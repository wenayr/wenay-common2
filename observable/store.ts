// ============================================================
//  store.ts — "transport store": a path-addressed reactive tree
//
//  One uniform model for the whole scenario:
//   • a STORE is a tree of NODES addressed by path;
//   • a leaf node holds a primitive, a branch node holds children
//     (from a Map or a plain object) — arbitrary depth;
//   • EVERY node is a subscription source at three granularities:
//       value(cb)   — this node's own (leaf) value changed
//       entries(cb) — a DIRECT child changed:  (key, value)
//       deep(cb)    — anything below changed:   (path, value)
//   • "user threw in a whole new map" → set() DIFFS against the
//     current state and emits ONLY the per-key deltas (the Binance
//     balances case: a fresh map, but only changed coins fire).
//     Diffing is recursive, so a deep replace only wakes changed leaves.
//   • snapshot() reconstructs a plain value / object / Map back out
//     (Map-vs-object fidelity is preserved per node).
//   • leaves are cells, branches are maps — DIFFERENT engines inside,
//     IDENTICAL facade outside.
//
//  Every node exposes its streams as funcListenCallbackBase via
//  listen*(), so single-element OR group subscriptions ride the
//  existing RPC unchanged. Chunked network sync is staged in
//  STORE-PLAN.md (built on deep() + snapshot()).
//
//  Cheap by construction: each stream is a createLazyListen — a
//  node that nobody observes allocates no Listen Maps.
// ============================================================

import {createLazyListen, registerReactiveNode} from './reactive'
import {Listener} from '../src/Common/events/Listen'

export type tKey = string
export type tPath = tKey[]
type tSubOpts = {current?: boolean}

// store-wide options (all additive; absence = legacy behavior)
//   deepEqual — leaf nodes compare values structurally instead of Object.is,
//               so replacing a big plain-object leaf with a structurally-equal
//               one stays silent. Opt-in (the default Object.is path is cheap).
//   opaque    — a predicate consulted on every set(): if it returns true for a
//               (path,value), that value is stored as an OPAQUE LEAF (no recursion
//               into a branch), replaced wholesale and compared as a leaf.
export type tStoreOpts = {
    deepEqual?: boolean
    opaque?: (path: tPath, value: any) => boolean
}

function isContainer(v: any) {
    if (v instanceof Map) return true
    return v != null && typeof v == 'object' && (v.constructor == Object || v.constructor == undefined)
}
function entriesOf(v: any): [tKey, any][] {
    return v instanceof Map ? [...v].map(([k, x]) => [String(k), x]) : Object.entries(v)
}

// ── deepEqual — small 0-dep structural compare ──────────────
// Handles primitives, arrays, plain objects, Map, Set, Date. Anything else
// (class instances, functions) falls back to reference identity via Object.is.
// Kept out of the default leaf path on purpose — only the deepEqual opt-in calls it.
export function deepEqual(a: any, b: any): boolean {
    if (Object.is(a, b)) return true
    if (a == null || b == null) return false
    if (typeof a != 'object' || typeof b != 'object') return false
    if (a instanceof Date || b instanceof Date)
        return a instanceof Date && b instanceof Date && a.getTime() == b.getTime()
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length != b.length) return false
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
        return true
    }
    if (a instanceof Map || b instanceof Map) {
        if (!(a instanceof Map) || !(b instanceof Map) || a.size != b.size) return false
        for (const [k, v] of a) { if (!b.has(k) || !deepEqual(v, b.get(k))) return false }
        return true
    }
    if (a instanceof Set || b instanceof Set) {
        if (!(a instanceof Set) || !(b instanceof Set) || a.size != b.size) return false
        for (const v of a) if (!b.has(v)) return false
        return true
    }
    // plain objects only — class instances fall through to false (Object.is already failed)
    const ca = a.constructor, cb = b.constructor
    if (!(ca == Object || ca == undefined) || !(cb == Object || cb == undefined)) return false
    const ka = Object.keys(a), kb = Object.keys(b)
    if (ka.length != kb.length) return false
    for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false }
    return true
}

