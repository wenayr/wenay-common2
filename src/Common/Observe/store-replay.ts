// =====================================================================
// store ⇄ replay — patch journal with seq, keyframe = root-patch
// =====================================================================
// All logic is in withReplayListen; store adds exactly "patch as event type".
// Keyframe — StorePatch with path: [] (replaceRoot): mirror applies ONE mechanism
// applyStorePatches for both snapshot and deltas. Reconnect stops costing a full
// snapshot when the journal tail is enough.

import {
    type Store, type StorePatch, type StoreDrain, type StoreEachCtx,
    applyStorePatches, cloneStoreValue, createStore, exposeStore, listenStorePatches,
} from './store'
import {replayListen, type ReplayListenOptions, type ReplayEvent} from '../events/replay-listen'
import {replaySubscribe, type ReplayRemote, type ReplaySubscribeOpts} from '../events/replay-wire'
import {
    replayRouteSubscribe, type ReplayRouteSubscribeOpts, type ReplayRouteSwitchOpts,
} from '../events/replay-route'
import {openHistory, type ReplayStorage} from '../events/replay-history'
import {mapListen} from '../events/mapListen'
import {brandRpcReplayWire, retransmitRpcReplayWire} from '../events/replay-rpc-wire'
import {makeOff} from '../rcp/rpc-off'
import {positiveIntegerOption} from '../positive-integer-option'
import {
    RPC_MEMBER_LOOKUP, RPC_SCHEMA_READY, RPC_TRANSPORT_LIFECYCLE,
    getRpcMemberState, getRpcSchemaReady, rpcMemberAvailable,
} from '../events/transport-lifecycle'
import {STORE_REPLAY_PATCH_SOURCE} from './observe-private'
import {
    type tStoreReplayWireBatchV2,
    decodeStoreReplayBatchV2,
    encodeStoreReplayBatchV2,
    storeReplayBatchV2WireMetrics,
    storeReplayPatchV2WireMetrics,
} from './store-replay-codec'
import {
    createStoreReplayViewLayer,
    type StoreReplayViewOpts,
    type StoreReplayViewRemote,
    type StoreReplayViewSyncOpts,
} from './store-replay-view'

export type {
    StoreReplayViewCursor,
    StoreReplayViewDescriptorV1,
    StoreReplayViewOpts,
    StoreReplayViewRemote,
    StoreReplayViewSnapshotChunkV1,
    StoreReplayViewSnapshotOpenV1,
    StoreReplayViewSnapshotOpts,
    StoreReplayViewSnapshotReadV1,
    StoreReplayViewSyncOpts,
} from './store-replay-view'

export type StoreReplayBatchOpts = Pick<ReplayListenOptions<[readonly StorePatch[]]>,
    'history' | 'keepMs' | 'getSince' | 'onJournal' | 'onJournalBatch' | 'now' | 'firstSeq'> & {
    /** Hard item ceiling per envelope (default 256). */
    maxItems?: number
    /** Conservative packed V2 RPC payload target (default 64 KiB; one indivisible patch may exceed it). */
    maxBytes?: number
    /** Optional aggregation across Store drain windows (default 0 = preserve each natural window). */
    maxDelayMs?: number
}

export type StoreReplayPatchSource = {
    /** Patches are absolute facts; Store state already reflects the whole reported batch. */
    on(cb: (patches: readonly StorePatch[]) => void): () => void
}

export type StoreReplayOpts = StoreReplayBatchOpts & {
    /** Static source descriptor served to clients as replay.describe(): schema/originId/... (JSON-able). */
    describe?: Record<string, any>
    /** Override the settled Store patch feed while retaining the same replay/journal/wire surfaces. */
    patchSource?: StoreReplayPatchSource
}

type StoreReplayWireRemote<W> = {
    line: {on: (cb: (batch: W) => void) => any}
    since: (seq: number) => Promise<W[] | null | undefined> | W[] | null | undefined
    keyframe: () => Promise<W | null | undefined> | W | null | undefined
    frame?: (seq: number, hint?: unknown) => Promise<W[] | null | undefined> | W[] | null | undefined
    frameLine?: {on: (cb: (batch: W) => void) => any}
}

export type StoreReplayBatchRemote = StoreReplayWireRemote<tStoreReplayWireBatchV2>

