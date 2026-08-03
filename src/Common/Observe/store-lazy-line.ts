// =====================================================================
// Lazy Store line — resumable progressive merge fill for slow links
// =====================================================================
// A subscriber converges to the current Store state without ever receiving a
// monolithic keyframe, without the host freezing a snapshot, and without
// spending bytes on values that would be overwritten before they arrive.
//
// Merge semantics only: a top-level value is absolute and the last write wins,
// so per-key convergence replaces point-in-time consistency. That single
// relaxation removes the frozen snapshot, the second copy in memory and the
// restart-on-change of a strict chunked transfer.
//
// THERE IS NO SNAPSHOT. Not of values, and not of a key list either. Progress is
// one cursor the SUBSCRIBER holds — `{key, revision}`, meaning "I have every key
// up to `key`, as of `revision`". The host keeps no per-subscriber state at all,
// so a reconnect resumes the fill instead of starting it over, which is the whole
// point on the links this line exists for.
//
// Invariants:
// - A key is sent with the value it has AT SEND TIME, never a captured one.
// - Keys after the cursor have never been sent, so a change to one costs nothing:
//   its turn will carry the newer value anyway. This is the slow-link saving.
// - Keys at or before the cursor are re-sent only when their revision is newer
//   than the cursor's. That is what a returning subscriber missed.
// - A deleted key travels as a tombstone: a subscriber may hold a stale copy.
// - Delivery is pull-based; the consumer's byte budget is the rate control, so a
//   background fill cannot occupy the link ahead of an urgent line.
//
// For the strict all-or-nothing transfer see store-replay-view; this is its
// sibling, not a replacement.

import {rpcResultWireMetricsFast} from '../rcp/rpc-wire-size'
import {listenStorePatches, type Store, type StorePatch} from './store'

// =====================================================================
// Wire shapes
// =====================================================================

/**
 * "I have every key up to `key`, as of `revision`, on line `lineId`."
 * `key: null` = nothing yet.
 *
 * `lineId` is what makes the claim checkable. A revision only means something inside
 * one host lifetime: after a restart the counter begins again, so without an identity
 * a cursor from the previous lifetime would be accepted, find nothing to catch up, and
 * resume the fill past keys it only ASSUMES it holds. `replay-listen` guards the same
 * hazard by refusing a seq "from another server lifetime".
 */
export type StoreLazyCursor = {
    lineId: string
    key: string | null
    revision: number
}

export type StoreLazyChunkV1 = {
    index: number
    /**
     * Absolute top-level values as a map, not one patch object per key. Every key of
     * this line is a single top-level segment, so a map writes each key once and
     * shares the enclosing structure — the encoding economy a keyframe already gets.
     * Measured: one-patch-per-key cost 2.8x the bytes of the equivalent keyframe
     * (experiments/store-lazy-2026-08).
     */
    values: Record<string, unknown>
    /** Keys that no longer exist. A tombstone, so a stale copy cannot survive. */
    deleted: readonly string[]
    /** 'fill' = first delivery of a key, 'live' = a key changed since the cursor. */
    kind: 'fill' | 'live'
}

export type StoreLazyReadV1 = {
    /** Persist this and hand it back to resume exactly here after a reconnect. */
    cursor: StoreLazyCursor
    /** Keys still awaiting their first delivery. */
    remaining: number
    /** Every key has been delivered at least once; only live re-sends remain. */
    filled: boolean
    revision: number
    /**
     * The cursor cannot be honoured: either it is older than the host can still prove
     * correct because tombstones that old were pruned, or it belongs to a different
     * line lifetime. Restart from a null cursor AND sweep the mirror — silently
     * continuing would leave keys alive that the host no longer has.
     */
    stale?: true
}

export type StoreLazyRemote = {
    describe?: () => Record<string, any> | Promise<Record<string, any>>
    read: (
        request: {cursor?: StoreLazyCursor | null, maxBytes?: number, maxItems?: number},
        emit: (chunk: StoreLazyChunkV1) => void,
    ) => StoreLazyReadV1 | Promise<StoreLazyReadV1>
}