// ── node ────────────────────────────────────────────────────
function makeNode(path: tPath, bubble: (p: tPath, v: any) => void, opts: tStoreOpts = {}) {
    let value: any
    let hasValue = false
    let kind: 'map' | 'object' | null = null
    let deepEqualHere = !!opts.deepEqual          // per-node override of the leaf-compare strategy (D1)
    let revCount = 0                              // monotonic change EPOCH — bumped on ANY subtree change (version dirty-check)
    const children = new Map<tKey, Node>()
    const valueEv = createLazyListen<[any]>()                        // own leaf value (single value → coalesces)
    const levelEv = createLazyListen<[tKey, any]>({coalesce: false}) // direct children: [key,value] deltas → never coalesce
    const deepEv = createLazyListen<[tPath, any]>({coalesce: false}) // anything below: [path,value] deltas → never coalesce

    // bubbleUp is the single funnel for "something below me changed": bump the rev
    // epoch (the cheap STAT a poller can read), then emit the deep delta + propagate.
    function bubbleUp(p: tPath, v: any) { revCount++; deepEv.emit(p, v); bubble(p, v) }

    function child(k: tKey): Node {
        let c = children.get(k)
        if (!c) { c = makeNode([...path, k], bubbleUp, opts); children.set(k, c) }
        return c
    }

    // leaf compare: cheap Object.is by default; structural deepEqual only when this
    // node opted in (D1). The branch is one boolean read, so the default path is untouched.
    function sameLeaf(v: any) {
        if (deepEqualHere) return deepEqual(value, v)
        return Object.is(value, v)
    }

    function setValue(v: any) {
        if (hasValue && sameLeaf(v)) return false
        if (children.size) { children.clear(); kind = null }   // leaf supersedes a former branch
        value = v; hasValue = true
        valueEv.emit(v)
        bubbleUp(path, v)
        return true
    }

    function setChild(k: tKey, v: any) {
        const c = child(k)
        const changed = c.set(v)
        if (changed && levelEv.count()) levelEv.emit(k, isContainer(v) ? c.snapshot() : v)
        return changed
    }

    function deleteChild(k: tKey) {
        const c = children.get(k)
        if (!c) return false
        children.delete(k)
        if (levelEv.count()) levelEv.emit(k, undefined)
        bubbleUp([...path, k], undefined)
        return true
    }

    // diff-replace: keep node identity, emit only what actually changed
    function applyContainer(obj: any) {
        kind = obj instanceof Map ? 'map' : 'object'
        hasValue = false; value = undefined
        const seen = new Set<tKey>()
        let changed = false
        for (const [k, v] of entriesOf(obj)) { seen.add(k); if (setChild(k, v)) changed = true }
        for (const k of [...children.keys()]) if (!seen.has(k)) { if (deleteChild(k)) changed = true }
        return changed
    }

    // opaque (D2): a path the store marked opaque stores the object as a single LEAF —
    // no recursion into a branch — so a replace emits ONE value-change, not per-key deltas,
    // and snapshot() returns the object verbatim. Consulted BEFORE the isContainer split.
    function isOpaqueHere(v: any) { return opts.opaque ? opts.opaque(path, v) : false }

    function set(v: any) {
        if (isOpaqueHere(v)) return setValue(v)
        return isContainer(v) ? applyContainer(v) : setValue(v)
    }

    function snapshot(): any {
        // honor container kind even when EMPTY (a Map emptied by a diff-replace must
        // still snapshot to a Map, not undefined) — fidelity for typed projection + wire
        if (children.size || (kind && !hasValue)) {
            if (kind == 'map') {
                const m = new Map(); for (const [k, c] of children) m.set(k, c.snapshot()); return m
            }
            const o: any = {}; for (const [k, c] of children) o[k] = c.snapshot(); return o
        }
        return hasValue ? value : undefined
    }

    const node = {
        path, child, set, setChild, deleteChild, snapshot,
        has: (k: tKey) => children.has(k),
        keys: () => [...children.keys()],
        size: () => children.size,
        // container kind read/write — the wire layer uses these to carry
        // Map-vs-object fidelity that a flattened [path,value] frame can't.
        // setKind only tags the node; it never touches children or value.
        getKind: () => kind,
        setKind: (k: 'map' | 'object' | null) => { kind = k },
        // D1 per-node opt-in: switch THIS node's leaf compare to structural deepEqual.
        getDeepEqual: () => deepEqualHere,
        setDeepEqual: (on: boolean) => { deepEqualHere = on },
        // monotonic change epoch (version dirty-check) — the cheap STAT for stat-then-hash.
        revCount: () => revCount,
        valueEv, levelEv, deepEv,
    }
    type Node = typeof node
    return node
}
type Node = ReturnType<typeof makeNode>

