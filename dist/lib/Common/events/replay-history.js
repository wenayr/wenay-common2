"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMemoryReplayStorage = createMemoryReplayStorage;
exports.archiveReplay = archiveReplay;
exports.openHistory = openHistory;
function upperBy(arr, k, v) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (k(arr[mid]) <= v)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
const bySeq = (e) => e.seq;
const byTs = (e) => e.ts;
function createMemoryReplayStorage(opts = {}) {
    const { maxEvents, maxKeyframes } = opts;
    const events = [];
    const keyframes = [];
    return {
        putEvent: (ev) => {
            events.push(ev);
            if (maxEvents && events.length > maxEvents)
                events.shift();
        },
        putKeyframe: (kf) => {
            keyframes.push(kf);
            if (maxKeyframes && keyframes.length > maxKeyframes)
                keyframes.shift();
        },
        getKeyframe: (at = {}) => {
            const end = at.ts != null ? upperBy(keyframes, byTs, at.ts) : upperBy(keyframes, bySeq, at.seq ?? Infinity);
            return keyframes[end - 1];
        },
        getEvents: (from, to) => events.slice(upperBy(events, bySeq, from), upperBy(events, bySeq, to)),
        size: () => ({ events: events.length, keyframes: keyframes.length }),
    };
}
function archiveReplay(replay, opts) {
    const { storage, everyEvents = 64, everyMs } = opts;
    if (!replay.hasKeyframe)
        throw new TypeError('archiveReplay: нужен current-провайдер (keyframe)');
    let events = 0;
    let keyframes = 0;
    let lastKfSeq = 0;
    let lastKfTs = 0;
    function takeKeyframe() {
        const kf = replay.keyframe();
        if (!kf)
            return;
        storage.putKeyframe(kf);
        keyframes++;
        lastKfSeq = kf.seq;
        lastKfTs = kf.ts;
    }
    takeKeyframe();
    const offLine = replay.line.on(function archiveLineEvent(ev) {
        storage.putEvent(ev);
        events++;
        const due = ev.seq - lastKfSeq >= everyEvents || (everyMs != null && ev.ts - lastKfTs >= everyMs);
        if (due)
            takeKeyframe();
    });
    return {
        close: () => offLine(),
        stats: () => ({ events, keyframes }),
    };
}
function openHistory(storage, live) {
    function at(where = {}) {
        const kf = storage.getKeyframe(where);
        if (!kf)
            return undefined;
        let tail = storage.getEvents(kf.seq, where.seq ?? Infinity);
        if (where.ts != null) {
            const cut = tail.findIndex(ev => ev.ts > where.ts);
            if (cut >= 0)
                tail = tail.slice(0, cut);
        }
        return [kf, ...tail];
    }
    function subscribe(cb, opts = {}) {
        const { since, ts, onSeq } = opts;
        let last = since ?? 0;
        function deliver(ev) {
            if (ev.seq <= last)
                return;
            last = ev.seq;
            cb(...ev.event);
            onSeq?.(ev.seq);
        }
        function deliverFromKeyframe(envs) {
            if (!envs)
                return;
            last = envs[0].seq - 1;
            for (const ev of envs)
                deliver(ev);
        }
        if (since != null) {
            const tail = storage.getEvents(since, Infinity);
            if (tail.length && tail[0].seq != since + 1)
                deliverFromKeyframe(at({}));
            else
                for (const ev of tail)
                    deliver(ev);
        }
        else {
            deliverFromKeyframe(at(ts != null ? { ts } : {}));
        }
        let offLive = null;
        if (live)
            offLive = live.on(cb, { since: last, onSeq: function trackSeq(s) { last = s; onSeq?.(s); } });
        function off() { offLive?.(); }
        return Object.assign(off, {
            seq: () => last,
        });
    }
    return { at, subscribe };
}
