// ============================================================
//  typed.ts — type-level field projection over a transport store
//
//  The store (store.ts) is a uniform, path-addressed reactive tree
//  whose facade is intentionally `any` outside. That untyped surface
//  is what makes the diffing/snapshot engine generic — but a CLIENT
//  almost always knows the SHAPE it talks to, and almost always wants
//  only a SUBSET of it (a balances feed doesn't care about secrets).
//
//  This module is "GraphQL field-selection, but as a TS type": you
//  describe the subset with a plain projection object (`{balances:true,
//  account:{leverage:true}}`) and the types narrow the store reads AND
//  the projected view to exactly that subset. There is no DSL and no
//  parser — the projection IS a value-level mirror of a TS type, so
//  the compiler does the whole job. The runtime is a thin wrapper over
//  the existing store: we only add types and walk the selection.
//
//  Layers (CLAUDE.md):
//   • types        — Projection / Project / shape helpers (the value)
//   • resource     — typedStore (cast wrapper over createTransportStore)
//   • business     — project (walk a selection, expose typed view nodes)
// ============================================================

import {createTransportStore, tKey, tPath} from './store'
import {Listener} from '../src/Common/events/Listen'

type tSubOpts = {current?: boolean}

// ============================================================
//  types — shape inspection
//
//  A "branch" is something we can recurse into: a plain object,
//  or a Map whose VALUES are objects (a Map<string, Account> is a
//  branch keyed by string; a Map<string, number> is a leaf-ish
//  collection we take wholesale). Everything else is a leaf.
// ============================================================

// the element type a Map projects to (its value), else never
type tMapValue<T> = T extends Map<any, infer V> ? V : never

// is `T` a record we can drill into key-by-key?
type tIsPlainObject<T> = T extends object
    ? T extends Map<any, any> ? false
    : T extends ReadonlyArray<any> ? false
    : T extends (...a: any[]) => any ? false
    : true
    : false

// a Map<_, object> recurses into the object shape under each key;
// a plain object recurses into its own keys; anything else is a leaf.
type tChildShape<T> =
    tIsPlainObject<T> extends true ? T
    : T extends Map<any, infer V> ? (tIsPlainObject<V> extends true ? V : never)
    : never

// ============================================================
//  types — Projection
//
//  For each key of T: `true` takes the leaf/whole branch, or a nested
//  Projection narrows further. Nesting is only OFFERED where there is
//  a child shape to drill into (plain object, or Map-of-objects);
//  leaf keys accept `true` only.
// ============================================================
export type Projection<T> = {
    [K in keyof T]?:
        tChildShape<T[K]> extends never ? true
        : true | Projection<tChildShape<T[K]>>
}

// ============================================================
//  types — Project (the narrowed result shape)
//
//  Drop unselected keys. For a selected key:
//   • `true`            → keep the original type as-is.
//   • nested Projection → narrow: a plain object narrows its keys; a
//     Map<K, object> stays a Map but with each value narrowed.
// ============================================================
export type Project<T, S extends Projection<T>> = {
    [K in keyof S & keyof T]:
        S[K] extends true ? T[K]
        : S[K] extends Projection<any>
            ? T[K] extends Map<infer MK, infer MV>
                ? Map<MK, MV extends object ? Project<MV, Extract<S[K], Projection<MV>>> : MV>
                : Project<T[K], Extract<S[K], Projection<T[K]>>>
        : T[K]
}

// ============================================================
//  resource — typedStore
//
//  Pure type overlay on createTransportStore. The runtime is the
//  untyped node facade verbatim; we only retype the surface that a
//  caller addresses by known key/path. Internally `any`-casts are
//  fine — the engine is shape-agnostic by design (store.ts).
// ============================================================

// the typed face we expose. Reads/writes are narrowed against T;
// navigation returns a child face typed at the child shape.
export type TypedNode<T> = {
    get<K extends keyof T>(k: K): T[K]
    get(): T
    snapshot(): T
    has(k: keyof T): boolean
    keys(): (keyof T)[]
    path: tPath

    set<K extends keyof T>(k: K, v: T[K]): boolean
    replace(v: T): boolean
    delete(k: keyof T): boolean

    // navigate into a known key — child face typed at the child shape
    key<K extends keyof T>(k: K): TypedNode<tChildShape<T[K]> extends never ? T[K] : tChildShape<T[K]>>
    at<K extends keyof T>(k: K): TypedNode<tChildShape<T[K]> extends never ? T[K] : tChildShape<T[K]>>

    value(cb: Listener<[T]>, opt?: tSubOpts): () => void
    entries(cb: Listener<[tKey, any]>, opt?: tSubOpts): () => void
    deep(cb: Listener<[tPath, any]>, opt?: tSubOpts): () => void
}

export function typedStore<T extends object>(initial?: Partial<T>) {
    // engine is shape-agnostic; the type is the whole contribution here.
    return createTransportStore(initial as any) as unknown as TypedNode<T>
}
export type TypedStore<T extends object> = ReturnType<typeof typedStore<T>>

// ============================================================
//  business — project (a typed view of a selected subset)
//
//  Walk the selection once and expose, per selected key, the matching
//  store node (already a uniform facade). The view's reads/snapshot are
//  typed as Project<T, S> so the compiler refuses any unselected key.
//  Runtime stays thin: navigation is delegated to the live store, so
//  the view reflects writes made through the typed store.
// ============================================================

