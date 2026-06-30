// ============================================================
//  autotrack.ts — automatic dependency tracking for derived
//  values (the "C = A + B" auto-subscription idea)
//
//  Unlike `combine`, the caller never lists dependencies. They
//  write `fn(use => use(a) + use(b))`; each `use(source)` call
//  both RECORDS the source as a dependency and RETURNS its
//  current value. Tracking is explicit-call but automatic: no
//  manual dep array, and the dep set is rebuilt on every run —
//  so DYNAMIC / conditional deps work (`use(flag) ? use(a) :
//  use(b)` re-subscribes to whichever branch actually ran).
//
//  Cost model mirrors `combine` (built on createLazyListen):
//   • get()  pulls — runs fn with a throwaway collector, touches
//     no upstream subscription. Works with zero subscribers.
//   • first listener — run fn, capture deps, subscribe to exactly
//     those; a dep change re-runs fn with a FRESH collector,
//     DIFFs the dep set (subscribe new / unsubscribe gone), and
//     emits only when the result changed.
//   • last unsubscriber — drop every upstream sub; cold again.
// ============================================================

import {Source, createLazyListen, registerReactiveNode} from './reactive'

// one-place strict identity for change-detection (see reactive.ts):
// Object.is is genuinely wanted here so a real change is never
// suppressed and NaN→NaN is treated as no-change.
function sameValue<R>(a: R, b: R) { return Object.is(a, b) }

// the collector handed to fn — calling it on a source tags the dep.
// .untrack reads a source's value WITHOUT tagging it: a conditional that
// peeks at a value purely for control-flow shouldn't subscribe to it.
type tUse = {
    <T>(s: Source<T>): T
    untrack: <T>(s: Source<T>) => T
}

export function computedAuto<R>(
    fn: (use: tUse) => R,
    {equals = sameValue}: {equals?: (a: R, b: R) => boolean} = {}
) {
    let cached: R
    let live = false                          // subscribed to upstream right now?
    // current dep set → its unsubscribe handle. The Source object is
    // the identity key, so the same source used twice in one run is a
    // single subscription, and diffing is set membership.
    let deps = new Map<Source<any>, () => void>()

    // -------- run fn under a fresh collector, returning value + deps --------
    // We don't subscribe here; we only learn WHICH sources fn read this
    // time. The caller decides what to do with the collected set.
    function run() {
        const seen = new Set<Source<any>>()
        const use = function use<T>(s: Source<T>) { seen.add(s); return s.get() } as tUse
        // escape hatch: read for control-flow without joining the dep set,
        // so a change to an untracked source does NOT recompute
        use.untrack = function untrack<T>(s: Source<T>) { return s.get() }
        const value = fn(use)
        return {value, seen}
    }

    // -------- diff: align live subscriptions with a freshly-seen set --------
    // Subscribe sources that appeared, unsubscribe sources that vanished.
    // This is what makes the graph dynamic — conditional branches that
    // stopped running get torn down, new branches get wired up.
    function reconcile(seen: Set<Source<any>>) {
        for (const [s, off] of deps) {
            if (!seen.has(s)) { off(); deps.delete(s) }
        }
        for (const s of seen) {
            if (!deps.has(s)) deps.set(s, s.addListen(onUpstream))
        }
    }

    // a dep changed: recompute, re-diff deps, emit only on real change
    function onUpstream() {
        const {value, seen} = run()
        reconcile(seen)
        if (equals(cached, value)) return
        cached = value
        ev.emit(value)
    }

    const ev = createLazyListen<[R]>({
        recycle: true,
        onActive(active) {
            if (active) {
                const {value, seen} = run()
                cached = value
                live = true
                reconcile(seen)
            } else {
                for (const off of deps.values()) off()
                deps.clear()
                live = false
            }
        },
    })

    // live → return the value kept fresh by onUpstream; cold → pull now
    function get() { return live ? cached : run().value }

    return registerReactiveNode({
        get,
        addListen: ev.addListen,
        removeListen: ev.removeListen,
        subscribe(cb: Parameters<typeof ev.addListen>[0], {current = false}: {current?: boolean} = {}) {
            if (current) cb(get())
            return ev.addListen(cb)
        },
        map: <R2>(mapFn: (v: R) => R2, o?: {equals?: (a: R2, b: R2) => boolean}) =>
            computedAuto(use => mapFn(use({get, addListen: ev.addListen, removeListen: ev.removeListen})), o),
        count: ev.count,
        listen: ev.raw,
        close: ev.close,
    })
}
export type ComputedAuto<R> = ReturnType<typeof computedAuto<R>>

