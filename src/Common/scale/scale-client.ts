// =====================================================================
// Scale cluster client — one consumer of a scaled line, from one config object
// =====================================================================
// The client corner of the deployment triangle: follow the roster line, place
// ONCE with a sticky weighted pick (level-2 balancing, decided at the edge),
// bridge the eligible rows into replica-set offers, and let the line itself
// move gap-free by seq (level 3). Absorbs the composition every consumer used
// to hand-wire: followNodeDirectory + sticky placement + directoryReplicaOffers
// + createStoreReplicaSet.
//
// Placement semantics (proven live on the mini-scale stand): the weighted
// random pick decides the landing node and is NOT re-rolled on roster churn —
// only when the placed node loses eligibility (drain / dead / weight<=0 /
// gone) or on an explicit repick(). Spawning a node never yanks placed clients.
// Liveness is a fact the authority publishes on the row (alive); this client
// judges nothing by its own clock.
//
// The HOST owns the transport: deps.connect opens the actual session (socket
// hub or in-process fragment); this factory never sees a socket.

import {
    directoryReplicaOffers, directoryRoutePriority, followNodeDirectory, pickDirectoryNode,
    type NodeDirectoryView,
} from '../Observe/node-directory'
import type {StoreReplayRemote} from '../Observe/store-replay'
import {
    createStoreReplicaSet, type StoreLineCoordinates, type StoreReplicaLeadership, type StoreReplicaSession,
} from '../Observe/store-replica-set'

// ============================================================
// public contract
// ============================================================

export type ScaleClusterClientDeps<T extends Record<string, any>> = {
    /** Replica-line coordinates (must match the cluster's line) and the state before the first keyframe. */
    line: StoreLineCoordinates & {initial: T}
    /** The roster line — an authority's serve.browser().roster or a standalone directory's api. */
    roster: StoreReplayRemote
    /** Transport adapter: open a live session to a node; the host owns sockets. */
    connect: (view: NodeDirectoryView) => StoreReplicaSession | Promise<StoreReplicaSession>
    placement?: {
        /** Log prefix distinguishing this consumer among many (per-reader placement). */
        label?: string
        /** Full route-cost override; disables the sticky pick's priorities. */
        priorityOf?: (view: NodeDirectoryView) => number
        /** Injectable randomness for deterministic placement; default Math.random. */
        rng?: () => number
        /**
         * Even placement over the replicated readers facts: land on the node with
         * the lowest readers/weight, and voluntarily migrate off a gross overload
         * toward a clearly underloaded node (the hand-off itself stays gap-free
         * by seq). Off by default — plain sticky placement never yanks a client.
         */
        balance?: {
            /** Migrate only when the placed node's load exceeds fair share × this (default 2). */
            aboveShare?: number
            /** ...and some other node sits below fair share × this (default 0.6). */
            belowShare?: number
            /** Evaluation cadence (default 4000ms). */
            checkMs?: number
            /** Probability per check to actually move — staggers herd migrations (default 0.5). */
            moveChance?: number
            /** Quiet period after a voluntary move (default 10000ms). */
            cooldownMs?: number
        }
    }
    /** Default follower/not-eligible: a pure consumer never runs for authority. */
    leadership?: StoreReplicaLeadership
    log?: (line: string) => void
}

