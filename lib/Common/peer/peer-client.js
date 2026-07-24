"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPeerClient = createPeerClient;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
const replay_wire_1 = require("../events/replay-wire");
const transport_lifecycle_1 = require("../events/transport-lifecycle");
const route_coordinator_1 = require("../events/route-coordinator");
const route_signal_webrtc_1 = require("../events/route-signal-webrtc");
const peer_publish_batch_1 = require("./peer-publish-batch");
const peer_remote_compat_1 = require("./peer-remote-compat");
function createPeerClient(deps) {
    const { remote, account, initial, rtc, session, accept, policy, peerInitial = () => ({}), history, drain, journal = 'resume', onPublishError, } = deps;
    const repair = deps.repair ?? 'tail';
    const store = (0, store_1.createStore)(initial, drain !== undefined ? { drain } : {});
    const exposed = (0, store_replay_1.exposeStoreReplay)(store, history !== undefined ? { history } : {});
    let repairing = null;
    let closed = false;
    function peerClientClosedError() {
        return new Error('peer client closed');
    }
    function ensurePeerClientOpen() {
        if (closed)
            throw peerClientClosedError();
    }
    function repairEnvelopes(from) {
        const line = exposed.replay;
        if (repair == 'tail' && from >= 0) {
            const tail = line.getSince(from);
            if (tail)
                return tail;
            if (journal == 'sacred') {
                throw new Error('peer publish: local journal evicted seq ' + from + ', sacred relay is unrepairable — raise {history}');
            }
        }
        const kf = exposed.replay.keyframe();
        return kf ? [kf] : [];
    }
    const publishLifecycle = (0, transport_lifecycle_1.getRpcTransportLifecycle)(remote);
    const publishSchemaReady = (0, transport_lifecycle_1.getRpcSchemaReady)(remote);
    let publishGeneration = publishLifecycle?.generation();
    function detectPublishMode() {
        const state = (0, transport_lifecycle_1.getRpcMemberState)(remote, 'publishBatch');
        if (state == true)
            return 'batch';
        if (state == false)
            return 'legacy';
        if (publishSchemaReady)
            return 'probe';
        if (typeof remote.publishBatch != 'function')
            return 'legacy';
        return 'probe';
    }
    let publishMode = detectPublishMode();
    function refreshPublishMode() {
        const generation = publishLifecycle?.generation();
        const generationChanged = generation != publishGeneration;
        if (generationChanged)
            publishGeneration = generation;
        const detected = detectPublishMode();
        if (detected != 'probe' || generationChanged)
            publishMode = detected;
        return publishMode;
    }
    async function publishLegacy(batches, sequential = false) {
        ensurePeerClientOpen();
        if (sequential) {
            for (const batch of batches) {
                for (const item of batch.items) {
                    ensurePeerClientOpen();
                    const result = await remote.publish(item);
                    if (result == false || (result != null && typeof result == 'object'))
                        return result;
                }
            }
            return true;
        }
        const calls = [];
        for (const batch of batches) {
            for (const item of batch.items) {
                ensurePeerClientOpen();
                calls.push(Promise.resolve(remote.publish(item)));
            }
        }
        const results = await Promise.all(calls);
        for (const result of results) {
            if (result == false || (result != null && typeof result == 'object'))
                return result;
        }
        return true;
    }
    function canPublishBatch(batch) {
        return batch.byteLength <= peer_publish_batch_1.PEER_PUBLISH_BATCH_MAX_BYTES;
    }
    function publishBatchGroup(batch) {
        ensurePeerClientOpen();
        if (!canPublishBatch(batch))
            return Promise.resolve(remote.publish(batch.items[0]));
        return Promise.resolve(remote.publishBatch(batch.items));
    }
    async function publishKnownBatches(batches, sequential = false) {
        if (sequential) {
            for (const batch of batches) {
                const result = await publishBatchGroup(batch);
                if (result == false || (result != null && typeof result == 'object'))
                    return result;
            }
            return true;
        }
        const calls = [];
        for (const batch of batches)
            calls.push(publishBatchGroup(batch));
        const results = await Promise.all(calls);
        for (const result of results) {
            if (result == false || (result != null && typeof result == 'object'))
                return result;
        }
        return true;
    }
    async function publishBatches(batches, sequential = false) {
        ensurePeerClientOpen();
        if (publishSchemaReady && (0, transport_lifecycle_1.getRpcMemberState)(remote, 'publishBatch') == undefined) {
            await publishSchemaReady();
            ensurePeerClientOpen();
        }
        refreshPublishMode();
        if (publishMode == 'legacy')
            return publishLegacy(batches, sequential);
        if (publishMode == 'batch') {
            try {
                return await publishKnownBatches(batches, sequential);
            }
            catch (error) {
                if (closed)
                    throw error;
                const modeAfterError = refreshPublishMode();
                if (modeAfterError == 'legacy')
                    return publishLegacy(batches, sequential);
                throw error;
            }
        }
        const [first, ...rest] = batches;
        if (!first)
            return true;
        if (!canPublishBatch(first))
            return publishLegacy(batches, sequential);
        try {
            const result = await remote.publishBatch(first.items);
            ensurePeerClientOpen();
            publishMode = 'batch';
            if (result == false || (result != null && typeof result == 'object'))
                return result;
        }
        catch (error) {
            if (closed)
                throw error;
            refreshPublishMode();
            if (publishMode == 'probe')
                publishMode = 'legacy';
            return publishLegacy(batches, sequential);
        }
        return publishKnownBatches(rest, sequential);
    }
    async function runRepair(from) {
        ensurePeerClientOpen();
        const batches = (0, peer_publish_batch_1.splitMeasuredPeerPublishEnvelopes)(repairEnvelopes(from));
        const res = await publishBatches(batches, true);
        if (res != null && typeof res == 'object') {
            throw new Error('peer publish: repair rejected at relay seq ' + res.seq);
        }
    }
    function queueRepair(from) {
        if (closed)
            return Promise.resolve();
        if (repairing)
            return repairing;
        repairing = runRepair(from)
            .catch(function reportRepairError(e) {
            if (closed)
                return;
            if (onPublishError)
                onPublishError(e);
            else
                setTimeout(function rethrowRepairError() { throw e; }, 0);
        })
            .finally(function finishRepair() { repairing = null; });
        return repairing;
    }
    async function handleVerdict(res) {
        if (closed)
            return;
        if (res != null && typeof res == 'object' && typeof res.seq == 'number')
            await queueRepair(res.seq);
    }
    async function publishQueued(batch) {
        await handleVerdict(await publishBatches([batch]));
    }
    function reportPublishReject(error) {
        try {
            onPublishError?.(error);
        }
        catch (callbackError) {
            setTimeout(function rethrowPublishErrorCallback() { throw callbackError; }, 0);
        }
    }
    const MAX_PENDING_PUBLISH_BATCHES = 64;
    const publishWork = [];
    let publishing = false;
    let activeBarrier = null;
    async function drainPublishWork() {
        if (publishing || closed)
            return;
        publishing = true;
        try {
            while (!closed && publishWork.length) {
                const work = publishWork.shift();
                if (work.kind == 'batch') {
                    try {
                        await publishQueued(work.batch);
                    }
                    catch (error) {
                        if (!closed)
                            reportPublishReject(error);
                    }
                    continue;
                }
                activeBarrier = work;
                try {
                    await work.run();
                    if (closed)
                        work.reject(peerClientClosedError());
                    else
                        work.resolve();
                }
                catch (error) {
                    work.reject(error);
                }
                finally {
                    if (activeBarrier == work)
                        activeBarrier = null;
                }
            }
        }
        finally {
            publishing = false;
            if (!closed && publishWork.length)
                void drainPublishWork();
        }
    }
    function pendingBatchSuffixLength() {
        let count = 0;
        for (let index = publishWork.length - 1; index >= 0; index--) {
            if (publishWork[index].kind != 'batch')
                break;
            count++;
        }
        return count;
    }
    function dispatchPublish(batch) {
        if (closed)
            return;
        const pendingBatches = pendingBatchSuffixLength();
        if (journal != 'sacred' && pendingBatches >= MAX_PENDING_PUBLISH_BATCHES) {
            const keyframe = exposed.replay.keyframe();
            const root = keyframe ? (0, peer_publish_batch_1.splitMeasuredPeerPublishEnvelopes)([keyframe])[0] : undefined;
            publishWork.length -= pendingBatches;
            publishWork.push({ kind: 'batch', batch: root ?? batch });
        }
        else {
            publishWork.push({ kind: 'batch', batch });
        }
        void drainPublishWork();
    }
    function rejectPublishWork(error) {
        const pending = publishWork.splice(0);
        for (const work of pending) {
            if (work.kind == 'barrier')
                work.reject(error);
        }
        const active = activeBarrier;
        activeBarrier = null;
        active?.reject(error);
    }
    const publishQueue = (0, peer_publish_batch_1.createMeasuredPeerPublishBatchQueue)({
        emit: dispatchPublish,
        schedule: queueMicrotask,
    });
    const offPublish = exposed.replay.line.on(function publishEnvelope(env) {
        publishQueue.push(env);
    });
    const warmup = exposed.replay.keyframe();
    if (warmup)
        publishQueue.push(warmup);
    function resync() {
        if (closed) {
            const rejected = Promise.reject(peerClientClosedError());
            void rejected.catch(function containIgnoredClosedResync() { });
            return rejected;
        }
        publishQueue.flush();
        if (closed) {
            const rejected = Promise.reject(peerClientClosedError());
            void rejected.catch(function containIgnoredFlushClose() { });
            return rejected;
        }
        const pending = new Promise(function queueResync(resolve, reject) {
            publishWork.push({
                kind: 'barrier',
                async run() {
                    ensurePeerClientOpen();
                    const node = remote.peers[account];
                    const relaySeq = await (0, peer_remote_compat_1.readPeerRelaySeq)(node);
                    ensurePeerClientOpen();
                    const localSeq = exposed.replay.keyframe()?.seq ?? -1;
                    if (relaySeq >= localSeq)
                        return;
                    await runRepair(relaySeq);
                },
                resolve,
                reject,
            });
            void drainPublishWork();
        });
        void pending.catch(function containIgnoredResyncRejection() { });
        return pending;
    }
    const port = {
        send: env => remote.signal.send(env),
        signals: { on: cb => remote.signal.signals.on(cb) },
    };
    const stopAccept = rtc
        ? (0, route_signal_webrtc_1.acceptWebRtcDirect)({
            port, rtc, self: account,
            serve: () => (0, replay_wire_1.exposeReplay)(exposed.replay),
            ...(accept ? { accept } : {}),
        })
        : null;
    function relayConnector(other) {
        let state = 'idle';
        return {
            info: { label: 'relay', kind: 'relay', ordered: true, reliable: true },
            open() {
                const node = remote.peers[other];
                state = 'open';
                function subscribeLine(cb) {
                    return node.line.on(cb);
                }
                function since(seq) {
                    return node.since(seq);
                }
                function keyframe() {
                    return node.keyframe();
                }
                function frame(seq, hint) {
                    return (0, peer_remote_compat_1.readPeerRelayFrame)(node, seq, hint);
                }
                return {
                    line: { on: subscribeLine },
                    since,
                    keyframe,
                    frame,
                };
            },
            close() { state = 'closed'; },
            state: () => state,
        };
    }
    const coord = (0, route_coordinator_1.createRouteCoordinator)({
        ...(policy ? { policy } : {}),
        connect(ref, kind) {
            const other = ref.a == account ? ref.b : ref.a;
            if (kind == 'relay')
                return relayConnector(other);
            if (!rtc)
                throw new Error('peer client: promoteDirect needs an rtc factory (deps.rtc)');
            return (0, route_signal_webrtc_1.createWebRtcConnector)({
                port, rtc, self: account, peer: other, pair: ref.key, session,
            });
        },
    });
    const views = new Map();
    function makeView(other) {
        const link = coord.pair(account, other);
        const mirror = (0, store_1.createStore)(peerInitial(), drain !== undefined ? { drain } : {});
        const sub = link.subscribe(function mirrorPatch(patch) {
            (0, store_1.applyStorePatch)(mirror, patch);
        });
        const view = {
            account: other,
            store: mirror,
            ready: sub.ready,
            seq: sub.seq,
            route: link.label,
            state: link.state,
            promoteDirect: link.promoteDirect,
            reinterposeRelay: link.reinterposeRelay,
            fallback: link.fallback,
            block: link.block,
            close() {
                views.delete(other);
                sub();
                link.close();
            },
        };
        return view;
    }
    function peer(other) {
        const existing = views.get(other);
        if (existing)
            return existing;
        const view = makeView(other);
        views.set(other, view);
        return view;
    }
    return {
        store,
        peer,
        onRoute: coord.onRoute,
        resync,
        close() {
            if (closed)
                return;
            closed = true;
            rejectPublishWork(peerClientClosedError());
            offPublish();
            publishQueue.close();
            for (const view of Array.from(views.values()))
                view.close();
            coord.close();
            stopAccept?.();
            exposed.close();
        },
    };
}
