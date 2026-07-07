import {createListen} from "../events/Listen";
import {listenUpdate, listenUpdatePaths, onUpdate, reactive, isReactive, toRaw, ReactiveChange} from "./reactive";

export type StorePath = readonly PropertyKey[]
export type StoreDrain = "micro" | "immediate" | number | ((flush: () => void) => void)

export type StoreSubOpts = {
    current?: boolean
    drain?: StoreDrain
    key?: string
}

export type StoreChange = ReactiveChange
export type StorePatch = {
    path: PropertyKey[]
    value: any
    exists: boolean
}
export type StoreChangedData<M = any> = {
    mask: M
    data: any
}
export type StoreSyncOpts = StoreSubOpts & {
    partial?: boolean
    onError?: (error: any) => void
}
export type StoreExposeOpts = {
    push?: boolean
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
    /** @deprecated alias of replace() */
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

export type StoreEachOpts = {
    /** Reserved: only 1 (top-level keys) is supported today. */
    depth?: number
}
export type StoreEachCtx = {path: PropertyKey[]}

export type Store<T extends object> = {
    readonly state: T
    readonly node: StoreNode<T>
    get(): T
    snapshot(): T
    replace(value: T): void
    on(cb: (value: T, ctx: StoreCtx<T>) => void, opts?: StoreSubOpts): () => void
    once(cb: (value: T, ctx: StoreCtx<T>) => void, opts?: StoreSubOpts): () => void
    update<M extends StoreMask<T>>(mask: M, opts?: StoreSubOpts): StoreSelection<T, M>
    // key типизирован string (не keyof T): keyof в контравариантной позиции Listen
    // сломал бы Store<T> -> Store<any>; symbol-ключи в рантайме проходят как есть
    each(opts?: StoreEachOpts): ReturnType<typeof createListen<[key: string, value: T[keyof T] | undefined, ctx: StoreEachCtx]>>
    listen(): ReturnType<typeof listenUpdate>
    listenPaths(): ReturnType<typeof listenUpdatePaths>
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
    changedPaths?: any
    patches?: any
    changedData?: any
}

export type StoreRemoteApi<T extends object> = {
    get(): T
    get<M extends StoreMask<T>>(mask: M): StorePick<T, M>
    set(path: StorePath, value: any): void
    replace(path: StorePath, value: any): void
    changed: any
    changedPaths: any
    patches?: any
    changedData?: any
}

// ============================================================
//  utilities — scheduling & paths (pure)
// ============================================================

const hasSetImmediate = typeof setImmediate == "function"

// human-readable route ('data.BTC') — the PUBLIC pathString format
function pathText(path: StorePath) {
    return path.map(String).join(".")
}

const symbolIds = new Map<symbol, number>()
let nextSymbolId = 1
function symbolKey(k: symbol) {
    let id = symbolIds.get(k)
    if (id == null) { id = nextSymbolId++; symbolIds.set(k, id) }
    return id
}

// internal cache/count key — collision-free (['a.b'] vs ['a','b'], Symbol('x') vs Symbol('x'))
function pathKey(path: StorePath) {
    return JSON.stringify(path.map(k => typeof k == "symbol" ? ["symbol", symbolKey(k)] : ["key", String(k)]))
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

// ============================================================
//  utilities — snapshot & masks (pure)
//  snapshot/pick always walk RAW targets (toRaw) — reading through
//  the proxy would materialize a lazy node per object visited.
// ============================================================

function snapshotValue<T>(value: T, seen = new WeakMap<object, any>()): T {
    value = toRaw(value)
    if (!isObj(value)) return value
    // cycle check BEFORE the Map/Set branches: a self-containing Map/Set must hit the
    // already-created copy, not recurse forever; shared refs keep one output identity
    const old = seen.get(value)
    if (old) return old
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
    const out: any = Array.isArray(value) ? [] : {}
    seen.set(value, out)
    for (const k of Reflect.ownKeys(value)) out[k as any] = snapshotValue((value as any)[k as any], seen)
    return out
}

function maskPaths(mask: any, base: PropertyKey[] = []): PropertyKey[][] {
    if (mask === true || mask == null) return [base]
    if (!isObj(mask)) return [base]
    const out: PropertyKey[][] = []
    for (const k of Reflect.ownKeys(mask)) out.push(...maskPaths((mask as any)[k as any], [...base, k]))
    return out
}

function pickSnapshot(root: any, mask: any, base: PropertyKey[] = []): any {
    root = toRaw(root)
    if (mask === true || mask == null) return snapshotValue(getAt(root, base))
    const out: any = {}
    for (const k of Reflect.ownKeys(mask)) out[k as any] = pickSnapshot(root, (mask as any)[k as any], [...base, k])
    return out
}

function deleteAt(root: any, path: StorePath) {
    if (path.length == 0) { replaceRoot(root, {}); return }
    const parent = getAt(root, path.slice(0, -1))
    if (isObj(parent)) delete (parent as any)[path[path.length - 1] as any]
}

function applyMask(root: any, mask: any, data: any, base: PropertyKey[] = []) {
    if (mask === true || mask == null) {
        if (data === undefined && base.length) deleteAt(root, base)
        else setAt(root, base, snapshotValue(data))
        return
    }
    for (const k of Reflect.ownKeys(mask)) applyMask(root, (mask as any)[k as any], (data as any)?.[k as any], [...base, k])
}

export function applyStoreMask<T extends object>(store: Store<T>, mask: StoreMask<T> | any, data: any) {
    applyMask(store.state, mask ?? true, data)
}

export function applyStorePatch<T extends object>(store: Store<T>, patch: StorePatch) {
    if (patch.exists === false) deleteAt(store.state, patch.path)
    else setAt(store.state, patch.path, snapshotValue(patch.value))
}

export function applyStorePatches<T extends object>(store: Store<T>, patches: readonly StorePatch[]) {
    for (const patch of patches) applyStorePatch(store, patch)
}

function pathToMask(path: StorePath): any {
    let out: any = true
    for (let i = path.length - 1; i >= 0; i--) out = {[path[i] as any]: out}
    return out
}

function hasMaskKey(mask: any, key: PropertyKey) {
    return isObj(mask) && Reflect.ownKeys(mask).some(k => Object.is(k, key))
}

function mergeMasks(a: any, b: any): any {
    if (a === undefined) return b
    if (b === undefined) return a
    if (a === true || a == null || b === true || b == null) return true
    if (!isObj(a) || !isObj(b)) return true
    const out: any = {}
    for (const k of Reflect.ownKeys(a)) out[k as any] = (a as any)[k as any]
    for (const k of Reflect.ownKeys(b)) {
        out[k as any] = hasMaskKey(a, k) ? mergeMasks((a as any)[k as any], (b as any)[k as any]) : (b as any)[k as any]
    }
    return out
}

function startsWithPath(path: StorePath, prefix: StorePath) {
    return prefix.length <= path.length && prefix.every((k, i) => Object.is(k, path[i]))
}

function intersectMaskWithPaths(mask: any, dirtyPaths?: PropertyKey[][]) {
    const baseMask = mask ?? true
    if (!Array.isArray(dirtyPaths)) return baseMask
    if (dirtyPaths.length == 0) return undefined
    const selected = maskPaths(baseMask)
    let out: any = undefined
    for (const dirty of dirtyPaths) {
        if (!Array.isArray(dirty)) continue
        if (dirty.length == 0) { out = mergeMasks(out, baseMask); continue }
        for (const selectedPath of selected) {
            if (startsWithPath(dirty, selectedPath)) out = mergeMasks(out, pathToMask(dirty))
            else if (startsWithPath(selectedPath, dirty)) out = mergeMasks(out, pathToMask(selectedPath))
        }
    }
    return out
}

function maskFromPaths(paths: PropertyKey[][]) {
    let out: any = undefined
    for (const path of paths) out = mergeMasks(out, pathToMask(path))
    return out ?? true
}

function makePatch(root: any, path: StorePath): StorePatch {
    root = toRaw(root)
    const exists = hasAt(root, path)
    return {
        path: [...path],
        exists,
        value: exists ? snapshotValue(getAt(root, path)) : undefined,
    }
}

function patchesForMask(patch: StorePatch, mask: any) {
    const selected = maskPaths(mask ?? true)
    const out: StorePatch[] = []
    let emittedWholePatch = false
    for (const selectedPath of selected) {
        if (startsWithPath(patch.path, selectedPath)) {
            if (!emittedWholePatch) {
                out.push(patch)
                emittedWholePatch = true
            }
            continue
        }
        if (!startsWithPath(selectedPath, patch.path)) continue
        const rel = selectedPath.slice(patch.path.length)
        const exists = patch.exists && hasAt(patch.value, rel)
        out.push({
            path: [...selectedPath],
            exists,
            value: exists ? snapshotValue(getAt(patch.value, rel)) : undefined,
        })
    }
    return out
}

function createPatchesListen<T extends object>(store: Store<T>) {
    return createListen<[StorePatch]>((emit) => {
        const off = store.listenPaths().on((change: StoreChange) => {
            for (const path of change.paths) emit(makePatch(store.state, path))
        })
        return off
    }, {
        event: (type, count, api) => {
            if (type == "add" && count == 1 && !api.isRunning()) api.run()
            if (type == "remove" && count == 0 && api.isRunning()) api.close()
        },
    })
}

// Изменённые ТОП-ключи как обычный Listen: (key, value | undefined, {path}).
// Тонкий слой над listenPaths: движок сам рассыпает root replace (keyframe зеркала)
// в per-key пути, включая удаления — cold start и reconnect не спец-кейсы.
// Ключ с НЕизменившимся примитивом при root replace не стреляет (set-трап
// пропускает Object.is-равные записи) — потребителю и не нужно.
function createEachListen<T extends object>(store: Store<T>, opts: StoreEachOpts = {}) {
    if (opts.depth != null && opts.depth != 1) throw new Error("store.each: only depth 1 is supported (reserved option)")
    return createListen<[key: string, value: T[keyof T] | undefined, ctx: StoreEachCtx]>((emit) => {
        // ключи, о которых потребители уже знают — чтобы гипотетический root-путь []
        // (array-root / будущий движок) мог отдать (key, undefined) за исчезнувшие
        const known = new Set<PropertyKey>(Reflect.ownKeys(toRaw(store.state)))
        function emitKey(key: PropertyKey) {
            const raw: any = toRaw(store.state)
            const exists = isObj(raw) && key in raw
            if (exists) known.add(key)
            else known.delete(key)
            emit(key as any, exists ? (store.state as any)[key] : undefined, {path: [key]})
        }
        const off = store.listenPaths().on(function eachStoreChange(change: StoreChange) {
            const keys = new Set<PropertyKey>()
            let root = false
            for (const path of change.paths) {
                if (path.length == 0) root = true
                else keys.add(path[0])
            }
            if (root) {
                for (const key of Reflect.ownKeys(toRaw(store.state))) keys.add(key)
                for (const key of known) keys.add(key)
            }
            for (const key of keys) emitKey(key)
        })
        return off
    }, {
        event: (type, count, api) => {
            if (type == "add" && count == 1 && !api.isRunning()) api.run()
            if (type == "remove" && count == 0 && api.isRunning()) api.close()
        },
    })
}

function createChangedDataListen<T extends object>(store: Store<T>) {
    return createListen<[StoreChangedData]>((emit) => {
        const off = store.listenPaths().on((change: StoreChange) => {
            const mask = maskFromPaths(change.paths)
            emit({mask, data: pickSnapshot(store.state, mask)})
        })
        return off
    }, {
        event: (type, count, api) => {
            if (type == "add" && count == 1 && !api.isRunning()) api.run()
            if (type == "remove" && count == 0 && api.isRunning()) api.close()
        },
    })
}
// ============================================================
//  subscription engine
// ============================================================

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
        pathString: pathText(path),
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

// ============================================================
//  node facade & selections
// ============================================================

function getNode<T>(store: StoreInternal<any>, path: PropertyKey[]): StoreNode<T> {
    const k = pathKey(path)
    const cached = store._nodeCache.get(k)
    if (cached) return cached

    const api: StoreNodeApi<T> = {
        get path() { return [...path] },
        get pathString() { return pathText(path) },
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

// guardrail-варн onEach-по-корню — один раз на процесс, не спамить
let warnedRootOnEach = false

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
            // `current` may fire synchronously inside this.on, BEFORE `off` is
            // assigned — the `done` flag keeps that first call from repeating.
            let done = false
            let off = () => {}
            off = this.on(function fireOnce(v, c) { if (done) return; done = true; off(); cb(v, c) }, {...opts, current: opts.current ?? defaults.current})
            if (done) off()
            return off
        },
        onEach(cb, opts = {}) {
            // частая ловушка: onEach стреляет per ВЫБРАННЫЙ путь, mask true выбирает
            // сам корень выборки → ОДИН вызов за drain-окно с целым значением
            if (fullPaths.some(p => p.length == base.length) && !warnedRootOnEach) {
                warnedRootOnEach = true
                console.warn("store: update(true).onEach fires ONCE per drain window with the WHOLE value (per selected path, not per key). For per-changed-key delivery use store.each(); for a subset — an explicit key mask.")
            }
            const o = {...defaults, ...opts}
            const offs = fullPaths.map(p => subscribePath<any>(store, p, cb, o, false))
            return () => { for (const off of offs) off() }
        },
    }
}

// ============================================================
//  store
// ============================================================

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
        each: (opts?: StoreEachOpts) => createEachListen<T>(store, opts),
        listen: () => listenUpdate(state),
        listenPaths: () => listenUpdatePaths(state),
        count: () => Array.from(store._counts.values()).reduce((a: number, b: number) => a + b, 0),
    }
    return store
}