export type StoreReplayRemote = StoreReplayBatchRemote & {
    describe?: () => Record<string, any> | Promise<Record<string, any>>
}

export type tStoreReplayMode = 'v2'

export type StoreReplaySyncOpts<T extends object = any> = ReplaySubscribeOpts & {
    /** Runs after one decoded physical envelope is applied; bounds may split a source drain and delay may merge drains. */
    onBatch?: (patches: readonly StorePatch[], store: Store<T>) => void
    /** Validate one decoded envelope before any Store mutation. */
    validateBatch?: (patches: readonly StorePatch[], store: Store<T>) => void
}

export type StoreReplayRouteOpts<T extends object = any> = ReplayRouteSubscribeOpts & {
    /** Runs after one decoded route envelope is applied; its boundary need not equal one source drain. */
    onBatch?: (patches: readonly StorePatch[], store: Store<T>) => void
    /** Validate one decoded envelope before any Store mutation. */
    validateBatch?: (patches: readonly StorePatch[], store: Store<T>) => void
}

/** Resolve the coordinate space before subscribing; callers that persist seq must persist this too. */
export function storeReplayMode(): tStoreReplayMode { return 'v2' }

/**
 * keyOf for patch line (conflateReplay): collapse by exact path.
 * Patch is absolute by its path, and the order of last touches = order by seq,
 * so "last patch of each path" gives the same state as the entire line —
 * including ancestor/descendant overlaps (ancestor patch carries the entire subtree).
 * In the new path (frame on line) — internal detail of condensePatchTail below.
 */
function cloneStoreReplayPatch(patch: StorePatch): StorePatch {
    return {
        path: [...patch.path],
        exists: patch.exists,
        value: patch.exists ? cloneStoreValue(patch.value) : undefined,
    }
}

function cloneStoreReplayBatchEvent(
    event: ReplayEvent<[readonly StorePatch[]]>,
): ReplayEvent<[StorePatch[]]> {
    return {seq: event.seq, ts: event.ts, event: [event.event[0].map(cloneStoreReplayPatch)]}
}

// A later patch of an ancestor supersedes earlier descendants. A later
// descendant must stay after its ancestor (delete + recreate is preserved).
function condenseBatchPatchTail(tail: ReplayEvent<[readonly StorePatch[]]>[]) {
    type PatchNode = {
        children: Map<PropertyKey, PatchNode>
        patch?: StorePatch
        order?: number
    }
    const root: PatchNode = {children: new Map()}
    let order = 0
    for (const ev of tail) for (const patch of ev.event[0]) {
        if (patch.path.some(key => typeof key == 'symbol')) return tail
        let node = root
        for (const key of patch.path) {
            let child = node.children.get(key)
            if (!child) {
                child = {children: new Map()}
                node.children.set(key, child)
            }
            node = child
        }
        node.patch = patch
        node.order = order++
        node.children.clear()
    }
    const ordered: {patch: StorePatch, order: number}[] = []
    function collect(node: PatchNode) {
        if (node.patch) ordered.push({patch: node.patch, order: node.order!})
        for (const child of node.children.values()) collect(child)
    }
    collect(root)
    ordered.sort((a, b) => a.order - b.order)
    const held = ordered.map(entry => entry.patch)
    if (held.length == 0) return []
    const last = tail[tail.length - 1]
    return [{seq: last.seq, ts: last.ts, event: [held] as [readonly StorePatch[]]}]
}

