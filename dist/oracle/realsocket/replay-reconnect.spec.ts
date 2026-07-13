// REAL-SOCKET replay reconnect oracle. The replay journals below outlive every
// Socket.IO connection: reconnect must repair a logical subscription, not create
// a new application-level replay line. Port 4112.
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {replayListen} from '../../src/Common/events/replay-listen'
import {exposeReplay, replaySubscribe, ReplayRemote} from '../../src/Common/events/replay-wire'

const PORT = 4112
const WAIT_MS = 8000

type tCheck = ReturnType<typeof makeChecker>['check']
type tClient = Awaited<ReturnType<typeof startRealClient>>

// ============================================================
// Persistent server resources
// ============================================================

function createPersistentReplay(history: number, frameDelayMs = 0) {
    const [emit, replay] = replayListen<[number]>({history})
    const exposed = exposeReplay(replay)

    if (frameDelayMs == 0) return {emit, replay, api: exposed}

    async function delayedFrame(seq: number, hint?: unknown) {
        await delay(frameDelayMs)
        return exposed.frame(seq, hint)
    }

    return {
        emit,
        replay,
        api: {...exposed, frame: delayedFrame},
    }
}

const shortLine = createPersistentReplay(32)
const consumersLine = createPersistentReplay(32)
const cyclesLine = createPersistentReplay(64, 140)
const sacredLine = createPersistentReplay(2)
const disposeLine = createPersistentReplay(16)
const lifecycleLine = createPersistentReplay(32)
const rotationLine = createPersistentReplay(16)

function makeObject() {
    return {
        identity: {
            deep: {
                orders: {
                    events: async function segmentedEvents() { return 'segmented' },
                },
            },
        },
        'identity.deep': {
            orders: {
                events: async function dottedEvents() { return 'dotted' },
            },
        },
        replay: {
            short: shortLine.api,
            consumers: consumersLine.api,
            cycles: cyclesLine.api,
            sacred: sacredLine.api,
            dispose: disposeLine.api,
            lifecycle: lifecycleLine.api,
            rotation: rotationLine.api,
        },
    }
}

// Every connection has its own RPC server registry. Summing their consumer
// counts catches callbacks leaked by dead wire-generations.
const serverApis: any[] = []

function rememberServer(api: any) {
    serverApis.push(api)
}

function serverSubscriberCount() {
    let total = 0
    for (const api of serverApis) {
        for (const sub of api.subscriptions()) total += sub.consumers
    }
    return total
}

// ============================================================
// Test utilities
// ============================================================

async function waitFor(name: string, predicate: () => boolean, timeoutMs = WAIT_MS) {
    const deadline = Date.now() + timeoutMs
    let lastError: any = null
    while (Date.now() < deadline) {
        try {
            if (predicate()) return
        } catch (e) {
            lastError = e
        }
        await delay(10)
    }
    const suffix = lastError == null ? '' : ': ' + String(lastError?.message ?? lastError)
    throw new Error('timeout waiting for ' + name + suffix)
}

function remoteOf(cli: tClient, name: string) {
    return (cli.client.func as any).replay[name] as ReplayRemote<[number]>
}

function currentClient(cli: tClient) {
    return (cli.hub.facade as any).api
}

async function breakTransport(cli: tClient, label: string) {
    const socket = cli.hub.socket as any
    if (!socket?.connected) throw new Error(label + ': socket is not connected')
    const count = cli.hub.connectCount()
    const engine = socket.io?.engine
    if (!engine?.close) throw new Error(label + ': Engine.IO close() is unavailable')

    // Closing Engine.IO, rather than Socket#disconnect(), is a transient network
    // failure: Socket.IO must reconnect this same Socket object automatically.
    engine.close()
    await waitFor(label + ' disconnect', () => !socket.connected)
    return {socket, count}
}

