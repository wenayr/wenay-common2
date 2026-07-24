// =====================================================================
// store ⇄ replay — patch journal with seq, keyframe = root-patch
// =====================================================================
// All logic is in withReplayListen; store adds exactly "patch as event type".
// Keyframe — StorePatch with path: [] (replaceRoot): mirror applies ONE mechanism
// applyStorePatch for both snapshot and deltas. Reconnect stops costing a full
// snapshot when the journal tail is enough.

import {
    type Store, type StorePatch, type StoreDrain, type StoreEachCtx,
    applyStorePatch, applyStorePatches, cloneStoreValue, createStore, exposeStore, listenStorePatches,
} from './store'
import {replayListen, type ReplayListenOptions, type ReplayEvent} from '../events/replay-listen'
import {
    type ReplayExpose, replaySubscribe, type ReplayRemote, type ReplaySubscribeOpts,
} from '../events/replay-wire'
import {
    replayRouteSubscribe, type ReplayRouteSubscribeOpts, type ReplayRouteSwitchOpts,
} from '../events/replay-route'
import {openHistory, type ReplayStorage} from '../events/replay-history'
import {mapListen} from '../events/mapListen'
import {makeOff} from '../rcp/rpc-off'
import {getRpcResultLimits} from '../rcp/rpc-result-limits'
import {positiveIntegerOption} from '../positive-integer-option'
import {
    RPC_MEMBER_LOOKUP, RPC_SCHEMA_READY, RPC_TRANSPORT_LIFECYCLE,
    getRpcMemberState, getRpcSchemaReady, getRpcTransportLifecycle, rpcMemberAvailable,
} from '../events/transport-lifecycle'
import {
    type tStoreReplayWireBatch, type tStoreReplayWireBatchV2, type tStoreReplayWireBatchV3,
    type tStoreReplayWireBatchV4, type tStoreReplayWireBatchV5,
    decodeStoreReplayBatch, decodeStoreReplayBatchV2, decodeStoreReplayBatchV3,
    decodeStoreReplayBatchV4, decodeStoreReplayBatchV5,
    encodeStoreReplayBatch, encodeStoreReplayBatchV2, encodeStoreReplayBatchV3,
    encodeStoreReplayBatchV4, encodeStoreReplayBatchV5,
    storeReplayBatchMaxWireMetrics, storeReplayPatchMaxWireMetrics,
} from './store-replay-codec'
import {STORE_REPLAY_BINARY_MAX_WIRE_BYTES} from './store-replay-binary'
import {
    createStoreReplayMsgpackCodec,
    type tStoreReplaySchemaKnowledge,
    type tStoreReplayWireBatchV7,
} from './store-replay-msgpack'

export type StoreReplayBatchOpts = Pick<ReplayListenOptions<[readonly StorePatch[]]>,
    'history' | 'getSince' | 'onJournal' | 'onJournalBatch' | 'now' | 'firstSeq'> & {
    /** Hard item ceiling per envelope (default 256). */
    maxItems?: number
    /** Conservative packed v1-v5 RPC payload target (default 64 KiB; one indivisible patch may exceed it). */
    maxBytes?: number
    /** Optional aggregation across Store drain windows (default 0 = preserve each natural window). */
    maxDelayMs?: number
}

export type StoreReplayPatchSource = {
    /** Patches are absolute facts; Store state already reflects the whole reported batch. */
    on(cb: (patches: readonly StorePatch[]) => void): () => void
}

