// REAL-SOCKET stress: MASS / volume over a genuine WebSocket. Port 4111.
//  (1) 500+ concurrent CALLs — id-pool integrity, no dropped/mismatched RESP.
//  (2) 50+ concurrent subscribers + 100+ high-freq ticks — no loss, clean teardown to 0.
//  (3) mixed concurrent calls + streams.
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {listen as createListenPair} from '../../src/Common/events/Listen'

const PORT = 4111

// ===================================================================
//  facade — captured emit handles (single client connection ⇒ makeObject
//  runs once; we stash the per-connection emitters at module scope).
// ===================================================================
let emitTick: ((n: number) => void) | null = null   // stream A: high-frequency ticks
let emitMix: ((n: number) => void) | null = null     // stream B: used in the mixed test

function makeObject() {
    const [tick, tickListen] = createListenPair<number>()
    const [mix, mixListen] = createListenPair<number>()
    emitTick = tick
    emitMix = mix
    return {
        // identity call — server echoes the request index back; lets us assert
        // every one of N concurrent responses landed on the right promise.
        idn: async (i: number) => i,
        // arithmetic so a mismatched correlation would produce a wrong value, not just a wrong tag.
        sq: async (i: number) => i * i,
        ticks: tickListen,
        mixStream: mixListen,
    }
}

async function main() {
    const {check, done} = makeChecker('stress')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 40000)

    // capture the per-connection server api (for subscriptions() leak checks)
    let srvApi: any = null
    const srv = await startRealServer({port: PORT, makeObject, onServer: (api) => { srvApi = api }})
    const cli = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    const api = cli.api

    // =============================================================
    //  (1) MASS CALLs — 600 concurrent, assert every result correct
    // =============================================================
    const N = 600
    const idxs = Array.from({length: N}, (_, i) => i)
    const results = await Promise.all(idxs.map(i => api.idn(i)))
    // every response matches its request index (no mismatched correlation)
    await check('mass: 600 idn results in order', () => results, idxs)
    await check('mass: zero mismatches', () => results.filter((v, i) => v !== i).length, 0)

    // a second wave through the SAME id-pool — proves released ids are reusable & clean
    const sqResults = await Promise.all(idxs.map(i => api.sq(i)))
    await check('mass: 600 sq second wave', () => sqResults.filter((v, i) => v !== i * i).length, 0)
    // id-pool fully drained back: no pending requests left hanging
    await delay(50)
    await check('mass: pending drained to 0', () => (cli.client.api as any).pending(), 0)

    // =============================================================
    //  (2) MASS SUBSCRIBERS — 60 subscribers, 120 high-freq ticks
    // =============================================================
    const SUBS = 60
    const TICKS = 120
    const buckets: number[][] = Array.from({length: SUBS}, () => [])
    // NB: callback() returns a callable off-handle (a thenable that resolves only
    // when the STREAM ENDS) — do NOT await it, or Promise.all would block forever.
    const offs = buckets.map((b) => (api.ticks as any).callback((v: number) => b.push(v)))
    // give every subscription a round-trip to register on the server
    await delay(120)

    // Client-side dedup (on by default): 60 identical `ticks.callback(fn)` subscribers
    // collapse to ONE wire subscription; the 60-way fan-out happens locally. So:
    //   • client subscriptions(): one entry, consumers == 60 (all local consumers)
    //   • server subscriptions(): one node, consumers == 1 (the single wire callback)
    await check('subs: client one wire sub, 60 local consumers', () => {
        const list = (cli.client.api as any).subscriptions() as {consumers: number}[]
        return [list.length, list[0]?.consumers]
    }, [1, SUBS])
    await check('subs: server sees one wire consumer (dedup)', () => {
        const subsList = srvApi.subscriptions() as {consumers: number}[]
        return [subsList.length, subsList.reduce((a, e) => a + e.consumers, 0)]
    }, [1, 1])

    // high-frequency burst: no awaits between emits
    for (let i = 0; i < TICKS; i++) emitTick!(i)
    // generous drain for the real socket to deliver every CB
    await delay(400)

    // every subscriber received every tick — no loss, no dup
    const expectedSeq = Array.from({length: TICKS}, (_, i) => i)
    await check('subs: every bucket has all 120 ticks', () => buckets.filter(b => b.length !== TICKS).length, 0)
    await check('subs: total CBs == 60*120', () => buckets.reduce((a, b) => a + b.length, 0), SUBS * TICKS)
    await check('subs: bucket #0 exact sequence', () => buckets[0], expectedSeq)
    await check('subs: bucket #59 exact sequence', () => buckets[SUBS - 1], expectedSeq)

    // clean teardown — off() each, then both client and server registries empty
    for (const off of offs) off()
    await delay(200)
    await check('subs: client wireSubs back to 0', () => (cli.client.api as any).subscriptions().length, 0)
    await check('subs: server subscriptions back to 0', () => srvApi.subscriptions().length, 0)

    // post-teardown ticks must reach nobody (no leak / dangling consumer)
    const before = buckets.reduce((a, b) => a + b.length, 0)
    for (let i = 0; i < 30; i++) emitTick!(999)
    await delay(150)
    await check('subs: no delivery after teardown', () => buckets.reduce((a, b) => a + b.length, 0), before)

    // =============================================================
    //  (3) MIXED — concurrent calls + a fresh stream burst together
    // =============================================================
    const mixBuckets: number[][] = Array.from({length: 10}, () => [])
    const mixOffs = mixBuckets.map(b => (api.mixStream as any).callback((v: number) => b.push(v)))
    await delay(80)
    // fire 200 calls AND 50 ticks interleaved
    const callP = Promise.all(Array.from({length: 200}, (_, i) => api.sq(i)))
    for (let i = 0; i < 50; i++) emitMix!(i)
    const mixCalls = await callP
    await delay(250)
    await check('mixed: 200 calls all correct under stream load', () => mixCalls.filter((v, i) => v !== i * i).length, 0)
    await check('mixed: each of 10 subs got all 50 ticks', () => mixBuckets.filter(b => b.length !== 50).length, 0)
    for (const off of mixOffs) off()
    await delay(150)
    await check('mixed: server subscriptions back to 0', () => srvApi.subscriptions().length, 0)

    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