// ============================================================
//  oracle — disposable self-test (see CLAUDE.md: tests as oracles)
// ============================================================
if (require.main === module) {
    const {createCell} = require('./reactive') as typeof import('./reactive')
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }

    // (1) get() pulls with no subscribers and no upstream subscription
    {
        const a = createCell(2)
        const b = createCell(3)
        const c = computedAuto(use => use(a) + use(b))
        assert(c.get() == 5, 'get() pulls 2+3 == 5 with no subscribers')
        assert(a.count() == 0 && b.count() == 0, 'pull does not subscribe upstream')
        a.set(10)
        assert(c.get() == 13, 'get() re-pulls fresh value after upstream change')
        assert(a.count() == 0 && b.count() == 0, 'still no upstream subs after pull')
    }

    // (2) C = A + B pushes on change
    {
        const a = createCell(1)
        const b = createCell(1)
        const c = computedAuto(use => use(a) + use(b))
        const seen: number[] = []
        const off = c.subscribe(v => seen.push(v), {current: true})
        assert(a.count() == 1 && b.count() == 1, 'first subscriber wires both deps')
        a.set(5)
        b.set(7)
        assert(seen.join(',') == '2,6,12', `pushes on each change (got ${seen.join(',')})`)
        // change-detection: setting same value emits nothing new
        a.set(5)
        assert(seen.length == 3, 'equal result does not re-emit')
        off()
    }

    // (3) DYNAMIC deps: conditional switches which source it reads
    {
        const flag = createCell(true)
        const a = createCell('A')
        const b = createCell('B')
        const c = computedAuto(use => (use(flag) ? use(a) : use(b)))
        const seen: string[] = []
        const off = c.subscribe(v => seen.push(v), {current: true})
        assert(seen[0] == 'A', 'initial reads a (flag true)')
        assert(flag.count() == 1 && a.count() == 1 && b.count() == 0, 'b not subscribed while flag true')

        // irrelevant source (b) changing does NOT fire
        b.set('B2')
        assert(seen.length == 1, 'changing inactive source b does not fire')

        // flip the flag — should re-subscribe to b, drop a
        flag.set(false)
        assert(seen[seen.length - 1] == 'B2', 'after flip reads b')
        assert(a.count() == 0 && b.count() == 1, 'dep set re-diffed: a dropped, b added')

        // now a (irrelevant) changing does NOT fire; b DOES
        a.set('A2')
        assert(seen.length == 2, 'changing now-irrelevant a does not fire')
        b.set('B3')
        assert(seen[seen.length - 1] == 'B3', 'changing newly-relevant b fires')
        off()
    }

    // (4) last unsubscribe tears down upstream
    {
        const a = createCell(1)
        const b = createCell(2)
        const c = computedAuto(use => use(a) + use(b))
        const off1 = c.subscribe(() => {})
        const off2 = c.subscribe(() => {})
        assert(a.count() == 1 && b.count() == 1, 'multiple subscribers share one upstream sub')
        off1()
        assert(a.count() == 1, 'still live with one subscriber left')
        off2()
        assert(a.count() == 0 && b.count() == 0, 'last unsubscribe drops all upstream subs')
    }

    // (5) untrack: read A tracked, B via untrack — B changes don't recompute, A does
    {
        const a = createCell(1)
        const b = createCell(100)
        const c = computedAuto(use => use(a) + use.untrack(b))
        const seen: number[] = []
        const off = c.subscribe(v => seen.push(v), {current: true})
        assert(seen.join(',') == '101', `initial reads a + untracked b (got ${seen.join(',')})`)
        assert(a.count() == 1 && b.count() == 0, 'a subscribed, b untracked => not subscribed')

        b.set(200)
        assert(seen.length == 1, 'changing untracked b does NOT recompute')
        assert(b.count() == 0, 'b still not subscribed after its change')

        a.set(2)
        // recompute reads the CURRENT untracked b (200) without subscribing it
        assert(seen[seen.length - 1] == 202, `changing tracked a recomputes, picks up current b (got ${seen[seen.length - 1]})`)
        assert(a.count() == 1 && b.count() == 0, 'still: a subscribed, b never subscribed')
        off()
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    process.exit(fails == 0 ? 0 : 1)
}
