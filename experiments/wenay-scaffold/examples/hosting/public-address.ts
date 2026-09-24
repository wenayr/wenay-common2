import assert from 'node:assert/strict'
import {createServer, request} from 'node:http'
import {connect, type Socket} from 'node:net'
import {setTimeout as delay} from 'node:timers/promises'
import {io} from 'socket.io-client'
import {createServiceLeaderHost, createServiceNodeHost} from '../../../../src/service/host'
import {createServiceClient} from '../../../../src/service/client'
import {describeService, type ServiceResourceContext} from '../../../../src/service'
import {createMemoryReplayStorage} from '../../../../src/Common/events/replay-history'
import type {StorePatch} from '../../../../src/Common/Observe/store'
import {runCheck} from '../../resources/run-check'

// Real HTTP/WS forwarding with a replaceable upstream; no container or paid service.
async function gateway() {
    let upstream = ''
    let upgrades = 0
    const sockets = new Set<Socket>()
    const server = createServer(function forward(req, res) {
        const target = request(upstream + req.url, {method: req.method, headers: req.headers}, function response(answer) {
            res.writeHead(answer.statusCode!, answer.headers)
            answer.pipe(res)
        })
        target.on('error', function failed() { res.destroy() })
        req.pipe(target)
    })
    server.on('connection', function connected(socket) {
        sockets.add(socket)
        socket.once('close', function closed() { sockets.delete(socket) })
    })
    server.on('upgrade', function upgrade(req, socket, head) {
        upgrades++
        const target = new URL(upstream)
        const remote = connect(Number(target.port), target.hostname, function linked() {
            remote.write(`${req.method} ${req.url} HTTP/1.1\r\n`)
            for (let i = 0; i < req.rawHeaders.length; i += 2) remote.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`)
            remote.write('\r\n')
            remote.write(head)
            socket.pipe(remote).pipe(socket)
        })
        socket.on('error', function failed() { remote.destroy() })
        remote.on('error', function failed() { socket.destroy() })
        socket.on('close', function closed() { remote.destroy() })
        remote.on('close', function closed() { socket.destroy() })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = 'http://127.0.0.1:' + (server.address() as {port: number}).port
    return {url, route(value: string) { upstream = value }, upgrades: () => upgrades,
        async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) }}
}

async function until(check: () => boolean, label: string) {
    const end = Date.now() + 10_000
    while (!check()) { assert(Date.now() < end, label); await delay(10) }
}

async function main() {
    const definition = {
        name: 'public-address', storeId: 'public-address', originId: 'authority', initial: {count: 0},
        access: {rolesOf: () => ['user']},
        commands: {add: {apply(ctx: {state: {count: number}}, n: number) { return ctx.state.count += n }}},
        views: {count: {allow: ['user'], project: (state: {count: number}) => ({count: state.count})}},
        resources: {session: {allow: ['user'], placement: 'authority' as const, open(ctx: ServiceResourceContext) {
            return {facade: {id: () => ctx.resourceId}, close() {}}
        }}},
    }
    for (const publicUrl of ['localhost:8080', 'ftp://example.com', 'http://u:p@example.com', 'http://example.com/path', 'http://example.com/?x=1', 'http://example.com/#x', 'http://0.0.0.0', 'http://[::]', 'http://localhost:0']) {
        await assert.rejects(createServiceLeaderHost({definition, env: {}, publicUrl}), /public URL/)
    }
    const front = await gateway(), frontA = await gateway(), frontB = await gateway()
    const durable = {storage: createMemoryReplayStorage<[readonly StorePatch[]]>()}
    const durableControl = {storage: createMemoryReplayStorage<[readonly StorePatch[]]>()}
    const env = {SERVICE_HOST: '127.0.0.1', SERVICE_PUBLIC_URL: front.url, SERVICE_NODE_TOKEN: 'address-node-secret', SERVICE_TOKEN_SECRET: 'address-token-secret'}
    async function authority() {
        const host = await createServiceLeaderHost({definition, env, durable, durableControl, rest: false,
            origins: [front.url], mount({app}) { app.get('/health', function healthy(_req, res) { res.json({ok: true}) }) }})
        front.route(host.url)
        assert.equal(host.publicUrl, front.url)
        assert.notEqual(host.url, front.url)
        return host
    }
    let host: Awaited<ReturnType<typeof authority>>
    try { host = await authority() }
    catch (error) {
        for (const proxy of [front, frontA, frontB]) await proxy.close()
        throw error
    }
    const nodes: Awaited<ReturnType<typeof createServiceNodeHost>>[] = []
    async function serving(nodeId: string, proxy: Awaited<ReturnType<typeof gateway>>) {
        const node = await createServiceNodeHost({definition, host: '127.0.0.1', publicUrl: proxy.url, graceMs: 20, env: {
            SERVICE_NODE_ID: nodeId, SERVICE_UPSTREAM: front.url, SERVICE_NODE_TOKEN: env.SERVICE_NODE_TOKEN,
            SERVICE_TOKEN_SECRET: env.SERVICE_TOKEN_SECRET,
        }})
        proxy.route(node.url)
        nodes.push(node)
        return node
    }
    const client = createServiceClient({definition: describeService(definition), url: front.url,
        auth: {login: async () => host.leader.identity.login('alice').token}, placement: {rng: () => 0}, log() {}})
    try {
        const a = await serving('node-a', frontA)
        await serving('node-b', frontB)
        const view = client.views.count
        await view.ready
        const store = view.store
        assert.equal(client.view.endpoint()?.url, frontA.url)
        assert.deepEqual(new Set(client.view.roster().map(row => row.url)), new Set([front.url, frontA.url, frontB.url]))
        assert.equal(await client.commands.add('receipt', 4), 4)
        await until(() => store.state.count == 4, 'store receives command through serving proxy')
        const resource = client.resources.open('session')
        await until(() => !!resource.current(), 'authority resource through proxy')
        const old = resource.current()!
        const oldId = await old.remote.id()
        await a.close()
        await until(() => client.view.endpoint()?.nodeId == 'node-b', 'drain selects second published URL')
        assert.equal(await resource.current()!.remote.id(), oldId, 'serving drain preserves authority resource')
        await nodes[1].close()
        await until(() => client.view.endpoint()?.nodeId == 'leader', 'all nodes drained to advertised authority')
        const response = await fetch(front.url + '/health', {headers: {host: 'spoof.invalid', 'x-forwarded-host': 'spoof.invalid', 'x-forwarded-proto': 'https', origin: 'https://evil.invalid'}})
        assert.equal(response.headers.get('access-control-allow-origin'), null)
        assert.equal(client.view.roster().find(row => row.nodeId == 'leader')?.url, front.url)
        const rejected = io(front.url, {transports: ['websocket'], extraHeaders: {origin: 'https://evil.invalid'}, reconnection: false})
        try { await new Promise<void>((resolve, reject) => { rejected.once('connect_error', () => resolve()); rejected.once('connect', () => reject(new Error('CORS widened'))) }) }
        finally { rejected.close() }
        await host.close()
        await until(() => resource.status.state.phase == 'offline', 'resource offline')
        host = await authority()
        await until(() => !!resource.current() && resource.current()!.generation > old.generation, 'new scope after replacement behind same gateway')
        assert.notEqual(await resource.current()!.remote.id(), oldId)
        await assert.rejects(old.remote.id())
        assert.equal(await client.commands.add('receipt', 4), 4, 'durable receipt restored')
        assert.equal(await client.commands.add('after-restart', 3), 7)
        await until(() => store.state.count == 7, 'same Store after authority replacement')
        assert.equal(view.store, store)
        assert(front.upgrades() > 3 && frontA.upgrades() > 0 && frontB.upgrades() > 0)
    } finally {
        client.close()
        for (const node of nodes) await node.close()
        await host.close()
        for (const proxy of [front, frontA, frontB]) await proxy.close()
    }
    console.log('PASS H3: published origins, three real gateways, placement/drain/restart, Store/receipts/resources, URL validation and CORS')
}
runCheck(main)
