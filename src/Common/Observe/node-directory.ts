// =====================================================================
// Node directory — replicated roster of service nodes for client-side balancing
// =====================================================================
// The directory is an ordinary latest-delivery replicated map keyed by nodeId:
// the host (usually the leader) owns it, nodes register/heartbeat through a
// host-authorized command path, clients follow it like any replicated map and
// pick a node with the pure helpers below. Balancing therefore stays observable
// by construction: the ops panel and the balancer read the SAME store facts.
//
// Placement semantics on one line each:
//   weight > 0            node accepts placements, proportional share
//   weight <= 0           node is closed: new placements avoid it, existing move away
//   draining: true        node is leaving: same as closed, but announced as intent
//   heartbeat older than staleMs   node is presumed dead regardless of its facts

import {createReplicatedMap, followReplicatedMap, FollowReplicatedMapOpts, ReplicatedMapRemote, ReplicatedMapState, tReplicatedMapDelivery} from './replicated-map'
import {createStoreReplicaOffers, StoreReplicaOffer, StoreReplicaSession} from './store-replica-set'

// ============================================================
// public contract
// ============================================================

export type tNodeDirectoryRole = 'leader' | 'mirror'

export type NodeDirectoryEntry = {
    nodeId: string
    /** Client-reachable origin, e.g. http://localhost:3101. */
    url: string
    role: tNodeDirectoryRole
    /** Relative placement share; <= 0 closes the node (see semantics above). */
    weight: number
    /** true = the node is leaving; move clients away. */
    draining: boolean
    /** Host-clock ms of the last heartbeat; readers derive staleness. */
    ts: number
    /** Plain JSON application facts (region, version, capacity...). */
    meta?: Record<string, unknown>
}

export type NodeDirectoryView = NodeDirectoryEntry & {
    stale: boolean
    /** !stale && !draining && weight > 0 — usable for serving clients. */
    eligible: boolean
}

export const NODE_DIRECTORY_STALE_MS = 15_000

function requireNodeId(value: unknown) {
    if (typeof value != 'string' || value.length == 0) throw new TypeError('node directory nodeId must be a non-empty string')
    return value
}

function requireEntry(entry: NodeDirectoryEntry) {
    requireNodeId(entry.nodeId)
    if (typeof entry.url != 'string') throw new TypeError('node directory url must be a string')
    if (!Number.isFinite(entry.weight)) throw new TypeError('node directory weight must be a finite number')
    return entry
}

// ============================================================
// host: authority over the roster
// ============================================================

export type NodeDirectoryDeps = {
    now?: () => number
    /** Stable replay identity only when the same journal is durably restored. */
    lineId?: string
    /** Advanced replicated-map replay pass-through (history/keepMs/describe). */
    replay?: {history?: number, keepMs?: number, describe?: Record<string, any>}
}

export function createNodeDirectory(deps: NodeDirectoryDeps = {}) {
    const {now = Date.now} = deps
    const map = createReplicatedMap<NodeDirectoryEntry>({
        keyOf(entry) { return entry.nodeId },
        delivery: 'latest' satisfies tReplicatedMapDelivery,
        ...(deps.lineId != undefined ? {lineId: deps.lineId} : {}),
        ...(deps.replay ? {replay: deps.replay} : {}),
    })

    /** Register or replace a node; ts is stamped by the directory clock. */
    function upsert(entry: Omit<NodeDirectoryEntry, 'ts' | 'draining'> & {draining?: boolean}) {
        map.control.set(requireEntry({draining: false, ...entry, ts: now()}))
    }

    /** Refresh liveness (and optionally facts) of a known node; false = node is not registered. */
    function heartbeat(nodeId: string, patch: Partial<Omit<NodeDirectoryEntry, 'nodeId' | 'ts'>> = {}) {
        const current = map.control.get(requireNodeId(nodeId))
        if (!current) return false
        map.control.set(requireEntry({...current, ...patch, nodeId, ts: now()}))
        return true
    }

    function drain(nodeId: string) {
        return heartbeat(nodeId, {draining: true})
    }

    function undrain(nodeId: string, weight?: number) {
        return heartbeat(nodeId, weight == undefined ? {draining: false} : {draining: false, weight})
    }

    function remove(nodeId: string) {
        map.control.delete(requireNodeId(nodeId))
    }

    return {
        /** Store Replay fragment — spread into the RPC object like any replicated map. */
        api: map.api,
        control: {
            upsert,
            heartbeat,
            drain,
            undrain,
            remove,
            get: map.control.get,
            snapshot: map.control.snapshot,
            flush: map.control.flush,
            close: map.control.close,
        },
    }
}
export type NodeDirectory = ReturnType<typeof createNodeDirectory>

// ============================================================
// pure reader helpers — one derivation, shared by balancer and panels
// ============================================================

export type NodeDirectoryViewOpts = {
    /** Heartbeat age above which a node is presumed dead; 0 disables the check. */
    staleMs?: number
    now?: () => number
}

export function nodeDirectoryViews(
    state: Readonly<ReplicatedMapState<NodeDirectoryEntry>>,
    opts: NodeDirectoryViewOpts = {},
) {
    const {staleMs = NODE_DIRECTORY_STALE_MS, now = Date.now} = opts
    const moment = now()
    const views: NodeDirectoryView[] = []
    for (const nodeId of Object.keys(state)) {
        const entry = state[nodeId]
        if (!entry) continue
        const stale = staleMs > 0 && moment - entry.ts > staleMs
        views.push({...entry, stale, eligible: !stale && !entry.draining && entry.weight > 0})
    }
    return views
}

