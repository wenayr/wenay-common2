// ============================================================
//  Observe/reactive.ts — lazy reactive object: FACTS, not deltas
//
//  reactive(obj) → a plain-feeling object of ANY nesting depth.
//  Mutate it normally:
//      s.price = 100
//      s.a.b.c = 5
//      s.balances = {7 fresh coins}     // replace a whole sub-tree
//  Subscribe with onUpdate(node, cb) to learn the FACT that something
//  under that node changed — coalesced to ONE call per settled batch,
//  on a CONSISTENT state (never an intermediate one). No (key,value),
//  no add/del/diff, no string paths.
//
//  Why it is correct where the old folder wasn't:
//   • STABLE identity across replacement — a node's proxy reads
//     node.target, which we rebind on a wholesale replace, so a
//     subscriber on `s.balances` keeps firing after `s.balances = {…}`.
//   • CONSISTENT — the producer's coherent change reaches you as one
//     commit; you recompute (e.g. a sum) on a whole, never-torn state.
//   • CHEAP COLD — with zero subscribers, set/delete just write.
//
//  Caveat (by design, see test 9b): a slot keeps its proxy identity even
//  across an array↔object replace, so Array.isArray reflects the ORIGINAL
//  shape; serialization is patched via toJSON. Use toRaw() when the real
//  current value matters.
//
//  Knobs (all optional):
//   • drain: 'immediate' (setImmediate, DEFAULT — batches an I/O turn)
//          | 'micro' (queueMicrotask) | number (setTimeout throttle)
//          | (flush)=>void (bring your own scheduler)
//   • depth: wrap only this deep (deeper = opaque leaf). default ∞
//   • eager: true → full reactivity (pre-wrap the whole tree up front);
//            default lazy (wrap a branch on first access)
// ============================================================

import {createListen} from "../events/Listen";
import {deferImmediate} from '../core/defer-immediate'
import {isReactiveObj, prepareReactiveValue} from './reactive-value'
import {
    REACTIVE_ARRAY_MUTATIONS,
    type ReactiveArrayMutations,
} from './observe-private'

type Fn = () => void
export type ReactiveChange = {paths: PropertyKey[][]}
type PathUpdateFn = (change: ReactiveChange) => void
type Drain = 'micro' | 'immediate' | number | ((flush: Fn) => void)
export type Opts = {drain?: Drain; depth?: number; eager?: boolean}
type InternalOpts = Opts & {_onMutation?: (path: PropertyKey[]) => void}

const NODE = Symbol('reactive.node')

// the only place the deferral primitive is chosen — pluggable on purpose
function scheduler(drain: Drain): (f: Fn) => void {
    if (drain == 'micro') return f => queueMicrotask(f)
    if (typeof drain == 'number') return f => { setTimeout(f, drain) }
    if (typeof drain == 'function') return f => drain(f)
    return deferImmediate
}

type Eng = {
    live: number                 // total subscribers in the tree (cheap-cold gate)
    pathLive: number
    dirty: Set<Node>
    dirtyPaths: PropertyKey[][]
    dirtyPathKeys: Set<string>   // keyed dedup in O(1) per path — linear scan over dirtyPaths is quadratic on hot-write
    pathKey: (path: PropertyKey[]) => string
    arrayMutationPaths: PropertyKey[][]
    arrayMutationPathKeys: Set<string>
    arrayReplacementPaths: PropertyKey[][]
    arrayReplacementPathKeys: Set<string>
    arrayPathKey: (path: PropertyKey[]) => string
    scheduled: boolean
    waiters: Set<Fn>
    depth: number
    onMutation?: (path: PropertyKey[]) => void
    schedule: () => void
    /** The scheduled drain, runnable now (flushReactiveNow): a durable close must not wait a turn. */
    flush: () => void
}

// ============================================================
//  engine
// ============================================================

