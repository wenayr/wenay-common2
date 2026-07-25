// =====================================================================
// Peer client — the one-call client SDK over an existing rpc connection
// =====================================================================
// Takes the deep proxy of the host's peer fragment (client.func.peer) — the
// rest of the client's rpc surface is untouched, legacy call sites keep
// working on the same connection. Composes what used to be five primitives:
// own store -> exposeStoreReplay -> publish to relay; route coordinator with
// a relay connector (the host's noStrict peers map) and an optional WebRTC
// direct connector; peer(account) -> a mirrored store that survives any route
// change (relay <-> direct share the owner's seq space by construction).

import {applyStorePatch, createStore, listenStorePatches, Store, StoreDrain, StorePatch} from '../Observe/store'
import {exposeReplay, ReplayRemote} from '../events/replay-wire'
import {replayListen} from '../events/replay-listen'
import {getRpcMemberState, getRpcSchemaReady, getRpcTransportLifecycle} from '../events/transport-lifecycle'
import {createRouteCoordinator, RouteConnector, RoutePolicy, tConnectorState} from '../events/route-coordinator'
import {acceptWebRtcDirect, createWebRtcConnector, RtcPeerConnection, SignalEnvelope, SignalPort} from '../events/route-signal-webrtc'
import {PatchEnvelope, RelayPushResult, tRelayGap} from './peer-relay'
import {
    PEER_PUBLISH_BATCH_MAX_BYTES,
    createMeasuredPeerPublishBatchQueue,
    splitMeasuredPeerPublishEnvelopes,
    tMeasuredPeerPublishBatch,
} from './peer-publish-batch'
import {readPeerRelayFrame, readPeerRelaySeq} from './peer-remote-compat'

/** Runtime shape of the host fragment as seen through the client deep proxy. */
export type PeerRemote = {
    signal: {
        send: (env: SignalEnvelope) => Promise<boolean | void>
        signals: {on: (cb: (env: SignalEnvelope) => void) => any}
    }
    publish: (env: PatchEnvelope) => Promise<RelayPushResult | void> | RelayPushResult | void
    /** Present on batching hosts; legacy hosts keep serving `publish`. */
    publishBatch?: (envelopes: PatchEnvelope[]) => Promise<RelayPushResult | void> | RelayPushResult | void
    peers: Record<string, ReplayRemote<[StorePatch]> & {seq?: () => number | Promise<number>}>
    /** Present on hosts >= 1.0.74: who is online (subscribe to changes FIRST, then list()). */
    presence?: {
        list: () => Promise<string[]> | string[]
        changes: {on: (cb: (change: {account: string, online: boolean}) => void) => any}
    }
}

/**
 * Repair economy for publisher gaps. 'tail' = re-send the missed envelopes
 * verbatim (lossless; falls back to a root keyframe if the local journal
 * evicted them — 'resume' journals only). 'keyframe' = one fresh root snapshot
 * (cheap; the relay ring resets — right for ephemeral state like cursors).
 * A declared 'sacred' journal admits ONLY 'tail': cheap repair is forbidden by
 * this type, not by a runtime check — lie about the journal kind and the relay
 * will simply keep rejecting you (see peer-relay).
 */
export type tPublishRepair<J extends tRelayGap = 'resume'> = J extends 'sacred' ? 'tail' : 'tail' | 'keyframe'

export type PeerClientDeps<T extends object, J extends tRelayGap = 'resume'> = {
    /** Deep proxy of the host's peer fragment, e.g. `clients.api.func.peer`. */
    remote: PeerRemote
    account: string
    /** Own store initial state — writes here are what other accounts see. */
    initial: T
    /** WebRTC runtime factory; omit = relay-only client (promoteDirect unavailable). */
    rtc?: () => RtcPeerConnection
    /** Opaque session material for direct offers (validated by host authorize + peer accept). */
    session?: unknown
    /** Validate incoming direct offers (the serving side of this client). */
    accept?: (env: SignalEnvelope) => boolean | Promise<boolean>
    policy?: RoutePolicy
    /** Initial state for peer mirrors before the keyframe lands. */
    peerInitial?: () => T
    /** What the server declared for this account's journal — constrains `repair` at the type level. */
    journal?: J
    repair?: tPublishRepair<J>
    /** Publish-path failures (repair impossible, transport rejected) — loud, never silent. */
    onPublishError?: (e: unknown) => void
    history?: number
    drain?: StoreDrain
}

