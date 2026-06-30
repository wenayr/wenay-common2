// ============================================================
//  native.ts — `createReactive`: a PLAIN-OBJECT native skin over
//  the transport store (store.ts).
//
//  The whole point: read & write a reactive tree as if it were a
//  normal object, at any depth, including replacing a whole sub-tree:
//
//      const p = createReactive({price: 0, balances: {BTC: 1}})
//      p.price = 100              // plain set  -> emits
//      p.balances.BTC = 2         // nested set -> emits
//      p.balances = {a: {c: 5}}   // sub-tree replace -> DIFFS, only deltas fire
//      delete p.balances.ETH      // plain delete -> emits
//      p.balances.BTC             // plain read
//      Object.keys(p.balances)    // native enumeration / spread / `in`
//
//  No `.set('k',v)` / `.get('k')` / `{current:true}` ceremony, and —
//  unlike auto.ts — NO identity-change caveat: the Proxy is STABLE
//  (never dropped at 0 listeners). All reactivity is the existing
//  store engine; this file adds only the Proxy syntax + free-function
//  subscription surface. No new reactivity logic.
//
//  Lazy twice: (a) events are lazy via the store's createLazyListen
//  (no listeners -> no Listen Maps); (b) a child Proxy for a sub-tree
//  is built only on first navigation into it and cached, so untouched
//  branches allocate no Proxy.
//
//  Subscription lives in FREE FUNCTIONS (onValue/onChange/onKey/onDeep/
//  listen*/snapshot/setIn) so the object itself stays 100% pure data;
//  the underlying store node is reached through a hidden, non-enumerable
//  Symbol carried on every Proxy.
// ============================================================

import {createTransportStore, TransportStore, tKey, tPath, tStoreOpts} from './store'
import {registerReactiveNode} from './reactive'
import {Listener, funcListenCallbackBase} from '../src/Common/events/Listen'

type tSubOpts = {current?: boolean}
type tNode = ReturnType<TransportStore['key']>          // a uniform store node facade
type tKeyPath = tKey | tPath

// private brand: read it off any reactive Proxy to recover its store node.
// A Symbol key is invisible to Object.keys / spread / JSON, so the Proxy
// reads as pure data everywhere except this one internal lookup.
const NODE = Symbol('reactiveNode')

function toPath(k: tKeyPath): tPath { return Array.isArray(k) ? k : [k] }

// a child node is a CONTAINER (navigate into it) vs a LEAF (return the value).
// kind is tagged by the store on applyContainer; an opaque/primitive leaf has
// kind null and no children.
function isContainerNode(n: tNode) { return n.keys().length > 0 || n.containerKind() != null }

// wrap one store node in a stable, navigation-lazy Proxy
function wrap<T extends object>(node: tNode): T {
    const childCache = new Map<string, any>()        // string key -> child Proxy (lazy)

    function readChild(k: string) {
        const child = node.key(k)
        if (!isContainerNode(child)) return child.snapshot()   // leaf -> the primitive
        let pr = childCache.get(k)
        if (!pr) { pr = wrap(child); childCache.set(k, pr) }    // container -> cached child Proxy
        return pr
    }

    const proxy = new Proxy({} as any, {
        get(t, k) {
            if (k == NODE) return node
            if (typeof k != 'string') return (t as any)[k]      // symbols (inspect/iterator/then) stay inert
            if (!node.has(k)) return undefined
            return readChild(k)
        },
        set(t, k, v) {
            if (typeof k != 'string') { (t as any)[k] = v; return true }
            node.set(k, v)                                       // store diffs + emits (new key / nested / replace)
            childCache.delete(k)                                 // shape may have changed -> drop stale child Proxy
            return true
        },
        deleteProperty(t, k) {
            if (typeof k == 'string') { node.delete(k); childCache.delete(k) }
            return true
        },
        has(t, k) {
            if (k == NODE) return true
            if (typeof k == 'string') return node.has(k)
            return k in t
        },
        ownKeys() { return node.keys() },
        getOwnPropertyDescriptor(t, k) {
            if (typeof k == 'string' && node.has(k))
                return {configurable: true, enumerable: true, writable: true, value: readChild(k)}
            return Object.getOwnPropertyDescriptor(t, k)
        },
    })
    // brand it as one of ours (so isReactiveNode recognizes a reactive Proxy)
    return registerReactiveNode(proxy) as T
}