export function reactive<T extends object>(root: T, opts: Opts = {}) {
    const {drain = 'immediate', depth = Infinity, eager = false} = opts
    // Store installs this private hook only while it holds path-node cache entries.
    // It is intentionally absent from the public reactive options surface.
    const internalOpts = opts as InternalOpts
    const hasMutationHook = '_onMutation' in internalOpts
    const fire = scheduler(drain)
    const eng: Eng = {
        live: 0, pathLive: 0, dirty: new Set(), dirtyPaths: [],
        dirtyPathKeys: new Set(), pathKey: createPathKeyer(),
        arrayMutationPaths: [], arrayMutationPathKeys: new Set(),
        arrayReplacementPaths: [], arrayReplacementPathKeys: new Set(),
        arrayPathKey: createPathKeyer(),
        scheduled: false, waiters: new Set(), depth,
        schedule() {
            if (eng.scheduled) return
            eng.scheduled = true
            // drain deferred: a callback that mutates re-queues for the NEXT
            // drain (we snapshot the batch first), so cascades never loop sync.
            fire(eng.flush)
        },
        flush() {
            {
                // an early flushReactiveNow already drained this window; the deferred fire finds nothing
                if (!eng.scheduled) return
                eng.scheduled = false
                const batch = [...eng.dirty]; eng.dirty.clear()
                const dirtyPaths = eng.dirtyPaths; eng.dirtyPaths = []
                const arrayMutations: ReactiveArrayMutations = {
                    paths: eng.arrayMutationPaths,
                    replacements: eng.arrayReplacementPaths,
                }
                // fresh keyer per window: symbol-identity map does not accumulate foreign symbols
                eng.dirtyPathKeys = new Set(); eng.pathKey = createPathKeyer()
                eng.arrayMutationPaths = []
                eng.arrayMutationPathKeys = new Set()
                eng.arrayReplacementPaths = []
                eng.arrayReplacementPathKeys = new Set()
                eng.arrayPathKey = createPathKeyer()
                let err: any
                for (const n of batch) {
                    if (n.subs) for (const cb of [...n.subs]) {
                        try { cb() }
                        catch (e) { err ??= e }
                    }
                    if (n.pathSubs?.size) {
                        const paths = pathsForNode(n, dirtyPaths)
                        if (paths.length) for (const cb of [...n.pathSubs]) {
                            try {
                                const change = {paths}
                                Object.defineProperty(change, REACTIVE_ARRAY_MUTATIONS, {value: arrayMutations})
                                cb(change)
                            }
                            catch (e) { err ??= e }
                        }
                    }
                }
                if (!eng.scheduled && eng.dirty.size == 0 && eng.dirtyPaths.length == 0) {
                    const waiters = [...eng.waiters]; eng.waiters.clear()
                    for (const w of waiters) w()
                }
                if (err !== undefined) setTimeout(() => { throw err }, 0)
            }
        },
    }
    if (hasMutationHook) {
        let onMutation = internalOpts._onMutation
        Object.defineProperty(internalOpts, '_onMutation', {
            configurable: true,
            get: () => onMutation,
            set: next => { onMutation = next; eng.onMutation = next },
        })
        eng.onMutation = onMutation
    }
    const rootNode = new Node(prepareReactiveValue(root, toRaw), null, undefined, eng)
    if (eager) prewalk(rootNode)
    return rootNode.proxy as T
}

// The proxy target is a dummy with the right broad shape. The object dummy comes from a
// constructor, so V8's slack tracking shrinks it to a bare 3-word object (a `{}` literal keeps
// four spare property slots); its prototype IS Object.prototype, so the proxy's prototype,
// inspect output and error texts stay a plain object's. The array dummy keeps its full length:
// a captured array proxy rebound to an object still reports the length it was made with
// (pinned in oracle/regression/reactive-surface.spec.ts, 'unsynced arr->obj').
function ObjectDummy() {}
ObjectDummy.prototype = Object.prototype
function makeDummy(target: any) {
    return Array.isArray(target) ? new Array(target.length) : new (ObjectDummy as any)()
}

