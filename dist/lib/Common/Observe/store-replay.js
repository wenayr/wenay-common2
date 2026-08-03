"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storeReplayMode = storeReplayMode;
exports.exposeStoreReplay = exposeStoreReplay;
exports.syncStoreReplayBatch = syncStoreReplayBatch;
exports.syncStoreReplay = syncStoreReplay;
exports.createStoreReplayView = createStoreReplayView;
exports.syncStoreReplayView = syncStoreReplayView;
exports.syncStoreReplayRoute = syncStoreReplayRoute;
exports.syncStoreReplayEach = syncStoreReplayEach;
exports.storeReplayAt = storeReplayAt;
const store_1 = require("./store");
const replay_listen_1 = require("../events/replay-listen");
const replay_wire_1 = require("../events/replay-wire");
const replay_route_1 = require("../events/replay-route");
const replay_history_1 = require("../events/replay-history");
const mapListen_1 = require("../events/mapListen");
const replay_rpc_wire_1 = require("../events/replay-rpc-wire");
const rpc_off_1 = require("../rcp/rpc-off");
const positive_integer_option_1 = require("../positive-integer-option");
const transport_lifecycle_1 = require("../events/transport-lifecycle");
const observe_private_1 = require("./observe-private");
const store_replay_codec_1 = require("./store-replay-codec");
const store_replay_view_1 = require("./store-replay-view");
function storeReplayMode() { return 'v2'; }
function cloneStoreReplayPatch(patch) {
    return {
        path: [...patch.path],
        exists: patch.exists,
        value: patch.exists ? (0, store_1.cloneStoreValue)(patch.value) : undefined,
    };
}
function cloneStoreReplayBatchEvent(event) {
    return { seq: event.seq, ts: event.ts, event: [event.event[0].map(cloneStoreReplayPatch)] };
}
function condenseBatchPatchTail(tail) {
    const root = { children: new Map() };
    let order = 0;
    for (const ev of tail)
        for (const patch of ev.event[0]) {
            if (patch.path.some(key => typeof key == 'symbol'))
                return tail;
            let node = root;
            for (const key of patch.path) {
                let child = node.children.get(key);
                if (!child) {
                    child = { children: new Map() };
                    node.children.set(key, child);
                }
                node = child;
            }
            node.patch = patch;
            node.order = order++;
            node.children.clear();
        }
    const ordered = [];
    function collect(node) {
        if (node.patch)
            ordered.push({ patch: node.patch, order: node.order });
        for (const child of node.children.values())
            collect(child);
    }
    collect(root);
    ordered.sort((a, b) => a.order - b.order);
    const held = ordered.map(entry => entry.patch);
    if (held.length == 0)
        return [];
    const last = tail[tail.length - 1];
    return [{ seq: last.seq, ts: last.ts, event: [held] }];
}
function createBatchReplay(currentBatch, opts, label = 'exposeStoreReplay') {
    const maxItems = (0, positive_integer_option_1.positiveIntegerOption)(opts.maxItems, 256, label + ': batch.maxItems');
    const maxBytes = (0, positive_integer_option_1.positiveIntegerOption)(opts.maxBytes, 64 * 1024, label + ': batch.maxBytes');
    const maxDelayMs = opts.maxDelayMs ?? 0;
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
        throw new RangeError(label + ': batch.maxDelayMs must be >= 0');
    }
    const [emitBatch, replay] = (0, replay_listen_1.replayListen)({
        current: currentBatch,
        frame: condenseBatchPatchTail,
        history: opts.getSince ? undefined : (opts.history ?? 1024),
        keepMs: opts.getSince ? undefined : opts.keepMs,
        getSince: opts.getSince,
        onJournal: opts.onJournal,
        onJournalBatch: opts.onJournalBatch,
        now: opts.now,
        firstSeq: opts.firstSeq,
    });
    const envelopeBytes = 48;
    const exactEmptyEnvelopeBytes = (0, store_replay_codec_1.storeReplayBatchV2WireMetrics)([]).byteLength;
    let pending = [];
    const ready = [];
    let pendingBytes = envelopeBytes;
    let pendingBinaryCount = 0;
    let pendingMetricsExact = true;
    let timer = null;
    let closed = false;
    let flushing = false;
    let sourceBatches = 0;
    let sourcePatches = 0;
    let emittedBatches = 0;
    let emittedPatches = 0;
    let estimatedBytes = 0;
    function stopTimer() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }
    function sealPending(target = ready) {
        if (pending.length == 0)
            return;
        const sealed = pending;
        const estimated = pendingBytes;
        const exactPatchMetrics = pendingMetricsExact;
        pending = [];
        pendingBytes = envelopeBytes;
        pendingBinaryCount = 0;
        pendingMetricsExact = true;
        const planned = [];
        splitToWireLimit(sealed, estimated, planned, exactPatchMetrics);
        target.push(...planned);
    }
    function splitToWireLimit(patches, estimated, planned, exactPatchMetrics = false) {
        if (estimated <= maxBytes) {
            planned.push({ patches, bytes: estimated });
            return;
        }
        if (patches.length == 1 && exactPatchMetrics) {
            const patchBytes = estimated - envelopeBytes - 1;
            planned.push({ patches, bytes: exactEmptyEnvelopeBytes + patchBytes });
            return;
        }
        let bytes;
        try {
            bytes = (0, store_replay_codec_1.storeReplayBatchV2WireMetrics)(patches).byteLength;
        }
        catch {
            planned.push({ patches, bytes: estimated });
            return;
        }
        if (bytes <= maxBytes || patches.length == 1) {
            planned.push({ patches, bytes });
            return;
        }
        const middle = Math.ceil(patches.length / 2);
        splitToWireLimit(patches.slice(0, middle), bytes, planned);
        splitToWireLimit(patches.slice(middle), bytes, planned);
    }
    function drainReady() {
        if (flushing)
            return;
        flushing = true;
        let delivered = 0;
        try {
            while (delivered < ready.length) {
                const batch = ready[delivered];
                emitBatch(batch.patches);
                delivered++;
                emittedBatches++;
                emittedPatches += batch.patches.length;
                estimatedBytes += batch.bytes;
            }
        }
        finally {
            if (delivered)
                ready.splice(0, delivered);
            flushing = false;
        }
    }
    function flush() {
        stopTimer();
        sealPending();
        drainReady();
    }
    function armTimer() {
        if (timer || maxDelayMs == 0)
            return;
        timer = setTimeout(flush, maxDelayMs);
        timer.unref?.();
    }
    function push(patches) {
        if (closed || patches.length == 0)
            return;
        sourceBatches++;
        sourcePatches += patches.length;
        const staged = [];
        function measurePatch(patch, firstBinaryIndex = 0) {
            try {
                return { ...(0, store_replay_codec_1.storeReplayPatchV2WireMetrics)(patch, firstBinaryIndex), exact: true };
            }
            catch {
                return { byteLength: maxBytes, binaryCount: 0, exact: false };
            }
        }
        for (const patch of patches) {
            let metrics = measurePatch(patch, pendingBinaryCount);
            let bytes = metrics.byteLength + 1;
            if (pending.length && (pending.length >= maxItems || pendingBytes + bytes > maxBytes)) {
                sealPending(staged);
                if (metrics.binaryCount > 0 || !metrics.exact)
                    metrics = measurePatch(patch);
                bytes = metrics.byteLength + 1;
            }
            pending.push(patch);
            pendingBytes += bytes;
            pendingBinaryCount += metrics.binaryCount;
            pendingMetricsExact = pendingMetricsExact && metrics.exact;
            if (pending.length >= maxItems)
                sealPending(staged);
        }
        if (maxDelayMs == 0)
            sealPending(staged);
        else
            armTimer();
        ready.push(...staged);
        drainReady();
    }
    function close() {
        if (closed)
            return;
        flush();
        closed = true;
        replay.close();
    }
    function stats() {
        return { sourceBatches, sourcePatches, emittedBatches, emittedPatches, estimatedBytes };
    }
    const readSafeReplay = {
        ...replay,
        getSince(seq) {
            flush();
            return replay.getSince(seq);
        },
        keyframe() {
            flush();
            return replay.keyframe();
        },
        frame(seq, hint) {
            flush();
            return replay.frame(seq, hint);
        },
    };
    return {
        replay: readSafeReplay,
        push,
        flush,
        close,
        stats,
        limits: { maxItems, maxBytes },
    };
}
function exposeStoreReplayWire(replay, encode, prepareRead) {
    const [, line] = (0, mapListen_1.mapListen)(replay.line, function encodeStoreReplayLive(event) {
        return [encode(cloneStoreReplayBatchEvent(event))];
    });
    replay.line.onClose(function closeEncodedStoreReplayLine() { line.close(); });
    function since(seq) {
        prepareRead();
        return replay.getSince(seq)?.map(function encodeStoreReplayTail(event) {
            return encode(cloneStoreReplayBatchEvent(event));
        }) ?? null;
    }
    function keyframe() {
        prepareRead();
        const event = replay.keyframe();
        return event ? encode(event) : null;
    }
    function frame(seq, hint) {
        prepareRead();
        return replay.frame(seq, hint).map(function encodeStoreReplayFrame(event) {
            return encode(cloneStoreReplayBatchEvent(event));
        });
    }
    const facade = {
        line,
        since,
        keyframe,
        frame,
    };
    return (0, replay_rpc_wire_1.brandRpcReplayWire)(facade, {
        head: replay.head,
        sequenceOf(value) {
            return Array.isArray(value) && typeof value[1] == 'number' ? value[1] : undefined;
        },
    });
}
function exposeStoreReplayBatch(replay, prepareRead) {
    return exposeStoreReplayWire(replay, store_replay_codec_1.encodeStoreReplayBatchV2, prepareRead);
}
function subscribeDecodedReplayLine(line, decode, cb, opts) {
    let upstream;
    let upstreamStopped = false;
    let stopped = false;
    let failed = false;
    let rejectDecode = function rejectDecodeLater(_error) { };
    const decodeFailure = new Promise(function captureDecodeFailure(_resolve, reject) {
        rejectDecode = reject;
    });
    let resolveLocalClose = function resolveLocalCloseLater() { };
    const localClose = new Promise(function captureLocalClose(resolve) {
        resolveLocalClose = resolve;
    });
    const offLocalClose = Object.prototype.hasOwnProperty.call(line, 'onClose')
        && typeof line.onClose == 'function'
        ? line.onClose(function decodedReplaySourceClosed() { resolveLocalClose(); })
        : function noDecodedReplayCloseListener() { };
    function stopUpstream() {
        if (upstreamStopped)
            return;
        upstreamStopped = true;
        if (typeof upstream == 'function')
            upstream();
        else if (typeof upstream?.off == 'function')
            upstream.off();
        else if (typeof upstream?.unsubscribe == 'function')
            upstream.unsubscribe();
    }
    function failDecode(error) {
        if (failed || stopped)
            return;
        failed = true;
        rejectDecode(error);
        if (upstream != null)
            stopUpstream();
    }
    function decodeLiveStoreReplay(wire) {
        if (failed || stopped)
            return;
        try {
            cb(decode(wire));
        }
        catch (error) {
            failDecode(error);
        }
    }
    try {
        upstream = line.on(decodeLiveStoreReplay, opts);
    }
    catch (error) {
        failDecode(error);
    }
    if (failed)
        stopUpstream();
    const upstreamEnd = typeof upstream?.then == 'function'
        ? Promise.resolve(upstream)
        : new Promise(function waitForRemoteReplayEnd() { });
    const ended = Promise.race([decodeFailure, localClose, upstreamEnd]);
    return (0, rpc_off_1.makeOff)(ended, function closeDecodedReplayLine() {
        stopped = true;
        offLocalClose();
        stopUpstream();
    });
}
function decodeStoreReplayWireRemote(remote, decode, lifecycleSource = remote, knowledge) {
    function decodeEvents(events) {
        if (events == null)
            return events;
        return events.map(decode);
    }
    function decodeEvent(event) {
        if (event == null)
            return event;
        return decode(event);
    }
    function subscribeLine(cb) {
        return subscribeDecodedReplayLine(remote.line, decode, cb, knowledge ? { knowledge: knowledge() } : undefined);
    }
    async function since(seq) {
        return decodeEvents(await remote.since(seq, knowledge?.()));
    }
    async function keyframe() {
        return decodeEvent(await remote.keyframe(knowledge?.()));
    }
    const decoded = {
        line: { on: subscribeLine },
        since,
        keyframe,
    };
    if ((0, transport_lifecycle_1.rpcMemberAvailable)(remote, 'frame')) {
        decoded.frame = async function decodeFrame(seq, hint) {
            return decodeEvents(await remote.frame(seq, hint, knowledge?.()));
        };
    }
    if ((0, transport_lifecycle_1.rpcMemberAvailable)(remote, 'frameLine')) {
        function subscribeFrameLine(cb) {
            return subscribeDecodedReplayLine(remote.frameLine, decode, cb, knowledge ? { knowledge: knowledge() } : undefined);
        }
        decoded.frameLine = {
            on: subscribeFrameLine,
        };
    }
    Object.defineProperty(decoded, transport_lifecycle_1.RPC_TRANSPORT_LIFECYCLE, { get: () => lifecycleSource[transport_lifecycle_1.RPC_TRANSPORT_LIFECYCLE] });
    Object.defineProperty(decoded, transport_lifecycle_1.RPC_MEMBER_LOOKUP, { get: () => remote[transport_lifecycle_1.RPC_MEMBER_LOOKUP] });
    Object.defineProperty(decoded, transport_lifecycle_1.RPC_SCHEMA_READY, { get: () => lifecycleSource[transport_lifecycle_1.RPC_SCHEMA_READY] });
    return decoded;
}
function decodeStoreReplayRemote(remote) {
    function decodeStoreReplayV2(value) {
        const local = value;
        if (local && typeof local == 'object' && typeof local.seq == 'number' && typeof local.ts == 'number'
            && Array.isArray(local.event) && Array.isArray(local.event[0])) {
            return cloneStoreReplayBatchEvent(local);
        }
        return (0, store_replay_codec_1.decodeStoreReplayBatchV2)(value);
    }
    return decodeStoreReplayWireRemote(remote, decodeStoreReplayV2);
}
function exposeStoreReplay(store, opts = {}) {
    function currentStoreReplayBatch() {
        return [[{ path: [], exists: true, value: store.snapshot() }]];
    }
    const batchReplay = createBatchReplay(currentStoreReplayBatch, opts);
    const replayApi = exposeStoreReplayBatch(batchReplay.replay, batchReplay.flush);
    const { patches: _patches, patchesBatch: _patchesBatch, changedData: _changedData, ...storeApi } = (0, store_1.exposeStore)(store, { push: true });
    const getExactPatches = store[observe_private_1.STORE_REPLAY_PATCH_SOURCE];
    const patchBatches = opts.patchSource ?? getExactPatches?.() ?? (0, store_1.listenStorePatches)(store);
    const offStore = patchBatches.on(function journalStoreChange(patches) {
        batchReplay.push(patches);
    });
    function describe() {
        return (0, store_1.cloneStoreValue)(opts.describe);
    }
    function retryPending() {
        batchReplay.flush();
    }
    function close() {
        offStore();
        batchReplay.close();
    }
    const replayFacade = opts.describe ? { ...replayApi, describe } : replayApi;
    (0, replay_rpc_wire_1.retransmitRpcReplayWire)(replayApi, replayFacade);
    return {
        api: { ...storeApi, replay: replayFacade },
        replay: batchReplay.replay,
        batchStats: batchReplay.stats,
        flushPending: retryPending,
        close,
    };
}
function syncStoreReplayBatch(store, remote, opts = {}) {
    const { onBatch, validateBatch, ...wireOpts } = opts;
    return (0, replay_wire_1.replaySubscribe)(decodeStoreReplayRemote(remote), function applyBatch(patches) {
        validateBatch?.(patches, store);
        (0, store_1.applyStorePatches)(store, patches);
        onBatch?.(patches, store);
    }, wireOpts);
}
function syncStoreReplayResolved(store, remote, opts) {
    return Object.assign(syncStoreReplayBatch(store, remote, opts), { mode: 'v2' });
}
function deferStoreReplaySync(store, remote, opts, schemaReady) {
    let sub;
    let closed = false;
    let closeGate = function closeLater() { };
    const closedFirst = new Promise(function waitForClose(resolve) {
        closeGate = function resolveClosed() { resolve('closed'); };
    });
    const schemaFirst = Promise.resolve().then(schemaReady).then(function schemaResolved() { return 'schema'; }, function schemaFailed(error) {
        if (closed)
            return 'closed';
        if (opts.onError) {
            try {
                opts.onError(error);
            }
            catch (caught) {
                setTimeout(function rethrowSchemaError() { throw caught; }, 0);
            }
        }
        else
            setTimeout(function rethrowSchemaFailure() { throw error; }, 0);
        return 'closed';
    });
    const ready = Promise.race([schemaFirst, closedFirst]).then(async function startAfterSchema(state) {
        if (state == 'closed' || closed)
            return;
        sub = syncStoreReplayResolved(store, remote, opts);
        await sub.ready;
    });
    function off() {
        if (closed)
            return;
        closed = true;
        closeGate();
        sub?.();
    }
    const result = Object.assign(off, {
        ready,
        seq: () => sub?.seq() ?? opts.since ?? -1,
        isStale: () => sub?.isStale() ?? false,
        lastTs: () => sub?.lastTs() ?? 0,
        mode: 'v2',
    });
    return result;
}
function syncStoreReplay(store, remote, opts = {}) {
    const schemaReady = (0, transport_lifecycle_1.getRpcMemberState)(remote, 'line') == undefined
        ? (0, transport_lifecycle_1.getRpcSchemaReady)(remote)
        : undefined;
    return schemaReady
        ? deferStoreReplaySync(store, remote, opts, schemaReady)
        : syncStoreReplayResolved(store, remote, opts);
}
const storeReplayViewLayer = (0, store_replay_view_1.createStoreReplayViewLayer)({
    createBatchReplay,
    exposeStoreReplayBatch,
    syncStoreReplay,
});
function createStoreReplayView(store, opts) {
    return storeReplayViewLayer.createStoreReplayView(store, opts);
}
function syncStoreReplayView(store, remote, opts = {}) {
    return storeReplayViewLayer.syncStoreReplayView(store, remote, opts);
}
function syncStoreReplayRouteResolved(store, remote, opts) {
    const { onBatch, validateBatch, ...routeOpts } = opts;
    const route = (0, replay_route_1.replayRouteSubscribe)(decodeStoreReplayRemote(remote), function applyRouteBatch(patches) {
        validateBatch?.(patches, store);
        (0, store_1.applyStorePatches)(store, patches);
        onBatch?.(patches, store);
    }, routeOpts);
    const switchBatchRoute = route.switch;
    let closed = false;
    let generation = 0;
    const schemaWaitCancels = new Set();
    async function waitForV2Schema(nextRemote) {
        if ((0, transport_lifecycle_1.getRpcMemberState)(nextRemote, 'line') != undefined)
            return;
        const schemaReady = (0, transport_lifecycle_1.getRpcSchemaReady)(nextRemote);
        if (!schemaReady)
            return;
        const waitGeneration = generation;
        let cancel = function cancelLater() { };
        const closedFirst = new Promise(function waitForRouteClose(resolve) {
            cancel = function resolveRouteClosed() { resolve('closed'); };
        });
        schemaWaitCancels.add(cancel);
        try {
            const state = await Promise.race([
                Promise.resolve().then(schemaReady).then(function batchSchemaResolved() { return 'schema'; }),
                closedFirst,
            ]);
            if (state == 'closed' || closed || generation != waitGeneration) {
                throw new Error('syncStoreReplayRoute: closed');
            }
        }
        finally {
            schemaWaitCancels.delete(cancel);
        }
    }
    async function switchRoute(nextRemote, nextOpts = {}) {
        if (closed)
            throw new Error('syncStoreReplayRoute: closed');
        await waitForV2Schema(nextRemote);
        if (closed)
            throw new Error('syncStoreReplayRoute: closed');
        return switchBatchRoute(decodeStoreReplayRemote(nextRemote), nextOpts);
    }
    function off() {
        if (closed)
            return;
        closed = true;
        generation++;
        for (const cancel of [...schemaWaitCancels])
            cancel();
        schemaWaitCancels.clear();
        route();
    }
    return Object.assign(off, {
        ready: route.ready,
        switch: switchRoute,
        seq: route.seq,
        label: route.label,
        active: route.active,
        mode: 'v2',
    });
}
function deferStoreReplayRoute(store, remote, opts, schemaReady) {
    let route;
    let closed = false;
    let schemaFailed = false;
    let closeGate = function closeLater() { };
    const closedFirst = new Promise(function waitForClose(resolve) {
        closeGate = function resolveClosed() { resolve('closed'); };
    });
    const schemaFirst = Promise.resolve().then(schemaReady).then(function schemaResolved() { return 'schema'; }, function schemaRejected(error) {
        if (closed)
            return 'closed';
        schemaFailed = true;
        if (opts.onError) {
            try {
                opts.onError(error);
            }
            catch (caught) {
                setTimeout(function rethrowRouteSchemaError() { throw caught; }, 0);
            }
        }
        else
            setTimeout(function rethrowRouteSchemaFailure() { throw error; }, 0);
        return 'closed';
    });
    const ready = Promise.race([schemaFirst, closedFirst]).then(async function startRouteAfterSchema(state) {
        if (state == 'closed' || closed)
            return;
        route = syncStoreReplayRouteResolved(store, remote, opts);
        await route.ready;
    });
    let switchChain = ready.catch(function initialRouteFailed() { });
    function switchRoute(nextRemote, nextOpts = {}) {
        async function runSwitch() {
            await ready;
            if (closed || schemaFailed || !route)
                throw new Error('syncStoreReplayRoute: closed');
            return route.switch(nextRemote, nextOpts);
        }
        const pending = switchChain.then(runSwitch, runSwitch);
        switchChain = pending.catch(function routeSwitchFailed() { });
        return pending;
    }
    function off() {
        if (closed)
            return;
        closed = true;
        closeGate();
        route?.();
    }
    const result = Object.assign(off, {
        ready,
        switch: switchRoute,
        seq: () => route?.seq() ?? opts.since ?? -1,
        label: () => route?.label() ?? opts.label,
        active: () => route?.active() ?? false,
        mode: 'v2',
    });
    return result;
}
function syncStoreReplayRoute(store, remote, opts = {}) {
    const schemaReady = (0, transport_lifecycle_1.getRpcMemberState)(remote, 'line') == undefined
        ? (0, transport_lifecycle_1.getRpcSchemaReady)(remote)
        : undefined;
    return schemaReady
        ? deferStoreReplayRoute(store, remote, opts, schemaReady)
        : syncStoreReplayRouteResolved(store, remote, opts);
}
function syncStoreReplayEach(remote, cb, opts = {}) {
    const { drain, initial, ...wireOpts } = opts;
    const store = (0, store_1.createStore)((initial ?? {}), drain !== undefined ? { drain } : {});
    const offEach = store.each().on(cb);
    const sub = syncStoreReplay(store, remote, wireOpts);
    function off() { offEach(); sub(); }
    const result = Object.assign(off, {
        store,
        ready: sub.ready,
        seq: sub.seq,
        isStale: sub.isStale,
        lastTs: sub.lastTs,
    });
    Object.defineProperty(result, 'mode', { enumerable: true, get: () => sub.mode });
    return result;
}
function storeReplayAt(storage, at = {}) {
    const envelopes = (0, replay_history_1.openHistory)(storage).at(at);
    if (!envelopes)
        return undefined;
    const scratch = (0, store_1.createStore)({});
    for (const ev of envelopes)
        (0, store_1.applyStorePatches)(scratch, ev.event[0]);
    return scratch.snapshot();
}