// ============================================================
//  api — createReactive + free-function subscription surface
// ============================================================

export function createReactive<T extends Record<string, any>>(initial: T, opts?: tStoreOpts) {
    const store = createTransportStore(initial, opts)
    return wrap<T>(store as any)
}
export type Reactive<T extends Record<string, any>> = T

// recover the store node behind a reactive Proxy (throws on a foreign object)
function nodeOf(p: any): tNode {
    const n = p?.[NODE]
    if (!n) throw new Error('createReactive: not a reactive object')
    return n
}

// the node at an optional sub-path (root when omitted)
function nodeAt(p: any, path?: tKeyPath) {
    const n = nodeOf(p)
    return path == null ? n : n.at(toPath(path))
}

// the live store node, for deep()/rev()/at() and anything the facade exposes
export function node(p: any): tNode { return nodeOf(p) }

// subscribe to ONE (possibly deep) leaf's value. Path-addressed from `p`,
// because reading a leaf returns the primitive, not a node — so a deep leaf
// (`p.p.a.c`) is subscribed as `onValue(p, ['p','a','c'], cb)`.
export function onValue<V = any>(p: any, path: tKeyPath, cb: Listener<[V]>, opts?: tSubOpts) {
    return nodeOf(p).at(toPath(path)).value(cb as any, opts)
}

// sugar: value of a DIRECT child key
export function onKey<V = any>(p: any, key: tKey, cb: Listener<[V]>, opts?: tSubOpts) {
    return nodeOf(p).key(key).value(cb as any, opts)
}

// subscribe to DIRECT children of this node: (key, value) deltas
export function onChange(p: any, cb: Listener<[tKey, any]>, opts?: tSubOpts) {
    return nodeOf(p).entries(cb, opts)
}

// subscribe to ANYTHING below: (path, value) deltas
export function onDeep(p: any, cb: Listener<[tPath, any]>, opts?: tSubOpts) {
    return nodeOf(p).deep(cb, opts)
}

// deep set with auto-vivification of intermediate containers (chained `p.a.b=5`
// can't auto-create missing `a`; use this for that case)
export function setIn(p: any, path: tPath, v: any) { return nodeOf(p).setIn(path, v) }

// RPC-ready Listen façades (exact funcListenCallbackBase shape). Same split as the
// store node facade — pick by what you're watching. Each is generic in the VALUE
// type so the callback channel stays typed end-to-end over RPC (DeepSocketListen):
//   listen<V>(p, path?)      — children deltas (entries stream): watch a COLLECTION → (key, value)
//   listenValue<V>(p, path?) — a leaf's value stream:            watch a single FIELD → (value)
//   listenDeep<V>(p, path?)  — everything-below deltas → (path, value)
type tListen<TArgs extends any[]> = ReturnType<typeof funcListenCallbackBase<TArgs>>
export function listen<V = any>(p: any, path?: tKeyPath) {
    return nodeAt(p, path).listen() as unknown as tListen<[tKey, V]>
}
export function listenValue<V = any>(p: any, path?: tKeyPath) {
    return nodeAt(p, path).listenValue() as unknown as tListen<[V]>
}
export function listenDeep<V = any>(p: any, path?: tKeyPath) {
    return nodeAt(p, path).listenDeep() as unknown as tListen<[tPath, V]>
}

// a plain, detached snapshot (Map/object fidelity preserved by the store)
export function snapshot(p: any, path?: tKeyPath) { return nodeAt(p, path).snapshot() }

