// =====================================================================
// withReplayListen — keyframe (snapshot) + numbered delta line
// =====================================================================
// Decorator over ListenApi in the form of withStoreListen. One pattern for
// everything: keyframe + events S+1…K = exact state at K (I/P-frames, WAL,
// market data). Public reference: doc/wenay-common2*.md; oracles: replay/.
//
// Invariants:
// - seq — coordinate, time — attribute: each journal event = {seq, ts, event}.
// - Lagging subscriber NEVER receives backlog queue: journal evicted →
//   fresh keyframe + live from it. This is both catch-up and backpressure.
// - Memory external by choice: journal is either internal ring (history: N),
//   or external lambdas (getSince + onJournal) — decorator does not own the data.
// - Keyframe — event of THE SAME type (complete state as one event) —
//   therefore current-provider of the store-layer is reused as-is.
//
// IMPORTANT: only events emitted through the DECORATED
// emit (it numbers them). replayListen provides the correct emit itself.

import {
    createListen, LISTEN_DISPATCH_ERROR, registerListenOn,
    Listener, ListenApi, ListenCurrent, ListenCurrentProvider, ListenOnBrand, ListenOptions, NormalizeTuple,
} from './Listen'
import {jsonUtf8ByteLength} from '../wire-size'

type key = string | symbol
type cbClose = () => void

function createReplayDeliveryControl() {
    let activeErrors: any[] | null = null

    function capture(error: unknown) {
        if (activeErrors) {
            activeErrors.push(error)
            return
        }
        throw error
    }

    function during<T>(errors: any[], deliver: () => T) {
        const previousErrors = activeErrors
        activeErrors = errors
        try { return deliver() }
        finally { activeErrors = previousErrors }
    }

    return {capture, during}
}

type ReplayDeliveryControl = ReturnType<typeof createReplayDeliveryControl>

// Brand of replay-line (Symbol.for — survives module duplicates src/dist). Needed for the wire:
// replay-api structurally passes isListenCallback, therefore auto-detection in rpc-server-auto
// must check the brand, not the shape. Read via hasOwnProperty (rpc-guard convention).
export const IS_REPLAY_LISTEN = Symbol.for('isReplayListen')
/** Whether the value is a replay-line (brand, not structural sniff). */
export function isReplayListen(obj: any): obj is ListenReplayApi<any> {
    return !!obj && typeof obj == 'object' && Object.prototype.hasOwnProperty.call(obj, IS_REPLAY_LISTEN)
}

/** Journal unit: seq — monotonic coordinate, ts — attribute for humans. */
export type ReplayEvent<Z extends any[] = any[]> = { seq: number, ts: number, event: Z }

/** Staleness watchdog report: stale — new state (edge), lastTs — ts of last event, age — its age. */
export type StaleInfo = {stale: boolean, lastTs: number, age: number}

