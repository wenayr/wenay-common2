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

type Fn = () => void
export type ReactiveChange = {paths: PropertyKey[][]}
type PathUpdateFn = (change: ReactiveChange) => void
type Drain = 'micro' | 'immediate' | number | ((flush: Fn) => void)
export type Opts = {drain?: Drain; depth?: number; eager?: boolean}

const NODE = Symbol('reactive.node')
const isObj = (v: any) => v != null && typeof v == 'object'
const isReactiveObj = (v: any) => {
    if (!isObj(v)) return false
    if (Array.isArray(v)) return true
    const p = Object.getPrototypeOf(v)
    return p == Object.prototype || p == null
}

// the only place the deferral primitive is chosen — pluggable on purpose
const hasSetImmediate = typeof setImmediate == 'function'
function scheduler(drain: Drain): (f: Fn) => void {
    if (drain == 'micro') return f => queueMicrotask(f)
    if (typeof drain == 'number') return f => { setTimeout(f, drain) }
    if (typeof drain == 'function') return f => drain(f)
    return hasSetImmediate ? f => { setImmediate(f) } : f => { setTimeout(f, 0) }   // 'immediate'
}

type Node = {
    target: any
    parent: Node | null
    path: PropertyKey[]
    active: boolean
    level: number
    subs: Set<Fn>
    pathSubs: Set<PathUpdateFn>
    kids: Map<PropertyKey, Node>
    proxy: any
    eng: Eng
}
type Eng = {
    live: number                 // total subscribers in the tree (cheap-cold gate)
    pathLive: number
    dirty: Set<Node>
    dirtyPaths: PropertyKey[][]
    dirtyPathKeys: Set<string>   // keyed dedup за O(1) на путь — линейный скан по dirtyPaths квадратичен на hot-write
    pathKey: (path: PropertyKey[]) => string
    scheduled: boolean
    waiters: Set<Fn>
    depth: number
    schedule: () => void
}

// ============================================================
//  engine
// ============================================================

export function reactive<T extends object>(root: T, opts: Opts = {}) {
    const {drain = 'immediate', depth = Infinity, eager = false} = opts
    const fire = scheduler(drain)
    const eng: Eng = {
        live: 0, pathLive: 0, dirty: new Set(), dirtyPaths: [],
        dirtyPathKeys: new Set(), pathKey: createPathKeyer(),
        scheduled: false, waiters: new Set(), depth,
        schedule() {
            if (eng.scheduled) return
            eng.scheduled = true
            // drain deferred: a callback that mutates re-queues for the NEXT
            // drain (we snapshot the batch first), so cascades never loop sync.
            fire(function flush() {
                eng.scheduled = false
                const batch = [...eng.dirty]; eng.dirty.clear()
                const dirtyPaths = eng.dirtyPaths; eng.dirtyPaths = []
                // свежий keyer на окно: карта symbol-идентичности не копит чужие символы
                eng.dirtyPathKeys = new Set(); eng.pathKey = createPathKeyer()
                let err: any
                for (const n of batch) {
                    for (const cb of [...n.subs]) {
                        try { cb() }
                        catch (e) { err ??= e }
                    }
                    if (n.pathSubs.size) {
                        const paths = pathsForNode(n, dirtyPaths)
                        if (paths.length) for (const cb of [...n.pathSubs]) {
                            try { cb({paths}) }
                            catch (e) { err ??= e }
                        }
                    }
                }
                if (!eng.scheduled && eng.dirty.size == 0 && eng.dirtyPaths.length == 0) {
                    const waiters = [...eng.waiters]; eng.waiters.clear()
                    for (const w of waiters) w()
                }
                if (err !== undefined) setTimeout(() => { throw err }, 0)
            })
        },
    }
    const rootNode = makeNode(root, null, [], 0, eng)
    if (eager) prewalk(rootNode)
    return rootNode.proxy as T
}