// ============================================================
//  runnable oracle
//   node node_modules/ts-node/dist/bin.js --transpile-only observable/native.ts
// ============================================================
if (require.main === module) {
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }
    const J = (v: any) => JSON.stringify(v, (_k, x) => x instanceof Map ? {__map: [...x]} : x)
    const {isListenCallback} = require('./reactive') as typeof import('./reactive')

    console.log('\n[native] plain read/write')
    {
        const p = createReactive({price: 0, balances: {BTC: 1, ETH: 10}})
        p.price = 100
        assert(p.price == 100, 'plain set+read: ' + p.price)
        p.balances.BTC = 2
        assert(p.balances.BTC == 2, 'nested plain set+read: ' + p.balances.BTC)
    }

    console.log('\n[native] subscribe to a direct leaf — plain set emits')
    {
        const p = createReactive({price: 0})
        const seen: number[] = []
        onKey<number>(p, 'price', v => seen.push(v))
        p.price = 100
        p.price = 100               // unchanged -> store diffs to silent
        p.price = 101
        assert(J(seen) == '[100,101]', 'leaf value emits, dedup unchanged: ' + J(seen))
    }

    console.log('\n[native] HEADLINE: p.p = {a:{c:5}} fires deep leaf p.p.a.c')
    {
        const p = createReactive<any>({})
        const seen: any[] = []
        onValue(p, ['p', 'a', 'c'], v => seen.push(v))   // subscribe BEFORE the path exists
        p.p = {a: {c: 5}}                                 // whole sub-tree assigned
        assert(J(seen) == '[5]', 'deep leaf c got 5 from a whole-subtree assign: ' + J(seen))
        assert(p.p.a.c == 5, 'deep read after assign: ' + p.p.a.c)
    }

    console.log('\n[native] whole sub-tree replace emits ONLY deltas (Binance case)')
    {
        const p = createReactive<any>({balances: {BTC: 1, ETH: 10}})
        const onBTC: any[] = [], onEntries: any[] = []
        onKey(p, 'balances', () => {})                   // ensure node exists (no-op cb on container value)
        onValue(p.balances, 'BTC', v => onBTC.push(v))
        onChange(p.balances, (k, v) => onEntries.push([k, v]))
        p.balances = {BTC: 1, ETH: 11, SOL: 3}           // BTC same, ETH changed, SOL new
        assert(J(onBTC) == '[]', 'BTC silent (unchanged): ' + J(onBTC))
        assert(J(onEntries) == '[["ETH",11],["SOL",3]]', 'only ETH+SOL fired: ' + J(onEntries))
    }

    console.log('\n[native] delete + native enumeration + snapshot')
    {
        const p = createReactive<any>({balances: {BTC: 1, ETH: 10}})
        const ent: any[] = []
        onChange(p.balances, (k, v) => ent.push([k, v]))
        delete p.balances.ETH
        assert(J(ent) == '[["ETH",null]]', 'delete emits (value undefined->null in JSON): ' + J(ent))
        assert(J(Object.keys(p.balances)) == '["BTC"]', 'ownKeys reflects deletion: ' + J(Object.keys(p.balances)))
        assert(('BTC' in p.balances) && !('ETH' in p.balances), 'has-trap reflects membership')
        const snap = snapshot(p, 'balances')
        assert(J(snap) == J({BTC: 1}), 'snapshot returns plain detached copy: ' + J(snap))
    }

    console.log('\n[native] setIn auto-vivifies intermediate containers')
    {
        const p = createReactive<any>({})
        const seen: any[] = []
        onValue(p, ['account', 'positions', 'BTC', 'qty'], v => seen.push(v))
        setIn(p, ['account', 'positions', 'BTC', 'qty'], 0.7)
        assert(J(seen) == '[0.7]', 'deep setIn created the path and fired: ' + J(seen))
        assert(p.account.positions.BTC.qty == 0.7, 'deep read through created path: ' + p.account.positions.BTC.qty)
    }

    console.log('\n[native] listen* are RPC-ready (funcListenCallbackBase shape)')
    {
        const p = createReactive<any>({price: 0, balances: {BTC: 1}})
        assert(isListenCallback(listenValue(p, 'price')), 'listenValue(p,"price") field stream passes isListenCallback')
        assert(isListenCallback(listen(p, 'balances')), 'listen(p,"balances") collection stream passes isListenCallback')
        assert(isListenCallback(listenDeep(p)), 'listenDeep(p) passes isListenCallback')
    }

    console.log('\n[native] arrays are leaf-replaced wholesale (documented)')
    {
        const p = createReactive<any>({xs: [1, 2, 3]})
        const seen: any[] = []
        onKey(p, 'xs', v => seen.push(v))
        p.xs = [1, 2, 3, 4]
        assert(J(seen) == '[[1,2,3,4]]', 'array replace emits the whole array: ' + J(seen))
        assert(J(p.xs) == '[1,2,3,4]', 'array reads back: ' + J(p.xs))
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    process.exit(fails == 0 ? 0 : 1)
}
