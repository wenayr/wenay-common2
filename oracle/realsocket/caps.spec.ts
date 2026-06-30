// ============================================================
//  oracle/realsocket/caps.spec.ts — DISPOSABLE real-socket oracle
//  CATEGORY "caps": capability NEGOTIATION over a REAL WebSocket.
//
//  Verifies the handshake-negotiated optimization switch (opt.compact):
//    1) default (both new)        → COMPACT negotiated → server uses Pkt.CBV (CBV>0).
//    2) client opt:{compact:false}→ client advertises NO COMPACT (silent) → server stays
//                                   on plain Pkt.CB (CBV==0, CB>0). Ticks still intact.
//    3) server opt:{compact:false}→ server advertises caps without COMPACT → no compaction
//                                   even though the client supports it (CBV==0, CB>0).
//  In all cases data round-trips byte-correct (incl. Date), proving the optimization is
//  purely a wire choice negotiated at handshake — outcome-equivalent either way.
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {UseListen} from '../../src/Common/events/Listen'

const PORT = 4120

// one scenario: boot a server (opt = serverOpt) + connect a client (opt = clientOpt),
// fire N monomorphic ticks, count CBV(9)/CB(2) packets on the real server socket.
async function scenario(port: number, serverOpt?: {compact?: boolean}, clientOpt?: {compact?: boolean}) {
    let emit: ((v: any) => void) | null = null
    function makeObject() {
        const [e, listen] = UseListen<any>()
        emit = e
        return {stream: listen}
    }
    let cbv = 0, cb = 0
    const srv = await startRealServer({
        port, makeObject,
        serverOpts: serverOpt ? {opt: serverOpt} : {},
        onServer: (_api, socket) => {
            const orig = socket.emit.bind(socket)
            socket.emit = (key: string, d: any) => {
                if (Array.isArray(d)) { if (d[0] === 9) cbv++; else if (d[0] === 2) cb++ }
                return orig(key, d)
            }
        },
    })
    const cli = await startRealClient({port, opt: clientOpt})
    const got: any[] = []
    const off = cli.api.stream.callback((v: any) => got.push(v))
    await delay(60) // subscription round-trip + CAPS handshake over the real socket
    const N = 10
    for (let i = 0; i < N; i++) { emit!({a: i, when: new Date(i * 1000), tag: 'x'}); await delay(8) }
    await delay(120)
    off()
    await delay(20)
    cli.close()
    await srv.close()
    return {got, cbv, cb, N}
}

async function main() {
    const {check, done} = makeChecker('caps')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 60000)

    // ---- 1) default: COMPACT negotiated (both peers new) ----
    {
        const r = await scenario(PORT)
        await check('default: all ticks intact', () => r.got.length, r.N)
        await check('default: last tick exact (Date)', () => [r.got[r.N - 1].a, r.got[r.N - 1].tag, r.got[r.N - 1].when], [r.N - 1, 'x', new Date((r.N - 1) * 1000)])
        await check('default: compaction engaged (CBV>0)', () => r.cbv > 0, true)
    }

    // ---- 2) client opt:{compact:false}: client does NOT advertise → server plain CB ----
    {
        const r = await scenario(PORT + 1, undefined, {compact: false})
        await check('client-off: all ticks intact', () => r.got.length, r.N)
        await check('client-off: last tick exact (Date)', () => [r.got[r.N - 1].a, r.got[r.N - 1].when], [r.N - 1, new Date((r.N - 1) * 1000)])
        await check('client-off: NO compaction (CBV==0)', () => r.cbv, 0)
        await check('client-off: server sent plain CB (CB>0)', () => r.cb > 0, true)
    }

    // ---- 3) server opt:{compact:false}: server advertises no COMPACT → no compaction ----
    {
        const r = await scenario(PORT + 2, {compact: false})
        await check('server-off: all ticks intact', () => r.got.length, r.N)
        await check('server-off: last tick exact (Date)', () => [r.got[r.N - 1].a, r.got[r.N - 1].when], [r.N - 1, new Date((r.N - 1) * 1000)])
        await check('server-off: NO compaction (CBV==0)', () => r.cbv, 0)
        await check('server-off: server sent plain CB (CB>0)', () => r.cb > 0, true)
    }

    // ---- 4) subscribe via .on(cb) over the REAL web (idiomatic alias of .callback) ----
    {
        let emit: ((v: any) => void) | null = null
        const srv = await startRealServer({port: PORT + 3, makeObject: () => { const [e, l] = UseListen<any>(); emit = e; return {stream: l} }})
        const cli = await startRealClient({port: PORT + 3})
        const got: any[] = []
        const off = (cli.api.stream as any).on((v: any) => got.push(v))   // .on вместо .callback — «факт установки колбэка»
        await delay(60)
        for (let i = 0; i < 5; i++) { emit!({n: i}); await delay(8) }
        await delay(100)
        await check('on-web: .on(cb) subscribed + streamed', () => got.map((v: any) => v.n), [0, 1, 2, 3, 4])
        if (typeof off === 'function') off()
        await delay(20)
        cli.close()
        await srv.close()
    }

    // ---- 5) bare-on exposure ({ stream: listen.on }) + once over the REAL web ----
    {
        let emit: ((v: any) => void) | null = null
        const srv = await startRealServer({port: PORT + 4, makeObject: () => { const [e, l] = UseListen<any>(); emit = e; return {stream: (l as any).on} }})
        const cli = await startRealClient({port: PORT + 4})
        const got: any[] = []
        ;(cli.api.stream as any).on((v: any) => got.push(v))   // exposed ТОЛЬКО listen.on → клиент получил подписку
        await delay(60)
        for (let i = 0; i < 4; i++) { emit!({n: i}); await delay(8) }
        await delay(100)
        await check('bare-on: { stream: listen.on } streams over real web', () => got.map((v: any) => v.n), [0, 1, 2, 3])
        const one: any[] = []
        ;(cli.api.stream as any).once((v: any) => one.push(v))
        await delay(40); emit!({n: 99}); await delay(8); emit!({n: 100}); await delay(50)
        await check('once: exactly one event over real web', () => one.map((v: any) => v.n), [99])
        cli.close()
        await srv.close()
    }

    clearTimeout(watchdog)
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
