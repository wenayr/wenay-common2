// ============================================================
//  auto.ts — transparent reactivity via LAZY PROXY UPGRADE
//
//  This realises the idea: "let the subscriber upgrade the
//  resource while it is still a primitive".
//
//    no subscribers  → `.store` IS the raw object (zero Proxy
//                       overhead, plain reads/writes, no events)
//    first subscribe → the object is wrapped in a Proxy in place,
//                       so plain mutations `store.x = 5` emit
//    last unsubscribe→ downgraded back to the raw primitive
//
//  Trade-off (the in-place-upgrade caveat): the identity of
//  `.store` CHANGES on upgrade/downgrade. A reference captured
//  while it was still primitive will NOT trap writes — callers
//  must read `.store` fresh after subscribing. This is exactly
//  why valtio/Vue hand you a Proxy from the start; here we trade
//  that for "free until observed". Pick per use-case.
//
//  Reactivity itself is still lazy (createLazyListen): even the
//  Proxy allocates no Listen Maps until a key/whole stream is
//  actually subscribed.
// ============================================================

import {createLazyListen, LazyListen} from './reactive'
import {Listener} from '../src/Common/events/Listen'

type tSubOpts = {current?: boolean}

export function createAuto<T extends Record<string, any>>(initial: T, {recycle = true}: {recycle?: boolean} = {}) {
    const raw = initial
    let proxy: T | null = null
    let active = 0                         // live listens across whole + all keys
    const keyEv = new Map<PropertyKey, LazyListen<[any]>>()

    // when the very last listener leaves, drop the Proxy → back to primitive
    function onActive(on: boolean) {
        active += on ? 1 : -1
        if (active == 0) proxy = null
    }

    const whole = createLazyListen<[string, any]>({recycle, onActive})

    function keyListen(k: PropertyKey) {
        let l = keyEv.get(k)
        if (!l) { l = createLazyListen<[any]>({recycle, onActive}); keyEv.set(k, l) }
        return l
    }

    // the upgrade: wrap raw in a Proxy whose set/delete traps emit
    function upgrade() {
        if (proxy) return proxy
        proxy = new Proxy(raw, {
            set(t, k, v) {
                const changed = !(k in t) || !Object.is((t as any)[k], v)
                ;(t as any)[k] = v
                if (changed) { keyEv.get(k)?.emit(v); whole.emit(String(k), v) }
                return true
            },
            deleteProperty(t, k) {
                const had = k in t
                delete (t as any)[k]
                if (had) { keyEv.get(k)?.emit(undefined); whole.emit(String(k), undefined) }
                return true
            },
        })
        return proxy
    }

    return {
        // primitive until observed, Proxy while observed — READ FRESH after subscribing
        get store() { return (proxy ?? raw) as T },
        isReactive: () => proxy != null,
        // whole-object stream: [key, value] on any trapped mutation
        subscribe(cb: Listener<[string, any]>, {current = false}: tSubOpts = {}) {
            upgrade()
            if (current) for (const k of Object.keys(raw)) cb(k, (raw as any)[k])
            return whole.addListen(cb)
        },
        // one field
        key<K extends keyof T>(k: K) {
            const get = () => (raw as any)[k] as T[K]
            return {
                get,
                subscribe(cb: Listener<[T[K]]>, {current = false}: tSubOpts = {}) {
                    upgrade()
                    if (current) cb(get())
                    return keyListen(k).addListen(cb as any)
                },
                listen: () => keyListen(k).raw(),
            }
        },
        listen: whole.raw,
        close() { whole.close(); keyEv.forEach(l => l.close()); keyEv.clear(); proxy = null; active = 0 },
    }
}
export type Auto<T extends Record<string, any>> = ReturnType<typeof createAuto<T>>

// ============================================================
//  createAutoNode — the SAME lazy-Proxy trick, but WRITE-THROUGH
//  to a store node, so a whole store CATEGORY can be mutated as a
//  plain object.
//
//    const cat = store.at('balances')      // a store node facade
//    const view = createAutoNode(cat)
//    const off  = view.subscribe(() => {}) // upgrade: Proxy in place
//    const o    = view.store               // read FRESH (it's the Proxy now)
//    o.BTC = 5                             // plain set  → cat.set('BTC',5)
//    delete o.ETH                          // plain del  → cat.delete('ETH')
//
//  Unlike createAuto (which owns a raw object and emits its own
//  events), createAutoNode owns NOTHING: every trapped mutation is
//  forwarded to the store node, so it emits through the store's
//  EXISTING value/entries/deep streams. The proxy target is a thin
//  shell kept in sync with the node; reads go through snapshot().
//
//  Cheap-until-observed, same as createAuto: the Proxy is allocated
//  on the first subscribe and dropped on the last unsubscribe. We
//  piggy-back the store node's entries() stream for the onActive
//  accounting (0<->1 / 1<->0 edges) — no second listener machinery.
//
//  THE IN-PLACE-UPGRADE CAVEAT (identical to createAuto, and worth
//  repeating): `.store` identity CHANGES on upgrade/downgrade. A
//  reference captured while it was still the plain shell will NOT
//  write through to the node. Always read `.store` FRESH after
//  subscribing.
// ============================================================