function createBatchReplay(
    currentBatch: () => [readonly StorePatch[]],
    opts: StoreReplayBatchOpts,
    label = 'exposeStoreReplay',
) {
    const maxItems = positiveIntegerOption(opts.maxItems, 256, label + ': batch.maxItems')
    const maxBytes = positiveIntegerOption(opts.maxBytes, 64 * 1024, label + ': batch.maxBytes')
    const maxDelayMs = opts.maxDelayMs ?? 0
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
        throw new RangeError(label + ': batch.maxDelayMs must be >= 0')
    }

    const [emitBatch, replay] = replayListen<[readonly StorePatch[]]>({
        current: currentBatch,
        frame: condenseBatchPatchTail,
        history: opts.getSince ? undefined : (opts.history ?? 1024),
        keepMs: opts.getSince ? undefined : opts.keepMs,
        getSince: opts.getSince,
        onJournal: opts.onJournal,
        onJournalBatch: opts.onJournalBatch,
        now: opts.now,
        firstSeq: opts.firstSeq,
    })

    // 48 bytes conservatively covers [version, seq, ts, [...]] with safe-integer coordinates.
    const envelopeBytes = 48
    const exactEmptyEnvelopeBytes = storeReplayBatchV2WireMetrics([]).byteLength
    let pending: StorePatch[] = []
    const ready: {patches: StorePatch[], bytes: number}[] = []
    let pendingBytes = envelopeBytes
    let pendingBinaryCount = 0
    let pendingMetricsExact = true
    let timer: any = null
    let closed = false
    let flushing = false
    let sourceBatches = 0
    let sourcePatches = 0
    let emittedBatches = 0
    let emittedPatches = 0
    let estimatedBytes = 0

    function stopTimer() {
        if (timer) { clearTimeout(timer); timer = null }
    }

    function sealPending(target = ready) {
        if (pending.length == 0) return
        const sealed = pending
        const estimated = pendingBytes
        const exactPatchMetrics = pendingMetricsExact
        pending = []
        pendingBytes = envelopeBytes
        pendingBinaryCount = 0
        pendingMetricsExact = true
        const planned: {patches: StorePatch[], bytes: number}[] = []
        splitToWireLimit(sealed, estimated, planned, exactPatchMetrics)
        target.push(...planned)
    }

    function splitToWireLimit(
        patches: StorePatch[],
        estimated: number,
        planned: {patches: StorePatch[], bytes: number}[],
        exactPatchMetrics = false,
    ) {
        if (estimated <= maxBytes) {
            planned.push({patches, bytes: estimated})
            return
        }
        if (patches.length == 1 && exactPatchMetrics) {
            // Admission already measured this patch from binary index zero. Wrapping its
            // packed JSON in the fixed V2 envelope adds only the empty-envelope bytes;
            // walking an indivisible multi-megabyte value again cannot change its boundary.
            const patchBytes = estimated - envelopeBytes - 1
            planned.push({patches, bytes: exactEmptyEnvelopeBytes + patchBytes})
            return
        }
        let bytes: number
        try { bytes = storeReplayBatchV2WireMetrics(patches).byteLength }
        catch {
            planned.push({patches, bytes: estimated})
            return
        }
        if (bytes <= maxBytes || patches.length == 1) {
            planned.push({patches, bytes})
            return
        }
        const middle = Math.ceil(patches.length / 2)
        splitToWireLimit(patches.slice(0, middle), bytes, planned)
        splitToWireLimit(patches.slice(middle), bytes, planned)
    }

    function drainReady() {
        if (flushing) return
        flushing = true
        let delivered = 0
        try {
            while (delivered < ready.length) {
                const batch = ready[delivered]
                emitBatch(batch.patches)
                delivered++
                emittedBatches++
                emittedPatches += batch.patches.length
                estimatedBytes += batch.bytes
            }
        } finally {
            if (delivered) ready.splice(0, delivered)
            flushing = false
        }
    }

    function flush() {
        stopTimer()
        sealPending()
        drainReady()
    }

    function armTimer() {
        if (timer || maxDelayMs == 0) return
        timer = setTimeout(flush, maxDelayMs)
        timer.unref?.()
    }

    function push(patches: readonly StorePatch[]) {
        if (closed || patches.length == 0) return
        sourceBatches++
        sourcePatches += patches.length
        const staged: {patches: StorePatch[], bytes: number}[] = []
        function measurePatch(patch: StorePatch, firstBinaryIndex = 0) {
            try {
                return {...storeReplayPatchV2WireMetrics(patch, firstBinaryIndex), exact: true}
            } catch {
                return {byteLength: maxBytes, binaryCount: 0, exact: false}
            }
        }
        for (const patch of patches) {
            let metrics = measurePatch(patch, pendingBinaryCount)
            let bytes = metrics.byteLength + 1
            if (pending.length && (pending.length >= maxItems || pendingBytes + bytes > maxBytes)) {
                sealPending(staged)
                // A non-binary patch's metric is independent of the attachment index.
                // Binary or failed measurements still restart from index zero.
                if (metrics.binaryCount > 0 || !metrics.exact) metrics = measurePatch(patch)
                bytes = metrics.byteLength + 1
            }
            pending.push(patch)
            pendingBytes += bytes
            pendingBinaryCount += metrics.binaryCount
            pendingMetricsExact = pendingMetricsExact && metrics.exact
            if (pending.length >= maxItems) sealPending(staged)
        }
        if (maxDelayMs == 0) sealPending(staged)
        else armTimer()
        ready.push(...staged)
        // Ingestion is complete before a retained precommit can fail, so the
        // current call can never lose its unvisited suffix.
        drainReady()
    }

    function close() {
        if (closed) return
        flush()
        closed = true
        replay.close()
    }

    function stats() {
        return {sourceBatches, sourcePatches, emittedBatches, emittedPatches, estimatedBytes}
    }

    const readSafeReplay = {
        ...replay,
        getSince(seq: number) {
            flush()
            return replay.getSince(seq)
        },
        keyframe() {
            flush()
            return replay.keyframe()
        },
        frame(seq: number, hint?: unknown) {
            flush()
            return replay.frame(seq, hint)
        },
    }

    return {
        replay: readSafeReplay,
        push,
        flush,
        close,
        stats,
        limits: {maxItems, maxBytes},
    }
}

