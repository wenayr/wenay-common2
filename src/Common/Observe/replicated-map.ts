// =====================================================================
// Replicated Map — high-level keyed collection over Store Replay
// =====================================================================

import {LISTEN_DISPATCH_ERROR, listen, listenStore} from '../events/Listen'
import {readReplayDescriptor} from '../events/replay-wire'
import {getRpcTransportLifecycle} from '../events/transport-lifecycle'
import {isSafeKey} from '../rcp/rpc-limits'
import {cloneStoreProjectionValue} from './store-projection'
import {createStore, listenStorePatches, Store, StoreDrain, StorePatch} from './store'
import {
    exposeStoreReplay, StoreReplayOpts, StoreReplayRemote, StoreReplaySyncOpts,
    storeReplayMode, syncStoreReplay, tStoreReplayMode,
} from './store-replay'
import {toRaw} from './reactive'
import {compareDeepValues} from '../core/deep-equal'

// ============================================================
// public contract
// ============================================================

export type tReplicatedMapDelivery = 'latest' | 'lossless'

export type ReplicatedMapState<V, K extends string = string> = Partial<Record<K, V>>

export type ReplicatedMapSetOperation<V, K extends string = string> = {
    type: 'set'
    key: K
    value: V
}

export type ReplicatedMapDeleteOperation<K extends string = string> = {
    type: 'delete'
    key: K
}

export type ReplicatedMapOperation<V, K extends string = string> =
    | ReplicatedMapSetOperation<V, K>
    | ReplicatedMapDeleteOperation<K>

export type ReplicatedMapChange<V, K extends string = string> = {
    delivery: tReplicatedMapDelivery
    /** Convenience projection for table/rendering code. Ordered within set operations. */
    set: readonly (readonly [key: K, value: V])[]
    /** Keys deleted by this envelope. Ordered within delete operations. */
    delete: readonly K[]
    /** Complete cross-kind order; lossless mode keeps every producer operation here. */
    operations: readonly ReplicatedMapOperation<V, K>[]
}

export type ReplicatedMapKeyContext<K extends string = string> = {
    key: K
    exists: boolean
}

export type tReplicatedMapFollowState = 'connecting' | 'live' | 'reconnecting' | 'stale' | 'error' | 'closed'

export type ReplicatedMapStatus = {
    state: tReplicatedMapFollowState
    ready: boolean
    stale: boolean
    delivery: tReplicatedMapDelivery
    replayMode: tStoreReplayMode
    seq: number
    error: unknown | null
}

export type ReplicatedMapCursor = Pick<ReplicatedMapStatus, 'delivery' | 'replayMode' | 'seq'> & {
    /** Identity of this exact replay sequence space; changes when a fresh journal starts. */
    lineId: string
}

export type ReplicatedMapCheckpoint<V, K extends string = string> = {
    cursor: ReplicatedMapCursor
    snapshot: ReplicatedMapState<V, K>
}

export type ReplicatedMapDescriptor<V = unknown, K extends string = string> = {
    version: 1
    delivery: tReplicatedMapDelivery
    lineId: string
    /** Type-only inference carrier. It is deliberately absent from the runtime descriptor. */
    types?: {value: V, key: K}
}

export type ReplicatedMapWireDescriptor<V = unknown, K extends string = string> = Record<string, any> & {
    replicatedMap: ReplicatedMapDescriptor<V, K>
}

/** Store Replay wire with value/key types carried by its real descriptor method. */
export type ReplicatedMapRemote<V, K extends string = string> = Omit<StoreReplayRemote, 'describe'> & {
    describe(): ReplicatedMapWireDescriptor<V, K> | Promise<ReplicatedMapWireDescriptor<V, K>>
}

type ReplicatedMapOwnedDeps<V> = {
    initial?: Iterable<V>
    store?: never
}

type ReplicatedMapInjectedDeps<V, K extends string> = {
    initial?: never
    store: Store<ReplicatedMapState<V, K>>
    delivery: 'latest'
}

export type CreateReplicatedMapDeps<V, K extends string = string> = (
    | ReplicatedMapOwnedDeps<V>
    | ReplicatedMapInjectedDeps<V, K>
) & {
    keyOf(value: V): K
    delivery: tReplicatedMapDelivery
    /** Advanced stable identity only when the same replay seq-space is durably restored. */
    lineId?: string
    /** Advanced Store Replay journal/batch configuration. The facade owns patchSource/descriptor. */
    replay?: Omit<StoreReplayOpts, 'patchSource' | 'describe'> & {describe?: Record<string, any>}
}

