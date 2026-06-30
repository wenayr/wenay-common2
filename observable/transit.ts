// ============================================================
//  transit.ts — lazy transit / operator nodes
//
//  A TRANSIT node sits BETWEEN an upstream Source and downstream
//  consumers. It subscribes upstream, but — unlike combine /
//  computedAuto, which are END consumers — it forwards, drops, or
//  routes values. The whole point: a transit node must contribute
//  upstream liveness ONLY as a proxy for its own END consumers,
//  never on its own behalf.
//
//  Core invariant (holds by construction, no counter except route):
//    a node keeps its upstream hot  <=>  the transitive count of
//    END consumers reachable through it is > 0.
//
//  This falls out of createLazyListen.onActive firing on the 0<->1
//  edge of a node's OWN listener set: zero own listeners ->
//  onActive(false) -> unsubscribe upstream -> upstream's count
//  drops -> its onActive(false) -> ... recursively cold. This is
//  RxJS share({refCount}) / alien-signals unwatched-chaining,
//  expressed in this repo's primitives.
//
//  Layers (CLAUDE.md): this is the BUSINESS layer over the L0 core
//  (createLazyListen). 0 external deps. Every node returns the
//  standard surface so it stays RPC-native (listen()) and chains
//  straight into combine / computedAuto as a Source<T>.
//
//  transform is NOT here on purpose: a 1:1 mapping transit is just
//  the existing `.map` / combine / computed. This file adds the
//  cases where the transform assumptions break: filter (drops),
//  route / switch (one of N outputs), merge (N -> 1).
// ============================================================

import {Source, createLazyListen, combine, isListenCallback, isReactiveNode, registerReactiveNode} from './reactive'
import {Listener} from '../src/Common/events/Listen'

type tSubOpts = {current?: boolean}

// ============================================================
//  identity — local WeakSet brand (the "is this one of mine?")
//
//  Two DIFFERENT questions, two mechanisms (see STORE-PLAN):
//   • local "is this LITERALLY my node" -> WeakSet membership.
//     O(1), no mutation, GC-safe, survives recycle (identity is by
//     reference; the raw() facade is stable across destroy/recreate).
//   • wire "is this any Listen-shaped thing, maybe deserialized" ->
//     isListenCallback (shape). WeakSet/symbol DIE over the wire, so
//     duck-typing stays the network contract — they are complementary.
// ============================================================
const ourTransits = new WeakSet<object>()
export function isOurTransit(x: any) {
    return x != null && typeof x == 'object' && ourTransits.has(x)
}

// brand a transit node both into the transit-local set AND the shared
// reactive registry, so isOurTransit (transit-specific) and isReactiveNode
// (unified, all of OUR nodes) both recognize it. Mirrors every ourTransits.add.
function brand<T extends object>(x: T, ...also: object[]) {
    ourTransits.add(x)
    registerReactiveNode(x)
    for (const y of also) { ourTransits.add(y); registerReactiveNode(y) }
    return x
}

// re-export the wire-side check + the unified local check so callers see
// every half in one place. isListenCallback stays the WIRE/shape contract.
export {isListenCallback, isReactiveNode}

// ============================================================
//  core — createTransit
//
//  A lazy node whose hotness == its OWN listener count. `wire(push)`
//  runs on the 0->1 edge and returns a teardown run on 1->0; it is
//  the ONLY place an upstream subscription is created, so the
//  invariant holds by construction.
//
//  Reentrancy guard (the RxJS share/refCount bug class): a 1->0->1
//  transition in one synchronous tick must not leave the upstream
//  link half-torn. `busy` blocks a re-entrant edge from double-
//  wiring; after the outer edge settles we re-check count and
//  re-wire / tear down to match reality.
// ============================================================
function createTransit<R>(wire: (push: (v: R) => void) => (() => void)) {
    let off: (() => void) | null = null
    let busy = false

    const ev = createLazyListen<[R]>({
        recycle: true,
        onActive(active) {
            if (busy) return
            busy = true
            try {
                if (active) {
                    if (!off) off = wire(v => ev.emit(v))
                } else {
                    const cur = off
                    off = null
                    cur?.()
                    // a synchronous re-subscribe during teardown revived us
                    if (ev.count() > 0 && !off) off = wire(v => ev.emit(v))
                }
            } finally {
                busy = false
            }
        },
    })

    const base = {
        addListen: ev.addListen,
        removeListen: ev.removeListen,
        count: ev.count,
        listen: ev.raw,
        close: ev.close,
    }
    brand(base, ev.raw())   // node + the stable RPC facade (survives recycle)
    return base
}
type TransitBase = ReturnType<typeof createTransit<any>>

