// ============================================================
//  reactive.ts — cheap-until-subscribed reactive primitives
//
//  Goal: a variable / object / map you can read & write as a
//  plain value, that ALSO is a subscription source — but pays
//  nothing while nobody listens. With zero subscribers a cell
//  is just a closure + a field; `emit` is an empty `if`.
//
//  Built on the project's own `funcListenCallbackBase` (the
//  multicast Listen used by RPC), so every source exposes a
//  real Listen via `.listen()` and drops straight into the
//  existing network plumbing (`listenSocket` / `listen-deep`)
//  with no extra work. No external deps — 0-dep by design.
//
//  Layers (kept separate, see CLAUDE.md):
//   • resource/core  — createLazyListen (the lazy multicast)
//   • primitives     — createCell / createRObject / createRMap
//   • derived        — combine / computed / .map (lazy graph)
// ============================================================

import {funcListenCallbackBase, Listener, isListenCallback} from '../src/Common/events/Listen'
import {deferring, enqueue} from './batch'

// Strict identity for change-detection. `==` is wrong here on
// purpose: we must NOT let 0 == '' suppress a real change, and
// Object.is also folds NaN→NaN to "no change". This is the one
// place a strict compare is genuinely needed.
function sameValue<T>(a: T, b: T) { return Object.is(a, b) }

type tSubOpts = {
    // emit the current value to the new listener immediately,
    // before any future updates. Default false — a subscription
    // is "new updates only"; the snapshot is a separate concern.
    current?: boolean
}
type tAddOpts = {cbClose?: () => void, key?: string}

// a thing that can feed a derived node: read + subscribe
export type Source<T> = {
    get: () => T
    addListen: (cb: Listener<[T]>, opt?: tAddOpts) => (() => void)
    removeListen: (k: Listener<[T]> | string | null) => void
}

// ============================================================
//  identity — shared local-node registry (the "is this one of MINE?")
//
//  ONE module-scoped WeakSet branding EVERY node WE create — cells,
//  robject/rmap (and their per-key views), derived (combine/computed/
//  computedAuto), transit, and store nodes — plus each node's stable
//  raw() Listen façade. Two DIFFERENT questions, two mechanisms:
//   • local "is this LITERALLY my object" -> WeakSet membership.
//     O(1), no mutation, GC-safe, survives recycle (identity is by
//     reference; raw() is stable across the inner Listen's destroy/
//     recreate cycle).
//   • wire "is this any Listen-shaped thing, maybe deserialized" ->
//     isListenCallback (shape). A WeakSet/symbol DIES over the wire,
//     so duck-typing stays the network contract — complementary, not
//     a replacement. isListenCallback is left UNTOUCHED as the shape
//     contract; this set only answers "is it literally ours".
//
//  transit.ts keeps its own isOurTransit but registers into THIS set
//  too, so isReactiveNode is the single unified local check.
// ============================================================
const reactiveNodes = new WeakSet<object>()

// brand one or more objects as ours (the node + any façades). Returns
// the first arg for `return registerReactiveNode({...})` call-site ergonomics.
export function registerReactiveNode<T extends object>(node: T, ...also: object[]) {
    if (node != null && typeof node == 'object') reactiveNodes.add(node)
    for (const x of also) if (x != null && typeof x == 'object') reactiveNodes.add(x)
    return node
}

// local identity: literally one of our reactive nodes / façades?
export function isReactiveNode(x: any) {
    return x != null && typeof x == 'object' && reactiveNodes.has(x)
}

