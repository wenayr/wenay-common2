import {createListen, type ListenApi} from '../events/Listen'
import {listenUpdate, listenUpdatePaths, onUpdate, reactive, isReactive, toRaw, ReactiveChange} from "./reactive";
import {getRpcMemberState, getRpcSchemaReady, hasRpcMemberLookup} from '../events/transport-lifecycle'
import {positiveIntegerOption} from '../positive-integer-option'
import {rpcResultWireMetricsFast} from '../rcp/rpc-wire-size'
import {
    REACTIVE_ARRAY_MUTATIONS,
    STORE_REPLAY_PATCH_SOURCE,
    STORE_REPLAY_VIEW_PATCH_SOURCE,
    type ReactiveArrayMutations,
} from './observe-private'

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
    /** Prefer one natural patch array callback; old servers fall back to patches. */
    batch?: boolean
    onError?: (error: any) => void
}
export type StorePatchBatchOpts = {
    /** Hard patch ceiling for one callback (default 256). */
    maxItems?: number
    /** Packed RPC payload target for one callback (default 64 KiB; one patch may exceed it). */
    maxBytes?: number
}
export type StoreExposeOpts = {
    push?: boolean | StorePatchBatchOpts
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
    // key is typed as string (not keyof T): keyof in contravariant position in Listen
    // would break Store<T> -> Store<any>; symbol keys pass at runtime as is
    each(opts?: StoreEachOpts): ReturnType<typeof createListen<[key: string, value: T[keyof T] | undefined, ctx: StoreEachCtx]>>
    listen(): ReturnType<typeof listenUpdate>
    listenPaths(): ReturnType<typeof listenUpdatePaths>
    count(): number
}

type StoreReactiveOpts = Parameters<typeof reactive<object>>[1] & {
    _onMutation?: (path: PropertyKey[]) => void
}

type StoreNodeEntry = {
    key: string
    path: PropertyKey[]
    parent?: StoreNodeEntry
    parentKey?: PropertyKey
    children: Map<PropertyKey, StoreNodeEntry>
    proxy?: StoreNode<any>
}

type StoreInternal<T extends object> = Store<T> & {
    _state: T
    _nodeCache: Map<string, StoreNodeEntry>
    _nodeRoot?: StoreNodeEntry
    _counts: Map<string, number>
    _reactiveOpts: StoreReactiveOpts
}

type RemoteStore<T extends object> = {
    get(mask?: any): T | Promise<T>
    changed: any
    changedPaths?: any
    patches?: any
    patchesBatch?: any
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
    patchesBatch?: any
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
        if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined
        cur = (cur as any)[k as any]
    }
    return cur
}

function hasAt(root: any, path: StorePath): boolean {
    let cur = root
    for (const k of path) {
        if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return false
        cur = (cur as any)[k as any]
    }
    return true
}

function readRawAt(root: any, path: StorePath) {
    let cur = toRaw(root)
    for (const k of path) {
        if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) {
            return {exists: false, value: undefined}
        }
        cur = toRaw((cur as any)[k as any])
    }
    return {exists: true, value: cur}
}

function ensureParent(root: any, path: StorePath) {
    let cur = root
    for (let i = 0; i < path.length - 1; i++) {
        const k = path[i]
        if (!Object.prototype.hasOwnProperty.call(cur, k) || !isObj((cur as any)[k as any])) {
            defineOwnValue(cur, k, {})
        }
        cur = (cur as any)[k as any]
    }
    return cur
}

function safeStorePath(path: StorePath, label = 'store path') {
    if (!Array.isArray(path)) throw new TypeError(`${label} must be an array`)
    return Array.from(path, function validateStorePathKey(key) {
        if (typeof key != 'string' && typeof key != 'number' && typeof key != 'symbol') {
            throw new TypeError(`${label} keys must be string, number or symbol`)
        }
        return key
    })
}

function defineOwnValue(target: any, key: PropertyKey, value: any) {
    const ok = Reflect.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    })
    if (!ok) throw new TypeError(`store cannot define path key: ${String(key)}`)
}

