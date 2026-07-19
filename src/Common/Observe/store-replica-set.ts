// =====================================================================
// Store replica set — dynamic sources, authority reconciliation and routes
// =====================================================================
// A replica set is above transports and replay. Offers are capabilities to
// open sessions; sessions expose a descriptor, a replay line and an optional
// ping. The controller owns connection retries, authority choice and route
// hand-off. Store/replay stays the only data replication mechanism.

import {deepEqual} from '../core/common'
import {listen} from '../events/Listen'
import {ReplayRemote} from '../events/replay-wire'
import {createStore, Store, StorePatch} from './store'
import {exposeStoreReplay, StoreReplayOpts, syncStoreReplayRoute} from './store-replay'
import {diffKeyedState} from './store-follower'

export type tStoreReplicaRole = 'leader' | 'follower' | 'offline' | 'electing' | 'reconciling' | 'closed'
export type tStoreReplicaRouteState = 'connecting' | 'open' | 'failed' | 'rejected' | 'closed'

export type StoreReplicaDescriptor = {
    protocol: 1
    storeId: string
    originId: string
    /** Stable identity of the physical participant. */
    nodeId: string
    /** Identity of this participant's replay sequence space; changes on a cold restart. */
    lineId: string
    /** Current canonical writer, or null while this node has no authority. */
    leaderId: string | null
    epoch: number
    role: 'leader' | 'follower' | 'candidate'
    /** Sequence space of the current authority, propagated through cascades. */
    authorityLineId: string | null
    authoritySeq: number
    /** Measured end-to-end route cost from the authority to this node. */
    authorityCost: number | null
    /** Authority-to-node path. A route containing the local node is a cycle and is ignored. */
    path: string[]
    /** Head of this node's own cascading replay line. */
    headSeq: number
    /** Opaque election certificate/lease token interpreted by injected policy. */
    proof?: unknown
}

export type StoreReplicaRemote = {
    descriptor: () => StoreReplicaDescriptor | Promise<StoreReplicaDescriptor>
    changed?: {on: (cb: (descriptor?: StoreReplicaDescriptor) => void) => any}
    replay: ReplayRemote<[StorePatch]>
    /** The return value is opaque; elapsed wall time is the route sample. */
    ping?: () => unknown | Promise<unknown>
}

export type StoreReplicaSession = {
    remote: StoreReplicaRemote
    close: () => void
    onFail?: {on: (cb: (reason?: unknown) => void) => any}
}

/** A reusable connection capability, not a live connection. */
export type StoreReplicaOffer = {
    id: string
    connect: () => StoreReplicaSession | Promise<StoreReplicaSession>
    /** Additive route cost in milliseconds; lower is preferred. */
    priority?: number
}

export type StoreReplicaOfferSource = {
    list: () => readonly StoreReplicaOffer[]
    changes: {on: (cb: (offers: readonly StoreReplicaOffer[]) => void) => any}
}

export type StoreReplicaRouteStatus = {
    id: string
    state: tStoreReplicaRouteState
    nodeId: string | null
    leaderId: string | null
    epoch: number | null
    lineId: string | null
    authoritySeq: number
    path: string[]
    rtt: number | null
    cost: number | null
    error: string | null
}

export type StoreReplicaSetStatus = {
    role: tStoreReplicaRole
    nodeId: string
    leaderId: string | null
    epoch: number
    authorityLineId: string | null
    authoritySeq: number
    authorityCost: number | null
    path: string[]
    routeId: string | null
    routeNodeId: string | null
    rtt: number | null
    conflicts: number
    error: string | null
    routes: Record<string, StoreReplicaRouteStatus>
}

export type StoreReplicaConflict<T extends object> = {
    detectedAt: number
    local: StoreReplicaDescriptor
    authority: StoreReplicaDescriptor
    localState: T
    authorityState: T
    diff: ReturnType<typeof diffKeyedState<any>>
}

export type StoreReplicaRouteEvent = {
    from: string | null
    to: string | null
    reason: string
    rtt: number | null
}

export type StoreReplicaElectionContext = {
    storeId: string
    originId: string
    nodeId: string
    maxEpoch: number
    candidates: StoreReplicaDescriptor[]
}