// ============================================================
//  remote: expose & mirror
// ============================================================

export function exposeStore<T extends object>(store: Store<T>, opts: StoreExposeOpts = {}): StoreRemoteApi<T> {
    const get = ((mask?: StoreMask<T>) => mask ? store.update(mask as any).get() : store.snapshot()) as StoreRemoteApi<T>["get"]
    const api: StoreRemoteApi<T> = {
        get,
        // `set` kept as a wire alias of `replace` — remote clients may call either
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
        changedPaths: store.listenPaths(),
    }
    if (opts.push) {
        api.patches = createPatchesListen(store)
        api.changedData = createChangedDataListen(store)
    }
    return api
}

function isRemoteListen(listen: any) {
    return typeof listen?.on == "function"
}

function subscribeRemote(listen: any, cb: (...args: any[]) => void) {
    if (typeof listen?.on != "function") return () => {}
    const handle = listen.on(cb)
    return () => {
        if (typeof handle == "function") handle()
        else if (typeof handle?.off == "function") handle.off()
        else if (typeof listen?.off == "function") listen.off(cb)
    }
}

export function createStoreMirror<T extends object>(remote: RemoteStore<T>, initial = {} as T, opts: Parameters<typeof createStore<T>>[1] = {}) {
    const store = createStore<T>(initial, opts)
    const makeReport = (subOpts: StoreSyncOpts) => (error: any) => {
        if (subOpts.onError) subOpts.onError(error)
        else setTimeout(() => { throw error }, 0)
    }

    async function pull(mask: any) {
        const snap = await remote.get(mask)
        applyMask(store.state, mask, snap)
    }

    async function sync<M extends StoreMask<T>>(mask: M, subOpts: StoreSyncOpts = {current: true}) {
        const baseMask = mask ?? true
        const report = makeReport(subOpts)
        if (subOpts.current !== false) await pull(baseMask)

        let pendingMask: any = undefined
        // pulls are chained: a slow (stale) response can never land on top
        // of a newer one that resolved first
        let chain: Promise<void> = Promise.resolve()
        const drained = createDrained(() => {
            const nextMask = pendingMask === undefined ? baseMask : pendingMask
            pendingMask = undefined
            chain = chain.then(() => pull(nextMask)).catch(report)
        }, subOpts.drain)
        const queue = (nextMask: any) => {
            pendingMask = pendingMask === undefined ? nextMask : mergeMasks(pendingMask, nextMask)
            drained.push()
        }

        const changedPaths = remote.changedPaths
        const usePaths = subOpts.partial !== false && isRemoteListen(changedPaths)
        const off = usePaths
            ? subscribeRemote(changedPaths, (change?: StoreChange) => {
                const nextMask = intersectMaskWithPaths(baseMask, change?.paths)
                if (nextMask !== undefined) queue(nextMask)
            })
            : subscribeRemote(remote.changed, () => queue(baseMask))
        return () => { drained.close(); off() }
    }

    async function syncPatches<M extends StoreMask<T>>(mask: M, subOpts: StoreSyncOpts = {current: true}) {
        if (!isRemoteListen(remote.patches)) throw new Error("createStoreMirror.syncPatches: remote.patches is not exposed")
        const baseMask = mask ?? true
        const report = makeReport(subOpts)
        if (subOpts.current !== false) await pull(baseMask)

        const pending: StorePatch[] = []
        const drained = createDrained(() => {
            const batch = pending.splice(0)
            try { applyStorePatches(store, batch) }
            catch (e) { report(e) }
        }, subOpts.drain)
        const off = subscribeRemote(remote.patches, (patch: StorePatch) => {
            const next = patchesForMask(patch, baseMask)
            if (next.length == 0) return
            pending.push(...next)
            drained.push()
        })
        return () => { drained.close(); off() }
    }

    async function syncChangedData<M extends StoreMask<T>>(mask: M, subOpts: StoreSyncOpts = {current: true}) {
        if (!isRemoteListen(remote.changedData)) throw new Error("createStoreMirror.syncChangedData: remote.changedData is not exposed")
        const baseMask = mask ?? true
        const report = makeReport(subOpts)
        if (subOpts.current !== false) await pull(baseMask)

        const pending: StoreChangedData[] = []
        const drained = createDrained(() => {
            const batch = pending.splice(0)
            try {
                for (const change of batch) {
                    const nextMask = intersectMaskWithPaths(baseMask, maskPaths(change?.mask ?? true))
                    if (nextMask !== undefined) applyMask(store.state, nextMask, change.data)
                }
            } catch (e) { report(e) }
        }, subOpts.drain)
        const off = subscribeRemote(remote.changedData, (change: StoreChangedData) => {
            pending.push(change)
            drained.push()
        })
        return () => { drained.close(); off() }
    }

    return Object.assign(store, {sync, syncPatches, syncChangedData})
}