// assemble the standard Source surface from a transit base + a get()
function standard<R>(base: TransitBase, get: () => R) {
    const self = {
        get,
        addListen: base.addListen,
        removeListen: base.removeListen,
        subscribe(cb: Listener<[R]>, {current = false}: tSubOpts = {}) {
            if (current) { const v = get(); if (v != undefined) cb(v) }
            return base.addListen(cb)
        },
        map: <R2>(fn: (v: R) => R2, o?: {equals?: (a: R2, b: R2) => boolean}) =>
            combine([{get, addListen: base.addListen, removeListen: base.removeListen}], ([v]) => fn(v), o),
        count: base.count,
        listen: base.listen,
        close: base.close,
    }
    brand(self)
    return self
}

// ============================================================
//  filter — drops emissions; downstream sees only passing values
//
//  get() is the filter-specific concern: a cold pull has no
//  "passing" value, so we either hold the last passed value
//  (default) or fall through to the raw upstream value — chosen
//  by an opt-in, never silently undefined-as-if-it-passed.
// ============================================================
export function filter<T>(
    source: Source<T>,
    pred: (v: T) => boolean,
    {hold = true, equals}: {hold?: boolean; equals?: (a: T, b: T) => boolean} = {},
) {
    let last: T | undefined
    let everPassed = false

    const base = createTransit<T>(function wireFilter(push) {
        const cur = source.get()
        if (pred(cur)) { last = cur; everPassed = true }
        // dedup on the LIVE push path only: skip a passing value equal to the
        // last one we actually pushed. lastPushed tracks deliveries, not pulls —
        // get() is a pure read and never feeds this. No equals => no dedup (today's behavior).
        let lastPushed: T | undefined
        let everPushed = false
        return source.addListen(function onFilter(v) {
            if (!pred(v)) return            // the drop: no emit, no downstream churn
            last = v; everPassed = true
            if (equals && everPushed && equals(lastPushed as T, v)) return
            lastPushed = v; everPushed = true
            push(v)
        })
    })

    function get() {
        const cur = source.get()
        // record on pass so hold-last is consistent whether hot (onFilter) or
        // cold (pull-only): get() is the only state update while nobody listens
        if (pred(cur)) { last = cur; everPassed = true; return cur }
        return hold && everPassed ? (last as T) : cur
    }
    return standard(base, get)
}