export type StoreReplicaLeadership = {
    initialRole?: 'leader' | 'follower'
    epoch?: number
    proof?: unknown
    /** Omit to disable automatic promotion. */
    autoPromoteMs?: number
    eligible?: boolean
    /** Omit for availability mode: max observed epoch + 1. Return null when quorum is absent. */
    elect?: (ctx: StoreReplicaElectionContext) =>
        {epoch: number, proof?: unknown} | null | Promise<{epoch: number, proof?: unknown} | null>
    /** Positive means a is the preferred authority. Default: epoch, then leaderId. */
    compare?: (a: StoreReplicaDescriptor, b: StoreReplicaDescriptor) => number
    /** Validate an opaque proof/certificate before a descriptor enters authority choice. */
    accept?: (descriptor: StoreReplicaDescriptor) => boolean | Promise<boolean>
}

export type StoreReplicaRoutePolicy = {
    probeIntervalMs?: number
    reconnectMs?: number
    pingTimeoutMs?: number
    /** A new route must beat the current one by this many milliseconds. */
    hysteresisMs?: number
}

export type StoreReplicaSetDeps<T extends object> = {
    storeId: string
    originId: string
    nodeId: string
    lineId?: string
    store?: Store<T>
    initial?: T
    expose?: StoreReplayOpts
    offers?: StoreReplicaOfferSource
    leadership?: StoreReplicaLeadership
    route?: StoreReplicaRoutePolicy
    now?: () => number
}

function errorText(error: unknown) {
    if (typeof (error as any)?.message == 'string') return (error as any).message
    return String(error)
}

function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

function requiredId(value: unknown, label: string) {
    if (typeof value != 'string' || !value.trim()) throw new Error('store replica set: ' + label + ' is required')
    return value.trim()
}

function defaultAuthorityCompare(a: StoreReplicaDescriptor, b: StoreReplicaDescriptor) {
    if (a.epoch != b.epoch) return a.epoch - b.epoch
    const leaderOrder = (a.leaderId ?? '').localeCompare(b.leaderId ?? '')
    if (leaderOrder) return leaderOrder
    return (a.authorityLineId ?? '').localeCompare(b.authorityLineId ?? '')
}

function sameAuthority(a: StoreReplicaDescriptor | null, b: StoreReplicaDescriptor | null) {
    return !!a && !!b && a.originId == b.originId && a.epoch == b.epoch && a.leaderId == b.leaderId &&
        a.authorityLineId == b.authorityLineId
}

function keyframeState<T extends object>(value: Awaited<ReturnType<ReplayRemote<[StorePatch]>['keyframe']>>) {
    const patch = value?.event?.[0]
    if (!patch || patch.path.length || !patch.exists || patch.value == null || typeof patch.value != 'object') return null
    return patch.value as T
}

function timer(delay: number, run: () => void) {
    const handle = setTimeout(run, delay)
    ;(handle as any).unref?.()
    return handle
}

// =====================================================================
// Dynamic offer registry — useful when discovery itself is another stream
// =====================================================================

export function createStoreReplicaOffers(initial: readonly StoreReplicaOffer[] = []) {
    const offers = new Map<string, StoreReplicaOffer>()
    const [emitChanges, changes] = listen<[readonly StoreReplicaOffer[]]>()

    function publish() {
        emitChanges(Array.from(offers.values()))
    }

    function upsert(offer: StoreReplicaOffer) {
        const id = requiredId(offer.id, 'offer id')
        offers.set(id, {...offer, id})
        publish()
        return function removeThisOffer() {
            if (offers.get(id)?.connect != offer.connect) return
            offers.delete(id)
            publish()
        }
    }

    function replace(next: readonly StoreReplicaOffer[]) {
        offers.clear()
        for (const offer of next) offers.set(requiredId(offer.id, 'offer id'), offer)
        publish()
    }

    replace(initial)
    return {
        control: {
            upsert,
            remove(id: string) {
                if (!offers.delete(id)) return false
                publish()
                return true
            },
            replace,
            clear() {
                if (!offers.size) return
                offers.clear()
                publish()
            },
        },
        api: {
            list: () => Array.from(offers.values()),
            changes,
        },
    }
}

export type StoreReplicaOffers = ReturnType<typeof createStoreReplicaOffers>

// =====================================================================
// Replica-set controller
// =====================================================================

