import {funcListenCallbackBase} from "../events/Listen";
import {listenUpdate, onUpdate, reactive, isReactive} from "./reactive2";

export type StorePath = readonly PropertyKey[]
export type StoreDrain = "micro" | "immediate" | number | ((flush: () => void) => void)

export type StoreSubOpts = {
    current?: boolean
    drain?: StoreDrain
    key?: string
}

export type StoreCtx<T = any> = {
    store: Store<any>
    node: StoreNode<T>
    path: PropertyKey[]
    pathString: string
    exists: boolean
}

export type StoreMask<T> = true | (NonNullable<T> extends object ? {
    [K in keyof NonNullable<T>]?: StoreMask<NonNullable<T>[K]>
} : true)

export type StorePick<T, M> = M extends true
    ? T
    : NonNullable<T> extends object
        ? M extends object
            ? { [K in keyof M & keyof NonNullable<T>]: StorePick<NonNullable<T>[K], NonNullable<M[K]>> }
            : T
        : T

export type StoreNode<T> = StoreNodeApi<T> & (NonNullable<T> extends object ? {
    readonly [K in keyof NonNullable<T>]-?: StoreNode<NonNullable<T>[K]>
} : {})

export type StoreNodeApi<T> = {
    readonly path: PropertyKey[]
    readonly pathString: string
    get(): T
    has(): boolean
    snapshot(): T
    set(value: T): void
    replace(value: T): void
    on(cb: (value: T, ctx: StoreCtx<T>) => void, opts?: StoreSubOpts): () => void
    once(cb: (value: T, ctx: StoreCtx<T>) => void, opts?: StoreSubOpts): () => void
    update<M extends StoreMask<T>>(mask: M, opts?: StoreSubOpts): StoreSelection<T, M>
    at<K extends PropertyKey>(key: K): StoreNode<any>
    count(): number
}

export type StoreSelection<T, M> = {
    readonly mask: M
    readonly paths: PropertyKey[][]
    get(): StorePick<T, M>
    on(cb: (value: StorePick<T, M>, ctx: StoreSelectionCtx<T, M>) => void, opts?: StoreSubOpts): () => void
    once(cb: (value: StorePick<T, M>, ctx: StoreSelectionCtx<T, M>) => void, opts?: StoreSubOpts): () => void
    onEach(cb: (value: any, ctx: StoreCtx<any>) => void, opts?: StoreSubOpts): () => void
}

export type StoreSelectionCtx<T, M> = {
    store: Store<any>
    node: StoreNode<T>
    mask: M
    paths: PropertyKey[][]
}

export type Store<T extends object> = {
    readonly state: T
    readonly node: StoreNode<T>
    get(): T
    snapshot(): T
    replace(value: T): void
    on(cb: (value: T, ctx: StoreCtx<T>) => void, opts?: StoreSubOpts): () => void
    once(cb: (value: T, ctx: StoreCtx<T>) => void, opts?: StoreSubOpts): () => void
    update<M extends StoreMask<T>>(mask: M, opts?: StoreSubOpts): StoreSelection<T, M>
    listen(): ReturnType<typeof listenUpdate>
    count(): number
}

type StoreInternal<T extends object> = Store<T> & {
    _state: T
    _nodeCache: Map<string, any>
    _counts: Map<string, number>
}

type RemoteStore<T extends object> = {
    get(mask?: any): T | Promise<T>
    changed: any
}

const hasSetImmediate = typeof setImmediate == "function"

function pathKey(path: StorePath) {
    return path.map(String).join(".")
}

function schedule(drain: StoreDrain | undefined, flush: () => void) {
    if (drain == null) { flush(); return }
    if (drain == "micro") { queueMicrotask(flush); return }
    if (drain == "immediate") { (hasSetImmediate ? setImmediate : setTimeout)(flush as any, 0); return }
    if (typeof drain == "number") { setTimeout(flush, drain); return }
    drain(flush)
}