// ============================================================
//  core — lazy listen
//
//  funcListenCallbackBase (3 internal Maps) is allocated only
//  on the FIRST addListen. Until then `emit` is a no-op and the
//  source costs nothing.
//   • onActive(active) — fires on 0→1 and 1→0 listener edges
//     (the hook derived nodes use to connect/disconnect upstream).
//   • recycle — free the inner Listen back to null at 0 listeners,
//     fully returning to primitive after subscribers churn.
//   • raw() — a STABLE façade with the exact funcListenCallbackBase
//     shape (passes isListenCallback), so a captured ref — e.g. an
//     RPC binding — survives recycle's destroy/recreate cycle.
// ============================================================
export function createLazyListen<TArgs extends any[]>(opts: {
    onActive?: (active: boolean) => void
    recycle?: boolean
    // coalesce — batch deferral collapses repeat emits of THIS node to the
    // latest args. Correct for single-VALUE streams (a cell's final value),
    // WRONG for delta streams that emit distinct events ([key,value] /
    // [path,value]) where every emit matters. Such streams pass coalesce:false
    // so they emit inline even inside a batch (never silently drop a delta).
    coalesce?: boolean
} = {}) {
    const {onActive, recycle, coalesce = true} = opts
    // typed `any` internally: see ensure() — the TArgs↔NormalizeTuple<TArgs>
    // impedance is sound but unprovable to TS for a free generic.
    let inner: any = null
    let facade: any = null
    const closeHandlers = new Set<() => void>()   // persist across recycle
    // stable per-node identity for batch coalescing (see batch.ts). A node
    // emitted N times in one batch defers to ONE flush carrying the final args.
    const batchNode = {}

    function ensure() {
        if (inner) return inner
        // funcListenCallbackBase types its surface via NormalizeTuple<TArgs>; for
        // TArgs extends any[] that IS TArgs, but TS won't simplify the conditional
        // for a free generic. We carry TArgs as the already-normalized tuple and
        // bridge the (sound) impedance with casts confined to this core.
        const l = funcListenCallbackBase<TArgs>((() => {}) as any, {
            event(type, count) {
                if (type == 'add' && count == 1) onActive?.(true)
                else if (type == 'remove' && count == 0) {
                    onActive?.(false)
                    // free the Maps without firing close handlers — a recycle
                    // is not a permanent close; the source may wake again.
                    if (recycle) inner = null
                }
            }
        }) as any
        for (const h of closeHandlers) l.eventClose(h)
        inner = l
        return l
    }

    // built lazily on first .raw()/.listen() — cheap until you need the Listen object
    function makeFacade(): ReturnType<typeof funcListenCallbackBase<TArgs>> {
        if (facade) return facade
        facade = {
            func: ((...e: TArgs) => { inner?.func(...e) }) as Listener<TArgs>,
            isRun: () => inner?.isRun() ?? false,
            run: () => { ensure().run() },
            close() {
                if (inner && inner.count() > 0) onActive?.(false)   // run cold-down (upstream teardown) before close
                inner?.close()
                inner = null
                for (const h of closeHandlers) h()
                closeHandlers.clear()
            },
            eventClose(cb: () => void) {
                closeHandlers.add(cb)
                const off = inner?.eventClose(cb)
                return () => { closeHandlers.delete(cb); off?.() }
            },
            removeEventClose(cb: () => void) {
                closeHandlers.delete(cb)
                inner?.removeEventClose(cb)
            },
            addListen: (cb: Listener<TArgs>, opt?: tAddOpts) => ensure().addListen(cb, opt),
            removeListen: (k: Listener<TArgs> | string | null) => { inner?.removeListen(k) },
            count: () => inner?.count() ?? 0,
            get getAllKeys() { return inner?.getAllKeys ?? [] },
        }
        // the stable RPC façade is "ours" too — it survives recycle (identity
        // by ref), so a captured listen() ref stays recognized across churn.
        registerReactiveNode(facade)
        return facade
    }

    // emit, with opt-in batch deferral. When NOT batching this is the
    // UNCHANGED fast path — a single `if (inner)`. When batching, the
    // notification is coalesced PER NODE (latest args win) and fired once
    // on flush; we re-read the freshest args at flush time via a captured
    // thunk so an intermediate re-emit cannot replay a stale value.
    function emit(...e: TArgs) {
        // cold short-circuit FIRST: an unsubscribed node has nothing to notify,
        // even inside a batch — so it stays a pure no-op (the cheap-while-cold
        // property must survive an open batch elsewhere in the program).
        if (!inner) return
        // only single-value streams coalesce-defer; delta streams (coalesce:false)
        // must fire every distinct event, so they emit inline even while batching.
        if (coalesce && deferring()) {
            const deferred = enqueue(batchNode, function flushEmit() { inner?.func(...e) })
            if (deferred) return
        }
        inner.func(...e)
    }

    return {
        // hot path: nothing allocated, nothing iterated, until someone subscribes
        emit,
        addListen: (cb: Listener<TArgs>, opt?: tAddOpts): (() => void) => ensure().addListen(cb, opt),
        removeListen: (k: Listener<TArgs> | string | null) => { inner?.removeListen(k) },
        count: (): number => inner?.count() ?? 0,
        // stable, RPC-ready Listen façade (exact funcListenCallbackBase shape)
        raw: makeFacade,
        // current inner without allocating (null when never subscribed / recycled)
        peek: () => inner,
        close() {
            if (inner && inner.count() > 0) onActive?.(false)   // run cold-down (upstream teardown) before close
            inner?.close()
            inner = null
            for (const h of closeHandlers) h()
            closeHandlers.clear()
        },
    }
}
export type LazyListen<TArgs extends any[]> = ReturnType<typeof createLazyListen<TArgs>>