async function waitReconnect(cli: tClient, broken: Awaited<ReturnType<typeof breakTransport>>, label: string) {
    await waitFor(label + ' reconnect', () =>
        broken.socket.connected && cli.hub.connectCount() == broken.count + 1)
    if (cli.hub.socket !== broken.socket) throw new Error(label + ': Socket.IO object identity changed')
}

async function closeClient(cli: tClient) {
    currentClient(cli)?.dispose?.('reconnect oracle complete')
    cli.close()
    await waitFor('server subscription cleanup', () => serverSubscriberCount() == 0)
}

function errorMessage(error: any) {
    if (typeof error == 'string') return error
    if (typeof error?.message == 'string') return error.message
    if (typeof error?.error?.message == 'string') return error.error.message
    try { return JSON.stringify(error) } catch { return String(error) }
}

function numbers(from: number, to: number) {
    return Array.from({length: to - from + 1}, (_, i) => from + i)
}

// ============================================================
// Scenario 1 + 2: identity and a short recoverable gap
// ============================================================

async function checkIdentityAndShortReconnect(check: tCheck) {
    const cli = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    const client = cli.client as any

    const pathA = client.func.identity.deep.orders.events
    const pathB = client.func.identity.deep.orders.events
    const parentA = client.func.identity.deep.orders
    const parentB = client.func.identity.deep.orders
    const dotted = client.func['identity.deep'].orders.events
    const strictPath = client.strict.identity.deep.orders.events
    const remote = remoteOf(cli, 'short')
    const socketBefore = cli.hub.socket

    await check('identity: repeated RPC path returns the same Proxy', () => pathA === pathB, true)
    await check('identity: repeated nested parent returns the same Proxy', () => parentA === parentB, true)
    await check('identity: dotted key does not collide with segmented path', () => dotted !== pathA, true)
    await check('identity: collision-safe paths still call distinct routes', async () =>
        [await pathA(), await dotted()], ['segmented', 'dotted'])
    await check('identity: strict path is stable', () =>
        strictPath === client.strict.identity.deep.orders.events, true)
    await check('identity: incompatible wait surfaces do not share a Proxy', () =>
        pathA !== client.space.identity.deep.orders.events, true)
    await check('identity: client.all remains client.func', () => client.all === client.func, true)

    const values: number[] = []
    const seqs: number[] = []
    const callbackOrder: string[] = []
    const sub = replaySubscribe(remote, function receiveShort(value) {
        values.push(value)
        callbackOrder.push('value:' + value)
    }, {
        since: 0,
        onSeq: function rememberShortSeq(seq) {
            seqs.push(seq)
            callbackOrder.push('seq:' + seq)
        },
    })
    await sub.ready

    shortLine.emit(1)
    shortLine.emit(2)
    await waitFor('short seq 1,2', () => values.length == 2)

    const broken = await breakTransport(cli, 'short')
    shortLine.emit(3)
    shortLine.emit(4)
    await waitReconnect(cli, broken, 'short')

    // This is live during recovery. It must queue behind the replayed 3,4.
    shortLine.emit(5)
    await waitFor('short recovered 1..5', () => values.length == 5)
    await waitFor('short physical subscription', () => serverSubscriberCount() == 1)

    await check('short reconnect: values have no gap or duplicate', () => values, numbers(1, 5))
    await check('short reconnect: seqs have no gap or duplicate', () => seqs, numbers(1, 5))
    await check('short reconnect: callback precedes onSeq for every envelope', () => callbackOrder,
        numbers(1, 5).flatMap(n => ['value:' + n, 'seq:' + n]))
    await check('short reconnect: hub keeps the same Socket.IO object', () => cli.hub.socket === socketBefore, true)
    await check('short reconnect: connectCount increments exactly once', () =>
        cli.hub.connectCount(), broken.count + 1)
    await check('short reconnect: remote Proxy identity is unchanged', () =>
        remote === remoteOf(cli, 'short'), true)
    await check('short reconnect: strict Proxy survives schema refresh', () =>
        strictPath === client.strict.identity.deep.orders.events, true)
    await check('short reconnect: one client wire subscription', () =>
        cli.client.api.subscriptions().length, 1)
    await check('short reconnect: one physical server subscriber', serverSubscriberCount, 1)

    sub()
    await waitFor('short unsubscribe', () => cli.client.api.subscriptions().length == 0)
    await closeClient(cli)
}

