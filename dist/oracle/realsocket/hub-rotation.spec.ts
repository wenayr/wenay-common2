// REAL-SOCKET hub rotation oracle. A token wave (setToken/connect) replaces the
// hub's connection: the NEW socket must be the only one left alive — a wave that
// strands its predecessor turns every logout/rotation into a zombie TCP socket
// holding server-side sessions (the mini-scale stand counted 13 browser-owned
// sockets on one mini's port after readers closed). Counted server-side via
// io.engine connections, not inferred from client state. Port 4173.
import {Server as SocketIOServer} from 'socket.io'
import {createServer} from 'http'
import {io} from 'socket.io-client'
import {makeChecker, delay} from './_rs'
import {listen as createListenPair} from '../../src/Common/events/Listen'
import {replayListen} from '../../src/Common/events/replay-listen'
import {exposeReplay, replaySubscribe} from '../../src/Common/events/replay-wire'
import {createRpcServerAuto} from '../../src/Common/rcp/rpc-server-auto'
import {createRpcClientHub} from '../../src/Common/rcp/rpc-clientHub'

const PORT = 4173
const WAIT_MS = 8000
const HUB_CLOSED = 'RPC hub closed'

async function waitFor(name: string, predicate: () => boolean, timeoutMs = WAIT_MS) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await delay(20)
    }
    throw new Error('timeout waiting for ' + name)
}

