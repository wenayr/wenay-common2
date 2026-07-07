import {listen} from '../events/Listen'
import {ReplayRemote, ReplaySubscribeOpts} from '../events/replay-wire'
import {createStore, createStoreMirror, Store, StoreMask, StorePatch, StoreSyncOpts} from './store'
import {createOfflineStore, OfflineStorage, OfflineStore} from './store-offline'
import {syncStoreReplay} from './store-replay'

type RemoteStore<T extends object> = {
    get(mask?: any): T | Promise<T>
    changed: any
    changedPaths?: any
    patches?: any
    changedData?: any
}

export type StoreMirror<T extends object> = Store<T> & {
    sync<M extends StoreMask<T>>(mask: M, opts?: StoreSyncOpts): Promise<() => void>
    syncPatches<M extends StoreMask<T>>(mask: M, opts?: StoreSyncOpts): Promise<() => void>
    syncChangedData<M extends StoreMask<T>>(mask: M, opts?: StoreSyncOpts): Promise<() => void>
}

export type ManagedStoreKind = 'mirror' | 'replay' | 'offline'
export type ManagedStoreState = 'idle' | 'starting' | 'ready' | 'stopped' | 'error'
export type ManagedStoreSyncMode = 'pull' | 'patches' | 'changedData'

export type ManagedStoreUsage = {
    count: number
    weight: number
    lastUsedAt?: number
}

export type ManagedStorePriorityContext = {
    key: string
    now: number
    usage?: ManagedStoreUsage
}

type CommonResource<T extends object> = {
    /** Optional display key; object key in createStoreManager({key: ...}) wins. */
    key?: string
    initial: T
    tags?: readonly string[]
    priority?: number | ((ctx: ManagedStorePriorityContext) => number)
    usageKey?: string
    explicitOnly?: boolean
    large?: boolean
    autoStart?: boolean
    storeOpts?: Parameters<typeof createStore<T>>[1]
}

export type ManagedMirrorResource<T extends object> = CommonResource<T> & {
    kind?: 'mirror'
    remote: RemoteStore<T>
    mask: StoreMask<T>
    sync?: {
        mode?: ManagedStoreSyncMode
        opts?: StoreSyncOpts
    }
}

export type ManagedReplayResource<T extends object> = CommonResource<T> & {
    kind?: 'replay'
    remote: ReplayRemote<[StorePatch]>
    syncOpts?: ReplaySubscribeOpts
}

export type ManagedOfflineResource<T extends object> = CommonResource<T> & {
    kind?: 'offline'
    remote?: ReplayRemote<[StorePatch]>
    storage: OfflineStorage
    storageKey?: string
    version?: number
    debounceMs?: number
    syncOpts?: ReplaySubscribeOpts
    migrate?: (oldSnapshot: unknown, fromVersion: number, toVersion: number) => T | Promise<T>
}

export type ManagedStoreResource<T extends object = any> =
    | ManagedMirrorResource<T>
    | ManagedReplayResource<T>
    | ManagedOfflineResource<T>

export type ManagedStoreResources = Record<string, ManagedStoreResource<any>>

export type ManagedStoreOf<R> = R extends ManagedOfflineResource<infer T>
    ? OfflineStore<T>
    : R extends ManagedReplayResource<infer T>
        ? Store<T>
        : R extends ManagedMirrorResource<infer T>
            ? StoreMirror<T>
            : never

export type ManagedStoreStatus = {
    key: string
    state: ManagedStoreState
    kind: ManagedStoreKind
    error?: unknown
    startedAt?: number
    stoppedAt?: number
}

export type ManagedStorePlanItem = {
    key: string
    kind: ManagedStoreKind
    score: number
    state: ManagedStoreState
    large: boolean
    explicitOnly: boolean
    tags: readonly string[]
}

export type ManagedStoreStartOpts = {
    explicit?: boolean
    reason?: string
}

export type ManagedStorePlanOpts = {
    keys?: Iterable<string>
    tags?: readonly string[]
    includeLarge?: boolean
    includeExplicit?: boolean
    limit?: number
    now?: number
}