// ============================================================
// Scenario 3: two local consumers remain one physical subscription
// ============================================================

async function checkTwoConsumers(check: tCheck) {
    const cli = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    const remote = remoteOf(cli, 'consumers')
    const first: number[] = []
    const second: number[] = []

    const sub1 = replaySubscribe(remote, function receiveFirst(value) { first.push(value) }, {since: 0})
    const sub2 = replaySubscribe(remote, function receiveSecond(value) { second.push(value) }, {since: 0})
    await Promise.all([sub1.ready, sub2.ready])

    consumersLine.emit(1)
    consumersLine.emit(2)
    await waitFor('two consumers seq 1,2', () => first.length == 2 && second.length == 2)

    await check('two consumers: one deduped client wire subscription', () =>
        cli.client.api.subscriptions().length, 1)
    await check('two consumers: client wire has two logical consumers', () =>
        cli.client.api.subscriptions()[0]?.consumers, 2)
    await check('two consumers: one physical server subscriber before reconnect', serverSubscriberCount, 1)

    const broken = await breakTransport(cli, 'two consumers')
    consumersLine.emit(3)
    consumersLine.emit(4)
    await waitReconnect(cli, broken, 'two consumers')
    consumersLine.emit(5)
    await waitFor('both consumers recovered 1..5', () => first.length == 5 && second.length == 5)

    await check('two consumers: first recovered exactly 1..5', () => first, numbers(1, 5))
    await check('two consumers: second recovered exactly 1..5', () => second, numbers(1, 5))
    await check('two consumers: reconnect still has one client wire', () =>
        cli.client.api.subscriptions().length, 1)
    await check('two consumers: reconnect preserves refcount two', () =>
        cli.client.api.subscriptions()[0]?.consumers, 2)
    await check('two consumers: reconnect creates one physical server subscriber', serverSubscriberCount, 1)

    sub1()
    await waitFor('first consumer off', () => cli.client.api.subscriptions()[0]?.consumers == 1)
    consumersLine.emit(6)
    await waitFor('second consumer receives after first off', () => second.length == 6)
    await check('two consumers: off(first) stops only first', () => first, numbers(1, 5))
    await check('two consumers: second remains live after off(first)', () => second, numbers(1, 6))
    await check('two consumers: server wire remains after off(first)', serverSubscriberCount, 1)

    sub2()
    await waitFor('last consumer removes wire', () =>
        cli.client.api.subscriptions().length == 0 && serverSubscriberCount() == 0)

    const afterOff = await breakTransport(cli, 'after last off')
    consumersLine.emit(7)
    await waitReconnect(cli, afterOff, 'after last off')
    consumersLine.emit(8)
    await delay(120)
    await check('two consumers: reconnect after last off resurrects nothing', () =>
        [cli.client.api.subscriptions().length, serverSubscriberCount()], [0, 0])
    await check('two consumers: no delivery after final off', () => second, numbers(1, 6))

    await closeClient(cli)
}

// ============================================================
// Scenario 4: three reconnects, including overlapping recovery
// ============================================================

