// =====================================================================
// Offline store — persisted mirror over store replay
// =====================================================================
// This layer owns durable cache mechanics, not UI state. React/app code should
// only choose resources and display status; patches, seq and write ordering stay
// near Observe/Replay where the invariants already exist.

import {clone} from '../core/common'
import {listenStore} from '../events/Listen'
import {getRpcSchemaReady} from '../events/transport-lifecycle'
import {createStore, Store} from './store'
import {
    storeReplayMode, syncStoreReplay, StoreReplayRemote, StoreReplaySyncOpts, tStoreReplayMode,
} from './store-replay'

export type OfflineStorage = {
    read<T>(key: string): Promise<T | undefined>
    write<T>(key: string, value: T): Promise<void>
    remove(key: string): Promise<void>
    transaction?<R>(fn: (tx: OfflineStorage) => Promise<R>): Promise<R>
}

export type OfflineStoreRecord<T extends object> = {
    version: number
    seq: number
    /** Sequence coordinates are not interchangeable between legacy and compact replay lines. */
    replayMode?: tStoreReplayMode
    snapshot: T
    savedAt: number
}

export type OfflineStoreStatus = {
    ready: boolean
    syncing: boolean
    offline: boolean
    stale: boolean
    saving: boolean
    seq: number
    savedAt?: number
    error?: unknown
}

export type PersistStoreOpts = {
    key: string
    storage: OfflineStorage
    version?: number
    seq?: number
    replayMode?: tStoreReplayMode
    savedAt?: number
    debounceMs?: number
    now?: () => number
    onError?: (error: unknown) => void
    onStatus?: (status: OfflineStoreStatus) => void
}

export type CreateOfflineStoreOpts<T extends object> = {
    key: string
    remote?: StoreReplayRemote
    initial: T
    storage: OfflineStorage
    version?: number
    debounceMs?: number
    mode?: 'snapshot' | 'topLevel'
    migrate?: (oldSnapshot: unknown, fromVersion: number, toVersion: number) => T | Promise<T>
    now?: () => number
    storeOpts?: Parameters<typeof createStore<T>>[1]
    syncOpts?: StoreReplaySyncOpts<T>
    onError?: (error: unknown) => void
    onStatus?: (status: OfflineStoreStatus) => void
}

export type PersistedStoreControl = ReturnType<typeof persistStore>
export type OfflineStore<T extends object> = Store<T> & {
    ready: Promise<void>
    close(): void
    flush(): Promise<void>
    status(): OfflineStoreStatus
    statusListen: PersistedStoreControl['statusListen']
    reconnect(remote: StoreReplayRemote, opts?: StoreReplaySyncOpts<T>): Promise<void>
}

type LoadedSnapshot<T extends object> = {
    snapshot: T
    seq: number
    replayMode: tStoreReplayMode
    savedAt?: number
}

function isRecord<T extends object>(v: any): v is OfflineStoreRecord<T> {
    return !!v && typeof v == 'object' && typeof v.version == 'number'
        && typeof v.seq == 'number' && 'snapshot' in v
}

function cloneValue<T>(value: T): T {
    return clone(value)
}

export function createMemoryOfflineStorage(initial?: Record<string, unknown>): OfflineStorage & {dump(): Record<string, unknown>} {
    const data = new Map<string, unknown>()
    for (const [k, v] of Object.entries(initial ?? {})) data.set(k, cloneValue(v))
    const api: OfflineStorage & {dump(): Record<string, unknown>} = {
        async read<T>(key: string) {
            return data.has(key) ? cloneValue(data.get(key)) as T : undefined
        },
        async write<T>(key: string, value: T) {
            data.set(key, cloneValue(value))
        },
        async remove(key: string) {
            data.delete(key)
        },
        async transaction<R>(fn: (tx: OfflineStorage) => Promise<R>) {
            return fn(api)
        },
        dump() {
            const out: Record<string, unknown> = {}
            for (const [k, v] of data) out[k] = cloneValue(v)
            return out
        },
    }
    return api
}

function emitError(opts: {onError?: (error: unknown) => void}, error: unknown) {
    if (opts.onError) opts.onError(error)
    else setTimeout(function rethrowOfflineStoreError() { throw error }, 0)
}

function copyStatus(status: OfflineStoreStatus): OfflineStoreStatus {
    return {...status}
}