export type StoreReplayOpts = Pick<ReplayListenOptions<[StorePatch]>,
    'history' | 'getSince' | 'onJournal' | 'onJournalBatch' | 'now' | 'firstSeq'> & {
    /** Static source descriptor served to clients as replay.describe(): schema/originId/... (JSON-able). */
    describe?: Record<string, any>
    /** Add the negotiated compact batch capability at api.replay.batch. Legacy replay stays intact. */
    batch?: boolean | StoreReplayBatchOpts
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

export type StoreReplayBatchV2Remote = StoreReplayWireRemote<tStoreReplayWireBatchV2>
export type StoreReplayBatchV3Remote = StoreReplayWireRemote<tStoreReplayWireBatchV3>
export type StoreReplayBatchV4Remote = StoreReplayWireRemote<tStoreReplayWireBatchV4>
export type StoreReplayBatchV5Remote = StoreReplayWireRemote<tStoreReplayWireBatchV5>
export type StoreReplayBatchV6Remote =
    StoreReplayWireRemote<ReplayEvent<[readonly StorePatch[]]>>
export type StoreReplayBatchV7Remote = {
    line: {
        on(
            cb: (batch: tStoreReplayWireBatchV7) => void,
            opts?: {knowledge?: tStoreReplaySchemaKnowledge},
        ): any
    }
    since(
        seq: number,
        knowledge?: tStoreReplaySchemaKnowledge,
    ): Promise<tStoreReplayWireBatchV7[] | null | undefined>
        | tStoreReplayWireBatchV7[] | null | undefined
    keyframe(
        knowledge?: tStoreReplaySchemaKnowledge,
    ): Promise<tStoreReplayWireBatchV7 | null | undefined>
        | tStoreReplayWireBatchV7 | null | undefined
    frame?(
        seq: number,
        hint?: unknown,
        knowledge?: tStoreReplaySchemaKnowledge,
    ): Promise<tStoreReplayWireBatchV7[] | null | undefined>
        | tStoreReplayWireBatchV7[] | null | undefined
    frameLine?: {
        on(
            cb: (batch: tStoreReplayWireBatchV7) => void,
            opts?: {knowledge?: tStoreReplaySchemaKnowledge},
        ): any
    }
}
export type StoreReplayBatchRemote = StoreReplayWireRemote<tStoreReplayWireBatch> & {
    /** Same logical replay/seq-space, encoded with packed v2 tuples. */
    v2?: StoreReplayBatchV2Remote
    /** Same logical replay/seq-space, with recursive explicit-undefined preservation. */
    v3?: StoreReplayBatchV3Remote
    /** Same logical replay/seq-space, encoded with envelope-local column plans. */
    v4?: StoreReplayBatchV4Remote
    /** Same logical replay/seq-space, encoded as a compact binary envelope. */
    v5?: StoreReplayBatchV5Remote
    /**
     * Same logical replay/seq-space without a Store-specific inner encoding.
     * The negotiated universal RPC schema codec owns its physical representation.
     */
    v6?: StoreReplayBatchV6Remote
    /** Same logical replay/seq-space, encoded directly by msgpackr records. */
    v7?: StoreReplayBatchV7Remote
}

export type StoreReplayRemote = ReplayRemote<[StorePatch]> & {batch?: StoreReplayBatchRemote}

export type tStoreReplayMode = 'legacy' | 'batch'

export type StoreReplaySyncOpts<T extends object = any> = ReplaySubscribeOpts & {
    /** Prefer api.replay.batch when the server advertises it; fall back to legacy when absent. */
    batch?: boolean
    /** Runs after one decoded physical envelope is applied; bounds may split a source drain and delay may merge drains. */
    onBatch?: (patches: readonly StorePatch[], store: Store<T>) => void
    /** Validate one decoded envelope before any Store mutation. */
    validateBatch?: (patches: readonly StorePatch[], store: Store<T>) => void
}

export type StoreReplayRouteOpts<T extends object = any> = ReplayRouteSubscribeOpts & {
    /** Pin this route subscription to batch coordinates when the first route supports them. */
    batch?: boolean
    /** Runs after one decoded route envelope is applied; its boundary need not equal one source drain. */
    onBatch?: (patches: readonly StorePatch[], store: Store<T>) => void
    /** Validate one decoded envelope before any Store mutation. */
    validateBatch?: (patches: readonly StorePatch[], store: Store<T>) => void
}

/** Resolve the coordinate space before subscribing; callers that persist seq must persist this too. */
export function storeReplayMode(remote: StoreReplayRemote, preferBatch = false): tStoreReplayMode {
    return preferBatch && rpcMemberAvailable(remote, 'batch') ? 'batch' : 'legacy'
}

/**
 * keyOf for patch line (conflateReplay): collapse by exact path.
 * Patch is absolute by its path, and the order of last touches = order by seq,
 * so "last patch of each path" gives the same state as the entire line —
 * including ancestor/descendant overlaps (ancestor patch carries the entire subtree).
 * In the new path (frame on line) — internal detail of condensePatchTail below.
 */
export function storePatchKey(patch: StorePatch) {
    // symbol in JSON.stringify would become null → collisions; such patch is not collapsed
    for (const k of patch.path) if (typeof k == 'symbol') return null
    return JSON.stringify(patch.path)
}

// Compressor of patch-line frame (frame-lambda for replayListen): last patch
// of each exact path, order of last touches = order by seq (delete+re-insert).
// Non-collapsible patch (symbol in path) → honest full tail, without partial magic.
function condensePatchTail(tail: ReplayEvent<[StorePatch]>[]) {
    const held = new Map<string, ReplayEvent<[StorePatch]>>()
    for (const ev of tail) {
        const k = storePatchKey(ev.event[0])
        if (k == null) return tail
        held.delete(k)
        held.set(k, ev)
    }
    return [...held.values()]
}

function cloneStoreReplayPatch(patch: StorePatch): StorePatch {
    return {
        path: [...patch.path],
        exists: patch.exists,
        value: patch.exists ? cloneStoreValue(patch.value) : undefined,
    }
}

function cloneStoreReplayEvent(event: ReplayEvent<[StorePatch]>): ReplayEvent<[StorePatch]> {
    return {seq: event.seq, ts: event.ts, event: [cloneStoreReplayPatch(event.event[0])]}
}

function cloneStoreReplayBatchEvent(
    event: ReplayEvent<[readonly StorePatch[]]>,
): ReplayEvent<[readonly StorePatch[]]> {
    return {seq: event.seq, ts: event.ts, event: [event.event[0].map(cloneStoreReplayPatch)]}
}

type StoreReplayLine = ReturnType<typeof replayListen<[StorePatch]>>[1]

function exposeStoreReplayLine(replay: StoreReplayLine): ReplayExpose<[StorePatch]> {
    const [, line] = mapListen(replay.line, function cloneStoreReplayLive(event) {
        return [cloneStoreReplayEvent(event)] as [ReplayEvent<[StorePatch]>]
    })
    replay.line.onClose(function closeClonedStoreReplayLine() { line.close() })
    function since(seq: number) {
        return replay.getSince(seq)?.map(cloneStoreReplayEvent) ?? null
    }
    function keyframe() {
        const event = replay.keyframe()
        return event ? cloneStoreReplayEvent(event) : null
    }
    function frame(seq: number, hint?: unknown) {
        return replay.frame(seq, hint).map(cloneStoreReplayEvent)
    }
    return {line, since, keyframe, frame}
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

function createBatchReplay<T extends object>(store: Store<T>, opts: StoreReplayBatchOpts) {
    const maxItems = positiveIntegerOption(opts.maxItems, 256, 'exposeStoreReplay: batch.maxItems')
    const maxBytes = positiveIntegerOption(opts.maxBytes, 64 * 1024, 'exposeStoreReplay: batch.maxBytes')
    const maxDelayMs = opts.maxDelayMs ?? 0
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) throw new RangeError('exposeStoreReplay: batch.maxDelayMs must be >= 0')

    function currentBatch() {
        return [[{path: [], exists: true, value: store.snapshot()}]] as [readonly StorePatch[]]
    }

    const [emitBatch, replay] = replayListen<[readonly StorePatch[]]>({
        current: currentBatch,
        frame: condenseBatchPatchTail,
        history: opts.getSince ? undefined : (opts.history ?? 1024),
        getSince: opts.getSince,
        onJournal: opts.onJournal,
        onJournalBatch: opts.onJournalBatch,
        now: opts.now,
        firstSeq: opts.firstSeq,
    })

    // 48 bytes conservatively covers [version, seq, ts, [...]] with safe-integer coordinates.
    const envelopeBytes = 48
    let pending: StorePatch[] = []
    const ready: {patches: StorePatch[], bytes: number}[] = []
    let pendingBytes = envelopeBytes
    let pendingBinaryCount = 0
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
        pending = []
        pendingBytes = envelopeBytes
        pendingBinaryCount = 0
        const planned: {patches: StorePatch[], bytes: number}[] = []
        splitToWireLimit(sealed, estimated, planned)
        target.push(...planned)
    }

    function splitToWireLimit(
        patches: StorePatch[],
        estimated: number,
        planned: {patches: StorePatch[], bytes: number}[],
    ) {
        // v4 exact-number tags and v5 float64 are the only material expansion
        // over the legacy estimate; a dense -0 array is the worst supported
        // case (< 5.5x). Keep ordinary quote drains on the single-pass path.
        const wireTarget = Math.min(maxBytes, STORE_REPLAY_BINARY_MAX_WIRE_BYTES)
        if (estimated * 8 <= wireTarget) {
            planned.push({patches, bytes: estimated})
            return
        }
        let bytes: number
        try {
            bytes = storeReplayBatchMaxWireMetrics(patches).byteLength
        } catch (error) {
            // A combined v5 frame may exceed its hard codec ceiling even when
            // both halves are valid. Split and remeasure; an indivisible bad
            // value remains a loud producer error instead of a broken live head.
            if (patches.length == 1) throw error
            const middle = Math.ceil(patches.length / 2)
            splitToWireLimit(patches.slice(0, middle), maxBytes, planned)
            splitToWireLimit(patches.slice(middle), maxBytes, planned)
            return
        }
        if (bytes <= wireTarget || patches.length == 1) {
            planned.push({patches, bytes})
            return
        }
        const middle = Math.ceil(patches.length / 2)
        splitToWireLimit(patches.slice(0, middle), bytes, planned)
        splitToWireLimit(patches.slice(middle), bytes, planned)
    }

    function validate(patches: readonly StorePatch[]) {
        try {
            encodeStoreReplayBatchV5({
                seq: Number.MAX_SAFE_INTEGER,
                ts: Number.MAX_SAFE_INTEGER,
                event: [patches],
            })
        } catch (error) {
            // The hard frame limit is physical, not logical: a large source
            // window is valid when every recursively bounded part is valid.
            if (patches.length == 1) throw error
            const middle = Math.ceil(patches.length / 2)
            validate(patches.slice(0, middle))
            validate(patches.slice(middle))
        }
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
        for (const patch of patches) {
            let metrics: {byteLength: number, binaryCount: number}
            try { metrics = storeReplayPatchMaxWireMetrics(patch, pendingBinaryCount) }
            catch { metrics = {byteLength: maxBytes, binaryCount: 0} }
            let bytes = metrics.byteLength + 1
            if (pending.length && (pending.length >= maxItems || pendingBytes + bytes > maxBytes)) {
                sealPending(staged)
                try { metrics = storeReplayPatchMaxWireMetrics(patch) }
                catch { metrics = {byteLength: maxBytes, binaryCount: 0} }
                bytes = metrics.byteLength + 1
            }
            pending.push(patch)
            pendingBytes += bytes
            pendingBinaryCount += metrics.binaryCount
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
        validate,
        push,
        flush,
        close,
        stats,
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
    return {
        line,
        since,
        keyframe,
        frame,
    }
}

function exposeStoreReplayBatchV2(replay: StoreReplayBatchLine, prepareRead: () => void) {
    return exposeStoreReplayWire(replay, encodeStoreReplayBatchV2, prepareRead)
}

function exposeStoreReplayBatchV3(replay: StoreReplayBatchLine, prepareRead: () => void) {
    return exposeStoreReplayWire(replay, encodeStoreReplayBatchV3, prepareRead)
}

function exposeStoreReplayBatchV4(replay: StoreReplayBatchLine, prepareRead: () => void) {
    return exposeStoreReplayWire(replay, encodeStoreReplayBatchV4, prepareRead)
}

function exposeStoreReplayBatchV5(replay: StoreReplayBatchLine, prepareRead: () => void) {
    return exposeStoreReplayWire(replay, encodeStoreReplayBatchV5, prepareRead)
}

function exposeStoreReplayBatchV6(replay: StoreReplayBatchLine, prepareRead: () => void) {
    return exposeStoreReplayWire(
        replay,
        event => event,
        prepareRead,
    )
}

function exposeStoreReplayBatchV7(replay: StoreReplayBatchLine, prepareRead: () => void) {
    const codec = createStoreReplayMsgpackCodec()
    const [, preparedLine] = mapListen(replay.line, function prepareStoreReplayV7Live(event) {
        return [codec.prepare(cloneStoreReplayBatchEvent(event))]
    })
    replay.line.onClose(function closePreparedStoreReplayV7Line() { preparedLine.close() })

    const line = {
        ...preparedLine,
        on(
            cb: (wire: tStoreReplayWireBatchV7) => void,
            opts: {knowledge?: tStoreReplaySchemaKnowledge} = {},
        ) {
            const knowledge = codec.createRemoteKnowledge(opts.knowledge)
            return preparedLine.on(function encodeStoreReplayV7Live(payload) {
                cb(codec.wire(payload, knowledge))
            }, opts as any)
        },
    }

    function since(seq: number, snapshot?: tStoreReplaySchemaKnowledge) {
        prepareRead()
        const knowledge = codec.createRemoteKnowledge(snapshot)
        return replay.getSince(seq)?.map(function encodeStoreReplayV7Tail(event) {
            return codec.encode(cloneStoreReplayBatchEvent(event), knowledge)
        }) ?? null
    }

    function keyframe(snapshot?: tStoreReplaySchemaKnowledge) {
        prepareRead()
        const event = replay.keyframe()
        if (!event) return null
        return codec.encode(event, codec.createRemoteKnowledge(snapshot))
    }

    function frame(
        seq: number,
        hint?: unknown,
        snapshot?: tStoreReplaySchemaKnowledge,
    ) {
        prepareRead()
        const knowledge = codec.createRemoteKnowledge(snapshot)
        return replay.frame(seq, hint).map(function encodeStoreReplayV7Frame(event) {
            return codec.encode(cloneStoreReplayBatchEvent(event), knowledge)
        })
    }

    return {
        line,
        since,
        keyframe,
        frame,
    }
}

function exposeStoreReplayBatch(replay: StoreReplayBatchLine, prepareRead: () => void) {
    return {
        ...exposeStoreReplayWire(replay, encodeStoreReplayBatch, prepareRead),
        v2: exposeStoreReplayBatchV2(replay, prepareRead),
        v3: exposeStoreReplayBatchV3(replay, prepareRead),
        v4: exposeStoreReplayBatchV4(replay, prepareRead),
        v5: exposeStoreReplayBatchV5(replay, prepareRead),
        v6: exposeStoreReplayBatchV6(replay, prepareRead),
        v7: exposeStoreReplayBatchV7(replay, prepareRead),
    }
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
    type tCodec = 'v1' | 'v2' | 'v3' | 'v4' | 'v5' | 'v6' | 'v7'

    const lifecycle = getRpcTransportLifecycle(remote)
    const schemaReady = getRpcSchemaReady(remote)
    const resultLimits = getRpcResultLimits(remote)
    let activeCodec: tCodec | null = null
    let activeRemote: ReplayRemote<[StorePatch[]]> | null = null

    function selectedCodec(): tCodec {
        if (rpcMemberAvailable(remote, 'v7')) return 'v7'
        if (rpcMemberAvailable(remote, 'v6')) return 'v6'
        if (rpcMemberAvailable(remote, 'v5')) return 'v5'
        if (rpcMemberAvailable(remote, 'v4')) return 'v4'
        if (rpcMemberAvailable(remote, 'v3')) return 'v3'
        if (rpcMemberAvailable(remote, 'v2')) return 'v2'
        return 'v1'
    }

    function selectedRemote() {
        const codec = selectedCodec()
        if (activeRemote && activeCodec == codec) return activeRemote
        activeCodec = codec
        if (codec == 'v7') {
            const msgpack = createStoreReplayMsgpackCodec()
            activeRemote = decodeStoreReplayWireRemote(
                remote.v7!,
                wire => msgpack.decode(wire as tStoreReplayWireBatchV7),
                remote,
                msgpack.knowledge,
            )
        } else if (codec == 'v6') {
            activeRemote = decodeStoreReplayWireRemote(
                remote.v6!,
                event => event as ReplayEvent<[StorePatch[]]>,
                remote,
            )
        } else if (codec == 'v5') {
            activeRemote = decodeStoreReplayWireRemote(
                remote.v5!,
                function decodeLimitedStoreReplayBatchV5(wire) {
                    return decodeStoreReplayBatchV5(wire, resultLimits)
                },
                remote,
            )
        } else if (codec == 'v4') {
            activeRemote = decodeStoreReplayWireRemote(remote.v4!, decodeStoreReplayBatchV4, remote)
        } else if (codec == 'v3') {
            activeRemote = decodeStoreReplayWireRemote(remote.v3!, decodeStoreReplayBatchV3, remote)
        } else if (codec == 'v2') {
            activeRemote = decodeStoreReplayWireRemote(remote.v2!, decodeStoreReplayBatchV2, remote)
        } else {
            activeRemote = decodeStoreReplayWireRemote(remote, decodeStoreReplayBatch)
        }
        return activeRemote
    }

    function createAdaptiveLine(selectLine: () => ReplayRemote<[StorePatch[]]>['line']) {
        function subscribeAdaptiveLine(cb: (event: ReplayEvent<[StorePatch[]]>) => void) {
            if (!lifecycle) return selectLine().on(cb)
            const activeLifecycle = lifecycle

            let stopped = false
            let bindingGeneration = 0
            let handle: any = null
            let offConnect = function noAdaptiveConnectListener() {}
            let offDisconnect = function noAdaptiveDisconnectListener() {}
            let offClose = function noAdaptiveCloseListener() {}
            let resolveEnded = function resolveAdaptiveLineLater() {}
            let rejectEnded = function rejectAdaptiveLineLater(_error: unknown) {}
            const ended = new Promise<void>(function waitForAdaptiveLineEnd(resolve, reject) {
                resolveEnded = resolve
                rejectEnded = reject
            })

            function stopHandle() {
                const current = handle
                handle = null
                if (typeof current == 'function') current()
                else if (typeof current?.off == 'function') current.off()
                else if (typeof current?.unsubscribe == 'function') current.unsubscribe()
            }

            function stopListeners() {
                offConnect()
                offDisconnect()
                offClose()
            }

            function finish(failed: boolean, error?: unknown) {
                if (stopped) return
                stopped = true
                bindingGeneration++
                stopListeners()
                stopHandle()
                if (failed) rejectEnded(error)
                else resolveEnded()
            }

            function currentBinding(generation: number, binding: number) {
                return !stopped && activeLifecycle.connected()
                    && generation == activeLifecycle.generation() && binding == bindingGeneration
            }

            async function bindCurrentLine(generation: number) {
                const binding = ++bindingGeneration
                try {
                    await schemaReady?.()
                    if (!currentBinding(generation, binding)) return
                    const nextHandle = selectLine().on(cb)
                    if (!currentBinding(generation, binding)) {
                        if (typeof nextHandle == 'function') nextHandle()
                        else if (typeof nextHandle?.off == 'function') nextHandle.off()
                        else if (typeof nextHandle?.unsubscribe == 'function') nextHandle.unsubscribe()
                        return
                    }
                    handle = nextHandle
                    if (typeof nextHandle?.then == 'function') {
                        Promise.resolve(nextHandle).then(
                            function adaptivePhysicalLineEnded() {
                                if (currentBinding(generation, binding)) finish(false)
                            },
                            function adaptivePhysicalLineFailed(error) {
                                if (currentBinding(generation, binding)) finish(true, error)
                            },
                        )
                    }
                } catch (error) {
                    if (currentBinding(generation, binding)) finish(true, error)
                }
            }

            offDisconnect = activeLifecycle.onDisconnect(function detachAdaptiveLine() {
                bindingGeneration++
                stopHandle()
            })
            offConnect = activeLifecycle.onConnect(function rebindAdaptiveLine(generation) {
                void bindCurrentLine(generation)
            })
            offClose = activeLifecycle.onClose(function closeAdaptiveLine() {
                finish(false)
            })
            if (activeLifecycle.connected()) void bindCurrentLine(activeLifecycle.generation())

            return makeOff(ended, function closeAdaptiveLineSubscription() {
                if (stopped) return
                stopped = true
                bindingGeneration++
                stopListeners()
                stopHandle()
            })
        }
        return {on: subscribeAdaptiveLine}
    }

    const adaptiveLine = createAdaptiveLine(function selectLiveLine() {
        return selectedRemote().line
    })
    const adaptiveFrameLine = createAdaptiveLine(function selectLiveFrameLine() {
        const selected = selectedRemote()
        return selected.frameLine ?? selected.line
    })

    async function since(seq: number) {
        await schemaReady?.()
        return selectedRemote().since(seq)
    }

    async function keyframe() {
        await schemaReady?.()
        return selectedRemote().keyframe()
    }

    async function frame(seq: number, hint?: unknown) {
        await schemaReady?.()
        const selectedFrame = selectedRemote().frame
        return selectedFrame ? selectedFrame(seq, hint) : null
    }

    const decoded: ReplayRemote<[StorePatch[]]> = {
        line: adaptiveLine,
        since,
        keyframe,
    }
    Object.defineProperty(decoded, 'frame', {
        get() { return rpcMemberAvailable(selectedRemote(), 'frame') ? frame : undefined },
    })
    Object.defineProperty(decoded, 'frameLine', {
        get() { return rpcMemberAvailable(selectedRemote(), 'frameLine') ? adaptiveFrameLine : undefined },
    })
    Object.defineProperty(decoded, RPC_TRANSPORT_LIFECYCLE, {
        get: () => (remote as any)[RPC_TRANSPORT_LIFECYCLE],
    })
    Object.defineProperty(decoded, RPC_MEMBER_LOOKUP, {
        get() { return (selectedRemote() as any)[RPC_MEMBER_LOOKUP] },
    })
    Object.defineProperty(decoded, RPC_SCHEMA_READY, {get: () => (remote as any)[RPC_SCHEMA_READY]})
    return decoded
}

/**
 * Server side: exposeStore + numbered patch line.
 * Subscription to store is HOT — journal must see every change, even when
 * there are no subscribers, otherwise there are holes in the line. Cost: one listenPaths-listener + ring.
 */
export function exposeStoreReplay<T extends object>(store: Store<T>, opts: StoreReplayOpts = {}) {
    function currentPatch() {
        return [{path: [], exists: true, value: store.snapshot()}] as [StorePatch]
    }
    const [, lineApi] = replayListen<[StorePatch]>({
        current: currentPatch,
        // store-layer knows the semantics of its events → declares the frame compressor itself:
        // mini-frame (last patch per path) instead of full keyframe, zero configuration
        frame: condensePatchTail,
        history: opts.getSince ? undefined : (opts.history ?? 1024),
        getSince: opts.getSince,
        onJournal: opts.onJournal,
        onJournalBatch: opts.onJournalBatch,
        now: opts.now,
        firstSeq: opts.firstSeq,
    })
    // Store already knows how to build push-patches directly from raw state. Another pass through
    // store.node.at(path) would permanently leave in node-cache every temporary id of order/task.
    const batchOpts = opts.batch === true
        ? {now: opts.now}
        : opts.batch ? {...opts.batch, now: opts.batch.now ?? opts.now} : undefined
    const batchReplay = batchOpts ? createBatchReplay(store, batchOpts) : undefined
    const replayApi: ReplayExpose<[StorePatch]> & {batch?: ReturnType<typeof exposeStoreReplayBatch>} = exposeStoreReplayLine(lineApi)
    if (batchReplay) replayApi.batch = exposeStoreReplayBatch(batchReplay.replay, batchReplay.flush)

    const {patches: _patches, patchesBatch: _patchesBatch, changedData: _changedData, ...storeApi} = exposeStore(store, {push: true})
    const patchBatches = opts.patchSource ?? listenStorePatches(store)
    const pendingPatches: StorePatch[] = []
    let flushingPatches = false

    function flushPending(forceBatch = true) {
        if (flushingPatches) return
        if (pendingPatches.length == 0) {
            if (forceBatch) batchReplay?.flush()
            return
        }
        flushingPatches = true
        try {
            while (pendingPatches.length) {
                const count = pendingPatches.length
                const patches = pendingPatches.slice(0, count)
                const beforeHead = lineApi.head()
                try {
                    batchReplay?.validate(patches)
                    lineApi.emitBatch(patches.map(patch => [patch] as [StorePatch]))
                } catch (error) {
                    // A non-transactional onJournal adapter may have committed a
                    // safe prefix. Retain only the suffix so retry cannot duplicate it.
                    const committedCount = Math.min(count, Math.max(0, lineApi.head() - beforeHead))
                    if (committedCount) {
                        const committed = pendingPatches.splice(0, committedCount)
                        batchReplay?.push(committed)
                    }
                    throw error
                }
                pendingPatches.splice(0, count)
                batchReplay?.push(patches)
            }
            if (forceBatch) batchReplay?.flush()
        } finally {
            flushingPatches = false
        }
    }

    const offStore = patchBatches.on(function journalStoreChange(patches) {
        for (const patch of patches) pendingPatches.push(patch)
        flushPending(false)
    })
    function describe() {
        return cloneStoreValue(opts.describe!)
    }
    function retryPending() {
        flushPending(true)
    }
    function close() {
        offStore()
        batchReplay?.close()
        lineApi.close()
    }
    const replayFacade = opts.describe ? {...replayApi, describe} : replayApi
    return {
        /** Wire facade: pass to RPC server (object: api). Compatible with regular exposeStore. */
        api: {...storeApi, replay: replayFacade},
        /** Local replay-line — in-proc consumers, introspection (head/getSince). */
        replay: lineApi,
        /** Optional local logical batch line; application code still sees StorePatch objects. */
        replayBatch: batchReplay?.replay,
        batchStats: batchReplay?.stats,
        /** Retry patches retained after a journal precommit failure. */
        flushPending: retryPending,
        close,
    }
}

/**
 * Client side: mirror over line. keyframe/tail/live — by one mechanism
 * applyStorePatch. Reconnect: syncStoreReplay(store, remote, {since: prev.seq()}).
 */
export function syncStoreReplayBatch<T extends object>(
    store: Store<T>, remote: StoreReplayBatchRemote, opts: StoreReplaySyncOpts<T> = {},
) {
    const {batch: _batch, onBatch, validateBatch, ...wireOpts} = opts
    return replaySubscribe(decodeStoreReplayRemote(remote), function applyBatch(patches) {
        validateBatch?.(patches, store)
        applyStorePatches(store, patches)
        onBatch?.(patches, store)
    }, wireOpts)
}

function syncStoreReplayResolved<T extends object>(store: Store<T>, remote: StoreReplayRemote, opts: StoreReplaySyncOpts<T>) {
    const {batch, onBatch, validateBatch, ...wireOpts} = opts
    const mode = storeReplayMode(remote, batch)
    if (mode == 'batch') {
        const sub = syncStoreReplayBatch(store, remote.batch!, {...wireOpts, onBatch, validateBatch})
        return Object.assign(sub, {mode})
    }
    const sub = replaySubscribe<[StorePatch]>(remote, function applyLine(patch) {
        validateBatch?.([patch], store)
        applyStorePatch(store, patch)
        onBatch?.([patch], store)
    }, wireOpts)
    return Object.assign(sub, {mode})
}

function deferStoreReplaySync<T extends object>(
    store: Store<T>, remote: StoreReplayRemote, opts: StoreReplaySyncOpts<T>, schemaReady: () => Promise<void>,
) {
    let sub: (ReturnType<typeof replaySubscribe<any>> & {mode: tStoreReplayMode}) | undefined
    let closed = false
    let closeGate: () => void = function closeLater() {}
    let setMode = function setModeLater(_mode: tStoreReplayMode) {}
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
        setMode(sub.mode)
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
        mode: 'legacy' as tStoreReplayMode,
    })
    setMode = function updateDeferredMode(mode) { result.mode = mode }
    return result
}