type StoreReplayBatchLine = ReturnType<typeof replayListen<[readonly StorePatch[]]>>[1]

function exposeStoreReplayWire<W>(
    replay: StoreReplayBatchLine,
    encode: (event: ReplayEvent<[readonly StorePatch[]]>) => W,
    prepareRead: () => void,
): StoreReplayWireRemote<W> {
    const [, line] = mapListen(replay.line, function encodeStoreReplayLive(event) {
        return [encode(cloneStoreReplayBatchEvent(event))]
    })
    replay.line.onClose(function closeEncodedStoreReplayLine() { line.close() })
    function since(seq: number) {
        prepareRead()
        return replay.getSince(seq)?.map(function encodeStoreReplayTail(event) {
            return encode(cloneStoreReplayBatchEvent(event))
        }) ?? null
    }
    function keyframe() {
        prepareRead()
        const event = replay.keyframe()
        // Store's currentBatch provider has just produced an owned snapshot.
        // Cloning that fresh 15k tree again only adds allocation churn; live,
        // journal-tail and compact-frame events retain their defensive clone.
        return event ? encode(event) : null
    }
    function frame(seq: number, hint?: unknown) {
        prepareRead()
        return replay.frame(seq, hint).map(function encodeStoreReplayFrame(event) {
            return encode(cloneStoreReplayBatchEvent(event))
        })
    }
    const facade = {
        line,
        since,
        keyframe,
        frame,
    }
    return brandRpcReplayWire(facade, {
        head: replay.head,
        sequenceOf(value) {
            return Array.isArray(value) && typeof value[1] == 'number' ? value[1] : undefined
        },
    })
}

function exposeStoreReplayBatch(replay: StoreReplayBatchLine, prepareRead: () => void) {
    return exposeStoreReplayWire(replay, encodeStoreReplayBatchV2, prepareRead)
}

function subscribeDecodedReplayLine<W>(
    line: StoreReplayWireRemote<W>['line'],
    decode: (wire: W | unknown) => ReplayEvent<[StorePatch[]]>,
    cb: (event: ReplayEvent<[StorePatch[]]>) => void,
    opts?: unknown,
) {
    let upstream: any
    let upstreamStopped = false
    let stopped = false
    let failed = false
    let rejectDecode = function rejectDecodeLater(_error: unknown) {}
    const decodeFailure = new Promise<void>(function captureDecodeFailure(_resolve, reject) {
        rejectDecode = reject
    })
    let resolveLocalClose = function resolveLocalCloseLater() {}
    const localClose = new Promise<void>(function captureLocalClose(resolve) {
        resolveLocalClose = resolve
    })
    const offLocalClose = Object.prototype.hasOwnProperty.call(line, 'onClose')
        && typeof (line as any).onClose == 'function'
        ? (line as any).onClose(function decodedReplaySourceClosed() { resolveLocalClose() })
        : function noDecodedReplayCloseListener() {}

    function stopUpstream() {
        if (upstreamStopped) return
        upstreamStopped = true
        if (typeof upstream == 'function') upstream()
        else if (typeof upstream?.off == 'function') upstream.off()
        else if (typeof upstream?.unsubscribe == 'function') upstream.unsubscribe()
    }

    function failDecode(error: unknown) {
        if (failed || stopped) return
        failed = true
        rejectDecode(error)
        if (upstream != null) stopUpstream()
    }

    function decodeLiveStoreReplay(wire: W) {
        if (failed || stopped) return
        try { cb(decode(wire)) }
        catch (error) { failDecode(error) }
    }

    try { upstream = (line.on as any)(decodeLiveStoreReplay, opts) }
    catch (error) { failDecode(error) }
    if (failed) stopUpstream()

    const upstreamEnd = typeof upstream?.then == 'function'
        ? Promise.resolve(upstream)
        : new Promise<void>(function waitForRemoteReplayEnd() {})
    const ended = Promise.race([decodeFailure, localClose, upstreamEnd])
    return makeOff(ended, function closeDecodedReplayLine() {
        stopped = true
        offLocalClose()
        stopUpstream()
    })
}