function createDrained<A extends any[]>(fn: (...a: A) => void, drain?: StoreDrain) {
    let scheduled = false
    let latest: A | null = null
    let closed = false
    return {
        push(...a: A) {
            if (closed) return
            if (drain == null) { fn(...a); return }
            latest = a
            if (scheduled) return
            scheduled = true
            schedule(drain, () => {
                scheduled = false
                const x = latest
                latest = null
                if (!closed && x) fn(...x)
            })
        },
        close() { closed = true; latest = null },
    }
}

function isObj(v: any): v is object {
    return v != null && typeof v == "object"
}

function getAt(root: any, path: StorePath): any {
    let cur = root
    for (const k of path) {
        if (!isObj(cur)) return undefined
        cur = (cur as any)[k as any]
    }
    return cur
}

function hasAt(root: any, path: StorePath): boolean {
    let cur = root
    for (const k of path) {
        if (!isObj(cur) || !(k in cur)) return false
        cur = (cur as any)[k as any]
    }
    return true
}

function ensureParent(root: any, path: StorePath) {
    let cur = root
    for (let i = 0; i < path.length - 1; i++) {
        const k = path[i]
        if (!isObj((cur as any)[k as any])) (cur as any)[k as any] = {}
        cur = (cur as any)[k as any]
    }
    return cur
}

function replaceRoot(root: any, value: any) {
    for (const k of Reflect.ownKeys(root)) if (!isObj(value) || !(k in value)) delete root[k as any]
    if (isObj(value)) for (const k of Reflect.ownKeys(value)) (root as any)[k as any] = (value as any)[k as any]
}

function setAt(root: any, path: StorePath, value: any) {
    if (path.length == 0) { replaceRoot(root, value); return }
    const p = ensureParent(root, path)
    p[path[path.length - 1] as any] = value
}

function snapshotValue<T>(value: T, seen = new WeakMap<object, any>()): T {
    if (!isObj(value)) return value
    if (value instanceof Date) return new Date(value.valueOf()) as T
    if (value instanceof RegExp) return new RegExp(value.source, value.flags) as T
    if (value instanceof Map) {
        const out = new Map<any, any>()
        seen.set(value, out)
        value.forEach((v, k) => out.set(snapshotValue(k, seen), snapshotValue(v, seen)))
        return out as T
    }
    if (value instanceof Set) {
        const out = new Set<any>()
        seen.set(value, out)
        value.forEach(v => out.add(snapshotValue(v, seen)))
        return out as T
    }
    const old = seen.get(value)
    if (old) return old
    const out: any = Array.isArray(value) ? [] : {}
    seen.set(value, out)
    for (const k of Reflect.ownKeys(value)) out[k as any] = snapshotValue((value as any)[k as any], seen)
    return out
}

function maskPaths(mask: any, base: PropertyKey[] = []): PropertyKey[][] {
    if (mask === true || mask == null) return [base]
    if (!isObj(mask)) return [base]
    const out: PropertyKey[][] = []
    for (const k of Object.keys(mask)) out.push(...maskPaths((mask as any)[k], [...base, k]))
    return out
}

function pickSnapshot(root: any, mask: any, base: PropertyKey[] = []): any {
    if (mask === true || mask == null) return snapshotValue(getAt(root, base))
    const out: any = {}
    for (const k of Object.keys(mask)) out[k] = pickSnapshot(root, (mask as any)[k], [...base, k])
    return out
}

function applyMask(root: any, mask: any, data: any, base: PropertyKey[] = []) {
    if (mask === true || mask == null) { setAt(root, base, snapshotValue(data)); return }
    for (const k of Object.keys(mask)) applyMask(root, (mask as any)[k], (data as any)?.[k], [...base, k])
}

function watchTarget(root: any, path: StorePath) {
    let cur = root
    let lastReactive = root
    for (const k of path) {
        if (!isObj(cur) || !(k in cur)) return lastReactive
        const next = (cur as any)[k as any]
        if (isReactive(next)) { cur = next; lastReactive = next }
        else return lastReactive
    }
    return lastReactive
}

