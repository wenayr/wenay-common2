// oracle-ends: own watchdog timer — a stall exits 3
// One domain command: local Store -> RPC -> Scale placement -> transport reconnect.
// Reader sockets cross real WebSockets; trusted node-to-authority links stay in-process.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomBytes} from 'node:crypto'
import {Server as SocketIOServer, type Socket} from 'socket.io'
import {io} from 'socket.io-client'
import {sleepAsync} from '../../src/Common/core/common'
import {listen} from '../../src/Common/events/Listen'
import {createStore} from '../../src/Common/Observe/store'
import {syncStoreReplay} from '../../src/Common/Observe/store-replay'
import {flushReactive} from '../../src/Common/Observe/reactive'
import {createStoreNode} from '../../src/Common/Observe/store-node'
import type {NodeDirectoryView} from '../../src/Common/Observe/node-directory'
import {createAuthority} from '../../src/Common/scale/scale-authority'
import {createClusterClient} from '../../src/Common/scale/scale-client'
import {createRpcServerAuto} from '../../src/Common/rcp/rpc-server-auto'
import {createRpcClientHub} from '../../src/Common/rcp/rpc-clientHub'
import type {CommandCtx} from '../../src/Common/command/command-host'
import {createTokenCodec} from '../../src/server/auth-token'

function initialState() {
    return {counter: {value: 0, by: ''}}
}
type CounterState = ReturnType<typeof initialState>

function createCounterCommands(deps: {state: () => CounterState}) {
    return {
        add(ctx: CommandCtx, input: {delta: number}) {
            if (!Number.isSafeInteger(input.delta) || input.delta <= 0) throw new Error('positive integer required')
            const counter = deps.state().counter
            counter.value += input.delta
            counter.by = ctx.account
            return {value: counter.value, by: counter.by}
        },
    }
}

async function waitFor(name: string, predicate: () => boolean) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
        if (predicate()) return
        await sleepAsync(10)
    }
    throw new Error('timeout waiting for ' + name)
}

async function openTransport(deps: {onConnection: (socket: Socket) => void}) {
    const http = createServer()
    const sockets = new SocketIOServer(http)
    sockets.on('connection', deps.onConnection)
    await new Promise<void>(function listenOnFreePort(resolve) { http.listen(0, '127.0.0.1', resolve) })
    const address = http.address()
    assert(address && typeof address != 'string')
    return {
        url: 'http://127.0.0.1:' + address.port,
        close: () => new Promise<void>(function closeTransport(resolve) { sockets.close(function closed() { resolve() }) }),
    }
}