// The node IS its proxy's handler: the traps live once on this prototype and read `this`, so a
// node allocates no handler object and no closures of its own. A class because that prototype
// is the mechanism, not a service surface. No per-node path or level: both derive from `parent`
// and `key` when a consumer needs them (pathTo, levelOf).
class Node {
    target: any
    parent: Node | null
    /** Key under the parent; the root has none. A detached node has no parent link, so it keeps
     *  its whole path here instead, frozen when it was detached (detachTree). */
    key: PropertyKey | PropertyKey[] | undefined
    active = true
    // made on first use: most nodes never get a subscriber or a child
    subs: Set<Fn> | null = null
    pathSubs: Set<PathUpdateFn> | null = null
    kids: Map<PropertyKey, Node> | null = null
    proxy: any
    eng: Eng
    constructor(target: any, parent: Node | null, key: PropertyKey | undefined, eng: Eng) {
        this.target = target
        this.parent = parent
        this.key = key
        this.eng = eng
        // Every trap reads/writes node.target (the CURRENT value), so the proxy survives wholesale replace.
        this.proxy = new Proxy(makeDummy(target), this)
    }

    // traps: `this` is the node, `dummy` the proxy's inert target
    get(dummy: any, k: PropertyKey) {
        if (k == NODE) return this
        if (k == 'toJSON' && Array.isArray(dummy) && !Array.isArray(this.target) && this.target?.toJSON === undefined)
            return () => this.target
        const v = toRaw(this.target[k])
        if (isReactiveObj(v) && (this.eng.depth == Infinity || levelOf(this) < this.eng.depth)) {
            let kid = this.kids?.get(k)
            if (!kid) { kid = new Node(v, this, k, this.eng); (this.kids ??= new Map()).set(k, kid) }
            else if (kid.target !== v) kid.target = v
            return kid.proxy
        }
        return v
    }
    set(dummy: any, k: PropertyKey, v: any) {
        const eng = this.eng
        v = prepareReactiveValue(v, toRaw)        // resolve nested proxies before any slot can move
        const had = Object.prototype.hasOwnProperty.call(this.target, k)
        const old = this.target[k]
        if (had && Object.is(old, v)) return true
        let accepted = true
        if (had) {
            accepted = Reflect.set(this.target, k, v, this.target)
        } else {
            // A Store key is data, even when Object/Array.prototype was polluted
            // with a setter or a non-writable property of the same name.
            if (!Reflect.defineProperty(this.target, k, {
                configurable: true,
                enumerable: true,
                value: v,
                writable: true,
            })) return false
        }
        const next = this.target[k]
        if (!accepted && Object.is(old, next)) return false
        if (Array.isArray(this.target) && k == 'length') {
            syncArrayLength(dummy, this)
            if (next < old) detachTruncatedChildren(this)
        }
        const kid = this.kids?.get(k)
        if (kid) rebind(kid, next)                  // an existing child slot got a whole new value
        eng.onMutation?.(dirtyPathFor(this, k))
        if (eng.live > 0) bubble(this, k, Array.isArray(old) || Array.isArray(v))
        return accepted
    }
    defineProperty(dummy: any, k: PropertyKey, d: PropertyDescriptor) {
        const eng = this.eng
        const had = Object.prototype.hasOwnProperty.call(this.target, k)
        const old = this.target[k]
        const desc = 'value' in d ? {...d, value: prepareReactiveValue(d.value, toRaw)} : d
        const ok = Reflect.defineProperty(this.target, k, desc)
        const v = this.target[k]
        if (!ok && Object.is(old, v)) return false
        if (Array.isArray(this.target) && k == 'length') syncArrayLength(dummy, this)
        else if (desc.configurable === false) {
            const mirror = Reflect.defineProperty(dummy, k, desc)
            if (!mirror) return false
        }
        if (!had || !Object.is(old, v)) {
            if (Array.isArray(this.target) && k == 'length' && v < old) detachTruncatedChildren(this)
            const kid = this.kids?.get(k)
            if (kid) {
                if (isReactiveObj(v)) rebind(kid, v)
                else { this.kids!.delete(k); markChanged(kid); detachTree(kid) }
            }
            eng.onMutation?.(dirtyPathFor(this, k))
            if (eng.live > 0) bubble(this, k, Array.isArray(old) || Array.isArray(v))
        }
        return ok
    }
    deleteProperty(dummy: any, k: PropertyKey) {
        const eng = this.eng
        if (!Object.prototype.hasOwnProperty.call(this.target, k)) return true
        const old = this.target[k]
        if (!Reflect.deleteProperty(this.target, k)) return false
        const kid = this.kids?.get(k)
        if (kid) { this.kids!.delete(k); markChanged(kid); detachTree(kid) }
        eng.onMutation?.(dirtyPathFor(this, k))
        if (eng.live > 0) bubble(this, k, Array.isArray(old))
        return true
    }
    has(dummy: any, k: PropertyKey) { return k in this.target }
    ownKeys(dummy: any) {
        const keys = Reflect.ownKeys(this.target)
        for (const k of Reflect.ownKeys(dummy)) {
            const d = Reflect.getOwnPropertyDescriptor(dummy, k)
            if (d?.configurable === false && !keys.includes(k)) keys.push(k)
        }
        return keys
    }
    getOwnPropertyDescriptor(dummy: any, k: PropertyKey) {
        if (Array.isArray(dummy) && k == "length") {
            syncArrayLength(dummy, this)
            return Reflect.getOwnPropertyDescriptor(dummy, k)
        }
        const pd = Reflect.getOwnPropertyDescriptor(dummy, k)
        if (pd && pd.configurable === false) return pd
        const d = Reflect.getOwnPropertyDescriptor(this.target, k)
        if (d) d.configurable = true              // proxy invariant vs the empty dummy target
        return d
    }
}

