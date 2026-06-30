// ============================================================
//  observable2/reactive2.ts — lazy reactive object: FACTS, not deltas
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
//  Knobs (all optional):
//   • drain: 'immediate' (setImmediate, DEFAULT — batches an I/O turn)
//          | 'micro' (queueMicrotask) | number (setTimeout throttle)
//          | (flush)=>void (bring your own scheduler)
//   • depth: wrap only this deep (deeper = opaque leaf). default ∞
//   • eager: true → full reactivity (pre-wrap the whole tree up front);
//            default lazy (wrap a branch on first access)
// ============================================================

import {funcListenCallbackBase} from "../events/Listen";

type Fn = () => void
type Drain = 'micro' | 'immediate' | number | ((flush: Fn) => void)
export type Opts = {drain?: Drain; depth?: number; eager?: boolean}

const NODE = Symbol('reactive2.node')
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
    level: number
    subs: Set<Fn>
    kids: Map<PropertyKey, Node>
    proxy: any
    eng: Eng
}
type Eng = {
    live: number                 // total subscribers in the tree (cheap-cold gate)
    dirty: Set<Node>
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
        live: 0, dirty: new Set(), scheduled: false, waiters: new Set(), depth,
        schedule() {
            if (eng.scheduled) return
            eng.scheduled = true
            // drain deferred: a callback that mutates re-queues for the NEXT
            // drain (we snapshot the batch first), so cascades never loop sync.
            fire(function flush() {
                eng.scheduled = false
                const batch = [...eng.dirty]; eng.dirty.clear()
                let err: any
                for (const n of batch) for (const cb of [...n.subs]) {
                    try { cb() }
                    catch (e) { err ??= e }
                }
                if (!eng.scheduled && eng.dirty.size == 0) {
                    const waiters = [...eng.waiters]; eng.waiters.clear()
                    for (const w of waiters) w()
                }
                if (err !== undefined) setTimeout(() => { throw err }, 0)
            })
        },
    }
    const rootNode = makeNode(root, null, 0, eng)
    if (eager) prewalk(rootNode)
    return rootNode.proxy as T
}

function makeNode(target: any, parent: Node | null, level: number, eng: Eng): Node {
    const node: Node = {target, parent, level, subs: new Set(), kids: new Map(), proxy: null, eng}
    // proxy target is a dummy {}; every trap reads/writes node.target (the CURRENT
    // value) so the proxy survives node.target being rebound on a wholesale replace.
    node.proxy = new Proxy({} as any, {
        get(_, k) {
            if (k == NODE) return node
            const v = node.target[k]
            if (isReactiveObj(v) && level < eng.depth) {
                let kid = node.kids.get(k)
                if (!kid) { kid = makeNode(v, node, level + 1, eng); node.kids.set(k, kid) }
                else if (kid.target !== v) kid.target = v
                return kid.proxy
            }
            return v
        },
        set(_, k, v) {
            if (Object.is(node.target[k], v)) return true
            node.target[k] = v
            const kid = node.kids.get(k)
            if (kid) rebind(kid, v)                  // an existing child slot got a whole new value
            if (eng.live > 0) bubble(node)
            return true
        },
        deleteProperty(_, k) {
            if (!(k in node.target)) return true
            delete node.target[k]
            const kid = node.kids.get(k)
            if (kid) { node.kids.delete(k); markChanged(kid) }
            if (eng.live > 0) bubble(node)
            return true
        },
        has(_, k) { return k in node.target },
        ownKeys() { return Reflect.ownKeys(node.target) },
        getOwnPropertyDescriptor(_, k) {
            const d = Reflect.getOwnPropertyDescriptor(node.target, k)
            if (d) d.configurable = true              // proxy invariant vs the empty dummy target
            return d
        },
    })
    return node
}

// the fact bubbles UP: this node + every ancestor that has subscribers fires once
function bubble(from: Node) {
    const eng = from.eng
    for (let n: Node | null = from; n; n = n.parent) if (n.subs.size) eng.dirty.add(n)
    eng.schedule()
}

// a slot was replaced wholesale: KEEP node identity (subscribers survive), point it
// at the new value, and propagate the fact down to existing descendant watchers.
function rebind(node: Node, next: any) {
    node.target = next
    if (node.subs.size) node.eng.dirty.add(node)
    for (const [k, kid] of [...node.kids]) {
        const cv = isReactiveObj(next) ? next[k] : undefined
        if (isReactiveObj(cv)) rebind(kid, cv)
        else { node.kids.delete(k); markChanged(kid) }   // child is gone / no longer a branch
    }
}
function markChanged(node: Node) {
    if (node.subs.size) node.eng.dirty.add(node)
    for (const kid of node.kids.values()) markChanged(kid)
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

export function onUpdate(p: any, cb: Fn) {
    const node: Node | undefined = p && p[NODE]
    if (!node) throw new Error('onUpdate: not a reactive object')
    node.subs.add(cb)
    node.eng.live++
    let done = false
    return () => { if (done) return; done = true; node.subs.delete(cb); node.eng.live-- }
}

export function flushReactive(p: any) {
    const node: Node | undefined = p && p[NODE]
    if (!node) throw new Error('flushReactive: not a reactive object')
    const eng = node.eng
    if (!eng.scheduled && eng.dirty.size == 0) return Promise.resolve()
    return new Promise<void>(resolve => { eng.waiters.add(resolve) })
}

export function listenUpdate(p: any) {
    const listen = funcListenCallbackBase<[]>((emit) => onUpdate(p, () => emit()))
    listen.run()
    return listen
}

export type Reactive<T extends object> = T

// Tests live in reactive2.test.ts · practical examples in usage.ts