export type ReplayListenOptions<Z extends any[]> = {
    /**
     * Keyframe provider (complete state as event of the same type). Needed for fallback and {current}.
     * `'last'` — sugar for single-entity lines: keyframe = last journal event
     * (last tick is the complete state); producer does not store it manually.
     */
    current?: ListenCurrentProvider<Z> | 'last'
    /**
     * Frame compactor (accumulation mini-frame): receives exact journal tail after seq,
     * returns state-equivalent compact (last-per-entity, aggregate holes, etc.).
     * Only the producer knows event semantics — transport doesn't see these lambdas.
     * hint — end-to-end opaque from subscriber (arbitrary skip rules), wire doesn't look inside.
     */
    frame?: (tail: ReplayEvent<Z>[], hint?: unknown) => ReplayEvent<Z>[]
    /** Internal journal: hard cap of retained events. 0 = no internal journal. */
    history?: number
    /**
     * Internal journal retention target in milliseconds: an entry older than this is
     * evicted even while the count cap still allows it. Set it when the meaningful
     * unit is "a reconnect within N seconds must cost a tail, not a keyframe" —
     * an envelope count cannot express that, because its depth in wall-clock time
     * depends entirely on the write rate.
     *
     * `history` remains the hard cap and wins: with both set the window is whichever
     * bites first, so a burst cannot grow the journal without bound. With only
     * `keepMs` set the count is unbounded and memory is rate x keepMs — deliberate,
     * and the reason `journalWindow()` reports the window actually retained.
     */
    keepMs?: number
    /**
     * Internal journal retention target in bytes: oldest entries are evicted while
     * the retained total exceeds it. Set it when the meaningful unit is memory —
     * `history` counts envelopes and `keepMs` counts time, but a legal window under
     * both can still retain many LARGE events, and only a byte bound caps that
     * directly. All three bounds coexist; whichever bites first wins, with
     * `history` remaining the hard count cap.
     *
     * The newest entry is never evicted: a single event larger than the whole
     * budget keeps a window of exactly that event, reported honestly by
     * `journalWindow().bytes`. Unset = nothing is measured and `bytes` reads 0 —
     * existing lines pay nothing.
     */
    keepBytes?: number
    /**
     * Event measure for `keepBytes`: called ONCE per event at ingest and cached for
     * the entry's lifetime. Without it a conservative default is used — the UTF-8
     * length of the JSON of the event tuple (an unmeasurable event, e.g. circular,
     * prices at a fixed conservative cost). Never called while `keepBytes` is
     * unset.
     */
    sizeOf?: (event: ReplayEvent<Z>) => number
    /**
     * External journal (memory outside — preferred): events with seq > specified,
     * in order. undefined = evicted (seq too old) → fallback to keyframe.
     * Takes priority over history.
     */
    getSince?: (seq: number) => ReplayEvent<Z>[] | undefined
    /** Hook for writing to external journal: called on each numbered emit. */
    onJournal?: (ev: ReplayEvent<Z>) => void
    /** Atomic bulk precommit. Persist the whole batch or throw before publication. */
    onJournalBatch?: (events: readonly ReplayEvent<Z>[]) => void
    /** Clock for ts (default Date.now) — substitutable in tests/on external clock. */
    now?: () => number
    /**
     * Initial head: seq of the last event of a PREVIOUS lifetime (restored durable line).
     * Numbering continues from firstSeq+1; catch-up at/below firstSeq is served by
     * getSince (external journal) or falls back to keyframe — the internal ring never
     * pretends to know pre-firstSeq history.
     */
    firstSeq?: number
    /**
     * Staleness threshold: no journal event longer than staleMs → line is stale.
     * Does not create a timer by itself — isStale() is computed lazily.
     */
    staleMs?: number
    /**
     * Staleness watchdog: edge-triggered in BOTH directions (fresh→stale and stale→fresh),
     * non-repeating alarm. Timer exists only when onStale is set
     * and is armed after the first event — cold line is free. Requires staleMs.
     */
    onStale?: (info: StaleInfo) => void
}

type ReplayOnOptions<Z extends any[]> = {
    cbClose?: cbClose
    key?: key
    /** Store-layer as it was: keyframe + live. */
    current?: ListenCurrent<Z>
    /** Catch-up: "I have seq K" → replay journal from K+1, seamless transition to live. */
    since?: number
    /** Report seq of each delivered event — so consumer can reconnect via since. */
    onSeq?: (seq: number) => void
}

export type ListenOnReplay<Z extends any[] = any[]> =
    ((cb: Listener<Z>, opts?: ReplayOnOptions<Z>) => (() => void)) & ListenOnBrand<Z>

// Fixed price for an event no measure can size (circular JSON, throwing sizeOf).
// Over-counting is the safe direction for a budget: an under-count would let
// unmeasurable events accumulate past the target unnoticed.
const UNMEASURED_EVENT_BYTES = 1024
/** Default `keepBytes` measure: UTF-8 length of the JSON of the event tuple.
 *  wire-size counts bytes on Node's allocation-free fast path (encoding a
 *  throwaway Uint8Array per journaled event is exactly the waste a byte budget
 *  exists to avoid) and prices unserializable values at Infinity, which the
 *  isFinite guard below maps to the fixed cost. */
function estimateEventJsonBytes(ev: ReplayEvent<any>) {
    return jsonUtf8ByteLength(ev.event)
}

export function withReplayListen<T>(base: ListenApi<T>, options: ReplayListenOptions<NormalizeTuple<T>> = {}) {
    return decorateReplayListen(base, options, createReplayDeliveryControl())
}