// The proxy looks every trap up BY NAME on its handler, the node: a data field named like a
// trap would be taken for one. Rename the field; this fails to compile until then.
type tNodeField = {[K in keyof Node]: Node[K] extends Function ? never : K}[keyof Node]
type tNoTrapNamed<T extends never> = T
type tNodeFieldsAreNotTraps = tNoTrapNamed<Extract<tNodeField, keyof ProxyHandler<object>>>

function syncArrayLength(dummy: any, node: Node) {
    if (!Array.isArray(dummy) || !Array.isArray(node.target)) return
    const descriptor = Reflect.getOwnPropertyDescriptor(node.target, 'length')!
    Reflect.defineProperty(dummy, 'length', descriptor)
}

// Path and level derive from the parent chain; a detached ancestor contributes its frozen path.
// Only a finite depth limit needs the level.
function levelOf(node: Node) {
    let level = 0
    let n = node
    while (n.parent) { level++; n = n.parent }
    if (Array.isArray(n.key)) level += n.key.length
    return level
}

// built only when a consumer takes it (mutation hook, path subscribers), at its exact size
function pathTo(node: Node, extra = 0) {
    let depth = 0
    let n = node
    while (n.parent) { depth++; n = n.parent }
    const frozen = Array.isArray(n.key) ? n.key : null
    const base = frozen ? frozen.length : 0
    const out = new Array<PropertyKey>(base + depth + extra)
    if (frozen) for (let i = 0; i < base; i++) out[i] = frozen[i]
    let at = base + depth
    for (let m = node; m.parent; m = m.parent) out[--at] = m.key as PropertyKey   // attached: a single key
    return out
}
function pathOf(node: Node, key: PropertyKey) {
    const out = pathTo(node, 1)
    out[out.length - 1] = key
    return out
}

// the fact bubbles UP: this node + every ancestor that has subscribers fires once.
// Full path is materialized only when someone consumes it (pathLive > 0).
function bubble(from: Node, key: PropertyKey, replacedArrayBranch = false) {
    const eng = from.eng
    if (eng.pathLive > 0) {
        const dirtyPath = dirtyPathFor(from, key)
        addDirtyPath(eng, dirtyPath)
        if (Array.isArray(from.target)) addArrayPath(eng, pathOf(from, key), false)
        else if (replacedArrayBranch) addArrayPath(eng, dirtyPath, true)
    }
    for (let n: Node | null = from; n && n.active; n = n.parent)
        if (n.subs?.size || n.pathSubs?.size) eng.dirty.add(n)
    eng.schedule()
}