function defineSnapshotValue(target: any, key: PropertyKey, value: any) {
    let prototype = Object.getPrototypeOf(target)
    let inherited: PropertyDescriptor | undefined
    while (prototype && !inherited) {
        inherited = Object.getOwnPropertyDescriptor(prototype, key)
        prototype = Object.getPrototypeOf(prototype)
    }
    if (!inherited
        || Object.prototype.hasOwnProperty.call(inherited, 'value') && inherited.writable == true) {
        target[key as any] = value
        return
    }
    // Fresh snapshot containers can use the engine's fast property path except
    // where assignment would invoke or inherit a polluted prototype property.
    defineOwnValue(target, key, value)
}

function replaceRoot(root: any, value: any) {
    for (const k of Reflect.ownKeys(root)) {
        if (!isObj(value) || !Object.prototype.hasOwnProperty.call(value, k)) delete root[k as any]
    }
    if (isObj(value)) {
        for (const k of Reflect.ownKeys(value)) defineOwnValue(root, k, (value as any)[k as any])
    }
}

function setAt(root: any, path: StorePath, value: any) {
    if (path.length == 0) { replaceRoot(root, value); return }
    const safePath = safeStorePath(path)
    setPreparedAt(root, safePath, value)
}

function setPreparedAt(root: any, path: StorePath, value: any) {
    if (path.length == 0) { replaceRoot(root, value); return }
    const p = ensureParent(root, path)
    defineOwnValue(p, path[path.length - 1], value)
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
    if (value instanceof ArrayBuffer) return value.slice(0) as T
    if (ArrayBuffer.isView(value)) {
        const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        if (value instanceof DataView) return new DataView(bytes) as T
        const Constructor = value.constructor as any
        if (typeof Constructor.from == 'function' && typeof Constructor.isBuffer == 'function'
            && Constructor.isBuffer(value)) {
            return Constructor.from(new Uint8Array(bytes)) as T
        }
        return new Constructor(bytes) as T
    }
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
    const out: any = Array.isArray(value)
        ? []
        : Object.create(Object.getPrototypeOf(value) == null ? null : Object.prototype)
    seen.set(value, out)
    for (const k of Reflect.ownKeys(value)) {
        if (Array.isArray(value) && k == 'length') continue
        defineSnapshotValue(out, k, snapshotValue((value as any)[k as any], seen))
    }
    return out
}

/** Detached Store-safe value clone used at projection and wire ownership boundaries. */
export function cloneStoreValue<T>(value: T): T {
    return snapshotValue(value)
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
    const safePath = safeStorePath(path)
    deletePreparedAt(root, safePath)
}

