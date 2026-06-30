// ===========================================================================
//  why.ts — what `observable/` actually buys you.
//
//  Not a feature tour — a CONTRAST. For each task: first "BY HAND" (plain JS,
//  the code you'd otherwise write and maintain), then "WITH observable" (the
//  one line that replaces it). Both run; both must produce the SAME result —
//  so the only difference left is how much you had to write and get right.
//
//  Nothing here is about the underlying Listen — these are observable's OWN
//  jobs: diff-on-replace, deep path routing, built-in change detection.
//
//   node node_modules/ts-node/dist/bin.js --transpile-only observable/why.ts
// ===========================================================================

import {createReactive, onChange, onValue, onKey} from './native'

let fails = 0
const assert = (c: unknown, m: string) => { if (!c) { fails++; console.log('   ❌ FAIL:', m) } else console.log('   ✅', m) }
const J = (v: unknown) => JSON.stringify(v)

// =======================================================================
//  1) "The exchange hands me a WHOLE fresh map every tick. I only want
//      the rows that actually changed (added / changed / removed)."
// =======================================================================
console.log('\n━━ 1) whole snapshot in → minimal deltas out ━━')
{
    const snapshots: Record<string, number>[] = [
        {BTC: 1, ETH: 10},
        {BTC: 1, ETH: 11, SOL: 3},   // BTC same, ETH changed, SOL added
        {BTC: 2},                    // ETH & SOL gone, BTC changed
    ]

    // ── BY HAND: you keep the previous map and diff it yourself every tick ──
    function byHand() {
        const deltas: [string, number | null][] = []
        let prev: Record<string, number> = {}
        function applySnapshot(next: Record<string, number>) {
            for (const k of Object.keys(next))
                if (!Object.is(prev[k], next[k])) deltas.push([k, next[k]])   // added or changed
            for (const k of Object.keys(prev))
                if (!(k in next)) deltas.push([k, null])                      // removed
            prev = next
        }
        for (const s of snapshots) applySnapshot(s)
        return deltas
    }

    // ── WITH observable: assign the whole map. It diffs. You get the deltas. ──
    function withObservable() {
        const deltas: [string, number | null][] = []
        const state = createReactive<{balances: Record<string, number>}>({balances: {}})
        onChange(state.balances, (k: string, v: number | null) => deltas.push([k, v]))
        for (const s of snapshots) state.balances = s        // ← the whole job, per tick
        return deltas
    }

    const a = byHand(), b = withObservable()
    assert(J(a) == J(b), 'same deltas both ways: ' + J(b))
    console.log('   → BY HAND: a diff function you own, test and keep correct (Object.is, adds, removes).')
    console.log('   → observable: `state.balances = snapshot`. One assignment. The diff is the library\'s job.')
}

// =======================================================================
//  2) "State is nested. A widget watches ONE deep leaf. Changing that leaf
//      must wake exactly that widget — and a sibling change must not."
// =======================================================================
console.log('\n━━ 2) deep change → only the precise subscriber wakes ━━')
{
    type Pos = {qty: number}
    type Book = {account: {positions: Record<string, Pos>}}

    // ── BY HAND: a key-keyed registry + a change guard + dispatch to that key ──
    function deepByHand() {
        const data: Book = {account: {positions: {BTC: {qty: 0.5}, ETH: {qty: 2}}}}
        const subs = new Map<string, ((v: number) => void)[]>()
        function on(key: string, cb: (v: number) => void) {
            const list = subs.get(key)
            if (list) list.push(cb); else subs.set(key, [cb])
        }
        function setQty(sym: string, qty: number) {
            const pos = data.account.positions[sym]
            if (!pos || Object.is(pos.qty, qty)) return                 // change guard, by hand
            pos.qty = qty
            for (const cb of subs.get(`positions.${sym}.qty`) ?? []) cb(qty)   // notify only this key
        }
        const hits: number[] = []
        on('positions.BTC.qty', v => hits.push(v))
        setQty('BTC', 0.7)   // should fire
        setQty('ETH', 9)     // sibling — must NOT fire our sub
        return hits
    }

    // ── WITH observable: subscribe by path, write by just navigating ──
    function deepWithLib() {
        const hits: number[] = []
        const p = createReactive<Book>({account: {positions: {BTC: {qty: 0.5}, ETH: {qty: 2}}}})
        onValue<number>(p, ['account', 'positions', 'BTC', 'qty'], v => hits.push(v))
        p.account.positions['BTC'].qty = 0.7   // plain deep write — fires our sub
        p.account.positions['ETH'].qty = 9     // sibling — our sub stays silent
        return hits
    }

    const a = deepByHand(), b = deepWithLib()
    assert(J(a) == J([0.7]) && J(b) == J([0.7]), 'only the watched leaf fired, both ways: ' + J(b))
    console.log('   → BY HAND: a path registry + manual walk + manual notify-the-right-path. ~12 lines to maintain.')
    console.log('   → observable: `p.account.positions["BTC"].qty = 0.7` and `onValue(p, path, cb)`. That\'s all.')
}

// =======================================================================
//  3) "Don't fire when the value didn't actually change." (free, built-in)
// =======================================================================
console.log('\n━━ 3) change detection is on by default ━━')
{
    const ticks: number[] = []
    const p = createReactive({price: 100})
    onKey<number>(p, 'price', v => ticks.push(v))
    p.price = 100          // same value → silent (no guard written anywhere)
    p.price = 101
    p.price = 101          // same again → silent
    p.price = 102
    assert(J(ticks) == J([101, 102]), 'equal writes are dropped automatically: ' + J(ticks))
    console.log('   → BY HAND: every setter needs an `if (old !== new)` guard, everywhere.')
    console.log('   → observable: you just assign; equal-value writes never reach subscribers.')
}

console.log(`\n${fails == 0 ? 'ALL GREEN ✅  — the convenience is what you DIDN\'T have to write.' : fails + ' FAILURE(S) ❌'}`)
process.exit(fails == 0 ? 0 : 1)