type FollowReplicatedMapBaseOpts<V, K extends string> = Omit<
    StoreReplaySyncOpts<ReplicatedMapState<V, K>>,
    'onBatch' | 'policy' | 'catchUp' | 'gapPolicy' | 'prepareCatchUp' | 'since'
> & {
    /** Override only for a legacy remote without a Replicated Map descriptor. */
    delivery?: tReplicatedMapDelivery
    /** Advanced local notification scheduling; replication batching is unaffected. */
    drain?: StoreDrain
    /** One materialized bounded wire envelope; replay limits may split or merge producer operations. */
    onBatch?: (change: ReplicatedMapChange<V, K>) => void
    onStatus?: (status: ReplicatedMapStatus) => void
}

type ReplicatedMapColdFollow<V, K extends string> = {
    initial?: Readonly<ReplicatedMapState<V, K>>
    checkpoint?: never
}

type ReplicatedMapCheckpointFollow<V, K extends string> = {
    initial?: never
    /** Snapshot and replay coordinate are inseparable: a tail alone cannot materialize a map. */
    checkpoint: ReplicatedMapCheckpoint<V, K>
}

export type FollowReplicatedMapOpts<V, K extends string = string> = FollowReplicatedMapBaseOpts<V, K> & (
    | ReplicatedMapColdFollow<V, K>
    | ReplicatedMapCheckpointFollow<V, K>
)

// ============================================================
// value/key/descriptor utilities
// ============================================================

type ValueEntry<V, K extends string> = {key: K, value: V}

function owns(value: object, key: PropertyKey) {
    return Object.prototype.hasOwnProperty.call(value, key)
}

function requireReplicatedMapKey<K extends string>(key: unknown): K {
    if (typeof key != 'string') throw new TypeError('replicated map key must be a string')
    if (!isSafeKey(key)) throw new TypeError(`replicated map key is not wire-safe: ${key}`)
    return key as K
}

function requireReplicatedMapLineId(value: unknown) {
    if (typeof value != 'string' || value.length == 0) {
        throw new TypeError('replicated map lineId must be a non-empty string')
    }
    return value
}

function createReplicatedMapLineId() {
    const random = Math.random().toString(36).slice(2)
    return `map-${Date.now().toString(36)}-${random}`
}

function emptyReplicatedMapState<V, K extends string>() {
    return Object.create(null) as ReplicatedMapState<V, K>
}

function requireReplicatedMapOwnKey<K extends string>(value: object, key: PropertyKey) {
    if (typeof key != 'string') throw new TypeError('replicated map root accepts only string keys')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError('replicated map root accepts only enumerable data keys')
    }
    return requireReplicatedMapKey<K>(key)
}

function requireReplicatedMapRoot(value: unknown) {
    if (value == null || typeof value != 'object' || Array.isArray(value)) {
        throw new TypeError('replicated map root must be a keyed object')
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype != null && prototype != Object.prototype) {
        throw new TypeError('replicated map root must be a plain keyed object')
    }
    return value
}

function replicatedMapKeys<K extends string>(value: unknown) {
    const root = requireReplicatedMapRoot(value)
    const keys: K[] = []
    for (const key of Reflect.ownKeys(root)) keys.push(requireReplicatedMapOwnKey<K>(root, key))
    return keys
}

function collectValues<V, K extends string>(values: Iterable<V>, keyOf: (value: V) => K) {
    const entries: ValueEntry<V, K>[] = []
    for (const value of values) {
        entries.push({
            key: requireReplicatedMapKey<K>(keyOf(value)),
            value: cloneStoreProjectionValue(value),
        })
    }
    return entries
}

function lastRawValuesByKey<V, K extends string>(values: Iterable<V>, keyOf: (value: V) => K) {
    const latest = new Map<K, V>()
    for (const value of values) {
        const key = requireReplicatedMapKey<K>(keyOf(value))
        latest.delete(key)
        latest.set(key, value)
    }
    return [...latest].map(function mapLatestRawValue([key, value]) { return {key, value} })
}

function lastValuesByKey<V, K extends string>(entries: readonly ValueEntry<V, K>[]) {
    const latest = new Map<K, V>()
    for (const entry of entries) {
        latest.delete(entry.key)
        latest.set(entry.key, entry.value)
    }
    return [...latest].map(function mapLatestValue([key, value]) { return {key, value} })
}

function copyInitialState<V, K extends string>(initial: Readonly<ReplicatedMapState<V, K>> | undefined) {
    const state = emptyReplicatedMapState<V, K>()
    if (!initial) return state
    for (const safeKey of replicatedMapKeys<K>(initial)) {
        state[safeKey] = cloneStoreProjectionValue(initial[safeKey])
    }
    return state
}