export type StoreLazyLineOpts = {
    /** Packed payload target for one chunk (default 32 KiB; one indivisible value may exceed it). */
    chunkBytes?: number
    /** Hard key ceiling for one chunk (default 512). */
    maxItems?: number
    /**
     * Ceiling for one read call (default 512 KiB). One call emits MANY chunks, so this
     * is the round-trip amortiser: a budget below the link's bandwidth-delay product
     * leaves the link idle waiting for the next request, which is what made an early
     * version of this line latency-bound (experiments/store-lazy-2026-08).
     */
    windowBytes?: number
    /**
     * How long a deleted key's tombstone is retained (default 10 minutes). A subscriber
     * whose cursor is older than the last prune is told to restart, because its mirror
     * could otherwise keep a key that no longer exists.
     */
    tombstoneKeepMs?: number
    /**
     * Identity of this line's lifetime. A cursor from a different lineId is refused,
     * because a revision counter only means something inside one lifetime. Pass an
     * explicit value ONLY when the host genuinely preserves its revision counter and
     * key history across restarts; otherwise let it default to a fresh per-instance id.
     */
    lineId?: string
    /** Static descriptor served as describe(). */
    describe?: Record<string, any>
    now?: () => number
}

let lazyLineCounter = 0

// =====================================================================
// Local helpers
// =====================================================================

function positiveInteger(value: number | undefined, fallback: number, name: string) {
    const result = value ?? fallback
    if (!Number.isSafeInteger(result) || result <= 0) throw new RangeError(name + ' must be a positive safe integer')
    return result
}

function valueBytes(value: unknown) {
    return rpcResultWireMetricsFast(value).byteLength
}

// =====================================================================
// Host — stateless per subscriber
// =====================================================================