function decodeStoreReplayWireRemote<W>(
    remote: StoreReplayWireRemote<W>,
    decode: (wire: W | unknown) => ReplayEvent<[StorePatch[]]>,
    lifecycleSource: any = remote,
    knowledge?: () => unknown,
): ReplayRemote<[StorePatch[]]> {
    function decodeEvents(events: W[] | null | undefined) {
        if (events == null) return events
        return events.map(decode)
    }
    function decodeEvent(event: W | null | undefined): ReplayEvent<[StorePatch[]]> | null | undefined {
        if (event == null) return event as null | undefined
        return decode(event)
    }
    function subscribeLine(cb: (event: ReplayEvent<[StorePatch[]]>) => void) {
        return subscribeDecodedReplayLine(
            remote.line,
            decode,
            cb,
            knowledge ? {knowledge: knowledge()} : undefined,
        )
    }
    async function since(seq: number) {
        return decodeEvents(await (remote.since as any)(seq, knowledge?.()))
    }
    async function keyframe() {
        return decodeEvent(await (remote.keyframe as any)(knowledge?.()))
    }
    const decoded: ReplayRemote<[StorePatch[]]> = {
        line: {on: subscribeLine},
        since,
        keyframe,
    }
    if (rpcMemberAvailable(remote, 'frame')) {
        decoded.frame = async function decodeFrame(seq, hint) {
            return decodeEvents(await (remote.frame as any)(seq, hint, knowledge?.()))
        }
    }
    if (rpcMemberAvailable(remote, 'frameLine')) {
        function subscribeFrameLine(cb: (event: ReplayEvent<[StorePatch[]]>) => void) {
            return subscribeDecodedReplayLine(
                remote.frameLine!,
                decode,
                cb,
                knowledge ? {knowledge: knowledge()} : undefined,
            )
        }
        decoded.frameLine = {
            on: subscribeFrameLine,
        }
    }
    Object.defineProperty(decoded, RPC_TRANSPORT_LIFECYCLE, {get: () => lifecycleSource[RPC_TRANSPORT_LIFECYCLE]})
    Object.defineProperty(decoded, RPC_MEMBER_LOOKUP, {get: () => (remote as any)[RPC_MEMBER_LOOKUP]})
    Object.defineProperty(decoded, RPC_SCHEMA_READY, {get: () => lifecycleSource[RPC_SCHEMA_READY]})
    return decoded
}

function decodeStoreReplayRemote(remote: StoreReplayBatchRemote) {
    function decodeStoreReplayV2(value: unknown) {
        const local = value as ReplayEvent<[StorePatch[]]>
        if (local && typeof local == 'object' && typeof local.seq == 'number' && typeof local.ts == 'number'
            && Array.isArray(local.event) && Array.isArray(local.event[0])) {
            return cloneStoreReplayBatchEvent(local)
        }
        return decodeStoreReplayBatchV2(value)
    }
    return decodeStoreReplayWireRemote(remote, decodeStoreReplayV2)
}

/**
 * Server side: exposeStore + numbered patch line.
 * Subscription to store is HOT — journal must see every change, even when
 * there are no subscribers, otherwise there are holes in the line. Cost: one listenPaths-listener + ring.
 */