export type ManagedStoreHandle<TStore> = {
    readonly key: string
    readonly kind: ManagedStoreKind
    start(opts?: ManagedStoreStartOpts): Promise<TStore>
    stop(): void
    get(): TStore | undefined
    status(): ManagedStoreStatus
    touch(weight?: number): void
}

type HandleAny = ManagedStoreHandle<any>

function kindOf(resource: ManagedStoreResource<any>): ManagedStoreKind {
    return resource.kind ?? 'mirror'
}

function hasAnyTag(resourceTags: readonly string[] | undefined, tags: readonly string[] | undefined) {
    if (!tags?.length) return true
    if (!resourceTags?.length) return false
    return tags.some(tag => resourceTags.includes(tag))
}

function resourceScore(key: string, resource: ManagedStoreResource<any>, usage: ManagedStoreUsage | undefined, now: number) {
    const base = typeof resource.priority == 'function'
        ? resource.priority({key, usage, now})
        : resource.priority ?? 0
    const usageScore = usage ? usage.weight + Math.min(usage.count, 50) : 0
    const recency = usage?.lastUsedAt ? Math.max(0, 1_000_000 - (now - usage.lastUsedAt)) / 1_000_000 : 0
    return base + usageScore + recency
}

export const managedStore = {
    mirror<T extends object>(resource: ManagedMirrorResource<T>): ManagedMirrorResource<T> {
        return {...resource, kind: 'mirror'}
    },
    replay<T extends object>(resource: ManagedReplayResource<T>): ManagedReplayResource<T> {
        return {...resource, kind: 'replay'}
    },
    offline<T extends object>(resource: ManagedOfflineResource<T>): ManagedOfflineResource<T> {
        return {...resource, kind: 'offline'}
    },
}

