// =====================================================================
// Node directory — replicated roster of service nodes for client-side balancing
// =====================================================================
// The roster is the `nodes` section of a Store served as a Store Replay line:
// standalone the directory owns that store and its line; embedded (deps.store)
// it is a facet over a larger control store (the scale authority's), so the
// roster travels in the SAME line as the deny list and the receipts. Nodes
// register/heartbeat through a host-authorized command path, clients follow
// the line like any store and pick a node with the pure helpers below.
// Balancing therefore stays observable by construction: the ops panel and the
// balancer read the SAME store facts.
//
// Liveness is a FACT the directory owner publishes, not a judgement every
// reader makes: the owner (the one process with the relevant clock) keeps the
// last beat per row in memory, sweeps every staleMs/2 and flips `alive`. A
// replicated write happens when a fact changes — alive, readers, labels —
// never per beat, so a fleet of N nodes costs its followers nothing in steady
// state, and no reader ever compares a foreign clock against its own.
//
// Placement semantics on one line each:
//   weight > 0            node accepts placements, proportional share
//   weight <= 0           node is closed: new placements avoid it, existing move away
//   draining: true        node is leaving: same as closed, but announced as intent
//   alive: false          heartbeats stopped for staleMs: presumed dead regardless of its facts

import {compareDeepValues} from '../core/deep-equal'
import {createStore, type Store} from './store'
import {toRaw} from './reactive'
import {exposeStoreReplay, type StoreReplayOpts, type StoreReplayRemote} from './store-replay'
import {createStoreFollower, type StoreFollowerDeps} from './store-follower'
import {createStoreReplicaOffers, type StoreReplicaOffer, type StoreReplicaSession} from './store-replica-set'

// ============================================================
// public contract
// ============================================================

/** leader = the point of order · mirror = a serving node · standby = a successor-in-waiting
 *  (discoverable by url, registered with weight 0 so it is never placed). */
export type tNodeDirectoryRole = 'leader' | 'mirror' | 'standby'

export type NodeDirectoryEntry = {
    nodeId: string
    /** Client-reachable origin, e.g. http://localhost:3101. */
    url: string
    role: tNodeDirectoryRole
    /** Relative placement share; <= 0 closes the node (see semantics above). */
    weight: number
    /** true = the node is leaving; move clients away. */
    draining: boolean
    /** Published by the directory OWNER: false once heartbeats stopped for staleMs. */
    alive: boolean
    /** Owner-clock ms when `alive` last flipped (panels: "dead for 12 s"). */
    since: number
    /** Plain JSON application facts (region, version, capacity...). */
    meta?: Record<string, unknown>
}

export type NodeDirectoryView = NodeDirectoryEntry & {
    /** alive && !draining && weight > 0 — usable for serving clients. */
    eligible: boolean
}

/** The section shape the roster lives in; a control store carries it beside other sections. */
export type NodeDirectoryState = {nodes: Record<string, NodeDirectoryEntry>}

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
// owner: authority over the roster
// ============================================================

export type NodeDirectoryDeps<S extends NodeDirectoryState = NodeDirectoryState> = {
    /** Embed: the roster becomes the `nodes` section of THIS store (the caller serves the line). */
    store?: Store<S>
    now?: () => number
    /** Silence above which a row is published dead; default 15 s, 0 disables the sweep. */
    staleMs?: number
    /** Sweep cadence; default staleMs / 2. */
    sweepMs?: number
    /** Seed rows (standalone only) — ts-free: every seed starts alive with a fresh beat. */
    initial?: Iterable<NodeDirectoryEntry>
    /** Standalone replay pass-through (history/keepMs/describe). */
    replay?: Pick<StoreReplayOpts, 'history' | 'keepMs' | 'describe'>
}

/** A row as callers write it: liveness fields belong to the directory. */
export type NodeDirectoryRow = Omit<NodeDirectoryEntry, 'alive' | 'since' | 'draining'> & {draining?: boolean}

