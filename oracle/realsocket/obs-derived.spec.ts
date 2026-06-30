// ============================================================
//  oracle/realsocket/obs-derived.spec.ts — DISPOSABLE real-socket oracle
//
//  Category "obs-derived": computed + combine streamed over a REAL socket.io
//  WebSocket via RPC. A derived node streams its computed value to a remote
//  subscriber; updating a SOURCE propagates the recomputed value over the wire;
//  the derived node emits ONLY on a real value change (no spurious dup emits);
//  combine of multiple cells streams correctly.
//
//   node node_modules/ts-node/dist/bin.js --transpile-only oracle/realsocket/obs-derived.spec.ts
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createCell, combine, computed} from '../../observable/reactive'

const PORT = 4203

// ── nodes in OUTER scope so the test can mutate sources after the client subscribes
const a = createCell(2)
const b = createCell(3)
// combine of multiple cells: a + b
const sum = combine([a, b], ([x, y]) => x + y)
// computed over a single source: a doubled (used to prove no-spurious-emit)
const doubledA = computed(a, x => x * 2)
// combine whose value depends only on the MAX — used to prove value-change dedup:
// changing a source that does not move the max must NOT emit, even though the
// source itself emitted and the combine recomputed.
const maxAB = combine([a, b], ([x, y]) => Math.max(x, y))

// per-connection facade: hand out the derived nodes' Listen façades
function makeObject() {
    return {
        sum: sum.listen(),
        doubledA: doubledA.listen(),
        maxAB: maxAB.listen(),
    }
}

async function main() {
    const {check, done} = makeChecker('obs-derived')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 45000)

    const srv = await startRealServer({port: PORT, makeObject})
    const cli = await startRealClient({port: PORT})

    const gotSum: number[] = []
    const gotDoubled: number[] = []
    const gotMax: number[] = []

    // baseline known source values (module load left them at 2/3; pin explicitly)
    a.set(2); b.set(3)

    // subscribe over the real wire to all three derived nodes
    const subSum: any = cli.api.sum.callback((v: any) => gotSum.push(v))
    const subDbl: any = cli.api.doubledA.callback((v: any) => gotDoubled.push(v))
    const subMax: any = cli.api.maxAB.callback((v: any) => gotMax.push(v))
    await delay(50)

    // subscribing the derived nodes connects them upstream → sources become live.
    // a is upstream of sum(+1), doubledA(+1), maxAB(+1) = 3 ; b of sum(+1), maxAB(+1) = 2
    await check('subscribing derived connects upstream sources (a.count==3)', () => a.count(), 3)
    await check('subscribing derived connects upstream sources (b.count==2)', () => b.count(), 2)

    // ── source mutation propagates the recomputed value over the wire ──
    a.set(10)            // sum: 10+3=13 ; doubledA: 20 ; maxAB: max(10,3)=10
    await delay(30)
    b.set(0)             // sum: 10+0=10 ; doubledA unchanged (a=10) ; maxAB max(10,0)=10 → unchanged
    await delay(30)

    await check('combine streams recomputed values over real socket', async () => JSON.stringify(gotSum), '[13,10]')
    await check('computed streams recomputed value over real socket', async () => JSON.stringify(gotDoubled), '[20]')

    // ── derived emits ONLY on a real value change (no spurious duplicate) ──
    a.set(10)            // a unchanged → no source emit at all
    await delay(30)
    b.set(0)             // b unchanged → no source emit
    await delay(30)
    await check('no spurious emit when source value is unchanged (sum)', async () => JSON.stringify(gotSum), '[13,10]')
    await check('no spurious emit when source value is unchanged (doubled)', async () => JSON.stringify(gotDoubled), '[20]')

    // ── value-change dedup: a source REALLY changes & combine recomputes, but the
    //    combine RESULT is unchanged → no emit over the wire. State: a=10,b=0,max=10.
    //    Lower b within [.,10) keeps max==10 → maxAB must NOT emit. ──
    b.set(5)             // max(10,5)=10 → unchanged → no emit ; sum:10+5=15 → emits
    await delay(40)
    await check('combine dedups when recomputed value is unchanged', async () => JSON.stringify(gotMax), '[10]')
    await check('combine still emits on a real value change (sum)', async () => JSON.stringify(gotSum), '[13,10,15]')

    // ── server-side refcount via remote unsubscribe ──
    subSum.unsubscribe?.()
    subDbl.unsubscribe?.()
    subMax.unsubscribe?.()
    await delay(50)
    // last listener leaving disconnects the derived from upstream → sources cold again
    await check('upstream sources cold again after remote unsubscribe (a.count==0)', () => a.count(), 0)
    await check('upstream sources cold again after remote unsubscribe (b.count==0)', () => b.count(), 0)

    // further source mutations after unsubscribe must NOT reach the client
    a.set(99); b.set(99)
    await delay(30)
    await check('no events after remote unsubscribe (sum)', async () => JSON.stringify(gotSum), '[13,10,15]')

    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
