import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {setTimeout as delay} from 'node:timers/promises'
import {Server} from 'socket.io'
import {io} from 'socket.io-client'
import {createRpcClientHub} from '../../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../../src/Common/rcp/rpc-server-auto'
import {createStoreFollower} from '../../src/Common/Observe/store-follower'
import {createTokenCodec} from '../../src/server/auth-token'
import {createServiceLeader, type tServiceDefinition} from '../../experiments/wenay-scaffold/template/leader'
import {createServiceNode} from '../../experiments/wenay-scaffold/template/node'
import {createServiceClient} from '../../experiments/wenay-scaffold/template/client'
import {runOracle} from '../run-oracle'

type State = {roles: Record<string, string[]>, inventory: {flour: number}}
const definition = {
    name: 'session', storeId: 'session', originId: 'leader',
    initial: {roles: {owner: ['owner'], manager: ['manager'], other: ['manager']}, inventory: {flour: 5}} as State,
    access: {rolesOf: (state: State, account: string) => state.roles[account] ?? []},
    commands: {
        setRoles: {allow: ['owner'], apply(ctx, input: {account: string, roles: string[]}) { ctx.state.roles[input.account] = input.roles; return true }},
        change: {allow: ['owner', 'manager'], apply(ctx, input: {flour: number}) { ctx.state.inventory.flour = input.flour; return input.flour }},
    },
    views: {
        inventory: {allow: ['manager'], shared: true, keys: ['inventory'], project: (state: State) => ({inventory: state.inventory})},
        public: {allow: 'public', project: () => ({open: true})},
    },
} satisfies tServiceDefinition<State>

async function until(label: string, check: () => boolean) {
    for (let attempt = 0; attempt < 800; attempt++) {
        if (check()) return
        await delay(10)
    }
    assert.fail('timeout: ' + label)
}

async function socketHost() {
    const http = createServer()
    const sockets = new Server(http)
    await new Promise<void>(function bind(resolve) { http.listen(0, '127.0.0.1', resolve) })
    const address = http.address()
    assert(address && typeof address != 'string')
    return {
        sockets, url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>(function stop(resolve) { sockets.close(function stopped() { resolve() }) }),
    }
}