// a slot was replaced wholesale: KEEP node identity (subscribers survive), point it
// at the new value, and propagate the fact down to existing descendant watchers.
function rebind(node: Node, next: any) {
    node.target = next = toRaw(next)
    if (node.subs?.size || node.pathSubs?.size) node.eng.dirty.add(node)
    if (!node.kids) return
    for (const [k, kid] of [...node.kids]) {
        const cv = isReactiveObj(next) ? next[k] : undefined
        if (isReactiveObj(cv)) rebind(kid, cv)
        else { node.kids.delete(k); markChanged(kid); detachTree(kid) }   // child is gone / no longer a branch
    }
}
function markChanged(node: Node) {
    if (node.subs?.size || node.pathSubs?.size) node.eng.dirty.add(node)
    if (node.kids) for (const kid of node.kids.values()) markChanged(kid)
}

function dirtyPathFor(node: Node, key: PropertyKey) {
    return Array.isArray(node.target) ? pathTo(node) : pathOf(node, key)
}

// collision-proof string path key: length-prefixed segments (string with any
// content cannot merge across boundary), symbols — by identity via keyer map.
// Keyer lives one drain window / one call, so symbols do not accumulate in the map.
function createPathKeyer() {
    let symIds: Map<symbol, number> | null = null
    return function pathKey(path: PropertyKey[]) {
        let out = ''
        for (const p of path) {
            if (typeof p == 'symbol') {
                symIds ??= new Map()
                let id = symIds.get(p)
                if (id == null) { id = symIds.size; symIds.set(p, id) }
                out += 'y' + id + '|'
            } else {
                const s = String(p)
                out += (typeof p)[0] + s.length + ':' + s + '|'
            }
        }
        return out
    }
}

function addDirtyPath(eng: Eng, path: PropertyKey[]) {
    const k = eng.pathKey(path)
    if (eng.dirtyPathKeys.has(k)) return
    eng.dirtyPathKeys.add(k)
    eng.dirtyPaths.push(path)     // path is a fresh array from dirtyPathFor, no copy needed
}

function addArrayPath(eng: Eng, path: PropertyKey[], replacement: boolean) {
    const key = eng.arrayPathKey(path)
    const keys = replacement ? eng.arrayReplacementPathKeys : eng.arrayMutationPathKeys
    if (keys.has(key)) return
    keys.add(key)
    const paths = replacement ? eng.arrayReplacementPaths : eng.arrayMutationPaths
    paths.push(path)
}

function startsWithPath(path: PropertyKey[], prefix: PropertyKey[]) {
    return prefix.length <= path.length && prefix.every((k, i) => Object.is(k, path[i]))
}

function pathsForNode(node: Node, dirtyPaths: PropertyKey[][]) {
    const out: PropertyKey[][] = []
    const seen = new Set<string>()
    const pathKey = createPathKeyer()
    const nodePath = pathTo(node)
    for (const path of dirtyPaths) {
        let next: PropertyKey[] | null = null
        if (startsWithPath(path, nodePath)) next = path.slice(nodePath.length)
        else if (startsWithPath(nodePath, path)) next = []
        if (next == null) continue
        const k = pathKey(next)
        if (seen.has(k)) continue
        seen.add(k)
        out.push(next)
    }
    return out
}

function detachTree(node: Node) {
    if (!node.active) return
    node.active = false
    // Freeze the path BEFORE releasing the parent link: pathTo walks parent links, and a detached
    // proxy still reports its writes under its old path (mutation hook, path subscribers). The
    // kids detach after this, so each one resolves its own path through the frozen one.
    node.key = pathTo(node)
    node.parent = null
    if (node.kids) for (const kid of node.kids.values()) detachTree(kid)
    node.kids = null
}

function detachTruncatedChildren(node: Node) {
    if (!node.kids) return
    for (const [key, child] of node.kids) {
        if (Object.prototype.hasOwnProperty.call(node.target, key)) continue
        node.kids.delete(key)
        markChanged(child)
        detachTree(child)
    }
}

