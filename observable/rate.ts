// ============================================================
//  rate.ts — rate-limited subscription over-layer, on waitRun
//
//  Wraps any Source so updates arrive AT MOST once per `ms`, and
//  the LATEST value is always eventually delivered. Built on the
//  project's waitRun():
//    • trailing ("wait and run", жди и запусти) → debounceAsync
//      — one emit per burst, ms after it starts, value = latest.
//    • leading  ("run and wait", запусти и жди) → throttleAsync
//      for the immediate edge + a trailing debounce guarantee, so
//      even leading mode never loses the final value.
//
//  Two faces, by audience:
//    • subscribe(cb, {ms, mode}) — PER-SUBSCRIBER rate, adjustable
//      live via the returned unsub's .setRate(ms). For in-process.
//    • listen() — ONE throttle, fanned out to all consumers, at the
//      creation rate. For RPC: throttle once on the server, send
//      once over the wire (this is the "don't flood the network"
//      path). Exact funcListenCallbackBase shape, RPC-ready.
// ============================================================

import {createLazyListen, Source} from './reactive'
import {waitRun} from '../src/Common/async/waitRun'
import {Listener} from '../src/Common/events/Listen'

type tMode = 'leading' | 'trailing'
type tThrottleOpts = {ms?: number, mode?: tMode, equals?: (a: any, b: any) => boolean}

export function throttle<T>(source: Source<T>, {ms = 0, mode = 'trailing', equals = Object.is}: tThrottleOpts = {}) {

    // one throttled pipe: source → cb, with its own rate/mode/state
    function attach(cb: Listener<[T]>, rate0: number, mode0: tMode) {
        let rate = rate0
        let latest: T
        let last: T
        let primed = false
        const w = waitRun()                              // trailing (debounce) — always-latest
        const wLead = mode0 == 'leading' ? waitRun() : null

        function flush() {
            if (primed && equals(last, latest)) return   // never emit the same value twice
            last = latest; primed = true
            cb(latest)
        }
        const off = source.addListen(function onUpstream(v) {
            latest = v
            if (rate <= 0) { flush(); return }           // 0 = passthrough
            if (wLead) wLead.refreshAsync(rate, flush)   // leading edge
            w.refreshAsync2(rate, flush)                 // trailing edge (guarantees last)
        })

        const unsub = (() => off()) as (() => void) & {setRate: (n: number) => void}
        unsub.setRate = (n: number) => { rate = n }      // adjust frequency live
        return unsub
    }

    // ── network path: throttle ONCE, fan out to every consumer ──
    let offSrc: (() => void) | null = null
    const out = createLazyListen<[T]>({
        recycle: true,
        onActive(active) {
            if (active) offSrc = attach((v: any) => out.emit(v), ms, mode)
            else { offSrc?.(); offSrc = null }
        },
    })

    return {
        get: source.get,
        // per-subscriber rate (in-process), adjustable via .setRate / per-call {ms,mode}
        subscribe(cb: Listener<[T]>, {ms: m = ms, mode: md = mode, current = false}: tThrottleOpts & {current?: boolean} = {}) {
            if (current) cb(source.get())
            return attach(cb, m, md)
        },
        // Source-compatible: feeds the shared throttled pipe (creation rate)
        addListen: (cb: Listener<[T]>) => out.addListen(cb),
        removeListen: out.removeListen,
        count: out.count,
        // shared throttled Listen for RPC (one throttle on the server, one stream on the wire)
        listen: out.raw,
        close: out.close,
    }
}
export type Throttled<T> = ReturnType<typeof throttle<T>>

// ── runnable demo ───────────────────────────────────────────
if (require.main === module) {
    const {createCell} = require('./reactive')
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }
    const J = (v: any) => JSON.stringify(v)

    async function main() {
        // trailing: a burst collapses to one emit = the LAST value
        console.log('\n[throttle trailing] burst → single latest')
        {
            const n = createCell(0)
            const t = throttle<number>(n, {ms: 40, mode: 'trailing'})
            const got: number[] = []
            t.subscribe(v => got.push(v))
            for (let i = 1; i <= 5; i++) n.set(i)   // burst 1..5, synchronous
            assert(J(got) == '[]', 'nothing yet (trailing waits): ' + J(got))
            await delay(60)
            assert(J(got) == '[5]', 'one emit, the latest: ' + J(got))
        }

        // leading: immediate first + trailing latest, rate-limited
        console.log('\n[throttle leading] immediate + trailing latest')
        {
            const n = createCell(0)
            const t = throttle<number>(n, {ms: 40, mode: 'leading'})
            const got: number[] = []
            t.subscribe(v => got.push(v))
            n.set(1)                                  // leading → emits 1 now
            await delay(5)
            n.set(2); n.set(3)                        // within window → trailing keeps last
            await delay(60)
            assert(got[0] == 1, 'leading emitted first value immediately: ' + J(got))
            assert(got[got.length - 1] == 3, 'trailing delivered the final value: ' + J(got))
            assert(got.length <= 2, 'rate-limited (≤2 emits, not 3): ' + J(got))
        }

        // independent per-subscriber rates + live setRate
        console.log('\n[throttle] independent subscribers + live setRate')
        {
            const n = createCell(0)
            const t = throttle<number>(n, {ms: 100})
            const fast: number[] = [], slow: number[] = []
            const offFast = t.subscribe(v => fast.push(v), {ms: 10})
            t.subscribe(v => slow.push(v), {ms: 200})
            n.set(1); n.set(2); n.set(3)             // one burst
            await delay(40)
            assert(J(fast) == '[3]', 'fast (10ms) already delivered latest: ' + J(fast))
            assert(J(slow) == '[]', 'slow (200ms) still waiting: ' + J(slow))
            // speed the fast one up to passthrough — next change is immediate
            offFast.setRate(0)
            n.set(7)
            await delay(5)
            assert(fast[fast.length - 1] == 7, 'after setRate(0) passthrough is immediate: ' + J(fast))
            await delay(220)
            assert(slow[slow.length - 1] == 7, 'slow eventually gets the latest too: ' + J(slow))
        }

        console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
        process.exit(fails == 0 ? 0 : 1)
    }
    main()
}