// ============================================================
//  primitive — createCell (reactive variable)
// ============================================================
export function createCell<T>(initial: T, {equals = sameValue, recycle}: {
    equals?: (a: T, b: T) => boolean
    recycle?: boolean
} = {}) {
    let value = initial
    const ev = createLazyListen<[T]>({recycle})

    function get() { return value }
    function set(next: T) {
        if (equals(value, next)) return false
        value = next
        ev.emit(value)
        return true
    }

    return registerReactiveNode({
        get,
        set,
        update: (fn: (prev: T) => T) => set(fn(value)),
        // raw subscribe — new updates only (RPC-compatible name/shape)
        addListen: ev.addListen,
        removeListen: ev.removeListen,
        // ergonomic subscribe — optional immediate current value
        subscribe(cb: Listener<[T]>, {current = false}: tSubOpts = {}) {
            if (current) cb(value)
            return ev.addListen(cb)
        },
        // derived view of this cell
        map: <R>(fn: (v: T) => R, o?: {equals?: (a: R, b: R) => boolean}) =>
            combine([{get, addListen: ev.addListen, removeListen: ev.removeListen}], ([v]) => fn(v), o),
        count: ev.count,
        // the underlying Listen — for RPC / listen-deep
        listen: ev.raw,
        close: ev.close,
    })
}
export type Cell<T> = ReturnType<typeof createCell<T>>

// ============================================================
//  primitive — createRObject (reactive record)
//  Per-key streams (lazy, one Listen per *subscribed* key) plus
//  a whole-object stream emitting [key, value] on any change.
// ============================================================
export function createRObject<T extends Record<string, any>>(
    initial: T,
    {equals = sameValue, recycle}: {equals?: (a: any, b: any) => boolean, recycle?: boolean} = {}
) {
    const data = {...initial} as T
    const keyEv = new Map<keyof T, LazyListen<[any]>>()   // lazy, per subscribed key (single value → coalesces)
    // whole-object stream emits [key,value] deltas → must NOT coalesce in a batch
    const whole = createLazyListen<[keyof T & string, any]>({recycle, coalesce: false})

    function keyListen(k: keyof T) {
        let l = keyEv.get(k)
        if (!l) { l = createLazyListen<[any]>({recycle}); keyEv.set(k, l) }
        return l
    }

    function set<K extends keyof T>(k: K, v: T[K]) {
        if (k in data && equals(data[k], v)) return false
        data[k] = v
        keyEv.get(k)?.emit(v)
        whole.emit(k as keyof T & string, v)
        return true
    }

    // per-key view — same shape as a Cell, bound to one key
    function key<K extends keyof T>(k: K) {
        const l = () => keyListen(k)
        const get = () => data[k]
        const addListen = (cb: Listener<[T[K]]>, opt?: tAddOpts) => l().addListen(cb as any, opt)
        const removeListen = (kk: any) => keyEv.get(k)?.removeListen(kk)
        return registerReactiveNode({
            get,
            set: (v: T[K]) => set(k, v),
            addListen,
            removeListen,
            subscribe(cb: Listener<[T[K]]>, {current = false}: tSubOpts = {}) {
                if (current) cb(data[k])
                return l().addListen(cb as any)
            },
            map: <R>(fn: (v: T[K]) => R, o?: {equals?: (a: R, b: R) => boolean}) =>
                combine([{get, addListen: addListen as any, removeListen}], ([v]) => fn(v), o),
            count: () => keyEv.get(k)?.count() ?? 0,
            listen: () => l().raw(),
        })
    }

    return registerReactiveNode({
        get: <K extends keyof T>(k: K) => data[k],
        set,
        update: <K extends keyof T>(k: K, fn: (prev: T[K]) => T[K]) => set(k, fn(data[k])),
        snapshot: () => ({...data}),
        key,
        // whole-object stream — [key, value] on every change
        addListen: whole.addListen,
        removeListen: whole.removeListen,
        subscribe(cb: Listener<[keyof T & string, any]>, {current = false}: tSubOpts = {}) {
            if (current) for (const k of Object.keys(data)) cb(k as keyof T & string, data[k])
            return whole.addListen(cb)
        },
        listen: whole.raw,
        close() {
            whole.close()
            keyEv.forEach(l => l.close())
            keyEv.clear()
        },
    })
}
export type RObject<T extends Record<string, any>> = ReturnType<typeof createRObject<T>>