export function exposeStoreLazyLine<T extends object>(store: Store<T>, opts: StoreLazyLineOpts = {}) {
    const chunkBytes = positiveInteger(opts.chunkBytes, 32 * 1024, 'exposeStoreLazyLine: chunkBytes')
    const maxItems = positiveInteger(opts.maxItems, 512, 'exposeStoreLazyLine: maxItems')
    const windowBytes = positiveInteger(opts.windowBytes, 512 * 1024, 'exposeStoreLazyLine: windowBytes')
    const tombstoneKeepMs = positiveInteger(opts.tombstoneKeepMs, 600_000, 'exposeStoreLazyLine: tombstoneKeepMs')
    const now = opts.now ?? Date.now
    // Must differ across process restarts, or a cursor from a dead lifetime would be
    // silently trusted. Time plus a counter separates both restarts and instances.
    const lineId = opts.lineId ?? ('lazy-' + Date.now().toString(36) + '-' + (++lazyLineCounter))

    /** Revision of the last change to each key, including keys that were deleted. */
    const keyRevision = new Map<string, number>()
    /** Deleted keys awaiting tombstone expiry: key -> when it was removed. */
    const tombstones = new Map<string, number>()

    let revision = 0
    // A cursor older than this cannot be served: tombstones it needed are gone.
    let oldestProvableRevision = 0
    let sortedKeys: string[] | null = null
    let closed = false

    // === Key set index ===
    // Rebuilt only when the SET of keys changes. A merge line rewrites values far
    // more often than it adds or removes keys, so this stays cold in the hot path.

    function keysInOrder() {
        if (sortedKeys == null) sortedKeys = Object.keys(store.state as object).sort()
        return sortedKeys
    }

    function onStorePatches(patches: readonly StorePatch[]) {
        if (closed) return
        revision++
        const state = store.state as Record<string, unknown>
        for (const patch of patches) {
            if (patch.path.length == 0) {
                // Root replacement: every key is new information for everyone.
                sortedKeys = null
                for (const key of Object.keys(state)) keyRevision.set(key, revision)
                continue
            }
            const key = String(patch.path[0])
            const known = keyRevision.has(key)
            keyRevision.set(key, revision)
            const exists = Object.prototype.hasOwnProperty.call(state, key)
            if (exists) {
                if (tombstones.delete(key) || !known) sortedKeys = null
            } else {
                if (!tombstones.has(key)) sortedKeys = null
                tombstones.set(key, now())
            }
        }
        pruneTombstones()
    }

    function pruneTombstones() {
        if (tombstones.size == 0) return
        const deadline = now() - tombstoneKeepMs
        for (const [key, removedAt] of tombstones) {
            if (removedAt >= deadline) continue
            tombstones.delete(key)
            const at = keyRevision.get(key)
            keyRevision.delete(key)
            // Any cursor older than this can no longer learn about the deletion.
            if (at != undefined && at > oldestProvableRevision) oldestProvableRevision = at
        }
    }

    const offPatches = listenStorePatches(store).on(onStorePatches)

    /** Current value of one key, or the absent marker when it is gone. */
    function currentValue(key: string) {
        const state = store.state as Record<string, unknown>
        return Object.prototype.hasOwnProperty.call(state, key)
            ? {exists: true as const, value: state[key]}
            : {exists: false as const, value: undefined}
    }

    // === The single ordered walk ===
    // Keys at or before the cursor are caught up first (they are what a returning
    // subscriber missed), then the fill continues past it. Sorted order makes both
    // halves one pass and makes the cursor resumable without host state.

    function read(
        request: {cursor?: StoreLazyCursor | null, maxBytes?: number, maxItems?: number},
        emit: (chunk: StoreLazyChunkV1) => void,
    ): StoreLazyReadV1 {
        if (closed) throw new Error('exposeStoreLazyLine: host is closed')
        const cursor: StoreLazyCursor = request.cursor ?? {lineId, key: null, revision: 0}
        // A cursor is only meaningful inside the lifetime that issued it, and only while
        // every deletion it missed is still provable.
        if (cursor.key != null && (cursor.lineId != lineId || cursor.revision < oldestProvableRevision)) {
            return {
                cursor: {lineId, key: null, revision: 0},
                remaining: keysInOrder().length,
                filled: false,
                revision,
                stale: true,
            }
        }

        const budget = Math.min(
            positiveInteger(request.maxBytes, windowBytes, 'read: maxBytes'),
            windowBytes,
        )
        const itemLimit = Math.min(
            positiveInteger(request.maxItems, maxItems, 'read: maxItems'),
            maxItems,
        )
        const readRevision = revision
        const keys = keysInOrder()

        let spent = 0
        let chunkIndex = 0
        let values: Record<string, unknown> = {}
        let deleted: string[] = []
        let count = 0
        let chunkSize = 0
        let chunkKind: 'fill' | 'live' = 'live'
        let nextCursorKey = cursor.key
        let caughtUp = true
        let exhausted = false

        function flush() {
            if (count == 0) return
            emit({index: chunkIndex++, values, deleted, kind: chunkKind})
            values = {}
            deleted = []
            count = 0
            chunkSize = 0
        }

        function send(key: string, kind: 'fill' | 'live') {
            const current = currentValue(key)
            // Key bytes plus its value; the map itself adds no per-entry wrapper.
            const size = key.length + 4 + (current.exists ? valueBytes(current.value) : 0)
            if (count > 0 && (kind != chunkKind || chunkSize + size > chunkBytes || count >= itemLimit)) flush()
            chunkKind = kind
            if (current.exists) values[key] = current.value
            else deleted.push(key)
            count++
            chunkSize += size
            spent += size
        }

        // Catch-up: tombstones for keys already deleted, then live keys that moved.
        for (const [key] of tombstones) {
            if (cursor.key == null || key > cursor.key) continue
            if ((keyRevision.get(key) ?? 0) <= cursor.revision) continue
            if (spent >= budget) { caughtUp = false; exhausted = true; break }
            send(key, 'live')
        }

        if (!exhausted) {
            for (const key of keys) {
                if (spent >= budget) {
                    exhausted = true
                    if (cursor.key != null && key <= cursor.key) caughtUp = false
                    break
                }
                if (cursor.key != null && key <= cursor.key) {
                    if ((keyRevision.get(key) ?? 0) > cursor.revision) send(key, 'live')
                    continue
                }
                send(key, 'fill')
                nextCursorKey = key
            }
        }
        flush()

        const remaining = countRemaining(keys, nextCursorKey)
        return {
            // The revision only advances when the catch-up half completed; otherwise
            // the rest of what the subscriber missed would be skipped silently.
            cursor: {lineId, key: nextCursorKey, revision: caughtUp ? readRevision : cursor.revision},
            remaining,
            filled: remaining == 0,
            revision,
        }
    }

    function countRemaining(keys: readonly string[], cursorKey: string | null) {
        if (cursorKey == null) return keys.length
        let low = 0
        let high = keys.length
        while (low < high) {
            const mid = (low + high) >> 1
            if (keys[mid] <= cursorKey) low = mid + 1
            else high = mid
        }
        return keys.length - low
    }

    function snapshot() {
        return {
            revision,
            oldestProvableRevision,
            keys: keysInOrder().length,
            tombstones: tombstones.size,
            trackedKeys: keyRevision.size,
            chunkBytes,
            windowBytes,
            tombstoneKeepMs,
        }
    }

    const api: StoreLazyRemote = {read}
    if (opts.describe) api.describe = () => ({...opts.describe})

    return {
        /** Remote surface: expose this object through RPC. */
        api,
        view: {snapshot},
        close: function closeHost() {
            if (closed) return
            closed = true
            keyRevision.clear()
            tombstones.clear()
            sortedKeys = null
            offPatches?.()
        },
    }
}

