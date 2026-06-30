// REAL-SOCKET lifecycle: disconnect teardown drains live subscriptions, fires
// onDisconnect (client + hub), and hard setToken rotation tears down old subs then
// reconnects (connectCount++). Default = teardown, NO auto-resubscribe. Port 4108.
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {UseListen} from '../../src/Common/events/Listen'

const PORT = 4108

// ===== facade: a method + two UseListen stream nodes =====
// The server fabricates a fresh facade per connection (see _rs.startRealServer),
// so each connection gets its own emit handle. We stash the latest emit on a
// module-level ref so the test body can push ticks into the live stream.
let emitTicks: ((n: number) => void) | null = null
let emitClock: ((s: string) => void) | null = null

function makeObject() {
    const [tick, tickListen] = UseListen<number>()
    const [clock, clockListen] = UseListen<string>()
    emitTicks = tick
    emitClock = clock
    return {
        ping: async () => 'pong',
        // Listen nodes: client subscribes via api.<node>.callback(fn)
        ticks: tickListen,
        clock: clockListen,
    }
}

async function main() {
    const {check, done} = makeChecker('lifecycle')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 40000)

    const srv = await startRealServer({port: PORT, makeObject})

    // ============================================================
    // PART 1 — client.dispose() drains a live subscription
    // ============================================================
    const cli = await startRealClient({port: PORT})
    const api = cli.api

    // sanity: a plain call round-trips over the real socket
    await check('CALL ping', () => api.ping(), 'pong')

    // subscribe to the `ticks` stream; collect ticks; the off-handle is a
    // callable thenable that RESOLVES when the stream ends (teardown/drain).
    const got1: number[] = []
    let drained1 = false
    const off1 = api.ticks.callback((n: number) => got1.push(n))
    off1.then(() => { drained1 = true }) // settle on stream end

    await delay(60) // let the subscription round-trip to the server
    emitTicks?.(1)
    emitTicks?.(2)
    await delay(60) // ticks travel back over the wire

    await check('subscription receives live ticks', () => got1.slice(), [1, 2])
    await check('1 live wire subscription before dispose', () => cli.client.api.subscriptions().length, 1)

    // dispose drains: the consumer promise settles, NO auto-resubscribe
    let cliDisconnectReason: string | null = null
    cli.client.onDisconnect((r: string) => { cliDisconnectReason = r })
    cli.client.dispose('test dispose')

    await delay(60)
    await check('client.onDisconnect fires with reason', () => cliDisconnectReason, 'test dispose')
    await check('dispose drained the consumer promise (resolved)', () => drained1, true)
    await check('no live subscriptions after dispose', () => cli.client.api.subscriptions().length, 0)

    // post-dispose ticks must NOT reach the (drained) consumer — honest teardown
    emitTicks?.(99)
    await delay(40)
    await check('no auto-resubscribe: stale ticks ignored after dispose', () => got1.slice(), [1, 2])

    cli.close()

    // ============================================================
    // PART 2 — hub.setToken hard rotation: teardown old subs, then reconnect
    // ============================================================
    const cli2 = await startRealClient({port: PORT})

    let hubDisconnectReason: string | null = null
    let connectFiredCount = 0
    cli2.hub.onDisconnect((r: string) => { hubDisconnectReason = r })
    cli2.hub.onConnect((count: number) => { connectFiredCount = count })

    await check('connectCount after initial connect', () => cli2.hub.connectCount(), 1)

    // subscribe on the clock stream of the FIRST connection
    const got2: string[] = []
    let drained2 = false
    const off2 = cli2.api.clock.callback((s: string) => got2.push(s))
    off2.then(() => { drained2 = true })

    await delay(60)
    emitClock?.('a')
    await delay(60)
    await check('rotation: sub receives tick on old connection', () => got2.slice(), ['a'])
    await check('1 live subscription before rotation', () => cli2.client.api.subscriptions().length, 1)

    // capture the OLD per-connection client surface (the facade swaps on rotation)
    const oldClient = cli2.client

    // HARD rotation: setToken tears down old subs (socketAlive:false), fires hub
    // onDisconnect, opens a fresh socket and fires onConnect again (connectCount++).
    await cli2.hub.setToken('rotated-token')
    await delay(120) // let the fresh socket connect + reconnect handshake

    await check('hub.onDisconnect fired on rotation', () => hubDisconnectReason, 'token rotated')
    await check('old subscription drained on rotation (no auto-resubscribe)', () => drained2, true)
    await check('old client has 0 live subscriptions after rotation', () => oldClient.api.subscriptions().length, 0)
    await check('connectCount incremented to 2 on rotation', () => cli2.hub.connectCount(), 2)
    await check('hub.onConnect fired again with fresh count', () => connectFiredCount, 2)

    // the NEW connection has NO carried-over subscription (default = teardown)
    await check('fresh connection starts with 0 subscriptions', () => {
        // facade[key] is the new per-connection client after rotation
        const fresh = (cli2.hub.facade as any).api
        return cli2.hub.connectCount() == 2 && fresh.api.subscriptions().length == 0
    }, true)

    cli2.close()

    clearTimeout(watchdog)
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
