// REAL-SOCKET regression: reconnect recovery must wait for delayed in-band auth
// before recreating the physical replay subscription. Port 4125.
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {replayListen} from '../../src/Common/events/replay-listen'
import {exposeReplay, replaySubscribe, ReplayRemote} from '../../src/Common/events/replay-wire'

const PORT = 4125
const WAIT_MS = 10000
const AUTH_DELAY_MS = 180

const [emit, replay] = replayListen<[number]>({history: 16})
const principal = {replay: exposeReplay(replay)}
const serverApis: any[] = []
let authCount = 0

async function resolveAuth(token: any) {
    authCount++
    await delay(AUTH_DELAY_MS)
    if (token != 'replay-token') throw new Error('bad token')
    return {object: principal, ack: {ok: true}}
}

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

async function waitFor(name: string, predicate: () => boolean, timeoutMs = WAIT_MS) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await delay(10)
    }
    throw new Error('timeout waiting for ' + name)
}

async function main() {
    const {check, done} = makeChecker('replay-reconnect-auth')
    const watchdog = setTimeout(function watchdogExpired() {
        console.error('WATCHDOG timeout')
        process.exit(3)
    }, 40000)

    const srv = await startRealServer({
        port: PORT,
        makeObject: function makeGatedObject() { return {} },
        serverOpts: {auth: {resolveAuth, gate: true}},
        onServer: rememberServer,
    })
    const cli = await startRealClient({port: PORT, token: 'replay-token'})
    const remote = (cli.client.func as any).replay as ReplayRemote<[number]>
    const values: number[] = []
    const seqs: number[] = []
    const sub = replaySubscribe(remote, function receiveValue(value) {
        values.push(value)
    }, {
        since: 0,
        onSeq: function rememberSeq(seq) { seqs.push(seq) },
    })
    await sub.ready

    emit(1)
    await waitFor('initial live seq 1', () => values.length == 1)

    const socket = cli.hub.socket as any
    const connectCount = cli.hub.connectCount()
    const authBeforeReconnect = authCount
    const engine = socket.io?.engine
    if (!engine?.close) throw new Error('Engine.IO close() is unavailable')
    engine.close()
    await waitFor('transport disconnect', () => !socket.connected)

    emit(2)
    await waitFor('same Socket.IO object reconnect', () =>
        socket.connected && cli.hub.connectCount() == connectCount + 1)
    await waitFor('authenticated catch-up seq 2', () =>
        values.length == 2 && serverSubscriberCount() == 1)

    // The physical line is installed and catch-up has drained, so seq 3 is live.
    emit(3)
    await waitFor('live seq 3 after reconnect', () => values.length == 3)

    await check('reconnect performs one fresh delayed auth', () => authCount, authBeforeReconnect + 1)
    await check('reconnect preserves Socket.IO object identity', () => cli.hub.socket === socket, true)
    await check('reconnect increments connectCount exactly once', () => cli.hub.connectCount(), connectCount + 1)
    await check('catch-up then live delivery has no gap or duplicate', () => values, [1, 2, 3])
    await check('reported seq has no gap or duplicate', () => seqs, [1, 2, 3])
    await check('one logical client subscription survives reconnect', () =>
        cli.client.api.subscriptions().length, 1)
    await check('one physical server subscription after reconnect', serverSubscriberCount, 1)

    sub()
    await waitFor('subscription cleanup', () =>
        cli.client.api.subscriptions().length == 0 && serverSubscriberCount() == 0)
    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() == 0 ? 0 : 1)
}

main().catch(function reportFailure(error) {
    console.error(error)
    process.exit(2)
})
