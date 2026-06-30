// ============================================================
//  oracle/realsocket/obs-shape.spec.ts — DISPOSABLE battle-test
//
//  CATEGORY "obs-shape": shape compaction of a reactive OBJECT stream
//  pushed over a REAL socket.io WebSocket via RPC.
//
//  A createCell holds a MONOMORPHIC plain object {id, name, balance, at:Date}.
//  Mutated >=8 times at high frequency. The server's adaptive compaction
//  (rpc-shape.ts) standardizes a repeated shape after THRESHOLD(5) occurrences:
//  first a Pkt.SHAPE(keys) then Pkt.CBV(values), and compact Pkt.CBV after.
//  We assert (1) the remote subscriber receives EVERY update intact incl. the
//  Date, nothing dropped/corrupted, and (2) we directly OBSERVE Pkt.CBV/Pkt.SHAPE
//  engaging by spying server-side socket.emit. Then refcount up/down.
//
//  run: node node_modules/ts-node/dist/bin.js --transpile-only oracle/realsocket/obs-shape.spec.ts
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createCell} from '../../observable/reactive'
import {Pkt} from '../../src/Common/rcp/rpc-protocol'

const PORT = 4207

// ── nodes in OUTER scope so the test can mutate them after the client subscribes ──
// A monomorphic plain object: SAME keys every tick, includes a Date field.
type tRow = {id: number, name: string, balance: number, at: Date}
const row = createCell<tRow>({id: 0, name: 'init', balance: 0, at: new Date('2026-01-01T00:00:00.000Z')})
function makeObject() { return {row: row.listen()} }

// ── server-side wire spy: count Pkt.SHAPE / Pkt.CBV / Pkt.CB on the row channel ──
const wire = {shape: 0, cbv: 0, cb: 0}
function spyServer(_api: any, socket: any) {
    const orig = socket.emit.bind(socket)
    socket.emit = function spiedEmit(ev: string, d: any) {
        if (Array.isArray(d)) {
            if (d[0] == Pkt.SHAPE) wire.shape++
            else if (d[0] == Pkt.CBV) wire.cbv++
            else if (d[0] == Pkt.CB) wire.cb++
        }
        return orig(ev, d)
    }
}

async function main() {
    const {check, done} = makeChecker('obs-shape')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 45000)

    const srv = await startRealServer({port: PORT, makeObject, onServer: spyServer})
    const cli = await startRealClient({port: PORT})

    // remote subscriber records each reconstructed object (incl. Date round-trip)
    const got: tRow[] = []
    const sub: any = cli.api.row.callback((v: tRow) => got.push(v))
    await delay(40) // real WS handshake + CAPS round-trip before we start mutating

    // ── high-frequency monomorphic mutation: 10 distinct updates, SAME shape ──
    // base Date increments per tick so we can verify each Date arrives distinctly.
    const baseTs = Date.parse('2026-06-19T12:00:00.000Z')
    const N = 10
    for (let i = 1; i <= N; i++) {
        row.set({id: i, name: 'row-' + i, balance: i * 100, at: new Date(baseTs + i * 1000)})
        await delay(8) // give the real socket time to deliver each tick (no coalescing across awaits)
    }
    await delay(60) // drain

    // (1) count: every one of the N updates arrived (nothing dropped)
    await check('all updates arrived (count)', () => got.length, N)

    // (2) ids arrived in order, intact
    await check('ids intact and ordered', () => JSON.stringify(got.map(r => r.id)), JSON.stringify([1,2,3,4,5,6,7,8,9,10]))

    // (3) string + number fields intact across every tick
    await check('name+balance intact on every tick',
        () => JSON.stringify(got.map(r => [r.name, r.balance])),
        JSON.stringify(Array.from({length: N}, (_, k) => ['row-' + (k+1), (k+1)*100])))

    // (4) Date field survives compaction on EVERY tick (rich-type integrity) —
    //     reconstruct expected ISO list; checker normalizes Date→ISO.
    await check('Date field intact on every tick (incl. under CBV compaction)',
        () => got.map(r => r.at),
        Array.from({length: N}, (_, k) => new Date(baseTs + (k+1) * 1000)))

    // (5) every reconstructed object has EXACTLY the monomorphic key set (no drift)
    await check('monomorphic key set preserved on every tick',
        () => JSON.stringify([...new Set(got.map(r => Object.keys(r).sort().join(',')))]),
        JSON.stringify(['at,balance,id,name']))

    // (6) compaction actually engaged: with N=10 (>THRESHOLD 5) we MUST see one
    //     Pkt.SHAPE registration and at least one Pkt.CBV compact tick.
    await check('Pkt.SHAPE registered exactly once', () => wire.shape, 1)
    await check('Pkt.CBV engaged (>=5 compact ticks after threshold)', () => wire.cbv >= 5, true)

    // (7) server-side refcount = exactly one live wire subscriber
    await check('server-side refcount = 1', () => row.count(), 1)

    // (8) remote unsubscribe frees the server-side listener (cold again)
    sub.unsubscribe?.()
    await delay(40)
    const beforeLen = got.length
    row.set({id: 99, name: 'after', balance: -1, at: new Date(baseTs)})
    await delay(40)
    await check('no events after remote unsubscribe', () => got.length, beforeLen)
    await check('cold again after unsubscribe (refcount 0)', () => row.count(), 0)

    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
