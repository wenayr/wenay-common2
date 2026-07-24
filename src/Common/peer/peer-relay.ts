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

import {listen, LISTEN_DISPATCH_ERROR} from '../events/Listen'
import {ReplayEvent} from '../events/replay-listen'
import {ReplayRemote} from '../events/replay-wire'
import {applyStorePatch, applyStorePatches, createStore, StorePatch} from '../Observe/store'
import {storePatchKey} from '../Observe/store-replay'
import {
    PEER_PUBLISH_BATCH_MAX_BYTES,
    PEER_PUBLISH_BATCH_MAX_ITEMS,
    peerPublishBatchBytes,
} from './peer-publish-batch'

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
    const ringCapacity = Number.isFinite(history)
        ? Math.max(0, Math.floor(history))
        : Number.MAX_SAFE_INTEGER
    let batchDeliveryErrors: unknown[] | null = null
    const [emitLine, line] = listen<[PatchEnvelope]>({
        [LISTEN_DISPATCH_ERROR]: function captureDeliveryError(error: unknown) {
            if (batchDeliveryErrors) {
                batchDeliveryErrors.push(error)
                return
            }
            rethrowDeliveryErrors([error])
        },
    })
    let fold = folding ? createStore<any>({}, {drain: 'micro'}) : null
    let ring: PatchEnvelope[] = []
    let ringStart = 0
    let ringLength = 0
    let last = -1
    let lastTs = 0
    let hasState = false
    let closed = false
    const deliveryQueue: PatchEnvelope[] = []
    let deliveryCursor = 0
    let deliveryHold = 0
    let delivering = false

    function rethrowDeliveryErrors(errors: unknown[]) {
        if (!errors.length) return
        const error = errors.length == 1
            ? errors[0]
            : new AggregateError(errors, 'peer relay subscriber errors')
        setTimeout(function throwDeliveryErrors() { throw error }, 0)
    }

    function drainDeliveries() {
        if (delivering || deliveryHold > 0) return
        delivering = true
        try {
            while (deliveryCursor < deliveryQueue.length) {
                emitLine(deliveryQueue[deliveryCursor++])
            }
        } finally {
            if (deliveryCursor == deliveryQueue.length) deliveryQueue.length = 0
            else if (deliveryCursor > 0) deliveryQueue.splice(0, deliveryCursor)
            deliveryCursor = 0
            delivering = false
        }
    }

    function deliver(env: PatchEnvelope) {
        deliveryQueue.push(env)
        drainDeliveries()
    }

    function clearRing() {
        ring = []
        ringStart = 0
        ringLength = 0
    }

    function appendRing(env: PatchEnvelope) {
        if (ringCapacity <= 0) return
        if (ringLength < ringCapacity) {
            ring[(ringStart + ringLength) % ringCapacity] = env
            ringLength++
            return
        }
        ring[ringStart] = env
        ringStart = (ringStart + 1) % ringCapacity
    }

    function ringAt(index: number) {
        return ring[(ringStart + index) % ringCapacity]
    }

    function accept(env: PatchEnvelope, reset: boolean) {
        try {
            if (fold) applyStorePatch(fold, env.event[0])
            else {
                const validationFold = createStore<any>({}, {drain: 'micro'})
                applyStorePatch(validationFold, env.event[0])
            }
        } catch {
            return false as const
        }
        if (reset) clearRing()
        last = env.seq
        lastTs = env.ts ?? lastTs
        hasState = true
        appendRing(env)
        deliver(env)
        return true as const
    }

    function push(env: PatchEnvelope): RelayPushResult {
        if (closed) return false
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

    /** Validate first, then expose the ordered batch as one atomic journal operation. */
    function pushBatch(envelopes: PatchEnvelope[]): RelayPushResult {
        if (closed) return false
        if (!Array.isArray(envelopes)) return false
        if (!envelopes.length) return true
        if (envelopes.length > PEER_PUBLISH_BATCH_MAX_ITEMS) return false
        try {
            if (peerPublishBatchBytes(envelopes) > PEER_PUBLISH_BATCH_MAX_BYTES) return false
        } catch {
            return false
        }

        let point = last
        let state = hasState
        let previous = -Infinity
        const accepted: Array<{env: PatchEnvelope, reset: boolean}> = []
        const ignoredPatches: StorePatch[] = []
        for (const env of envelopes) {
            if (env == null || typeof env.seq != 'number' || env.seq <= previous) return false
            const patch = env.event?.[0]
            if (patch == null || !Array.isArray(patch.path)) return false
            previous = env.seq
            const isRoot = patch.path.length == 0

            if (env.seq <= point) {
                if (folding && isRoot && env.seq < point) {
                    accepted.push({env, reset: true})
                    point = env.seq
                    state = true
                } else ignoredPatches.push(patch)
                continue
            }
            let reset = false
            if (state && env.seq > point + 1) {
                if (!folding || !isRoot) return {seq: last}
                reset = true
            } else if (folding && !state && !isRoot) {
                return {seq: last}
            }
            accepted.push({env, reset})
            point = env.seq
            state = true
        }

        // Store owns the canonical patch preparation rules. Validate ignored
        // duplicates on a disposable fold, then prepare every accepted patch
        // together before the real fold sees its first mutation.
        try {
            if (ignoredPatches.length) {
                const validationFold = createStore<any>({}, {drain: 'micro'})
                applyStorePatches(validationFold, ignoredPatches)
            }
            const acceptedPatches = accepted.map(action => action.env.event[0])
            if (fold) applyStorePatches(fold, acceptedPatches)
            else if (acceptedPatches.length) {
                const validationFold = createStore<any>({}, {drain: 'micro'})
                applyStorePatches(validationFold, acceptedPatches)
            }
        } catch {
            return false
        }

        const errors: unknown[] = []
        const previousErrors = batchDeliveryErrors
        batchDeliveryErrors = errors
        deliveryHold++
        try {
            for (const {env, reset} of accepted) {
                if (reset) clearRing()
                last = env.seq
                lastTs = env.ts ?? lastTs
                hasState = true
                appendRing(env)
                deliver(env)
            }
        } finally {
            deliveryHold--
            drainDeliveries()
            batchDeliveryErrors = previousErrors
        }
        rethrowDeliveryErrors(errors)
        return true
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
        if (!ringLength || seq < ringAt(0).seq - 1) return null
        const tail: PatchEnvelope[] = []
        for (let i = 0; i < ringLength; i++) {
            const env = ringAt(i)
            if (env.seq > seq) tail.push(env)
        }
        return tail
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

    function close() {
        if (closed) return
        closed = true
        deliveryQueue.length = 0
        clearRing()
        fold = null
        hasState = false
        line.close()
    }

    return {
        /** Feed with the owner's envelopes (rpc `publish` call lands here). */
        push,
        /** Feed the same owner line in one atomic rpc call. */
        pushBatch,
        /** ReplayRemote-shaped wire (+seq): expose over rpc / serve over a channel as is. */
        remote,
        gap,
        seq: () => last,
        snapshot: () => fold?.snapshot(),
        close,
    }
}

export type PatchRelayJournal = ReturnType<typeof createPatchRelayJournal>