function makeNode(target: any, parent: Node | null, path: PropertyKey[], level: number, eng: Eng): Node {
    const node: Node = {
        target, parent, path, active: true, level,
        subs: new Set(), pathSubs: new Set(), kids: new Map(), proxy: null, eng,
    }
    // proxy target is a dummy with the right broad shape. Every trap reads/writes
    // node.target (the CURRENT value), so the proxy survives wholesale replace.
    const proxyTarget = (Array.isArray(target) ? [] : {}) as any
    node.proxy = new Proxy(proxyTarget, {
        get(_, k) {
            if (k == NODE) return node
            if (k == 'toJSON' && Array.isArray(proxyTarget) && !Array.isArray(node.target) && node.target?.toJSON === undefined)
                return () => node.target
            const v = node.target[k]
            if (isReactiveObj(v) && level < eng.depth) {
                let kid = node.kids.get(k)
                if (!kid) { kid = makeNode(v, node, [...node.path, k], level + 1, eng); node.kids.set(k, kid) }
                else if (kid.target !== v) kid.target = v
                return kid.proxy
            }
            return v
        },
        set(_, k, v) {
            v = toRaw(v)                             // no reactive-in-reactive: state holds raw values only
            if (Object.is(node.target[k], v)) return true
            node.target[k] = v
            if (Array.isArray(proxyTarget) && k == "length") proxyTarget.length = v
            const kid = node.kids.get(k)
            if (kid) rebind(kid, v)                  // an existing child slot got a whole new value
            if (eng.live > 0) bubble(node, k)        // путь считается ВНУТРИ и только при pathLive — cold write не аллоцирует
            return true
        },
        defineProperty(_, k, d) {
            const old = node.target[k]
            const desc = 'value' in d ? {...d, value: toRaw(d.value)} : d
            const ok = Reflect.defineProperty(node.target, k, desc)
            if (!ok) return false
            if (desc.configurable === false) {
                const mirror = Reflect.defineProperty(proxyTarget, k, desc)
                if (!mirror) return false
            }
            const v = node.target[k]
            if (!Object.is(old, v)) {
                const kid = node.kids.get(k)
                if (kid) {
                    if (isReactiveObj(v)) rebind(kid, v)
                    else { node.kids.delete(k); markChanged(kid); detachTree(kid) }
                }
                if (eng.live > 0) bubble(node, k)
            }
            return true
        },
        deleteProperty(_, k) {
            if (!(k in node.target)) return true
            delete node.target[k]
            const kid = node.kids.get(k)
            if (kid) { node.kids.delete(k); markChanged(kid); detachTree(kid) }
            if (eng.live > 0) bubble(node, k)
            return true
        },
        has(_, k) { return k in node.target },
        ownKeys() {
            const keys = Reflect.ownKeys(node.target)
            for (const k of Reflect.ownKeys(proxyTarget)) {
                const d = Reflect.getOwnPropertyDescriptor(proxyTarget, k)
                if (d?.configurable === false && !keys.includes(k)) keys.push(k)
            }
            return keys
        },
        getOwnPropertyDescriptor(_, k) {
            if (Array.isArray(proxyTarget) && k == "length")
                return Reflect.getOwnPropertyDescriptor(proxyTarget, k)
            const pd = Reflect.getOwnPropertyDescriptor(proxyTarget, k)
            if (pd && pd.configurable === false) return pd
            const d = Reflect.getOwnPropertyDescriptor(node.target, k)
            if (d) d.configurable = true              // proxy invariant vs the empty dummy target
            return d
        },
    })
    return node
}

// the fact bubbles UP: this node + every ancestor that has subscribers fires once.
// Полный путь материализуется только когда его кто-то потребит (pathLive > 0).
function bubble(from: Node, key: PropertyKey) {
    const eng = from.eng
    if (eng.pathLive > 0) addDirtyPath(eng, dirtyPathFor(from, key))
    for (let n: Node | null = from; n && n.active; n = n.parent)
        if (n.subs.size || n.pathSubs.size) eng.dirty.add(n)
    eng.schedule()
}