export function persistStore<T extends object>(store: Store<T>, opts: PersistStoreOpts) {
    const {key, storage, version = 1, debounceMs = 250, now = Date.now, onStatus} = opts
    let seq = opts.seq ?? -1
    let replayMode = opts.replayMode ?? 'legacy'
    let savedAt = opts.savedAt
    let closed = false
    let dirty = false
    let timer: any = null
    let chain: Promise<void> = Promise.resolve()
    const status: OfflineStoreStatus = {
        ready: true,
        syncing: false,
        offline: false,
        stale: false,
        saving: false,
        seq,
        savedAt,
    }
    const [emitStatus, statusListen] = listenStore<[OfflineStoreStatus]>({
        current: () => [copyStatus(status)],
    })

    function updateStatus(patch: Partial<OfflineStoreStatus> = {}) {
        Object.assign(status, patch, {seq, savedAt})
        const snap = copyStatus(status)
        emitStatus(snap)
        onStatus?.(snap)
    }

    function clearTimer() {
        if (timer) clearTimeout(timer)
        timer = null
    }

    function scheduleSave() {
        if (closed) return
        dirty = true
        clearTimer()
        timer = setTimeout(function flushOfflineStoreTimer() {
            timer = null
            flush().catch(e => emitError(opts, e))
        }, Math.max(0, debounceMs))
        timer.unref?.()
    }

    async function writeRecord(record: OfflineStoreRecord<T>) {
        if (storage.transaction) {
            await storage.transaction(async function writeOfflineStoreTx(tx) {
                await tx.write(key, record)
            })
        } else {
            await storage.write(key, record)
        }
    }

    async function runFlush(force = false) {
        if (closed) return
        if (!dirty && !force) return
        dirty = false
        updateStatus({saving: true, error: undefined})
        const nextSavedAt = now()
        const record: OfflineStoreRecord<T> = {
            version,
            seq,
            replayMode,
            snapshot: store.snapshot(),
            savedAt: nextSavedAt,
        }
        try {
            await writeRecord(record)
            savedAt = nextSavedAt
            updateStatus({saving: false, error: undefined})
        } catch (e) {
            updateStatus({saving: false, error: e})
            throw e
        } finally {
            if (dirty && !closed) scheduleSave()
        }
    }

    function flush() {
        clearTimer()
        const task = chain.catch(() => {}).then(function flushOfflineStore() { return runFlush(false) })
        chain = task.catch(() => {})
        return task
    }

    function forceFlush() {
        clearTimer()
        dirty = true
        const task = chain.catch(() => {}).then(function forceFlushOfflineStore() { return runFlush(true) })
        chain = task.catch(() => {})
        return task
    }

    function setSeq(nextSeq: number) {
        if (nextSeq == seq) return
        seq = nextSeq
        updateStatus()
        scheduleSave()
    }

    function setReplayMode(nextMode: tStoreReplayMode) {
        if (nextMode == replayMode) return false
        replayMode = nextMode
        seq = -1
        updateStatus()
        scheduleSave()
        return true
    }

    const offStore = store.listenPaths().on(function persistStoreChange() {
        scheduleSave()
    })

    function close() {
        if (closed) return
        closed = true
        clearTimer()
        offStore()
        statusListen.close()
    }

    function setSyncStatus(patch: Partial<OfflineStoreStatus>) {
        updateStatus(patch)
    }

    return {
        flush,
        forceFlush,
        close,
        setSeq,
        setReplayMode,
        replayMode: () => replayMode,
        seq: () => seq,
        status: () => copyStatus(status),
        statusListen,
        setSyncStatus,
    }
}

async function loadSnapshot<T extends object>(opts: CreateOfflineStoreOpts<T>): Promise<LoadedSnapshot<T>> {
    const {key, storage, initial, version = 1, migrate} = opts
    const raw = await storage.read<unknown>(key)
    if (raw == null) return {snapshot: initial, seq: -1, replayMode: 'legacy'}
    if (isRecord<T>(raw)) {
        if (raw.version == version) return {
            snapshot: raw.snapshot, seq: raw.seq, replayMode: raw.replayMode ?? 'legacy', savedAt: raw.savedAt,
        }
        if (migrate) return {
            snapshot: await migrate(raw.snapshot, raw.version, version),
            seq: raw.seq,
            replayMode: raw.replayMode ?? 'legacy',
            savedAt: raw.savedAt,
        }
        return {snapshot: initial, seq: -1, replayMode: 'legacy'}
    }
    if (migrate) return {snapshot: await migrate(raw, 0, version), seq: -1, replayMode: 'legacy'}
    return {snapshot: initial, seq: -1, replayMode: 'legacy'}
}

