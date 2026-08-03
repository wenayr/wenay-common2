// =====================================================================
// Selective Store Replay view — shared projection and bounded snapshot.
// =====================================================================

import {
    type Store, type StorePatch, cloneStoreValue, listenStorePatches,
} from './store'
import type {replayListen} from '../events/replay-listen'
import {retransmitRpcReplayWire} from '../events/replay-rpc-wire'
import {rpcEndCallback} from '../rcp/rpc-walk'
import {positiveIntegerOption} from '../positive-integer-option'
import {normalizeStoreSelectionKeys, storeSelectionId} from './store-selection'
import {STORE_REPLAY_PATCH_SOURCE, STORE_REPLAY_VIEW_PATCH_SOURCE} from './observe-private'
import {toRaw} from './reactive'
import {
    type tStoreReplayWireBatchV2,
    decodeStoreReplayBatchV2,
    encodeStoreReplayBatchV2,
    storeReplayPatchV2WireMetrics,
} from './store-replay-codec'
import type {
    StoreReplayBatchOpts,
    StoreReplayBatchRemote,
    StoreReplayPatchSource,
    StoreReplayRemote,
    StoreReplaySyncOpts,
    syncStoreReplay as syncStoreReplayBase,
} from './store-replay'

export type StoreReplayViewSnapshotOpts = {
    /** Approximate packed target for one physical callback chunk (default 512 KiB). */
    chunkBytes?: number
    /** Maximum packed bytes emitted before one read response barrier (default 1 MiB). */
    windowBytes?: number
    /** Hard patch ceiling for one snapshot chunk (default 256). */
    maxItems?: number
    /** Concurrent snapshot cursors retained by one shared view (default 32). */
    maxSessions?: number
    /** Abandoned cursor lifetime in milliseconds (default 30 seconds). */
    ttlMs?: number
}

export type StoreReplayViewOpts<K extends string = string> = StoreReplayBatchOpts & {
    /** Static, server-authorized top-level keys. The remote client cannot change them. */
    keys: readonly K[]
    /** Replay coordinate identity. A unique lifetime id is generated when omitted. */
    lineId?: string
    /** Additional static replay descriptor fields. */
    describe?: Record<string, any>
    /** Override the authoritative Store patch feed (primarily for composition/tests). */
    patchSource?: StoreReplayPatchSource
    snapshot?: StoreReplayViewSnapshotOpts
}

export type StoreReplayViewDescriptorV1 = {
    version: 1
    lineId: string
    selectionId: string
    keyCount: number
}

export type StoreReplayViewSnapshotOpenV1 = {
    version: 1
    transferId: string
    lineId: string
    selectionId: string
    baseSeq: number
    ts: number
}

export type StoreReplayViewSnapshotChunkV1 = {
    version: 1
    transferId: string
    page: number
    index: number
    wire: tStoreReplayWireBatchV2
}

export type StoreReplayViewSnapshotReadV1 = {
    version: 1
    transferId: string
    lineId: string
    after: number
    next: number
    emitted: number
    done: boolean
    retry?: true
    seq?: number
    ts?: number
}

export type StoreReplayViewRemote = {
    describe: () => Record<string, any> | Promise<Record<string, any>>
    replay: StoreReplayRemote
    snapshot: {
        open: () => StoreReplayViewSnapshotOpenV1 | Promise<StoreReplayViewSnapshotOpenV1>
        read: (
            request: {transferId: string, after: number, maxBytes?: number},
            emit: (chunk: StoreReplayViewSnapshotChunkV1) => void,
        ) => StoreReplayViewSnapshotReadV1 | Promise<StoreReplayViewSnapshotReadV1>
        close: (transferId: string) => void | Promise<void>
    }
}

export type StoreReplayViewCursor = {
    lineId: string
    selectionId: string
    seq: number
}

export type StoreReplayViewSyncOpts<T extends object = any> = Omit<
    StoreReplaySyncOpts<T>,
    'catchUp' | 'prepareCatchUp' | 'recoverGap' | 'since'