async function main() {
    const {check, done} = makeChecker('hub-rotation')
    const watchdog = setTimeout(function watchdogTimeout() {
        console.error('WATCHDOG timeout')
        process.exit(3)
    }, 120_000)

    const httpServer = createServer()
    const ioServer = new SocketIOServer(httpServer)
    const [emitTick, tickLine] = replayListen<[number]>({history: 32})
    ioServer.on('connection', function serveHubPeer(socket) {
        const [gone, goneListen] = createListenPair()
        socket.on('disconnect', function hubPeerGone() { gone() })
        createRpcServerAuto({
            socket,
            socketKey: 'app',
            object: {ping: () => 'pong', line: exposeReplay(tickLine)},
            disconnectListen: goneListen,
        })
    })
    await new Promise<void>(resolve => httpServer.listen(PORT, resolve))
    const live = () => ioServer.engine.clientsCount
    const lineSubs = () => tickLine.line.count()
    emitTick(1)

    function openHub() {
        return createRpcClientHub(
            () => io('http://localhost:' + PORT, {transports: ['websocket'], auth: {tab: 'hub-rotation'}}),
            r => ({app: r<any>('app')}) as const,
        )
    }

    // ============== 1. one wave = one connection (the sim-reader shape) ==============
    const hub = openHub()
    await check('no eager socket before the first wave', () => hub.socket == null, true)
    const clients = await hub.setToken(null) as any
    await clients.app.readyStrict()
    await check('first wave answers calls', () => clients.app.func.ping(), 'pong')
    await waitFor('first wave settles at one connection', () => live() == 1)
    await check('one wave holds exactly ONE server connection', live, 1)

    // ============== 2. hard rotation replaces, never strands ==============
    const firstSocket = hub.socket
    const rotated = await hub.setToken('tok:rotated') as any
    await rotated.app.readyStrict()
    await check('rotation raised a fresh socket object', () => hub.socket !== firstSocket, true)
    await waitFor('rotation leaves one connection', () => live() == 1)
    await check('hard rotation closes the replaced socket', live, 1)

    const backAnonymous = await hub.setToken(null) as any
    await backAnonymous.app.readyStrict()
    await waitFor('second rotation leaves one connection', () => live() == 1)
    await check('rotating back to anonymous still holds ONE connection', live, 1)

    // ============== 3. rapid rotation storm: no wave may strand its predecessor ==============
    hub.setToken('tok:a')
    hub.setToken('tok:b')
    const settled = await hub.setToken(null) as any
    await settled.app.readyStrict()
    await waitFor('rotation storm settles at one connection', () => live() == 1)
    await check('three back-to-back rotations leave ONE connection', live, 1)

    // ============== 4. the demo close path: hub.socket.disconnect() reaches zero ==============
    ;(hub.socket as any)?.disconnect?.()
    await waitFor('disconnect drains the server', () => live() == 0)
    await check('hub.socket.disconnect() closes the LAST connection too', live, 0)

    // ============== 5. a token-provider hub self-starts exactly one connection ==============
    const provided = createRpcClientHub(
        () => io('http://localhost:' + PORT, {transports: ['websocket'], auth: {tab: 'hub-provider'}}),
        r => ({app: r<any>('app')}) as const,
        {token: async function provideHubToken() { return null }},
    )
    const started = await provided.promise as any
    await started.app.readyStrict()
    await waitFor('provider self-start settles at one connection', () => live() == 1)
    await check('a provider hub opens exactly ONE connection', live, 1)
    const explicitWave = await provided.setToken('tok:explicit') as any
    await explicitWave.app.readyStrict()
    await waitFor('explicit wave over provider leaves one connection', () => live() == 1)
    await check('an explicit wave over a provider hub strands nothing', live, 1)
    ;(provided.socket as any)?.disconnect?.()
    await waitFor('provider hub teardown drains the server', () => live() == 0)
    await check('teardown returns the server to zero connections', live, 0)

    // ============== 6. MOTIVATION RECORD: today's only teardown is a raw-socket sweep ==============
    // Without a close() verb a consumer can only disconnect the sockets its
    // createSocket callback has returned so far (the mini-scale demo did exactly
    // that). Two exposures follow. (a) mid-handshake: the sweep hits a socket
    // whose engine is still opening — in real browsers the landed open re-armed
    // the wave (live stand: 13-14 orphaned engines). (b) the wave RACE: a wave
    // that lands after the sweep is adopted — its socket is connected, carries
    // the hub's wiring, and no reference the consumer holds can ever reach it.
    const sweptSockets = new Set<any>()
    const sweptHub = createRpcClientHub(
        () => {
            const raw = io('http://localhost:' + PORT, {transports: ['websocket', 'polling'], auth: {tab: 'hub-swept'}})
            sweptSockets.add(raw)
            return raw
        },
        r => ({app: r<any>('app')}) as const,
    )
    const sweptClients = await sweptHub.setToken(null) as any
    await sweptClients.app.readyStrict()
    const sweptValues: number[] = []
    const sweptSub = replaySubscribe(sweptClients.app.func.line, function receiveSweptTick(value: number) {
        sweptValues.push(value)
    }, {since: 0})
    await sweptSub.ready
    await waitFor('swept hub subscribes the line', () => lineSubs() == 1 && sweptValues.length == 1)

    // (a) a second hub torn down mid-handshake: no engine may survive or return
    const midSockets = new Set<any>()
    const midHub = createRpcClientHub(
        () => {
            const raw = io('http://localhost:' + PORT, {transports: ['websocket', 'polling'], auth: {tab: 'hub-mid'}})
            midSockets.add(raw)
            return raw
        },
        r => ({app: r<any>('app')}) as const,
    )
    void midHub.setToken(null)
    for (const raw of midSockets) raw.disconnect()   // the engine is still opening here
    await delay(1500)
    await check('mid-handshake sweep leaves no engine behind', live, 1)

    // (b) the wave race: sweep FIRST, then a wave the consumer never saw lands.
    // RECORDED HAZARD (this is why close() exists — the check below failed with 1 != 0
    // before close() shipped): the late wave is ADOPTED, its engine lives, and no raw
    // socket the consumer ever captured can reach it. Only close() ends it.
    for (const raw of sweptSockets) raw.disconnect()
    await waitFor('sweep drains the swept hub', () => live() == 0)
    void (sweptHub.setToken(null) as Promise<any>).catch(function ignoreLateWave() {})
    await delay(1500)
    await check('MOTIVATION RECORD: sweep-only teardown cannot stop a late wave being adopted', live, 1)
    await check('the adopted wave does not resurrect the line subscription by itself', lineSubs, 0)
    await check('close() reaps the adopted wave', () => sweptHub.close(), true)
    await waitFor('the adopted wave engine dies with the hub', () => live() == 0)
    await check('after close() the server is back to zero connections', live, 0)

    // ============== 7. ACCEPTANCE: close() semantics ==============
    // close() during a live subscription: everything drains, nothing resurrects.
    const closable = openHub()
    const closableClients = await closable.setToken(null) as any
    await closableClients.app.readyStrict()
    const closableTicks: number[] = []
    const closableSub = replaySubscribe(closableClients.app.func.line, function receiveClosableTick(value: number) {
        closableTicks.push(value)
    }, {since: 0})
    await closableSub.ready
    await waitFor('closable hub holds one engine and one line sub', () => live() == 1 && lineSubs() == 1)
    await check('close() on a live hub reports the teardown', () => closable.close(), true)
    await waitFor('close() drains the engine and the line subscription', () => live() == 0 && lineSubs() == 0)
    await delay(1200) // any reconnect timer that survived close() would resurrect here
    await check('nothing resurrects after close()', () => [live(), lineSubs()], [0, 0])
    await check('close() is idempotent (second call reports false)', () => closable.close(), false)
    await check('setToken after close() is refused by rejection', () =>
        (closable.setToken('tok:late') as Promise<any>).then(
            function lateWaveAdopted() { return 'adopted' },
            function lateWaveRefused(error: any) { return String(error?.message ?? error) },
        ), HUB_CLOSED)
    await check('reauth after close() is refused by rejection', () =>
        closable.reauth('tok:late').then(
            function lateReauthAccepted() { return 'accepted' },
            function lateReauthRefused(error: any) { return String(error?.message ?? error) },
        ), HUB_CLOSED)
    await check('refused waves raise no connection', live, 0)

    // close() MID-WAVE — the crux: the wave completes after close() and must be
    // disposed, not adopted; the caller's pending promise settles by rejection.
    const midWaveHub = openHub()
    const pendingWave = midWaveHub.setToken(null) as Promise<any>
    await check('close() lands while the first wave is still in flight', () => midWaveHub.close(), true)
    await check('the pending wave settles by rejection, never hangs', () =>
        pendingWave.then(
            function midWaveAdopted() { return 'adopted' },
            function midWaveRefused(error: any) { return String(error?.message ?? error) },
        ), HUB_CLOSED)
    await delay(1200) // a landed open would show up here as a live engine
    await check('a wave completing after close() is disposed, not adopted', live, 0)

    clearTimeout(watchdog)
    await new Promise<void>(resolve => { ioServer.close(); httpServer.close(() => resolve()) })
    process.exit(done() == 0 ? 0 : 1)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