export function createClusterClient<T extends Record<string, any>>(deps: ScaleClusterClientDeps<T>) {
    const log = deps.log ?? console.log
    const label = deps.placement?.label ? deps.placement.label + ' ' : ''
    const rng = deps.placement?.rng
    const directory = followNodeDirectory(deps.roster)

    // ============== placement (level 2): pick WHERE to land once, stay sticky ==============
    const balance = deps.placement?.balance
    const random = rng ?? Math.random
    let placedNodeId: string | null = null

    function loadOf(view: NodeDirectoryView) {
        return Number(view.meta?.['readers'] ?? 0)
    }
    /** Emptiest eligible node by readers/weight; score ties go to the bigger capacity. */
    function pickBalanced(views: readonly NodeDirectoryView[]) {
        const eligible = views.filter(view => view.eligible)
        if (eligible.length == 0) return null
        function scoreOf(view: NodeDirectoryView) { return loadOf(view) / Math.max(view.weight, 1e-3) }
        const bestScore = Math.min(...eligible.map(scoreOf))
        const tier = eligible.filter(view => scoreOf(view) - bestScore <= 1e-9)
        const bestWeight = Math.max(...tier.map(view => view.weight))
        const finalists = tier.filter(view => view.weight >= bestWeight - 1e-9)
        return finalists[Math.min(finalists.length - 1, Math.floor(random() * finalists.length))]
    }

    // in balance mode the pick stays FLUID until the line first catches up: the
    // roster may arrive in batches, and gluing to the first visible row would
    // defeat the whole even-placement promise
    let placementSettled = !balance
    function ensurePlaced() {
        const views = directory.nodes()
        const keepPlaced = placedNodeId != null && views.some(function stillPlaced(view) {
            return view.nodeId == placedNodeId && view.eligible
        })
        if (keepPlaced && placementSettled) return placedNodeId
        const picked = balance ? pickBalanced(views) : pickDirectoryNode(views, rng ? {rng} : {})
        if (keepPlaced && (!picked || picked.nodeId == placedNodeId)) return placedNodeId
        const previous = placedNodeId
        placedNodeId = picked ? picked.nodeId : null
        if (placedNodeId && placedNodeId != previous) {
            log(`cluster client ${label}placement → ${placedNodeId} (${balance ? 'emptiest' : 'weighted'} pick)`)
        }
        return placedNodeId
    }
    // subscribed BEFORE the offers bridge, so re-derived priorities see the fresh pick
    const offRepick = directory.onNodes(function repickOnRosterChange() { ensurePlaced() })
    ensurePlaced()
    /** The placed node wins outright; everything else keeps the DEFAULT weight
     *  order as a fallback, offset behind the placement instead of re-derived. */
    function priorityOf(view: NodeDirectoryView) {
        return view.nodeId == placedNodeId ? 1 : 1000 + directoryRoutePriority(view)
    }

    // ============== offers + line: selection, hysteresis and seq hand-off stay below ==============
    const offers = directoryReplicaOffers({
        directory,
        connect: deps.connect,
        priorityOf: deps.placement?.priorityOf ?? priorityOf,
    })
    const {initial, ...coordinates} = deps.line
    const client = createStoreReplicaSet<T>({
        ...coordinates,
        lineId: coordinates.lineId ?? coordinates.nodeId + '-line',
        initial,
        leadership: deps.leadership ?? {initialRole: 'follower', eligible: false},
        offers: offers.api,
    })
    // the first catch-up freezes the fluid balance pick into the normal sticky one
    if (!placementSettled) void client.api.ready.then(function settlePlacement() { placementSettled = true })

    /** Force a fresh weighted pick NOW; the line still hands off by seq, gap-free. */
    function repick() {
        placedNodeId = null
        const picked = ensurePlaced()
        offers.refresh()
        return picked
    }

    // ============== voluntary rebalance: trickle off a gross overload ==============
    // The facts lag heartbeats, so the thresholds are wide, moves are randomly
    // staggered, and a cooldown follows every move — the goal is an even fleet
    // over tens of seconds, never a synchronized herd jump.
    let lastMoveAt = 0
    function evaluateBalance() {
        if (!balance || placedNodeId == null) return
        const now = Date.now()
        if (now - lastMoveAt < (balance.cooldownMs ?? 10_000)) return
        const views = directory.nodes().filter(view => view.eligible)
        if (views.length < 2) return
        const placed = views.find(view => view.nodeId == placedNodeId)
        if (!placed) return
        const totalLoad = views.reduce((sum, view) => sum + loadOf(view), 0)
        const totalWeight = views.reduce((sum, view) => sum + Math.max(view.weight, 0), 0)
        if (totalWeight <= 0 || totalLoad == 0) return
        // fair share floors at 0.5 so near-zero fleets do not divide into noise
        function shareOf(view: NodeDirectoryView) {
            return Math.max(totalLoad * Math.max(view.weight, 0) / totalWeight, 0.5)
        }
        if (loadOf(placed) <= (balance.aboveShare ?? 2) * shareOf(placed)) return
        const target = pickBalanced(views.filter(view => view.nodeId != placedNodeId))
        if (!target || loadOf(target) >= (balance.belowShare ?? 0.6) * shareOf(target)) return
        if (random() > (balance.moveChance ?? 0.5)) return
        lastMoveAt = now
        log(`cluster client ${label}rebalance ${placedNodeId} → ${target.nodeId} (load ${loadOf(placed)} above fair share)`)
        placedNodeId = target.nodeId
        offers.refresh()
    }
    const balanceTimer = balance ? setInterval(evaluateBalance, balance.checkMs ?? 4000) : null
    if (balanceTimer) (balanceTimer as any).unref?.()

    function close() {
        if (balanceTimer) clearInterval(balanceTimer)
        client.close()
        offers.close()
        offRepick()
        directory.close()
    }

    return {
        /** The materialized line: read state, subscribe like any Store. */
        store: client.api.store,
        /** Route/role/seq facts of the underlying replica set, as a live Store. */
        status: client.api.status,
        /** Resolves once the line has caught up through its first route. */
        ready: client.api.ready,
        placement: {
            placedNodeId: () => placedNodeId,
            repick,
        },
        view: {
            nodes: () => directory.nodes(),
            route: () => client.api.status.state.routeId,
            /** Link status of the roster line itself ({upstream, seq, error}). */
            roster: () => directory.status.state,
        },
        close,
    }
}
export type ScaleClusterClient<T extends Record<string, any> = Record<string, any>> =
    ReturnType<typeof createClusterClient<T>>