export function createNodeDirectory<S extends NodeDirectoryState = NodeDirectoryState>(deps: NodeDirectoryDeps<S> = {}) {
    const {now = Date.now} = deps
    const staleMs = deps.staleMs ?? NODE_DIRECTORY_STALE_MS
    const owned = !deps.store
    // the section facet only ever touches .nodes; the wider control store stays the caller's
    const store: Store<NodeDirectoryState> = (deps.store as Store<NodeDirectoryState> | undefined) ?? createStore<NodeDirectoryState>({nodes: {}})
    const exposed = owned ? exposeStoreReplay(store, {
        ...deps.replay,
        describe: {...deps.replay?.describe, nodeDirectory: {version: 2}},
    }) : null

    // beats are OWNER memory, never replicated: the line carries the verdict (alive), not the pulse
    const lastBeat = new Map<string, number>()
    let closed = false

    /** Writes go through the reactive state... */
    function rows() {
        return store.state.nodes
    }
    /** ...reads come from the RAW rows: spreading a reactive proxy back into the store would nest it. */
    function rawRows(): Record<string, NodeDirectoryEntry> {
        return toRaw(store.state).nodes
    }
    /** Read-only row (do not mutate; write through set/patch). */
    function get(nodeId: string) {
        return rawRows()[requireNodeId(nodeId)] as NodeDirectoryEntry | undefined
    }
    function snapshot(): Record<string, NodeDirectoryEntry> {
        return store.snapshot().nodes
    }

    /** Register or REPLACE a row; it starts alive with a fresh beat. */
    function set(row: NodeDirectoryRow) {
        const moment = now()
        const current = get(row.nodeId)
        const entry: NodeDirectoryEntry = requireEntry({
            draining: false, ...row,
            alive: true,
            since: current?.alive ? current.since : moment,
        })
        lastBeat.set(entry.nodeId, moment)
        if (!current || !compareDeepValues(current, entry)) rows()[entry.nodeId] = entry
    }

    /** Merge facts into a known row (meta merges one level); false = not registered.
     *  Writes only when something actually changes. */
    function patch(nodeId: string, partial: Partial<Omit<NodeDirectoryEntry, 'nodeId' | 'alive' | 'since'>>) {
        const current = get(nodeId)
        if (!current) return false
        const meta = partial.meta ? {...current.meta, ...partial.meta} : current.meta
        const next = requireEntry({...current, ...partial, ...(meta ? {meta} : {}), nodeId, alive: current.alive, since: current.since})
        if (!compareDeepValues(current, next)) rows()[nodeId] = next
        return true
    }

    /** The node is alive now (+ optional facts). false = not registered. */
    function heartbeat(nodeId: string, partial: Parameters<typeof patch>[1] = {}) {
        const current = get(nodeId)
        if (!current) return false
        lastBeat.set(nodeId, now())
        if (!current.alive) rows()[nodeId] = {...current, alive: true, since: now()}
        return patch(nodeId, partial)
    }

    function drain(nodeId: string) {
        return patch(nodeId, {draining: true})
    }

    function undrain(nodeId: string, weight?: number) {
        return patch(nodeId, weight == undefined ? {draining: false} : {draining: false, weight})
    }

    function remove(nodeId: string) {
        requireNodeId(nodeId)
        lastBeat.delete(nodeId)
        if (rawRows()[nodeId]) delete rows()[nodeId]
    }

    /** Every row gets a fresh beat — a promoted owner grants the fleet staleMs to re-home. */
    function grace() {
        const moment = now()
        for (const nodeId of Object.keys(rawRows())) lastBeat.set(nodeId, moment)
    }

    /** Publish the verdict for rows whose pulse stopped. */
    function sweep() {
        if (staleMs <= 0) return
        const moment = now()
        for (const nodeId of Object.keys(rawRows())) {
            const entry = rawRows()[nodeId]
            if (!entry || !entry.alive) continue
            const beat = lastBeat.get(nodeId)
            if (beat == undefined) { lastBeat.set(nodeId, moment); continue }
            if (moment - beat > staleMs) rows()[nodeId] = {...entry, alive: false, since: moment}
        }
    }
    const sweeper = staleMs > 0 ? setInterval(sweep, deps.sweepMs ?? Math.max(50, Math.floor(staleMs / 2))) : null
    ;(sweeper as any)?.unref?.()

    function flush() {
        exposed?.flushPending()
    }

    function close() {
        if (closed) return
        closed = true
        if (sweeper) clearInterval(sweeper)
        exposed?.close()
    }

    if (deps.initial) for (const row of deps.initial) set(row)

    return {
        /** Store Replay line over {nodes} — standalone only; embedded rosters ride the caller's line. */
        api: (exposed?.api.replay ?? null) as StoreReplayRemote | null,
        control: {
            set,
            patch,
            heartbeat,
            drain,
            undrain,
            remove,
            grace,
            sweep,
            get,
            snapshot,
            flush,
            close,
        },
        view: {
            nodes: () => nodeDirectoryViews(snapshot()),
        },
        /** The store the roster lives in (the caller's, when embedded). */
        store,
        close,
    }
}
export type NodeDirectory = ReturnType<typeof createNodeDirectory>

// ============================================================
// pure reader helpers — one derivation, shared by balancer and panels
// ============================================================