// ============================================================
//  primitive — createRMap (reactive map, dynamic keys)
//  Same model as RObject but over a real Map: arbitrary key
//  types, add/delete, and a whole-map stream of [key, value].
//  A deletion emits `undefined` as the value.
// ============================================================
export function createRMap<K, V>(
    initial?: Iterable<readonly [K, V]>,
    {equals = sameValue, recycle}: {equals?: (a: V | undefined, b: V | undefined) => boolean, recycle?: boolean} = {}
) {
    const data = new Map<K, V>(initial as any)
    const keyEv = new Map<K, LazyListen<[V | undefined]>>()
    // whole-map stream emits [key,value] deltas → must NOT coalesce in a batch
    const whole = createLazyListen<[K, V | undefined]>({recycle, coalesce: false})

    function keyListen(k: K) {
        let l = keyEv.get(k)
        if (!l) { l = createLazyListen<[V | undefined]>({recycle}); keyEv.set(k, l) }
        return l
    }

    function set(k: K, v: V) {
        if (data.has(k) && equals(data.get(k), v)) return false
        data.set(k, v)
        keyEv.get(k)?.emit(v)
        whole.emit(k, v)
        return true
    }

    function del(k: K) {
        if (!data.has(k)) return false
        data.delete(k)
        keyEv.get(k)?.emit(undefined)
        whole.emit(k, undefined)
        return true
    }

    function key(k: K) {
        const l = () => keyListen(k)
        const get = () => data.get(k)
        const addListen = (cb: Listener<[V | undefined]>, opt?: tAddOpts) => l().addListen(cb, opt)
        const removeListen = (kk: any) => keyEv.get(k)?.removeListen(kk)
        return registerReactiveNode({
            get,
            set: (v: V) => set(k, v),
            delete: () => del(k),
            addListen,
            removeListen,
            subscribe(cb: Listener<[V | undefined]>, {current = false}: tSubOpts = {}) {
                if (current) cb(data.get(k))
                return l().addListen(cb)
            },
            map: <R>(fn: (v: V | undefined) => R, o?: {equals?: (a: R, b: R) => boolean}) =>
                combine([{get, addListen, removeListen}], ([v]) => fn(v), o),
            count: () => keyEv.get(k)?.count() ?? 0,
            listen: () => l().raw(),
        })
    }

    return registerReactiveNode({
        get: (k: K) => data.get(k),
        has: (k: K) => data.has(k),
        set,
        delete: del,
        update: (k: K, fn: (prev: V | undefined) => V) => set(k, fn(data.get(k))),
        get size() { return data.size },
        keys: () => data.keys(),
        entries: () => data.entries(),
        snapshot: () => new Map(data),
        key,
        addListen: whole.addListen,
        removeListen: whole.removeListen,
        subscribe(cb: Listener<[K, V | undefined]>, {current = false}: tSubOpts = {}) {
            if (current) for (const [k, v] of data) cb(k, v)
            return whole.addListen(cb)
        },
        listen: whole.raw,
        close() {
            whole.close()
            keyEv.forEach(l => l.close())
            keyEv.clear()
        },
    })
}
export type RMap<K, V> = ReturnType<typeof createRMap<K, V>>

// ============================================================
//  derived — combine / computed
//
//  A pull+push node over N sources:
//   • get()  pulls (recomputes from sources) with ZERO upstream
//     subscriptions — works while nobody listens to the derived.
//   • on first listener it subscribes to every source and pushes
//     recomputed values; on the last listener it drops them all.
//  So an entire derived graph stays cold (no upstream cost) until
//  a leaf subscriber appears, and collapses back when it leaves.
// ============================================================
type SourceValue<S> = S extends Source<infer U> ? U : never

export function combine<const S extends readonly Source<any>[], R>(
    sources: S,
    compute: (values: {[I in keyof S]: SourceValue<S[I]>}) => R,
    {equals = sameValue}: {equals?: (a: R, b: R) => boolean} = {}
) {
    let cached: R
    let live = false                 // are we subscribed to upstream right now?
    const offs: Array<() => void> = []

    function recompute() {
        return compute(sources.map(s => s.get()) as any)
    }

    const ev = createLazyListen<[R]>({
        recycle: true,
        onActive(active) {
            if (active) {
                cached = recompute()
                live = true
                for (const s of sources) {
                    offs.push(s.addListen(function onUpstream() {
                        const next = recompute()
                        if (equals(cached, next)) return
                        cached = next
                        ev.emit(next)
                    }))
                }
            } else {
                for (const off of offs) off()
                offs.length = 0
                live = false
            }
        },
    })

    function get() { return live ? cached : recompute() }

    return registerReactiveNode({
        get,
        addListen: ev.addListen,
        removeListen: ev.removeListen,
        subscribe(cb: Listener<[R]>, {current = false}: tSubOpts = {}) {
            if (current) cb(get())
            return ev.addListen(cb)
        },
        map: <R2>(fn: (v: R) => R2, o?: {equals?: (a: R2, b: R2) => boolean}) =>
            combine([{get, addListen: ev.addListen, removeListen: ev.removeListen}], ([v]) => fn(v), o),
        count: ev.count,
        listen: ev.raw,
        close: ev.close,
    })
}
// computed = combine over a single source
export function computed<T, R>(source: Source<T>, fn: (v: T) => R, opts?: {equals?: (a: R, b: R) => boolean}) {
    return combine([source], ([v]) => fn(v), opts)
}
export type Computed<R> = ReturnType<typeof combine<readonly Source<any>[], R>>

