// =====================================================================
// store follower — server mirror of the authoritative store (leader → follower)
// =====================================================================
// Follower is a regular replay-client of the leader, which is itself a server:
// syncStoreReplay pulls keyframe and deltas into the local store, and the cascading
// exposeStoreReplay distributes the SAME state to its own subscribers — one
// mechanism on both hops (leader → follower → browser). Follower commands
// are NOT applied locally: they are forwarded to the leader by the connection owner
// (application layer) — the only order point remains at the leader.
// Upstream status is a small separate reactive store: nothing local is written to the mirror store,
// otherwise it will diverge from the leader.

import {createStore} from './store'
import {exposeStoreReplay, syncStoreReplay, StoreReplayOpts, StoreReplayRemote, tStoreReplayMode} from './store-replay'
import {getRpcTransportLifecycle} from '../events/transport-lifecycle'
import {deepEqual} from '../core/common'

export type tFollowerUpstream = 'catching-up' | 'live' | 'offline' | 'promoted' | 'closed'

export type FollowerStatus = {
    upstream: tFollowerUpstream
    /** Last applied seq of the leader — reconnect point and measure of lag. */
    seq: number
    /** Coordinate space of seq; persist and compare it together with seq. */
    replayMode?: tStoreReplayMode
    /** Epoch of the line: for a follower — epoch of its leader, after promote — own (+1). */
    epoch: number
    /** Text of terminal subscription error (when upstream == 'closed'). */
    error: string | null
}

export type StoreFollowerDeps<T extends object> = {
    /** Replay wire of the leader — RPC projection of exposeStoreReplay(...).api.replay. */
    remote: StoreReplayRemote
    /** State before the first keyframe (usually {}). */
    initial?: T
    /** Cascade journal options for OWN subscribers (history/getSince/...). */
    expose?: StoreReplayOpts
    /** Upstream staleness threshold, ms — passed to replay subscription as staleMs. */
    staleMs?: number
    /** Epoch of the upstream leader (fork-choice on failover): promote() returns epoch + 1. */
    epoch?: number
}

function errorText(error: unknown) {
    if (typeof (error as any)?.message == 'string') return (error as any).message
    return String(error)
}

export function createStoreFollower<T extends object>(deps: StoreFollowerDeps<T>) {
    const store = createStore<T>((deps.initial ?? {}) as T)
    const status = createStore<FollowerStatus>({
        upstream: 'catching-up', seq: -1, replayMode: 'v2', epoch: deps.epoch ?? 0, error: null,
    })

    function setUpstream(next: tFollowerUpstream) {
        // promoted and closed — terminal roles: late transport events do not change them
        if (status.state.upstream == 'closed' || status.state.upstream == 'promoted') return
        if (status.state.upstream != next) status.state.upstream = next
    }

    // ============== mirroring: leader → local store ==============
    const sub = syncStoreReplay(store, deps.remote, {
        onSeq: function trackUpstreamSeq(seq) {
            status.state.seq = seq
            status.state.replayMode = sub.mode
        },
        onLive: function upstreamLive() { setUpstream('live') },
        onError: function upstreamFailed(error) {
            status.state.error = errorText(error)
            status.state.upstream = 'closed'
        },
        ...(deps.staleMs != null ? {staleMs: deps.staleMs} : {}),
    })

    // ============== link status: transport lifecycle of RPC proxy ==============
    const lifecycle = getRpcTransportLifecycle(deps.remote)
    const offDisconnect = lifecycle?.onDisconnect(function upstreamGone() {
        setUpstream('offline')
    }) ?? function noDisconnectListener() {}
    const offConnect = lifecycle?.onConnect(function upstreamBack() {
        setUpstream('catching-up')
    }) ?? function noConnectListener() {}

    // ============== cascade: the same store — replay source for own clients ==============
    const exposeOpts = deps.expose ?? {}
    const exposed = exposeStoreReplay(store, exposeOpts)

    // ============== manual promotion (failover, phase 4 of plan) ==============
    // Mirroring stops, state remains as is, and the CASCADE
    // journal continues to live — subscribers of this node do not notice the role change:
    // their line and seq are continuous. Next, the application builds authority OVER THIS SAME
    // store (commands write to it → cascade distributes). Epoch grows by 1 —
    // simple fork-choice rule "larger epoch wins", no choices.
    let promoted = false
    function promote() {
        if (status.state.upstream == 'closed') throw new Error('store follower is closed')
        if (!promoted) {
            promoted = true
            offConnect()
            offDisconnect()
            sub()
            status.state.upstream = 'promoted'
            status.state.epoch = (deps.epoch ?? 0) + 1
        }
        return {store, replay: exposed.replay, epoch: status.state.epoch}
    }

    return {
        /** Mirror store — local reads/subscriptions on the follower instance. */
        store,
        /** Reactive upstream status: {upstream, seq, error} — regular store. */
        status,
        /** Upstream staleness now (requires staleMs in deps). */
        isStale: sub.isStale,
        /** Cascade wire facade for OWN clients — placed in RPC server object. */
        api: exposed.api,
        /** Local replay line of cascade — introspection, in-proc consumers. */
        replay: exposed.replay,
        /** End of first catch-up from leader (or terminal error/teardown). */
        ready: sub.ready,
        /** Manual promotion to leader: stop mirroring, epoch+1, cascade continues. */
        promote,
        close() {
            offConnect()
            offDisconnect()
            sub()
            exposed.close()
            if (status.state.upstream != 'closed') status.state.upstream = 'closed'
        },
    }
}

export type StoreFollower<T extends object> = ReturnType<typeof createStoreFollower<T>>

// =====================================================================
// Split-brain conflict log: diff of two keyed-states after failover
// =====================================================================
// When the old leader returns after mirror promotion, its diverging
// tail is NOT discarded: localOnly — entries that the winner does not have
// (candidates for re-execution with regular commands — analog of returning transactions
// of orphaned branch to mempool), conflicts — both sides changed one entry
// differently (winner already chosen by epoch; pair is saved for the application),
// authorityOnly — arrives with keyframe upon accepting the follower role.

export type KeyedConflict<T> = {key: string, local: T, authority: T}

export function diffKeyedState<T extends object>(local: Record<string, T>, authority: Record<string, T>) {
    const localOnly: T[] = []
    const authorityOnly: T[] = []
    const conflicts: KeyedConflict<T>[] = []
    for (const [key, value] of Object.entries(local)) {
        const winner = authority[key]
        if (winner === undefined) localOnly.push(value)
        else if (!deepEqual(value, winner)) conflicts.push({key, local: value, authority: winner})
    }
    for (const [key, value] of Object.entries(authority)) {
        if (local[key] === undefined) authorityOnly.push(value)
    }
    return {localOnly, authorityOnly, conflicts}
}