// the minimal slice of a store node facade we write through. Kept structural
// (not an import of TransportStore) so this stays 0-coupling + additive.
export type tStoreNode = {
    get: (k?: tKey) => any
    snapshot: () => any
    keys: () => tKey[]
    has: (k: tKey) => boolean
    set: (k: tKey, v: any) => boolean
    delete: (k: tKey) => boolean
    entries: (cb: Listener<[tKey, any]>, opts?: tSubOpts) => () => void
}
type tKey = string

export function createAutoNode<T extends Record<string, any> = Record<string, any>>(node: tStoreNode) {
    let proxy: T | null = null
    let active = 0
    // listeners we are proxying onto the node's entries stream; each returns its
    // own off() and we tear them all down on the 1->0 edge alongside the Proxy.
    const offs = new Set<() => void>()

    // a fresh shell mirroring the node's current children — the Proxy target.
    // We rebuild it on each upgrade so reads reflect the node even after a
    // downgrade/upgrade cycle mutated the node underneath us.
    function shell() {
        const o: any = {}
        for (const k of node.keys()) o[k] = node.get(k)
        return o
    }

    // upgrade: wrap a fresh shell whose traps WRITE THROUGH to the store node.
    // The node does the diffing + emitting; the shell is only a read mirror.
    function upgrade() {
        if (proxy) return proxy
        proxy = new Proxy(shell(), {
            get(t, k) {
                // serve from the node so reads stay correct even if the shell drifted
                if (typeof k == 'string' && node.has(k)) return node.get(k)
                return (t as any)[k]
            },
            has(t, k) {
                if (typeof k == 'string') return node.has(k)
                return k in t
            },
            ownKeys() { return node.keys() },
            getOwnPropertyDescriptor(t, k) {
                if (typeof k == 'string' && node.has(k))
                    return {configurable: true, enumerable: true, value: node.get(k), writable: true}
                return Object.getOwnPropertyDescriptor(t, k)
            },
            set(t, k, v) {
                ;(t as any)[k] = v
                if (typeof k == 'string') node.set(k, v)   // node diffs + emits
                return true
            },
            deleteProperty(t, k) {
                delete (t as any)[k]
                if (typeof k == 'string') node.delete(k)   // node emits on real delete
                return true
            },
        }) as T
        return proxy
    }

    function onActive(on: boolean) {
        active += on ? 1 : -1
        if (active == 0) { offs.forEach(off => off()); offs.clear(); proxy = null }
    }

    return {
        // plain shell until observed, write-through Proxy while observed —
        // READ FRESH after subscribing (the in-place-upgrade caveat).
        get store() { return (proxy ?? shell()) as T },
        isReactive: () => proxy != null,
        // subscribe to the node's DIRECT children (entries granularity). The act of
        // subscribing upgrades us to the write-through Proxy; the last unsubscribe
        // downgrades. cb fires with (key, value) just like store.at(path).entries().
        subscribe(cb: Listener<[tKey, any]>, opts: tSubOpts = {}) {
            upgrade()
            onActive(true)
            const off = node.entries(cb, opts)
            let done = false
            function unsubscribe() {
                if (done) return
                done = true
                offs.delete(off)
                off()
                onActive(false)
            }
            offs.add(off)
            return unsubscribe
        },
        // the live store node, for deep()/value()/snapshot() and further navigation
        node,
    }
}
export type AutoNode<T extends Record<string, any> = Record<string, any>> = ReturnType<typeof createAutoNode<T>>