export type ProjectedView<T, S extends Projection<T>> = {
    // the narrowed snapshot — only selected branches, nested-narrowed
    snapshot(): Project<T, S>
    // a selected branch as its own (untyped-inside) node facade
    node<K extends keyof S & keyof T>(k: K): any
    // typed leaf/branch read for a selected key
    get<K extends keyof S & keyof T>(k: K): Project<T, S>[K & keyof Project<T, S>]
    // which keys this view selected
    keys(): (keyof S & keyof T)[]
}

export function project<T extends object, S extends Projection<T>>(
    store: TypedNode<T>,
    sel: S
) {
    // the store facade is uniform at every depth; `any` here is the
    // engine's native surface — projection types live at the boundary.
    const raw = store as any
    const selKeys = Object.keys(sel) as (keyof S & keyof T)[]

    // recursively narrow a node's snapshot against a sub-selection,
    // so snapshot() of the view contains ONLY selected branches.
    function pick(node: any, s: any): any {
        const out: any = {}
        for (const k of Object.keys(s)) {
            const child = node.key(k)
            const sub = s[k]
            if (sub == true) { out[k] = child.snapshot(); continue }
            // sub is a nested projection
            const snap = child.snapshot()
            if (snap instanceof Map) {
                // Map<_, object>: narrow each value by the sub-projection
                const m = new Map()
                for (const mk of child.keys()) m.set(mk, pick(child.key(mk), sub))
                out[k] = m
            } else {
                out[k] = pick(child, sub)
            }
        }
        return out
    }

    // read one selected key, narrowed by its sub-selection (so a nested
    // projection drops unselected siblings at runtime too, matching the type).
    function getKey(k: keyof S & keyof T) {
        const sub = (sel as any)[k]
        const child = raw.key(k)
        return sub == true ? child.snapshot() : (pick(raw, {[k]: sub} as any) as any)[k]
    }

    const view = {
        snapshot: () => pick(raw, sel) as Project<T, S>,
        node: (k: keyof S & keyof T) => raw.key(k),
        get: (k: keyof S & keyof T) => getKey(k),
        keys: () => selKeys,
    }
    return view as ProjectedView<T, S>
}

// ============================================================
//  runnable demo — proves narrowing (tsc) + runtime correctness
// ============================================================
if (require.main === module) {
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }
    const J = (v: any) => JSON.stringify(v, (_k, x) => x instanceof Map ? {__map: [...x]} : x)

    type tAccount = {leverage: number, secret: string}
    type tShape = {
        price: number
        balances: Map<string, number>
        account: tAccount
    }

    const store = typedStore<tShape>({
        price: 100,
        balances: new Map([['BTC', 1], ['ETH', 10]]),
        account: {leverage: 5, secret: 'hunter2'},
    })

    console.log('\n[typed] typed store reads narrow to T')
    const price = store.get('price')       // typed number
    const lev = store.at('account').get('leverage')   // typed number
    assert(price == 100, 'typed leaf read: ' + price)
    assert(lev == 5, 'typed nested read via at(): ' + lev)

    // ── compile-time narrowing (these would fail tsc if types were wrong) ──
    // @ts-expect-error — 'nope' is not a key of tShape
    store.get('nope')
    // @ts-expect-error — 'secret' is not in the projection's account selection
    const _bad: typeof viewSnap.account.secret = undefined

    console.log('\n[typed] project a subset: {balances:true, account:{leverage:true}}')
    const view = project(store, {balances: true, account: {leverage: true}})
    const viewSnap = view.snapshot()

    // typed access to selected branches
    const balSnap = viewSnap.balances           // Map<string, number>
    const levSnap = viewSnap.account.leverage   // number
    assert(balSnap.get('BTC') == 1 && balSnap.get('ETH') == 10, 'selected Map branch reads: ' + J(balSnap))
    assert(levSnap == 5, 'selected nested leaf reads: ' + levSnap)

    console.log('\n[typed] snapshot of view contains ONLY selected branches')
    assert(!('price' in viewSnap), 'unselected leaf "price" absent from view snapshot')
    assert(!('secret' in (viewSnap.account as any)), 'unselected "secret" absent from narrowed account')
    assert('leverage' in viewSnap.account, 'selected "leverage" present')
    assert(viewSnap.balances instanceof Map, 'balances kept as Map in view')

    console.log('\n[typed] view reflects live writes through the typed store')
    store.set('balances', new Map([['BTC', 2], ['ETH', 10], ['SOL', 3]]))
    const after = view.snapshot()
    assert(after.balances.get('BTC') == 2 && after.balances.get('SOL') == 3, 'view sees updated balances: ' + J(after.balances))

    console.log('\n[typed] view.get reads a selected branch directly (nested-narrowed)')
    assert(view.get('account').leverage == 5, 'view.get selected branch: ' + J(view.get('account')))
    assert(!('secret' in (view.get('account') as any)), 'view.get drops unselected "secret" at runtime too')
    assert(J(view.keys()) == '["balances","account"]', 'view reports selected keys: ' + J(view.keys()))

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    process.exit(fails == 0 ? 0 : 1)
}
