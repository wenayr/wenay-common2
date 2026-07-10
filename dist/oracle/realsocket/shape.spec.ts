// ============================================================
//  oracle/realsocket/shape.spec.ts — DISPOSABLE real-socket oracle
//  CATEGORY "shape": adaptive shape compaction (Pkt.SHAPE/CBV) over a REAL WebSocket.
//
//  Two server streams:
//    monoStream — monomorphic high-freq object stream. After THRESHOLD(5) ticks of the
//                 same shape the server standardizes it and switches to compact Pkt.CBV.
//                 We assert ALL ticks (>=8) arrive intact incl. Date values, AND that
//                 compaction actually engaged (CBV>0) by wrapping socket.emit in onServer.
//    polyStream — polymorphic stream (changing shapes). Adaptive fallback: no shape ever
//                 reaches threshold → no data loss; we also assert CBV stayed 0.
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {listen as createListenPair} from '../../src/Common/events/Listen'

const PORT = 4107

// captured server-side emit handles (filled when makeObject runs on the connection)
let emitMono: ((v: any) => void) | null = null
let emitPoly: ((v: any) => void) | null = null

function makeObject() {
    const [mono, monoListen] = createListenPair<any>()
    const [poly, polyListen] = createListenPair<any>()
    emitMono = mono
    emitPoly = poly
    return {monoStream: monoListen, polyStream: polyListen}
}

async function main() {
    const {check, done} = makeChecker('shape')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 40000)

    // counters of raw packet types seen on the REAL server socket
    let cbvCount = 0     // Pkt.CBV = 9  (compact values tick)
    let shapeCount = 0   // Pkt.SHAPE = 8 (shape declaration)
    let cbCount = 0      // Pkt.CB = 2   (full callback tick)

    const srv = await startRealServer({
        port: PORT,
        makeObject,
        onServer: (_api, socket) => {
            // wrap the genuine socket.emit BEFORE any tick is sent — the rpc-server
            // adapter calls socket.emit(key, packetArray) at send time, so this sees
            // every outgoing packet and lets us observe compaction on the real wire.
            const orig = socket.emit.bind(socket)
            socket.emit = (key: string, d: any) => {
                if (Array.isArray(d)) {
                    if (d[0] === 9) cbvCount++
                    else if (d[0] === 8) shapeCount++
                    else if (d[0] === 2) cbCount++
                }
                return orig(key, d)
            }
        },
    })

    const cli = await startRealClient({port: PORT})
    const api = cli.api

    // give the connection a moment so makeObject ran and emit handles are captured
    await delay(50)
    await check('emit handles captured', () => emitMono != null && emitPoly != null, true)

    // ---------- monomorphic stream: subscribe, then fire many same-shape ticks ----------
    const gotMono: any[] = []
    const offMono = api.monoStream.callback((v: any) => gotMono.push(v))
    await delay(60) // subscription round-trip + CAPS handshake over real socket

    const N = 12
    for (let i = 0; i < N; i++) {
        emitMono!({a: i, when: new Date(i * 1000), tag: 'x'})
        await delay(8)
    }
    await delay(120) // let all compact ticks land

    await check('mono: all ticks arrived', () => gotMono.length, N)
    await check('mono: first tick values intact', () => [gotMono[0].a, gotMono[0].tag, gotMono[0].when], [0, 'x', new Date(0)])
    await check('mono: last tick values intact (Date)', () => [gotMono[N - 1].a, gotMono[N - 1].tag, gotMono[N - 1].when], [N - 1, 'x', new Date((N - 1) * 1000)])
    // verify EVERY tick is correct and in order (no drop / corruption / reordering)
    await check('mono: every tick exact + ordered', () => gotMono.map(v => [v.a, v.tag, v.when]),
        Array.from({length: N}, (_v, i) => [i, 'x', new Date(i * 1000)]))
    // compaction engaged: after THRESHOLD(5) of the same shape, server declared SHAPE once and sent CBV
    await check('mono: SHAPE declared exactly once', () => shapeCount, 1)
    await check('mono: compaction engaged (CBV>0)', () => cbvCount > 0, true)
    // with threshold 5: ticks 1..5 full (the 5th triggers register→CBV), 6..12 compact.
    // register sends SHAPE+CBV, then each later same-shape tick a CBV → CBV count = N - 4.
    await check('mono: CBV count == N-4 (ticks after threshold)', () => cbvCount, N - 4)

    offMono()
    await delay(30)

    // ---------- polymorphic stream: each tick a different shape → adaptive fallback ----------
    const cbvBefore = cbvCount
    const gotPoly: any[] = []
    const offPoly = api.polyStream.callback((v: any) => gotPoly.push(v))
    await delay(60)

    // 8 ticks, each a distinct shape — no single shape ever reaches THRESHOLD(5)
    emitPoly!({a: 1})
    await delay(8); emitPoly!({b: 2})
    await delay(8); emitPoly!({c: 3, d: 4})
    await delay(8); emitPoly!({e: 5})
    await delay(8); emitPoly!({f: 6, g: 7})
    await delay(8); emitPoly!({h: 8})
    await delay(8); emitPoly!({i: 9, j: 10, k: 11})
    await delay(8); emitPoly!({l: 12})
    await delay(120)

    await check('poly: all 8 ticks arrived (no loss)', () => gotPoly.length, 8)
    await check('poly: values intact across shapes', () => [gotPoly[0].a, gotPoly[1].b, gotPoly[2].c, gotPoly[2].d, gotPoly[6].i, gotPoly[6].k, gotPoly[7].l],
        [1, 2, 3, 4, 9, 11, 12])
    await check('poly: no compaction (no new CBV)', () => cbvCount - cbvBefore, 0)

    offPoly()
    await delay(30)

    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
