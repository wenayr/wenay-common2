// ============================================================
//  oracle/realsocket/callbacks.spec.ts — DISPOSABLE real-socket oracle
//  CATEGORY "callbacks": callbacks-as-args (Pkt.CB) + listen streaming
//  subscriptions over a genuine WebSocket. Port 4102 (own port, no clash).
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {listen as createListenPair} from '../../src/Common/events/Listen'

const PORT = 4102

// Stream nodes live in module scope so the facade factory closes over the SAME
// listen handles every connection — we drive them from the test below.
const [tick, tickListen] = createListenPair<[{n: number; at: Date; tags: Set<string>}]>()
const [multiTick, multiListen] = createListenPair<[number, string]>()

function makeObject() {
    return {
        // ── callback-as-arg (Pkt.CB): server invokes the passed callback N times ──
        counter: {
            run: async (a: {n: number; callback: (i: number, when: Date) => void}) => {
                // emit `n` ticks in order, each with a rich Date arg; resolve when done
                for (let i = 0; i < a.n; i++) {
                    a.callback(i, new Date(Date.UTC(2026, 0, 1) + i * 1000))
                    await delay(5)
                }
                return a.n
            },
        },
        // ── listen stream node: client subscribes via api.stream.callback(fn) ──
        stream: tickListen,        // single rich object arg
        multi: multiListen,        // two args (number, string)
        // ── control surface to end the single-arg stream (→ CB_END / await off) ──
        endStream: async () => { tickListen.close(); return true },
    }
}

async function main() {
    const {check, done} = makeChecker('callbacks')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 40000)

    const srv = await startRealServer({port: PORT, makeObject})
    const cli = await startRealClient({port: PORT})
    const api = cli.api

    // ===== 1. Callback-as-arg (Pkt.CB): all ticks arrive in order, rich Date =====
    {
        const got: Array<{i: number; when: Date}> = []
        const ret = await api.counter.run({n: 4, callback: (i: number, when: Date) => { got.push({i, when}) }})
        await delay(30) // let any trailing CB packets land after RESP
        await check('cb-arg: return value = n', () => ret, 4)
        await check('cb-arg: tick count', () => got.length, 4)
        await check('cb-arg: indices in order', () => got.map(g => g.i), [0, 1, 2, 3])
        await check('cb-arg: rich Date round-trips',
            () => got.map(g => g.when),
            [0, 1, 2, 3].map(i => new Date(Date.UTC(2026, 0, 1) + i * 1000)))
    }

    // ===== 2. listen stream: ticks arrive with rich values =====
    {
        const a: Array<{n: number; at: Date; tags: Set<string>}> = []
        const off = (api as any).stream.callback((v: any) => a.push(v))
        await delay(40) // subscription round-trips over the real socket
        tick({n: 1, at: new Date('2026-03-03T00:00:00.000Z'), tags: new Set(['x', 'y'])})
        tick({n: 2, at: new Date('2026-03-04T00:00:00.000Z'), tags: new Set(['z'])})
        await delay(40)
        await check('stream: tick count', () => a.length, 2)
        await check('stream: rich values (Date+Set) round-trip',
            () => a,
            [
                {n: 1, at: new Date('2026-03-03T00:00:00.000Z'), tags: new Set(['x', 'y'])},
                {n: 2, at: new Date('2026-03-04T00:00:00.000Z'), tags: new Set(['z'])},
            ])
        // off() stops further ticks
        off()
        await delay(20)
        tick({n: 3, at: new Date('2026-03-05T00:00:00.000Z'), tags: new Set()})
        await delay(40)
        await check('stream: off() stops further ticks', () => a.length, 2)
    }

    // ===== 3. MULTIPLE independent subscribers each get every tick =====
    {
        const b: number[] = [], c: number[] = []
        const offB = (api as any).multi.callback((n: number, _s: string) => b.push(n))
        await delay(20)
        const offC = (api as any).multi.callback((n: number, _s: string) => c.push(n))
        await delay(40)
        multiTick(10, 'a')
        multiTick(20, 'b')
        await delay(40)
        await check('multi-sub: first subscriber got every tick', () => b, [10, 20])
        await check('multi-sub: second subscriber got every tick', () => c, [10, 20])
        // drop one; the other keeps receiving
        offB()
        await delay(20)
        multiTick(30, 'c')
        await delay(40)
        await check('multi-sub: dropped subscriber stops', () => b, [10, 20])
        await check('multi-sub: surviving subscriber continues', () => c, [10, 20, 30])
        offC()
        await delay(20)
    }

    // ===== 4. CB_END / stream end resolves the off-handle (await off) =====
    {
        let resolved = false
        const off = (api as any).stream.callback(() => {})
        await delay(40)
        const awaited = (async () => { await off; resolved = true })()
        // close the server stream → CB_END → off-handle promise resolves
        await api.endStream()
        await Promise.race([awaited, delay(500)])
        await check('stream-end: await off resolved on CB_END', () => resolved, true)
    }

    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