// re-export so consumers can verify a source's Listen is RPC-ready
export {isListenCallback}

// ============================================================
//  oracle — local node identity (the unified WeakSet registry)
//   node node_modules/ts-node/dist/bin.js --transpile-only observable/reactive.ts
//
//  Proves the ONE shared registry recognizes ALL of OUR node kinds
//  — cell, robject/rmap (+ per-key views), derived (combine/computed/
//  computedAuto), store nodes, transit — AND their stable raw() Listen
//  façade (survives recycle), while a foreign object is NOT ours. Also
//  checks isReactiveNode and isListenCallback stay complementary, not
//  the same answer.
// ============================================================
if (require.main === module) {
    const {createTransportStore} = require('./store') as typeof import('./store')
    const {filter, isOurTransit} = require('./transit') as typeof import('./transit')
    const {computedAuto} = require('./autotrack') as typeof import('./autotrack')
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }

    // (1) every node kind we create is recognized locally
    {
        const cell = createCell(1)
        const robj = createRObject({a: 1, b: 2})
        const rmap = createRMap<string, number>([['x', 1]])
        const der = combine([cell], ([v]) => v + 1)
        const cmp = computed(cell, v => v * 2)
        const auto = computedAuto(use => use(cell) + 1)
        const store = createTransportStore({price: 100, acct: {lev: 5}})
        const trans = filter(cell, () => true)

        assert(isReactiveNode(cell), 'cell is ours')
        assert(isReactiveNode(robj) && isReactiveNode(robj.key('a')), 'robject + per-key view are ours')
        assert(isReactiveNode(rmap) && isReactiveNode(rmap.key('x')), 'rmap + per-key view are ours')
        assert(isReactiveNode(der) && isReactiveNode(cmp), 'combine + computed are ours')
        assert(isReactiveNode(auto), 'computedAuto is ours')
        assert(isReactiveNode(store) && isReactiveNode(store.at('acct')), 'store root + nested node are ours')
        assert(isReactiveNode(trans), 'transit node is ours')

        // the stable raw() façade is branded too — and stays so across recycle
        assert(isReactiveNode(cell.listen()), 'cell raw() façade is ours')
        assert(isReactiveNode(store.listen()) && isReactiveNode(store.listenValue()), 'store listen façades are ours')
        const off = trans.subscribe(() => {})
        off()                                              // recycle frees the inner Listen
        assert(isReactiveNode(trans.listen()), 'transit façade still ours after recycle (identity by ref)')

        // transit-local check still agrees for transit nodes
        assert(isOurTransit(trans) && isReactiveNode(trans), 'isOurTransit and isReactiveNode both recognize a transit')
    }

    // (2) a FOREIGN object is not ours — and is not confused with a node
    {
        assert(!isReactiveNode({}), 'plain object is NOT ours')
        assert(!isReactiveNode({get: () => 1, addListen: () => () => {}, removeListen: () => {}}), 'a Source-SHAPED foreign object is NOT ours (identity, not shape)')
        assert(!isReactiveNode(null) && !isReactiveNode(undefined) && !isReactiveNode(42) && !isReactiveNode('x'), 'non-objects are NOT ours')
    }

    // (3) complementary, not identical: a foreign Listen-shaped object passes the
    //     WIRE check but is NOT local; our façade passes BOTH. We use a REAL
    //     funcListenCallbackBase (not made through our factories) as the foreign
    //     wire-shaped object, so the shape match is genuine, not hand-faked.
    {
        const cell = createCell(0)
        const wireShaped = funcListenCallbackBase(() => {})
        assert(isListenCallback(wireShaped) && !isReactiveNode(wireShaped), 'foreign Listen (not via our factories): passes shape check, fails local identity')
        assert(isListenCallback(cell.listen()) && isReactiveNode(cell.listen()), 'our façade passes BOTH the wire and the local check')
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    process.exit(fails == 0 ? 0 : 1)
}