export function createStoreManager<const R extends ManagedStoreResources>(resources: R) {
    const usages = new Map<string, ManagedStoreUsage>()
    const [emitStatus, statusListen] = listen<[ManagedStoreStatus]>()

    function usageFor(key: string, resource: ManagedStoreResource<any>) {
        const usageKey = resource.usageKey ?? key
        let usage = usages.get(usageKey)
        if (!usage) {
            usage = {count: 0, weight: 0}
            usages.set(usageKey, usage)
        }
        return usage
    }

    function createHandle(key: string, resource: ManagedStoreResource<any>): HandleAny {
        const kind = kindOf(resource)
        let state: ManagedStoreState = 'idle'
        let store: any
        let stopSync: (() => void) | undefined
        let pending: Promise<any> | undefined
        let error: unknown
        let startedAt: number | undefined
        let stoppedAt: number | undefined

        function setState(next: ManagedStoreState, nextError?: unknown) {
            state = next
            error = nextError
            if (next == 'ready') startedAt = Date.now()
            if (next == 'stopped') stoppedAt = Date.now()
            emitStatus(status())
        }

        function status(): ManagedStoreStatus {
            return {key, state, kind, error, startedAt, stoppedAt}
        }

        async function start(opts: ManagedStoreStartOpts = {}) {
            if (resource.explicitOnly && !opts.explicit) {
                throw new Error(`store manager: ${key} is explicitOnly`)
            }
            if (state == 'ready' && store) return store
            if (pending) return pending
            pending = (async () => {
                setState('starting')
                try {
                    if (kind == 'mirror') {
                        const r = resource as ManagedMirrorResource<any>
                        store ??= createStoreMirror(r.remote, r.initial, r.storeOpts) as StoreMirror<any>
                        const mode = r.sync?.mode ?? 'pull'
                        const opts = r.sync?.opts
                        stopSync = mode == 'patches'
                            ? await store.syncPatches(r.mask, opts)
                            : mode == 'changedData'
                                ? await store.syncChangedData(r.mask, opts)
                                : await store.sync(r.mask, opts)
                    } else if (kind == 'replay') {
                        const r = resource as ManagedReplayResource<any>
                        store ??= createStore(r.initial, r.storeOpts)
                        const sub = syncStoreReplay(store, r.remote, r.syncOpts)
                        stopSync = sub
                        await sub.ready
                    } else {
                        const r = resource as ManagedOfflineResource<any>
                        store = await createOfflineStore({
                            key: r.storageKey ?? key,
                            remote: r.remote,
                            initial: r.initial,
                            storage: r.storage,
                            version: r.version,
                            debounceMs: r.debounceMs,
                            storeOpts: r.storeOpts,
                            syncOpts: r.syncOpts,
                            migrate: r.migrate,
                        })
                        await store.ready
                    }
                    setState('ready')
                    return store
                } catch (e) {
                    setState('error', e)
                    throw e
                } finally {
                    pending = undefined
                }
            })()
            return pending
        }

        function stop() {
            stopSync?.()
            stopSync = undefined
            if (kind == 'offline') {
                store?.close?.()
                store = undefined
            }
            if (state != 'idle') setState('stopped')
        }

        function touch(weight = 1) {
            const usage = usageFor(key, resource)
            usage.count++
            usage.weight += weight
            usage.lastUsedAt = Date.now()
        }

        return {key, kind, start, stop, get: () => store, status, touch}
    }

    const handles: Record<string, HandleAny> = {}
    for (const key of Object.keys(resources)) handles[key] = createHandle(key, resources[key])

    function plan(opts: ManagedStorePlanOpts = {}) {
        const now = opts.now ?? Date.now()
        const keySet = opts.keys ? new Set([...opts.keys].map(String)) : null
        const out: ManagedStorePlanItem[] = []
        for (const key of Object.keys(resources)) {
            if (keySet && !keySet.has(key)) continue
            const resource = resources[key]
            if (!hasAnyTag(resource.tags, opts.tags)) continue
            if (resource.explicitOnly && !opts.includeExplicit) continue
            if (resource.large && !opts.includeLarge) continue
            const usage = usages.get(resource.usageKey ?? key)
            out.push({
                key,
                kind: kindOf(resource),
                score: resourceScore(key, resource, usage, now),
                state: handles[key].status().state,
                large: !!resource.large,
                explicitOnly: !!resource.explicitOnly,
                tags: resource.tags ?? [],
            })
        }
        out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
        return opts.limit == null ? out : out.slice(0, opts.limit)
    }

    async function start<K extends keyof R & string>(key: K, opts?: ManagedStoreStartOpts): Promise<ManagedStoreOf<R[K]>> {
        const handle = handles[key]
        if (!handle) throw new Error(`store manager: unknown resource ${key}`)
        return handle.start(opts)
    }

    async function startMany(keys: Iterable<keyof R & string>, opts?: ManagedStoreStartOpts) {
        const out: Partial<{[K in keyof R]: ManagedStoreOf<R[K]>}> = {}
        for (const key of keys) (out as any)[key] = await start(key, opts)
        return out
    }

    async function startPlanned(opts: ManagedStorePlanOpts & ManagedStoreStartOpts = {}) {
        const out: Record<string, any> = {}
        for (const item of plan(opts)) out[item.key] = await handles[item.key].start(opts)
        return out as Partial<{[K in keyof R]: ManagedStoreOf<R[K]>}>
    }

    function stop<K extends keyof R & string>(key: K) {
        const handle = handles[key]
        if (!handle) throw new Error(`store manager: unknown resource ${key}`)
        handle.stop()
    }

    function stopAll() {
        for (const handle of Object.values(handles)) handle.stop()
    }

    function get<K extends keyof R & string>(key: K): ManagedStoreOf<R[K]> | undefined {
        return handles[key]?.get()
    }

    function touch<K extends keyof R & string>(key: K, weight?: number) {
        const handle = handles[key]
        if (!handle) throw new Error(`store manager: unknown resource ${key}`)
        handle.touch(weight)
    }

    return {
        handles: handles as {[K in keyof R]: ManagedStoreHandle<ManagedStoreOf<R[K]>>},
        statusListen,
        plan,
        start,
        startMany,
        startPlanned,
        stop,
        stopAll,
        get,
        touch,
        usage: () => new Map(usages),
    }
}