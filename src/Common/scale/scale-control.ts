// =====================================================================
// Control line — the authority's ONE store of facts, owned or followed
// =====================================================================
// Roster, deny list and receipts are three SECTIONS of one Store served as one
// Store Replay line. A standby follows that line with createStoreFollower and
// is promoted by the follower's own promote(): the same store continues, the
// cascade journal lives on, every section is re-owned in the same instant. A
// demoted leader lets go of the line and keeps the last snapshot as the seed of
// its next follow. Browsers must not see the deny list or the receipts, so the
// roster reaches them through a PROJECTION line of the `nodes` section.
// Internal to the Scale tier: the authority and the store node are its users.

import {createStore, applyStorePatches, listenStorePatches, type Store, type StorePatch} from '../Observe/store'
import {exposeStoreReplay, type StoreReplayRemote} from '../Observe/store-replay'
import {createStoreFollower, type StoreFollower} from '../Observe/store-follower'
import type {NodeDirectoryState} from '../Observe/node-directory'
import type {CommandReceiptsState} from '../command/command-receipts'
import type {StoreNodeRevocation} from '../Observe/store-node'

// ============================================================
// public contract (types travel through the authority's facades)
// ============================================================

export type ScaleControlState = NodeDirectoryState & CommandReceiptsState & {
    revoked: Record<string, StoreNodeRevocation>
}

export function emptyControlState(): ScaleControlState {
    return {nodes: {}, revoked: {}, receipts: {}}
}

export type tControlLineRole = 'owner' | 'follower' | 'idle'

export type ControlLineDeps<S extends object> = {
    /** State of a line born owned, or the seed a first follow starts from. */
    initial: S
    /** Own the line from birth (a born leader); default: idle until follow()/promote(). */
    own?: boolean
    /** Static descriptor fields served on the line (schema/originId...). */
    describe?: Record<string, any>
    label?: string
    log?: (line: string) => void
}

// ============================================================
// succession: follow → promote → demote → follow …
// ============================================================

export function createControlLine<S extends object>(deps: ControlLineDeps<S>) {
    const label = deps.label ?? 'control line'
    const expose = deps.describe ? {describe: deps.describe} : {}
    type Owner = {store: Store<S>, api: StoreReplayRemote, close: () => void}
    let owner: Owner | null = null
    let follower: StoreFollower<S> | null = null
    // the last state known from EITHER side; a demote/follow hand-over seeds from it
    let lastKnown: S = deps.initial
    let closed = false

    function role(): tControlLineRole {
        return owner ? 'owner' : follower ? 'follower' : 'idle'
    }

    /** The live store: the owner's, the follower's, or a detached copy of the last known state. */
    let idleStore: Store<S> | null = null
    function store(): Store<S> {
        if (owner) return owner.store
        if (follower) return follower.store
        return idleStore ??= createStore<S>(lastKnown)
    }

    function stopFollowing() {
        if (!follower) return
        lastKnown = follower.store.snapshot()
        follower.close()
        follower = null
    }

    function stopOwning() {
        if (!owner) return
        lastKnown = owner.store.snapshot()
        owner.close()
        owner = null
    }

    /** Mirror the remote line; a previous follower or owner is let go first. */
    function follow(remote: StoreReplayRemote) {
        if (closed) throw new Error(label + ' is closed')
        stopOwning()
        stopFollowing()
        idleStore = null
        follower = createStoreFollower<S>({remote, initial: lastKnown, expose})
        return follower.ready
    }

    /** Take the line over: the follower's store CONTINUES as the owned line (no copy). */
    function promote() {
        if (closed) throw new Error(label + ' is closed')
        if (owner) return owner.store
        if (follower && follower.status.state.upstream != 'closed') {
            const taken = follower
            taken.promote()
            owner = {store: taken.store, api: taken.api.replay, close: taken.close}
            follower = null
        } else {
            // a follower whose link already died is terminal: its state is still the freshest we have
            stopFollowing()
            const fresh = idleStore ?? createStore<S>(lastKnown)
            idleStore = null
            const exposed = exposeStoreReplay(fresh, expose)
            owner = {store: fresh, api: exposed.api.replay, close: exposed.close}
        }
        deps.log?.(`${label}: owned`)
        return owner.store
    }

    /** Stop owning; nothing is followed until follow() — the state stays readable. */
    function demote() {
        if (!owner) return
        stopOwning()
        deps.log?.(`${label}: released`)
    }

    /** The owned line's wire, or a clear refusal — only an owner serves a line. */
    function api(verb = 'serve') {
        if (!owner) throw new Error(`${label}: ${verb} refused — this process does not own the line (${role()})`)
        return owner.api
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
        store,
        api,
        owner: () => owner != null,
        follow,
        promote,
        demote,
        /** Reactive link status while following ({upstream, seq, error}); null otherwise. */
        followStatus: () => follower?.status ?? null,
        close,
    }
}
export type ControlLine<S extends object> = ReturnType<typeof createControlLine<S>>

// ============================================================
// projection: ONE section of a store as its own line
// ============================================================

/** Serve `source.state[key]` as an independent line: browsers see the roster, never the rest. */
export function projectStoreSection<S extends object, K extends keyof S & string>(
    source: Store<S>, key: K, describe?: Record<string, any>,
) {
    type Projected = Pick<S, K>
    const projected = createStore<Projected>({[key]: source.snapshot()[key]} as Projected)
    const exposed = exposeStoreReplay(projected, describe ? {describe} : {})
    const off = listenStorePatches(source).on(function forwardSectionPatches(patches: readonly StorePatch[]) {
        const mine: StorePatch[] = []
        for (const patch of patches) {
            if (patch.path.length == 0) {
                // a whole-root replacement (reset/keyframe) carries our section inside it
                mine.push({path: [key], exists: true, value: (patch.value as any)?.[key] ?? {}})
            } else if (patch.path[0] == key) {
                mine.push(patch)
            }
        }
        if (mine.length) applyStorePatches(projected, mine)
    })
    return {
        api: exposed.api.replay as StoreReplayRemote,
        store: projected,
        close() {
            off()
            exposed.close()
        },
    }
}