function replicatedMapDescriptor(descriptor: Record<string, any> | null) {
    const map = descriptor?.['replicatedMap'] as Partial<ReplicatedMapDescriptor> | undefined
    if (map?.version == 1 && (map.delivery == 'latest' || map.delivery == 'lossless')
        && typeof map.lineId == 'string' && map.lineId.length > 0) {
        return map as ReplicatedMapDescriptor
    }
    return undefined
}

function copyStatus(status: ReplicatedMapStatus): ReplicatedMapStatus {
    return {...status}
}

function operationsChange<V, K extends string>(
    delivery: tReplicatedMapDelivery,
    operations: ReplicatedMapOperation<V, K>[],
): ReplicatedMapChange<V, K> {
    const set: (readonly [K, V])[] = []
    const deleted: K[] = []
    for (const operation of operations) {
        if (operation.type == 'set') set.push([operation.key, operation.value])
        else deleted.push(operation.key)
    }
    return {delivery, set, delete: deleted, operations}
}

// ============================================================
// producer: authority + Store Replay resource
// ============================================================

export function createReplicatedMap<V, K extends string = string>(deps: CreateReplicatedMapDeps<V, K>) {
    const uncheckedDeps = deps as {store?: unknown, delivery: tReplicatedMapDelivery}
    if (uncheckedDeps.store && uncheckedDeps.delivery == 'lossless') {
        throw new Error('lossless replicated map must own its Store')
    }
    const initialEntries = collectValues(deps.store ? [] : (deps.initial ?? []), deps.keyOf)
    const initialState = emptyReplicatedMapState<V, K>()
    for (const entry of initialEntries) initialState[entry.key] = entry.value

    const store = deps.store ?? createStore(initialState)
    const [emitPatches, patchSource] = listen<[readonly StorePatch[]]>()
    const ownsPatchSource = deps.store == undefined
    const replayOpts = deps.replay ?? {}
    const lineId = requireReplicatedMapLineId(deps.lineId ?? createReplicatedMapLineId())
    const descriptor = {
        ...replayOpts.describe,
        replicatedMap: {version: 1, delivery: deps.delivery, lineId} satisfies ReplicatedMapDescriptor<V, K>,
    }
    validateState(rawState())
    let lastPublishedState = store.snapshot()
    const exposed = exposeStoreReplay(store, {
        ...replayOpts,
        describe: descriptor,
        patchSource,
    })
    let closed = false

    function ensureOpen() {
        if (closed) throw new Error('replicated map is closed')
    }

    function rawState() {
        return toRaw(store.state) as ReplicatedMapState<V, K>
    }

    function validateValueKey(key: K, value: V) {
        if (requireReplicatedMapKey<K>(deps.keyOf(value)) != key) {
            throw new Error(`replicated map store key does not match keyOf(value): ${key}`)
        }
    }

    function validateState(state: Readonly<ReplicatedMapState<V, K>>) {
        for (const safeKey of replicatedMapKeys<K>(state)) {
            validateValueKey(safeKey, state[safeKey] as V)
        }
    }

    function normalizeInjectedPatches(patches: readonly StorePatch[]) {
        const state = rawState()
        if (patches.some(function hasRootStorePatch(patch) { return patch.path.length == 0 })) {
            validateState(state)
            const snapshot = store.snapshot()
            return [{path: [], exists: true, value: snapshot}] satisfies StorePatch[]
        }
        const touched = new Map<K, true>()
        for (const patch of patches) {
            const key = requireReplicatedMapKey<K>(patch.path[0])
            touched.delete(key)
            touched.set(key, true)
        }
        const normalized: StorePatch[] = []
        for (const key of touched.keys()) {
            if (!owns(state, key)) {
                normalized.push({path: [key], exists: false, value: undefined})
                continue
            }
            requireReplicatedMapOwnKey<K>(state, key)
            const value = state[key] as V
            validateValueKey(key, value)
            normalized.push({path: [key], exists: true, value: cloneStoreProjectionValue(value)})
        }
        return normalized
    }

    const offInjectedStore = ownsPatchSource
        ? function noInjectedStoreListener() {}
        : listenStorePatches(store).on(function forwardInjectedStorePatches(patches) {
            const normalized = normalizeInjectedPatches(patches)
            emitPatches(normalized)
            lastPublishedState = store.snapshot()
        })

    // ============== producer business operations ==============

    function publish(patches: StorePatch[]) {
        if (patches.length == 0) {
            // A repeated equal write is also the natural retry after a retained precommit failure.
            exposed.flushPending()
            return
        }
        if (ownsPatchSource) emitPatches(patches)
    }

    function applyOwnedEntries(entries: readonly ValueEntry<V, K>[]) {
        const patches: StorePatch[] = []
        for (const entry of entries) {
            store.state[entry.key] = entry.value
            patches.push({path: [entry.key], exists: true, value: cloneStoreProjectionValue(entry.value)})
        }
        publish(patches)
    }

    function collectLatestChanges(values: Iterable<V>) {
        const winners = lastRawValuesByKey(values, deps.keyOf)
        const state = rawState()
        const changes: ValueEntry<V, K>[] = []
        for (const entry of winners) {
            if (owns(state, entry.key) && compareDeepValues(state[entry.key], entry.value)) continue
            changes.push({key: entry.key, value: cloneStoreProjectionValue(entry.value)})
        }
        return changes
    }

    function applyValues(values: Iterable<V>) {
        const entries = deps.delivery == 'latest'
            ? collectLatestChanges(values)
            : collectValues(values, deps.keyOf)
        applyOwnedEntries(entries)
    }

    function set(value: V) {
        ensureOpen()
        applyValues([value])
    }

    function setMany(values: Iterable<V>) {
        ensureOpen()
        applyValues(values)
    }

    function deleteKey(key: K) {
        deleteMany([key])
    }

    function deleteMany(keys: Iterable<K>) {
        ensureOpen()
        const safeKeys = [...keys].map(function validateDeleteKey(key) {
            return requireReplicatedMapKey<K>(key)
        })
        const state = rawState()
        const patches: StorePatch[] = []
        for (const key of safeKeys) {
            if (!owns(state, key)) continue
            delete store.state[key]
            patches.push({path: [key], exists: false, value: undefined})
        }
        publish(patches)
    }

    function replaceAll(values: Iterable<V>) {
        ensureOpen()
        if (deps.delivery == 'latest') {
            const entries = lastRawValuesByKey(values, deps.keyOf)
            const nextKeys = new Set<K>()
            const current = rawState()
            const changes: ValueEntry<V, K>[] = []
            for (const entry of entries) {
                nextKeys.add(entry.key)
                if (owns(current, entry.key) && compareDeepValues(current[entry.key], entry.value)) continue
                changes.push({key: entry.key, value: cloneStoreProjectionValue(entry.value)})
            }

            const deleted: K[] = []
            for (const safeKey of replicatedMapKeys<K>(current)) {
                if (!nextKeys.has(safeKey)) deleted.push(safeKey)
            }
            const patches: StorePatch[] = deleted.map(function deleteReplicatedMapEntry(key) {
                return {path: [key], exists: false, value: undefined}
            })
            for (const entry of changes) {
                patches.push({
                    path: [entry.key],
                    exists: true,
                    value: cloneStoreProjectionValue(entry.value),
                })
            }

            for (const key of deleted) delete store.state[key]
            for (const entry of changes) store.state[entry.key] = entry.value
            publish(patches)
            return
        }

        const entries = collectValues(values, deps.keyOf)
        const finalEntries = lastValuesByKey(entries)
        const next = emptyReplicatedMapState<V, K>()
        for (const entry of finalEntries) next[entry.key] = entry.value

        const current = rawState()
        const patches: StorePatch[] = []
        for (const safeKey of replicatedMapKeys<K>(current)) {
            if (!owns(next, safeKey)) patches.push({path: [safeKey], exists: false, value: undefined})
        }
        for (const entry of entries) {
            patches.push({path: [entry.key], exists: true, value: cloneStoreProjectionValue(entry.value)})
        }
        store.replace(next)
        publish(patches)
    }

    function has(key: K) {
        return owns(rawState(), requireReplicatedMapKey<K>(key))
    }

    function get(key: K) {
        const safeKey = requireReplicatedMapKey<K>(key)
        const state = rawState()
        return owns(state, safeKey) ? cloneStoreProjectionValue(state[safeKey]) : undefined
    }

    function snapshot() {
        validateState(rawState())
        return store.snapshot()
    }

    function close() {
        if (closed) return
        if (!ownsPatchSource) {
            validateState(rawState())
            const current = store.snapshot()
            if (!compareDeepValues(lastPublishedState, current)) {
                emitPatches([{path: [], exists: true, value: current}])
                lastPublishedState = current
            }
        }
        exposed.flushPending()
        closed = true
        offInjectedStore()
        exposed.close()
        patchSource.close()
    }

    function flush() {
        ensureOpen()
        exposed.flushPending()
    }

    return {
        api: exposed.api.replay as unknown as ReplicatedMapRemote<V, K>,
        control: {
            set,
            setMany,
            delete: deleteKey,
            deleteMany,
            replaceAll,
            has,
            get,
            snapshot,
            flush,
            close,
        },
    }
}