export function nodeDirectoryViews(state: Readonly<Record<string, NodeDirectoryEntry | undefined>>) {
    const views: NodeDirectoryView[] = []
    for (const nodeId of Object.keys(state)) {
        const entry = state[nodeId]
        if (!entry) continue
        views.push({...entry, eligible: entry.alive && !entry.draining && entry.weight > 0})
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
// client: follow facade over the roster line
// ============================================================

export type FollowNodeDirectoryOpts = Pick<StoreFollowerDeps<NodeDirectoryState>, 'initial' | 'staleMs' | 'expose'>

/** Follow a roster line — a standalone directory's api or an authority's nodes projection. */
export function followNodeDirectory(remote: StoreReplayRemote, opts: FollowNodeDirectoryOpts = {}) {
    const follower = createStoreFollower<NodeDirectoryState>({
        remote,
        initial: opts.initial ?? {nodes: {}},
        ...(opts.staleMs != undefined ? {staleMs: opts.staleMs} : {}),
        ...(opts.expose ? {expose: opts.expose} : {}),
    })

    function nodes() {
        return nodeDirectoryViews(follower.store.snapshot().nodes ?? {})
    }

    function pick(pickOpts: PickDirectoryNodeOpts = {}) {
        return pickDirectoryNode(nodes(), pickOpts)
    }

    /** Fires once per applied change batch with the fresh views. */
    function onNodes(cb: (views: NodeDirectoryView[]) => void) {
        return follower.store.node.at('nodes').on(function forwardRosterChange() { cb(nodes()) })
    }

    /** Watch ONE row; cb(entry | undefined). `current` fires immediately with the present state. */
    function onNode(nodeId: string, cb: (entry: NodeDirectoryEntry | undefined) => void, watchOpts: {current?: boolean} = {}) {
        return follower.store.node.at('nodes').at(nodeId).on(function forwardRowChange(value) {
            cb(value as NodeDirectoryEntry | undefined)
        }, watchOpts)
    }

    return {
        nodes,
        pick,
        onNodes,
        onNode,
        ready: follower.ready,
        /** Reactive link status of the roster line: {upstream, seq, error}. */
        status: follower.status,
        isStale: follower.isStale,
        /** Cascade line: a node may re-serve the roster it follows. */
        api: follower.api,
        store: follower.store,
        close: follower.close,
    }
}
export type FollowedNodeDirectory = ReturnType<typeof followNodeDirectory>

// ============================================================
// bridge: directory facts -> replica-set offers
// ============================================================
// Route selection, hysteresis and the seq-resume hand-off stay in
// createStoreReplicaSet; this adapter only keeps its offer list equal to the
// eligible directory rows. Removing an offer (drain / weight<=0 / dead / gone)
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

/** Default route price for a directory row: higher weight = cheaper. The ONE
 *  weight→priority mapping — consumers layering their own ordering (e.g. the
 *  cluster client's sticky placement) offset THIS instead of re-deriving it. */
export function directoryRoutePriority(view: Pick<NodeDirectoryView, 'weight'>) {
    return Math.round(1000 / Math.max(view.weight, 1e-3))
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
            priority: deps.priorityOf?.(view) ?? directoryRoutePriority(view),
            connect: entry.connect,
        }
    }

    let lastSignature = ''
    function syncOffers(views: readonly NodeDirectoryView[]) {
        const wanted = views.filter(function usable(view) { return view.eligible })
        const wantedIds = new Set(wanted.map(function idOf(view) { return view.nodeId }))
        for (const nodeId of [...stable.keys()]) {
            if (!wantedIds.has(nodeId)) stable.delete(nodeId)
        }
        // offerOf runs for every wanted row regardless: it refreshes the view the
        // stable connect closure reads, even when the list itself does not change
        const offers = wanted.map(offerOf)
        // a fact change that alters no membership and no price (readers, labels) —
        // skip the replace, or every follower re-reconciles an identical list
        const signature = offers.map(function priceOf(offer) { return offer.id + '@' + offer.priority }).join('|')
        if (signature == lastSignature) return
        lastSignature = signature
        source.control.replace(offers)
    }

    const offNodes = deps.directory.onNodes(syncOffers)
    syncOffers(deps.directory.nodes())

    return {
        api: source.api,
        /** Re-derive offers now (e.g. after a placement decision changed the prices). */
        refresh() { syncOffers(deps.directory.nodes()) },
        close() {
            offNodes()
            source.control.clear()
        },
    }
}
export type DirectoryReplicaOffers = ReturnType<typeof directoryReplicaOffers>
