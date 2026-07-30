"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exposeReplay = exposeReplay;
exports.readReplayDescriptor = readReplayDescriptor;
exports.replaySubscribe = replaySubscribe;
const replay_conflate_1 = require("./replay-conflate");
const replay_rpc_wire_1 = require("./replay-rpc-wire");
const transport_lifecycle_1 = require("./transport-lifecycle");
function exposeReplayPlain(replay) {
    const facade = {
        line: replay.line,
        since: (seq) => replay.getSince(seq) ?? null,
        keyframe: () => replay.keyframe() ?? null,
        frame: (seq, hint) => replay.frame(seq, hint),
    };
    return (0, replay_rpc_wire_1.brandRpcReplayWire)(facade, {
        head: replay.head,
        sequenceOf(event) {
            const seq = event?.seq;
            return typeof seq == 'number' ? seq : undefined;
        },
    });
}
function exposeReplay(replay, opts) {
    if (!opts?.conflate)
        return exposeReplayPlain(replay);
    const gated = (0, replay_conflate_1.conflateReplay)(replay, opts.conflate);
    return { ...gated.api, close: gated.close, stats: gated.stats };
}
function unsubscribeHandle(handle) {
    if (typeof handle == 'function') {
        handle();
        return;
    }
    if (typeof handle?.off == 'function')
        handle.off();
    else if (typeof handle?.unsubscribe == 'function')
        handle.unsubscribe();
}
async function readReplayDescriptor(remote) {
    await (0, transport_lifecycle_1.getRpcSchemaReady)(remote)?.();
    if (!(0, transport_lifecycle_1.rpcMemberAvailable)(remote, 'describe'))
        return null;
    return (await remote.describe()) ?? null;
}
function replaySubscribe(remote, cb, opts = {}) {
    const { since = -1, onSeq, onError, onLive, staleMs, onStale, skewMs = 0, now = Date.now, policy = 'queue', hint, catchUp: catchUpMode = 'frame', gapPolicy = 'keyframe', prepareCatchUp, recoverGap, } = opts;
    const lifecycle = (0, transport_lifecycle_1.getRpcTransportLifecycle)(remote);
    let lastDelivered = since;
    let replaying = true;
    let closed = false;
    let recoveryGeneration = 0;
    let recoveryAbort;
    let queue = [];
    let deliveryQueue = [];
    let delivering = false;
    let readySettled = false;
    let resolveReady = function resolveReadyLater() { };
    const ready = new Promise(function waitUntilReady(resolve) { resolveReady = resolve; });
    function settleReady() {
        if (readySettled)
            return;
        readySettled = true;
        resolveReady();
    }
    let lastTs = 0;
    let lastArrival = now();
    let staleFlag = false;
    let staleTimer = null;
    function stopStaleTimer() {
        if (staleTimer) {
            clearTimeout(staleTimer);
            staleTimer = null;
        }
    }
    function reportStale(stale) {
        staleFlag = stale;
        if (!onStale)
            return;
        try {
            onStale({ stale, lastTs, age: now() - (lastTs || lastArrival) });
        }
        catch (e) {
            setTimeout(function rethrowOnStale() { throw e; }, 0);
        }
    }
    function checkArrivalGap() {
        staleTimer = null;
        if (closed)
            return;
        const gap = now() - lastArrival;
        if (gap >= staleMs) {
            if (!staleFlag)
                reportStale(true);
        }
        else
            armStaleTimer(staleMs - gap);
    }
    function armStaleTimer(delay) {
        if (staleTimer || !onStale || staleMs == null || closed)
            return;
        staleTimer = setTimeout(checkArrivalGap, delay);
        staleTimer.unref?.();
    }
    function assessStale() {
        if (staleMs == null || closed)
            return;
        const tsStale = lastTs > 0 && now() - lastTs > staleMs + skewMs;
        if (tsStale != staleFlag)
            reportStale(tsStale);
        if (tsStale)
            stopStaleTimer();
        else
            armStaleTimer(staleMs);
    }
    armStaleTimer(staleMs);
    function deliverOne(ev) {
        if (closed || ev.seq <= lastDelivered)
            return;
        if (gapPolicy == 'error' && lastDelivered >= 0 && ev.seq != lastDelivered + 1) {
            failRecovery(new Error(`non-contiguous sequence: expected ${lastDelivered + 1}, received ${ev.seq}`), lastDelivered, 'sequence gap');
            return;
        }
        try {
            cb(...ev.event);
        }
        catch (error) {
            failRecovery(error, lastDelivered, 'consumer callback');
            return;
        }
        lastDelivered = ev.seq;
        lastTs = ev.ts;
        lastArrival = now();
        if (onSeq) {
            try {
                onSeq(ev.seq);
            }
            catch (error) {
                setTimeout(function rethrowOnSeq() { throw error; }, 0);
            }
        }
        if (!replaying)
            assessStale();
    }
    function deliver(ev) {
        deliveryQueue.push(ev);
        if (delivering)
            return;
        delivering = true;
        let index = 0;
        try {
            while (!closed && index < deliveryQueue.length)
                deliverOne(deliveryQueue[index++]);
        }
        finally {
            deliveryQueue.length = 0;
            delivering = false;
        }
    }
    function orderedEvents(events, owned = false) {
        for (let index = 1; index < events.length; index++) {
            if (events[index - 1].seq <= events[index].seq)
                continue;
            return (owned ? events : [...events]).sort((a, b) => a.seq - b.seq);
        }
        return events;
    }
    function deliverSorted(events, allowReset) {
        const sorted = orderedEvents(events);
        if (allowReset && sorted.length && sorted[0].seq <= lastDelivered) {
            lastDelivered = sorted[0].seq - 1;
        }
        for (const event of sorted)
            deliver(event);
    }
    function drainLiveQueue() {
        while (queue.length) {
            const batch = queue;
            queue = [];
            for (const event of orderedEvents(batch, true))
                deliver(event);
        }
    }
    let handle = null;
    let offConnect = function noConnectListener() { };
    let offDisconnect = function noDisconnectListener() { };
    let offClose = function noCloseListener() { };
    function closeSubscription() {
        if (closed)
            return false;
        closed = true;
        recoveryGeneration++;
        recoveryAbort?.abort();
        recoveryAbort = undefined;
        queue.length = 0;
        deliveryQueue.length = 0;
        stopStaleTimer();
        offConnect();
        offDisconnect();
        offClose();
        unsubscribeHandle(handle);
        settleReady();
        return true;
    }
    function errorText(error) {
        if (typeof error?.message == 'string')
            return error.message;
        if (typeof error?.error?.message == 'string')
            return error.error.message;
        return String(error);
    }
    function failRecovery(error, point, phase) {
        const wrapped = new Error('replaySubscribe: ' + phase + ' from seq ' + point + ' failed: ' + errorText(error));
        wrapped.cause = error;
        if (!closeSubscription())
            return;
        if (onError) {
            try {
                onError(wrapped);
            }
            catch (caught) {
                setTimeout(function rethrowOnError() { throw caught; }, 0);
            }
        }
        else {
            setTimeout(function rethrowRecoveryError() { throw wrapped; }, 0);
        }
    }
    function liveTap(ev) {
        if (closed)
            return;
        if (ev == null || typeof ev.seq != 'number') {
            failRecovery(new Error('line ended by server (' + String(ev) + ')'), lastDelivered, 'live line');
            return;
        }
        lastArrival = now();
        if (replaying)
            queue.push(ev);
        else
            deliver(ev);
    }
    function attachLiveLine() {
        if (closed)
            return;
        const liveLine = policy == 'frame' && (0, transport_lifecycle_1.rpcMemberMayBeAvailable)(remote, 'frameLine')
            ? remote.frameLine
            : remote.line;
        handle = liveLine.on(liveTap);
        if (closed) {
            unsubscribeHandle(handle);
            handle = null;
            return;
        }
        if (typeof handle?.then == 'function') {
            handle.then(function logicalLineEnded() {
                if (!closed)
                    failRecovery(new Error('logical RPC line ended'), lastDelivered, 'live line');
            }, function logicalLineFailed(error) {
                if (!closed)
                    failRecovery(error, lastDelivered, 'live line');
            });
        }
    }
    const schemaReady = (0, transport_lifecycle_1.getRpcSchemaReady)(remote);
    let lineReady;
    if (schemaReady) {
        try {
            lineReady = Promise.resolve(schemaReady()).then(attachLiveLine);
        }
        catch (error) {
            lineReady = Promise.reject(error);
        }
        lineReady.catch(function deferLineReadyFailureToCatchUp() { });
    }
    else {
        attachLiveLine();
        lineReady = Promise.resolve();
    }
    function isCurrent(generation) {
        return !closed && generation == recoveryGeneration;
    }
    function preparedPoint(value, point) {
        if (value?.since == null)
            return point;
        if (!Number.isSafeInteger(value.since) || value.since < 0) {
            throw new TypeError('catch-up snapshot seq must be a non-negative safe integer');
        }
        if (value.ts != null) {
            if (!Number.isFinite(value.ts) || value.ts < 0) {
                throw new TypeError('catch-up snapshot ts must be a non-negative finite number');
            }
        }
        lastDelivered = value.since;
        if (value.ts != null)
            lastTs = value.ts;
        lastArrival = now();
        if (onSeq) {
            try {
                onSeq(value.since);
            }
            catch (error) {
                setTimeout(function rethrowPreparedOnSeq() { throw error; }, 0);
            }
        }
        return value.since;
    }
    async function catchUp(generation, point, initial, signal) {
        try {
            await lineReady;
            if (!isCurrent(generation))
                return;
            const preparation = await prepareCatchUp?.({ initial, since: point, signal });
            if (!isCurrent(generation))
                return;
            if (preparation?.reset) {
                point = -1;
                lastDelivered = -1;
            }
            point = preparedPoint(preparation, point);
            if (!isCurrent(generation))
                return;
            let done = false;
            if (catchUpMode == 'frame' && point >= 0 && (0, transport_lifecycle_1.rpcMemberMayBeAvailable)(remote, 'frame')) {
                const envelopes = await remote.frame(point, hint);
                if (!isCurrent(generation))
                    return;
                if (envelopes) {
                    deliverSorted(envelopes, initial);
                    done = true;
                }
            }
            if (!done) {
                const tail = point >= 0 ? await remote.since(point) : null;
                if (!isCurrent(generation))
                    return;
                if (tail) {
                    deliverSorted(tail, false);
                }
                else {
                    const recovered = point >= 0
                        ? await recoverGap?.({ initial, since: point, signal })
                        : undefined;
                    if (!isCurrent(generation))
                        return;
                    if (recovered) {
                        point = preparedPoint(recovered, point);
                        if (!isCurrent(generation))
                            return;
                        const recoveredTail = await remote.since(point);
                        if (!isCurrent(generation))
                            return;
                        if (recoveredTail == null) {
                            throw new Error('journal evicted while installing the replacement snapshot');
                        }
                        deliverSorted(recoveredTail, false);
                    }
                    else {
                        if (point >= 0 && gapPolicy == 'error') {
                            throw new Error('journal evicted or unavailable; gap policy forbids keyframe reset');
                        }
                        const keyframe = await remote.keyframe();
                        if (!isCurrent(generation))
                            return;
                        if (keyframe) {
                            if (initial && keyframe.seq <= lastDelivered)
                                lastDelivered = keyframe.seq - 1;
                            deliver(keyframe);
                        }
                        else if (point >= 0) {
                            throw new Error('journal evicted or unavailable; no keyframe can cover the gap');
                        }
                    }
                }
            }
            if (!isCurrent(generation))
                return;
            drainLiveQueue();
            replaying = false;
            assessStale();
            settleReady();
            if (onLive) {
                try {
                    onLive();
                }
                catch (e) {
                    setTimeout(function rethrowOnLive() { throw e; }, 0);
                }
            }
        }
        catch (error) {
            if (!isCurrent(generation))
                return;
            failRecovery(error, point, initial ? 'initial catch-up' : 'reconnect catch-up');
        }
    }
    function startCatchUp(initial) {
        if (closed)
            return;
        replaying = true;
        recoveryAbort?.abort();
        recoveryAbort = new AbortController();
        const generation = ++recoveryGeneration;
        void catchUp(generation, lastDelivered, initial, recoveryAbort.signal);
    }
    if (lifecycle) {
        offDisconnect = lifecycle.onDisconnect(function replayTransportDisconnected() {
            if (closed)
                return;
            replaying = true;
            recoveryGeneration++;
            recoveryAbort?.abort();
            recoveryAbort = undefined;
            queue.length = 0;
        });
        offConnect = lifecycle.onConnect(function replayTransportConnected() {
            startCatchUp(!readySettled);
        });
        offClose = lifecycle.onClose(function replayTransportClosed() {
            closeSubscription();
        });
    }
    if (!lifecycle || lifecycle.connected())
        startCatchUp(true);
    function off() {
        closeSubscription();
    }
    return Object.assign(off, {
        ready,
        seq: () => lastDelivered,
        isStale: () => staleFlag || (staleMs != null && now() - lastArrival >= staleMs),
        lastTs: () => lastTs,
    });
}