function resolve(node: Node, p: tPath) { let n = node; for (const k of p) n = n.child(k); return n }
function toPath(p: tKey | tPath): tPath { return Array.isArray(p) ? p : [p] }

// ── public facade over a node (uniform at every depth) ──────
function nodeFacade(node: Node) {
    const self = {
        // ── reads ──
        get: (k?: tKey) => (k == null ? node.snapshot() : node.child(k).snapshot()),
        snapshot: () => node.snapshot(),
        has: node.has,
        keys: node.keys,
        path: node.path,

        // ── writes (owner) ──
        set: (k: tKey, v: any) => node.setChild(k, v),   // RMap-style: set one key
        replace: (v: any) => node.set(v),                // whole-node replace (diffs)
        setIn: (p: tPath, v: any) => resolve(node, p.slice(0, -1)).setChild(p[p.length - 1], v),
        delete: (k: tKey) => node.deleteChild(k),

        // ── container kind (Map vs object) — for wire fidelity ──
        containerKind: () => node.getKind(),
        setContainerKind: (k: 'map' | 'object') => { node.setKind(k) },

        // ── leaf-compare strategy (D1) — opt this node into structural deepEqual ──
        deepEqual: () => node.getDeepEqual(),
        setDeepEqual: (on = true) => { node.setDeepEqual(on) },

        // ── navigation ──
        key: (k: tKey) => nodeFacade(node.child(k)),
        at: (p: tKey | tPath) => nodeFacade(resolve(node, toPath(p))),

        // ── subscribe, by granularity ──
        value: (cb: Listener<[any]>, {current = false}: tSubOpts = {}) => {
            if (current) cb(node.snapshot())
            return node.valueEv.addListen(cb)
        },
        entries: (cb: Listener<[tKey, any]>, {current = false}: tSubOpts = {}) => {
            if (current) for (const k of node.keys()) cb(k, node.child(k).snapshot())
            return node.levelEv.addListen(cb)
        },
        deep: (cb: Listener<[tPath, any]>, {current = false}: tSubOpts = {}) => {
            if (current) emitDeepSnapshot(node, cb)
            return node.deepEv.addListen(cb)
        },

        // ── coarse change epoch (additive) — the stat-then-hash primitive ──
        // rev()   — monotonic int bumped in bubbleUp on ANY subtree change. Poll it
        //           ("one-eye peek"): if it moved since you last looked, go pull+diff.
        // onRev() — a COARSE no-arg trigger riding the EXISTING deep stream with the
        //           [path,value] args DROPPED. Signals only THE FACT of a change; cheap
        //           (one lazy-listen subscriber, allocates nothing until subscribed).
        rev: () => node.revCount(),
        onRev: (cb: () => void) => node.deepEv.addListen(function onRevTrigger() { cb() }),

        // ── RPC: each stream as a real Listen (single element OR group) ──
        listen: () => node.levelEv.raw(),
        listenValue: () => node.valueEv.raw(),
        listenDeep: () => node.deepEv.raw(),
    }
    // every store node (root, key(), at()) is one of OUR reactive nodes
    return registerReactiveNode(self)
}

// flatten current state as [path, value] leaf deltas (for current/replay + chunked sync)
function emitDeepSnapshot(node: Node, cb: (p: tPath, v: any) => void) {
    for (const k of node.keys()) {
        const c = node.child(k)
        if (c.size()) emitDeepSnapshot(c, cb)
        else cb(c.path, c.snapshot())
    }
}

// ── store ───────────────────────────────────────────────────
export function createTransportStore(initial?: Record<string, any> | Map<tKey, any>, opts?: tStoreOpts) {
    const root = makeNode([], () => {}, opts)
    if (initial) root.set(initial)
    return nodeFacade(root)
}
export type TransportStore = ReturnType<typeof createTransportStore>