export type StoreLazyLineHost = ReturnType<typeof exposeStoreLazyLine>

// =====================================================================
// Subscriber
// =====================================================================

export type StoreLazySyncOpts = {
    /**
     * Byte budget for one read (default 256 KiB) — the consumer's rate control.
     *
     * One read emits many chunks, so this is also the round-trip amortiser. Keep it
     * comfortably ABOVE the link's bandwidth-delay product (throughput x round-trip
     * time), or the link sits idle between requests: at 128 KiB/s and 160 ms RTT the
     * product is ~20 KiB, and a 16 KiB budget made the fill latency-bound rather than
     * bandwidth-bound. Lower it only to make a background fill more polite.
     */
    readBytes?: number
    /** Resume point from a previous run — the fill continues instead of restarting. */
    cursor?: StoreLazyCursor | null
    /** Delay between reads while the fill is still running (default 0). */
    fillIntervalMs?: number
    /** Delay between reads once the first pass is complete (default 250). */
    liveIntervalMs?: number
    /** Stop after the first pass instead of following live re-sends. */
    fillOnly?: boolean
    /** Persist the cursor so a later process can resume where this one stopped. */
    onCursor?: (cursor: StoreLazyCursor) => void
    onProgress?: (progress: {
        received: number
        remaining: number
        filled: boolean
        chunks: number
        /** Mirror keys removed by the end-of-pass sweep because the host no longer has them. */
        swept: number
    }) => void
    onError?: (error: unknown) => void
}

/**
 * Apply a lazy line into a mirror Store, progressively and resumably. The mirror shows
 * a mix of fresh and stale keys while the first pass runs — that is the trade this line
 * makes, and it is why it never needs a second copy in memory.
 */