export function exposeStoreReplay<T extends object>(store: Store<T>, opts: StoreReplayOpts = {}) {
    function currentStoreReplayBatch() {
        return [[{path: [], exists: true, value: store.snapshot()}]] as [readonly StorePatch[]]
    }
    const batchReplay = createBatchReplay(currentStoreReplayBatch, opts)
    const replayApi = exposeStoreReplayBatch(batchReplay.replay, batchReplay.flush)

    const {patches: _patches, patchesBatch: _patchesBatch, changedData: _changedData, ...storeApi} = exposeStore(store, {push: true})
    const getExactPatches = (store as Store<T> & {
        [STORE_REPLAY_PATCH_SOURCE]?: () => StoreReplayPatchSource
    })[STORE_REPLAY_PATCH_SOURCE]
    const patchBatches = opts.patchSource ?? getExactPatches?.() ?? listenStorePatches(store)

    const offStore = patchBatches.on(function journalStoreChange(patches) {
        batchReplay.push(patches)
    })
    function describe() {
        return cloneStoreValue(opts.describe!)
    }
    function retryPending() {
        batchReplay.flush()
    }
    function close() {
        offStore()
        batchReplay.close()
    }
    const replayFacade = opts.describe ? {...replayApi, describe} : replayApi
    retransmitRpcReplayWire(replayApi, replayFacade)
    return {
        /** Wire facade: pass to RPC server (object: api). Compatible with regular exposeStore. */
        api: {...storeApi, replay: replayFacade},
        /** Local replay-line — in-proc consumers, introspection (head/getSince). */
        replay: batchReplay.replay,
        batchStats: batchReplay.stats,
        /** Retry patches retained after a journal precommit failure. */
        flushPending: retryPending,
        close,
    }
}

/**
 * Client side: mirror over line. keyframe/tail/live use one patch mechanism.
 */
export function syncStoreReplayBatch<T extends object>(
    store: Store<T>, remote: StoreReplayBatchRemote, opts: StoreReplaySyncOpts<T> = {},
) {
    const {onBatch, validateBatch, ...wireOpts} = opts
    return replaySubscribe(decodeStoreReplayRemote(remote), function applyBatch(patches) {
        validateBatch?.(patches, store)
        applyStorePatches(store, patches)
        onBatch?.(patches, store)
    }, wireOpts)
}

function syncStoreReplayResolved<T extends object>(store: Store<T>, remote: StoreReplayRemote, opts: StoreReplaySyncOpts<T>) {
    return Object.assign(syncStoreReplayBatch(store, remote, opts), {mode: 'v2' as const})
}

function deferStoreReplaySync<T extends object>(
    store: Store<T>, remote: StoreReplayRemote, opts: StoreReplaySyncOpts<T>, schemaReady: () => Promise<void>,
) {
    let sub: (ReturnType<typeof replaySubscribe<any>> & {mode: tStoreReplayMode}) | undefined
    let closed = false
    let closeGate: () => void = function closeLater() {}
    const closedFirst = new Promise<'closed'>(function waitForClose(resolve) {
        closeGate = function resolveClosed() { resolve('closed') }
    })
    const schemaFirst = Promise.resolve().then(schemaReady).then(
        function schemaResolved() { return 'schema' as const },
        function schemaFailed(error) {
            if (closed) return 'closed' as const
            if (opts.onError) {
                try { opts.onError(error) }
                catch (caught) { setTimeout(function rethrowSchemaError() { throw caught }, 0) }
            } else setTimeout(function rethrowSchemaFailure() { throw error }, 0)
            return 'closed' as const
        },
    )
    const ready = Promise.race([schemaFirst, closedFirst]).then(async function startAfterSchema(state) {
        if (state == 'closed' || closed) return
        sub = syncStoreReplayResolved(store, remote, opts)
        await sub.ready
    })
    function off() {
        if (closed) return
        closed = true
        closeGate()
        sub?.()
    }
    const result = Object.assign(off, {
        ready,
        seq: () => sub?.seq() ?? opts.since ?? -1,
        isStale: () => sub?.isStale() ?? false,
        lastTs: () => sub?.lastTs() ?? 0,
        mode: 'v2' as const,
    })
    return result
}

export function syncStoreReplay<T extends object>(store: Store<T>, remote: StoreReplayRemote, opts: StoreReplaySyncOpts<T> = {}) {
    const schemaReady = getRpcMemberState(remote, 'line') == undefined
        ? getRpcSchemaReady(remote)
        : undefined
    return schemaReady
        ? deferStoreReplaySync(store, remote, opts, schemaReady)
        : syncStoreReplayResolved(store, remote, opts)
}

