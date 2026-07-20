// ============================================================
//  oracle/realsocket/callbacks.spec.ts — DISPOSABLE real-socket oracle
//  CATEGORY "callbacks": callbacks-as-args (Pkt.CB) + listen streaming
//  subscriptions over a genuine WebSocket. Port 4102 (own port, no clash).
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {listen as createListenPair, listenStore} from '../../src/Common/events/Listen'

const PORT = 4102

// Stream nodes live in module scope so the facade factory closes over the SAME
// listen handles every connection — we drive them from the test below.
const [tick, tickListen] = createListenPair<[{n: number; at: Date; tags: Set<string>}]>()
const [multiTick, multiListen] = createListenPair<[number, string]>()
let currentValue = 7
const [emitCurrent, currentListen] = listenStore<number>({current: () => [currentValue]})

function setCurrent(value: number) {
    currentValue = value
    emitCurrent(value)
}

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
        current: currentListen,
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

    // ===== 4. current option crosses RPC and survives local wire dedupe =====
    {
        const first: number[] = []
        let hiddenOptionCalls = 0
        const offFirst = (api as any).current.on((value: number) => first.push(value), {
            current: true,
            hidden: function hiddenListenOption() { hiddenOptionCalls++ },
        })
        await delay(40)
        await check('current: first subscriber receives the existing value', () => first, [7])
        await check('current: only the event callback becomes an RPC capability', () => cli.client.api.callbacks(), 1)
        await check('current: unrelated option callbacks never cross the wire', () => hiddenOptionCalls, 0)

        setCurrent(8)
        await delay(30)
        await check('current: first subscriber continues with live values', () => first, [7, 8])

        const late: number[] = []
        const offLate = (api as any).current.on((value: number) => late.push(value), {current: true})
        await delay(20)
        await check('current: late deduped subscriber receives the latest value', () => late, [8])
        await check('current: local subscribers still share one wire subscription', () => currentListen.count(), 1)

        const liveOnly: number[] = []
        const offLiveOnly = (api as any).current.on((value: number) => liveOnly.push(value))
        await delay(30)
        await check('current: omitted option preserves live-only behavior', () => liveOnly, [])

        setCurrent(9)
        await delay(30)
        await check('current: first subscriber receives the next live value', () => first, [7, 8, 9])
        await check('current: late subscriber receives the next live value once', () => late, [8, 9])
        await check('current: live-only subscriber starts at the next event', () => liveOnly, [9])

        const once: number[] = []
        await (api as any).current.once((value: number) => once.push(value), {current: true})
        await check('current: once resolves from the existing value', () => once, [9])

        const waitingOnce: number[] = []
        const callbacksBeforeWaitingOnce = cli.client.api.callbacks()
        const waiting = (api as any).current.once((value: number) => waitingOnce.push(value), {
            hidden: function hiddenOnceOption() { hiddenOptionCalls++ },
        })
        await delay(20)
        await check('current: once also strips unrelated option callbacks', () => cli.client.api.callbacks(), callbacksBeforeWaitingOnce + 1)
        setCurrent(10)
        await waiting
        await check('current: live-only once still receives its one event', () => waitingOnce, [10])
        await check('current: stripped option callbacks remain unreachable', () => hiddenOptionCalls, 0)

        await cli.client.reauth('cache-scope-rotation')
        const afterReauth: number[] = []
        const offAfterReauth = (api as any).current.on((value: number) => afterReauth.push(value), {current: true})
        await delay(20)
        await check('current: reauth clears the previous generation cache', () => afterReauth, [])
        setCurrent(11)
        await delay(20)
        await check('current: post-reauth consumers continue from fresh live data', () => afterReauth, [11])

        offFirst()
        offLate()
        offLiveOnly()
        offAfterReauth()
        await delay(20)
        await check('current: once and shared subscriptions leave no server listener', () => currentListen.count(), 0)
    }

    // ===== 5. CB_END / stream end resolves the off-handle (await off) =====
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
