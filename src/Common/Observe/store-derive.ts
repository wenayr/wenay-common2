// =====================================================================
// Derived store — a projection of one store, served as its own line
// =====================================================================
// The read-policy primitive of a served state: the authority and every
// serving node hold the FULL replicated state (they are trusted processes),
// but a browser, a role, a device or one account must see only its slice.
// deriveStore recomputes `project(snapshot)` after every source batch and
// applies the DIFFERENCE to a second store — so a replay line exposed over
// the derived store emits path-level patches, never a keyframe per change,
// and a follower of that line stays gap-free by seq like any other.
//
// Deliberately simple: the projection is a pure function of the whole
// snapshot (no incremental view maintenance), so its cost is O(projection)
// per source batch. `keys` skips batches that cannot change the result — the
// static top-level keys the projection reads. One derived line per ROLE is
// cheap; one per ACCOUNT is fine while the state is small, and the honest
// next step for a large state is a per-partition line, not a smarter diff.

import {compareDeepValues} from '../core/deep-equal'
import {applyStorePatches, createStore, listenStorePatches, type Store, type StorePatch} from './store'

// ============================================================
// diff: two plain snapshots → the patches that turn one into the other
// ============================================================

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value == null || typeof value != 'object' || Array.isArray(value)) return false
    const proto = Object.getPrototypeOf(value)
    return proto == null || proto == Object.prototype
}

function diffInto(prev: unknown, next: unknown, path: PropertyKey[], out: StorePatch[]) {
    if (Object.is(prev, next)) return
    if (isPlainRecord(prev) && isPlainRecord(next)) {
        for (const key of Object.keys(prev)) {
            if (!Object.hasOwn(next, key)) out.push({path: [...path, key], exists: false, value: undefined})
        }
        for (const key of Object.keys(next)) {
            if (!Object.hasOwn(prev, key)) out.push({path: [...path, key], exists: true, value: next[key]})
            else diffInto(prev[key], next[key], [...path, key], out)
        }
        return
    }
    // arrays and non-plain values are replaced whole: the order of an array is
    // part of its value, and a rich value has no path-addressable inside
    if (compareDeepValues(prev, next)) return
    out.push({path, exists: true, value: next})
}

/** The patches that turn `prev` into `next`; a missing `prev` is one root replacement. */
export function storeDiffPatches(prev: unknown, next: object) {
    const out: StorePatch[] = []
    if (prev === undefined) out.push({path: [], exists: true, value: next})
    else diffInto(prev, next, [], out)
    return out
}

// ============================================================
// the derived store
// ============================================================

export type DeriveStoreOpts = {
    /** Static top-level keys the projection reads; a batch touching none of them is skipped. */
    keys?: readonly string[]
}

export function deriveStore<S extends object, P extends object>(
    source: Store<S>, project: (state: S) => P, opts: DeriveStoreOpts = {},
) {
    const keys = opts.keys ? new Set<PropertyKey>(opts.keys) : null
    let current = project(source.snapshot())
    const store = createStore<P>(current)
    let recomputes = 0
    let emitted = 0
    let skipped = 0

    function touches(patches: readonly StorePatch[]) {
        if (!keys) return true
        for (const patch of patches) {
            if (patch.path.length == 0 || keys.has(patch.path[0])) return true
        }
        return false
    }

    const off = listenStorePatches(source).on(function recompute(patches: readonly StorePatch[]) {
        if (!touches(patches)) { skipped++; return }
        recomputes++
        const next = project(source.snapshot())
        const diff = storeDiffPatches(current, next)
        current = next
        if (diff.length == 0) return
        emitted += diff.length
        applyStorePatches(store, diff)
    })

    return {
        /** The projection as a live store: subscribe, snapshot, or expose as a replay line. */
        store,
        stats: () => ({recomputes, emitted, skipped}),
        close: off,
    }
}
export type DerivedStore<P extends object = any> = ReturnType<typeof deriveStore<any, P>>
