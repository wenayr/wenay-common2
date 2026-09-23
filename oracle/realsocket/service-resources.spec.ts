import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {createServiceLeaderHost, createServiceNodeHost} from '../../src/service/host'
import {createServiceClient} from '../../src/service/client'
import {describeService, type tServiceDefinition, type ServiceResourceContext} from '../../src/service'
import {listen} from '../../src/Common/events/Listen'
import {noStrict} from '../../src/Common/rcp/rpc-dynamic'
import {createPeerHost, createPeerClient} from '../../src/Common/peer/peer-index'
import type {Socket} from 'node:net'

async function until(check: () => boolean, label: string, ms = 5000) {
    const end = Date.now() + ms
    while (!check()) { assert(Date.now() < end, label); await delay(5) }
}
async function main() {
    const errors: unknown[] = []
    function unhandled(error: unknown) { errors.push(error) }
    process.on('unhandledRejection', unhandled)
    const contexts: ServiceResourceContext[] = [], disposed: string[] = []
    const [emit, events] = listen<[number]>()
    const room = createPeerHost({history: 16})
    let total = 0
    const definition = {
        name: 'resources-test', storeId: 'resources-test', originId: 'resources-test', initial: {roles: ['user'], count: 0},
        access: {rolesOf: (state: {roles: string[]}) => state.roles},
        commands: {add: {apply(ctx: {state: {count: number}}, input: number) { ctx.state.count += input; return ctx.state.count }}},
        views: {count: {allow: 'public', project: (state: {count: number}) => ({count: state.count})}},
        resources: {presence: {allow: ['user'], placement: 'authority', open(ctx: ServiceResourceContext) {
            const peer = room.connection(ctx.resourceId)
            return {facade: {session: () => ctx.resourceId, peer: peer.fragment}, close: peer.close}
        }}, counter: {allow: ['user'], placement: 'authority', open(ctx: ServiceResourceContext) {
            contexts.push(ctx)
            return {facade: {control: {add(n: number) { total += n; emit(total); return total }},
                view: {read() { return total }}, events, dynamic: noStrict({events})},
            close() { disposed.push(ctx.resourceId) }}
        }}},
    } satisfies tServiceDefinition<any, any>
    const host = await createServiceLeaderHost({definition, env: {}, rest: false})
    const transports = new Set<Socket>()
    host.httpServer.on('connection', function accepted(socket) {
        transports.add(socket)
        socket.once('close', function removed() { transports.delete(socket) })
    })
    let currentToken = host.leader.identity.login('alice').token
    const descriptor = describeService(definition)
    assert.equal(JSON.stringify(descriptor).includes('open'), false)
    const client = createServiceClient({definition: descriptor, url: host.url, auth: {login: async () => currentToken}})
    const tab = createServiceClient({definition: descriptor, url: host.url, auth: {token: currentToken}, handshake: {sessionId: 'spoof', account: 'bob'}})
    let node: Awaited<ReturnType<typeof createServiceNodeHost>> | undefined
    try {
        const a = client.resources.open('counter'), b = client.resources.open('counter'), c = tab.resources.open('counter')
        await until(() => !!a.current() && !!b.current() && !!c.current(), 'three resources ready: ' + JSON.stringify(a.status.snapshot()))
        assert.equal(contexts.length, 3)
        assert.equal(new Set(contexts.map(ctx => ctx.resourceId)).size, 3)
        assert(contexts.every(ctx => ctx.principal.account == 'alice' && ctx.sessionId != 'spoof'))
        const original = a.current()!, remote = original.remote
        const got: number[] = [], independent: number[] = []
        const off = remote.dynamic.events.on((value: number) => got.push(value))
        const offB = b.current()!.remote.events.on((value: number) => independent.push(value))
        await remote.view.read()
        await b.current()!.remote.view.read()
        assert.equal(await remote.control.add(1), 1)
        await until(() => got.length == 1 && independent.length == 1, 'subscriptions attached')
        const closing = a.close()
        assert.equal(a.current(), null)
        assert.equal(a.close(), closing)
        await closing
        await assert.rejects(remote.control.add(100))
        assert.equal(await b.current()!.remote.control.add(1), 2)
        await until(() => independent.length == 2, 'independent resource survives')
        assert.deepEqual(got, [1])
        off(); offB()
        const stable = b.status, old = b.current()!
        host.leader.line.control.store.state.roles = ['user', 'extra']
        await until(() => !!b.current() && b.current()!.generation > old.generation, 'role change recreates allowed resource')
        assert.equal(b.status, stable)
        await assert.rejects(old.remote.view.read())
        host.leader.line.control.store.state.roles = []
        await until(() => b.status.state.phase == 'denied', 'role denial')
        host.leader.line.control.store.state.roles = ['user']
        await until(() => b.status.state.phase == 'ready', 'role regrant')
        const view = client.views.count
        await view.ready
        const beforeNode = b.current()
        node = await createServiceNodeHost({definition, env: {SERVICE_UPSTREAM: host.url, SERVICE_NODE_ID: 'resource-node',
            SERVICE_NODE_TOKEN: host.leader.secrets.nodeToken, SERVICE_TOKEN_SECRET: host.leader.secrets.tokenSecret}, graceMs: 25})
        client.control.repick()
        await client.ready()
        assert.equal(client.view.endpoint()?.nodeId, 'resource-node')
        assert.equal(b.current(), beforeNode, 'placement does not clone resources')
        assert.equal(await client.commands.add('add-1', 3), 3)
        await until(() => view.store.state.count == 3, 'ordinary views and commands still work')
        host.leader.control.drain('resource-node')
        await node.close(); node = undefined
        await until(() => client.view.endpoint()?.nodeId == 'leader', 'fallback authority')
        const beforeReconnect = b.current()!
        for (const transport of transports) transport.destroy()
        await until(() => !!b.current() && b.current()!.generation > beforeReconnect.generation, 'transport reconnect creates fresh generation')
        await assert.rejects(beforeReconnect.remote.control.add(100))
        assert.equal(await b.current()!.remote.view.read(), 2, 'old command is never replayed')
        const p = client.resources.open('presence'), q = tab.resources.open('presence')
        await until(() => !!p.current() && !!q.current(), 'peer facades ready')
        const pRemote = p.current()!.remote, qRemote = q.current()!.remote
        const pId = await pRemote.session(), qId = await qRemote.session()
        const pClient = createPeerClient({account: pId, remote: pRemote.peer, initial: {x: 0}})
        const qClient = createPeerClient({account: qId, remote: qRemote.peer, initial: {x: 0}})
        try {
            const mirror = qClient.peer(pId)
            await mirror.ready
            pClient.store.state.x = 9
            await until(() => mirror.store.state.x == 9, 'peer replay through scoped facade')
            await p.close()
            await assert.rejects(pRemote.peer.peers[qId].keyframe())
            await assert.rejects(pRemote.peer.publish({seq: 999, ts: 0, event: [{path: [], value: {x: 999}, exists: true}]}))
            assert((await qRemote.peer.presence.list()).includes(qId))
        } finally { pClient.close(); qClient.close(); await p.close(); await q.close() }
        await b.close(); await c.close()
        assert.equal(disposed.length, contexts.length)
    } finally {
        client.close(); tab.close()
        await node?.close()
        await host.close()
        events.close()
        room.close()
        process.off('unhandledRejection', unhandled)
    }
    assert.deepEqual(errors, [])
    console.log('PASS resource real sockets: authority ownership, roles, independent opens/tabs, saved remotes, views and commands')
}
main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