async function checkRepeatedReconnect(check: tCheck) {
    const cli = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    const values: number[] = []
    const seqs: number[] = []
    const sub = replaySubscribe(remoteOf(cli, 'cycles'), function receiveCycle(value) {
        values.push(value)
    }, {since: 0, onSeq: function rememberCycleSeq(seq) { seqs.push(seq) }})
    await sub.ready

    cyclesLine.emit(1)
    await waitFor('cycles seq 1', () => values.length == 1)

    // Cycle one starts a deliberately slow frame request.
    const firstBreak = await breakTransport(cli, 'cycles one')
    cyclesLine.emit(2)
    await waitReconnect(cli, firstBreak, 'cycles one')
    cyclesLine.emit(3)

    // Cycle two interrupts that catch-up. Its late completion must be stale and
    // must not delete, flush, or otherwise mutate the new wire-generation.
    await delay(20)
    const secondBreak = await breakTransport(cli, 'cycles two')
    cyclesLine.emit(4)
    await waitReconnect(cli, secondBreak, 'cycles two')
    cyclesLine.emit(5)
    await waitFor('cycles recovered through 5', () => values.length == 5)

    // Cycle three checks the steady-state path after the overlap.
    const thirdBreak = await breakTransport(cli, 'cycles three')
    cyclesLine.emit(6)
    await waitReconnect(cli, thirdBreak, 'cycles three')
    cyclesLine.emit(7)
    await waitFor('cycles recovered through 7', () => values.length == 7)

    // Let every stale promise finish, then prove the current generation survived.
    await delay(320)
    cyclesLine.emit(8)
    await waitFor('cycles current generation still live', () => values.length == 8)

    await check('three reconnects: values are strictly 1..8', () => values, numbers(1, 8))
    await check('three reconnects: seqs are strictly 1..8', () => seqs, numbers(1, 8))
    await check('three reconnects: exactly four total connects', () => cli.hub.connectCount(), 4)
    await check('three reconnects: one logical client wire remains', () =>
        cli.client.api.subscriptions().length, 1)
    await check('three reconnects: request/callback tracking stays bounded to the live wire', () =>
        [cli.client.api.pending(), cli.client.api.callbacks()], [1, 1])
    await check('three reconnects: dead server generations retain no subscriber', serverSubscriberCount, 1)

    sub()
    await closeClient(cli)
}

// ============================================================
// Scenario 5: sacred journal eviction fails loudly and stays stopped
// ============================================================

async function checkSacredEviction(check: tCheck) {
    const cli = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    const values: number[] = []
    const seqs: number[] = []
    const errors: any[] = []
    const sub = replaySubscribe(remoteOf(cli, 'sacred'), function receiveSacred(value) {
        values.push(value)
    }, {
        since: 0,
        onSeq: function rememberSacredSeq(seq) { seqs.push(seq) },
        onError: function rememberSacredError(error) { errors.push(error) },
    })
    await sub.ready

    sacredLine.emit(1)
    sacredLine.emit(2)
    await waitFor('sacred seq 1,2', () => values.length == 2)

    const broken = await breakTransport(cli, 'sacred')
    sacredLine.emit(3)
    sacredLine.emit(4)
    sacredLine.emit(5)
    await waitReconnect(cli, broken, 'sacred')
    await waitFor('sacred recovery error', () => errors.length > 0)

    // A fresh live event after the reported gap must not masquerade as a
    // continuous stream. Recovery is terminal until the caller starts anew.
    sacredLine.emit(6)
    await delay(160)
    const message = errorMessage(errors[0]).toLowerCase()

    await check('sacred eviction: onError fires once', () => errors.length, 1)
    await check('sacred eviction: error names the requested reconnect seq', () => message.includes('2'), true)
    await check('sacred eviction: error explains eviction/gap', () =>
        message.includes('evict') || message.includes('sacred') || message.includes('gap'), true)
    await check('sacred eviction: post-gap events are not delivered', () => values, [1, 2])
    await check('sacred eviction: seq callback does not claim recovery', () => seqs, [1, 2])
    await check('sacred eviction: handle keeps the honest reconnect point', () => sub.seq(), 2)
    await check('sacred eviction: failed logical subscription is retired', () =>
        cli.client.api.subscriptions().length, 0)
    await check('sacred eviction: failed wire leaves no pending/callback state', () =>
        [cli.client.api.pending(), cli.client.api.callbacks()], [0, 0])

    sub()
    await closeClient(cli)
}

// ============================================================
// Scenario 6: dispose while offline is terminal
// ============================================================

