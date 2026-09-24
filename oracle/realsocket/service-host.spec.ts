import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {io} from 'socket.io-client'
import {createServiceLeaderHost, createServiceNodeHost, runLeaderProcess} from '../../src/service/host'
import {createServiceClient} from '../../src/service/client'
import {describeService, type tServiceDefinition} from '../../src/service'
import {runOracle} from '../run-oracle'

const definition = {
    name: 'host-test', storeId: 'host-test', originId: 'host-test', initial: {count: 0},
    commands: {add: {apply(ctx: {state: {count: number}}, input: {amount: number}) { ctx.state.count += input.amount; return ctx.state.count }}},
    views: {count: {allow: 'public', project: (state: {count: number}) => ({count: state.count})}},
} satisfies tServiceDefinition<any, any>

async function until(check: () => boolean, label: string, ms = 3000) {
    const end = Date.now() + ms
    while (!check()) { assert(Date.now() < end, label); await delay(10) }
}

async function main() {
    const origins = ['https://ui.example']
    let cleaned = 0
    const host = await createServiceLeaderHost({definition, origins, rest: false, env: {},
        mount({app}) {
            const timer = setInterval(function tick() {}, 100)
            app.get('/health', function healthy(_req, res) { res.json({ok: true}) })
            return async function dispose() { clearInterval(timer); await delay(15); cleaned++ }
        },
    })
    const nodes: Awaited<ReturnType<typeof createServiceNodeHost>>[] = []
    const logs: string[] = []
    const client = createServiceClient({definition: describeService(definition), url: host.url, placement: {rng: () => 0}, log: line => logs.push(line)})
    try {
        for (const origin of [origins[0], 'https://denied.example']) {
            for (const method of ['GET', 'OPTIONS']) {
                const response = await fetch(host.url + '/health', {method, headers: {origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type'}})
                assert.equal(response.headers.get('access-control-allow-origin'), origin == origins[0] ? origin : null)
                assert.equal(response.headers.get('access-control-allow-credentials'), null)
            }
            const socket = io(host.url, {transports: ['websocket'], extraHeaders: {origin}, reconnection: false})
            try {
                const accepted = await new Promise<boolean>(function outcome(resolve) {
                    socket.once('connect', function ok() { resolve(true) })
                    socket.once('connect_error', function denied() { resolve(false) })
                })
                assert.equal(accepted, origin == origins[0])
            } finally { socket.close() }
        }
        async function node(id: string) {
            const opened = await createServiceNodeHost({definition, env: {SERVICE_NODE_ID: id, SERVICE_UPSTREAM: host.url,
                SERVICE_NODE_TOKEN: host.leader.secrets.nodeToken, SERVICE_TOKEN_SECRET: host.leader.secrets.tokenSecret}, graceMs: 30})
            nodes.push(opened)
            return opened
        }
        const a = await node('node-a')
        const b = await node('node-b')
        const view = client.views.count
        await view.ready
        assert.equal(client.view.endpoint()?.nodeId, 'node-a')
        const store = view.store
        host.leader.control.drain('node-a')
        host.leader.control.drain('node-b')
        await Promise.all([a.close(), b.close()])
        await until(() => client.view.endpoint()?.nodeId == 'leader', 'planned drain must reattach without readiness timeout')
        assert(!logs.some(line => line.includes('timed out')), logs.join('\n'))
        host.leader.line.control.store.state.count = 7
        await until(() => store.state.count == 7, 'same mirror after drain')
        assert.equal(client.views.count.store, store)
        await node('node-a')
        client.control.repick()
        await client.ready()
        assert.equal(client.view.endpoint()?.nodeId, 'node-a')
    } finally {
        client.close()
        await Promise.all(nodes.map(node => node.close()))
        const closing = host.close()
        assert.equal(host.close(), closing)
        await closing
    }
    assert.equal(cleaned, 1)
    assert.equal(host.httpServer.listening, false)

    let failedCleanup = 0
    const occupied = await createServiceLeaderHost({definition, rest: false, env: {}})
    try {
        await assert.rejects(createServiceLeaderHost({definition, rest: false, env: {SERVICE_PORT: new URL(occupied.url).port},
            mount() { return async function dispose() { failedCleanup++; await delay(5) } },
        }), /EADDRINUSE/)
        assert.equal(failedCleanup, 1)
    } finally { await occupied.close() }

    const abort = new AbortController()
    let lateCleanup = 0
    let release!: () => void
    const pending = createServiceLeaderHost({definition, env: {}, rest: false, signal: abort.signal,
        async mount() { await new Promise<void>(resolve => { release = resolve }); return function dispose() { lateCleanup++ } },
    })
    await until(() => !!release, 'pending mount started')
    abort.abort()
    await assert.rejects(pending, /closed/)
    release()
    await until(() => lateCleanup == 1, 'late mount disposed')

    const hung = await createServiceLeaderHost({definition, env: {}, rest: false, closeTimeoutMs: 50,
        mount() { return function cannotFinish() { return new Promise<void>(() => {}) } },
    })
    await assert.rejects(hung.close(), /cleanup timed out/)
    assert.equal(hung.httpServer.listening, false)
    const pendingNode = createServiceNodeHost({definition, startTimeoutMs: 50, env: {
        SERVICE_UPSTREAM: 'http://localhost:1', SERVICE_NODE_ID: 'absent', SERVICE_NODE_TOKEN: 'token', SERVICE_TOKEN_SECRET: 'secret',
    }})
    await assert.rejects(pendingNode, /startup timed out/)

    const signalCount = process.listenerCount('SIGTERM')
    const processHost = await runLeaderProcess({definition, env: {}, rest: false})
    assert.equal(process.listenerCount('SIGTERM'), signalCount + 1)
    await processHost.close()
    assert.equal(process.listenerCount('SIGTERM'), signalCount)
    let signalCleanup = 0
    const signalled = await runLeaderProcess({definition, env: {}, rest: false,
        mount() { return async function dispose() { await delay(5); signalCleanup++ } },
    })
    process.emit('SIGTERM')
    await signalled.close()
    assert.equal(signalCleanup, 1)
    assert.equal(process.listenerCount('SIGTERM'), signalCount)
    console.log('PASS public service host: HTTP/WS origins, drain/restart, stable Store, idempotent cleanup, failed bind, cancelled mount, signals')
}
runOracle(main)