function exposePeerPatchReplay<T extends object>(store: Store<T>, history?: number) {
    const [emit, replay] = replayListen<[StorePatch]>({
        history: history ?? 1024,
        current: function currentPeerPatch() {
            return [{path: [], exists: true, value: store.snapshot()}]
        },
    })
    const offStore = listenStorePatches(store).on(function publishPeerPatches(patches) {
        replay.emitBatch(patches.map(patch => [patch] as [StorePatch]))
    })
    function close() {
        offStore()
        replay.close()
    }
    return {replay, close}
}

export function createPeerClient<T extends object, J extends tRelayGap = 'resume'>(deps: PeerClientDeps<T, J>) {
    const {
        remote, account, initial, rtc, session, accept, policy,
        peerInitial = () => ({} as T), history, drain,
        journal = 'resume' as J, onPublishError,
    } = deps
    const repair: 'tail' | 'keyframe' = deps.repair ?? 'tail'

    // ============== own state: a plain store, published as a patch line ==============
    const store = createStore<T>(initial, drain !== undefined ? {drain} : {})
    const exposed = exposePeerPatchReplay(store, history)

    // -------- rejection-driven repair: the relay's {seq: N} verdict IS the repair
    // request. One repair at a time; envelopes racing past it get re-rejected with
    // a fresh coordinate, so the loop converges by induction.
    let repairing: Promise<void> | null = null
    let closed = false

    function peerClientClosedError() {
        return new Error('peer client closed')
    }

    function ensurePeerClientOpen() {
        if (closed) throw peerClientClosedError()
    }

    function repairEnvelopes(from: number): PatchEnvelope[] {
        const line = exposed.replay
        if (repair == 'tail' && from >= 0) {
            const tail = line.getSince(from)
            if (tail) return tail
            // local journal evicted the coordinate: a sacred relay cannot be
            // repaired by an invented snapshot — that is the publisher's fault
            if (journal == 'sacred') {
                throw new Error('peer publish: local journal evicted seq ' + from + ', sacred relay is unrepairable — raise {history}')
            }
        }
        const kf = exposed.replay.keyframe()
        return kf ? [kf] : []
    }

    // RPC schema is the capability handshake. A plain in-process remote has no
    // schema, so the first batch call is the probe and falls back once on reject.
    type tPublishMode = 'batch' | 'legacy' | 'probe'
    const publishLifecycle = getRpcTransportLifecycle(remote)
    const publishSchemaReady = getRpcSchemaReady(remote)
    let publishGeneration = publishLifecycle?.generation()

    function detectPublishMode(): tPublishMode {
        const state = getRpcMemberState(remote, 'publishBatch')
        if (state == true) return 'batch'
        if (state == false) return 'legacy'
        if (publishSchemaReady) return 'probe'
        if (typeof remote.publishBatch != 'function') return 'legacy'
        return 'probe'
    }

    let publishMode = detectPublishMode()

    function refreshPublishMode() {
        const generation = publishLifecycle?.generation()
        const generationChanged = generation != publishGeneration
        if (generationChanged) publishGeneration = generation
        const detected = detectPublishMode()
        if (detected != 'probe' || generationChanged) publishMode = detected
        return publishMode
    }

    type PublishItem = PatchEnvelope
    type PublishBatch = tMeasuredPeerPublishBatch<PublishItem>

    async function publishLegacy(batches: readonly PublishBatch[], sequential = false) {
        ensurePeerClientOpen()
        if (sequential) {
            for (const batch of batches) {
                for (const item of batch.items) {
                    ensurePeerClientOpen()
                    const result = await remote.publish(item)
                    if (result == false || (result != null && typeof result == 'object')) return result
                }
            }
            return true as RelayPushResult
        }
        const calls: Array<Promise<RelayPushResult | void>> = []
        for (const batch of batches) {
            for (const item of batch.items) {
                ensurePeerClientOpen()
                calls.push(Promise.resolve(remote.publish(item)))
            }
        }
        const results = await Promise.all(calls)
        for (const result of results) {
            if (result == false || (result != null && typeof result == 'object')) return result
        }
        return true as RelayPushResult
    }

    function canPublishBatch(batch: PublishBatch) {
        return batch.byteLength <= PEER_PUBLISH_BATCH_MAX_BYTES
    }

    function publishBatchGroup(batch: PublishBatch) {
        ensurePeerClientOpen()
        if (!canPublishBatch(batch)) return Promise.resolve(remote.publish(batch.items[0]))
        return Promise.resolve(remote.publishBatch!(batch.items))
    }

    async function publishKnownBatches(batches: readonly PublishBatch[], sequential = false) {
        if (sequential) {
            for (const batch of batches) {
                const result = await publishBatchGroup(batch)
                if (result == false || (result != null && typeof result == 'object')) return result
            }
            return true as RelayPushResult
        }
        const calls: Array<Promise<RelayPushResult | void>> = []
        for (const batch of batches) calls.push(publishBatchGroup(batch))
        const results = await Promise.all(calls)
        for (const result of results) {
            if (result == false || (result != null && typeof result == 'object')) return result
        }
        return true as RelayPushResult
    }

    async function publishBatches(batches: readonly PublishBatch[], sequential = false) {
        ensurePeerClientOpen()
        if (publishSchemaReady && getRpcMemberState(remote, 'publishBatch') == undefined) {
            await publishSchemaReady()
            ensurePeerClientOpen()
        }
        refreshPublishMode()
        if (publishMode == 'legacy') return publishLegacy(batches, sequential)
        if (publishMode == 'batch') {
            try {
                return await publishKnownBatches(batches, sequential)
            } catch (error) {
                // A rolling downgrade changes the current RPC schema. Re-read it
                // before deciding whether this is a transport error or a legacy host.
                if (closed) throw error
                const modeAfterError = refreshPublishMode()
                if (modeAfterError == 'legacy') return publishLegacy(batches, sequential)
                throw error
            }
        }

        const [first, ...rest] = batches
        if (!first) return true as RelayPushResult
        if (!canPublishBatch(first)) return publishLegacy(batches, sequential)
        try {
            const result = await remote.publishBatch!(first.items)
            ensurePeerClientOpen()
            publishMode = 'batch'
            if (result == false || (result != null && typeof result == 'object')) return result
        } catch (error) {
            if (closed) throw error
            refreshPublishMode()
            if (publishMode == 'probe') publishMode = 'legacy'
            // If the probe reached a new relay but its response was lost, replaying
            // legacy envelopes is still safe because owner seq makes them idempotent.
            return publishLegacy(batches, sequential)
        }
        return publishKnownBatches(rest, sequential)
    }

    async function runRepair(from: number) {
        ensurePeerClientOpen()
        const batches = splitMeasuredPeerPublishEnvelopes(repairEnvelopes(from))
        const res = await publishBatches(batches, true)
        if (res != null && typeof res == 'object') {
            throw new Error('peer publish: repair rejected at relay seq ' + res.seq)
        }
    }

    function queueRepair(from: number) {
        if (closed) return Promise.resolve()
        if (repairing) return repairing
        repairing = runRepair(from)
            .catch(function reportRepairError(e) {
                if (closed) return
                if (onPublishError) onPublishError(e)
                else setTimeout(function rethrowRepairError() { throw e }, 0)
            })
            .finally(function finishRepair() { repairing = null })
        return repairing
    }

    async function handleVerdict(res: RelayPushResult | void) {
        if (closed) return
        if (res != null && typeof res == 'object' && typeof res.seq == 'number') await queueRepair(res.seq)
    }

    async function publishQueued(batch: PublishBatch) {
        await handleVerdict(await publishBatches([batch]))
    }

    function reportPublishReject(error: unknown) {
        try {
            onPublishError?.(error)
        } catch (callbackError) {
            setTimeout(function rethrowPublishErrorCallback() { throw callbackError }, 0)
        }
    }

    type PublishWork =
        | {kind: 'batch', batch: PublishBatch}
        | {
            kind: 'barrier'
            run: () => Promise<void>
            resolve: () => void
            reject: (error: unknown) => void
        }
    type PublishBarrier = Extract<PublishWork, {kind: 'barrier'}>

    const MAX_PENDING_PUBLISH_BATCHES = 64
    const publishWork: PublishWork[] = []
    let publishing = false
    let activeBarrier: PublishBarrier | null = null

    async function drainPublishWork() {
        if (publishing || closed) return
        publishing = true
        try {
            while (!closed && publishWork.length) {
                const work = publishWork.shift()!
                if (work.kind == 'batch') {
                    try { await publishQueued(work.batch) }
                    catch (error) {
                        if (!closed) reportPublishReject(error)
                    }
                    continue
                }
                activeBarrier = work
                try {
                    await work.run()
                    if (closed) work.reject(peerClientClosedError())
                    else work.resolve()
                } catch (error) {
                    work.reject(error)
                } finally {
                    if (activeBarrier == work) activeBarrier = null
                }
            }
        } finally {
            publishing = false
            if (!closed && publishWork.length) void drainPublishWork()
        }
    }

    function pendingBatchSuffixLength() {
        let count = 0
        for (let index = publishWork.length - 1; index >= 0; index--) {
            if (publishWork[index].kind != 'batch') break
            count++
        }
        return count
    }

    function dispatchPublish(batch: PublishBatch) {
        if (closed) return
        const pendingBatches = pendingBatchSuffixLength()
        if (journal != 'sacred' && pendingBatches >= MAX_PENDING_PUBLISH_BATCHES) {
            const keyframe = exposed.replay.keyframe()
            const root = keyframe ? splitMeasuredPeerPublishEnvelopes([keyframe])[0] : undefined
            publishWork.length -= pendingBatches
            publishWork.push({kind: 'batch', batch: root ?? batch})
        } else {
            publishWork.push({kind: 'batch', batch})
        }
        void drainPublishWork()
    }

    function rejectPublishWork(error: Error) {
        const pending = publishWork.splice(0)
        for (const work of pending) {
            if (work.kind == 'barrier') work.reject(error)
        }
        const active = activeBarrier
        activeBarrier = null
        active?.reject(error)
    }

    const publishQueue = createMeasuredPeerPublishBatchQueue<PublishItem>({
        emit: dispatchPublish,
        schedule: queueMicrotask,
    })

    const offPublish = exposed.replay.line.on(function publishEnvelope(env: PatchEnvelope) {
        publishQueue.push(env)
    })
    const warmup = exposed.replay.keyframe()
    if (warmup) publishQueue.push(warmup)

    /** Reconnect hook: compare the relay's coordinate with the local line and repair the gap. */
    function resync() {
        if (closed) {
            const rejected = Promise.reject<void>(peerClientClosedError())
            void rejected.catch(function containIgnoredClosedResync() {})
            return rejected
        }
        publishQueue.flush()
        if (closed) {
            const rejected = Promise.reject<void>(peerClientClosedError())
            void rejected.catch(function containIgnoredFlushClose() {})
            return rejected
        }
        const pending = new Promise<void>(function queueResync(resolve, reject) {
            publishWork.push({
                kind: 'barrier',
                async run() {
                    ensurePeerClientOpen()
                    // Writes arriving during this coordinate read remain behind
                    // the barrier and therefore follow any resulting repair.
                    const node = remote.peers[account]
                    const relaySeq = await readPeerRelaySeq(node)
                    ensurePeerClientOpen()
                    const localSeq = exposed.replay.keyframe()?.seq ?? -1
                    if (relaySeq >= localSeq) return
                    await runRepair(relaySeq)
                },
                resolve,
                reject,
            })
            void drainPublishWork()
        })
        void pending.catch(function containIgnoredResyncRejection() {})
        return pending
    }

    // ============== transport wiring: signaling port + connectors ==============
    const port: SignalPort = {
        send: env => remote.signal.send(env),
        signals: {on: cb => remote.signal.signals.on(cb)},
    }
    // the serving side of direct: peers read this client's LOCAL journal — the same
    // seq space as the relay journal, so their route hand-off is a plain seq resume
    const stopAccept = rtc
        ? acceptWebRtcDirect<[StorePatch]>({
            port, rtc, self: account,
            serve: () => exposeReplay(exposed.replay),
            ...(accept ? {accept} : {}),
        })
        : null

    function relayConnector(other: string): RouteConnector<[StorePatch]> {
        let state: tConnectorState = 'idle'
        return {
            info: {label: 'relay', kind: 'relay', ordered: true, reliable: true},
            open() {
                // flat wrapper over the rpc proxy: the node must not be returned as is —
                // awaiting a proxy could invoke `.then` as a remote call
                const node = remote.peers[other]
                state = 'open'
                function subscribeLine(cb: (event: any) => void) {
                    return node.line.on(cb)
                }
                function since(seq: number) {
                    return node.since(seq)
                }
                function keyframe() {
                    return node.keyframe()
                }
                function frame(seq: number, hint?: unknown) {
                    return readPeerRelayFrame(node, seq, hint)
                }
                return {
                    line: {on: subscribeLine},
                    since,
                    keyframe,
                    frame,
                }
            },
            close() { state = 'closed' },
            state: () => state,
        }
    }

    const coord = createRouteCoordinator<[StorePatch]>({
        ...(policy ? {policy} : {}),
        connect(ref, kind) {
            const other = ref.a == account ? ref.b : ref.a
            if (kind == 'relay') return relayConnector(other)
            if (!rtc) throw new Error('peer client: promoteDirect needs an rtc factory (deps.rtc)')
            return createWebRtcConnector<[StorePatch]>({
                port, rtc, self: account, peer: other, pair: ref.key, session,
            })
        },
    })

    // ============== peer views: mirrored store + route control per account ==============
    const views = new Map<string, PeerView>()

    function makeView(other: string) {
        const link = coord.pair(account, other)
        const mirror = createStore<T>(peerInitial(), drain !== undefined ? {drain} : {})
        const sub = link.subscribe(function mirrorPatch(patch: StorePatch) {
            applyStorePatch(mirror, patch)
        })
        const view = {
            account: other,
            /** Mirror of the peer's store — reads survive any route change. */
            store: mirror,
            /** First catch-up (keyframe or tail) delivered. */
            ready: sub.ready,
            seq: sub.seq,
            /** Current data-path label: 'relay' | 'direct'. */
            route: link.label,
            state: link.state,
            promoteDirect: link.promoteDirect,
            reinterposeRelay: link.reinterposeRelay,
            fallback: link.fallback,
            block: link.block,
            close() {
                views.delete(other)
                sub()
                link.close()
            },
        }
        return view
    }

    type PeerView = ReturnType<typeof makeView>

    function peer(other: string): PeerView {
        const existing = views.get(other)
        if (existing) return existing
        const view = makeView(other)
        views.set(other, view)
        return view
    }

    return {
        /** Own store: write here — the relay (and direct peers) see it. */
        store,
        /** Mirror + route control for another account. */
        peer,
        /** Route transitions across all pairs (metrics/UI). */
        onRoute: coord.onRoute,
        /** Call after a transport reconnect: repairs the relay journal without waiting for the next write. */
        resync,
        close() {
            if (closed) return
            closed = true
            rejectPublishWork(peerClientClosedError())
            offPublish()
            publishQueue.close()
            for (const view of Array.from(views.values())) view.close()
            coord.close()
            stopAccept?.()
            exposed.close()
        },
    }
}

export type PeerClient<T extends object> = ReturnType<typeof createPeerClient<T>>
