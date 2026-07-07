// REAL-SOCKET dedupe: subscription dedupe + refcount + server stats + cap. Port 4106.
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {listen as createListenPair} from '../../src/Common/events/Listen'

const PORT = 4106

// One stream node per facade; emit pushes a value to whoever subscribed.
// `feed` is a server-side method the client can call to drive an emission.
function makeObject() {
    const [emitA, listenA] = createListenPair<number>()
    const [emitB, listenB] = createListenPair<number>()
    return {
        // The Listen handle itself IS the node; resolveTransform turns it into
        // {callback, removeCallback}, so the wire path is `streamA.callback`.
        streamA: listenA,
        streamB: listenB,
        // server-side drivers: tell the server to fire an event into a stream.
        feedA: async (v: number) => { emitA(v); return v },
        feedB: async (v: number) => { emitB(v); return v },
    }
}

async function main() {
    const {check, done} = makeChecker('dedupe')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 40000)

    // capture per-connection server api for subscription stats
    let serverApi: any = null
    const srv = await startRealServer({port: PORT, makeObject, onServer: (api) => { serverApi = api }})
    const cli = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    const api = cli.api

    await delay(50) // let handshake (MAP / declared listens) settle

    // =====================================================================
    // Part 1: two local consumers, SAME address → ONE wire subscription.
    // =====================================================================
    const gotC1: number[] = []
    const gotC2: number[] = []
    const off1 = api.streamA.callback((v: number) => gotC1.push(v))
    const off2 = api.streamA.callback((v: number) => gotC2.push(v))
    await delay(80) // subscription round-trip

    // Client side: ONE wire sub, with TWO local consumers.
    await check('client wireSubs count == 1 (deduped)',
        () => cli.client.api.subscriptions().length, 1)
    await check('client consumers == 2 (two local on same address)',
        () => cli.client.api.subscriptions()[0].consumers, 2)

    // Server side: ONE Listen node, ONE wire subscriber (dedupe collapsed the two).
    await check('server subscriptions: 1 node',
        () => serverApi.subscriptions().length, 1)
    await check('server consumers == 1 (single shared wire sub)',
        () => serverApi.subscriptions()[0].consumers, 1)

    // Fan-out: one server emit reaches BOTH local consumers.
    await api.feedA(7)
    await delay(80)
    await check('fan-out: consumer1 received [7]', () => gotC1, [7])
    await check('fan-out: consumer2 received [7]', () => gotC2, [7])

    // =====================================================================
    // Part 2: refcount — wire stop only when the LAST consumer leaves.
    // =====================================================================
    off1() // first consumer leaves
    await delay(80)
    await check('after off1: still 1 wire sub (refcount > 0)',
        () => cli.client.api.subscriptions().length, 1)
    await check('after off1: consumers dropped to 1',
        () => cli.client.api.subscriptions()[0]?.consumers, 1)
    await check('after off1: server STILL has the node (wire alive)',
        () => serverApi.subscriptions().length, 1)

    // Surviving consumer still receives events.
    await api.feedA(11)
    await delay(80)
    await check('after off1: consumer2 still gets events [7,11]', () => gotC2, [7, 11])
    await check('after off1: consumer1 stopped getting events [7]', () => gotC1, [7])

    off2() // LAST consumer leaves → wire stop fires
    await delay(120) // removeCallback is fire-and-forget; give it round-trip time
    await check('after last off: client wireSubs empty',
        () => cli.client.api.subscriptions().length, 0)
    await check('after last off: server node removed (wire stop fired)',
        () => serverApi.subscriptions().length, 0)

    // =====================================================================
    // Part 3: maxPerListen cap — over-cap subscriptions silently ignored.
    // Distinct addresses (different non-cb args) on the SAME Listen node each
    // create a wire sub; the cap is per Listen node on the server.
    // =====================================================================
    cli.close()
    await srv.close()
    await delay(50)

    const CAP = 2
    let serverApi2: any = null
    const srv2 = await startRealServer({
        port: PORT, makeObject,
        serverOpts: {maxPerListen: CAP},
        onServer: (api) => { serverApi2 = api },
    })
    const cli2 = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    const api2 = cli2.api
    await delay(50)

    // Three DISTINCT-address subscriptions on streamA: the callback comes FIRST
    // (so server-side listenSocket.callback(z) still gets the fn), a trailing tag
    // arg makes each dedupe address unique → three independent wire subs. Cap is 2.
    const recv: Record<string, number[]> = {s0: [], s1: [], s2: []}
    api2.streamA.callback((v: number) => recv.s0.push(v), 0)
    api2.streamA.callback((v: number) => recv.s1.push(v), 1)
    api2.streamA.callback((v: number) => recv.s2.push(v), 2)
    await delay(120)

    // The client issues three distinct-address wire subs, but the over-cap one is
    // silently resolved by the server (subscribe returns Promise.resolve()), which
    // fires the client's .then(finish) and tears that wire entry down locally — so
    // the client settles back to CAP live wire subs. (Server-side cap below is the
    // load-bearing assertion; this documents the client-side consequence.)
    await check('client settles to CAP live wire subs (over-cap torn down)',
        () => cli2.client.api.subscriptions().length, CAP)

    // Server accepted only CAP subscribers on the node; over-cap silently ignored.
    await check('server node consumers capped at maxPerListen',
        () => serverApi2.subscriptions()[0]?.consumers, CAP)

    // Emit reaches exactly the accepted subscribers (first CAP), not the dropped one.
    await api2.feedA(99)
    await delay(100)
    await check('capped: accepted sub s0 got [99]', () => recv.s0, [99])
    await check('capped: accepted sub s1 got [99]', () => recv.s1, [99])
    await check('capped: over-cap sub s2 got nothing []', () => recv.s2, [])

    clearTimeout(watchdog)
    cli2.close()
    await srv2.close()

    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