export async function createOfflineStore<T extends object>(opts: CreateOfflineStoreOpts<T>): Promise<OfflineStore<T>> {
    const {remote, storeOpts, syncOpts = {}, onStatus} = opts
    if (opts.mode && opts.mode != 'snapshot') throw new Error('createOfflineStore: only snapshot mode is implemented')

    let loaded: LoadedSnapshot<T>
    try {
        loaded = await loadSnapshot(opts)
    } catch (e) {
        emitError(opts, e)
        loaded = {snapshot: opts.initial, seq: -1, replayMode: 'legacy'}
    }

    const store = createStore<T>(loaded.snapshot, storeOpts)
    const persist = persistStore(store, {
        key: opts.key,
        storage: opts.storage,
        version: opts.version,
        seq: loaded.seq,
        replayMode: loaded.replayMode,
        savedAt: loaded.savedAt,
        debounceMs: opts.debounceMs,
        now: opts.now,
        onError: opts.onError,
        onStatus,
    })
    let sub: ReturnType<typeof syncStoreReplay<T>> | null = null
    let ready: Promise<void> = Promise.resolve()
    let closed = false
    let reconnectGeneration = 0
    let cancelReconnect: (() => void) | null = null

    async function runReconnect(
        generation: number,
        cancelled: Promise<'cancelled'>,
        nextRemote: StoreReplayRemote,
        nextSyncOpts: StoreReplaySyncOpts<T>,
    ) {
        function isCurrent() {
            return !closed && generation == reconnectGeneration
        }

        sub?.()
        sub = null
        persist.setSyncStatus({syncing: true, offline: false, ready: false, error: undefined})
        const effectiveSyncOpts = {...nextSyncOpts, batch: nextSyncOpts.batch ?? true}
        try {
            const schemaReady = effectiveSyncOpts.batch ? getRpcSchemaReady(nextRemote) : undefined
            if (schemaReady) {
                const schemaState = await Promise.race([
                    Promise.resolve().then(schemaReady).then(function schemaResolved() { return 'schema' as const }),
                    cancelled,
                ])
                if (schemaState == 'cancelled' || !isCurrent()) return
            }
            if (!isCurrent()) return
            const mode = storeReplayMode(nextRemote, effectiveSyncOpts.batch)
            const modeChanged = persist.setReplayMode(mode)
            const {onSeq, onError, onStale, since, ...rest} = effectiveSyncOpts
            const effectiveSince = modeChanged ? undefined : (since ?? (persist.seq() >= 0 ? persist.seq() : undefined))
            const candidate = syncStoreReplay(store, nextRemote, {
                ...rest,
                since: effectiveSince,
                onSeq: function offlineStoreOnSeq(seq) {
                    if (!isCurrent()) return
                    persist.setSeq(seq)
                    onSeq?.(seq)
                },
                onError: function offlineStoreOnError(error) {
                    if (!isCurrent()) return
                    persist.setSyncStatus({offline: true, syncing: false, error})
                    onError?.(error)
                    if (!onError) opts.onError?.(error)
                },
                onStale: onStale && function offlineStoreOnStale(info) {
                    if (!isCurrent()) return
                    persist.setSyncStatus({stale: info.stale})
                    onStale(info)
                },
            })
            if (!isCurrent()) { candidate(); return }
            sub = candidate
            const syncState = await Promise.race([
                candidate.ready.then(function storeReplayReady() { return 'ready' as const }),
                cancelled,
            ])
            if (syncState == 'cancelled' || !isCurrent()) {
                candidate()
                if (sub == candidate) sub = null
                return
            }
            persist.setSyncStatus({ready: true, syncing: false})
        } catch (e) {
            if (!isCurrent()) return
            persist.setSyncStatus({ready: true, syncing: false, offline: true, error: e})
            emitError(opts, e)
        }
    }

    function reconnect(nextRemote: StoreReplayRemote, nextSyncOpts: StoreReplaySyncOpts<T> = syncOpts) {
        cancelReconnect?.()
        cancelReconnect = null
        const generation = ++reconnectGeneration
        if (closed) {
            ready = Promise.resolve()
            return ready
        }
        let cancel = function cancelLater() {}
        const cancelled = new Promise<'cancelled'>(function waitForReconnectCancellation(resolve) {
            cancel = function resolveCancellation() { resolve('cancelled') }
        })
        cancelReconnect = cancel
        const run = runReconnect(generation, cancelled, nextRemote, nextSyncOpts)
            .finally(function finishReconnectAttempt() {
                if (generation == reconnectGeneration) cancelReconnect = null
            })
        ready = run
        return run
    }

    if (remote) {
        reconnect(remote)
    } else {
        persist.setSyncStatus({ready: true, syncing: false, offline: true})
    }

    function close() {
        if (closed) return
        closed = true
        reconnectGeneration++
        cancelReconnect?.()
        cancelReconnect = null
        sub?.()
        sub = null
        persist.close()
    }

    function flush() {
        return persist.flush()
    }

    return Object.assign(store, {
        get ready() { return ready },
        close,
        flush,
        status: persist.status,
        statusListen: persist.statusListen,
        reconnect,
    })
}
