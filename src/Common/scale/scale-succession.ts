// =====================================================================
// Line succession — a keyed line that is FOLLOWED or OWNED, never both
// =====================================================================
// The authority owns three control lines (directory, deny list, receipts). A
// standby must hold their CURRENT contents without owning them, and take them
// over the instant it is promoted; a demoted leader must let go without losing
// the last thing it knew. This is that one shape, once, for any replicated map:
//   follow(remote)  — mirror the remote line (standby); the owner, if any, closes
//   promote()       — produce a fresh OWNED line seeded with the followed snapshot
//   demote()        — close the owned line; the snapshot stays as last-known
// The owner factory is injected because each line has its own facade (the node
// directory's verbs, a plain replicated map, the receipts line) — succession
// owns the hand-over, never the verbs.
// Internal to the Scale tier: the authority is its one consumer.

import {followReplicatedMap, type FollowedReplicatedMap, type ReplicatedMapRemote, type ReplicatedMapState} from '../Observe/replicated-map'

export type tLineSuccessionRole = 'owner' | 'follower' | 'idle'

/** The minimum an owned line must show: its current rows and a way to close. */
export type LineSuccessionOwner<V> = {
    control: {snapshot(): ReplicatedMapState<V>, close(): void}
}

export type LineSuccessionDeps<V, O extends LineSuccessionOwner<V>> = {
    /** Build the OWNED line seeded with the rows this process last saw. */
    produce: (initial: V[]) => O
    /** Start owning right away (a born leader); default: idle until follow()/promote(). */
    own?: boolean
    label?: string
    log?: (line: string) => void
    onError?: (error: unknown) => void
}

export function createLineSuccession<V, O extends LineSuccessionOwner<V>>(deps: LineSuccessionDeps<V, O>) {
    const label = deps.label ?? 'line'
    let owner: O | null = null
    let follower: FollowedReplicatedMap<V> | null = null
    // the last snapshot known from EITHER side; demote/follow hand-overs read it
    let lastKnown: ReplicatedMapState<V> = {}
    let closed = false

    function role(): tLineSuccessionRole {
        return owner ? 'owner' : follower ? 'follower' : 'idle'
    }

    function snapshot(): ReplicatedMapState<V> {
        if (owner) return owner.control.snapshot()
        if (follower) return follower.snapshot()
        return lastKnown
    }

    function rows() {
        return Object.values(snapshot()).filter(function present(value) { return value != undefined }) as V[]
    }

    function stopFollowing() {
        if (!follower) return
        lastKnown = follower.snapshot()
        follower.close()
        follower = null
    }

    function stopOwning() {
        if (!owner) return
        lastKnown = owner.control.snapshot()
        owner.control.close()
        owner = null
    }

    /** Mirror the remote line; a previous follower or owner is let go first. */
    function follow(remote: ReplicatedMapRemote<V>) {
        if (closed) throw new Error(label + ' succession is closed')
        stopOwning()
        stopFollowing()
        follower = followReplicatedMap<V>(remote, {
            initial: lastKnown,
            ...(deps.onError ? {onError: deps.onError} : {}),
        })
        return follower.ready
    }

    /** Take the line over: the followed rows seed a fresh owned line. Idempotent while owner. */
    function promote() {
        if (closed) throw new Error(label + ' succession is closed')
        if (owner) return owner
        const seed = rows()
        stopFollowing()
        owner = deps.produce(seed)
        deps.log?.(`${label}: promoted with ${seed.length} row(s)`)
        return owner
    }

    /** Stop owning; nothing is followed until follow() — the snapshot stays readable. */
    function demote() {
        if (!owner) return
        stopOwning()
        deps.log?.(`${label}: demoted`)
    }

    /** The owned line, or a clear refusal — writes exist only on the owner. */
    function requireOwner(verb = 'write') {
        if (!owner) throw new Error(`${label}: ${verb} refused — this process does not own the line (${role()})`)
        return owner
    }

    function close() {
        if (closed) return
        closed = true
        stopFollowing()
        stopOwning()
    }

    if (deps.own) promote()

    return {
        role,
        snapshot,
        rows,
        follow,
        promote,
        demote,
        requireOwner,
        /** Current owner or null; facades that must not throw read this. */
        owner: () => owner,
        close,
    }
}
export type LineSuccession<V, O extends LineSuccessionOwner<V>> = ReturnType<typeof createLineSuccession<V, O>>
