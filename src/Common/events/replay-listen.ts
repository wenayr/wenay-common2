// =====================================================================
// withReplayListen — keyframe (snapshot) + numbered delta line
// =====================================================================
// Decorator over ListenApi in the form of withStoreListen. One pattern for
// everything: keyframe + events S+1…K = exact state at K (I/P-frames, WAL,
// market data). Design: REPLAY-PLAN.md; oracles: replay/ (sandbox).
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
    /** Internal journal: ring of last N events. */
    history?: number
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

export function withReplayListen<T>(base: ListenApi<T>, options: ReplayListenOptions<NormalizeTuple<T>> = {}) {
    return decorateReplayListen(base, options, createReplayDeliveryControl())
}

function decorateReplayListen<T>(
    base: ListenApi<T>, options: ReplayListenOptions<NormalizeTuple<T>>, deliveryControl: ReplayDeliveryControl,
) {
    type Z = NormalizeTuple<T>
    const {
        current: currentOpt, frame: condense, history = 0, getSince, onJournal, onJournalBatch,
        now = Date.now, staleMs, onStale, firstSeq = 0,
    } = options
    // 'last' — keyframe from last journal event: single-entity line,
    // last tick = complete state. lastEv is written in the numbering emit below.
    let lastEv: ReplayEvent<Z> | undefined
    const current: ListenCurrentProvider<Z> | undefined =
        currentOpt == 'last' ? () => lastEv?.event : currentOpt

    // === journal ===
    let head = firstSeq
    // fixed-size ring: event slot seq = (seq-1) % history
    const ring: ReplayEvent<Z>[] = []
    // current sync fan-out event: subscriber's liveTap learns seq without
    // envelope-protocol. save/restore → survives re-entrant emit.
    let emitting: ReplayEvent<Z> | null = null
    // line of envelopes {seq, ts, event} — normal Listen: wire proxies it as-is
    const line = createListen<[ReplayEvent<Z>]>(function noReplayLineProducer() {}, {
        [LISTEN_DISPATCH_ERROR]: deliveryControl.capture,
    })
    line.run()

    function journalSince(seq: number) {
        if (getSince) return getSince(seq)
        // seq from the future (another server lifetime) — don't trust journal, keyframe only
        if (seq > head) return undefined
        if (seq == head) return [] as ReplayEvent<Z>[]
        const oldest = Math.max(firstSeq + 1, head - history + 1)
        if (seq + 1 < oldest) return undefined
        const out: ReplayEvent<Z>[] = []
        for (let s = seq + 1; s <= head; s++) out.push(ring[(s - 1) % history])
        return out
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
        if (history > 0) ring[(ev.seq - 1) % history] = ev
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
        current, frame, history, getSince, onJournal, onJournalBatch,
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
        current, frame, history, getSince, onJournal, onJournalBatch, now, staleMs, onStale, firstSeq,
    }, deliveryControl)
    base.run()
    t = listen.emit  // IMPORTANT: through decorator — otherwise events bypass journal
    return [t!, listen] as const
}