// ============================================================
//  route / switch — forward each value to ONE of N outputs
//
//  The refcount-of-refcounts case: the shared upstream is hot iff
//  >=1 output branch currently has consumers. Each output is its
//  own lazy node reporting liveness via branchActive; the route
//  node connects upstream on the FIRST live branch and tears it
//  down on the LAST. A branch with no consumers contributes
//  nothing — values routed to a cold branch are dropped at
//  _pushIfLive without allocating downstream.
// ============================================================
export function route<T, K extends string>(
    source: Source<T>,
    keys: readonly K[],
    pick: (v: T) => K,
) {
    let liveBranches = 0
    let upstreamOff: (() => void) | null = null

    function connect() {
        upstreamOff = source.addListen(function onRoute(v) {
            outputs[pick(v)]?._pushIfLive(v)
        })
    }
    // aggregate 0<->1 across ALL branches — the route-level refcount
    function branchActive(active: boolean) {
        if (active) {
            if (liveBranches++ == 0 && !upstreamOff) connect()
        } else {
            if (--liveBranches == 0 && upstreamOff) {
                const off = upstreamOff
                upstreamOff = null          // null before calling off() — reentrancy-safe
                off()
            }
        }
    }

    function makeBranch(k: K) {
        let live = false
        const ev = createLazyListen<[T]>({
            recycle: true,
            onActive(a) { live = a; branchActive(a) },
        })
        function get() {
            const cur = source.get()
            return pick(cur) == k ? cur : undefined
        }
        const b = {
            get,
            addListen: ev.addListen,
            removeListen: ev.removeListen,
            subscribe(cb: Listener<[T]>, {current = false}: tSubOpts = {}) {
                if (current) { const v = get(); if (v != undefined) cb(v) }
                return ev.addListen(cb)
            },
            map: <R>(fn: (v: T | undefined) => R, o?: {equals?: (a: R, b: R) => boolean}) =>
                combine([{get, addListen: ev.addListen, removeListen: ev.removeListen}], ([v]) => fn(v), o),
            count: ev.count,
            listen: ev.raw,
            close: ev.close,
            _pushIfLive(v: T) { if (live) ev.emit(v) },   // internal: only the chosen, live branch
        }
        brand(b, ev.raw())
        return b
    }

    const outputs = {} as Record<K, ReturnType<typeof makeBranch>>
    for (const k of keys) outputs[k] = makeBranch(k)

    const api = {
        outputs,                        // record<K, Source-shaped node>
        out: (k: K) => outputs[k],      // ergonomic accessor
        close() {
            for (const k of keys) outputs[k].close()
            if (upstreamOff) { const off = upstreamOff; upstreamOff = null; off() }
        },
    }
    brand(api)
    return api
}

// switch = a 2-way route by predicate (sugar)
export function switchOn<T>(source: Source<T>, pred: (v: T) => boolean) {
    const r = route(source, ['on', 'off'] as const, v => (pred(v) ? 'on' : 'off'))
    return {on: r.out('on'), off: r.out('off'), close: r.close}
}

// ============================================================
//  merge — N upstreams -> 1 downstream (fan-in)
//
//  upstream-i is subscribed iff the merge node has >=1 own
//  consumer; per-source teardown on the last unsubscribe.
// ============================================================
export function merge<T>(sources: readonly Source<T>[]) {
    const base = createTransit<T>(function wireMerge(push) {
        const offs = sources.map(s => s.addListen(function onMerge(v) { push(v) }))
        return function offMerge() { for (const off of offs) off() }
    })
    function get() {
        const n = sources.length
        return n ? sources[n - 1].get() : undefined
    }
    return standard(base, get)
}