export function syncStoreReplay<T extends object>(store: Store<T>, remote: StoreReplayRemote, opts: StoreReplaySyncOpts<T> = {}) {
    const schemaReady = opts.batch && getRpcMemberState(remote, 'batch') == undefined
        ? getRpcSchemaReady(remote)
        : undefined
    return schemaReady
        ? deferStoreReplaySync(store, remote, opts, schemaReady)
        : syncStoreReplayResolved(store, remote, opts)
}

function syncStoreReplayRouteResolved<T extends object>(
    store: Store<T>, remote: StoreReplayRemote, opts: StoreReplayRouteOpts<T>,
) {
    const {batch, onBatch, validateBatch, ...routeOpts} = opts
    const mode = storeReplayMode(remote, batch)
    if (mode == 'legacy') {
        const route = replayRouteSubscribe<[StorePatch]>(remote, function applyRoutePatch(patch) {
            validateBatch?.([patch], store)
            applyStorePatch(store, patch)
            onBatch?.([patch], store)
        }, routeOpts)
        return Object.assign(route, {mode})
    }

    const route = replayRouteSubscribe<[StorePatch[]]>(decodeStoreReplayRemote(remote.batch!), function applyRouteBatch(patches) {
        validateBatch?.(patches, store)
        applyStorePatches(store, patches)
        onBatch?.(patches, store)
    }, routeOpts)
    const switchBatchRoute = route.switch
    let closed = false
    let generation = 0
    const schemaWaitCancels = new Set<() => void>()

    async function waitForBatchSchema(nextRemote: StoreReplayRemote) {
        if (getRpcMemberState(nextRemote, 'batch') != undefined) return
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
        await waitForBatchSchema(nextRemote)
        if (closed) throw new Error('syncStoreReplayRoute: closed')
        if (storeReplayMode(nextRemote, true) != 'batch') {
            throw new Error('syncStoreReplayRoute: batch route cannot switch to legacy coordinates')
        }
        return switchBatchRoute(decodeStoreReplayRemote(nextRemote.batch!), nextOpts)
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
        mode,
    })
}