// ============================================================
// follower: materialized Store + lifecycle
// ============================================================

export function followReplicatedMap<V, K extends string = string>(
    remote: ReplicatedMapRemote<V, K> | StoreReplayRemote,
    opts: FollowReplicatedMapOpts<V, K> = {},
) {
    const {
        initial, drain, onBatch, onStatus, delivery: requestedDelivery,
        checkpoint, onSeq, onError, onLive, onStale, validateBatch, ...wireOpts
    } = opts
    const requestedCursor = checkpoint?.cursor
    const store = createStore<ReplicatedMapState<V, K>>(
        copyInitialState<V, K>(checkpoint?.snapshot ?? initial),
        drain !== undefined ? {drain} : {},
    )
    let delivery: tReplicatedMapDelivery = requestedDelivery ?? requestedCursor?.delivery ?? 'latest'
    let lineId = requestedCursor?.lineId ?? ''
    let sync: ReturnType<typeof syncStoreReplay<ReplicatedMapState<V, K>>> | undefined
    let closed = false
    let failed = false
    let liveOnce = false
    let resolveClosed = function resolveClosedLater() {}
    const closedFirst = new Promise<'closed'>(function waitForReplicatedMapClose(resolve) {
        resolveClosed = function settleReplicatedMapClose() { resolve('closed') }
    })
    let status: ReplicatedMapStatus = {
        state: 'connecting', ready: false, stale: false, delivery,
        replayMode: 'v2', seq: requestedCursor?.seq ?? -1, error: null,
    }

    function reportConsumerError(error: unknown) {
        setTimeout(function rethrowReplicatedMapConsumerError() { throw error }, 0)
    }

    const dispatchOptions = {[LISTEN_DISPATCH_ERROR]: reportConsumerError}
    const [emitBatch, batches] = listen<[ReplicatedMapChange<V, K>]>(dispatchOptions)
    const [emitKey, keys] = listen<[K, V | undefined, ReplicatedMapKeyContext<K>]>(dispatchOptions)
    const [emitStatus, statusChanges] = listenStore<[ReplicatedMapStatus]>({
        ...dispatchOptions,
        current: function currentReplicatedMapStatus() { return [copyStatus(status)] },
    })

    function setStatus(patch: Partial<ReplicatedMapStatus>) {
        const next = {...status, ...patch}
        if (next.state == status.state && next.ready == status.ready && next.stale == status.stale
            && next.delivery == status.delivery && next.replayMode == status.replayMode
            && next.seq == status.seq && next.error == status.error) return
        status = next
        emitStatus(copyStatus(status))
    }

    if (onBatch) batches.on(onBatch)
    if (onStatus) {
        try { onStatus(copyStatus(status)) }
        catch (error) { reportConsumerError(error) }
        statusChanges.on(onStatus)
    }

    const knownKeys = new Set<K>(replicatedMapKeys<K>(toRaw(store.state)))
    const pendingChanges: (ReplicatedMapChange<V, K> | undefined)[] = []

    function validateReplicatedMapPatches(patches: readonly StorePatch[]) {
        for (const patch of patches) {
            if (patch.path.length == 0) {
                if (!patch.exists) continue
                replicatedMapKeys<K>(patch.value)
                continue
            }
            if (patch.path.length != 1) {
                throw new TypeError('replicated map accepts only root or top-level patches')
            }
            requireReplicatedMapKey<K>(patch.path[0])
        }
        validateBatch?.(patches, store)
    }

    // ============== public change projection ==============

    function replaceKnownKeys(keys = replicatedMapKeys<K>(toRaw(store.state))) {
        knownKeys.clear()
        for (const key of keys) knownKeys.add(key)
    }

    function touchKey(touched: Map<K, true>, key: K) {
        touched.delete(key)
        touched.set(key, true)
    }

    function latestChange(patches: readonly StorePatch[]) {
        const touched = new Map<K, true>()
        const state = toRaw(store.state) as ReplicatedMapState<V, K>
        let rootKeys: K[] | undefined
        for (const patch of patches) {
            if (patch.path.length == 0) {
                rootKeys ??= replicatedMapKeys<K>(state)
                for (const key of knownKeys) touchKey(touched, key)
                for (const key of rootKeys) touchKey(touched, key)
                continue
            }
            touchKey(touched, requireReplicatedMapKey<K>(patch.path[0]))
        }
        const operations: ReplicatedMapOperation<V, K>[] = []
        for (const key of touched.keys()) {
            if (owns(state, key)) {
                operations.push({type: 'set', key, value: cloneStoreProjectionValue(state[key] as V)})
            } else operations.push({type: 'delete', key})
        }
        if (rootKeys) replaceKnownKeys(rootKeys)
        else for (const key of touched.keys()) {
            if (owns(state, key)) knownKeys.add(key)
            else knownKeys.delete(key)
        }
        return operationsChange('latest', operations)
    }

    function losslessChange(patches: readonly StorePatch[]) {
        const operations: ReplicatedMapOperation<V, K>[] = []
        for (const patch of patches) {
            if (patch.path.length == 0) {
                const root = patch.exists && patch.value != null && typeof patch.value == 'object'
                    ? patch.value as Record<string, V>
                    : {}
                const nextKeys = new Set<K>()
                for (const key of replicatedMapKeys<K>(root)) nextKeys.add(key)
                for (const key of knownKeys) if (!nextKeys.has(key)) operations.push({type: 'delete', key})
                for (const key of nextKeys) {
                    operations.push({type: 'set', key, value: cloneStoreProjectionValue(root[key])})
                }
                knownKeys.clear()
                for (const key of nextKeys) knownKeys.add(key)
                continue
            }
            if (patch.path.length != 1) {
                throw new Error('lossless replicated map accepts only root or top-level patches')
            }
            const key = requireReplicatedMapKey<K>(patch.path[0])
            if (patch.exists) {
                operations.push({type: 'set', key, value: cloneStoreProjectionValue(patch.value)})
                knownKeys.add(key)
            } else {
                operations.push({type: 'delete', key})
                knownKeys.delete(key)
            }
        }
        return operationsChange('lossless', operations)
    }

    function trackKnownKeys(patches: readonly StorePatch[]) {
        const state = toRaw(store.state) as ReplicatedMapState<V, K>
        for (const patch of patches) {
            if (patch.path.length == 0) {
                replaceKnownKeys()
                return
            }
            const key = requireReplicatedMapKey<K>(patch.path[0])
            if (owns(state, key)) knownKeys.add(key)
            else knownKeys.delete(key)
        }
    }

    function receivePatches(patches: readonly StorePatch[]) {
        if (batches.count() == 0) {
            trackKnownKeys(patches)
            pendingChanges.push(undefined)
            return
        }
        pendingChanges.push(delivery == 'lossless' ? losslessChange(patches) : latestChange(patches))
    }

    const offEach = store.each().on(function forwardReplicatedMapKey(key, _value) {
        if (keys.count() == 0) return
        const safeKey = requireReplicatedMapKey<K>(key)
        const state = toRaw(store.state) as ReplicatedMapState<V, K>
        const exists = owns(state, safeKey)
        emitKey(
            safeKey,
            exists ? cloneStoreProjectionValue(state[safeKey]) : undefined,
            {key: safeKey, exists},
        )
    })

    function reportSyncError(error: unknown) {
        if (closed) return
        failed = true
        setStatus({state: 'error', error})
        if (!onError) return
        try { onError(error) }
        catch (caught) { reportConsumerError(caught) }
    }

    // ============== transport and recovery lifecycle ==============

    function trackSeq(seq: number) {
        setStatus({seq, replayMode: sync?.mode ?? status.replayMode})
        const change = pendingChanges.shift()
        if (change) emitBatch(change)
        if (!onSeq) return
        try { onSeq(seq) }
        catch (error) { reportConsumerError(error) }
    }

    function reportLive() {
        liveOnce = true
        setStatus({state: sync?.isStale() ? 'stale' : 'live', ready: true, stale: sync?.isStale() ?? false, error: null})
        if (!onLive) return
        try { onLive() }
        catch (error) { reportConsumerError(error) }
    }

    function reportStale(info: Parameters<NonNullable<StoreReplaySyncOpts['onStale']>>[0]) {
        setStatus({state: info.stale ? 'stale' : 'live', stale: info.stale})
        if (!onStale) return
        try { onStale(info) }
        catch (error) { reportConsumerError(error) }
    }

    const lifecycle = getRpcTransportLifecycle(remote)
    const offDisconnect = lifecycle?.onDisconnect(function replicatedMapDisconnected() {
        if (!closed && !failed) setStatus({state: 'reconnecting'})
    }) ?? function noDisconnectListener() {}
    const offConnect = lifecycle?.onConnect(function replicatedMapConnected() {
        if (!closed && !failed) setStatus({state: liveOnce ? 'reconnecting' : 'connecting'})
    }) ?? function noConnectListener() {}
    const offTransportClose = lifecycle?.onClose(function replicatedMapTransportClosed() {
        close()
    }) ?? function noTransportCloseListener() {}

    function waitForTransportConnect() {
        if (!lifecycle || lifecycle.closed()) return Promise.resolve(false)
        if (lifecycle.connected()) return Promise.resolve(true)
        return new Promise<boolean>(function waitForReplicatedMapTransport(resolve) {
            let settled = false
            let offReady = function offReadyLater() {}
            let offClosed = function offClosedLater() {}
            function finish(connected: boolean) {
                if (settled) return
                settled = true
                offReady()
                offClosed()
                resolve(connected)
            }
            offReady = lifecycle.onConnect(function replicatedMapTransportReady() { finish(true) })
            offClosed = lifecycle.onClose(function replicatedMapTransportGone() { finish(false) })
            if (lifecycle.closed()) finish(false)
            else if (lifecycle.connected()) finish(true)
        })
    }

    async function readInitialDescriptor() {
        while (!closed) {
            if (lifecycle?.closed()) throw new Error('replicated map transport is already closed')
            const generation = lifecycle?.generation()
            try {
                const descriptor = await readReplayDescriptor(remote)
                if (!lifecycle) return descriptor
                if (lifecycle.closed()) throw new Error('replicated map transport closed during descriptor read')
                if (lifecycle.generation() == generation && lifecycle.connected()) return descriptor
                if (!await waitForTransportConnect()) {
                    throw new Error('replicated map transport closed during descriptor retry')
                }
            }
            catch (error) {
                if (!lifecycle) throw error
                if (lifecycle.closed()) throw error
                if (lifecycle.generation() != generation) continue
                if (lifecycle.connected()) throw error
                if (!await waitForTransportConnect()) throw error
            }
        }
        return null
    }

    async function prepareReplicatedMapCatchUp(context: {initial: boolean, since: number}) {
        const phase = context.initial ? 'before initial catch-up' : 'on reconnect'
        const nextWireDescriptor = await readReplayDescriptor(remote)
        const next = replicatedMapDescriptor(nextWireDescriptor)
        if (next && next.delivery != delivery) {
            throw new Error(`replicated map delivery changed ${phase}: ${delivery} -> ${next.delivery}`)
        }
        if (!next && delivery == 'lossless') {
            throw new Error(`lossless replicated map lost its producer descriptor ${phase}`)
        }
        const nextMode = storeReplayMode()
        if (nextMode != replayMode()) {
            throw new Error(`replicated map replay mode changed ${phase}: ${replayMode()} -> ${nextMode}`)
        }
        if (next?.lineId == lineId) return
        if (delivery == 'lossless') {
            throw new Error(
                `lossless replicated map replay line changed ${phase}: ${lineId} -> ${next?.lineId ?? 'unknown'}`,
            )
        }
        lineId = next?.lineId ?? ''
        setStatus({seq: -1})
        return {reset: true}
    }

    async function start() {
        const descriptorReady = readInitialDescriptor().then(
            function replicatedMapDescriptorReady(value) { return {state: 'ready' as const, value} },
            function replicatedMapDescriptorFailed(error) { return {state: 'error' as const, error} },
        )
        const negotiated = await Promise.race([
            descriptorReady,
            closedFirst.then(function replicatedMapClosedBeforeDescriptor() { return {state: 'closed' as const} }),
        ])
        if (negotiated.state == 'closed' || closed) return
        if (negotiated.state == 'error') { reportSyncError(negotiated.error); return }

        if (requestedCursor && (!Number.isInteger(requestedCursor.seq) || requestedCursor.seq < -1)) {
            reportSyncError(new TypeError('replicated map cursor seq must be an integer greater than or equal to -1'))
            return
        }
        if (requestedCursor) {
            try { requireReplicatedMapLineId(requestedCursor.lineId) }
            catch (error) { reportSyncError(error); return }
        }
        if (requestedDelivery && requestedCursor && requestedDelivery != requestedCursor.delivery) {
            reportSyncError(new Error(
                `replicated map delivery mismatch: requested ${requestedDelivery}, cursor ${requestedCursor.delivery}`,
            ))
            return
        }

        const preferredDelivery = requestedDelivery ?? requestedCursor?.delivery
        const declared = replicatedMapDescriptor(negotiated.value)
        const declaredDelivery = declared?.delivery
        if (preferredDelivery == 'lossless' && !declared) {
            reportSyncError(new Error('lossless replicated map requires a compatible producer descriptor'))
            return
        }
        if (preferredDelivery && declaredDelivery && preferredDelivery != declaredDelivery) {
            reportSyncError(new Error(`replicated map delivery mismatch: requested ${preferredDelivery}, remote ${declaredDelivery}`))
            return
        }
        delivery = preferredDelivery ?? declaredDelivery ?? 'latest'
        lineId = declared?.lineId ?? ''

        const replayMode = storeReplayMode()
        if (requestedCursor && requestedCursor.delivery != delivery) {
            reportSyncError(new Error(
                `replicated map delivery mismatch: cursor ${requestedCursor.delivery}, remote ${delivery}`,
            ))
            return
        }
        if (requestedCursor && requestedCursor.lineId != lineId && delivery == 'lossless') {
            reportSyncError(new Error(
                `lossless replicated map cannot resume another replay line: ${requestedCursor.lineId} -> ${lineId || 'unknown'}`,
            ))
            return
        }
        if (requestedCursor && requestedCursor.replayMode != replayMode && delivery == 'lossless') {
            reportSyncError(new Error(
                `lossless replicated map cannot translate a ${requestedCursor.replayMode} cursor to ${replayMode}`,
            ))
            return
        }
        const sameCheckpointSpace = requestedCursor?.lineId == lineId && requestedCursor.replayMode == replayMode
        const since = sameCheckpointSpace ? requestedCursor!.seq : -1
        setStatus({delivery, replayMode, seq: since})

        try {
            sync = syncStoreReplay(store, remote, {
                ...wireOpts,
                since,
                policy: delivery == 'latest' ? 'frame' : 'queue',
                catchUp: delivery == 'latest' ? 'frame' : 'tail',
                gapPolicy: delivery == 'latest' ? 'keyframe' : 'error',
                prepareCatchUp: prepareReplicatedMapCatchUp,
                validateBatch: validateReplicatedMapPatches,
                onBatch: receivePatches,
                onSeq: trackSeq,
                onError: reportSyncError,
                onLive: reportLive,
                onStale: reportStale,
            })
            await Promise.race([sync.ready, closedFirst])
        } catch (error) {
            if (!closed && !failed) reportSyncError(error)
        }
    }

    const ready = start()

    // ============== materialized read API ==============

    function get(key: K) {
        const safeKey = requireReplicatedMapKey<K>(key)
        const state = toRaw(store.state) as ReplicatedMapState<V, K>
        return owns(state, safeKey) ? cloneStoreProjectionValue(state[safeKey]) : undefined
    }

    function has(key: K) {
        return owns(toRaw(store.state), requireReplicatedMapKey<K>(key))
    }

    function snapshot() {
        return store.snapshot()
    }

    function onKey(
        key: K,
        cb: (value: V | undefined, ctx: ReplicatedMapKeyContext<K>) => void,
        keyOpts: {current?: boolean} = {},
    ) {
        if (closed) throw new Error('replicated map follower is closed')
        const safeKey = requireReplicatedMapKey<K>(key)
        const off = keys.on(function forwardSelectedReplicatedMapKey(changedKey, value, ctx) {
            if (changedKey == safeKey) cb(value, ctx)
        })
        if (keyOpts.current) {
            try { cb(get(safeKey), {key: safeKey, exists: has(safeKey)}) }
            catch (error) { reportConsumerError(error) }
        }
        return off
    }

    function currentStatus() {
        return copyStatus(status)
    }

    function seq() {
        return sync?.seq() ?? status.seq
    }

    function replayMode() {
        return sync?.mode ?? status.replayMode
    }

    function checkpointSnapshot(): ReplicatedMapCheckpoint<V, K> {
        if (!lineId) throw new Error('replicated map remote has no safe checkpoint identity')
        return {
            cursor: {lineId, delivery, replayMode: replayMode(), seq: seq()},
            snapshot: snapshot(),
        }
    }

    function isStale() {
        return sync?.isStale() ?? status.stale
    }

    function close() {
        if (closed) return
        closed = true
        resolveClosed()
        offConnect()
        offDisconnect()
        offTransportClose()
        sync?.()
        pendingChanges.length = 0
        offEach()
        setStatus({state: 'closed'})
        batches.close()
        keys.close()
        statusChanges.close()
    }

    return {
        get,
        has,
        snapshot,
        onKey,
        batches,
        keys,
        ready,
        status: currentStatus,
        statusChanges,
        seq,
        replayMode,
        delivery: () => delivery,
        checkpoint: checkpointSnapshot,
        isStale,
        close,
        /** Advanced local observation only; writes would violate remote ownership. */
        debug: {store},
    }
}

export type ReplicatedMap<V, K extends string = string> = ReturnType<typeof createReplicatedMap<V, K>>
export type FollowedReplicatedMap<V, K extends string = string> = ReturnType<typeof followReplicatedMap<V, K>>