// ── runnable demo / smoke check ─────────────────────────────
if (require.main === module) {
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }
    const J = (v: any) => JSON.stringify(v)

    const init = {x: 1, y: 2}
    const a = createAuto(init)

    console.log('\n[auto] primitive until observed')
    assert(a.isReactive() == false, 'not reactive with no subscribers')
    assert(a.store === init, 'store IS the raw object reference (no wrapper)')
    a.store.x = 10                       // plain write, nobody listening → no events
    assert(a.store.x == 10 && a.isReactive() == false, 'cheap write while unobserved, still primitive')

    console.log('\n[auto] upgrade on subscribe; plain mutation emits')
    const whole: any[] = []
    const onX: any[] = []
    const offW = a.subscribe((k, v) => whole.push([k, v]))
    const offX = a.key('x').subscribe(v => onX.push(v))
    assert(a.isReactive() == true, 'upgraded to Proxy after subscribe')
    const s = a.store as any             // read FRESH — this is the Proxy now
    s.x = 11                             // plain mutation → emits
    s.y = 22
    delete s.z                           // no-op (absent) → no emit
    s.z = 99                             // new key → emits
    assert(J(onX) == '[11]', 'key("x") saw only x: ' + J(onX))
    assert(J(whole) == '[["x",11],["y",22],["z",99]]', 'whole saw x,y,z: ' + J(whole))

    console.log('\n[auto] downgrade to primitive when last listener leaves')
    offW(); offX()
    assert(a.isReactive() == false, 'back to primitive after last unsubscribe')
    a.store.x = 1000                     // plain write again, no events
    assert(a.store.x == 1000, 'cheap writes resume after downgrade')

    console.log('\n[auto] the in-place-upgrade caveat (documented)')
    const captured = a.store             // captured while primitive (raw)
    a.subscribe(() => { throw new Error('should not fire from captured raw write') })
    captured.x = 7                       // writes the raw object directly → does NOT trap
    assert(a.store.x == 7, 'captured-raw write lands in data but bypasses Proxy (expected)')

    // ── createAutoNode: plain mutation on a store CATEGORY ──────
    // require inside the oracle so the library surface adds no top-level coupling.
    const {createTransportStore} = require('./store') as typeof import('./store')

    console.log('\n[autoNode] plain set/delete on a store category writes through')
    const store = createTransportStore({balances: new Map([['BTC', 1], ['ETH', 10]])})
    const cat = store.at('balances')
    const view = createAutoNode(cat)

    assert(view.isReactive() == false, 'autoNode not reactive with no subscribers')
    assert(view.store !== view.store, 'store shell is fresh each read while unobserved (no Proxy)')

    const seenEntries: any[] = []
    const seenDeep: any[] = []
    const offEntries = cat.entries((k, v) => seenEntries.push([k, v]))
    const offDeep = cat.deep((p, v) => seenDeep.push([p.join('.'), v]))
    const offView = view.subscribe(() => {})
    assert(view.isReactive() == true, 'autoNode upgraded to Proxy after subscribe')

    const o = view.store as any            // read FRESH — this is the write-through Proxy
    o.foo = 1                              // plain set → node.set('foo',1) → emits
    o.BTC = 2                              // change existing → emits
    o.BTC = 2                              // same value → node diffs to silent
    delete o.ETH                           // plain delete → node.delete('ETH') → emits
    delete o.nope                          // absent → node delete is a no-op

    assert(seenEntries.some(([k, v]) => k == 'foo' && v == 1), 'set foo=1 surfaced via entries(): ' + J(seenEntries))
    assert(seenEntries.some(([k, v]) => k == 'BTC' && v == 2), 'set BTC=2 surfaced via entries(): ' + J(seenEntries))
    assert(seenEntries.filter(([k]) => k == 'BTC').length == 1, 'same-value BTC write did not re-emit (node diffed): ' + J(seenEntries))
    assert(seenEntries.some(([k, v]) => k == 'ETH' && v == undefined), 'delete ETH surfaced via entries(): ' + J(seenEntries))
    assert(seenDeep.some(([p, v]) => p == 'balances.foo' && v == 1), 'set foo=1 surfaced via deep() with full path: ' + J(seenDeep))

    console.log('\n[autoNode] reads + snapshot round-trip through the node')
    assert(o.foo == 1 && o.BTC == 2, 'Proxy reads serve node values: foo=' + o.foo + ' BTC=' + o.BTC)
    assert(('ETH' in o) == false && 'foo' in o, 'has-trap reflects node membership after delete/add')
    assert(J(Object.keys(o).sort()) == J(['BTC', 'foo']), 'ownKeys reflect node children: ' + J(Object.keys(o).sort()))
    const snap = cat.snapshot()
    assert(snap instanceof Map && snap.size == 2 && snap.get('BTC') == 2 && snap.get('foo') == 1 && !snap.has('ETH'),
        'node snapshot round-trips the plain mutations (Map fidelity): ' + J([...snap]))

    console.log('\n[autoNode] downgrade drops the Proxy on last unsubscribe')
    offView()
    assert(view.isReactive() == false, 'autoNode back to plain shell after last unsubscribe')
    const shellAfter = view.store as any   // a plain shell mirror, not a Proxy
    shellAfter.zzz = 5                      // writes the shell only → does NOT reach the node
    assert(cat.has('zzz') == false, 'write to downgraded shell bypasses the node (in-place-upgrade caveat)')
    offEntries(); offDeep()

    console.log('\n[autoNode] the in-place-upgrade caveat (documented): captured-while-plain ref does not write through')
    const off2 = view.subscribe(() => {})
    const freshProxy = view.store as any   // read FRESH after subscribe — this one traps
    freshProxy.cap = 7
    assert(cat.get('cap') == 7, 'fresh-read Proxy DOES write through: ' + cat.get('cap'))
    off2()

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    process.exit(fails == 0 ? 0 : 1)
}