function decorateReplayListen<T>(
    base: ListenApi<T>, options: ReplayListenOptions<NormalizeTuple<T>>, deliveryControl: ReplayDeliveryControl,
) {
    type Z = NormalizeTuple<T>
    const {
        current: currentOpt, frame: condense, history = 0, keepMs, keepBytes, sizeOf, getSince, onJournal, onJournalBatch,
        now = Date.now, staleMs, onStale, firstSeq = 0,
    } = options
    const ageLimitMs = keepMs != undefined && keepMs > 0 ? keepMs : 0
    const byteLimit = keepBytes != undefined && keepBytes > 0 ? keepBytes : 0
    // The journal exists when any bound asks for it. `history` alone is the
    // historical behaviour; `keepMs`/`keepBytes` alone are time-/byte-only windows.
    const journalEnabled = history > 0 || ageLimitMs > 0 || byteLimit > 0
    // 'last' — keyframe from last journal event: single-entity line,
    // last tick = complete state. lastEv is written in the numbering emit below.
    let lastEv: ReplayEvent<Z> | undefined
    const current: ListenCurrentProvider<Z> | undefined =
        currentOpt == 'last' ? () => lastEv?.event : currentOpt

    // === journal ===
    let head = firstSeq
    // Entries in seq order. A fixed-modulo ring cannot evict by age, so retention
    // is a head/tail window: `entries[start]` is the oldest retained event.
    //
    // An evicted slot is nulled IMMEDIATELY rather than waiting for compaction. The
    // fixed-modulo ring it replaced overwrote each slot in place and therefore held
    // exactly `history` event graphs; a head/tail window that only drops references at
    // compaction time holds the consumed prefix as well, which measured up to 5x the
    // configured window on a busy line. Slots below `start` are always undefined.
    let entries: (ReplayEvent<Z> | undefined)[] = []
    let start = 0
    // Count cap bit the window before the age target could — reported, never silent.
    let cappedByCount = false
    // Byte budget bit the window before the age target could — same honesty.
    let cappedByBytes = false
    // Byte budget bookkeeping. sizes[i] is the cached measure of entries[i] — a
    // parallel array instead of a wrapper record, so the hot path allocates no
    // per-event object. All of it stays untouched while keepBytes is unset:
    // nothing is measured and retainedBytes reads 0.
    let sizes: number[] = []
    let retainedBytes = 0
    const measure = sizeOf ?? estimateEventJsonBytes
    // sizeOf is producer code and this runs AFTER persistence succeeded: a throw
    // here must not become a publication error, so any failure — and any value a
    // budget cannot subtract back (NaN, negative) — prices at the fixed cost.
    function measureEventBytes(ev: ReplayEvent<Z>) {
        let size: number
        try { size = measure(ev) }
        catch { return UNMEASURED_EVENT_BYTES }
        return Number.isFinite(size) && size >= 0 ? size : UNMEASURED_EVENT_BYTES
    }
    // current sync fan-out event: subscriber's liveTap learns seq without
    // envelope-protocol. save/restore → survives re-entrant emit.
    let emitting: ReplayEvent<Z> | null = null
    // line of envelopes {seq, ts, event} — normal Listen: wire proxies it as-is
    const line = createListen<[ReplayEvent<Z>]>(function noReplayLineProducer() {}, {
        [LISTEN_DISPATCH_ERROR]: deliveryControl.capture,
    })
    line.run()

    /** Release the event AND advance past it, so no evicted graph stays reachable. */
    function dropOldest() {
        if (byteLimit > 0) {
            retainedBytes -= sizes[start]
            sizes[start] = 0
        }
        entries[start] = undefined
        start++
    }

    // Reclaim the empty prefix once it dominates. Only array slots are reclaimed here —
    // the events themselves were released at eviction — so the bound is on slot count,
    // not on retained heap.
    function compactJournal() {
        if (start > 64 && start * 2 > entries.length) {
            entries = entries.slice(start)
            if (byteLimit > 0) sizes = sizes.slice(start)
            start = 0
        }
    }

    // Age and byte eviction are lazy: applied on write and before every read, so a
    // quiet line frees memory without owning a timer.
    function pruneJournal() {
        if (start >= entries.length) return
        if (ageLimitMs > 0) {
            const cutoff = now() - ageLimitMs
            while (start < entries.length && entries[start]!.ts < cutoff) dropOldest()
        }
        // Byte target AFTER the age window, so an entry evicted here is one the age
        // target would have kept — exactly what cappedByBytes reports. The newest
        // entry never goes: one oversized event retains a window of itself.
        while (byteLimit > 0 && entries.length - start > 1 && retainedBytes > byteLimit) {
            dropOldest()
            cappedByBytes = true
        }
        compactJournal()
    }

    function journalSince(seq: number) {
        if (getSince) return getSince(seq)
        // seq from the future (another server lifetime) — don't trust journal, keyframe only
        if (seq > head) return undefined
        // Already at the head: nothing to replay, and no journal is needed to say so.
        // This must stay ahead of the retention check, or a line quiet for longer
        // than keepMs would answer an up-to-date consumer with a keyframe.
        if (seq == head) return [] as ReplayEvent<Z>[]
        pruneJournal()
        if (start >= entries.length) return undefined
        const oldest = Math.max(firstSeq + 1, entries[start]!.seq)
        if (seq + 1 < oldest) return undefined
        const out: ReplayEvent<Z>[] = []
        for (let index = start + (seq + 1 - entries[start]!.seq); index < entries.length; index++) {
            out.push(entries[index]!)
        }
        return out
    }

    /** The window actually retained right now — so a bitten cap is visible, not guessed. */
    function journalWindow() {
        pruneJournal()
        const retained = entries.length - start
        return {
            entries: retained,
            oldestSeq: retained > 0 ? entries[start]!.seq : null,
            head,
            ageMs: retained > 0 ? now() - entries[start]!.ts : 0,
            /** Retained total under keepBytes (0 while unset — nothing is measured). */
            bytes: retainedBytes,
            historyLimit: history,
            keepMs: ageLimitMs,
            keepBytes: byteLimit,
            /** true = the count cap cut the window shorter than keepMs asked for. */
            cappedByCount,
            /** true = the byte budget cut entries the age window would have kept. */
            cappedByBytes,
        }
    }

    function currentValue(c?: ListenCurrent<Z>) {
        if (typeof c == 'function') return c()
        return c ? current?.() : undefined
    }

    // === staleness watchdog ===
    // isStale()/lastTs() — lazy, don't create a timer. Timer exists ONLY
    // when onStale is set (otherwise no one gets the edge) and is armed after the first event —
    // cold line holds neither timer nor process (unref).
    let lastTs = 0
    let staleFlag = false
    let staleTimer: any = null
    function stopStaleTimer() {
        if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
    }
    function reportStale(stale: boolean) {
        staleFlag = stale
        try { onStale!({stale, lastTs, age: now() - lastTs}) }
        catch (e) { setTimeout(function rethrowOnStale() { throw e }, 0) }
    }
    // one-shot timer, re-armed for remainder: event only writes lastTs,
    // timer untouched — high-frequency line doesn't pay for re-arm
    function checkStale() {
        staleTimer = null
        const age = now() - lastTs
        if (age >= staleMs!) reportStale(true)   // stale-edge; fresh-edge given by next emit
        else armStaleTimer(staleMs! - age)
    }
    function armStaleTimer(delay: number) {
        if (staleTimer || !onStale || staleMs == null) return
        staleTimer = setTimeout(checkStale, delay)
        staleTimer.unref?.()
    }
    function touchStale(ts: number) {
        lastTs = ts
        if (staleFlag) reportStale(false)        // stale→fresh: line came alive
        armStaleTimer(staleMs!)                  // no-op without onStale/staleMs or with live timer
    }

    // === business logic: precommit, then publish ===
    // Re-entrant emits are queued so a staged bulk cannot interleave its seq range.
    const queued: Z[][] = []
    let publishing = false

    function commitJournalEvent(ev: ReplayEvent<Z>, deliveryErrors: any[]) {
        head = ev.seq
        if (journalEnabled) {
            entries.push(ev)
            if (byteLimit > 0) {
                const size = measureEventBytes(ev)
                sizes.push(size)
                retainedBytes += size
            }
            pruneJournal()
            // Hard count cap last: it must win over the age target so a burst
            // cannot grow the journal without bound.
            if (history > 0) {
                while (entries.length - start > history) {
                    dropOldest()
                    cappedByCount = true
                }
                compactJournal()
            }
        }
        if (currentOpt == 'last') lastEv = ev
        touchStale(ev.ts)
        // Persistence already owns this coordinate. A broken wire consumer must
        // neither roll the head back nor suppress the independent local fan-out.
        deliveryControl.during(deliveryErrors, function deliverCommittedEvent() {
            const prev = emitting
            emitting = ev
            try {
                try { line.emit(ev) }
                catch (error) { deliveryErrors.push(error) }
                try { base.emit(...ev.event) }
                catch (error) { deliveryErrors.push(error) }
            } finally {
                emitting = prev
            }
        })
    }

    function publishJournalBatch(events: Z[], deliveryErrors: any[]) {
        if (onJournalBatch) {
            const staged = events.map(function stageJournalEvent(event, index): ReplayEvent<Z> {
                return {seq: head + index + 1, ts: now(), event}
            })
            for (const ev of staged) onJournal?.(ev)
            onJournalBatch(staged)
            // Once the transaction succeeded every staged coordinate is durable.
            // Publish all of them even when an observer throws midway.
            for (const ev of staged) commitJournalEvent(ev, deliveryErrors)
            return
        }
        // A per-event adapter cannot promise a transaction. Commit a safe prefix:
        // each event reaches storage before its own head/fan-out becomes visible.
        for (const event of events) {
            const ev: ReplayEvent<Z> = {seq: head + 1, ts: now(), event}
            onJournal?.(ev)
            commitJournalEvent(ev, deliveryErrors)
        }
    }

    function deferDeliveryErrors(errors: any[]) {
        if (errors.length == 0) return
        const error = errors.length == 1 ? errors[0] : new AggregateError(errors, 'Multiple replay listeners failed')
        setTimeout(function rethrowReplayDeliveryError() { throw error }, 0)
    }

    function emitBatchJournaled(events: readonly Z[]) {
        if (events.length == 0) return
        const owned = events.map(event => [...event] as Z)
        if (publishing) { queued.push(owned); return }
        publishing = true
        const deliveryErrors: any[] = []
        let publicationError: any = null
        try {
            let next: Z[] | undefined = owned
            while (next) {
                publishJournalBatch(next, deliveryErrors)
                next = queued.shift()
            }
        } catch (error) {
            queued.length = 0
            publicationError = error
        } finally {
            publishing = false
        }
        deferDeliveryErrors(deliveryErrors)
        if (publicationError != null) throw publicationError
    }

    const api = {
        ...base,
        /** Numbering emit: seq++, write to journal, fan-out. Only door to journal. */
        emit: function emitJournaled(...e: Z) {
            emitBatchJournaled([e])
        } as Listener<Z>,
        /** Number and precommit a producer batch before publishing its first event. */
        emitBatch: emitBatchJournaled,
        /** Current line head (seq of last event; 0 = not yet). */
        head: () => head,
        /** Lazy staleness: staleMs is set, there was at least one event and it's older than staleMs. Does not require a timer. */
        isStale: () => staleMs != null && head > 0 && now() - lastTs >= staleMs,
        /** ts of last journal event (0 = not yet). */
        lastTs: () => lastTs,
        /** Close base, numbered wire line and staleness watchdog. */
        close: function closeReplay() {
            stopStaleTimer()
            line.close()
            base.close()
        },
        /** Journal tail after seq (or undefined = evicted). For store-layer / introspection. */
        getSince: journalSince,
        /**
         * Retention actually in force: entries, oldest retained seq, its age, the
         * retained bytes, the configured bounds and whether the count cap or the
         * byte budget cut a `keepMs` target short.
         * A retention window that cannot be observed cannot be trusted.
         */
        journalWindow,
        /** Line of envelopes {seq, ts, event} — for wire (exposeReplay) and external journals. */
        line,
        /** Is current-provider set — can recovery with fresh keyframe occur (fallback, conflation). */
        hasKeyframe: current != null,
        /** Fresh keyframe with its coordinate: state at the moment of head. */
        keyframe: () => {
            const m = current?.()
            return m ? {seq: head, ts: now(), event: m} as ReplayEvent<Z> : undefined
        },
        /**
         * Frame: envelopes bringing the consumer from sinceSeq to head as compactly as
         * the line can. Only method for three triggers: reconnect (since),
         * client pull (its own pace) and draining server gates after lag.
         * Default: exact journal tail (through compactor, if declared) ?? keyframe.
         * Sacred line (neither frame nor current) with evicted journal — LOUD failure:
         * nothing to invent silently, event loss on such line is forbidden.
         */
        frame: function frameSince(sinceSeq: number, hint?: unknown) {
            const tail = journalSince(sinceSeq)
            if (tail) return condense ? condense(tail, hint) : tail
            const m = current?.()
            if (m) return [{seq: head, ts: now(), event: m} as ReplayEvent<Z>]
            throw new Error(`replay frame(${sinceSeq}): journal evicted and no keyframe (sacred line)`)
        },
        on: ((cb: Listener<Z>, {cbClose, key, current: cur, since, onSeq}: ReplayOnOptions<Z> = {}) => {
            if (since == null) {
                // modes without replay-journal — as in store-layer
                const off = base.on(cb, {cbClose, key})
                if (cur) {
                    const m = currentValue(cur)
                    if (m) cb(...m)
                }
                return off
            }
            // === catch-up: only delicate place — handover replay→live ===
            // Order: subscribe to live FIRST (events during replay accumulate in
            // queue by seq), then replay tail, then drain queue. Dedup —
            // strict seq comparison, so neither holes nor duplicates.
            let lastDelivered = since
            let replaying = true
            const queue: ReplayEvent<Z>[] = []
            function deliver(ev: ReplayEvent<Z>) {
                if (ev.seq <= lastDelivered) return
                lastDelivered = ev.seq
                cb(...ev.event)
                onSeq?.(ev.seq)
            }
            const off = base.on(function liveTap(...e: Z) {
                const ev = emitting
                if (ev == null) { cb(...e); return }  // event bypassing journal — return as-is, without seq
                if (replaying) queue.push(ev)
                else deliver(ev)
            }, {cbClose, key})
            const tail = journalSince(since)
            if (tail) {
                for (const ev of tail) deliver(ev)
            } else {
                // journal evicted → fresh keyframe + line from it (killer property:
                // no backlog — new starting point). Reset possible even DOWN:
                // seq "from another server lifetime" must not suppress live events.
                const m = current?.()
                lastDelivered = head
                if (m) {
                    cb(...m)
                    onSeq?.(head)
                }
            }
            // re-entrant emits during replay — deliver with the same dedup logic
            while (queue.length) deliver(queue.shift()!)
            replaying = false
            return off
        }) as ListenOnReplay<Z>,
        once: (cb: Listener<Z>, opts: {key?: key, current?: ListenCurrent<Z>} = {}) => {
            // parity with store-layer: current on once — replay of current value is the event
            if (opts.current) {
                const m = currentValue(opts.current)
                if (m) { cb(...m); return () => {} }
            }
            let off: () => void = () => {}
            off = base.on(((...e: Z) => { off(); cb(...e) }), {key: opts.key})
            return off
        },
    }
    // brand for wire: auto-detection in rpc-server-auto — by it, not by shape
    Object.defineProperty(api, IS_REPLAY_LISTEN, {value: true})
    registerListenOn(api.on, api)
    return api
}
export type ListenReplayApi<T> = ReturnType<typeof withReplayListen<T>>

export type ReplayListenUseOptions<T> = ListenOptions<T> & ReplayListenOptions<NormalizeTuple<T>>

/** [emit, listen]: emit numbers and journals (goes through decorator, not bypassing it). */
export function replayListen<T>(options: ReplayListenUseOptions<T> = {}) {
    const {
        current, frame, history, keepMs, keepBytes, sizeOf, getSince, onJournal, onJournalBatch,
        now, staleMs, onStale, firstSeq, ...listenOptions
    } = options
    let t: ((...a: NormalizeTuple<T>) => void)
    const deliveryControl = createReplayDeliveryControl()
    const base = createListen<T>(function captureReplayEmit(e) { t = e }, {
        fast: true,
        ...listenOptions,
        [LISTEN_DISPATCH_ERROR]: deliveryControl.capture,
    })
    const listen = decorateReplayListen<T>(base, {
        current, frame, history, keepMs, keepBytes, sizeOf, getSince, onJournal, onJournalBatch,
        now, staleMs, onStale, firstSeq,
    }, deliveryControl)
    base.run()
    t = listen.emit  // IMPORTANT: through decorator — otherwise events bypass journal
    return [t!, listen] as const
}
