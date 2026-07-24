// =====================================================================
// Archive replay-line — periodic keyframes + events, seek and playback
// =====================================================================
// Memory FULLY outside: storage — four lambdas (file/DB/anything),
// decorator owns no data. System rule is the same:
//     keyframe(S) + events S+1…K = exact state at K.
// Archiver — another subscriber to the line; keyframe cadence — GOP compromise:
// more frequent frames = fast seek / more space, less frequent = cheaper / longer replay.
// Keyframe is written ONLY ON an event (in silence state doesn't change — frame
// adds nothing), so no timers at all.
// History reader — SAME subscriber interface: {since|ts} → replay archive →
// catch-up on live journal → live. One mechanism for playback and live.
// For SEAMLESS playback→live, the live journal's past must also be in the archive:
// create the line with getSince reading the same storage ("memory outside"), —
// otherwise the gap archive→live closes with a fresh keyframe (killer property, jump).

import {Listener, NormalizeTuple} from './Listen'
import {ListenOnReplay, ListenReplayApi, ReplayEvent} from './replay-listen'

// =====================================================================
// Storage: lambda interface + reference memory implementation
// =====================================================================

export type ReplayStorage<Z extends any[] = any[]> = {
    /** Write a line event (called on each numbered emit). */
    putEvent: (ev: ReplayEvent<Z>) => void
    /** Optional atomic bulk write: persist every event or throw without exposing a partial prefix. */
    putEvents?: (events: readonly ReplayEvent<Z>[]) => void
    /** Write a keyframe (state at kf.seq — event of the same type). */
    putKeyframe: (kf: ReplayEvent<Z>) => void
    /** Nearest keyframe with seq <= at.seq (or ts <= at.ts). Without at — the latest. undefined = none. */
    getKeyframe: (at?: {seq?: number, ts?: number}) => ReplayEvent<Z> | undefined
    /** Events with from < seq <= to, in seq order. */
    getEvents: (from: number, to: number) => ReplayEvent<Z>[]
}

// first index where field k of element > v (array is sorted by k)
function upperBy<E>(arr: E[], k: (e: E) => number, v: number) {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (k(arr[mid]) <= v) lo = mid + 1
        else hi = mid
    }
    return lo
}
const bySeq = (e: ReplayEvent) => e.seq
const byTs = (e: ReplayEvent) => e.ts

// Bounded archives are hot append-only logs. Keeping the logical head in a
// closure avoids Array.shift() moves and capacity-dependent array modes while
// retaining the same sorted binary-search contract.
function createMemoryReplayLog<E>(limit?: number) {
    const capacity = !limit || limit == Infinity
        ? null
        : !Number.isFinite(limit) || limit < 1
            ? 0
            : Math.floor(limit)
    const values: E[] = []
    let start = 0
    let length = 0

    function at(index: number) {
        return capacity == null ? values[index] : values[(start + index) % capacity]
    }

    function append(value: E) {
        if (capacity == null) {
            values.push(value)
            length++
            return
        }
        if (capacity == 0) return
        if (length < capacity) {
            values[(start + length) % capacity] = value
            length++
            return
        }
        values[start] = value
        start = (start + 1) % capacity
    }

    function upper(k: (value: E) => number, value: number) {
        if (capacity == null) return upperBy(values, k, value)
        let lo = 0
        let hi = length
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (k(at(mid)) <= value) lo = mid + 1
            else hi = mid
        }
        return lo
    }

    function between(k: (value: E) => number, from: number, to: number) {
        const begin = upper(k, from)
        const end = upper(k, to)
        if (capacity == null) return values.slice(begin, end)
        const out: E[] = []
        for (let index = begin; index < end; index++) out.push(at(index))
        return out
    }

    function latest(k: (value: E) => number, value: number) {
        return at(upper(k, value) - 1)
    }

    return {append, between, latest, size: () => length}
}

/**
 * Reference memory storage (and oracle for file/DB implementations).
 * maxEvents/maxKeyframes — evict oldest: models a bounded archive.
 */
export function createMemoryReplayStorage<Z extends any[] = any[]>(opts: {maxEvents?: number, maxKeyframes?: number} = {}) {
    const {maxEvents, maxKeyframes} = opts
    // written strictly in ascending seq order → arrays are always sorted
    const events = createMemoryReplayLog<ReplayEvent<Z>>(maxEvents)
    const keyframes = createMemoryReplayLog<ReplayEvent<Z>>(maxKeyframes)
    function putEvent(ev: ReplayEvent<Z>) {
        events.append(ev)
    }
    function putEvents(batch: readonly ReplayEvent<Z>[]) {
        for (const ev of batch) putEvent(ev)
    }
    return {
        putEvent,
        putEvents,
        putKeyframe: (kf: ReplayEvent<Z>) => {
            keyframes.append(kf)
        },
        getKeyframe: (at: {seq?: number, ts?: number} = {}) => {
            return at.ts != null
                ? keyframes.latest(byTs, at.ts)
                : keyframes.latest(bySeq, at.seq ?? Infinity)
        },
        getEvents: (from: number, to: number) => events.between(bySeq, from, to),
        /** Introspection for metrics/tests. */
        size: () => ({events: events.size(), keyframes: keyframes.size()}),
    }
}