async function checkDisposeOffline(check: tCheck) {
    const cli = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    const remote = remoteOf(cli, 'dispose')
    const values: number[] = []
    const sub = replaySubscribe(remote, function receiveBeforeDispose(value) { values.push(value) }, {since: 0})
    let rawDrained = false
    const rawHandle = remote.line.on(function observeRawLine() {}) as any
    rawHandle.then(function rawLineDrained() { rawDrained = true })
    await sub.ready

    disposeLine.emit(1)
    await waitFor('dispose seq 1', () => values.length == 1)

    const broken = await breakTransport(cli, 'dispose offline')
    cli.client.dispose('offline dispose', {socketAlive: false})
    await waitFor('offline dispose drains raw consumer', () => rawDrained)
    await waitReconnect(cli, broken, 'dispose offline')

    disposeLine.emit(2)
    await delay(160)
    await check('dispose offline: raw consumer handle is settled', () => rawDrained, true)
    await check('dispose offline: old replay receives nothing else', () => values, [1])
    await check('dispose offline: reconnect restores no client wire', () =>
        cli.client.api.subscriptions().length, 0)
    await check('dispose offline: reconnect restores no server subscriber', serverSubscriberCount, 0)
    await check('dispose offline: reconnect point remains last delivered seq', () => sub.seq(), 1)

    sub()
    rawHandle()
    await closeClient(cli)
}

// ============================================================
// Scenario 8: legacy lifecycle slot plus additive multicast listeners
// ============================================================

async function checkLifecycleMulticast(check: tCheck) {
    const cli = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    const hub = cli.hub
    const values: number[] = []
    const sub = replaySubscribe(remoteOf(cli, 'lifecycle'), function receiveLifecycle(value) {
        values.push(value)
    }, {since: 0})
    await sub.ready

    const legacyConnect: number[] = []
    const connectA: number[] = []
    const connectB: number[] = []
    const legacyDisconnect: string[] = []
    const disconnectA: string[] = []
    const disconnectB: string[] = []

    hub.onConnect(function onLegacyConnect(count) { legacyConnect.push(count) })
    hub.onDisconnect(function onLegacyDisconnect(reason) { legacyDisconnect.push(reason) })
    const offConnectA = hub.connectListen(function onConnectA(count) { connectA.push(count) })
    const offConnectB = hub.connectListen(function onConnectB(count) { connectB.push(count) })
    const offDisconnectA = hub.disconnectListen(function onDisconnectA(reason) { disconnectA.push(reason) })
    const offDisconnectB = hub.disconnectListen(function onDisconnectB(reason) { disconnectB.push(reason) })

    lifecycleLine.emit(1)
    await waitFor('lifecycle seq 1', () => values.length == 1)

    const firstBreak = await breakTransport(cli, 'lifecycle first')
    lifecycleLine.emit(2)
    await waitReconnect(cli, firstBreak, 'lifecycle first')
    lifecycleLine.emit(3)
    await waitFor('lifecycle first recovery', () => values.length == 3)
    await waitFor('lifecycle first disconnect notifications', () => disconnectB.length == 1)

    await check('lifecycle: legacy connect slot fires', () => legacyConnect, [firstBreak.count + 1])
    await check('lifecycle: both additive connect listeners fire', () =>
        [connectA, connectB], [[firstBreak.count + 1], [firstBreak.count + 1]])
    await check('lifecycle: legacy disconnect slot fires once', () => legacyDisconnect.length, 1)
    await check('lifecycle: both additive disconnect listeners fire once', () =>
        [disconnectA.length, disconnectB.length], [1, 1])

    offConnectA()
    offDisconnectA()
    hub.onConnect(null)
    hub.onDisconnect(null)

    const secondBreak = await breakTransport(cli, 'lifecycle second')
    lifecycleLine.emit(4)
    await waitReconnect(cli, secondBreak, 'lifecycle second')
    lifecycleLine.emit(5)
    await waitFor('lifecycle second recovery', () => values.length == 5)
    await waitFor('lifecycle second disconnect notification', () => disconnectB.length == 2)

    await check('lifecycle: off removes only connect listener A', () =>
        [connectA.length, connectB.length], [1, 2])
    await check('lifecycle: off removes only disconnect listener A', () =>
        [disconnectA.length, disconnectB.length], [1, 2])
    await check('lifecycle: clearing legacy slots leaves additive listeners alive', () =>
        [legacyConnect.length, legacyDisconnect.length], [1, 1])
    await check('lifecycle: replay recovery ignores public legacy slot changes', () =>
        values, numbers(1, 5))
    await check('lifecycle: internal recovery still has one server subscriber', serverSubscriberCount, 1)

    offConnectB()
    offDisconnectB()
    sub()
    await closeClient(cli)
}

