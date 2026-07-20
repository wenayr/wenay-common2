// =====================================================================
// conflateReplay — per-client conflation + snapshot recovery
// =====================================================================
// Gate on replay-line of ONE client, server side. While client's outgoing
// buffer is below threshold — envelopes go as-is; above threshold — deltas
// stop being sent AT ALL (no queue — killer property), client
// marked "needs keyframe"; buffer drained — fresh keyframe goes as SAME
// envelope on line, deltas resume from its seq. Client unchanged at all:
// replaySubscribe dedupes by seq anyway, keyframe — event of same type
// (for store — root-patch).
//
// Transport decorator doesn't know: fullness signal — pending() lambda
// (for socket.io — e.g., socket.conn.writeBuffer.length). Units any
// (bytes, packets, frames…), but pending() and thresholds — same ones.
//
// Collapsing by key (opts.keyOf): while client lags, instead of clean drop
// we hold map "key → LAST envelope"; buffer drained — tail of
// last values of affected keys (in seq order) goes, not full
// keyframe. Thousand ticks of one key = one envelope; big store doesn't
// stall because of a couple changed keys. Memory bounded by number of keys
// (maxKeys), not number of events — killer property in place. Correctness:
// event must be ABSOLUTE for its key (fully set its
// state, like store-patch on path); map order = order of last
// touches = by seq, so tail — subsequence of line where each
// dropped envelope is masked by later one with same key.
// Unkeyed event (keyOf → null) or more keys than maxKeys → episode
// degrades to classic keyframe recovery — so current-provider
// is required in this mode too.
//
// Built PER-CONNECTION — where rpc server of connection is created:
//     const gated = conflateReplay(exposed.replay, {pending, highWater})
//     object = {...exposed.api, replay: gated.api}   // instead of exposeReplay
//     disconnect → gated.close()
// One-liner alternative — exposeReplay(replay, {conflate: opts}) in replay-wire.

import {createListen, NormalizeTuple} from './Listen'
import {ListenReplayApi, ReplayEvent} from './replay-listen'

export type ConflateOpts<Z extends any[] = any[]> = {
    /** Fullness of outgoing buffer of THIS client (units same as thresholds). */
    pending: () => number
    /** Entry to conflation: pending() > highWater → deltas for client stop. */
    highWater: number
    /** Exit from conflation (default 0): pending() <= lowWater → keyframe + deltas continue. */
    lowWater?: number
    /** Poll interval for pending() in conflation mode, ms (default 25) — recovery even on quiet line. */
    pollMs?: number
    /**
     * @deprecated Compaction moved to line: declare `frame` in options
     * replayListen/withReplayListen (same place as current) — will be picked up by these gates
     * (recovery via replay.frame), and auto-path rpc-server-auto, and client catch-up.
     * keyOf-mechanics (held-map) stays working for old calls.
     *
     * Collapsing by key: during conflation stores LAST envelope of each
     * key, recovery = tail of these envelopes instead of full keyframe.
     * Event must be absolute for its key (store-patch: storePatchKey).
     * null/undefined = event doesn't collapse → episode degrades to keyframe.
     */
    keyOf?: (...event: Z) => PropertyKey | null | undefined
    /** @deprecated Together with keyOf. Ceiling of key map of episode (default 1024): more → degrade to keyframe. */
    maxKeys?: number
}

export function conflateReplay<T>(replay: ListenReplayApi<T>, opts: ConflateOpts<NormalizeTuple<T>>) {
    type Z = NormalizeTuple<T>
    const {pending, highWater, lowWater = 0, pollMs = 25, keyOf, maxKeys = 1024} = opts
    // without current-provider nothing to recover with: dropped deltas would become silent hole
    if (!replay.hasKeyframe) throw new TypeError('conflateReplay: need current-provider (keyframe recovery)')

    // personal envelope line of this client
    const gate = createListen<[ReplayEvent<Z>]>(() => {})
    gate.run()

    let conflating = false
    let closed = false
    let dropped = 0        // deltas dropped entirely (collapse into keyframe)
    let keyframes = 0      // recoveries with full keyframe
    let coalesced = 0      // envelopes absorbed by later one with same key
    let flushes = 0        // recoveries with tail of collapsed deltas (instead of keyframe)
    // episode collapse map: key → last envelope; null = keyframe-mode.
    // delete+re-insert on update → iteration order = last touches = by seq.
    let held: Map<PropertyKey, ReplayEvent<Z>> | null = null
    let timer: any = null

    function stopPoll() {
        if (timer) { clearInterval(timer); timer = null }
    }
    // poll needed to recover even when line is quiet (buffer drained, no events)
    function startPoll() {
        if (timer || closed) return
        timer = setInterval(recoverIfDrained, pollMs)
        timer.unref?.()
    }
    function recoverIfDrained() {
        if (!conflating || closed) return
        if (pending() > lowWater) return
        conflating = false
        stopPoll()
        if (held) {
            // tail recovery: last values of affected keys, in seq order
            const tail = [...held.values()]
            held = null
            flushes++
            for (const ev of tail) gate.emit(ev)
            return
        }
        const kf = replay.keyframe()
        // kf.seq == head → client's dedup by seq will cut overlap with subsequent deltas
        if (kf) { keyframes++; gate.emit(kf as ReplayEvent<Z>) }
    }
    // absorb envelope into episode map; doesn't collapse → degrade to keyframe-mode
    function absorb(ev: ReplayEvent<Z>) {
        const k = keyOf!(...ev.event)
        if (k == null || (!held!.has(k) && held!.size >= maxKeys)) {
            dropped += held!.size + 1
            held = null
            return
        }
        if (held!.delete(k)) coalesced++
        held!.set(k, ev)
    }
    const offLine = replay.line.on(function gateForward(ev: ReplayEvent<Z>) {
        if (closed) return
        if (!conflating && pending() > highWater) {
            conflating = true
            held = keyOf ? new Map() : null
            startPoll()
        }
        if (conflating) {
            if (held) {
                // absorb BEFORE drain check: if drained — tail includes THIS event
                absorb(ev)
                recoverIfDrained()
                return
            }
            // don't wait for timer: if drained — keyframe already includes THIS event (journal written before fan-out)
            recoverIfDrained()
            if (conflating) dropped++
            return
        }
        gate.emit(ev)
    })

    function close() {
        if (closed) return
        closed = true
        held = null
        stopPoll()
        offLine()
        gate.close()
    }

    return {
        /** Wire-facade of THIS client: shape of exposeReplay, but line — personal gates.
         *  Shape inlines (not imported) so graph replay-wire → replay-conflate stays acyclic. */
        api: {
            line: gate,
            since: (seq: number) => replay.getSince(seq) ?? null,
            keyframe: () => replay.keyframe() ?? null,
            frame: (seq: number, hint?: unknown) => replay.frame(seq, hint),
        },
        close,
        /** Introspection for metrics/tests. */
        stats: () => ({conflating, dropped, keyframes, coalesced, flushes}),
    }
}