function deferStoreReplayRoute<T extends object>(
    store: Store<T>, remote: StoreReplayRemote, opts: StoreReplayRouteOpts<T>, schemaReady: () => Promise<void>,
) {
    let route: ReturnType<typeof syncStoreReplayRouteResolved<T>> | undefined
    let closed = false
    let schemaFailed = false
    let closeGate: () => void = function closeLater() {}
    let setMode = function setModeLater(_mode: tStoreReplayMode) {}
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
        setMode(route.mode)
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
        mode: 'legacy' as tStoreReplayMode,
    })
    setMode = function updateDeferredRouteMode(mode) { result.mode = mode }
    return result
}

/**
 * Route-switching store mirror: keep the old route alive, catch up the replacement
 * route from the last delivered seq, then close the old one. Use for relay <-> direct
 * promotion/re-interposition when the authority/replay line stays semantically the same.
 */
export function syncStoreReplayRoute<T extends object>(store: Store<T>, remote: StoreReplayRemote, opts: StoreReplayRouteOpts<T> = {}) {
    const schemaReady = opts.batch && getRpcMemberState(remote, 'batch') == undefined
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
 * and deltas are applied by ONE mechanism applyStorePatch. undefined = archive is empty.
 */
export function storeReplayAt<T extends object>(storage: ReplayStorage<[StorePatch]>, at: {seq?: number, ts?: number} = {}) {
    const envelopes = openHistory(storage).at(at)
    if (!envelopes) return undefined
    const scratch = createStore<any>({})
    for (const ev of envelopes) applyStorePatch(scratch, ev.event[0])
    return scratch.snapshot() as T
}
