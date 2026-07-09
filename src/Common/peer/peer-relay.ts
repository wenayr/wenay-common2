// =====================================================================
// Patch relay journal — server-side mirror of an OWNER-sequenced patch line
// =====================================================================
// The relay stores the owner's envelopes VERBATIM (owner seq space), so the
// relay route and the direct route (served from the owner's local journal)
// share coordinates: a relay <-> direct hand-off is a plain seq resume, no
// keyframe reset needed.
//
// Correctness contract (gap policy — the SERVER declares data semantics):
//   'resume' (default, folding): keyframe is folded server-side (late joiners
//     never depend on the owner being online); a ROOT patch always resets the
//     journal (owner restart and keyframe repair share one rule); a NON-root
//     envelope with a seq gap is REJECTED — push returns {seq: last}, and that
//     coordinate IS the repair request: the publisher re-sends from there.
//   'sacred': the journal never invents state — no folded keyframe, no root
//     reset semantics, strict contiguity only; frame() on an evicted tail
//     THROWS (loud, never a silent seq jump). For data where an invented
//     snapshot is unacceptable (orders, audit).
// The publisher's repair mode lives in peer-client; asking for a cheap repair
// against a sacred journal is forbidden by TYPES there, not by runtime checks.

import {listen} from '../events/Listen'
import {ReplayEvent} from '../events/replay-listen'
import {ReplayRemote} from '../events/replay-wire'
import {applyStorePatch, createStore, StorePatch} from '../Observe/store'
import {storePatchKey} from '../Observe/store-replay'

export type PatchEnvelope = ReplayEvent<[StorePatch]>

export type tRelayGap = 'resume' | 'sacred'

/** push verdict: accepted | malformed | "my last seq is N — repair from N". */
export type RelayPushResult = boolean | {seq: number}

// last patch per exact path — same condensation rule as exposeStoreReplay's frame
function condensePatchTail(tail: PatchEnvelope[]) {
    const held = new Map<string, PatchEnvelope>()
    for (const ev of tail) {
        const k = storePatchKey(ev.event[0])
        if (k == null) return tail
        held.delete(k)
        held.set(k, ev)
    }
    return Array.from(held.values())
}

/**
 * Owner-sequenced envelope journal. The exposed remote is ReplayRemote-shaped
 * (plus `seq`) — spread it into an rpc object or serve it over any channel as is.
 */
export function createPatchRelayJournal(opts: {history?: number, gap?: tRelayGap} = {}) {
    const {history = 1024, gap = 'resume'} = opts
    const folding = gap != 'sacred'
    const [emitLine, line] = listen<[PatchEnvelope]>()
    const fold = folding ? createStore<any>({}, {drain: 'micro'}) : null
    let ring: PatchEnvelope[] = []
    let last = -1
    let lastTs = 0
    let hasState = false

    function accept(env: PatchEnvelope, reset: boolean) {
        if (reset) ring = []
        last = env.seq
        lastTs = env.ts ?? lastTs
        hasState = true
        if (fold) applyStorePatch(fold, env.event[0])
        ring.push(env)
        if (ring.length > history) ring.splice(0, ring.length - history)
        emitLine(env)
        return true as const
    }

    function push(env: PatchEnvelope): RelayPushResult {
        if (env == null || typeof env.seq != 'number') return false
        const patch = env.event?.[0]
        if (patch == null || !Array.isArray(patch.path)) return false
        const isRoot = patch.path.length == 0

        // duplicate delivery (reconnect/repair overlap) — idempotent accept-noop,
        // EXCEPT a root patch with a lower seq on a folding journal: owner restart
        if (env.seq <= last) {
            if (folding && isRoot && env.seq < last) return accept(env, true)
            return true
        }
        // seq gap: a folding journal takes a root patch as a legitimate reset point;
        // anything else is rejected WITH the repair coordinate
        if (hasState && env.seq > last + 1) {
            if (folding && isRoot) return accept(env, true)
            return {seq: last}
        }
        // first envelope of a folding journal must carry full state — otherwise
        // the fold (and every late joiner's keyframe) would be a partial lie
        if (folding && !hasState && !isRoot) return {seq: -1}
        return accept(env, false)
    }

    function keyframe(): PatchEnvelope | null {
        // sacred: the journal never invents a snapshot
        if (!fold || !hasState) return null
        return {seq: last, ts: lastTs, event: [{path: [], exists: true, value: fold.snapshot()}]}
    }

    function since(seq: number): PatchEnvelope[] | null {
        if (!hasState) return null
        if (seq >= last) return []
        // evicted head -> null: the caller falls back to keyframe (visible seq jump, by contract)
        if (!ring.length || seq < ring[0].seq - 1) return null
        return ring.filter(ev => ev.seq > seq)
    }

    function frame(seq: number, _hint?: unknown): PatchEnvelope[] | null {
        const tail = since(seq)
        if (tail) return condensePatchTail(tail)
        const kf = keyframe()
        if (kf) return [kf]
        // sacred line + evicted journal: loud, never silent invention
        if (!folding && hasState) throw new Error('sacred relay journal: tail evicted, no keyframe to invent')
        return null
    }

    // line rides as a REAL Listen object: the rpc layer detects listen nodes by
    // registry (listenByOn) — an anonymous {on: cb => ...} wrapper would not stream
    const remote: ReplayRemote<[StorePatch]> & {seq: () => number} = {
        line, since, keyframe, frame,
        /** Publisher-side resync coordinate (additive on the wire). */
        seq: () => last,
    }

    return {
        /** Feed with the owner's envelopes (rpc `publish` call lands here). */
        push,
        /** ReplayRemote-shaped wire (+seq): expose over rpc / serve over a channel as is. */
        remote,
        gap,
        seq: () => last,
        snapshot: () => fold?.snapshot(),
        close: () => { line.close() },
    }
}

export type PatchRelayJournal = ReturnType<typeof createPatchRelayJournal>
