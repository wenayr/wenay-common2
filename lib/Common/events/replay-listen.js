"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IS_REPLAY_LISTEN = void 0;
exports.isReplayListen = isReplayListen;
exports.withReplayListen = withReplayListen;
exports.replayListen = replayListen;
const Listen_1 = require("./Listen");
function createReplayDeliveryControl() {
    let activeErrors = null;
    function capture(error) {
        if (activeErrors) {
            activeErrors.push(error);
            return;
        }
        throw error;
    }
    function during(errors, deliver) {
        const previousErrors = activeErrors;
        activeErrors = errors;
        try {
            return deliver();
        }
        finally {
            activeErrors = previousErrors;
        }
    }
    return { capture, during };
}
exports.IS_REPLAY_LISTEN = Symbol.for('isReplayListen');
function isReplayListen(obj) {
    return !!obj && typeof obj == 'object' && Object.prototype.hasOwnProperty.call(obj, exports.IS_REPLAY_LISTEN);
}
function withReplayListen(base, options = {}) {
    return decorateReplayListen(base, options, createReplayDeliveryControl());
}
function decorateReplayListen(base, options, deliveryControl) {
    const { current: currentOpt, frame: condense, history = 0, keepMs, getSince, onJournal, onJournalBatch, now = Date.now, staleMs, onStale, firstSeq = 0, } = options;
    const ageLimitMs = keepMs != undefined && keepMs > 0 ? keepMs : 0;
    const journalEnabled = history > 0 || ageLimitMs > 0;
    let lastEv;
    const current = currentOpt == 'last' ? () => lastEv?.event : currentOpt;
    let head = firstSeq;
    let entries = [];
    let start = 0;
    let cappedByCount = false;
    let emitting = null;
    const line = (0, Listen_1.createListen)(function noReplayLineProducer() { }, {
        [Listen_1.LISTEN_DISPATCH_ERROR]: deliveryControl.capture,
    });
    line.run();
    function dropOldest() {
        entries[start] = undefined;
        start++;
    }
    function compactJournal() {
        if (start > 64 && start * 2 > entries.length) {
            entries = entries.slice(start);
            start = 0;
        }
    }
    function pruneJournalByAge() {
        if (ageLimitMs == 0 || start >= entries.length)
            return;
        const cutoff = now() - ageLimitMs;
        while (start < entries.length && entries[start].ts < cutoff)
            dropOldest();
        compactJournal();
    }
    function journalSince(seq) {
        if (getSince)
            return getSince(seq);
        if (seq > head)
            return undefined;
        if (seq == head)
            return [];
        pruneJournalByAge();
        if (start >= entries.length)
            return undefined;
        const oldest = Math.max(firstSeq + 1, entries[start].seq);
        if (seq + 1 < oldest)
            return undefined;
        const out = [];
        for (let index = start + (seq + 1 - entries[start].seq); index < entries.length; index++) {
            out.push(entries[index]);
        }
        return out;
    }
    function journalWindow() {
        pruneJournalByAge();
        const retained = entries.length - start;
        return {
            entries: retained,
            oldestSeq: retained > 0 ? entries[start].seq : null,
            head,
            ageMs: retained > 0 ? now() - entries[start].ts : 0,
            historyLimit: history,
            keepMs: ageLimitMs,
            cappedByCount,
        };
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
    const queued = [];
    let publishing = false;
    function commitJournalEvent(ev, deliveryErrors) {
        head = ev.seq;
        if (journalEnabled) {
            entries.push(ev);
            pruneJournalByAge();
            if (history > 0) {
                while (entries.length - start > history) {
                    dropOldest();
                    cappedByCount = true;
                }
                compactJournal();
            }
        }
        if (currentOpt == 'last')
            lastEv = ev;
        touchStale(ev.ts);
        deliveryControl.during(deliveryErrors, function deliverCommittedEvent() {
            const prev = emitting;
            emitting = ev;
            try {
                try {
                    line.emit(ev);
                }
                catch (error) {
                    deliveryErrors.push(error);
                }
                try {
                    base.emit(...ev.event);
                }
                catch (error) {
                    deliveryErrors.push(error);
                }
            }
            finally {
                emitting = prev;
            }
        });
    }
    function publishJournalBatch(events, deliveryErrors) {
        if (onJournalBatch) {
            const staged = events.map(function stageJournalEvent(event, index) {
                return { seq: head + index + 1, ts: now(), event };
            });
            for (const ev of staged)
                onJournal?.(ev);
            onJournalBatch(staged);
            for (const ev of staged)
                commitJournalEvent(ev, deliveryErrors);
            return;
        }
        for (const event of events) {
            const ev = { seq: head + 1, ts: now(), event };
            onJournal?.(ev);
            commitJournalEvent(ev, deliveryErrors);
        }
    }
    function deferDeliveryErrors(errors) {
        if (errors.length == 0)
            return;
        const error = errors.length == 1 ? errors[0] : new AggregateError(errors, 'Multiple replay listeners failed');
        setTimeout(function rethrowReplayDeliveryError() { throw error; }, 0);
    }
    function emitBatchJournaled(events) {
        if (events.length == 0)
            return;
        const owned = events.map(event => [...event]);
        if (publishing) {
            queued.push(owned);
            return;
        }
        publishing = true;
        const deliveryErrors = [];
        let publicationError = null;
        try {
            let next = owned;
            while (next) {
                publishJournalBatch(next, deliveryErrors);
                next = queued.shift();
            }
        }
        catch (error) {
            queued.length = 0;
            publicationError = error;
        }
        finally {
            publishing = false;
        }
        deferDeliveryErrors(deliveryErrors);
        if (publicationError != null)
            throw publicationError;
    }
    const api = {
        ...base,
        emit: function emitJournaled(...e) {
            emitBatchJournaled([e]);
        },
        emitBatch: emitBatchJournaled,
        head: () => head,
        isStale: () => staleMs != null && head > 0 && now() - lastTs >= staleMs,
        lastTs: () => lastTs,
        close: function closeReplay() {
            stopStaleTimer();
            line.close();
            base.close();
        },
        getSince: journalSince,
        journalWindow,
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
    const { current, frame, history, keepMs, getSince, onJournal, onJournalBatch, now, staleMs, onStale, firstSeq, ...listenOptions } = options;
    let t;
    const deliveryControl = createReplayDeliveryControl();
    const base = (0, Listen_1.createListen)(function captureReplayEmit(e) { t = e; }, {
        fast: true,
        ...listenOptions,
        [Listen_1.LISTEN_DISPATCH_ERROR]: deliveryControl.capture,
    });
    const listen = decorateReplayListen(base, {
        current, frame, history, keepMs, getSince, onJournal, onJournalBatch, now, staleMs, onStale, firstSeq,
    }, deliveryControl);
    base.run();
    t = listen.emit;
    return [t, listen];
}