function sameLeaf(a: any, b: any, ae: boolean, be: boolean) {
    if (ae !== be) return false
    if (!ae && !be) return true
    return Object.is(a, b)
}

function makeCtx<T>(store: StoreInternal<any>, path: PropertyKey[]): StoreCtx<T> {
    return {
        store,
        node: getNode<T>(store, path),
        path: [...path],
        pathString: pathKey(path),
        exists: hasAt(store._state, path),
    }
}

function incCount(store: StoreInternal<any>, path: StorePath) {
    const k = pathKey(path)
    store._counts.set(k, (store._counts.get(k) ?? 0) + 1)
}

function decCount(store: StoreInternal<any>, path: StorePath) {
    const k = pathKey(path)
    const n = (store._counts.get(k) ?? 0) - 1
    if (n > 0) store._counts.set(k, n)
    else store._counts.delete(k)
}

function subscribePath<T>(store: StoreInternal<any>, path: PropertyKey[], cb: (value: T, ctx: StoreCtx<T>) => void, opts: StoreSubOpts = {}, once = false) {
    let done = false
    let offUpdate: (() => void) | null = null
    let lastExists = hasAt(store._state, path)
    let lastValue = getAt(store._state, path)
    const drained = createDrained((value: T, ctx: StoreCtx<T>) => {
        if (done) return
        cb(value, ctx)
        if (once) off()
    }, opts.drain)

    function emitNow() {
        drained.push(getAt(store._state, path), makeCtx<T>(store, path))
    }

    function attach() {
        offUpdate?.()
        const target = watchTarget(store._state, path)
        offUpdate = onUpdate(target, () => {
            const exists = hasAt(store._state, path)
            const value = getAt(store._state, path)
            const valueIsObject = isReactive(value)
            const watchedSelf = target === value
            if (!valueIsObject && !watchedSelf && sameLeaf(lastValue, value, lastExists, exists)) return
            lastExists = exists
            lastValue = value
            const nextTarget = watchTarget(store._state, path)
            if (nextTarget !== target && !done) attach()
            emitNow()
        })
    }

    function off() {
        if (done) return
        done = true
        drained.close()
        offUpdate?.()
        offUpdate = null
        decCount(store, path)
    }

    incCount(store, path)
    if (opts.current && lastExists) {
        cb(lastValue, makeCtx<T>(store, path))
        if (once) { off(); return off }
    }
    attach()
    return off
}

function getNode<T>(store: StoreInternal<any>, path: PropertyKey[]): StoreNode<T> {
    const k = pathKey(path)
    const cached = store._nodeCache.get(k)
    if (cached) return cached

    const api: StoreNodeApi<T> = {
        get path() { return [...path] },
        get pathString() { return pathKey(path) },
        get: () => getAt(store._state, path),
        has: () => hasAt(store._state, path),
        snapshot: () => snapshotValue(getAt(store._state, path)),
        set: (value: T) => setAt(store._state, path, value),
        replace: (value: T) => setAt(store._state, path, value),
        on: (cb, opts) => subscribePath<T>(store, path, cb, opts, false),
        once: (cb, opts) => subscribePath<T>(store, path, cb, opts, true),
        update: (mask: any, opts?: StoreSubOpts) => createSelection(store, path, mask, opts),
        at: (key: PropertyKey) => getNode<any>(store, [...path, key]),
        count: () => store._counts.get(pathKey(path)) ?? 0,
    }

    const proxy = new Proxy(api as any, {
        get(target, p) {
            if (p === "then") return undefined
            if (p in target) return target[p]
            if (typeof p == "symbol") return undefined
            return getNode<any>(store, [...path, p])
        },
        ownKeys() {
            const v = getAt(store._state, path)
            return isObj(v) ? Reflect.ownKeys(v) : []
        },
        getOwnPropertyDescriptor() { return {enumerable: true, configurable: true} },
    })
    store._nodeCache.set(k, proxy)
    return proxy as StoreNode<T>
}

