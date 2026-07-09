// =====================================================================
// Patch relay journal — server-side mirror of an OWNER-sequenced patch line
// =====================================================================
// The relay stores the owner's envelopes VERBATIM (owner seq space), so the
// relay route and the direct route (served from the owner's local journal)
// share coordinates: a relay <-> direct hand-off is a plain seq resume, no
// keyframe reset needed. Keyframe is folded server-side from the patches, so
// late subscribers never depend on the owner being online.

import {listen} from '../events/Listen'
import {ReplayEvent} from '../events/replay-listen'
import {ReplayRemote} from '../events/replay-wire'
import {applyStorePatch, createStore, StorePatch} from '../Observe/store'
import {storePatchKey} from '../Observe/store-replay'

export type PatchEnvelope = ReplayEvent<[StorePatch]>

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
 * Owner-sequenced envelope journal: push() accepts the owner's line verbatim
 * (dedup by seq; a root patch with a LOWER seq means the owner restarted and
 * is a legitimate reset point). The exposed remote is ReplayRemote-shaped —
 * spread it into an rpc object or serve it over any channel as is.
 */
export function createPatchRelayJournal(opts: {history?: number} = {}) {
    const {history = 1024} = opts
    const [emitLine, line] = listen<[PatchEnvelope]>()
    const fold = createStore<any>({}, {drain: 'micro'})
    let ring: PatchEnvelope[] = []
    let last = -1
    let lastTs = 0
    let hasState = false

    function push(env: PatchEnvelope) {
        if (env == null || typeof env.seq != 'number') return false
        const patch = env.event?.[0]
        if (patch == null || !Array.isArray(patch.path)) return false
        const isRoot = patch.path.length == 0
        if (env.seq <= last) {
            // duplicate delivery (reconnect overlap) — drop; owner restart is the
            // one legitimate seq reset and it always arrives as a root keyframe
            if (!isRoot || env.seq == last) return false
            ring = []
        }
        last = env.seq
        lastTs = env.ts ?? lastTs
        hasState = true
        applyStorePatch(fold, patch)
        ring.push(env)
        if (ring.length > history) ring.splice(0, ring.length - history)
        emitLine(env)
        return true
    }

    function keyframe(): PatchEnvelope | null {
        if (!hasState) return null
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
        return kf ? [kf] : null
    }

    // line rides as a REAL Listen object: the rpc layer detects listen nodes by
    // registry (listenByOn) — an anonymous {on: cb => ...} wrapper would not stream
    const remote: ReplayRemote<[StorePatch]> = {line, since, keyframe, frame}

    return {
        /** Feed with the owner's envelopes (rpc `publish` call lands here). */
        push,
        /** ReplayRemote-shaped wire: expose over rpc / serve over a channel as is. */
        remote,
        seq: () => last,
        snapshot: () => fold.snapshot(),
        close: () => { line.close() },
    }
}

export type PatchRelayJournal = ReturnType<typeof createPatchRelayJournal>