// ============================================================
//  oracle — disposable self-test (CLAUDE.md: tests as oracles)
//   node node_modules/ts-node/dist/bin.js --transpile-only observable/transit.ts
// ============================================================
if (require.main === module) {
    const {createCell} = require('./reactive') as typeof import('./reactive')
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }

    // (1) COLD: route stays fully cold until a branch leaf subscribes
    {
        const src = createCell(1)
        const r = route(src, ['on', 'off'] as const, v => (v > 0 ? 'on' : 'off'))
        assert(src.count() == 0, 'no branch subscriber => upstream cold (zero effective listeners)')
        const seen: number[] = []
        const off = r.out('on').subscribe(v => seen.push(v))
        assert(src.count() == 1, 'subscribing one branch makes upstream hot exactly once')
        src.set(5); src.set(-3); src.set(7)              // -3 routes to the cold 'off' branch
        assert(seen.join(',') == '5,7', `only on-branch values delivered (got ${seen.join(',')})`)
        off()
        assert(src.count() == 0, 'last branch unsub => upstream cold again (recursive teardown)')
    }

    // (2) AGGREGATE refcount: two live branches share ONE upstream sub; last one frees it
    {
        const src = createCell(0)
        const r = route(src, ['on', 'off'] as const, v => (v >= 0 ? 'on' : 'off'))
        const o1 = r.out('on').subscribe(() => {})
        const o2 = r.out('off').subscribe(() => {})
        assert(src.count() == 1, 'two live branches => single shared upstream subscription')
        o1()
        assert(src.count() == 1, 'still hot with one branch live')
        o2()
        assert(src.count() == 0, 'last live branch gone => upstream cold')
    }

    // (3) 5-node-ish pipeline cold-propagation through filter
    {
        const cell = createCell(2)
        const f = filter(cell, v => v % 2 == 0)          // even-only
        const seen: number[] = []
        assert(cell.count() == 0, 'pipeline fully cold before any leaf')
        const off = f.subscribe(v => seen.push(v))
        assert(cell.count() == 1, 'leaf subscribe lights the whole chain')
        cell.set(3); cell.set(4); cell.set(6)
        assert(seen.join(',') == '4,6', `filter drops odds (got ${seen.join(',')})`)
        off()
        assert(cell.count() == 0, 'leaf unsub collapses chain to cold')
    }

    // (4) ORDERING: a recycled transit re-attaches LAST among siblings (documents §4)
    {
        const src = createCell(0)
        const order: string[] = []
        const a = src.subscribe(() => order.push('A'))
        const t = filter(src, () => true)
        const offT = t.subscribe(() => order.push('T'))  // T attaches to src after A
        const b = src.subscribe(() => order.push('B'))
        order.length = 0; src.set(1)
        assert(order.join('') == 'ATB', `initial order A,T,B (got ${order.join('')})`)
        offT()                                            // T detaches -> src drops that sub, recycles
        const offT2 = t.subscribe(() => order.push('T')) // re-attach: appended LAST
        order.length = 0; src.set(2)
        assert(order.join('') == 'ABT', `after recycle T is delivered last (got ${order.join('')})`)
        a(); b(); offT2()
    }

    // (5) IDENTITY: our nodes recognized locally; raw() facade survives recycle + passes the wire check
    {
        const src = createCell(0)
        const f = filter(src, () => true)
        assert(isOurTransit(f) && isOurTransit(f.listen()), 'transit node + its raw() facade are ours')
        assert(isListenCallback(f.listen()), 'raw() still passes the wire duck-type')
        const off = f.subscribe(() => {})
        off()                                             // recycle frees the inner Listen
        assert(isOurTransit(f.listen()), 'stable facade still recognized after recycle (identity by ref)')
    }

    // (6) FILTER get(): hold-last vs never-passed
    {
        const src = createCell(1)
        const f = filter(src, v => v > 10)
        assert(f.get() == 1, 'never passed, hold default => falls through to raw upstream value')
        src.set(20)
        assert(f.get() == 20, 'after a pass, current value passes')
        src.set(3)
        assert(f.get() == 20, 'fails pred => holds last passed value (hold:true)')
        const g = filter(src, v => v > 10, {hold: false})
        assert(g.get() == 3, 'hold:false => falls through to raw upstream value instead of holding')
    }

    // (7) FILTER equals: two equal consecutive passing values emit once with equals, twice without
    //  source dedup disabled ({equals:()=>false}) so the cell actually delivers both equal
    //  values to the filter — what's under test is the FILTER's dedup, not the cell's.
    {
        // without equals — today's behavior, no dedup
        const src = createCell(0, {equals: () => false})
        const fRaw = filter(src, v => v > 0)
        const rawSeen: number[] = []
        const offRaw = fRaw.subscribe(v => rawSeen.push(v))
        src.set(5); src.set(5)
        assert(rawSeen.join(',') == '5,5', `no equals => no dedup, both emitted (got ${rawSeen.join(',')})`)
        offRaw()

        // with equals — dedup equal consecutive passing values
        const src2 = createCell(0, {equals: () => false})
        const fEq = filter(src2, v => v > 0, {equals: (a, b) => a == b})
        const eqSeen: number[] = []
        const offEq = fEq.subscribe(v => eqSeen.push(v))
        src2.set(5); src2.set(5)
        assert(eqSeen.join(',') == '5', `equals => equal re-emit deduped, emitted once (got ${eqSeen.join(',')})`)
        src2.set(7)
        assert(eqSeen.join(',') == '5,7', `a differing passing value still emits (got ${eqSeen.join(',')})`)
        offEq()
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    process.exit(fails == 0 ? 0 : 1)
}

export type Filter<T> = ReturnType<typeof filter<T>>
export type Route<T, K extends string> = ReturnType<typeof route<T, K>>
export type Merge<T> = ReturnType<typeof merge<T>>
