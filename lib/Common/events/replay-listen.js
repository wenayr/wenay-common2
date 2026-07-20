"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IS_REPLAY_LISTEN = void 0;
exports.isReplayListen = isReplayListen;
exports.withReplayListen = withReplayListen;
exports.replayListen = replayListen;
const Listen_1 = require("./Listen");
exports.IS_REPLAY_LISTEN = Symbol.for('isReplayListen');
function isReplayListen(obj) {
    return !!obj && typeof obj == 'object' && Object.prototype.hasOwnProperty.call(obj, exports.IS_REPLAY_LISTEN);
}
function withReplayListen(base, options = {}) {
    const { current: currentOpt, frame: condense, history = 0, getSince, onJournal, now = Date.now, staleMs, onStale, firstSeq = 0 } = options;
    let lastEv;
    const current = currentOpt == 'last' ? () => lastEv?.event : currentOpt;
    let head = firstSeq;
    const ring = [];
    let emitting = null;
    const line = (0, Listen_1.createListen)(() => { });
    line.run();
    function journalSince(seq) {
        if (getSince)
            return getSince(seq);
        if (seq > head)
            return undefined;
        if (seq == head)
            return [];
        const oldest = Math.max(firstSeq + 1, head - history + 1);
        if (seq + 1 < oldest)
            return undefined;
        const out = [];
        for (let s = seq + 1; s <= head; s++)
            out.push(ring[(s - 1) % history]);
        return out;
    }
    function currentValue(c) {
        if (typeof c == 'function')
            return c();
        return c ? current?.() : undefined;
    }
    let lastTs = 0;
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
        try {
            onStale({ stale, lastTs, age: now() - lastTs });
        }
        catch (e) {
            setTimeout(function rethrowOnStale() { throw e; }, 0);
        }
    }
    function checkStale() {
        staleTimer = null;
        const age = now() - lastTs;
        if (age >= staleMs)
            reportStale(true);
        else
            armStaleTimer(staleMs - age);
    }
    function armStaleTimer(delay) {
        if (staleTimer || !onStale || staleMs == null)
            return;
        staleTimer = setTimeout(checkStale, delay);
        staleTimer.unref?.();
    }
    function touchStale(ts) {
        lastTs = ts;
        if (staleFlag)
            reportStale(false);
        armStaleTimer(staleMs);
    }
    const api = {
        ...base,
        emit: function emitJournaled(...e) {
            const ev = { seq: ++head, ts: now(), event: e };
            if (history > 0)
                ring[(ev.seq - 1) % history] = ev;
            if (currentOpt == 'last')
                lastEv = ev;
            onJournal?.(ev);
            touchStale(ev.ts);
            line.emit(ev);
            const prev = emitting;
            emitting = ev;
            try {
                base.emit(...e);
            }
            finally {
                emitting = prev;
            }
        },
        head: () => head,
        isStale: () => staleMs != null && head > 0 && now() - lastTs >= staleMs,
        lastTs: () => lastTs,
        close: function closeReplay() { stopStaleTimer(); base.close(); },
        getSince: journalSince,
        line,
        hasKeyframe: current != null,
        keyframe: () => {
            const m = current?.();
            return m ? { seq: head, ts: now(), event: m } : undefined;
        },
        frame: function frameSince(sinceSeq, hint) {
            const tail = journalSince(sinceSeq);
            if (tail)
                return condense ? condense(tail, hint) : tail;
            const m = current?.();
            if (m)
                return [{ seq: head, ts: now(), event: m }];
            throw new Error(`replay frame(${sinceSeq}): journal evicted and no keyframe (sacred line)`);
        },
        on: ((cb, { cbClose, key, current: cur, since, onSeq } = {}) => {
            if (since == null) {
                const off = base.on(cb, { cbClose, key });
                if (cur) {
                    const m = currentValue(cur);
                    if (m)
                        cb(...m);
                }
                return off;
            }
            let lastDelivered = since;
            let replaying = true;
            const queue = [];
            function deliver(ev) {
                if (ev.seq <= lastDelivered)
                    return;
                lastDelivered = ev.seq;
                cb(...ev.event);
                onSeq?.(ev.seq);
            }
            const off = base.on(function liveTap(...e) {
                const ev = emitting;
                if (ev == null) {
                    cb(...e);
                    return;
                }
                if (replaying)
                    queue.push(ev);
                else
                    deliver(ev);
            }, { cbClose, key });
            const tail = journalSince(since);
            if (tail) {
                for (const ev of tail)
                    deliver(ev);
            }
            else {
                const m = current?.();
                lastDelivered = head;
                if (m) {
                    cb(...m);
                    onSeq?.(head);
                }
            }
            while (queue.length)
                deliver(queue.shift());
            replaying = false;
            return off;
        }),
        once: (cb, opts = {}) => {
            if (opts.current) {
                const m = currentValue(opts.current);
                if (m) {
                    cb(...m);
                    return () => { };
                }
            }
            let off = () => { };
            off = base.on(((...e) => { off(); cb(...e); }), { key: opts.key });
            return off;
        },
    };
    Object.defineProperty(api, exports.IS_REPLAY_LISTEN, { value: true });
    (0, Listen_1.registerListenOn)(api.on, api);
    return api;
}
function replayListen(options = {}) {
    const { current, frame, history, getSince, onJournal, now, staleMs, onStale, firstSeq, ...listenOptions } = options;
    let t;
    const base = (0, Listen_1.createListen)((e) => { t = e; }, { fast: true, ...listenOptions });
    const listen = withReplayListen(base, { current, frame, history, getSince, onJournal, now, staleMs, onStale, firstSeq });
    base.run();
    t = listen.emit;
    return [t, listen];
}