// flatten helper exposed for the (staged) wire layer — chunk a snapshot into deltas
export function flatten(store: {at: (p: tPath) => any}, path: tPath = []): [tPath, any][] {
    const out: [tPath, any][] = []
    store.at(path).deep((p: tPath, v: any) => out.push([p, v]), {current: true})
    return out
}

// ── runnable demo ───────────────────────────────────────────
if (require.main === module) {
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }
    const J = (v: any) => JSON.stringify(v, (_k, x) => x instanceof Map ? {__map: [...x]} : x)

    // mixed: primitives + maps + nesting
    const store = createTransportStore({
        price: 100,
        balances: new Map([['BTC', 1], ['ETH', 10]]),
        account: {leverage: 5, positions: new Map([['BTC', {qty: 0.5}]])},
    })

    console.log('\n[store] mixed read + snapshot reconstruction')
    assert(store.get('price') == 100, 'primitive read')
    assert(J(store.at('balances').snapshot()) == J(new Map([['BTC', 1], ['ETH', 10]])), 'map snapshot keeps Map type')
    assert(store.at(['account', 'positions', 'BTC', 'qty']).get() == 0.5, 'deep path read')

    console.log('\n[store] granular subscribe')
    const onBTC: any[] = [], onBalances: any[] = [], onAny: any[] = []
    store.at('balances').key('BTC').value(v => onBTC.push(v))           // single element
    store.at('balances').entries((k, v) => onBalances.push([k, v]))     // whole category
    store.deep((p, v) => onAny.push([p.join('.'), v]))                  // anything, anywhere

    console.log('\n[store] the Binance case: throw a WHOLE new balances map → only deltas fire')
    store.set('balances', new Map([['BTC', 1], ['ETH', 11], ['SOL', 3]]))  // BTC same, ETH changed, SOL new
    assert(J(onBTC) == '[]', 'BTC listener silent (unchanged): ' + J(onBTC))
    assert(J(onBalances) == '[["ETH",11],["SOL",3]]', 'only ETH + SOL fired: ' + J(onBalances))

    console.log('\n[store] delete on whole-replace (missing key) + deep stream')
    store.set('balances', new Map([['BTC', 2]]))   // ETH & SOL gone, BTC changed
    assert(onBTC[onBTC.length - 1] == 2, 'BTC now 2: ' + J(onBTC))
    assert(J(onBalances.slice(-3)) == '[["BTC",2],["ETH",null],["SOL",null]]', 'BTC changed, ETH/SOL deleted: ' + J(onBalances.slice(-3)))

    console.log('\n[store] deep mutation routes to the right path')
    store.setIn(['account', 'positions', 'BTC', 'qty'], 0.7)
    assert(onAny.some(([p, v]) => p == 'account.positions.BTC.qty' && v == 0.7), 'deep delta carries full path: ' + J(onAny.slice(-1)))

    console.log('\n[store] reconstruct object from store at any node')
    const recon = store.at('account').snapshot()
    assert(recon.leverage == 5 && recon.positions.get('BTC').qty == 0.7, 'reconstructed nested object: ' + J(recon))

    console.log('\n[store] flatten → chunkable [path,value] deltas (wire sync foundation)')
    const flat = flatten(store)
    assert(flat.length >= 3 && flat.every(([p]) => Array.isArray(p)), `flattened ${flat.length} leaf deltas`)

    // ── D1: opt-in deep value-compare on replace ──
    // A plain-object LEAF (an opaque-marked node, where objects are stored whole) is
    // where leaf-compare matters: by default it compares by ref (Object.is), so a fresh
    // but structurally-equal object still FIRES; deepEqual makes that replace SILENT.
    console.log('\n[store] D1 deepEqual: structurally-equal replace of an object LEAF — FIRES by default, SILENT under deepEqual')
    const opaqueCfg = {opaque: (p: tPath) => p.length == 1 && p[0] == 'cfg'}

    // default (Object.is): a structurally-equal but fresh object leaf still emits
    const plain = createTransportStore({cfg: {a: 1, nested: {b: [2, 3]}}}, opaqueCfg)
    const plainHits: any[] = []
    plain.key('cfg').value(v => plainHits.push(v))
    plain.set('cfg', {a: 1, nested: {b: [2, 3]}})   // structurally equal, but new ref
    assert(plainHits.length == 1, 'default Object.is leaf FIRES on structurally-equal replace: ' + J(plainHits))

    // store-wide deepEqual: same replace stays silent, a real change still fires
    const deqStore = createTransportStore({cfg: {a: 1, nested: {b: [2, 3]}}}, {...opaqueCfg, deepEqual: true})
    const deqHits: any[] = []
    deqStore.key('cfg').value(v => deqHits.push(v))
    deqStore.set('cfg', {a: 1, nested: {b: [2, 3]}})    // structurally equal → no emit
    assert(deqHits.length == 0, 'store-wide deepEqual SILENT on structurally-equal replace: ' + J(deqHits))
    deqStore.set('cfg', {a: 1, nested: {b: [2, 4]}})    // genuinely different → emits
    assert(deqHits.length == 1, 'store-wide deepEqual still FIRES on a real change: ' + J(deqHits))

    // per-node opt-in works without the store-wide flag
    const perNode = createTransportStore({cfg: {a: 1}}, opaqueCfg)
    const pnHits: any[] = []
    perNode.key('cfg').setDeepEqual()
    perNode.key('cfg').value(v => pnHits.push(v))
    perNode.set('cfg', {a: 1})                          // equal → silent under per-node deepEqual
    assert(pnHits.length == 0 && perNode.key('cfg').deepEqual(), 'per-node deepEqual silent + reads back on: ' + J(pnHits))

    // raw deepEqual util sanity
    assert(deepEqual(new Map([['x', 1]]), new Map([['x', 1]])), 'deepEqual Map')
    assert(!deepEqual(new Set([1, 2]), new Set([1, 3])), 'deepEqual Set diff')
    assert(deepEqual(new Date(5), new Date(5)) && !deepEqual(new Date(5), new Date(6)), 'deepEqual Date')

    // ── D2: opaque-leaf objects ──
    console.log('\n[store] D2 opaque: a marked object is one LEAF — one value-change, no per-key deltas; snapshot returns the object')
    const opStore = createTransportStore(undefined, {
        opaque: (path, _v) => path.length == 1 && path[0] == 'blob',
    })
    const opVal: any[] = [], opEntries: any[] = []
    opStore.key('blob').value(v => opVal.push(v))
    opStore.key('blob').entries((k, v) => opEntries.push([k, v]))   // would catch per-key deltas if it recursed
    opStore.set('blob', {x: 1, y: 2})
    opStore.set('blob', {x: 9, y: 2})                                // wholesale replace
    assert(opVal.length == 2, 'opaque leaf emits ONE value-change per replace (not per-key): ' + J(opVal))
    assert(J(opEntries) == '[]', 'opaque leaf fires NO per-key entries deltas: ' + J(opEntries))
    assert(J(opStore.get('blob')) == J({x: 9, y: 2}), 'snapshot returns the opaque object verbatim: ' + J(opStore.get('blob')))
    assert(opStore.key('blob').keys().length == 0, 'opaque leaf is a leaf (no children): ' + opStore.key('blob').keys().length)
    // non-opaque sibling still recurses into a branch
    opStore.set('open', {x: 1, y: 2})
    assert(opStore.key('open').keys().length == 2, 'non-opaque object still recurses to a branch: ' + J(opStore.key('open').keys()))

    // ── batch() must NOT drop delta-stream events (regression) ──
    // deep()/entries() are [path,value]/[key,value] DELTA streams (coalesce:false),
    // so wrapping several distinct writes in a batch must deliver EVERY delta — not
    // just the last one (the per-node-coalesce model is only correct for value cells).
    console.log('\n[store] batch() delivers ALL delta-stream events (no coalesce-drop)')
    {
        const {batch} = require('./batch') as typeof import('./batch')
        const bs = createTransportStore({a: 0, b: 0})
        const deep: any[] = [], ent: any[] = []
        bs.deep((p, v) => deep.push([p.join('.'), v]))
        bs.entries((k, v) => ent.push([k, v]))
        batch(() => { bs.set('a', 1); bs.set('b', 2) })
        assert(J(deep) == J([['a', 1], ['b', 2]]), 'deep got BOTH deltas inside a batch: ' + J(deep))
        assert(J(ent) == J([['a', 1], ['b', 2]]), 'entries got BOTH deltas inside a batch: ' + J(ent))
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    process.exit(fails == 0 ? 0 : 1)
}