> & {
    /** Persist lineId, selectionId and seq together; a different view forces a fresh snapshot. */
    cursor?: StoreReplayViewCursor
    /** Requested server window; the view clamps it to its configured maximum. */
    snapshotWindowBytes?: number
    /** Fresh snapshot attempts after cursor expiry/history eviction (default 3). */
    snapshotRetries?: number
    onSnapshotProgress?: (progress: {
        transferId: string
        chunks: number
        pages: number
        done: boolean
    }) => void
}

type StoreReplayBatchLine = ReturnType<typeof replayListen<[readonly StorePatch[]]>>[1]

type StoreReplayViewBatch = {
    replay: StoreReplayBatchLine
    push: (patches: readonly StorePatch[]) => void
    flush: () => void
    close: () => void
    stats: () => {
        sourceBatches: number
        sourcePatches: number
        emittedBatches: number
        emittedPatches: number
        estimatedBytes: number
    }
}

type StoreReplayViewLayerDeps = {
    createBatchReplay: (
        currentBatch: () => [readonly StorePatch[]],
        opts: StoreReplayBatchOpts,
        label?: string,
    ) => StoreReplayViewBatch
    exposeStoreReplayBatch: (
        replay: StoreReplayBatchLine,
        prepareRead: () => void,
    ) => StoreReplayBatchRemote
    syncStoreReplay: typeof syncStoreReplayBase
}

/**
 * The base replay owns batching and transport decoding. This layer owns only
 * selection, bounded snapshot cursors, and view-specific recovery.
 */
