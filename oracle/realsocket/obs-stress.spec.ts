// REAL-SOCKET obs-stress: BATTLE / volume — OBSERVABLE reactive nodes streamed
// THROUGH RPC over a genuine socket.io WebSocket. Port 4208 (ours alone).
//
//  Pattern (from observable/test.ts '[rpc] real client+server round-trip'):
//   put node.listen() into the per-connection server object; subscribe from the
//   client via the proxy `.callback(fn)`; mutate via node.set(...); assert the
//   client received every tick and the server-side node.count() refcount tracks
//   subscribe/unsubscribe. Adapted from loopback to the REAL socket via _rs.
//
//  Nodes live in OUTER scope so the test mutates them AFTER the client subscribes.
//   • 60 plain cells, each its own remote subscription
//   • 100+ high-frequency mutations spread across them — assert ZERO loss and the
//     correct final value + tick count per subscriber
//   • a few computed/combine derived nodes mixed in
//   • unsubscribe/dispose ALL → every server-side node returns to count()==0
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createCell, combine, computed} from '../../observable/reactive'

const PORT = 4208

// ===================================================================
//  nodes — OUTER scope so we can mutate after the client subscribes
// ===================================================================
const NCELLS = 60
const cells = Array.from({length: NCELLS}, (_, i) => createCell(i))   // cell[i] starts at i

// derived nodes (mixed in): sum of two cells, double of one cell, a combine of three
const sumAB = combine([cells[0], cells[1]], ([a, b]) => a + b)
const doubleC = computed(cells[2], v => v * 2)
const tripleSum = combine([cells[3], cells[4], cells[5]], ([a, b, c]) => a + b + c)

// makeObject runs once per connection; expose every node's listen() handle.
function makeObject() {
    const obj: Record<string, any> = {sumAB: sumAB.listen(), doubleC: doubleC.listen(), tripleSum: tripleSum.listen()}
    for (let i = 0; i < NCELLS; i++) obj['c' + i] = cells[i].listen()
    return obj
}