const storeReplayViewLayer = createStoreReplayViewLayer({
    createBatchReplay,
    exposeStoreReplayBatch,
    syncStoreReplay,
})

/** Read-only selective replay over one authoritative Store. */
export function createStoreReplayView<
    T extends object,
    K extends Extract<keyof T, string> = Extract<keyof T, string>,
>(store: Store<T>, opts: StoreReplayViewOpts<K>) {
    return storeReplayViewLayer.createStoreReplayView(store, opts)
}

/** Atomic selected-view mirror with bounded snapshot transport. */
export function syncStoreReplayView<T extends object>(
    store: Store<T>,
    remote: StoreReplayViewRemote,
    opts: StoreReplayViewSyncOpts<T> = {},
) {
    return storeReplayViewLayer.syncStoreReplayView(store, remote, opts)
}

function syncStoreReplayRouteResolved<T extends object>(
    store: Store<T>, remote: StoreReplayRemote, opts: StoreReplayRouteOpts<T>,
) {
    const {onBatch, validateBatch, ...routeOpts} = opts
    const route = replayRouteSubscribe<[StorePatch[]]>(decodeStoreReplayRemote(remote), function applyRouteBatch(patches) {
        validateBatch?.(patches, store)
        applyStorePatches(store, patches)
        onBatch?.(patches, store)
    }, routeOpts)
    const switchBatchRoute = route.switch
    let closed = false
    let generation = 0
    const schemaWaitCancels = new Set<() => void>()

    async function waitForV2Schema(nextRemote: StoreReplayRemote) {
        if (getRpcMemberState(nextRemote, 'line') != undefined) return
        const schemaReady = getRpcSchemaReady(nextRemote)
        if (!schemaReady) return
        const waitGeneration = generation
        let cancel = function cancelLater() {}
        const closedFirst = new Promise<'closed'>(function waitForRouteClose(resolve) {
            cancel = function resolveRouteClosed() { resolve('closed') }
        })
        schemaWaitCancels.add(cancel)
        try {
            const state = await Promise.race([
                Promise.resolve().then(schemaReady).then(function batchSchemaResolved() { return 'schema' as const }),
                closedFirst,
            ])
            if (state == 'closed' || closed || generation != waitGeneration) {
                throw new Error('syncStoreReplayRoute: closed')
            }
        } finally {
            schemaWaitCancels.delete(cancel)
        }
    }

    async function switchRoute(nextRemote: StoreReplayRemote, nextOpts: Parameters<typeof route.switch>[1] = {}) {
        if (closed) throw new Error('syncStoreReplayRoute: closed')
        await waitForV2Schema(nextRemote)
        if (closed) throw new Error('syncStoreReplayRoute: closed')
        return switchBatchRoute(decodeStoreReplayRemote(nextRemote), nextOpts)
    }

    function off() {
        if (closed) return
        closed = true
        generation++
        for (const cancel of [...schemaWaitCancels]) cancel()
        schemaWaitCancels.clear()
        route()
    }

    return Object.assign(off, {
        ready: route.ready,
        switch: switchRoute,
        seq: route.seq,
        label: route.label,
        active: route.active,
        mode: 'v2' as const,
    })
}