function createSelection<T, M>(store: StoreInternal<any>, base: PropertyKey[], mask: M, defaults: StoreSubOpts = {}): StoreSelection<T, M> {
    const fullPaths = maskPaths(mask, base)
    const rootNode = getNode<T>(store, base)
    const ctx = (): StoreSelectionCtx<T, M> => ({store, node: rootNode, mask, paths: fullPaths.map(p => [...p])})
    const get = () => pickSnapshot(store._state, mask, base) as StorePick<T, M>

    return {
        mask,
        paths: fullPaths.map(p => [...p]),
        get,
        on(cb, opts = {}) {
            const o = {...defaults, ...opts, current: false}
            const drained = createDrained(() => cb(get(), ctx()), opts.drain ?? defaults.drain ?? "micro")
            const offs = fullPaths.map(p => subscribePath<any>(store, p, () => drained.push(), o, false))
            if ((opts.current ?? defaults.current)) cb(get(), ctx())
            return () => { drained.close(); for (const off of offs) off() }
        },
        once(cb, opts = {}) {
            let off = () => {}
            off = this.on((v, c) => { off(); cb(v, c) }, {...opts, current: opts.current ?? defaults.current})
            return off
        },
        onEach(cb, opts = {}) {
            const o = {...defaults, ...opts}
            const offs = fullPaths.map(p => subscribePath<any>(store, p, cb, o, false))
            return () => { for (const off of offs) off() }
        },
    }
}

export function createStore<T extends object>(initial: T, opts: Parameters<typeof reactive<T>>[1] = {}): Store<T> {
    const state = reactive(initial, opts)
    let store: StoreInternal<T>
    store = {
        _state: state,
        _nodeCache: new Map<string, any>(),
        _counts: new Map<string, number>(),
        state,
        get node(): StoreNode<T> { return getNode<T>(store, []) },
        get: () => state,
        snapshot: () => snapshotValue(state),
        replace: (value: T) => replaceRoot(state, value),
        on: (cb, opts) => getNode<T>(store, []).on(cb, opts),
        once: (cb, opts) => getNode<T>(store, []).once(cb, opts),
        update: (mask, opts) => createSelection<T, any>(store, [], mask, opts),
        listen: () => listenUpdate(state),
        count: () => Array.from(store._counts.values()).reduce((a: number, b: number) => a + b, 0),
    }
    return store
}

export function exposeStore<T extends object>(store: Store<T>) {
    return {
        get: (mask?: StoreMask<T>) => mask ? store.update(mask as any).get() : store.snapshot(),
        set: (path: StorePath, value: any) => {
            let node: StoreNode<any> = store.node
            for (const k of path) node = node.at(k)
            node.replace(value)
        },
        replace: (path: StorePath, value: any) => {
            let node: StoreNode<any> = store.node
            for (const k of path) node = node.at(k)
            node.replace(value)
        },
        changed: store.listen(),
    }
}

export function createStoreMirror<T extends object>(remote: RemoteStore<T>, initial = {} as T, opts: Parameters<typeof createStore<T>>[1] = {}) {
    const store = createStore<T>(initial, opts)
    async function sync<M extends StoreMask<T>>(mask: M, subOpts: StoreSubOpts = {current: true}) {
        async function pull() {
            const snap = await remote.get(mask)
            applyMask(store.state, mask, snap)
        }
        if (subOpts.current !== false) await pull()
        const drained = createDrained(() => { void pull() }, subOpts.drain)
        const changed = remote.changed
        const off = typeof changed?.on == "function"
            ? changed.on(() => drained.push())
            : typeof changed?.addListen == "function"
                ? changed.addListen(() => drained.push())
                : (() => {})
        return () => { drained.close(); off?.() }
    }
    return Object.assign(store, {sync})
}