async function main() {
    const {check, done} = makeChecker('obs-stress')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 45000)

    let srvApi: any = null
    const srv = await startRealServer({port: PORT, makeObject, onServer: (api) => { srvApi = api }})
    const cli = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    const api = cli.api

    // =============================================================
    //  subscribe — one remote subscription per cell (60 distinct wire subs)
    // =============================================================
    const buckets: number[][] = Array.from({length: NCELLS}, () => [])
    // callback() returns a callable off-handle; do NOT await it.
    const cellOffs = cells.map((_, i) => (api['c' + i] as any).callback((v: number) => buckets[i].push(v)))

    // derived subscribers
    const sumABGot: number[] = []
    const doubleCGot: number[] = []
    const tripleSumGot: number[] = []
    const dSumAB: any = (api.sumAB as any).callback((v: number) => sumABGot.push(v))
    const dDoubleC: any = (api.doubleC as any).callback((v: number) => doubleCGot.push(v))
    const dTripleSum: any = (api.tripleSum as any).callback((v: number) => tripleSumGot.push(v))

    // generous registration drain over the real socket
    await delay(200)

    // Each cell carries its own direct wire subscriber (1). Cells 0..5 ALSO feed a
    // live derived node, which subscribes upstream when it goes hot — so those 6 carry
    // an EXTRA upstream subscriber (count 2). The rest carry exactly 1. This asserts
    // the per-node refcount is EXACTLY the number of real subscribers, derived included.
    const derivedFed = new Set([0, 1, 2, 3, 4, 5])   // sumAB:0,1  doubleC:2  tripleSum:3,4,5
    await check('every cell refcount exactly matches subscriber count (direct + derived upstream)',
        () => cells.filter((c, i) => c.count() !== (derivedFed.has(i) ? 2 : 1)).length, 0)
    await check('plain (non-derived-fed) cells all refcount 1', () => cells.filter((c, i) => !derivedFed.has(i) && c.count() !== 1).length, 0)
    // derived nodes are live (subscribed upstream + one wire sub each)
    await check('derived nodes each refcount == 1', () => [sumAB.count(), doubleC.count(), tripleSum.count()], [1, 1, 1])

    // =============================================================
    //  BATTLE — 100+ high-frequency mutations spread across the cells
    //   each cell c[i] is set to a deterministic series of values; the final
    //   value and exact tick count per subscriber is then asserted with no loss.
    // =============================================================
    // round-robin burst: 5 full passes over 60 cells = 300 mutations, all distinct
    // values per cell (cell i gets i+1000, i+2000, ... i+5000) → each set() changes
    // the value so every one emits (no equals() suppression).
    const PASSES = 5
    for (let pass = 1; pass <= PASSES; pass++) {
        for (let i = 0; i < NCELLS; i++) cells[i].set(i + pass * 1000)
    }
    // generous drain for the real socket to deliver every CB
    await delay(500)

    // every subscriber received exactly PASSES ticks — ZERO loss, ZERO dup
    await check('every bucket has exactly PASSES ticks (no loss)', () => buckets.filter(b => b.length !== PASSES).length, 0)
    await check('total CBs == NCELLS * PASSES', () => buckets.reduce((a, b) => a + b.length, 0), NCELLS * PASSES)
    // exact ordered sequence for a sample cell (#0): [1000, 2000, 3000, 4000, 5000]
    await check('cell #0 exact ordered sequence', () => buckets[0], [1000, 2000, 3000, 4000, 5000])
    // exact ordered sequence for last cell (#59): [1059, 2059, 3059, 4059, 5059]
    await check('cell #59 exact ordered sequence', () => buckets[NCELLS - 1],
        Array.from({length: PASSES}, (_, p) => (NCELLS - 1) + (p + 1) * 1000))
    // final value per cell is its last mutation (i + PASSES*1000)
    await check('every cell final delivered value correct', () =>
        buckets.filter((b, i) => b[b.length - 1] !== i + PASSES * 1000).length, 0)

    // derived correctness: each upstream change recomputed & streamed.
    //  sumAB tracks cells[0]+cells[1]; final = (0+5000) + (1+5000) = 10001
    await check('combine sumAB final value correct', () => sumABGot[sumABGot.length - 1], (0 + PASSES * 1000) + (1 + PASSES * 1000))
    //  doubleC tracks cells[2]*2; final = (2+5000)*2 = 10004
    await check('computed doubleC final value correct', () => doubleCGot[doubleCGot.length - 1], (2 + PASSES * 1000) * 2)
    //  tripleSum tracks cells[3]+cells[4]+cells[5]; final = sum of (i+5000) for i in 3..5
    await check('combine tripleSum final value correct', () => tripleSumGot[tripleSumGot.length - 1],
        (3 + PASSES * 1000) + (4 + PASSES * 1000) + (5 + PASSES * 1000))
    // derived nodes emitted at least once each (proves the push path ran)
    await check('all derived streams delivered something', () =>
        [sumABGot.length > 0, doubleCGot.length > 0, tripleSumGot.length > 0], [true, true, true])

    // =============================================================
    //  TEARDOWN — unsubscribe/dispose ALL, assert every node back to count()==0
    // =============================================================
    for (const off of cellOffs) off()
    dSumAB.unsubscribe?.(); dDoubleC.unsubscribe?.(); dTripleSum.unsubscribe?.()
    await delay(400)

    await check('every cell back to refcount 0 (no leak)', () => cells.filter(c => c.count() !== 0).length, 0)
    await check('derived nodes back to refcount 0', () => [sumAB.count(), doubleC.count(), tripleSum.count()], [0, 0, 0])
    await check('server subscriptions registry empty', () => srvApi.subscriptions().length, 0)

    // post-teardown mutations reach nobody (no dangling consumer)
    const before = buckets.reduce((a, b) => a + b.length, 0)
    for (let i = 0; i < NCELLS; i++) cells[i].set(99999)
    sumAB && cells[0].set(123456)
    await delay(200)
    await check('no delivery after full teardown', () => buckets.reduce((a, b) => a + b.length, 0), before)

    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