// eager: pre-wrap the whole tree to depth (full reactivity up front)
function prewalk(node: Node, ancestors = new WeakSet<object>()) {
    if ((node.eng.depth != Infinity && levelOf(node) >= node.eng.depth) || ancestors.has(node.target)) return
    ancestors.add(node.target)
    for (const k of Reflect.ownKeys(node.target)) {
        if (isReactiveObj(node.target[k])) { node.proxy[k]; const kid = node.kids?.get(k); if (kid) prewalk(kid, ancestors) }
    }
    ancestors.delete(node.target)
}

// ============================================================
//  subscribe — the FACT of update
// ============================================================

// a reactive proxy is always an object: any other value skips the symbol lookup on its prototype
export function isReactive(p: any) {
    const node: Node | undefined = typeof p == 'object' && p != null ? p[NODE] : undefined
    return !!node && node.active
}

// current raw value behind a reactive proxy (the proxy itself if not one).
// Reading/walking the raw value creates NO lazy nodes — use for snapshots.
export function toRaw<T>(p: T): T {
    // every trap read passes its value through here: a leaf must not pay for the lookup
    const node: Node | undefined = typeof p == 'object' && p != null ? (p as any)[NODE] : undefined
    return node ? node.target : p
}

export function onUpdate(p: any, cb: Fn) {
    const node: Node | undefined = p && p[NODE]
    if (!node) throw new Error('onUpdate: not a reactive object')
    if (!node.active) throw new Error('onUpdate: reactive object is detached')
    const sub = () => cb()
    ;(node.subs ??= new Set()).add(sub)
    node.eng.live++
    let done = false
    return () => { if (done) return; done = true; if (node.subs?.delete(sub)) node.eng.live-- }
}

export function onUpdatePaths(p: any, cb: PathUpdateFn) {
    const node: Node | undefined = p && p[NODE]
    if (!node) throw new Error('onUpdatePaths: not a reactive object')
    if (!node.active) throw new Error('onUpdatePaths: reactive object is detached')
    const sub = (change: ReactiveChange) => cb(change)
    ;(node.pathSubs ??= new Set()).add(sub)
    node.eng.live++
    node.eng.pathLive++
    let done = false
    return () => {
        if (done) return
        done = true
        if (node.pathSubs?.delete(sub)) {
            node.eng.live--
            node.eng.pathLive--
        }
    }
}

export function flushReactive(p: any) {
    const node: Node | undefined = p && p[NODE]
    if (!node) throw new Error('flushReactive: not a reactive object')
    const eng = node.eng
    if (!eng.scheduled && eng.dirty.size == 0 && eng.dirtyPaths.length == 0) return Promise.resolve()
    return new Promise<void>(resolve => { eng.waiters.add(resolve) })
}

/**
 * Drain the pending window NOW, synchronously, instead of on the scheduler's next turn.
 * A durable line closing right after an acknowledged write needs its batch in the journal
 * before the process goes away (observe/scale-durable-close.test.ts); ordinary consumers
 * never need this — the deferred drain is what keeps cascades from looping synchronously.
 */
export function flushReactiveNow(p: any) {
    const node: Node | undefined = p && p[NODE]
    if (!node) throw new Error('flushReactiveNow: not a reactive object')
    if (node.eng.scheduled) node.eng.flush()
}

export function listenUpdate(p: any) {
    const listen = createListen<[]>((emit) => onUpdate(p, () => emit()), {
        event: (type, count, api) => {
            if (type == "add" && count == 1 && !api.isRunning()) api.run()
            if (type == "remove" && count == 0 && api.isRunning()) api.close()
        },
    })
    return listen
}

export function listenUpdatePaths(p: any) {
    const listen = createListen<[ReactiveChange]>((emit) => onUpdatePaths(p, change => emit(change)), {
        event: (type, count, api) => {
            if (type == "add" && count == 1 && !api.isRunning()) api.run()
            if (type == "remove" && count == 0 && api.isRunning()) api.close()
        },
    })
    return listen
}

export type Reactive<T extends object> = T

// Tests live in reactive.test.ts · practical examples in usage.ts
