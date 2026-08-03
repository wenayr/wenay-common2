"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStoreReplayViewLayer = createStoreReplayViewLayer;
const store_1 = require("./store");
const replay_rpc_wire_1 = require("../events/replay-rpc-wire");
const rpc_walk_1 = require("../rcp/rpc-walk");
const positive_integer_option_1 = require("../positive-integer-option");
const store_selection_1 = require("./store-selection");
const observe_private_1 = require("./observe-private");
const reactive_1 = require("./reactive");
const store_replay_codec_1 = require("./store-replay-codec");
function createStoreReplayViewLayer(deps) {
    const { createBatchReplay, exposeStoreReplayBatch, syncStoreReplay } = deps;
    let storeReplayViewLifetime = 0;
    function storeReplayViewId(prefix) {
        storeReplayViewLifetime++;
        return prefix + ':' + Date.now().toString(36) + ':' + storeReplayViewLifetime.toString(36)
            + ':' + Math.random().toString(36).slice(2);
    }
    function requireStoreReplayViewLineId(value) {
        if (typeof value != 'string' || value.length == 0) {
            throw new TypeError('createStoreReplayView: lineId must be a non-empty string');
        }
        return value;
    }
    function storeReplayViewSnapshotTask() {
        return new Promise(function yieldSnapshotChunk(resolve) {
            if (typeof setImmediate == 'function')
                setImmediate(resolve);
            else
                setTimeout(resolve, 0);
        });
    }
    function createStoreReplayView(store, opts) {
        const keys = (0, store_selection_1.normalizeStoreSelectionKeys)(opts.keys, 'createStoreReplayView');
        const selected = new Set(keys);
        const selectionId = (0, store_selection_1.storeSelectionId)(keys);
        const lineId = requireStoreReplayViewLineId(opts.lineId ?? storeReplayViewId('store-view'));
        const snapshotOpts = opts.snapshot ?? {};
        const snapshotChunkBytes = (0, positive_integer_option_1.positiveIntegerOption)(snapshotOpts.chunkBytes, 512 * 1024, 'createStoreReplayView: snapshot.chunkBytes');
        const snapshotWindowBytes = (0, positive_integer_option_1.positiveIntegerOption)(snapshotOpts.windowBytes, 1024 * 1024, 'createStoreReplayView: snapshot.windowBytes');
        const snapshotMaxItems = (0, positive_integer_option_1.positiveIntegerOption)(snapshotOpts.maxItems, 256, 'createStoreReplayView: snapshot.maxItems');
        const maxSessions = (0, positive_integer_option_1.positiveIntegerOption)(snapshotOpts.maxSessions, 32, 'createStoreReplayView: snapshot.maxSessions');
        const snapshotTtlMs = (0, positive_integer_option_1.positiveIntegerOption)(snapshotOpts.ttlMs, 30_000, 'createStoreReplayView: snapshot.ttlMs');
        function sampleSelectedKey(key) {
            const root = (0, reactive_1.toRaw)(store.state);
            const exists = Object.prototype.hasOwnProperty.call(root, key);
            return {
                path: [key],
                exists,
                value: exists ? (0, store_1.cloneStoreValue)(root[key]) : undefined,
            };
        }
        function currentViewBatch() {
            const patches = [{ path: [], exists: true, value: {} }];
            for (const key of keys)
                patches.push(sampleSelectedKey(key));
            return [patches];
        }
        const batchReplay = createBatchReplay(currentViewBatch, opts, 'createStoreReplayView');
        const replayApi = exposeStoreReplayBatch(batchReplay.replay, batchReplay.flush);
        const descriptor = {
            ...(0, store_1.cloneStoreValue)(opts.describe ?? {}),
            storeReplayView: {
                version: 1,
                lineId,
                selectionId,
                keyCount: keys.length,
            },
        };
        function describe() {
            return (0, store_1.cloneStoreValue)(descriptor);
        }
        const replayFacade = { ...replayApi, describe };
        (0, replay_rpc_wire_1.retransmitRpcReplayWire)(replayApi, replayFacade);
        const createSelectedPatches = store[observe_private_1.STORE_REPLAY_VIEW_PATCH_SOURCE];
        const getExactPatches = store[observe_private_1.STORE_REPLAY_PATCH_SOURCE];
        const sourceIsSelected = opts.patchSource == null && createSelectedPatches != null;
        const source = opts.patchSource
            ?? createSelectedPatches?.(keys)
            ?? getExactPatches?.()
            ?? (0, store_1.listenStorePatches)(store);
        function selectRootPatch(rootPatch) {
            const root = rootPatch.exists ? rootPatch.value : undefined;
            return keys.map(function projectSelectedRootKey(key) {
                const exists = root != null && typeof root == 'object'
                    && Object.prototype.hasOwnProperty.call(root, key);
                return {
                    path: [key],
                    exists,
                    value: exists ? root[key] : undefined,
                };
            });
        }
        function journalSelectedStoreChange(patches) {
            const projected = [];
            for (const patch of patches) {
                if (patch.path.length == 0) {
                    projected.push(...selectRootPatch(patch));
                    continue;
                }
                if (typeof patch.path[0] == 'string' && selected.has(patch.path[0])) {
                    projected.push(patch);
                }
            }
            batchReplay.push(projected);
        }
        function journalPreselectedStoreChange(patches) {
            batchReplay.push(patches);
        }
        const offStore = source.on(sourceIsSelected ? journalPreselectedStoreChange : journalSelectedStoreChange);
        const sessions = new Map();
        let cleanupTimer = null;
        let closed = false;
        let openedSnapshots = 0;
        let completedSnapshots = 0;
        let expiredSnapshots = 0;
        let retrySnapshots = 0;
        let snapshotPages = 0;
        let snapshotChunks = 0;
        let snapshotPatches = 0;
        let snapshotBytes = 0;
        function stopCleanupTimer() {
            if (!cleanupTimer)
                return;
            clearTimeout(cleanupTimer);
            cleanupTimer = null;
        }
        function pruneSnapshotSessions(now = Date.now()) {
            for (const [id, session] of sessions) {
                if (session.reading || now - session.lastUse < snapshotTtlMs)
                    continue;
                sessions.delete(id);
                expiredSnapshots++;
            }
            if (sessions.size == 0)
                stopCleanupTimer();
        }
        function armCleanupTimer() {
            if (cleanupTimer || sessions.size == 0 || closed)
                return;
            cleanupTimer = setTimeout(function cleanExpiredSnapshotSessions() {
                cleanupTimer = null;
                pruneSnapshotSessions();
                armCleanupTimer();
            }, snapshotTtlMs);
            cleanupTimer.unref?.();
        }
        function openSnapshot() {
            if (closed)
                throw new Error('createStoreReplayView: closed');
            pruneSnapshotSessions();
            if (sessions.size >= maxSessions) {
                throw new Error('createStoreReplayView: too many active snapshot sessions');
            }
            batchReplay.flush();
            const transferId = storeReplayViewId('snapshot');
            const session = {
                transferId,
                baseSeq: batchReplay.replay.head(),
                ts: Date.now(),
                keyIndex: -1,
                page: 0,
                chunkIndex: 0,
                lastUse: Date.now(),
                reading: false,
            };
            sessions.set(transferId, session);
            openedSnapshots++;
            armCleanupTimer();
            return {
                version: 1,
                transferId,
                lineId,
                selectionId,
                baseSeq: session.baseSeq,
                ts: session.ts,
            };
        }
        function nextSnapshotPatch(session) {
            if (session.keyIndex < 0) {
                session.keyIndex = 0;
                return { path: [], exists: true, value: {} };
            }
            if (session.keyIndex >= keys.length)
                return undefined;
            return sampleSelectedKey(keys[session.keyIndex++]);
        }
        function measureSnapshotPatch(patch, firstBinaryIndex) {
            try {
                const metrics = (0, store_replay_codec_1.storeReplayPatchV2WireMetrics)(patch, firstBinaryIndex);
                return { patch, byteLength: metrics.byteLength + 1, binaryCount: metrics.binaryCount };
            }
            catch {
                return { patch, byteLength: snapshotChunkBytes, binaryCount: 0 };
            }
        }
        function buildSnapshotChunk(session, chunkLimit, carried) {
            const patches = [];
            let estimatedBytes = 48;
            let binaryCount = 0;
            let pending = carried?.binaryCount
                ? measureSnapshotPatch(carried.patch, 0)
                : carried;
            while (patches.length < snapshotMaxItems) {
                const measured = pending ?? (() => {
                    const patch = nextSnapshotPatch(session);
                    return patch ? measureSnapshotPatch(patch, binaryCount) : undefined;
                })();
                pending = undefined;
                if (!measured)
                    break;
                if (patches.length && estimatedBytes + measured.byteLength > chunkLimit) {
                    pending = measured;
                    break;
                }
                patches.push(measured.patch);
                estimatedBytes += measured.byteLength;
                binaryCount += measured.binaryCount;
            }
            return { patches, estimatedBytes, pending };
        }
        async function readSnapshot(request, emit) {
            if (closed)
                throw new Error('createStoreReplayView: closed');
            if (!request || typeof request.transferId != 'string'
                || !Number.isSafeInteger(request.after) || request.after < 0) {
                throw new TypeError('createStoreReplayView: invalid snapshot read request');
            }
            pruneSnapshotSessions();
            const session = sessions.get(request.transferId);
            if (!session)
                throw new Error('createStoreReplayView: unknown or expired snapshot');
            if (session.reading)
                throw new Error('createStoreReplayView: snapshot read already in progress');
            if (request.after != session.page) {
                throw new Error(`createStoreReplayView: expected snapshot page ${session.page}, received ${request.after}`);
            }
            let windowLimit = snapshotWindowBytes;
            if (request.maxBytes != null) {
                if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
                    throw new TypeError('createStoreReplayView: snapshot maxBytes must be a positive safe integer');
                }
                windowLimit = Math.min(windowLimit, request.maxBytes);
            }
            const chunkLimit = Math.min(snapshotChunkBytes, windowLimit);
            const page = session.page;
            let emitted = 0;
            let emittedBytes = 0;
            let pending;
            session.reading = true;
            session.lastUse = Date.now();
            function rewindSnapshotPatches(patches, carried) {
                let selectedCount = patches.filter(patch => patch.path.length == 1).length;
                if (carried?.patch.path.length == 1)
                    selectedCount++;
                session.keyIndex -= selectedCount;
            }
            try {
                while (session.keyIndex < keys.length || session.keyIndex < 0 || pending) {
                    const built = buildSnapshotChunk(session, chunkLimit, pending);
                    pending = built.pending;
                    if (built.patches.length == 0)
                        break;
                    if (emitted > 0 && emittedBytes + built.estimatedBytes > windowLimit) {
                        rewindSnapshotPatches(built.patches, pending);
                        pending = undefined;
                        break;
                    }
                    const chunk = {
                        version: 1,
                        transferId: session.transferId,
                        page,
                        index: session.chunkIndex++,
                        wire: (0, store_replay_codec_1.encodeStoreReplayBatchV2)({
                            seq: session.baseSeq,
                            ts: session.ts,
                            event: [built.patches],
                        }),
                    };
                    emit(chunk);
                    emitted++;
                    emittedBytes += built.estimatedBytes;
                    snapshotChunks++;
                    snapshotPatches += built.patches.length;
                    snapshotBytes += built.estimatedBytes;
                    await storeReplayViewSnapshotTask();
                    if (emittedBytes >= windowLimit) {
                        rewindSnapshotPatches([], pending);
                        pending = undefined;
                        break;
                    }
                }
            }
            finally {
                (0, rpc_walk_1.rpcEndCallback)(emit);
                session.reading = false;
                session.lastUse = Date.now();
            }
            session.page++;
            snapshotPages++;
            const done = session.keyIndex >= keys.length && !pending;
            let retry;
            if (done) {
                batchReplay.flush();
                if (batchReplay.replay.getSince(session.baseSeq) == null) {
                    retry = true;
                    retrySnapshots++;
                }
                else {
                    completedSnapshots++;
                }
            }
            armCleanupTimer();
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
            };
        }
        function closeSnapshot(transferId) {
            if (typeof transferId != 'string')
                return;
            sessions.delete(transferId);
            if (sessions.size == 0)
                stopCleanupTimer();
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
            };
        }
        function close() {
            if (closed)
                return;
            closed = true;
            offStore();
            stopCleanupTimer();
            sessions.clear();
            batchReplay.close();
        }
        const resource = {
            describe,
            replay: replayFacade,
            snapshot: {
                open: openSnapshot,
                read: readSnapshot,
                close: closeSnapshot,
            },
        };
        return {
            resource,
            events: { replay: batchReplay.replay },
            view: {
                lineId,
                selectionId,
                keys: () => [...keys],
                stats,
            },
            close,
        };
    }
    function abortStoreReplayViewSnapshot(signal) {
        if (!signal.aborted)
            return;
        const error = new Error('syncStoreReplayView: snapshot cancelled');
        error.name = 'AbortError';
        throw error;
    }
    function applyOwnedStoreReplayViewPatch(root, patch) {
        if (patch.path.length == 0) {
            if (root)
                throw new TypeError('syncStoreReplayView: duplicate snapshot root reset');
            if (!patch.exists || patch.value == null || typeof patch.value != 'object'
                || Array.isArray(patch.value)) {
                throw new TypeError('syncStoreReplayView: first snapshot patch must reset the object root');
            }
            return {};
        }
        if (!root)
            throw new TypeError('syncStoreReplayView: snapshot key arrived before root reset');
        if (patch.path.length != 1 || typeof patch.path[0] != 'string') {
            throw new TypeError('syncStoreReplayView: snapshot contains a non-top-level string path');
        }
        const key = patch.path[0];
        if (!patch.exists) {
            Reflect.deleteProperty(root, key);
            return root;
        }
        const defined = Reflect.defineProperty(root, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: patch.value,
        });
        if (!defined)
            throw new TypeError('syncStoreReplayView: cannot assemble snapshot key ' + key);
        return root;
    }
    function syncStoreReplayView(store, remote, opts = {}) {
        const { cursor, snapshotWindowBytes, snapshotRetries, onSnapshotProgress, validateBatch, onBatch, ...wireOpts } = opts;
        if (cursor && (typeof cursor.lineId != 'string' || cursor.lineId.length == 0
            || typeof cursor.selectionId != 'string' || cursor.selectionId.length == 0
            || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0)) {
            throw new TypeError('syncStoreReplayView: invalid cursor');
        }
        let activeLineId = cursor?.lineId;
        let activeSelectionId = cursor?.selectionId;
        const maxAttempts = (0, positive_integer_option_1.positiveIntegerOption)(snapshotRetries, 3, 'syncStoreReplayView: snapshotRetries');
        if (snapshotWindowBytes != null
            && (!Number.isSafeInteger(snapshotWindowBytes) || snapshotWindowBytes <= 0)) {
            throw new TypeError('syncStoreReplayView: snapshotWindowBytes must be a positive safe integer');
        }
        async function installSnapshot(signal) {
            let lastError;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                abortStoreReplayViewSnapshot(signal);
                const opened = await remote.snapshot.open();
                abortStoreReplayViewSnapshot(signal);
                if (!opened || opened.version != 1 || typeof opened.transferId != 'string'
                    || typeof opened.lineId != 'string' || typeof opened.selectionId != 'string'
                    || !Number.isSafeInteger(opened.baseSeq) || opened.baseSeq < 0
                    || !Number.isFinite(opened.ts) || opened.ts < 0) {
                    throw new TypeError('syncStoreReplayView: invalid snapshot open response');
                }
                let root;
                let page = 0;
                let chunkIndex = 0;
                let chunkError;
                let chunks = 0;
                try {
                    while (true) {
                        abortStoreReplayViewSnapshot(signal);
                        let pageChunks = 0;
                        const result = await remote.snapshot.read({
                            transferId: opened.transferId,
                            after: page,
                            maxBytes: snapshotWindowBytes,
                        }, function receiveStoreReplayViewChunk(chunk) {
                            if (signal.aborted || chunkError)
                                return;
                            try {
                                if (!chunk || chunk.version != 1 || chunk.transferId != opened.transferId
                                    || chunk.page != page || chunk.index != chunkIndex) {
                                    throw new TypeError('syncStoreReplayView: invalid or out-of-order snapshot chunk');
                                }
                                const event = (0, store_replay_codec_1.decodeStoreReplayBatchV2)(chunk.wire);
                                if (event.seq != opened.baseSeq || event.ts != opened.ts) {
                                    throw new TypeError('syncStoreReplayView: snapshot chunk changed its coordinate');
                                }
                                for (const patch of event.event[0]) {
                                    root = applyOwnedStoreReplayViewPatch(root, patch);
                                }
                                chunkIndex++;
                                pageChunks++;
                                chunks++;
                            }
                            catch (error) {
                                chunkError = error;
                            }
                        });
                        abortStoreReplayViewSnapshot(signal);
                        if (chunkError)
                            throw chunkError;
                        if (!result || result.version != 1 || result.transferId != opened.transferId
                            || result.lineId != opened.lineId || result.after != page
                            || result.next != page + 1 || result.emitted != pageChunks
                            || typeof result.done != 'boolean') {
                            throw new TypeError('syncStoreReplayView: invalid snapshot read response');
                        }
                        page = result.next;
                        onSnapshotProgress?.({
                            transferId: opened.transferId,
                            chunks,
                            pages: page,
                            done: result.done,
                        });
                        if (!result.done)
                            continue;
                        if (result.retry) {
                            lastError = new Error('syncStoreReplayView: replay history moved past the snapshot base');
                            break;
                        }
                        if (result.seq != opened.baseSeq || result.ts != opened.ts || !root) {
                            throw new TypeError('syncStoreReplayView: incomplete snapshot commit');
                        }
                        abortStoreReplayViewSnapshot(signal);
                        const rootPatch = {
                            path: [],
                            exists: true,
                            value: root,
                        };
                        validateBatch?.([rootPatch], store);
                        abortStoreReplayViewSnapshot(signal);
                        store.replace(root);
                        onBatch?.([rootPatch], store);
                        activeLineId = opened.lineId;
                        activeSelectionId = opened.selectionId;
                        return { since: result.seq, ts: result.ts };
                    }
                }
                finally {
                    try {
                        const closing = remote.snapshot.close(opened.transferId);
                        if (closing && typeof closing.catch == 'function') {
                            void closing.catch(function ignoreSnapshotCloseFailure() { });
                        }
                    }
                    catch {
                    }
                }
            }
            throw lastError ?? new Error('syncStoreReplayView: snapshot retries exhausted');
        }
        async function sameReplayViewLine(signal) {
            const descriptor = await remote.describe();
            abortStoreReplayViewSnapshot(signal);
            const view = descriptor?.['storeReplayView'];
            if (!view || view.version != 1 || typeof view.lineId != 'string' || view.lineId.length == 0
                || typeof view.selectionId != 'string' || view.selectionId.length == 0) {
                throw new TypeError('syncStoreReplayView: remote has no valid view descriptor');
            }
            return activeLineId != null && activeLineId == view.lineId
                && activeSelectionId != null && activeSelectionId == view.selectionId;
        }
        const sub = syncStoreReplay(store, remote.replay, {
            ...wireOpts,
            since: cursor?.seq,
            validateBatch,
            onBatch,
            catchUp: 'tail',
            async prepareCatchUp(context) {
                if (context.since >= 0 && await sameReplayViewLine(context.signal))
                    return;
                return installSnapshot(context.signal);
            },
            async recoverGap(context) {
                return installSnapshot(context.signal);
            },
        });
        return Object.assign(sub, {
            viewMode: 'v1',
            cursor() {
                return activeLineId == null || activeSelectionId == null
                    ? null
                    : { lineId: activeLineId, selectionId: activeSelectionId, seq: sub.seq() };
            },
        });
    }
    return { createStoreReplayView, syncStoreReplayView };
}
