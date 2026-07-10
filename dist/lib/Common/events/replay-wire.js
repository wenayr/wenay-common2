"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exposeReplay = exposeReplay;
exports.replaySubscribe = replaySubscribe;
const replay_conflate_1 = require("./replay-conflate");
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
    let lastDelivered = since;
    let replaying = true;
    let closed = false;
    const queue = [];
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
    const liveLine = policy == 'frame' && remote.frameLine ? remote.frameLine : remote.line;
    const handle = liveLine.on(function liveTap(ev) {
        if (ev == null || typeof ev.seq != 'number') {
            if (closed)
                return;
            const err = new Error('replaySubscribe: line ended by server (' + String(ev) + ')');
            off();
            if (onError)
                onError(err);
            else
                setTimeout(function rethrowLineEnd() { throw err; }, 0);
            return;
        }
        lastArrival = now();
        if (replaying)
            queue.push(ev);
        else
            deliver(ev);
    });
    async function catchUp() {
        try {
            let done = false;
            if (since >= 0 && remote.frame) {
                const envs = await remote.frame(since, hint);
                if (closed)
                    return;
                if (envs) {
                    if (envs.length) {
                        lastDelivered = envs[0].seq - 1;
                        for (const ev of envs)
                            deliver(ev);
                    }
                    done = true;
                }
            }
            if (!done) {
                const tail = since >= 0 ? await remote.since(since) : null;
                if (closed)
                    return;
                if (tail) {
                    for (const ev of tail)
                        deliver(ev);
                }
                else {
                    const kf = await remote.keyframe();
                    if (closed)
                        return;
                    if (kf) {
                        lastDelivered = kf.seq;
                        lastTs = kf.ts;
                        lastArrival = now();
                        cb(...kf.event);
                        onSeq?.(kf.seq);
                    }
                }
            }
        }
        catch (e) {
            if (onError)
                onError(e);
            else
                setTimeout(function rethrowCatchUp() { throw e; }, 0);
        }
        finally {
            while (queue.length)
                deliver(queue.shift());
            replaying = false;
            assessStale();
        }
    }
    const ready = catchUp();
    function off() {
        if (closed)
            return;
        closed = true;
        stopStaleTimer();
        unsubscribeHandle(handle);
    }
    return Object.assign(off, {
        ready,
        seq: () => lastDelivered,
        isStale: () => staleFlag || (staleMs != null && now() - lastArrival >= staleMs),
        lastTs: () => lastTs,
    });
}