async function main() {
    const host = await socketHost()
    const authority = createServiceLeader({definition, selfUrl: () => host.url, log() {}})
    const codec = createTokenCodec({secret: authority.secrets.tokenSecret})
    host.sockets.on('connection', function connected(socket) {
        const session = authority.serve.scaleConnection()
        socket.once('disconnect', function gone() { session.close() })
        const {control} = createRpcServerAuto({socket, socketKey: 'scale', object: {}, auth: {
            gate: true,
            resolveAuth(presented) {
                const grant = session.auth.resolveAuth(presented)
                return {...grant, object: {session: grant.object}}
            },
        }})
        session.attach(control)
        createRpcServerAuto({socket, socketKey: 'app', object: {session: authority.serve.browserFragment('anonymous')}})
    })
    authority.control.start()
    const nodeHosts: Awaited<ReturnType<typeof socketHost>>[] = []
    const nodes: ReturnType<typeof createServiceNode<State>>[] = []
    const clients: ReturnType<typeof createServiceClient<typeof definition>>[] = []
    const rawHubs: ReturnType<typeof rawHub>[] = []
    function rawHub(url: string) {
        return createRpcClientHub(() => io(url, {transports: ['websocket'], forceNew: true}), r => ({scale: r<any>('scale')}))
    }
    function connect(account: string, seed?: string) {
        const client = createServiceClient({definition, url: host.url,
            auth: {token: seed ?? codec.issue({sub: account})}, placement: {rng: () => 0},
        })
        clients.push(client)
        return client
    }
    try {
        for (const id of ['node-a', 'node-b']) {
            const nodeHost = await socketHost()
            nodeHosts.push(nodeHost)
            const link = authority.serve.nodeLinkFragment()
            const node = createServiceNode({definition, nodeId: id, selfUrl: () => nodeHost.url, heartbeatMs: 30,
                verifyToken(presented) {
                    const result = codec.verify(presented)
                    if (!result.ok) throw new Error('token rejected')
                    return {account: result.claims.sub, expiresAt: result.claims.exp}
                },
                upstream: () => ({replica: link.replica, control: link.control, commandsByToken: link.commandsByToken,
                    register: link.register, heartbeat: link.heartbeat, goodbye: link.goodbye, onFail: {on: () => () => {}},
                }),
                serve: {onConnection(handler) { nodeHost.sockets.on('connection', handler) }}, onLeave() {}, log() {},
            })
            nodes.push(node)
            await node.start()
        }
        const owner = connect('owner')
        const manager = connect('manager')
        const other = connect('other')
        const mine = manager.views.inventory
        const mirror = mine.store
        const permissions = manager.identity.permissions
        const otherView = other.views.inventory
        await Promise.all([owner.ready(), mine.ready, otherView.ready])
        assert.equal(manager.health.state.connected, true)
        assert.equal(manager.identity.account(), 'manager', 'seed-token identity comes from verified permissions')
        const savedCommand = manager.commands.change

        // Raw subscribers never watch permissions or reauthenticate: the server must protect them.
        const hub = rawHub(nodeHosts[0].url)
        rawHubs.push(hub)
        const raw = await hub.setToken(codec.issue({sub: 'manager'}))
        await raw.scale.readyStrict()
        const source = raw.scale.func.session.views.inventory
        const rawView = createStoreFollower<{inventory: {flour: number}}>({remote: source})
        try {
            await rawView.ready
            await owner.commands.setRoles('remove', {account: 'manager', roles: []})
            await until('raw private projection cleared', () => !('inventory' in rawView.store.state))
            await until('client permissions revoked', () => !permissions.state.views.includes('inventory'))
            assert.deepEqual(mirror.snapshot(), {})
            await assert.rejects(savedCommand('forbidden', {flour: 77}), /forbidden/)
            await assert.rejects(raw.scale.func.session.commands.change('raw-forbidden', {flour: 77}), /forbidden/)
            await assert.rejects(source.keyframe(), /forbidden|not found|not exist/i)
            await owner.commands.change('after-remove', {flour: 99})
            await until('unrelated session still receives shared content', () => otherView.store.state.inventory.flour == 99)
            assert.deepEqual(rawView.store.snapshot(), {})
            assert.deepEqual(mirror.snapshot(), {})

            await owner.commands.setRoles('restore', {account: 'manager', roles: ['manager']})
            await until('role returns without login', () => mirror.state.inventory?.flour == 99)
            assert.equal(manager.identity.permissions, permissions)
            assert.equal(manager.views.inventory.store, mirror)
            assert.equal(await savedCommand('restored-command', {flour: 100}), 100)

            manager.control.repick()
            await until('switch to second serving node', () => manager.health.state.nodeId == 'node-b')
            await until('retained mirror catches up after switch', () => mirror.state.inventory?.flour == 100)
            await owner.commands.setRoles('remove-again', {account: 'manager', roles: []})
            await until('revocation on second serving node', () => !('inventory' in mirror.state))
            await owner.commands.change('after-second-remove', {flour: 101})
            await until('other remains authorized', () => otherView.store.state.inventory.flour == 101)
            assert.deepEqual(mirror.snapshot(), {})
            await owner.commands.setRoles('restore-again', {account: 'manager', roles: ['manager']})
            await until('second regrant restores same mirror', () => mirror.state.inventory?.flour == 101)
        } finally { rawView.close(); hub.close() }

        // A short ready token must be renewed through authority before expiry, then survive repick.
        const seed = codec.issue({sub: 'manager'}, {ttlMs: 700})
        const short = connect('manager', seed)
        const tokens: string[] = []
        short.identity.onToken.on(function changed(token) { tokens.push(token) })
        const shortView = short.views.inventory
        await shortView.ready
        await until('ready token renewed', () => short.identity.token() != seed)
        assert(tokens.includes(short.identity.token()!))
        await delay(750)
        assert.equal(codec.verify(seed).ok, false)
        short.control.repick()
        await until('renewed token accepted at second node', () => short.health.state.nodeId == 'node-b')
        assert.equal(await short.commands.change('after-expiry', {flour: 102}), 102)
        await until('renewed client still receives updates', () => shortView.store.state.inventory?.flour == 102)

        let issuerCalls = 0
        let releaseIssuer!: () => void
        const issuerGate = new Promise<void>(function wait(resolve) { releaseIssuer = resolve })
        const switching = createServiceClient({definition, url: host.url, auth: {
            async login() {
                if (++issuerCalls == 1) return codec.issue({sub: 'other'}, {ttlMs: 700})
                await issuerGate
                return codec.issue({sub: 'owner'})
            },
        }})
        clients.push(switching)
        const prior = switching.views.inventory
        try {
            await prior.ready
            releaseIssuer()
            await until('issuer switches verified account', () => switching.identity.permissions.state.account == 'owner')
            assert.deepEqual(prior.store.snapshot(), {}, 'new account cannot retain the old account private mirror')
            assert(!switching.identity.permissions.state.views.includes('inventory'))
            assert.equal(switching.identity.account(), 'owner')
            assert.equal(await switching.commands.setRoles('issuer-owner', {account: 'other', roles: ['manager']}), true)
        } finally { releaseIssuer(); switching.close() }
        const authStates: string[] = []
        short.identity.onAuth.on(function authChanged(event) { authStates.push(event.state) })
        authority.control.revoke('manager')
        await until('account revocation is observable', () => authStates.includes('revoked'))
        await owner.commands.change('after-ban', {flour: 103})
        await until('unrelated account remains live after ban', () => otherView.store.state.inventory.flour == 103)
        assert.deepEqual(shortView.store.snapshot(), {})
        assert.deepEqual(short.identity.permissions.state.commands, [])
        await assert.rejects(short.commands.change('banned', {flour: 999}), /forbidden/)
        console.log('PASS scaffold session: raw revocation, shared-content isolation, automatic regrant, stable Store, second-node revocation, short-token renewal, account replacement, repick and account ban')
    } finally {
        for (const client of clients) client.close()
        for (const hub of rawHubs) hub.close()
        for (const node of nodes) node.close()
        authority.control.close()
        await Promise.all([...nodeHosts, host].map(server => server.close()))
    }
}

runOracle(main)