function deletePreparedAt(root: any, path: StorePath) {
    if (path.length == 0) { replaceRoot(root, {}); return }
    const parent = getAt(root, path.slice(0, -1))
    const key = path[path.length - 1]
    if (isObj(parent) && Object.prototype.hasOwnProperty.call(parent, key)) delete (parent as any)[key as any]
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

function prepareStorePatch(patch: StorePatch) {
    if (patch == null || typeof patch != 'object' || !Array.isArray(patch.path)
        || typeof patch.exists != 'boolean') {
        throw new TypeError('store patch must contain path[] and boolean exists')
    }
    const path = safeStorePath(patch.path, 'store patch path')
    return {
        path,
        exists: patch.exists,
        value: patch.exists ? snapshotValue(patch.value) : undefined,
    } satisfies StorePatch
}

function applyPreparedStorePatch<T extends object>(store: Store<T>, patch: StorePatch) {
    if (!patch.exists) deletePreparedAt(store.state, patch.path)
    else setPreparedAt(store.state, patch.path, patch.value)
}

export function applyStorePatch<T extends object>(store: Store<T>, patch: StorePatch) {
    applyPreparedStorePatch(store, prepareStorePatch(patch))
}

export function applyStorePatches<T extends object>(store: Store<T>, patches: readonly StorePatch[]) {
    const prepared = Array.from(patches, prepareStorePatch)
    for (const patch of prepared) applyPreparedStorePatch(store, patch)
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

function manageColdListenLifecycle(type: 'add' | 'remove', count: number, api: ListenApi<any>) {
    if (type == 'add' && count == 1 && !api.isRunning()) api.run()
    if (type == 'remove' && count == 0 && api.isRunning()) api.close()
}

function coldListenOptions() {
    return {event: manageColdListenLifecycle}
}

/**
 * Natural patch batch of one reactive drain window. Values are sampled only
 * after the window settles, so the array describes one consistent Store state.
 * Cold like the other Store listens: without subscribers it installs no watcher.
 */
function exactReplayPatchPaths(change: StoreChange) {
    const detail = (change as StoreChange & {
        [REACTIVE_ARRAY_MUTATIONS]?: ReactiveArrayMutations
    })[REACTIVE_ARRAY_MUTATIONS]
    if (!detail || detail.paths.length == 0) return change.paths

    const replacements = new Set(detail.replacements.map(pathKey))
    const mutations = new Map<string, PropertyKey[][]>()
    for (const path of detail.paths) {
        const parentKey = pathKey(path.slice(0, -1))
        let paths = mutations.get(parentKey)
        if (!paths) {
            paths = []
            mutations.set(parentKey, paths)
        }
        paths.push(path)
    }

    const refined: PropertyKey[][] = []
    for (const path of change.paths) {
        if (replacements.has(pathKey(path))) {
            refined.push(path)
            continue
        }
        const exact = mutations.get(pathKey(path))
        if (!exact || exact.some(item => item[item.length - 1] == 'length')) {
            refined.push(path)
            continue
        }
        refined.push(...exact)
    }
    return refined
}

function createStorePatchesListen<T extends object>(store: Store<T>, exactArrays = false) {
    function sampleChangedStorePath(path: PropertyKey[]) {
        return makePatch(store.state, path)
    }

    function produceStorePatchBatches(emit: (patches: readonly StorePatch[]) => void) {
        const off = store.listenPaths().on(function emitStorePatchBatch(change: StoreChange) {
            const paths = exactArrays ? exactReplayPatchPaths(change) : change.paths
            emit(paths.map(sampleChangedStorePath))
        })
        return off
    }
    return createListen<[readonly StorePatch[]]>(produceStorePatchBatches, coldListenOptions())
}

// One Store must be sampled once per drain even when legacy and batch consumers
// coexist. Its lazy sampler belongs to the Store closure, not module state.
const storePatchesListenOwner = Symbol('storePatchesListenOwner')
type StorePatchesListenOwner<T extends object> = Store<T> & {
    [storePatchesListenOwner]?: () => ReturnType<typeof createStorePatchesListen<T>>
}

function createStorePatchesListenOwner<T extends object>(store: Store<T>, exactArrays = false) {
    let patches: ReturnType<typeof createStorePatchesListen<T>> | undefined
    return function getStorePatchesListen() {
        patches ??= createStorePatchesListen(store, exactArrays)
        return patches
    }
}

function installStorePatchesListenOwner<T extends object>(store: Store<T>) {
    const owner = store as StorePatchesListenOwner<T>
    let getPatches = owner[storePatchesListenOwner]
    if (!getPatches) {
        getPatches = createStorePatchesListenOwner(store)
        Object.defineProperty(owner, storePatchesListenOwner, {value: getPatches})
    }
    return getPatches
}

function installStoreReplayPatchesListenOwner<T extends object>(store: Store<T>) {
    Object.defineProperty(store, STORE_REPLAY_PATCH_SOURCE, {
        value: createStorePatchesListenOwner(store, true),
    })
}

type StoreReplayViewPatchRegistration = {
    keys: ReadonlySet<string>
    emit: (patches: readonly StorePatch[]) => void
}

/**
 * Selective Replay views share one Store watcher. A changed fact is detached
 * once for the union of interested views, after dirty paths have been filtered.
 */
function createStoreReplayViewPatchesOwner<T extends object>(store: Store<T>) {
    const registrations = new Set<StoreReplayViewPatchRegistration>()
    const registrationsByKey = new Map<string, Set<StoreReplayViewPatchRegistration>>()
    let offStore: (() => void) | undefined

    function emitSelectedStorePatches(change: StoreChange) {
        const paths = exactReplayPatchPaths(change)
        const batches = new Map<StoreReplayViewPatchRegistration, StorePatch[]>()

        function add(registration: StoreReplayViewPatchRegistration, patch: StorePatch) {
            let patches = batches.get(registration)
            if (!patches) {
                patches = []
                batches.set(registration, patches)
            }
            patches.push(patch)
        }

        if (paths.some(path => path.length == 0)) {
            for (const [key, targets] of registrationsByKey) {
                const patch = makePatch(store.state, [key])
                for (const registration of targets) add(registration, patch)
            }
        } else {
            const sampled = new Map<string, StorePatch>()
            for (const path of paths) {
                const key = path[0]
                if (typeof key != 'string') continue
                const targets = registrationsByKey.get(key)
                if (!targets) continue
                const id = pathKey(path)
                if (sampled.has(id)) continue
                const patch = makePatch(store.state, path)
                sampled.set(id, patch)
                for (const registration of targets) add(registration, patch)
            }
        }

        const failures: unknown[] = []
        for (const [registration, patches] of batches) {
            try {
                registration.emit(patches)
            } catch (error) {
                failures.push(error)
            }
        }
        if (failures.length == 1) throw failures[0]
        if (failures.length > 1) {
            throw new AggregateError(failures, 'Store Replay views rejected a shared patch batch')
        }
    }

    function startStoreWatcher() {
        offStore ??= store.listenPaths().on(emitSelectedStorePatches)
    }

    function stopStoreWatcher() {
        if (registrations.size != 0) return
        offStore?.()
        offStore = undefined
    }

    return function createSelectedStorePatchSource(keys: readonly string[]) {
        const selection = new Set(keys)
        function produceSelectedStorePatches(emit: (patches: readonly StorePatch[]) => void) {
            const registration = {keys: selection, emit}
            registrations.add(registration)
            for (const key of selection) {
                let targets = registrationsByKey.get(key)
                if (!targets) {
                    targets = new Set()
                    registrationsByKey.set(key, targets)
                }
                targets.add(registration)
            }
            startStoreWatcher()
            return function removeSelectedStorePatchRegistration() {
                registrations.delete(registration)
                for (const key of selection) {
                    const targets = registrationsByKey.get(key)
                    targets?.delete(registration)
                    if (targets?.size == 0) registrationsByKey.delete(key)
                }
                stopStoreWatcher()
            }
        }
        return createListen<[readonly StorePatch[]]>(produceSelectedStorePatches, coldListenOptions())
    }
}

function installStoreReplayViewPatchesOwner<T extends object>(store: Store<T>) {
    Object.defineProperty(store, STORE_REPLAY_VIEW_PATCH_SOURCE, {
        value: createStoreReplayViewPatchesOwner(store),
    })
}

export function listenStorePatches<T extends object>(store: Store<T>) {
    return installStorePatchesListenOwner(store)()
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

function createPatchesListen(batches: ReturnType<typeof listenStorePatches>) {
    function produceIndividualStorePatches(emit: (patch: StorePatch) => void) {
        const off = batches.on(function emitIndividualStorePatches(patches) {
            for (const patch of patches) emit(patch)
        })
        return off
    }
    return createListen<[StorePatch]>(produceIndividualStorePatches, coldListenOptions())
}

function createPatchesBatchListen(
    batches: ReturnType<typeof listenStorePatches>, opts: StorePatchBatchOpts = {},
) {
    const maxItems = positiveIntegerOption(opts.maxItems, 256, 'exposeStore: push.maxItems')
    const maxBytes = positiveIntegerOption(opts.maxBytes, 64 * 1024, 'exposeStore: push.maxBytes')
    const envelopeBytes = 48
    function produceBoundedStorePatchBatches(emit: (patches: readonly StorePatch[]) => void) {
        return batches.on(function emitBoundedStorePatchBatches(patches) {
            let pending: StorePatch[] = []
            let pendingBytes = envelopeBytes
            let pendingBinaryCount = 0
            function flush() {
                if (pending.length == 0) return
                emit(pending)
                pending = []
                pendingBytes = envelopeBytes
                pendingBinaryCount = 0
            }
            for (const patch of patches) {
                let metrics = rpcResultWireMetricsFast(patch, pendingBinaryCount)
                let bytes = Number.isFinite(metrics.byteLength) ? metrics.byteLength + 1 : maxBytes
                if (pending.length && (pending.length >= maxItems || pendingBytes + bytes > maxBytes)) {
                    flush()
                    // A non-binary patch does not contain attachment indices, so the metric
                    // measured against the previous batch stays exact after the boundary.
                    if (metrics.binaryCount > 0) metrics = rpcResultWireMetricsFast(patch)
                    bytes = Number.isFinite(metrics.byteLength) ? metrics.byteLength + 1 : maxBytes
                }
                pending.push(patch)
                pendingBytes += bytes
                pendingBinaryCount += metrics.binaryCount
                if (pending.length >= maxItems) flush()
            }
            flush()
        })
    }
    return createListen<[readonly StorePatch[]]>(produceBoundedStorePatchBatches, coldListenOptions())
}

// Changed TOP-level keys as a regular Listen: (key, value | undefined, {path}).
// Thin layer over listenPaths: the engine itself breaks down root replace (mirror keyframe)
// into per-key paths, including deletes — cold start and reconnect are not special cases.
// A key with unchanged primitive on root replace does not fire (set trap
// skips Object.is-equal entries) — consumer doesn't need it.
function createEachListen<T extends object>(store: Store<T>, opts: StoreEachOpts = {}) {
    if (opts.depth != null && opts.depth != 1) throw new Error("store.each: only depth 1 is supported (reserved option)")
    return createListen<[key: string, value: T[keyof T] | undefined, ctx: StoreEachCtx]>((emit) => {
        // keys that consumers already know — so a hypothetical root-path []
        // (array-root / future engine) can return (key, undefined) for disappeared keys
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

function getNodeEntry(store: StoreInternal<any>, path: StorePath): StoreNodeEntry {
    const k = pathKey(path)
    const cached = store._nodeCache.get(k)
    if (cached) return cached

    const parent = path.length ? getNodeEntry(store, path.slice(0, -1)) : undefined
    const entry: StoreNodeEntry = {
        key: k,
        path: [...path],
        parent,
        parentKey: path[path.length - 1],
        children: new Map<PropertyKey, StoreNodeEntry>(),
    }
    store._nodeCache.set(k, entry)
    if (parent) parent.children.set(entry.parentKey!, entry)
    else store._nodeRoot = entry
    refreshNodePruner(store)
    return entry
}

function cachedNodeEntry(store: StoreInternal<any>, path: StorePath) {
    let entry = store._nodeRoot
    if (!entry) return undefined
    for (const key of path) {
        entry = entry.children.get(key)
        if (!entry) return undefined
    }
    return entry
}

function removeNodeEntry(store: StoreInternal<any>, entry: StoreNodeEntry) {
    if (entry.path.length == 0) return
    for (const child of [...entry.children.values()]) removeNodeEntry(store, child)
    entry.parent?.children.delete(entry.parentKey!)
    store._nodeCache.delete(entry.key)
}

function pruneNodeEntry(store: StoreInternal<any>, entry: StoreNodeEntry, exists: boolean, value: any) {
    for (const [key, child] of [...entry.children]) {
        const childExists = exists && isObj(value) && key in value
        const childValue = childExists ? toRaw((value as any)[key as any]) : undefined
        if (!pruneNodeEntry(store, child, childExists, childValue)) removeNodeEntry(store, child)
    }
    return entry.path.length == 0 || exists || (store._counts.get(entry.key) ?? 0) > 0 || entry.children.size > 0
}

function pruneCachedPath(store: StoreInternal<any>, path: StorePath) {
    const entry = cachedNodeEntry(store, path)
    if (!entry) return
    const current = readRawAt(store._state, path)
    if (!pruneNodeEntry(store, entry, current.exists, current.value)) removeNodeEntry(store, entry)

    let parent = entry.parent
    while (parent && parent.path.length) {
        const currentParent = readRawAt(store._state, parent.path)
        if (pruneNodeEntry(store, parent, currentParent.exists, currentParent.value)) break
        const next = parent.parent
        removeNodeEntry(store, parent)
        parent = next
    }
    refreshNodePruner(store)
}

function refreshNodePruner(store: StoreInternal<any>) {
    if (store._nodeCache.size > 1) {
        store._reactiveOpts._onMutation ??= function pruneStoreNodeCache(path) {
            pruneCachedPath(store, path)
        }
    } else store._reactiveOpts._onMutation = undefined
}

function incCount(store: StoreInternal<any>, path: StorePath) {
    const k = pathKey(path)
    getNodeEntry(store, path)
    store._counts.set(k, (store._counts.get(k) ?? 0) + 1)
}

function decCount(store: StoreInternal<any>, path: StorePath) {
    const k = pathKey(path)
    const n = (store._counts.get(k) ?? 0) - 1
    if (n > 0) store._counts.set(k, n)
    else store._counts.delete(k)
    pruneCachedPath(store, path)
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
    const entry = getNodeEntry(store, path)
    if (entry.proxy) return entry.proxy as StoreNode<T>

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
    entry.proxy = proxy as StoreNode<T>
    return entry.proxy as StoreNode<T>
}

// guardrail-warn onEach on root — once per process, no spam
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
            // common pitfall: onEach fires per SELECTED path, mask true selects
            // the root of the selection itself → ONE call per drain window with the whole value
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
    const reactiveOpts: StoreReactiveOpts = {...opts, _onMutation: undefined}
    const state = reactive(initial, reactiveOpts)
    let store: StoreInternal<T>
    store = {
        _state: state,
        _nodeCache: new Map<string, StoreNodeEntry>(),
        _counts: new Map<string, number>(),
        _reactiveOpts: reactiveOpts,
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
    installStorePatchesListenOwner(store)
    installStoreReplayPatchesListenOwner(store)
    installStoreReplayViewPatchesOwner(store)
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
        set: (path: StorePath, value: any) => setAt(store.state, path, value),
        replace: (path: StorePath, value: any) => setAt(store.state, path, value),
        changed: store.listen(),
        changedPaths: store.listenPaths(),
    }
    if (opts.push) {
        const patchBatches = listenStorePatches(store)
        const pushOpts = opts.push === true ? {} : opts.push
        api.patches = createPatchesListen(patchBatches)
        api.patchesBatch = createPatchesBatchListen(patchBatches, pushOpts)
        api.changedData = createChangedDataListen(store)
    }
    return api
}

function isRemoteListen(listen: any) {
    return typeof listen?.on == "function"
}

function subscribeRemote(listen: any, cb: (...args: any[]) => void) {
    if (typeof listen?.on != "function") return function noopRemoteUnsubscribe() {}
    const handle = listen.on(cb)
    return function unsubscribeRemote() {
        if (typeof handle == "function") handle()
        else if (typeof handle?.off == "function") handle.off()
        else if (typeof listen?.off == "function") listen.off(cb)
    }
}

export function createStoreMirror<T extends object>(remote: RemoteStore<T>, initial = {} as T, opts: Parameters<typeof createStore<T>>[1] = {}) {
    const store = createStore<T>(initial, opts)
    function makeReport(subOpts: StoreSyncOpts) {
        return function reportStoreMirrorError(error: any) {
            if (subOpts.onError) subOpts.onError(error)
            else setTimeout(function throwStoreMirrorError() { throw error }, 0)
        }
    }

    function waitForRemoteSchema(...members: string[]) {
        if (!members.some(member => getRpcMemberState(remote, member) == undefined)) return undefined
        return getRpcSchemaReady(remote)?.()
    }

    function remoteListenAvailable(member: string, candidate: any, allowRpcUnknown = false) {
        const state = getRpcMemberState(remote, member)
        if (state == true) return isRemoteListen(candidate)
        if (state == false) return false
        if (hasRpcMemberLookup(remote)) return allowRpcUnknown && isRemoteListen(candidate)
        return isRemoteListen(candidate)
    }

    async function pull(mask: any) {
        const snap = await remote.get(mask)
        applyMask(store.state, mask, snap)
    }

    async function sync<M extends StoreMask<T>>(mask: M, subOpts: StoreSyncOpts = {current: true}) {
        const baseMask = mask ?? true
        const report = makeReport(subOpts)
        let initializing = subOpts.current !== false
        let pendingMask: any = undefined
        // pulls are chained: a slow (stale) response can never land on top
        // of a newer one that resolved first
        let chain: Promise<void> = Promise.resolve()
        const drained = createDrained(function pullQueuedStoreMask() {
            const nextMask = pendingMask === undefined ? baseMask : pendingMask
            pendingMask = undefined
            chain = chain.then(function pullNextStoreMask() { return pull(nextMask) }).catch(report)
        }, subOpts.drain)
        function queueStoreMask(nextMask: any) {
            pendingMask = pendingMask === undefined ? nextMask : mergeMasks(pendingMask, nextMask)
            if (!initializing) drained.push()
        }

        function handleRemoteChangedPaths(change?: StoreChange) {
            const nextMask = intersectMaskWithPaths(baseMask, change?.paths)
            if (nextMask !== undefined) queueStoreMask(nextMask)
        }

        function handleRemoteChanged() {
            queueStoreMask(baseMask)
        }

        const wantsPaths = subOpts.partial !== false
        // With no initial pull, waiting before the live subscription would create
        // a real loss window. Unknown therefore takes the always-present legacy line.
        const pathsSchema = wantsPaths && subOpts.current !== false ? waitForRemoteSchema('changedPaths') : undefined
        if (pathsSchema) await pathsSchema
        const changedPaths = remote.changedPaths
        const usePaths = wantsPaths && remoteListenAvailable('changedPaths', changedPaths)
        const off = usePaths
            ? subscribeRemote(changedPaths, handleRemoteChangedPaths)
            : subscribeRemote(remote.changed, handleRemoteChanged)
        try {
            if (initializing) await pull(baseMask)
            initializing = false
            if (pendingMask !== undefined) drained.push()
        } catch (error) {
            drained.close()
            off()
            throw error
        }
        return function closeStoreSync() {
            drained.close()
            off()
        }
    }

    async function syncPatches<M extends StoreMask<T>>(mask: M, subOpts: StoreSyncOpts = {current: true}) {
        const canWaitForSchema = subOpts.current !== false
        const patchesSchema = canWaitForSchema
            ? waitForRemoteSchema('patches', ...(subOpts.batch != false ? ['patchesBatch'] : []))
            : undefined
        if (patchesSchema) await patchesSchema
        const useBatch = subOpts.batch != false
            && remoteListenAvailable('patchesBatch', remote.patchesBatch)
        const patchListen = useBatch ? remote.patchesBatch : remote.patches
        // current:false must attach without waiting; legacy patches is the only
        // lossless conservative choice while a branded schema is still unknown.
        if (!remoteListenAvailable(useBatch ? 'patchesBatch' : 'patches', patchListen, !canWaitForSchema && !useBatch)) {
            throw new Error("createStoreMirror.syncPatches: remote.patches is not exposed")
        }
        const baseMask = mask ?? true
        const report = makeReport(subOpts)
        let initializing = subOpts.current !== false
        const pending: StorePatch[] = []
        const drained = createDrained(function applyPendingStorePatches() {
            const batch = pending.splice(0)
            try { applyStorePatches(store, batch) }
            catch (e) { report(e) }
        }, subOpts.drain)
        function queuePatch(patch: StorePatch) {
            const next = patchesForMask(patch, baseMask)
            if (next.length == 0) return false
            pending.push(...next)
            return true
        }

        function handleRemoteStorePatches(value: StorePatch | readonly StorePatch[]) {
            let queued = false
            if (useBatch) {
                for (const patch of value as readonly StorePatch[]) queued = queuePatch(patch) || queued
            } else queued = queuePatch(value as StorePatch)
            if (queued && !initializing) drained.push()
        }

        const off = subscribeRemote(patchListen, handleRemoteStorePatches)
        try {
            if (initializing) await pull(baseMask)
            initializing = false
            if (pending.length) drained.push()
        } catch (error) {
            drained.close()
            off()
            throw error
        }
        return function closeStorePatchSync() {
            drained.close()
            off()
        }
    }

    async function syncChangedData<M extends StoreMask<T>>(mask: M, subOpts: StoreSyncOpts = {current: true}) {
        const canWaitForSchema = subOpts.current !== false
        const changedDataSchema = canWaitForSchema ? waitForRemoteSchema('changedData') : undefined
        if (changedDataSchema) await changedDataSchema
        if (!remoteListenAvailable('changedData', remote.changedData, !canWaitForSchema)) {
            throw new Error("createStoreMirror.syncChangedData: remote.changedData is not exposed")
        }
        const baseMask = mask ?? true
        const report = makeReport(subOpts)
        let initializing = subOpts.current !== false
        const pending: StoreChangedData[] = []
        const drained = createDrained(function applyPendingStoreChangedData() {
            const batch = pending.splice(0)
            try {
                for (const change of batch) {
                    const nextMask = intersectMaskWithPaths(baseMask, maskPaths(change?.mask ?? true))
                    if (nextMask !== undefined) applyMask(store.state, nextMask, change.data)
                }
            } catch (e) { report(e) }
        }, subOpts.drain)

        function handleRemoteStoreChangedData(change: StoreChangedData) {
            pending.push(change)
            if (!initializing) drained.push()
        }

        const off = subscribeRemote(remote.changedData, handleRemoteStoreChangedData)
        try {
            if (initializing) await pull(baseMask)
            initializing = false
            if (pending.length) drained.push()
        } catch (error) {
            drained.close()
            off()
            throw error
        }
        return function closeStoreChangedDataSync() {
            drained.close()
            off()
        }
    }

    return Object.assign(store, {sync, syncPatches, syncChangedData})
}