// ============================================================
// Scenario 7: setToken remains a hard generation boundary
// ============================================================

async function checkHardTokenRotation(check: tCheck) {
    const cli = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    const oldClient = cli.client
    const oldRemote = remoteOf(cli, 'rotation')
    const oldSocket = cli.hub.socket
    const oldConnectCount = cli.hub.connectCount()
    const values: number[] = []
    const sub = replaySubscribe(oldRemote, function receiveBeforeRotation(value) { values.push(value) }, {since: 0})
    let rawDrained = false
    const rawHandle = oldRemote.line.on(function observeRotationLine() {}) as any
    rawHandle.then(function rotationLineDrained() { rawDrained = true })
    await sub.ready

    rotationLine.emit(1)
    await waitFor('rotation seq 1', () => values.length == 1)

    const legacyDisconnect: string[] = []
    const multicastDisconnect: string[] = []
    cli.hub.onDisconnect(function rememberLegacyRotation(reason) { legacyDisconnect.push(reason) })
    const offDisconnect = cli.hub.disconnectListen(function rememberMulticastRotation(reason) {
        multicastDisconnect.push(reason)
    })

    await cli.hub.setToken('rotated-token')
    const freshClient = currentClient(cli)
    await freshClient.readyStrict()
    await waitFor('rotation drains old consumer', () => rawDrained)
    await delay(100)

    const freshRemote = freshClient.func.replay.rotation as ReplayRemote<[number]>
    rotationLine.emit(2)
    await delay(140)

    await check('setToken: old raw subscription handle is drained', () => rawDrained, true)
    await check('setToken: old client has zero subscriptions', () =>
        oldClient.api.subscriptions().length, 0)
    await check('setToken: new generation starts with zero subscriptions', () =>
        freshClient.api.subscriptions().length, 0)
    await check('setToken: old replay is not auto-restored', () => values, [1])
    await check('setToken: creates a new Socket.IO object', () => cli.hub.socket !== oldSocket, true)
    await check('setToken: creates a new RPC Proxy generation', () => freshRemote !== oldRemote, true)
    await check('setToken: connectCount increments once', () =>
        cli.hub.connectCount(), oldConnectCount + 1)
    await check('setToken: legacy disconnect is one logical event', () => legacyDisconnect.length, 1)
    await check('setToken: multicast disconnect is one logical event', () => multicastDisconnect.length, 1)
    await check('setToken: no physical subscription crosses token generation', serverSubscriberCount, 0)

    offDisconnect()
    cli.hub.onDisconnect(null)
    sub()
    rawHandle()
    await closeClient(cli)
}

async function main() {
    const {check, done} = makeChecker('replay-reconnect')
    const watchdog = setTimeout(function watchdogTimeout() {
        console.error('WATCHDOG timeout')
        process.exit(3)
    }, 120000)

    const server = await startRealServer({
        port: PORT,
        makeObject,
        onServer: rememberServer,
    })

    await checkIdentityAndShortReconnect(check)
    await checkTwoConsumers(check)
    await checkRepeatedReconnect(check)
    await checkSacredEviction(check)
    await checkDisposeOffline(check)
    await checkLifecycleMulticast(check)
    await checkHardTokenRotation(check)

    clearTimeout(watchdog)
    await server.close()
    process.exit(done() == 0 ? 0 : 1)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