function deferStoreReplayRoute<T extends object>(
    store: Store<T>, remote: StoreReplayRemote, opts: StoreReplayRouteOpts<T>, schemaReady: () => Promise<void>,
) {
    let route: ReturnType<typeof syncStoreReplayRouteResolved<T>> | undefined
    let closed = false
    let schemaFailed = false
    let closeGate: () => void = function closeLater() {}
    const closedFirst = new Promise<'closed'>(function waitForClose(resolve) {
        closeGate = function resolveClosed() { resolve('closed') }
    })
    const schemaFirst = Promise.resolve().then(schemaReady).then(
        function schemaResolved() { return 'schema' as const },
        function schemaRejected(error) {
            if (closed) return 'closed' as const
            schemaFailed = true
            if (opts.onError) {
                try { opts.onError(error) }
                catch (caught) { setTimeout(function rethrowRouteSchemaError() { throw caught }, 0) }
            } else setTimeout(function rethrowRouteSchemaFailure() { throw error }, 0)
            return 'closed' as const
        },
    )
    const ready = Promise.race([schemaFirst, closedFirst]).then(async function startRouteAfterSchema(state) {
        if (state == 'closed' || closed) return
        route = syncStoreReplayRouteResolved(store, remote, opts)
        await route.ready
    })
    let switchChain: Promise<unknown> = ready.catch(function initialRouteFailed() {})

    function switchRoute(nextRemote: StoreReplayRemote, nextOpts: ReplayRouteSwitchOpts = {}) {
        async function runSwitch() {
            await ready
            if (closed || schemaFailed || !route) throw new Error('syncStoreReplayRoute: closed')
            return route.switch(nextRemote, nextOpts)
        }
        const pending = switchChain.then(runSwitch, runSwitch)
        switchChain = pending.catch(function routeSwitchFailed() {})
        return pending
    }

    function off() {
        if (closed) return
        closed = true
        closeGate()
        route?.()
    }
    const result = Object.assign(off, {
        ready,
        switch: switchRoute,
        seq: () => route?.seq() ?? opts.since ?? -1,
        label: () => route?.label() ?? opts.label,
        active: () => route?.active() ?? false,
        mode: 'v2' as const,
    })
    return result
}

/**
 * Route-switching store mirror: keep the old route alive, catch up the replacement
 * route from the last delivered seq, then close the old one. Use for relay <-> direct
 * promotion/re-interposition when the authority/replay line stays semantically the same.
 */
export function syncStoreReplayRoute<T extends object>(store: Store<T>, remote: StoreReplayRemote, opts: StoreReplayRouteOpts<T> = {}) {
    const schemaReady = getRpcMemberState(remote, 'line') == undefined
        ? getRpcSchemaReady(remote)
        : undefined
    return schemaReady
        ? deferStoreReplayRoute(store, remote, opts, schemaReady)
        : syncStoreReplayRouteResolved(store, remote, opts)
}

/**
 * One-line remote-fold: mirror over line → callback per CHANGED top-key
 * (createStore + syncStoreReplay + store.each().on in one call). Keyframe at start
 * is expanded by keys, key deletion = (key, undefined), value = store.state[key]
 * at flush time. All ReplaySubscribeOpts pass straight through (since/policy/staleMs/onError...).
 * Return — composite off (removes both each subscription and wire subscription) with mirror
 * for direct reads (off.store.state.BTCUSDT) and ready/seq/isStale/lastTs of wire.
 */
export function syncStoreReplayEach<T extends object>(
    remote: StoreReplayRemote,
    cb: (key: string, value: T[keyof T] | undefined, ctx: StoreEachCtx) => void,
    opts: StoreReplaySyncOpts<T> & {drain?: StoreDrain, initial?: T} = {},
) {
    const {drain, initial, ...wireOpts} = opts
    const store = createStore<T>((initial ?? {}) as T, drain !== undefined ? {drain} : {})
    // each BEFORE wire: first catch-up keyframe must be expanded into callbacks
    const offEach = store.each().on(cb)
    const sub = syncStoreReplay(store, remote, wireOpts)
    function off() { offEach(); sub() }
    const result = Object.assign(off, {
        /** Mirror — for direct reads and additional subscriptions. */
        store,
        ready: sub.ready,
        seq: sub.seq,
        isStale: sub.isStale,
        lastTs: sub.lastTs,
    })
    Object.defineProperty(result, 'mode', {enumerable: true, get: () => sub.mode})
    return result as typeof result & {readonly mode: tStoreReplayMode}
}

/**
 * Time machine over patch archive (archiveReplay + ReplayStorage): snapshot
 * of state at the moment at (seq/ts; no at — last archived). Keyframe
 * and deltas are applied by ONE mechanism applyStorePatches. undefined = archive is empty.
 */
export function storeReplayAt<T extends object>(
    storage: ReplayStorage<[readonly StorePatch[]]>,
    at: {seq?: number, ts?: number} = {},
) {
    const envelopes = openHistory(storage).at(at)
    if (!envelopes) return undefined
    const scratch = createStore<any>({})
    for (const ev of envelopes) applyStorePatches(scratch, ev.event[0])
    return scratch.snapshot() as T
}