export function createStoreReplayViewLayer(deps: StoreReplayViewLayerDeps) {
    const {createBatchReplay, exposeStoreReplayBatch, syncStoreReplay} = deps

    /**
     * Lightweight selected replay over one authoritative Store.
     */
    let storeReplayViewLifetime = 0

    function storeReplayViewId(prefix: string) {
        storeReplayViewLifetime++
        return prefix + ':' + Date.now().toString(36) + ':' + storeReplayViewLifetime.toString(36)
            + ':' + Math.random().toString(36).slice(2)
    }

    function requireStoreReplayViewLineId(value: string) {
        if (typeof value != 'string' || value.length == 0) {
            throw new TypeError('createStoreReplayView: lineId must be a non-empty string')
        }
        return value
    }

    function storeReplayViewSnapshotTask() {
        return new Promise<void>(function yieldSnapshotChunk(resolve) {
            if (typeof setImmediate == 'function') setImmediate(resolve)
            else setTimeout(resolve, 0)
        })
    }

    /**
     * Read-only selective replay over one authoritative Store. The selection is
     * static and server-owned; share one returned view between clients with the
     * same authorized key set.
     */
    function createStoreReplayView<
        T extends object,
        K extends Extract<keyof T, string> = Extract<keyof T, string>,
    >(store: Store<T>, opts: StoreReplayViewOpts<K>) {
        const keys = normalizeStoreSelectionKeys(opts.keys, 'createStoreReplayView') as readonly K[]
        const selected = new Set<string>(keys)
        const selectionId = storeSelectionId(keys)
        const lineId = requireStoreReplayViewLineId(opts.lineId ?? storeReplayViewId('store-view'))
        const snapshotOpts = opts.snapshot ?? {}
        const snapshotChunkBytes = positiveIntegerOption(
            snapshotOpts.chunkBytes,
            512 * 1024,
            'createStoreReplayView: snapshot.chunkBytes',
        )
        const snapshotWindowBytes = positiveIntegerOption(
            snapshotOpts.windowBytes,
            1024 * 1024,
            'createStoreReplayView: snapshot.windowBytes',
        )
        const snapshotMaxItems = positiveIntegerOption(
            snapshotOpts.maxItems,
            256,
            'createStoreReplayView: snapshot.maxItems',
        )
        const maxSessions = positiveIntegerOption(
            snapshotOpts.maxSessions,
            32,
            'createStoreReplayView: snapshot.maxSessions',
        )
        const snapshotTtlMs = positiveIntegerOption(
            snapshotOpts.ttlMs,
            30_000,
            'createStoreReplayView: snapshot.ttlMs',
        )

        function sampleSelectedKey(key: string): StorePatch {
            const root = toRaw(store.state) as any
            const exists = Object.prototype.hasOwnProperty.call(root, key)
            return {
                path: [key],
                exists,
                value: exists ? cloneStoreValue(root[key]) : undefined,
            }
        }

        function currentViewBatch() {
            const patches: StorePatch[] = [{path: [], exists: true, value: {}}]
            for (const key of keys) patches.push(sampleSelectedKey(key))
            return [patches] as [readonly StorePatch[]]
        }

        const batchReplay = createBatchReplay(currentViewBatch, opts, 'createStoreReplayView')
        const replayApi = exposeStoreReplayBatch(batchReplay.replay, batchReplay.flush)
        const descriptor: Record<string, any> = {
            ...cloneStoreValue(opts.describe ?? {}),
            storeReplayView: {
                version: 1,
                lineId,
                selectionId,
                keyCount: keys.length,
            } satisfies StoreReplayViewDescriptorV1,
        }
        function describe() {
            return cloneStoreValue(descriptor)
        }
        const replayFacade = {...replayApi, describe}
        retransmitRpcReplayWire(replayApi, replayFacade)

        const createSelectedPatches = (store as Store<T> & {
            [STORE_REPLAY_VIEW_PATCH_SOURCE]?: (keys: readonly string[]) => StoreReplayPatchSource
        })[STORE_REPLAY_VIEW_PATCH_SOURCE]
        const getExactPatches = (store as Store<T> & {
            [STORE_REPLAY_PATCH_SOURCE]?: () => StoreReplayPatchSource
        })[STORE_REPLAY_PATCH_SOURCE]
        const sourceIsSelected = opts.patchSource == null && createSelectedPatches != null
        const source = opts.patchSource
            ?? createSelectedPatches?.(keys)
            ?? getExactPatches?.()
            ?? listenStorePatches(store)

        function selectRootPatch(rootPatch: StorePatch) {
            const root = rootPatch.exists ? rootPatch.value : undefined
            return keys.map(function projectSelectedRootKey(key): StorePatch {
                const exists = root != null && typeof root == 'object'
                    && Object.prototype.hasOwnProperty.call(root, key)
                return {
                    path: [key],
                    exists,
                    // The exact source already detached this root. Views retain only
                    // selected references; cloning happens at each wire boundary.
                    value: exists ? root[key] : undefined,
                }
            })
        }

        function journalSelectedStoreChange(patches: readonly StorePatch[]) {
            const projected: StorePatch[] = []
            for (const patch of patches) {
                if (patch.path.length == 0) {
                    projected.push(...selectRootPatch(patch))
                    continue
                }
                if (typeof patch.path[0] == 'string' && selected.has(patch.path[0])) {
                    projected.push(patch)
                }
            }
            batchReplay.push(projected)
        }

        function journalPreselectedStoreChange(patches: readonly StorePatch[]) {
            batchReplay.push(patches)
        }

        const offStore = source.on(
            sourceIsSelected ? journalPreselectedStoreChange : journalSelectedStoreChange,
        )

        type SnapshotSession = {
            transferId: string
            baseSeq: number
            ts: number
            keyIndex: number
            page: number
            chunkIndex: number
            lastUse: number
            reading: boolean
        }

        const sessions = new Map<string, SnapshotSession>()
        let cleanupTimer: any = null
        let closed = false
        let openedSnapshots = 0
        let completedSnapshots = 0
        let expiredSnapshots = 0
        let retrySnapshots = 0
        let snapshotPages = 0
        let snapshotChunks = 0
        let snapshotPatches = 0
        let snapshotBytes = 0

        function stopCleanupTimer() {
            if (!cleanupTimer) return
            clearTimeout(cleanupTimer)
            cleanupTimer = null
        }

        function pruneSnapshotSessions(now = Date.now()) {
            for (const [id, session] of sessions) {
                if (session.reading || now - session.lastUse < snapshotTtlMs) continue
                sessions.delete(id)
                expiredSnapshots++
            }
            if (sessions.size == 0) stopCleanupTimer()
        }

        function armCleanupTimer() {
            if (cleanupTimer || sessions.size == 0 || closed) return
            cleanupTimer = setTimeout(function cleanExpiredSnapshotSessions() {
                cleanupTimer = null
                pruneSnapshotSessions()
                armCleanupTimer()
            }, snapshotTtlMs)
            cleanupTimer.unref?.()
        }

        function openSnapshot(): StoreReplayViewSnapshotOpenV1 {
            if (closed) throw new Error('createStoreReplayView: closed')
            pruneSnapshotSessions()
            if (sessions.size >= maxSessions) {
                throw new Error('createStoreReplayView: too many active snapshot sessions')
            }
            batchReplay.flush()
            const transferId = storeReplayViewId('snapshot')
            const session: SnapshotSession = {
                transferId,
                baseSeq: batchReplay.replay.head(),
                ts: Date.now(),
                keyIndex: -1,
                page: 0,
                chunkIndex: 0,
                lastUse: Date.now(),
                reading: false,
            }
            sessions.set(transferId, session)
            openedSnapshots++
            armCleanupTimer()
            return {
                version: 1,
                transferId,
                lineId,
                selectionId,
                baseSeq: session.baseSeq,
                ts: session.ts,
            }
        }

        function nextSnapshotPatch(session: SnapshotSession) {
            if (session.keyIndex < 0) {
                session.keyIndex = 0
                return {path: [], exists: true, value: {}} satisfies StorePatch
            }
            if (session.keyIndex >= keys.length) return undefined
            return sampleSelectedKey(keys[session.keyIndex++])
        }

        type MeasuredPatch = {
            patch: StorePatch
            byteLength: number
            binaryCount: number
        }

        function measureSnapshotPatch(patch: StorePatch, firstBinaryIndex: number): MeasuredPatch {
            try {
                const metrics = storeReplayPatchV2WireMetrics(patch, firstBinaryIndex)
                return {patch, byteLength: metrics.byteLength + 1, binaryCount: metrics.binaryCount}
            } catch {
                return {patch, byteLength: snapshotChunkBytes, binaryCount: 0}
            }
        }

        function buildSnapshotChunk(
            session: SnapshotSession,
            chunkLimit: number,
            carried?: MeasuredPatch,
        ) {
            const patches: StorePatch[] = []
            let estimatedBytes = 48
            let binaryCount = 0
            let pending = carried?.binaryCount
                ? measureSnapshotPatch(carried.patch, 0)
                : carried
            while (patches.length < snapshotMaxItems) {
                const measured = pending ?? (() => {
                    const patch = nextSnapshotPatch(session)
                    return patch ? measureSnapshotPatch(patch, binaryCount) : undefined
                })()
                pending = undefined
                if (!measured) break
                if (patches.length && estimatedBytes + measured.byteLength > chunkLimit) {
                    pending = measured
                    break
                }
                patches.push(measured.patch)
                estimatedBytes += measured.byteLength
                binaryCount += measured.binaryCount
            }
            return {patches, estimatedBytes, pending}
        }

        async function readSnapshot(
            request: {transferId: string, after: number, maxBytes?: number},
            emit: (chunk: StoreReplayViewSnapshotChunkV1) => void,
        ): Promise<StoreReplayViewSnapshotReadV1> {
            if (closed) throw new Error('createStoreReplayView: closed')
            if (!request || typeof request.transferId != 'string'
                || !Number.isSafeInteger(request.after) || request.after < 0) {
                throw new TypeError('createStoreReplayView: invalid snapshot read request')
            }
            pruneSnapshotSessions()
            const session = sessions.get(request.transferId)
            if (!session) throw new Error('createStoreReplayView: unknown or expired snapshot')
            if (session.reading) throw new Error('createStoreReplayView: snapshot read already in progress')
            if (request.after != session.page) {
                throw new Error(`createStoreReplayView: expected snapshot page ${session.page}, received ${request.after}`)
            }
            let windowLimit = snapshotWindowBytes
            if (request.maxBytes != null) {
                if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
                    throw new TypeError('createStoreReplayView: snapshot maxBytes must be a positive safe integer')
                }
                windowLimit = Math.min(windowLimit, request.maxBytes)
            }
            const chunkLimit = Math.min(snapshotChunkBytes, windowLimit)
            const page = session.page
            let emitted = 0
            let emittedBytes = 0
            let pending: MeasuredPatch | undefined
            session.reading = true
            session.lastUse = Date.now()
            function rewindSnapshotPatches(patches: readonly StorePatch[], carried?: MeasuredPatch) {
                let selectedCount = patches.filter(patch => patch.path.length == 1).length
                if (carried?.patch.path.length == 1) selectedCount++
                session!.keyIndex -= selectedCount
            }
            try {
                while (session.keyIndex < keys.length || session.keyIndex < 0 || pending) {
                    const built = buildSnapshotChunk(session, chunkLimit, pending)
                    pending = built.pending
                    if (built.patches.length == 0) break
                    if (emitted > 0 && emittedBytes + built.estimatedBytes > windowLimit) {
                        rewindSnapshotPatches(built.patches, pending)
                        pending = undefined
                        break
                    }
                    const chunk: StoreReplayViewSnapshotChunkV1 = {
                        version: 1,
                        transferId: session.transferId,
                        page,
                        index: session.chunkIndex++,
                        wire: encodeStoreReplayBatchV2({
                            seq: session.baseSeq,
                            ts: session.ts,
                            event: [built.patches],
                        }),
                    }
                    emit(chunk)
                    emitted++
                    emittedBytes += built.estimatedBytes
                    snapshotChunks++
                    snapshotPatches += built.patches.length
                    snapshotBytes += built.estimatedBytes
                    await storeReplayViewSnapshotTask()
                    if (emittedBytes >= windowLimit) {
                        rewindSnapshotPatches([], pending)
                        pending = undefined
                        break
                    }
                }
            } finally {
                rpcEndCallback(emit)
                session.reading = false
                session.lastUse = Date.now()
            }

            session.page++
            snapshotPages++
            const done = session.keyIndex >= keys.length && !pending
            let retry: true | undefined
            if (done) {
                batchReplay.flush()
                if (batchReplay.replay.getSince(session.baseSeq) == null) {
                    retry = true
                    retrySnapshots++
                } else {
                    completedSnapshots++
                }
            }
            armCleanupTimer()
            return {
                version: 1,
                transferId: session.transferId,
                lineId,
                after: page,
                next: session.page,
                emitted,
                done,
                retry,
                seq: done && !retry ? session.baseSeq : undefined,
                ts: done && !retry ? session.ts : undefined,
            }
        }

        function closeSnapshot(transferId: string) {
            if (typeof transferId != 'string') return
            sessions.delete(transferId)
            if (sessions.size == 0) stopCleanupTimer()
        }

        function stats() {
            return {
                lineId,
                selectionId,
                keyCount: keys.length,
                activeSessions: sessions.size,
                openedSnapshots,
                completedSnapshots,
                expiredSnapshots,
                retrySnapshots,
                snapshotPages,
                snapshotChunks,
                snapshotPatches,
                snapshotBytes,
                replay: batchReplay.stats(),
            }
        }

        function close() {
            if (closed) return
            closed = true
            offStore()
            stopCleanupTimer()
            sessions.clear()
            batchReplay.close()
        }

        const resource: StoreReplayViewRemote = {
            describe,
            replay: replayFacade,
            snapshot: {
                open: openSnapshot,
                read: readSnapshot,
                close: closeSnapshot,
            },
        }
        return {
            resource,
            events: {replay: batchReplay.replay},
            view: {
                lineId,
                selectionId,
                keys: () => [...keys],
                stats,
            },
            close,
        }
    }

    function abortStoreReplayViewSnapshot(signal: AbortSignal) {
        if (!signal.aborted) return
        const error = new Error('syncStoreReplayView: snapshot cancelled')
        error.name = 'AbortError'
        throw error
    }

    function applyOwnedStoreReplayViewPatch(root: Record<string, any> | undefined, patch: StorePatch) {
        if (patch.path.length == 0) {
            if (root) throw new TypeError('syncStoreReplayView: duplicate snapshot root reset')
            if (!patch.exists || patch.value == null || typeof patch.value != 'object'
                || Array.isArray(patch.value)) {
                throw new TypeError('syncStoreReplayView: first snapshot patch must reset the object root')
            }
            return {} as Record<string, any>
        }
        if (!root) throw new TypeError('syncStoreReplayView: snapshot key arrived before root reset')
        if (patch.path.length != 1 || typeof patch.path[0] != 'string') {
            throw new TypeError('syncStoreReplayView: snapshot contains a non-top-level string path')
        }
        const key = patch.path[0]
        if (!patch.exists) {
            Reflect.deleteProperty(root, key)
            return root
        }
        const defined = Reflect.defineProperty(root, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: patch.value,
        })
        if (!defined) throw new TypeError('syncStoreReplayView: cannot assemble snapshot key ' + key)
        return root
    }

    /**
     * Atomic selected-view mirror. Snapshot chunks assemble outside the visible
     * Store; one root replacement happens only after the final bounded window.
     */
    function syncStoreReplayView<T extends object>(
        store: Store<T>,
        remote: StoreReplayViewRemote,
        opts: StoreReplayViewSyncOpts<T> = {},
    ) {
        const {
            cursor,
            snapshotWindowBytes,
            snapshotRetries,
            onSnapshotProgress,
            validateBatch,
            onBatch,
            ...wireOpts
        } = opts
        if (cursor && (typeof cursor.lineId != 'string' || cursor.lineId.length == 0
            || typeof cursor.selectionId != 'string' || cursor.selectionId.length == 0
            || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0)) {
            throw new TypeError('syncStoreReplayView: invalid cursor')
        }
        let activeLineId = cursor?.lineId
        let activeSelectionId = cursor?.selectionId
        const maxAttempts = positiveIntegerOption(
            snapshotRetries,
            3,
            'syncStoreReplayView: snapshotRetries',
        )
        if (snapshotWindowBytes != null
            && (!Number.isSafeInteger(snapshotWindowBytes) || snapshotWindowBytes <= 0)) {
            throw new TypeError('syncStoreReplayView: snapshotWindowBytes must be a positive safe integer')
        }

        async function installSnapshot(signal: AbortSignal) {
            let lastError: unknown
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                abortStoreReplayViewSnapshot(signal)
                const opened = await remote.snapshot.open()
                abortStoreReplayViewSnapshot(signal)
                if (!opened || opened.version != 1 || typeof opened.transferId != 'string'
                    || typeof opened.lineId != 'string' || typeof opened.selectionId != 'string'
                    || !Number.isSafeInteger(opened.baseSeq) || opened.baseSeq < 0
                    || !Number.isFinite(opened.ts) || opened.ts < 0) {
                    throw new TypeError('syncStoreReplayView: invalid snapshot open response')
                }
                let root: Record<string, any> | undefined
                let page = 0
                let chunkIndex = 0
                let chunkError: unknown
                let chunks = 0
                try {
                    while (true) {
                        abortStoreReplayViewSnapshot(signal)
                        let pageChunks = 0
                        const result = await remote.snapshot.read({
                            transferId: opened.transferId,
                            after: page,
                            maxBytes: snapshotWindowBytes,
                        }, function receiveStoreReplayViewChunk(chunk) {
                            if (signal.aborted || chunkError) return
                            try {
                                if (!chunk || chunk.version != 1 || chunk.transferId != opened.transferId
                                    || chunk.page != page || chunk.index != chunkIndex) {
                                    throw new TypeError('syncStoreReplayView: invalid or out-of-order snapshot chunk')
                                }
                                const event = decodeStoreReplayBatchV2(chunk.wire)
                                if (event.seq != opened.baseSeq || event.ts != opened.ts) {
                                    throw new TypeError('syncStoreReplayView: snapshot chunk changed its coordinate')
                                }
                                for (const patch of event.event[0]) {
                                    root = applyOwnedStoreReplayViewPatch(root, patch)
                                }
                                chunkIndex++
                                pageChunks++
                                chunks++
                            } catch (error) {
                                chunkError = error
                            }
                        })
                        abortStoreReplayViewSnapshot(signal)
                        if (chunkError) throw chunkError
                        if (!result || result.version != 1 || result.transferId != opened.transferId
                            || result.lineId != opened.lineId || result.after != page
                            || result.next != page + 1 || result.emitted != pageChunks
                            || typeof result.done != 'boolean') {
                            throw new TypeError('syncStoreReplayView: invalid snapshot read response')
                        }
                        page = result.next
                        onSnapshotProgress?.({
                            transferId: opened.transferId,
                            chunks,
                            pages: page,
                            done: result.done,
                        })
                        if (!result.done) continue
                        if (result.retry) {
                            lastError = new Error('syncStoreReplayView: replay history moved past the snapshot base')
                            break
                        }
                        if (result.seq != opened.baseSeq || result.ts != opened.ts || !root) {
                            throw new TypeError('syncStoreReplayView: incomplete snapshot commit')
                        }
                        abortStoreReplayViewSnapshot(signal)
                        const rootPatch = {
                            path: [],
                            exists: true,
                            value: root,
                        } satisfies StorePatch
                        validateBatch?.([rootPatch], store)
                        abortStoreReplayViewSnapshot(signal)
                        store.replace(root as T)
                        onBatch?.([rootPatch], store)
                        activeLineId = opened.lineId
                        activeSelectionId = opened.selectionId
                        return {since: result.seq, ts: result.ts}
                    }
                } finally {
                    try {
                        const closing = remote.snapshot.close(opened.transferId)
                        if (closing && typeof (closing as Promise<void>).catch == 'function') {
                            void (closing as Promise<void>).catch(function ignoreSnapshotCloseFailure() {})
                        }
                    } catch {
                        // A disconnected transport cannot retain more than one TTL-bounded cursor.
                    }
                }
            }
            throw lastError ?? new Error('syncStoreReplayView: snapshot retries exhausted')
        }

        async function sameReplayViewLine(signal: AbortSignal) {
            const descriptor = await remote.describe()
            abortStoreReplayViewSnapshot(signal)
            const view = descriptor?.['storeReplayView'] as StoreReplayViewDescriptorV1 | undefined
            if (!view || view.version != 1 || typeof view.lineId != 'string' || view.lineId.length == 0
                || typeof view.selectionId != 'string' || view.selectionId.length == 0) {
                throw new TypeError('syncStoreReplayView: remote has no valid view descriptor')
            }
            return activeLineId != null && activeLineId == view.lineId
                && activeSelectionId != null && activeSelectionId == view.selectionId
        }

        const sub = syncStoreReplay(store, remote.replay, {
            ...wireOpts,
            since: cursor?.seq,
            validateBatch,
            onBatch,
            catchUp: 'tail',
            async prepareCatchUp(context) {
                if (context.since >= 0 && await sameReplayViewLine(context.signal)) return
                return installSnapshot(context.signal)
            },
            async recoverGap(context) {
                return installSnapshot(context.signal)
            },
        })
        return Object.assign(sub, {
            viewMode: 'v1' as const,
            cursor() {
                return activeLineId == null || activeSelectionId == null
                    ? null
                    : {lineId: activeLineId, selectionId: activeSelectionId, seq: sub.seq()}
            },
        })
    }

    return {createStoreReplayView, syncStoreReplayView}
}