export type PickDirectoryNodeOpts = {
    exclude?: string | readonly string[]
    /** Injectable randomness for deterministic tests; default Math.random. */
    rng?: () => number
}

/** Weighted-random pick among eligible nodes; null = nothing to place on. */
export function pickDirectoryNode(views: readonly NodeDirectoryView[], opts: PickDirectoryNodeOpts = {}) {
    const excluded = new Set(typeof opts.exclude == 'string' ? [opts.exclude] : opts.exclude ?? [])
    const eligible = views.filter(function placeable(view) {
        return view.eligible && !excluded.has(view.nodeId)
    })
    if (eligible.length == 0) return null
    const total = eligible.reduce(function sumWeights(sum, view) { return sum + view.weight }, 0)
    let roll = (opts.rng ?? Math.random)() * total
    for (const view of eligible) {
        roll -= view.weight
        if (roll < 0) return view
    }
    return eligible[eligible.length - 1]
}

// ============================================================
// client: follow facade over the replicated map
// ============================================================

export type FollowNodeDirectoryOpts = NodeDirectoryViewOpts & Pick<
    FollowReplicatedMapOpts<NodeDirectoryEntry>,
    'initial' | 'drain' | 'onStatus' | 'onError'
>

export function followNodeDirectory(
    remote: ReplicatedMapRemote<NodeDirectoryEntry>,
    opts: FollowNodeDirectoryOpts = {},
) {
    const {staleMs, now, ...followOpts} = opts
    const viewOpts = {
        ...(staleMs != undefined ? {staleMs} : {}),
        ...(now ? {now} : {}),
    }
    const follow = followReplicatedMap<NodeDirectoryEntry>(remote, followOpts)

    /** Staleness is derived at READ time; onNodes fires on data changes only. */
    function nodes() {
        return nodeDirectoryViews(follow.snapshot(), viewOpts)
    }

    function pick(pickOpts: PickDirectoryNodeOpts = {}) {
        return pickDirectoryNode(nodes(), pickOpts)
    }

    function onNodes(cb: (views: NodeDirectoryView[]) => void) {
        return follow.batches.on(function forwardDirectoryChange() { cb(nodes()) })
    }

    return {
        nodes,
        pick,
        onNodes,
        ready: follow.ready,
        status: follow.status,
        statusChanges: follow.statusChanges,
        isStale: follow.isStale,
        close: follow.close,
        /** Full replicated-map surface for advanced consumers (checkpoint, onKey...). */
        follow,
    }
}
export type FollowedNodeDirectory = ReturnType<typeof followNodeDirectory>

// ============================================================
// bridge: directory facts -> replica-set offers
// ============================================================
// Route selection, hysteresis and the seq-resume hand-off stay in
// createStoreReplicaSet; this adapter only keeps its offer list equal to the
// eligible directory rows. Removing an offer (drain / weight<=0 / stale / gone)
// makes the replica set leave that node and resume elsewhere by seq — lossless.

export type DirectoryReplicaOffersDeps = {
    directory: Pick<FollowedNodeDirectory, 'nodes' | 'onNodes'>
    /** Open a live session to a node (socket hub or in-process fragment). */
    connect: (node: NodeDirectoryView) => StoreReplicaSession | Promise<StoreReplicaSession>
    /** Route cost per node; default prefers higher weight. Re-sampled on every directory
     *  change and on refresh(), and the replica set adopts the new price for a surviving
     *  offer — placement/balance moves speak through exactly this seam. */
    priorityOf?: (node: NodeDirectoryView) => number
}

export function directoryReplicaOffers(deps: DirectoryReplicaOffersDeps) {
    const source = createStoreReplicaOffers()
    // connect identity must stay stable per nodeId, or every directory change would
    // bounce live sessions (setOffers reconciles by the connect reference).
    const stable = new Map<string, {view: NodeDirectoryView, connect: StoreReplicaOffer['connect']}>()

    function offerOf(view: NodeDirectoryView): StoreReplicaOffer {
        let entry = stable.get(view.nodeId)
        if (!entry) {
            const created = {
                view,
                connect: function connectDirectoryNode() { return deps.connect(created.view) },
            }
            stable.set(view.nodeId, created)
            entry = created
        }
        entry.view = view
        return {
            id: view.nodeId,
            priority: deps.priorityOf?.(view) ?? Math.round(1000 / Math.max(view.weight, 1e-3)),
            connect: entry.connect,
        }
    }

    function syncOffers(views: readonly NodeDirectoryView[]) {
        const wanted = views.filter(function usable(view) { return view.eligible })
        for (const nodeId of [...stable.keys()]) {
            if (!wanted.some(function still(view) { return view.nodeId == nodeId })) stable.delete(nodeId)
        }
        source.control.replace(wanted.map(offerOf))
    }

    const offNodes = deps.directory.onNodes(syncOffers)
    syncOffers(deps.directory.nodes())

    return {
        api: source.api,
        /** Re-derive offers now (e.g. after a staleness clock step in tests). */
        refresh() { syncOffers(deps.directory.nodes()) },
        close() {
            offNodes()
            source.control.clear()
            stable.clear()
        },
    }
}
export type DirectoryReplicaOffers = ReturnType<typeof directoryReplicaOffers>