export function createStoreReplicaSet<T extends object>(deps: StoreReplicaSetDeps<T>) {
    const storeId = requiredId(deps.storeId, 'storeId')
    const originId = requiredId(deps.originId, 'originId')
    const nodeId = requiredId(deps.nodeId, 'nodeId')
    const lineId = requiredId(deps.lineId ?? nodeId + ':' + Math.random().toString(36).slice(2), 'lineId')
    const now = deps.now ?? Date.now
    const leadership = deps.leadership ?? {}
    const compareAuthority = leadership.compare ?? defaultAuthorityCompare
    const reconnectMs = deps.route?.reconnectMs ?? 1000
    const pingTimeoutMs = deps.route?.pingTimeoutMs ?? 3000
    const hysteresisMs = deps.route?.hysteresisMs ?? 8
    const store = deps.store ?? createStore<T>((deps.initial ?? {}) as T)
    const exposed = exposeStoreReplay(store, deps.expose)
    const offers = new Map<string, OfferEntry>()
    const [emitDescriptor, descriptorChanges] = listen<[StoreReplicaDescriptor]>()
    const [emitConflict, conflictListen] = listen<[StoreReplicaConflict<T>]>()
    const [emitRoute, routeListen] = listen<[StoreReplicaRouteEvent]>()

    let role: tStoreReplicaRole = leadership.initialRole == 'follower' ? 'offline' : 'leader'
    let leaderId: string | null = role == 'leader' ? nodeId : null
    let epoch = leadership.epoch ?? 0
    let proof = leadership.proof
    let authorityLineId: string | null = role == 'leader' ? lineId : null
    let authoritySeq = role == 'leader' ? exposed.replay.head() : -1
    let authorityCost: number | null = role == 'leader' ? 0 : null
    let authorityPath = role == 'leader' ? [nodeId] : []
    let activeEntry: OfferEntry | null = null
    let activeDescriptor: StoreReplicaDescriptor | null = null
    let upstreamSub: ReturnType<typeof syncStoreReplayRoute<T>> | null = null
    let conflictCount = 0
    let lastError: string | null = null
    let maxObservedEpoch = epoch
    let closed = false
    let electionTimer: ReturnType<typeof setTimeout> | null = null
    let probeTimer: ReturnType<typeof setInterval> | null = null
    let reconcileScheduled = false
    let opChain: Promise<unknown> = Promise.resolve()
    let readySettled = false
    let lastPublishedDescriptor: StoreReplicaDescriptor | null = null
    let settleReady = function settleReadyLater() {}
    const ready = new Promise<void>(function waitForReplicaReady(resolve) { settleReady = resolve })

    type OfferEntry = {
        offer: StoreReplicaOffer
        generation: number
        state: tStoreReplicaRouteState
        session: StoreReplicaSession | null
        descriptor: StoreReplicaDescriptor | null
        rtt: number | null
        error: string | null
        retry: ReturnType<typeof setTimeout> | null
        offChanged: any
        offFail: any
        refreshing: Promise<void> | null
    }

    function settleReplicaReady() {
        if (readySettled || (role != 'leader' && role != 'follower')) return
        readySettled = true
        settleReady()
    }

    function descriptor(): StoreReplicaDescriptor {
        return {
            protocol: 1,
            storeId,
            originId,
            nodeId,
            lineId,
            leaderId,
            epoch,
            role: role == 'leader' ? 'leader' : role == 'follower' ? 'follower' : 'candidate',
            authorityLineId,
            authoritySeq,
            authorityCost,
            path: [...authorityPath],
            headSeq: exposed.replay.head(),
            ...(proof !== undefined ? {proof} : {}),
        }
    }

    function routeSnapshot(entry: OfferEntry): StoreReplicaRouteStatus {
        const source = entry.descriptor
        return {
            id: entry.offer.id,
            state: entry.state,
            nodeId: source?.nodeId ?? null,
            leaderId: source?.leaderId ?? null,
            epoch: source?.epoch ?? null,
            lineId: source?.lineId ?? null,
            authoritySeq: source?.authoritySeq ?? -1,
            path: source ? [...source.path] : [],
            rtt: entry.rtt,
            cost: source?.authorityCost != null && entry.rtt != null ? routeCost(entry) : null,
            error: entry.error,
        }
    }

    function publishStatus() {
        const routes: Record<string, StoreReplicaRouteStatus> = {}
        for (const [id, entry] of offers) routes[id] = routeSnapshot(entry)
        const next: StoreReplicaSetStatus = {
            role,
            nodeId,
            leaderId,
            epoch,
            authorityLineId,
            authoritySeq,
            authorityCost,
            path: [...authorityPath],
            routeId: activeEntry?.offer.id ?? null,
            routeNodeId: activeDescriptor?.nodeId ?? null,
            rtt: activeEntry?.rtt ?? null,
            conflicts: conflictCount,
            error: lastError,
            routes,
        }
        status.replace(next)
        const current = descriptor()
        if (!lastPublishedDescriptor || !deepEqual(lastPublishedDescriptor, current)) {
            lastPublishedDescriptor = current
            emitDescriptor(current)
        }
        settleReplicaReady()
    }

    const status = createStore<StoreReplicaSetStatus>({
        role,
        nodeId,
        leaderId,
        epoch,
        authorityLineId,
        authoritySeq,
        authorityCost,
        path: [...authorityPath],
        routeId: null,
        routeNodeId: null,
        rtt: null,
        conflicts: 0,
        error: null,
        routes: {},
    })

    function report(error: unknown) {
        lastError = errorText(error)
        publishStatus()
    }

    function clearElectionTimer() {
        if (!electionTimer) return
        clearTimeout(electionTimer)
        electionTimer = null
    }

    function validateDescriptor(value: StoreReplicaDescriptor) {
        if (!value || value.protocol != 1) throw new Error('unsupported replica protocol')
        if (value.storeId != storeId) throw new Error('different storeId: ' + value.storeId)
        if (value.originId != originId) throw new Error('different originId: ' + value.originId)
        requiredId(value.nodeId, 'remote nodeId')
        requiredId(value.lineId, 'remote lineId')
        if (!Number.isInteger(value.epoch) || value.epoch < 0) throw new Error('invalid remote epoch')
        if (!Number.isInteger(value.headSeq) || value.headSeq < 0) throw new Error('invalid remote headSeq')
        if (!Number.isInteger(value.authoritySeq) || value.authoritySeq < -1) throw new Error('invalid remote authoritySeq')
        if ((value.role == 'leader' || value.role == 'follower') &&
            (typeof value.authorityCost != 'number' || !Number.isFinite(value.authorityCost) || value.authorityCost < 0)) {
            throw new Error('invalid remote authority cost')
        }
        if (!Array.isArray(value.path) || value.path.some(part => typeof part != 'string' || !part)) {
            throw new Error('invalid remote authority path')
        }
        if (new Set(value.path).size != value.path.length) throw new Error('cyclic remote authority path')
        if (value.nodeId == nodeId) throw new Error('self route rejected')
        if (value.leaderId != null) requiredId(value.leaderId, 'remote leaderId')
        if (value.authorityLineId != null) requiredId(value.authorityLineId, 'remote authorityLineId')
        if ((value.role == 'leader' || value.role == 'follower') &&
            (value.path[0] != value.leaderId || value.path[value.path.length - 1] != value.nodeId)) {
            throw new Error('invalid remote authority path')
        }
        if (value.role == 'leader' &&
            (value.nodeId != value.leaderId || value.lineId != value.authorityLineId || value.path.length != 1 || value.authorityCost != 0)) {
            throw new Error('invalid remote leader descriptor')
        }
        return value
    }

    async function accepted(value: StoreReplicaDescriptor) {
        validateDescriptor(value)
        return leadership.accept ? !!(await leadership.accept(value)) : true
    }

    function clearRetry(entry: OfferEntry) {
        if (!entry.retry) return
        clearTimeout(entry.retry)
        entry.retry = null
    }

    function closeSession(entry: OfferEntry) {
        entry.generation++
        unsubscribeHandle(entry.offChanged)
        unsubscribeHandle(entry.offFail)
        entry.offChanged = null
        entry.offFail = null
        const session = entry.session
        entry.session = null
        try { session?.close() } catch {}
    }

    function scheduleReconnect(entry: OfferEntry) {
        if (closed || entry.state == 'rejected' || !offers.has(entry.offer.id) || entry.retry) return
        entry.retry = timer(reconnectMs, function retryReplicaOffer() {
            entry.retry = null
            void openEntry(entry)
        })
    }

    function detachUpstream(reason: string) {
        const from = activeEntry?.offer.id ?? null
        upstreamSub?.()
        upstreamSub = null
        activeEntry = null
        activeDescriptor = null
        authorityCost = null
        if (role == 'follower' || role == 'reconciling') role = 'offline'
        emitRoute({from, to: null, reason, rtt: null})
    }

    function failEntry(entry: OfferEntry, reason: unknown) {
        if (!offers.has(entry.offer.id) || entry.state == 'closed') return
        const wasActive = activeEntry == entry
        closeSession(entry)
        entry.state = 'failed'
        entry.descriptor = null
        entry.error = errorText(reason)
        if (wasActive) detachUpstream('route failed: ' + entry.offer.id)
        publishStatus()
        scheduleReconnect(entry)
        scheduleReconcile('route failed')
    }

    async function ping(entry: OfferEntry, generation: number) {
        const probe = entry.session?.remote.ping
        if (!probe) return 0
        const started = now()
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        const timeout = new Promise<never>(function pingDeadline(_resolve, reject) {
            timeoutHandle = timer(pingTimeoutMs, function pingTimedOut() { reject(new Error('ping timeout')) })
        })
        try {
            await Promise.race([Promise.resolve(probe()), timeout])
            if (generation != entry.generation) throw new Error('stale ping generation')
            return Math.max(0, now() - started)
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle)
        }
    }

    function refreshEntry(entry: OfferEntry) {
        if (entry.refreshing) return entry.refreshing
        const generation = entry.generation
        const run = async function refreshReplicaOffer() {
            const session = entry.session
            if (!session) return
            try {
                const value = validateDescriptor(await session.remote.descriptor())
                if (value.path.includes(nodeId)) {
                    entry.descriptor = value
                    entry.state = 'rejected'
                    entry.error = 'cycle route rejected: ' + value.path.concat(nodeId).join(' -> ')
                    publishStatus()
                    scheduleReconcile('cycle route rejected')
                    return
                }
                if (!(await accepted(value))) {
                    entry.descriptor = value
                    entry.state = 'rejected'
                    entry.error = 'authority proof rejected'
                    publishStatus()
                    scheduleReconcile('authority proof rejected')
                    return
                }
                const sample = await ping(entry, generation)
                if (generation != entry.generation || session != entry.session) return
                entry.descriptor = value
                entry.rtt = entry.rtt == null ? sample : entry.rtt * 0.7 + sample * 0.3
                entry.state = 'open'
                entry.error = null
                maxObservedEpoch = Math.max(maxObservedEpoch, value.epoch)
                publishStatus()
                scheduleReconcile('descriptor changed')
            } catch (error) {
                if (generation != entry.generation) return
                if (/different storeId|different originId|self route|unsupported replica/.test(errorText(error))) {
                    closeSession(entry)
                    entry.state = 'rejected'
                    entry.descriptor = null
                    entry.error = errorText(error)
                    publishStatus()
                    return
                }
                failEntry(entry, error)
            }
        }
        entry.refreshing = run().finally(function finishReplicaRefresh() { entry.refreshing = null })
        return entry.refreshing
    }

    async function openEntry(entry: OfferEntry) {
        if (closed || !offers.has(entry.offer.id) || entry.session || entry.state == 'connecting') return
        clearRetry(entry)
        entry.state = 'connecting'
        entry.error = null
        const generation = ++entry.generation
        publishStatus()
        try {
            const session = await entry.offer.connect()
            if (closed || generation != entry.generation || !offers.has(entry.offer.id)) {
                session.close()
                return
            }
            entry.session = session
            entry.offFail = session.onFail?.on(function replicaSessionFailed(reason?: unknown) {
                failEntry(entry, reason ?? new Error('replica session failed'))
            }) ?? null
            entry.offChanged = session.remote.changed?.on(function remoteDescriptorChanged() {
                void refreshEntry(entry)
            }) ?? null
            await refreshEntry(entry)
        } catch (error) {
            if (generation == entry.generation) failEntry(entry, error)
        }
    }

    function addOffer(offerValue: StoreReplicaOffer) {
        const id = requiredId(offerValue.id, 'offer id')
        removeOffer(id)
        const offer = {...offerValue, id}
        const entry: OfferEntry = {
            offer,
            generation: 0,
            state: 'failed',
            session: null,
            descriptor: null,
            rtt: null,
            error: null,
            retry: null,
            offChanged: null,
            offFail: null,
            refreshing: null,
        }
        offers.set(id, entry)
        void openEntry(entry)
        return function removeAddedOffer() { removeOffer(id) }
    }

    function removeOffer(id: string) {
        const entry = offers.get(id)
        if (!entry) return false
        offers.delete(id)
        clearRetry(entry)
        const wasActive = activeEntry == entry
        closeSession(entry)
        entry.state = 'closed'
        if (wasActive) detachUpstream('route removed: ' + id)
        publishStatus()
        scheduleReconcile('offer removed')
        return true
    }

    function setOffers(next: readonly StoreReplicaOffer[]) {
        const wanted = new Map<string, StoreReplicaOffer>()
        for (const offer of next) wanted.set(requiredId(offer.id, 'offer id'), offer)
        for (const id of Array.from(offers.keys())) {
            const replacement = wanted.get(id)
            if (!replacement || replacement.connect != offers.get(id)?.offer.connect) removeOffer(id)
        }
        for (const [id, offer] of wanted) {
            if (!offers.has(id)) addOffer(offer)
        }
    }

    function viable(entry: OfferEntry) {
        const value = entry.descriptor
        return entry.state == 'open' && !!entry.session && !!value &&
            (value.role == 'leader' || value.role == 'follower') && value.leaderId != null && value.authorityLineId != null
    }

    function routeCost(entry: OfferEntry) {
        const priority = Number.isFinite(entry.offer.priority) ? entry.offer.priority! : 0
        return (entry.descriptor?.authorityCost ?? Number.POSITIVE_INFINITY) + (entry.rtt ?? 0) + priority
    }

    function chooseRoute(candidates: OfferEntry[]) {
        const authorityLine = candidates[0]?.descriptor?.authorityLineId
        const sameLineage = candidates.filter(entry => entry.descriptor?.authorityLineId == authorityLine)
        const freshestSeq = Math.max(...sameLineage.map(entry => entry.descriptor!.authoritySeq))
        const fresh = sameLineage.filter(entry => entry.descriptor!.authoritySeq == freshestSeq)
        fresh.sort((a, b) => routeCost(a) - routeCost(b) || a.offer.id.localeCompare(b.offer.id))
        const best = fresh[0]
        if (!best || !activeEntry || !fresh.includes(activeEntry)) return best
        return routeCost(best) + hysteresisMs < routeCost(activeEntry) ? best : activeEntry
    }

    function bestRemoteAuthority(candidates: OfferEntry[]) {
        let best: StoreReplicaDescriptor | null = null
        for (const entry of candidates) {
            const value = entry.descriptor!
            if (!best || compareAuthority(value, best) > 0) best = value
        }
        return best
    }

    function conflictFor(localState: T, authorityState: T, localDescriptor: StoreReplicaDescriptor, next: StoreReplicaDescriptor) {
        if (deepEqual(localState, authorityState)) return null
        const diff = diffKeyedState(localState as Record<string, any>, authorityState as Record<string, any>)
        if (!diff.localOnly.length && !diff.conflicts.length) return null
        return {detectedAt: now(), local: localDescriptor, authority: next, localState, authorityState, diff}
    }

    function trackAuthoritySeq(seq: number) {
        if (activeDescriptor?.lineId == activeDescriptor?.authorityLineId) authoritySeq = seq
        else authoritySeq = Math.max(authoritySeq, activeDescriptor?.authoritySeq ?? -1)
        publishStatus()
    }

    async function follow(entry: OfferEntry, next: StoreReplicaDescriptor, reason: string) {
        const session = entry.session
        if (!session) throw new Error('replica route closed before hand-off')
        const previousRole = role
        const previousEntry = activeEntry
        const previousDescriptor = activeDescriptor
        const previousAuthority = descriptor()
        const previousLeaderId = leaderId
        const previousEpoch = epoch
        const previousLineId = authorityLineId
        const previousSeq = authoritySeq
        const previousCost = authorityCost
        const previousPath = authorityPath
        const previousProof = proof
        const localState = store.snapshot()
        const authorityChanged = !sameAuthority(previousDescriptor ?? (previousRole == 'leader' ? previousAuthority : null), next)
        const sameSequenceSpace = sameAuthority(previousDescriptor, next) && previousDescriptor?.lineId == next.lineId
        const authorityFrame = previousRole == 'leader' && authorityChanged
            ? keyframeState<T>(await session.remote.replay.keyframe())
            : null
        const pendingConflict = authorityFrame
            ? conflictFor(localState, authorityFrame, previousAuthority, next)
            : null

        role = 'reconciling'
        leaderId = next.leaderId
        epoch = next.epoch
        proof = next.proof
        authorityLineId = next.authorityLineId
        authoritySeq = next.authoritySeq
        authorityCost = routeCost(entry)
        authorityPath = [...next.path, nodeId]
        publishStatus()

        let created = false
        try {
            if (!upstreamSub) {
                created = true
                upstreamSub = syncStoreReplayRoute(store, session.remote.replay, {
                    label: entry.offer.id,
                    since: -1,
                    reset: true,
                    onSeq: trackAuthoritySeq,
                    onError: function activeReplicaRouteFailed(error) { failEntry(entry, error) },
                })
                await upstreamSub.ready
            } else {
                await upstreamSub.switch(session.remote.replay, {
                    label: entry.offer.id,
                    ...(sameSequenceSpace ? {} : {since: -1, reset: true}),
                })
            }
            if (closed || entry.session != session) throw new Error('replica route changed during hand-off')
            activeEntry = entry
            activeDescriptor = next
            leaderId = next.leaderId
            epoch = next.epoch
            proof = next.proof
            authorityLineId = next.authorityLineId
            authoritySeq = Math.max(authoritySeq, next.authoritySeq)
            authorityCost = routeCost(entry)
            authorityPath = [...next.path, nodeId]
            role = 'follower'
            lastError = null
            clearElectionTimer()
            if (pendingConflict) {
                conflictCount++
                emitConflict(pendingConflict)
            }
            emitRoute({from: previousEntry?.offer.id ?? null, to: entry.offer.id, reason, rtt: entry.rtt})
            publishStatus()
        } catch (error) {
            if (created) { upstreamSub?.(); upstreamSub = null }
            activeEntry = previousEntry
            activeDescriptor = previousDescriptor
            leaderId = previousLeaderId
            epoch = previousEpoch
            authorityLineId = previousLineId
            authoritySeq = previousSeq
            authorityCost = previousCost
            authorityPath = previousPath
            proof = previousProof
            role = previousRole
            report(error)
            throw error
        }
    }

    async function promote(reason = 'manual') {
        if (closed) throw new Error('store replica set is closed')
        if (role == 'leader') return descriptor()
        if (leadership.eligible == false) return null
        const candidates = Array.from(offers.values()).filter(viable).map(entry => entry.descriptor!)
        const ctx: StoreReplicaElectionContext = {storeId, originId, nodeId, maxEpoch: maxObservedEpoch, candidates}
        const elected = leadership.elect
            ? await leadership.elect(ctx)
            : {epoch: maxObservedEpoch + 1}
        if (!elected) {
            role = 'offline'
            publishStatus()
            return null
        }
        if (!Number.isInteger(elected.epoch) || elected.epoch <= maxObservedEpoch) {
            throw new Error('store replica election must return an epoch above ' + maxObservedEpoch)
        }
        const from = activeEntry?.offer.id ?? null
        upstreamSub?.()
        upstreamSub = null
        activeEntry = null
        activeDescriptor = null
        epoch = elected.epoch
        maxObservedEpoch = epoch
        proof = elected.proof
        leaderId = nodeId
        authorityLineId = lineId
        authoritySeq = exposed.replay.head()
        authorityCost = 0
        authorityPath = [nodeId]
        role = 'leader'
        lastError = null
        clearElectionTimer()
        emitRoute({from, to: null, reason: 'promoted: ' + reason, rtt: null})
        publishStatus()
        scheduleReconcile('local promotion')
        return descriptor()
    }

    function scheduleElection(reason: string) {
        if (closed || role == 'leader' || electionTimer || leadership.autoPromoteMs == null || leadership.eligible == false) {
            if (role != 'leader' && role != 'electing') role = 'offline'
            publishStatus()
            return
        }
        role = 'electing'
        publishStatus()
        electionTimer = timer(leadership.autoPromoteMs, function automaticReplicaElection() {
            electionTimer = null
            void promote(reason).catch(report)
        })
    }

    async function runReconcile(reason: string) {
        if (closed) return
        const candidates = Array.from(offers.values()).filter(viable)
        for (const entry of candidates) maxObservedEpoch = Math.max(maxObservedEpoch, entry.descriptor!.epoch)
        const remoteBest = bestRemoteAuthority(candidates)
        const local = role == 'leader' ? descriptor() : null

        if (local && (!remoteBest || compareAuthority(local, remoteBest) >= 0)) {
            clearElectionTimer()
            lastError = null
            publishStatus()
            return
        }

        if (!remoteBest) {
            if (activeEntry || upstreamSub) detachUpstream('authority unavailable')
            scheduleElection(reason)
            return
        }

        clearElectionTimer()
        const routes = candidates.filter(entry => sameAuthority(entry.descriptor, remoteBest))
        const chosen = chooseRoute(routes)
        if (!chosen) {
            scheduleElection('no viable route')
            return
        }
        const next = chosen.descriptor!
        if (activeEntry == chosen && role == 'follower' && sameAuthority(activeDescriptor, next)) {
            activeDescriptor = next
            leaderId = next.leaderId
            epoch = next.epoch
            proof = next.proof
            authorityLineId = next.authorityLineId
            authoritySeq = Math.max(authoritySeq, next.authoritySeq)
            authorityCost = routeCost(chosen)
            authorityPath = [...next.path, nodeId]
            lastError = null
            publishStatus()
            return
        }
        await follow(chosen, next, reason)
    }

    function reconcile(reason = 'manual') {
        const run = opChain.then(function serializedReplicaReconcile() { return runReconcile(reason) })
        opChain = run.catch(function rememberReplicaReconcileError(error) { report(error) })
        return run
    }

    function scheduleReconcile(reason: string) {
        if (closed || reconcileScheduled) return
        reconcileScheduled = true
        Promise.resolve().then(function runScheduledReplicaReconcile() {
            reconcileScheduled = false
            void reconcile(reason).catch(function scheduledReplicaError() {})
        })
    }

    async function probe() {
        await Promise.all(Array.from(offers.values(), function refreshOpenReplica(entry) {
            return entry.session ? refreshEntry(entry) : openEntry(entry)
        }))
        await reconcile('probe')
    }

    const offHead = exposed.replay.line.on(function localReplicaHeadChanged() {
        if (role == 'leader') authoritySeq = exposed.replay.head()
        publishStatus()
    })
    const offOfferSource = deps.offers?.changes.on(function replaceDiscoveredOffers(next) { setOffers(next) }) ?? null
    if (deps.offers) setOffers(deps.offers.list())
    if (deps.route?.probeIntervalMs != null) {
        probeTimer = setInterval(function periodicReplicaProbe() { void probe().catch(report) }, deps.route.probeIntervalMs)
        ;(probeTimer as any).unref?.()
    }
    publishStatus()
    if (role != 'leader' && !offers.size) scheduleElection('initial election')

    function close() {
        if (closed) return
        closed = true
        clearElectionTimer()
        if (probeTimer) clearInterval(probeTimer)
        probeTimer = null
        unsubscribeHandle(offOfferSource)
        upstreamSub?.()
        upstreamSub = null
        for (const entry of Array.from(offers.values())) {
            clearRetry(entry)
            closeSession(entry)
            entry.state = 'closed'
        }
        offers.clear()
        role = 'closed'
        activeEntry = null
        activeDescriptor = null
        offHead()
        publishStatus()
        exposed.close()
        descriptorChanges.close()
        conflictListen.close()
        routeListen.close()
    }

    const fragment = {
        descriptor,
        changed: descriptorChanges,
        replay: exposed.api.replay,
        ping: () => now(),
    }

    return {
        control: {
            store,
            addOffer,
            removeOffer,
            setOffers,
            probe,
            reconcile,
            promote,
            canWrite: () => role == 'leader',
            close,
        },
        api: {
            store,
            status,
            ready,
            descriptor,
            changed: descriptorChanges,
            conflicts: conflictListen,
            routes: routeListen,
            replay: exposed.replay,
            fragment,
            canWrite: () => role == 'leader',
        },
        close,
    }
}

export type StoreReplicaSet<T extends object> = ReturnType<typeof createStoreReplicaSet<T>>