// =====================================================================
// Archiver: write side (events + keyframe cadence)
// =====================================================================

export type ArchiveReplayOpts<Z extends any[]> = {
    storage: ReplayStorage<Z>
    /** Keyframe every N events (default 64). */
    everyEvents?: number
    /** …or every T ms on ts line — whichever comes first (default off). */
    everyMs?: number
}

export function archiveReplay<T>(replay: ListenReplayApi<T>, opts: ArchiveReplayOpts<NormalizeTuple<T>>) {
    type Z = NormalizeTuple<T>
    const {storage, everyEvents = 64, everyMs} = opts
    // without current-provider, archive is not reproducible (no keyframe anchors) — fail loudly
    if (!replay.hasKeyframe) throw new TypeError('archiveReplay: нужен current-провайдер (keyframe)')

    let events = 0
    let keyframes = 0
    let lastKfSeq = 0
    let lastKfTs = 0
    function takeKeyframe() {
        const kf = replay.keyframe()
        if (!kf) return
        storage.putKeyframe(kf as ReplayEvent<Z>)
        keyframes++
        lastKfSeq = kf.seq
        lastKfTs = kf.ts
    }
    // baseline keyframe immediately: events before the first cadence keyframe need a base
    takeKeyframe()
    const offLine = replay.line.on(function archiveLineEvent(ev: ReplayEvent<Z>) {
        storage.putEvent(ev)
        events++
        const due = ev.seq - lastKfSeq >= everyEvents || (everyMs != null && ev.ts - lastKfTs >= everyMs)
        // keyframe() reads state at head — THIS event is already included
        if (due) takeKeyframe()
    })
    return {
        close: () => offLine(),
        /** Introspection for metrics/tests. */
        stats: () => ({events, keyframes}),
    }
}

// =====================================================================
// Reader: seek by seq/ts + playback via same subscriber interface
// =====================================================================

export type HistorySubscribeOpts = {
    /** "I have seq K" → archive tail; gap in archive → keyframe (reset downward is allowed). */
    since?: number
    /** Seek by time: state at ts (keyframe <= ts + deltas to ts), then forward. */
    ts?: number
    /** Report seq for each delivery — reconnection point. */
    onSeq?: (seq: number) => void
}

/**
 * History reader. live not set — pure playback (ends at archive boundary);
 * set — after archive, same catch-up on live journal and live
 * (two-stage handover: archive → journal line → live).
 */
export function openHistory<Z extends any[]>(storage: ReplayStorage<Z>, live?: {on: ListenOnReplay<Z>}) {
    /** Envelopes restoring state at location at: [keyframe, …deltas]. undefined = archive empty. */
    function at(where: {seq?: number, ts?: number} = {}) {
        const kf = storage.getKeyframe(where)
        if (!kf) return undefined
        let tail = storage.getEvents(kf.seq, where.seq ?? Infinity)
        if (where.ts != null) {
            // ts along the line is monotone → cut everything after the sought moment
            const cut = tail.findIndex(ev => ev.ts > where.ts!)
            if (cut >= 0) tail = tail.slice(0, cut)
        }
        return [kf, ...tail]
    }

    function subscribe(cb: Listener<Z>, opts: HistorySubscribeOpts = {}) {
        const {since, ts, onSeq} = opts
        let last = since ?? 0
        function deliver(ev: ReplayEvent<Z>) {
            if (ev.seq <= last) return
            last = ev.seq
            cb(...ev.event)
            onSeq?.(ev.seq)
        }
        function deliverFromKeyframe(envs: ReplayEvent<Z>[] | undefined) {
            if (!envs) return
            // fresh reference point: reset DOWN is allowed (kf may be older than since) —
            // redundant but consistent deliveries are better than a gap in state
            last = envs[0].seq - 1
            for (const ev of envs) deliver(ev)
        }
        // === archive part: clean tail from since or keyframe + deltas ===
        if (since != null) {
            const tail = storage.getEvents(since, Infinity)
            if (tail.length && tail[0].seq != since + 1) deliverFromKeyframe(at({}))
            else for (const ev of tail) deliver(ev)
        } else {
            deliverFromKeyframe(at(ts != null ? {ts} : {}))
        }
        // === live catch-up: journal line closes the gap archive→now, then live ===
        let offLive: (() => void) | null = null
        if (live) offLive = live.on(cb, {since: last, onSeq: function trackSeq(s: number) { last = s; onSeq?.(s) }})
        function off() { offLive?.() }
        return Object.assign(off, {
            /** Last delivered seq — reconnection point. */
            seq: () => last,
        })
    }

    return {at, subscribe}
}