async function main() {
    const cleanup: (() => void | Promise<void>)[] = []
    const watchdog = setTimeout(function timedOut() {
        console.error('store-consumer-journey timed out')
        process.exit(3)
    }, 60_000)
    try {
        // === Domain behavior begins locally ===
        const local = createStore(initialState())
        let state = local.state
        const commands = createCounterCommands({state: () => state})
        const localValues: number[] = []
        cleanup.push(local.node.counter.value.on(function localChanged(value) { localValues.push(value) }))
        assert.deepEqual(commands.add({account: 'alice', requestId: 'local', command: 'add'}, {delta: 1}), {value: 1, by: 'alice'})
        await flushReactive(local.state)
        assert.deepEqual(localValues, [1])

        const codec = createTokenCodec({secret: randomBytes(32).toString('hex')})
        function issue(account: string) { return codec.issue({sub: account}) }
        function verify(presented: unknown) {
            const verdict = codec.verify(presented)
            if (!verdict.ok) throw new Error('token rejected: ' + verdict.reason)
            return {account: verdict.claims.sub, expiresAt: verdict.claims.exp}
        }
        let authorityUrl = ''
        const authority = createAuthority({
            line: {storeId: 'consumer-journey', originId: 'consumer-origin', initial: local.snapshot()},
            roster: {url: () => authorityUrl, heartbeatMs: 100, staleMs: 0},
            identity: {issue, verify},
            corridor: {commands},
            log() {},
        })
        cleanup.push(authority.close)
        state = authority.line.control.store.state
        const readSurface = {...authority.serve.reader(), roster: authority.roster.api}
        type ReaderSurface = ReturnType<typeof authority.serve.reader>
        type WriteSurface = Pick<ReturnType<ReturnType<typeof authority.serve.connection>['auth']['resolveAuth']>['object'], 'whoami' | 'commands'>
        const host = await openTransport({
            onConnection(socket) {
                const [gone, disconnectListen] = listen<[]>()
                createRpcServerAuto({socket, socketKey: 'app', object: readSurface, disconnectListen})
                const connection = authority.serve.connection()
                const server = createRpcServerAuto({
                    socket, socketKey: 'scale', object: connection.object, auth: connection.auth, disconnectListen,
                })
                connection.attach(server.control)
                socket.on('disconnect', function disconnected() { gone(); connection.close() })
            },
        })
        cleanup.push(host.close)
        authorityUrl = host.url
        authority.start()

        // === The same inferred command and Store surface over RPC ===
        const token = issue('alice')
        const primary = createRpcClientHub(
            () => io(host.url, {transports: ['websocket'], forceNew: true}),
            r => ({read: r<typeof readSurface>('app'), write: r<WriteSurface>('scale')}),
        )
        cleanup.push(function closePrimary() { primary.close() })
        const primaryApi = await primary.setToken(token)
        await Promise.all([primaryApi.read.readyStrict(), primaryApi.write.readyStrict()])
        const rpcStore = createStore(initialState())
        const stopRpc = syncStoreReplay(rpcStore, primaryApi.read.func.replica.replay)
        cleanup.push(stopRpc)
        await waitFor('RPC initial state', () => rpcStore.state.counter.value == 1)
        assert.deepEqual(await primaryApi.write.func.commands.add('rpc-1', {delta: 1}), {value: 2, by: 'alice'})
        await waitFor('RPC command reaches Store', () => rpcStore.state.counter.value == 2)
        stopRpc()

        // === Add mirrors without changing the command implementation ===
        async function startMirror(nodeId: string) {
            let accept: ((socket: Socket) => void) | undefined
            const transport = await openTransport({onConnection(socket) { accept?.(socket) }})
            cleanup.push(transport.close)
            const trusted = authority.serve.nodeLink(nodeId)
            const node = createStoreNode<CounterState>({
                line: {storeId: 'consumer-journey', originId: 'consumer-origin', nodeId},
                roster: {url: () => transport.url, heartbeatMs: 100},
                upstream: () => ({...trusted, onFail: {on: () => () => {}}}),
                auth: {verify},
                commands: authority.corridor.names,
                serve: {onConnection(handler) { accept = handler }},
                onLeave() {},
                log() {},
            })
            cleanup.push(node.close)
            await node.start()
            return node
        }
        await startMirror('n1')
        await startMirror('n2')

        function createNodeHub(url: string) {
            return createRpcClientHub(
                () => io(url, {transports: ['websocket'], forceNew: true, reconnection: false}),
                r => ({read: r<ReaderSurface>('app'), write: r<WriteSurface>('scale')}),
            )
        }
        const sessions = new Map<string, ReturnType<typeof createNodeHub>>()
        let cutTransport = false
        async function connect(view: NodeDirectoryView) {
            if (cutTransport) throw new Error('consumer transport is offline')
            const hub = createNodeHub(view.url)
            sessions.set(view.nodeId, hub)
            try {
                const api = await hub.setToken(token)
                await Promise.all([api.read.readyStrict(), api.write.readyStrict()])
                return {
                    remote: api.read.func.replica,
                    onFail: {on: (cb: () => void) => hub.disconnectListen(cb)},
                    close() {
                        if (sessions.get(view.nodeId) == hub) sessions.delete(view.nodeId)
                        hub.close()
                    },
                }
            } catch (error) {
                hub.close()
                throw error
            }
        }
        const cluster = createClusterClient({
            line: {storeId: 'consumer-journey', originId: 'consumer-origin', nodeId: 'consumer', initial: initialState()},
            roster: primaryApi.read.func.roster,
            connect,
            placement: {priorityOf: view => view.nodeId == 'n1' ? 0 : view.nodeId == 'n2' ? 10 : 100},
            log() {},
        })
        cleanup.push(function closeCluster() {
            cluster.close()
            for (const hub of sessions.values()) hub.close()
        })
        const observed: number[] = []
        const subscribedStore = cluster.store
        const stop = cluster.store.node.counter.value.on(function counterChanged(value) { observed.push(value) })
        cleanup.push(stop)
        await cluster.ready
        await waitFor('first mirror route', () => cluster.view.route() == 'n1' && cluster.store.state.counter.value == 2)
        async function add(requestId: string, delta: number) {
            const nodeId = cluster.view.route()
            assert(nodeId, 'a write needs a selected read route')
            const hub = sessions.get(nodeId)
            assert(hub, 'selected route has an RPC session')
            return (await hub.promise).write.func.commands.add(requestId, {delta})
        }
        assert.deepEqual(await add('move-once', 1), {value: 3, by: 'alice'})
        await waitFor('subscription sees first mirror command', () => observed.includes(3))

        authority.roster.control.drain('n1')
        await waitFor('handoff to second mirror', () => cluster.view.route() == 'n2')
        assert.deepEqual(await add('move-once', 1), {value: 3, by: 'alice'})
        assert.equal(state.counter.value, 3, 'retry through another node reuses its receipt')
        assert.deepEqual(await add('after-move', 1), {value: 4, by: 'alice'})
        await waitFor('same subscription after handoff', () => observed.includes(4))

        // === Offline catch-up keeps the consumer Store and its subscription ===
        cutTransport = true
        for (const hub of [...sessions.values()]) hub.socket.disconnect()
        await waitFor('transport is down', () => cluster.status.state.role == 'offline')
        const countBeforeReconnect = observed.length
        await primaryApi.write.func.commands.add('while-offline', {delta: 1})
        await flushReactive(state)
        assert.equal(cluster.store.state.counter.value, 4, 'offline Store retains its last observed value')
        cutTransport = false
        await waitFor('reconnect catches up', () => cluster.view.route() == 'n2' && cluster.store.state.counter.value == 5)
        assert.equal(cluster.store, subscribedStore, 'reconnect preserves Store identity')
        assert(observed.slice(countBeforeReconnect).includes(5), 'original subscription receives reconnect catch-up')
        assert.deepEqual(await add('after-reconnect', 1), {value: 6, by: 'alice'})
        await waitFor('commands and subscription after reconnect', () => observed.includes(6))
        assert.deepEqual(cluster.store.snapshot(), authority.line.api.store.snapshot())
        assert.deepEqual(observed, [2, 3, 4, 5, 6], 'no rollback, duplicate or skipped observed checkpoint')
        console.log('store-consumer-journey: local -> RPC -> n1 -> n2 -> reconnect PASS')
    } finally {
        for (const close of cleanup.reverse()) await close()
        clearTimeout(watchdog)
    }
}

main().catch(function failed(error) {
    console.error(error)
    process.exitCode = 1
})