// a slot was replaced wholesale: KEEP node identity (subscribers survive), point it
// at the new value, and propagate the fact down to existing descendant watchers.
function rebind(node: Node, next: any) {
    node.target = next
    if (node.subs.size || node.pathSubs.size) node.eng.dirty.add(node)
    for (const [k, kid] of [...node.kids]) {
        const cv = isReactiveObj(next) ? next[k] : undefined
        if (isReactiveObj(cv)) rebind(kid, cv)
        else { node.kids.delete(k); markChanged(kid); detachTree(kid) }   // child is gone / no longer a branch
    }
}
function markChanged(node: Node) {
    if (node.subs.size || node.pathSubs.size) node.eng.dirty.add(node)
    for (const kid of node.kids.values()) markChanged(kid)
}

function dirtyPathFor(node: Node, key: PropertyKey) {
    return Array.isArray(node.target) ? [...node.path] : [...node.path, key]
}

// collision-proof строковый ключ пути: length-prefixed сегменты (строка с любым
// содержимым не склеится через границу), символы — по identity через карту keyer'а.
// Keyer живёт одно drain-окно / один вызов, поэтому символы в карте не копятся.
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
    eng.dirtyPaths.push(path)     // path — свежий массив из dirtyPathFor, копия не нужна
}

function startsWithPath(path: PropertyKey[], prefix: PropertyKey[]) {
    return prefix.length <= path.length && prefix.every((k, i) => Object.is(k, path[i]))
}

function pathsForNode(node: Node, dirtyPaths: PropertyKey[][]) {
    const out: PropertyKey[][] = []
    const seen = new Set<string>()
    const pathKey = createPathKeyer()
    for (const path of dirtyPaths) {
        let next: PropertyKey[] | null = null
        if (startsWithPath(path, node.path)) next = path.slice(node.path.length)
        else if (startsWithPath(node.path, path)) next = []
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
    node.parent = null
    for (const kid of node.kids.values()) detachTree(kid)
    node.kids.clear()
}

// eager: pre-wrap the whole tree to depth (full reactivity up front)
function prewalk(node: Node) {
    if (node.level >= node.eng.depth) return
    for (const k of Reflect.ownKeys(node.target)) {
        if (isReactiveObj(node.target[k])) { node.proxy[k]; const kid = node.kids.get(k); if (kid) prewalk(kid) }
    }
}

// ============================================================
//  subscribe — the FACT of update
// ============================================================

export function isReactive(p: any) {
    const node: Node | undefined = p && p[NODE]
    return !!node && node.active
}

// current raw value behind a reactive proxy (the proxy itself if not one).
// Reading/walking the raw value creates NO lazy nodes — use for snapshots.
export function toRaw<T>(p: T): T {
    const node: Node | undefined = p && (p as any)[NODE]
    return node ? node.target : p
}

export function onUpdate(p: any, cb: Fn) {
    const node: Node | undefined = p && p[NODE]
    if (!node) throw new Error('onUpdate: not a reactive object')
    if (!node.active) throw new Error('onUpdate: reactive object is detached')
    const sub = () => cb()
    node.subs.add(sub)
    node.eng.live++
    let done = false
    return () => { if (done) return; done = true; if (node.subs.delete(sub)) node.eng.live-- }
}

export function onUpdatePaths(p: any, cb: PathUpdateFn) {
    const node: Node | undefined = p && p[NODE]
    if (!node) throw new Error('onUpdatePaths: not a reactive object')
    if (!node.active) throw new Error('onUpdatePaths: reactive object is detached')
    const sub = (change: ReactiveChange) => cb(change)
    node.pathSubs.add(sub)
    node.eng.live++
    node.eng.pathLive++
    let done = false
    return () => {
        if (done) return
        done = true
        if (node.pathSubs.delete(sub)) {
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