export function syncStoreLazyLine<T extends object>(
    mirror: Store<T>,
    remote: StoreLazyRemote,
    opts: StoreLazySyncOpts = {},
) {
    const readBytes = positiveInteger(opts.readBytes, 256 * 1024, 'syncStoreLazyLine: readBytes')
    const fillIntervalMs = opts.fillIntervalMs ?? 0
    const liveIntervalMs = opts.liveIntervalMs ?? 250

    let stopped = false
    let cursor: StoreLazyCursor | null = opts.cursor ?? null
    let received = 0
    let chunks = 0
    // Keys delivered during a full pass from a null cursor. A pass from scratch walks
    // EVERY key that currently exists, so anything left in the mirror afterwards that
    // this pass never mentioned does not exist on the host — including a key whose
    // tombstone expired while the subscriber was away. Sweeping at the END of the pass
    // rather than clearing up front is what keeps the mirror populated throughout.
    let sweepSeen: Set<string> | null = cursor == null ? new Set<string>() : null
    let timer: ReturnType<typeof setTimeout> | null = null
    let settleFirstPass: (() => void) | null = null
    const firstPass = new Promise<void>(function captureFirstPass(resolve) {
        settleFirstPass = resolve
    })

    function applyChunk(chunk: StoreLazyChunkV1) {
        chunks++
        const state = mirror.state as Record<string, unknown>
        for (const key of Object.keys(chunk.values)) {
            state[key] = chunk.values[key]
            sweepSeen?.add(key)
            received++
        }
        for (const key of chunk.deleted) {
            delete state[key]
            sweepSeen?.add(key)
            received++
        }
    }

    /** Drop mirror keys a full pass never mentioned. Returns how many were removed. */
    function sweepUnseen() {
        if (sweepSeen == null) return 0
        const state = mirror.state as Record<string, unknown>
        const seen = sweepSeen
        sweepSeen = null
        let swept = 0
        for (const key of Object.keys(state)) {
            if (seen.has(key)) continue
            delete state[key]
            swept++
        }
        return swept
    }

    async function step() {
        if (stopped) return
        try {
            const result = await remote.read({cursor, maxBytes: readBytes}, applyChunk)
            if (stopped) return
            if (result.stale) {
                // Too far behind to be brought up to date incrementally. Restart the
                // walk AND arm a sweep: the host can no longer prove which keys were
                // deleted while this subscriber was away, so anything the fresh pass
                // does not mention must be dropped at the end of it. Resetting only the
                // cursor would leave a key deleted long ago alive in the mirror forever.
                //
                // The set is REPLACED, never kept. A stale can arrive part-way through a
                // pass that is already sweeping, and the keys that pass delivered are not
                // evidence about the restarted one: a key the aborted pass sent and the
                // fresh pass never mentions is exactly the key that must be swept.
                cursor = null
                sweepSeen = new Set<string>()
                schedule(fillIntervalMs)
                return
            }
            cursor = result.cursor
            opts.onCursor?.(result.cursor)
            // Sweep BEFORE settling `filled`, so awaiting it guarantees a mirror that
            // holds exactly what the host holds.
            const swept = result.filled ? sweepUnseen() : 0
            opts.onProgress?.({received, remaining: result.remaining, filled: result.filled, chunks, swept})
            if (result.filled && settleFirstPass) {
                settleFirstPass()
                settleFirstPass = null
                if (opts.fillOnly) {
                    close()
                    return
                }
            }
            schedule(result.filled ? liveIntervalMs : fillIntervalMs)
        } catch (error) {
            if (stopped) return
            opts.onError?.(error)
            schedule(liveIntervalMs)
        }
    }

    function schedule(delayMs: number) {
        if (stopped) return
        timer = setTimeout(function runLazyStep() { void step() }, delayMs)
        // The first pass keeps the process alive, because a caller awaiting `filled`
        // would otherwise see it stall silently in an idle process. Live polling after
        // that is background work and must not hold the process open.
        if (settleFirstPass == null) timer.unref?.()
    }

    function close() {
        if (stopped) return
        stopped = true
        if (timer != null) clearTimeout(timer)
        timer = null
        settleFirstPass?.()
        settleFirstPass = null
    }

    void step()

    return {
        /** Resolves when every key has been delivered at least once. */
        filled: firstPass,
        view: {
            snapshot: () => ({received, chunks, running: !stopped, cursor}),
        },
        close,
    }
}
