"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storeReplayMode = storeReplayMode;
exports.storePatchKey = storePatchKey;
exports.exposeStoreReplay = exposeStoreReplay;
exports.syncStoreReplayBatch = syncStoreReplayBatch;
exports.syncStoreReplay = syncStoreReplay;
exports.syncStoreReplayRoute = syncStoreReplayRoute;
exports.syncStoreReplayEach = syncStoreReplayEach;
exports.storeReplayAt = storeReplayAt;
const store_1 = require("./store");
const replay_listen_1 = require("../events/replay-listen");
const replay_wire_1 = require("../events/replay-wire");
const replay_route_1 = require("../events/replay-route");
const replay_history_1 = require("../events/replay-history");
const mapListen_1 = require("../events/mapListen");
const rpc_off_1 = require("../rcp/rpc-off");
const rpc_result_limits_1 = require("../rcp/rpc-result-limits");
const positive_integer_option_1 = require("../positive-integer-option");
const transport_lifecycle_1 = require("../events/transport-lifecycle");
const store_replay_codec_1 = require("./store-replay-codec");
const store_replay_binary_1 = require("./store-replay-binary");
const store_replay_msgpack_1 = require("./store-replay-msgpack");
function storeReplayMode(remote, preferBatch = false) {
    return preferBatch && (0, transport_lifecycle_1.rpcMemberAvailable)(remote, 'batch') ? 'batch' : 'legacy';
}
function storePatchKey(patch) {
    for (const k of patch.path)
        if (typeof k == 'symbol')
            return null;
    return JSON.stringify(patch.path);
}
function condensePatchTail(tail) {
    const held = new Map();
    for (const ev of tail) {
        const k = storePatchKey(ev.event[0]);
        if (k == null)
            return tail;
        held.delete(k);
        held.set(k, ev);
    }
    return [...held.values()];
}
function cloneStoreReplayPatch(patch) {
    return {
        path: [...patch.path],
        exists: patch.exists,
        value: patch.exists ? (0, store_1.cloneStoreValue)(patch.value) : undefined,
    };
}
function cloneStoreReplayEvent(event) {
    return { seq: event.seq, ts: event.ts, event: [cloneStoreReplayPatch(event.event[0])] };
}
function cloneStoreReplayBatchEvent(event) {
    return { seq: event.seq, ts: event.ts, event: [event.event[0].map(cloneStoreReplayPatch)] };
}
function exposeStoreReplayLine(replay) {
    const [, line] = (0, mapListen_1.mapListen)(replay.line, function cloneStoreReplayLive(event) {
        return [cloneStoreReplayEvent(event)];
    });
    replay.line.onClose(function closeClonedStoreReplayLine() { line.close(); });
    function since(seq) {
        return replay.getSince(seq)?.map(cloneStoreReplayEvent) ?? null;
    }
    function keyframe() {
        const event = replay.keyframe();
        return event ? cloneStoreReplayEvent(event) : null;
    }
    function frame(seq, hint) {
        return replay.frame(seq, hint).map(cloneStoreReplayEvent);
    }
    return { line, since, keyframe, frame };
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
function createBatchReplay(store, opts) {
    const maxItems = (0, positive_integer_option_1.positiveIntegerOption)(opts.maxItems, 256, 'exposeStoreReplay: batch.maxItems');
    const maxBytes = (0, positive_integer_option_1.positiveIntegerOption)(opts.maxBytes, 64 * 1024, 'exposeStoreReplay: batch.maxBytes');
    const maxDelayMs = opts.maxDelayMs ?? 0;
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0)
        throw new RangeError('exposeStoreReplay: batch.maxDelayMs must be >= 0');
    function currentBatch() {
        return [[{ path: [], exists: true, value: store.snapshot() }]];
    }
    const [emitBatch, replay] = (0, replay_listen_1.replayListen)({
        current: currentBatch,
        frame: condenseBatchPatchTail,
        history: opts.getSince ? undefined : (opts.history ?? 1024),
        getSince: opts.getSince,
        onJournal: opts.onJournal,
        onJournalBatch: opts.onJournalBatch,
        now: opts.now,
        firstSeq: opts.firstSeq,
    });
    const envelopeBytes = 48;
    let pending = [];
    const ready = [];
    let pendingBytes = envelopeBytes;
    let pendingBinaryCount = 0;
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
        pending = [];
        pendingBytes = envelopeBytes;
        pendingBinaryCount = 0;
        const planned = [];
        splitToWireLimit(sealed, estimated, planned);
        target.push(...planned);
    }
    function splitToWireLimit(patches, estimated, planned) {
        const wireTarget = Math.min(maxBytes, store_replay_binary_1.STORE_REPLAY_BINARY_MAX_WIRE_BYTES);
        if (estimated * 8 <= wireTarget) {
            planned.push({ patches, bytes: estimated });
            return;
        }
        let bytes;
        try {
            bytes = (0, store_replay_codec_1.storeReplayBatchMaxWireMetrics)(patches).byteLength;
        }
        catch (error) {
            if (patches.length == 1)
                throw error;
            const middle = Math.ceil(patches.length / 2);
            splitToWireLimit(patches.slice(0, middle), maxBytes, planned);
            splitToWireLimit(patches.slice(middle), maxBytes, planned);
            return;
        }
        if (bytes <= wireTarget || patches.length == 1) {
            planned.push({ patches, bytes });
            return;
        }
        const middle = Math.ceil(patches.length / 2);
        splitToWireLimit(patches.slice(0, middle), bytes, planned);
        splitToWireLimit(patches.slice(middle), bytes, planned);
    }
    function validate(patches) {
        try {
            (0, store_replay_codec_1.encodeStoreReplayBatchV5)({
                seq: Number.MAX_SAFE_INTEGER,
                ts: Number.MAX_SAFE_INTEGER,
                event: [patches],
            });
        }
        catch (error) {
            if (patches.length == 1)
                throw error;
            const middle = Math.ceil(patches.length / 2);
            validate(patches.slice(0, middle));
            validate(patches.slice(middle));
        }
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
        for (const patch of patches) {
            let metrics;
            try {
                metrics = (0, store_replay_codec_1.storeReplayPatchMaxWireMetrics)(patch, pendingBinaryCount);
            }
            catch {
                metrics = { byteLength: maxBytes, binaryCount: 0 };
            }
            let bytes = metrics.byteLength + 1;
            if (pending.length && (pending.length >= maxItems || pendingBytes + bytes > maxBytes)) {
                sealPending(staged);
                try {
                    metrics = (0, store_replay_codec_1.storeReplayPatchMaxWireMetrics)(patch);
                }
                catch {
                    metrics = { byteLength: maxBytes, binaryCount: 0 };
                }
                bytes = metrics.byteLength + 1;
            }
            pending.push(patch);
            pendingBytes += bytes;
            pendingBinaryCount += metrics.binaryCount;
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
        validate,
        push,
        flush,
        close,
        stats,
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
    return {
        line,
        since,
        keyframe,
        frame,
    };
}
function exposeStoreReplayBatchV2(replay, prepareRead) {
    return exposeStoreReplayWire(replay, store_replay_codec_1.encodeStoreReplayBatchV2, prepareRead);
}
function exposeStoreReplayBatchV3(replay, prepareRead) {
    return exposeStoreReplayWire(replay, store_replay_codec_1.encodeStoreReplayBatchV3, prepareRead);
}
function exposeStoreReplayBatchV4(replay, prepareRead) {
    return exposeStoreReplayWire(replay, store_replay_codec_1.encodeStoreReplayBatchV4, prepareRead);
}
function exposeStoreReplayBatchV5(replay, prepareRead) {
    return exposeStoreReplayWire(replay, store_replay_codec_1.encodeStoreReplayBatchV5, prepareRead);
}
function exposeStoreReplayBatchV6(replay, prepareRead) {
    return exposeStoreReplayWire(replay, event => event, prepareRead);
}
function exposeStoreReplayBatchV7(replay, prepareRead) {
    const codec = (0, store_replay_msgpack_1.createStoreReplayMsgpackCodec)();
    const [, preparedLine] = (0, mapListen_1.mapListen)(replay.line, function prepareStoreReplayV7Live(event) {
        return [codec.prepare(cloneStoreReplayBatchEvent(event))];
    });
    replay.line.onClose(function closePreparedStoreReplayV7Line() { preparedLine.close(); });
    function since(seq, _snapshot) {
        prepareRead();
        return replay.getSince(seq)?.map(function encodeStoreReplayV7Tail(event) {
            return codec.encode(cloneStoreReplayBatchEvent(event));
        }) ?? null;
    }
    function keyframe(_snapshot) {
        prepareRead();
        const event = replay.keyframe();
        if (!event)
            return null;
        return codec.encode(event);
    }
    function frame(seq, hint, _snapshot) {
        prepareRead();
        return replay.frame(seq, hint).map(function encodeStoreReplayV7Frame(event) {
            return codec.encode(cloneStoreReplayBatchEvent(event));
        });
    }
    return {
        line: preparedLine,
        since,
        keyframe,
        frame,
    };
}
function exposeStoreReplayBatch(replay, prepareRead) {
    return {
        ...exposeStoreReplayWire(replay, store_replay_codec_1.encodeStoreReplayBatch, prepareRead),
        v2: exposeStoreReplayBatchV2(replay, prepareRead),
        v3: exposeStoreReplayBatchV3(replay, prepareRead),
        v4: exposeStoreReplayBatchV4(replay, prepareRead),
        v5: exposeStoreReplayBatchV5(replay, prepareRead),
        v6: exposeStoreReplayBatchV6(replay, prepareRead),
        v7: exposeStoreReplayBatchV7(replay, prepareRead),
    };
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
    const lifecycle = (0, transport_lifecycle_1.getRpcTransportLifecycle)(remote);
    const schemaReady = (0, transport_lifecycle_1.getRpcSchemaReady)(remote);
    const resultLimits = (0, rpc_result_limits_1.getRpcResultLimits)(remote);
    let activeCodec = null;
    let activeRemote = null;
    function selectedCodec() {
        if ((0, transport_lifecycle_1.rpcMemberAvailable)(remote, 'v2'))
            return 'v2';
        if ((0, transport_lifecycle_1.rpcMemberAvailable)(remote, 'v7'))
            return 'v7';
        if ((0, transport_lifecycle_1.rpcMemberAvailable)(remote, 'v6'))
            return 'v6';
        if ((0, transport_lifecycle_1.rpcMemberAvailable)(remote, 'v5'))
            return 'v5';
        if ((0, transport_lifecycle_1.rpcMemberAvailable)(remote, 'v4'))
            return 'v4';
        if ((0, transport_lifecycle_1.rpcMemberAvailable)(remote, 'v3'))
            return 'v3';
        return 'v1';
    }
    function selectedRemote() {
        const codec = selectedCodec();
        if (activeRemote && activeCodec == codec)
            return activeRemote;
        activeCodec = codec;
        if (codec == 'v7') {
            const msgpack = (0, store_replay_msgpack_1.createStoreReplayMsgpackCodec)();
            activeRemote = decodeStoreReplayWireRemote(remote.v7, wire => msgpack.decode(wire), remote);
        }
        else if (codec == 'v6') {
            activeRemote = decodeStoreReplayWireRemote(remote.v6, event => event, remote);
        }
        else if (codec == 'v5') {
            activeRemote = decodeStoreReplayWireRemote(remote.v5, function decodeLimitedStoreReplayBatchV5(wire) {
                return (0, store_replay_codec_1.decodeStoreReplayBatchV5)(wire, resultLimits);
            }, remote);
        }
        else if (codec == 'v4') {
            activeRemote = decodeStoreReplayWireRemote(remote.v4, store_replay_codec_1.decodeStoreReplayBatchV4, remote);
        }
        else if (codec == 'v3') {
            activeRemote = decodeStoreReplayWireRemote(remote.v3, store_replay_codec_1.decodeStoreReplayBatchV3, remote);
        }
        else if (codec == 'v2') {
            activeRemote = decodeStoreReplayWireRemote(remote.v2, store_replay_codec_1.decodeStoreReplayBatchV2, remote);
        }
        else {
            activeRemote = decodeStoreReplayWireRemote(remote, store_replay_codec_1.decodeStoreReplayBatch);
        }
        return activeRemote;
    }
    function createAdaptiveLine(selectLine) {
        function subscribeAdaptiveLine(cb) {
            if (!lifecycle)
                return selectLine().on(cb);
            const activeLifecycle = lifecycle;
            let stopped = false;
            let bindingGeneration = 0;
            let handle = null;
            let offConnect = function noAdaptiveConnectListener() { };
            let offDisconnect = function noAdaptiveDisconnectListener() { };
            let offClose = function noAdaptiveCloseListener() { };
            let resolveEnded = function resolveAdaptiveLineLater() { };
            let rejectEnded = function rejectAdaptiveLineLater(_error) { };
            const ended = new Promise(function waitForAdaptiveLineEnd(resolve, reject) {
                resolveEnded = resolve;
                rejectEnded = reject;
            });
            function stopHandle() {
                const current = handle;
                handle = null;
                if (typeof current == 'function')
                    current();
                else if (typeof current?.off == 'function')
                    current.off();
                else if (typeof current?.unsubscribe == 'function')
                    current.unsubscribe();
            }
            function stopListeners() {
                offConnect();
                offDisconnect();
                offClose();
            }
            function finish(failed, error) {
                if (stopped)
                    return;
                stopped = true;
                bindingGeneration++;
                stopListeners();
                stopHandle();
                if (failed)
                    rejectEnded(error);
                else
                    resolveEnded();
            }
            function currentBinding(generation, binding) {
                return !stopped && activeLifecycle.connected()
                    && generation == activeLifecycle.generation() && binding == bindingGeneration;
            }
            async function bindCurrentLine(generation) {
                const binding = ++bindingGeneration;
                try {
                    await schemaReady?.();
                    if (!currentBinding(generation, binding))
                        return;
                    const nextHandle = selectLine().on(cb);
                    if (!currentBinding(generation, binding)) {
                        if (typeof nextHandle == 'function')
                            nextHandle();
                        else if (typeof nextHandle?.off == 'function')
                            nextHandle.off();
                        else if (typeof nextHandle?.unsubscribe == 'function')
                            nextHandle.unsubscribe();
                        return;
                    }
                    handle = nextHandle;
                    if (typeof nextHandle?.then == 'function') {
                        Promise.resolve(nextHandle).then(function adaptivePhysicalLineEnded() {
                            if (currentBinding(generation, binding))
                                finish(false);
                        }, function adaptivePhysicalLineFailed(error) {
                            if (currentBinding(generation, binding))
                                finish(true, error);
                        });
                    }
                }
                catch (error) {
                    if (currentBinding(generation, binding))
                        finish(true, error);
                }
            }
            offDisconnect = activeLifecycle.onDisconnect(function detachAdaptiveLine() {
                bindingGeneration++;
                stopHandle();
            });
            offConnect = activeLifecycle.onConnect(function rebindAdaptiveLine(generation) {
                void bindCurrentLine(generation);
            });
            offClose = activeLifecycle.onClose(function closeAdaptiveLine() {
                finish(false);
            });
            if (activeLifecycle.connected())
                void bindCurrentLine(activeLifecycle.generation());
            return (0, rpc_off_1.makeOff)(ended, function closeAdaptiveLineSubscription() {
                if (stopped)
                    return;
                stopped = true;
                bindingGeneration++;
                stopListeners();
                stopHandle();
            });
        }
        return { on: subscribeAdaptiveLine };
    }
    const adaptiveLine = createAdaptiveLine(function selectLiveLine() {
        return selectedRemote().line;
    });
    const adaptiveFrameLine = createAdaptiveLine(function selectLiveFrameLine() {
        const selected = selectedRemote();
        return selected.frameLine ?? selected.line;
    });
    async function since(seq) {
        await schemaReady?.();
        return selectedRemote().since(seq);
    }
    async function keyframe() {
        await schemaReady?.();
        return selectedRemote().keyframe();
    }
    async function frame(seq, hint) {
        await schemaReady?.();
        const selectedFrame = selectedRemote().frame;
        return selectedFrame ? selectedFrame(seq, hint) : null;
    }
    const decoded = {
        line: adaptiveLine,
        since,
        keyframe,
    };
    Object.defineProperty(decoded, 'frame', {
        get() { return (0, transport_lifecycle_1.rpcMemberAvailable)(selectedRemote(), 'frame') ? frame : undefined; },
    });
    Object.defineProperty(decoded, 'frameLine', {
        get() { return (0, transport_lifecycle_1.rpcMemberAvailable)(selectedRemote(), 'frameLine') ? adaptiveFrameLine : undefined; },
    });
    Object.defineProperty(decoded, transport_lifecycle_1.RPC_TRANSPORT_LIFECYCLE, {
        get: () => remote[transport_lifecycle_1.RPC_TRANSPORT_LIFECYCLE],
    });
    Object.defineProperty(decoded, transport_lifecycle_1.RPC_MEMBER_LOOKUP, {
        get() { return selectedRemote()[transport_lifecycle_1.RPC_MEMBER_LOOKUP]; },
    });
    Object.defineProperty(decoded, transport_lifecycle_1.RPC_SCHEMA_READY, { get: () => remote[transport_lifecycle_1.RPC_SCHEMA_READY] });
    return decoded;
}
function exposeStoreReplay(store, opts = {}) {
    function currentPatch() {
        return [{ path: [], exists: true, value: store.snapshot() }];
    }
    const [, lineApi] = (0, replay_listen_1.replayListen)({
        current: currentPatch,
        frame: condensePatchTail,
        history: opts.getSince ? undefined : (opts.history ?? 1024),
        getSince: opts.getSince,
        onJournal: opts.onJournal,
        onJournalBatch: opts.onJournalBatch,
        now: opts.now,
        firstSeq: opts.firstSeq,
    });
    const batchOpts = opts.batch === true
        ? { now: opts.now }
        : opts.batch ? { ...opts.batch, now: opts.batch.now ?? opts.now } : undefined;
    const batchReplay = batchOpts ? createBatchReplay(store, batchOpts) : undefined;
    const replayApi = exposeStoreReplayLine(lineApi);
    if (batchReplay)
        replayApi.batch = exposeStoreReplayBatch(batchReplay.replay, batchReplay.flush);
    const { patches: _patches, patchesBatch: _patchesBatch, changedData: _changedData, ...storeApi } = (0, store_1.exposeStore)(store, { push: true });
    const patchBatches = opts.patchSource ?? (0, store_1.listenStorePatches)(store);
    const pendingPatches = [];
    let flushingPatches = false;
    function flushPending(forceBatch = true) {
        if (flushingPatches)
            return;
        if (pendingPatches.length == 0) {
            if (forceBatch)
                batchReplay?.flush();
            return;
        }
        flushingPatches = true;
        try {
            while (pendingPatches.length) {
                const count = pendingPatches.length;
                const patches = pendingPatches.slice(0, count);
                const beforeHead = lineApi.head();
                try {
                    batchReplay?.validate(patches);
                    lineApi.emitBatch(patches.map(patch => [patch]));
                }
                catch (error) {
                    const committedCount = Math.min(count, Math.max(0, lineApi.head() - beforeHead));
                    if (committedCount) {
                        const committed = pendingPatches.splice(0, committedCount);
                        batchReplay?.push(committed);
                    }
                    throw error;
                }
                pendingPatches.splice(0, count);
                batchReplay?.push(patches);
            }
            if (forceBatch)
                batchReplay?.flush();
        }
        finally {
            flushingPatches = false;
        }
    }
    const offStore = patchBatches.on(function journalStoreChange(patches) {
        for (const patch of patches)
            pendingPatches.push(patch);
        flushPending(false);
    });
    function describe() {
        return (0, store_1.cloneStoreValue)(opts.describe);
    }
    function retryPending() {
        flushPending(true);
    }
    function close() {
        offStore();
        batchReplay?.close();
        lineApi.close();
    }
    const replayFacade = opts.describe ? { ...replayApi, describe } : replayApi;
    return {
        api: { ...storeApi, replay: replayFacade },
        replay: lineApi,
        replayBatch: batchReplay?.replay,
        batchStats: batchReplay?.stats,
        flushPending: retryPending,
        close,
    };
}
function syncStoreReplayBatch(store, remote, opts = {}) {
    const { batch: _batch, onBatch, validateBatch, ...wireOpts } = opts;
    return (0, replay_wire_1.replaySubscribe)(decodeStoreReplayRemote(remote), function applyBatch(patches) {
        validateBatch?.(patches, store);
        (0, store_1.applyStorePatches)(store, patches);
        onBatch?.(patches, store);
    }, wireOpts);
}
function syncStoreReplayResolved(store, remote, opts) {
    const { batch, onBatch, validateBatch, ...wireOpts } = opts;
    const mode = storeReplayMode(remote, batch);
    if (mode == 'batch') {
        const sub = syncStoreReplayBatch(store, remote.batch, { ...wireOpts, onBatch, validateBatch });
        return Object.assign(sub, { mode });
    }
    const sub = (0, replay_wire_1.replaySubscribe)(remote, function applyLine(patch) {
        validateBatch?.([patch], store);
        (0, store_1.applyStorePatch)(store, patch);
        onBatch?.([patch], store);
    }, wireOpts);
    return Object.assign(sub, { mode });
}
function deferStoreReplaySync(store, remote, opts, schemaReady) {
    let sub;
    let closed = false;
    let closeGate = function closeLater() { };
    let setMode = function setModeLater(_mode) { };
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
        setMode(sub.mode);
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
        mode: 'legacy',
    });
    setMode = function updateDeferredMode(mode) { result.mode = mode; };
    return result;
}
function syncStoreReplay(store, remote, opts = {}) {
    const schemaReady = opts.batch && (0, transport_lifecycle_1.getRpcMemberState)(remote, 'batch') == undefined
        ? (0, transport_lifecycle_1.getRpcSchemaReady)(remote)
        : undefined;
    return schemaReady
        ? deferStoreReplaySync(store, remote, opts, schemaReady)
        : syncStoreReplayResolved(store, remote, opts);
}
function syncStoreReplayRouteResolved(store, remote, opts) {
    const { batch, onBatch, validateBatch, ...routeOpts } = opts;
    const mode = storeReplayMode(remote, batch);
    if (mode == 'legacy') {
        const route = (0, replay_route_1.replayRouteSubscribe)(remote, function applyRoutePatch(patch) {
            validateBatch?.([patch], store);
            (0, store_1.applyStorePatch)(store, patch);
            onBatch?.([patch], store);
        }, routeOpts);
        return Object.assign(route, { mode });
    }
    const route = (0, replay_route_1.replayRouteSubscribe)(decodeStoreReplayRemote(remote.batch), function applyRouteBatch(patches) {
        validateBatch?.(patches, store);
        (0, store_1.applyStorePatches)(store, patches);
        onBatch?.(patches, store);
    }, routeOpts);
    const switchBatchRoute = route.switch;
    let closed = false;
    let generation = 0;
    const schemaWaitCancels = new Set();
    async function waitForBatchSchema(nextRemote) {
        if ((0, transport_lifecycle_1.getRpcMemberState)(nextRemote, 'batch') != undefined)
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
        await waitForBatchSchema(nextRemote);
        if (closed)
            throw new Error('syncStoreReplayRoute: closed');
        if (storeReplayMode(nextRemote, true) != 'batch') {
            throw new Error('syncStoreReplayRoute: batch route cannot switch to legacy coordinates');
        }
        return switchBatchRoute(decodeStoreReplayRemote(nextRemote.batch), nextOpts);
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
        mode,
    });
}
function deferStoreReplayRoute(store, remote, opts, schemaReady) {
    let route;
    let closed = false;
    let schemaFailed = false;
    let closeGate = function closeLater() { };
    let setMode = function setModeLater(_mode) { };
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
        setMode(route.mode);
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
        mode: 'legacy',
    });
    setMode = function updateDeferredRouteMode(mode) { result.mode = mode; };
    return result;
}
function syncStoreReplayRoute(store, remote, opts = {}) {
    const schemaReady = opts.batch && (0, transport_lifecycle_1.getRpcMemberState)(remote, 'batch') == undefined
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
        (0, store_1.applyStorePatch)(scratch, ev.event[0]);
    return scratch.snapshot();
}
