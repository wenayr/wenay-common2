"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exposeReplay = exposeReplay;
exports.replaySubscribe = replaySubscribe;
const replay_conflate_1 = require("./replay-conflate");
const transport_lifecycle_1 = require("./transport-lifecycle");
function exposeReplayPlain(replay) {
    return {
        line: replay.line,
        since: (seq) => replay.getSince(seq) ?? null,
        keyframe: () => replay.keyframe() ?? null,
        frame: (seq, hint) => replay.frame(seq, hint),
    };
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
function replaySubscribe(remote, cb, opts = {}) {
    const { since = -1, onSeq, onError, staleMs, onStale, skewMs = 0, now = Date.now, policy = 'queue', hint } = opts;
    const lifecycle = (0, transport_lifecycle_1.getRpcTransportLifecycle)(remote);
    let lastDelivered = since;
    let replaying = true;
    let closed = false;
    let recoveryGeneration = 0;
    const queue = [];
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
    function deliver(ev) {
        if (closed || ev.seq <= lastDelivered)
            return;
        lastDelivered = ev.seq;
        lastTs = ev.ts;
        lastArrival = now();
        cb(...ev.event);
        onSeq?.(ev.seq);
        if (!replaying)
            assessStale();
    }
    function deliverSorted(events, allowReset) {
        const sorted = [...events].sort((a, b) => a.seq - b.seq);
        if (allowReset && sorted.length && sorted[0].seq <= lastDelivered) {
            lastDelivered = sorted[0].seq - 1;
        }
        for (const event of sorted)
            deliver(event);
    }
    function drainLiveQueue() {
        while (queue.length) {
            const batch = queue.splice(0).sort((a, b) => a.seq - b.seq);
            for (const event of batch)
                deliver(event);
        }
    }
    const frameLineState = (0, transport_lifecycle_1.getRpcMemberState)(remote, 'frameLine');
    const liveLine = policy == 'frame' && frameLineState != false && remote.frameLine ? remote.frameLine : remote.line;
    let handle = null;
    let offConnect = function noConnectListener() { };
    let offDisconnect = function noDisconnectListener() { };
    let offClose = function noCloseListener() { };
    function closeSubscription() {
        if (closed)
            return false;
        closed = true;
        recoveryGeneration++;
        queue.length = 0;
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
    handle = liveLine.on(function liveTap(ev) {
        if (ev == null || typeof ev.seq != 'number') {
            failRecovery(new Error('line ended by server (' + String(ev) + ')'), lastDelivered, 'live line');
            return;
        }
        lastArrival = now();
        if (replaying)
            queue.push(ev);
        else
            deliver(ev);
    });
    if (typeof handle?.then == 'function') {
        handle.then(function logicalLineEnded() {
            if (!closed)
                failRecovery(new Error('logical RPC line ended'), lastDelivered, 'live line');
        }, function logicalLineFailed(error) {
            if (!closed)
                failRecovery(error, lastDelivered, 'live line');
        });
    }
    function isCurrent(generation) {
        return !closed && generation == recoveryGeneration;
    }
    async function catchUp(generation, point, initial) {
        try {
            let done = false;
            const frameState = (0, transport_lifecycle_1.getRpcMemberState)(remote, 'frame');
            if (point >= 0 && frameState != false && remote.frame) {
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
            if (!isCurrent(generation))
                return;
            drainLiveQueue();
            replaying = false;
            assessStale();
            settleReady();
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
        const generation = ++recoveryGeneration;
        void catchUp(generation, lastDelivered, initial);
    }
    if (lifecycle) {
        offDisconnect = lifecycle.onDisconnect(function replayTransportDisconnected() {
            if (closed)
                return;
            replaying = true;
            recoveryGeneration++;
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
