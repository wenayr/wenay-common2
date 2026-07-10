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

import {applyStorePatch, createStore, StoreDrain, StorePatch} from '../Observe/store'
import {exposeStoreReplay} from '../Observe/store-replay'
import {exposeReplay, ReplayRemote} from '../events/replay-wire'
import {createRouteCoordinator, RouteConnector, RoutePolicy, tConnectorState} from '../events/route-coordinator'
import {acceptWebRtcDirect, createWebRtcConnector, RtcPeerConnection, SignalEnvelope, SignalPort} from '../events/route-signal-webrtc'
import {PatchEnvelope, RelayPushResult, tRelayGap} from './peer-relay'

/** Runtime shape of the host fragment as seen through the client deep proxy. */
export type PeerRemote = {
    signal: {
        send: (env: SignalEnvelope) => Promise<boolean | void>
        signals: {on: (cb: (env: SignalEnvelope) => void) => any}
    }
    publish: (env: PatchEnvelope) => Promise<RelayPushResult | void> | RelayPushResult | void
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

export function createPeerClient<T extends object, J extends tRelayGap = 'resume'>(deps: PeerClientDeps<T, J>) {
    const {
        remote, account, initial, rtc, session, accept, policy,
        peerInitial = () => ({} as T), history, drain,
        journal = 'resume' as J, onPublishError,
    } = deps
    const repair: 'tail' | 'keyframe' = deps.repair ?? 'tail'

    // ============== own state: a plain store, published as a patch line ==============
    const store = createStore<T>(initial, drain !== undefined ? {drain} : {})
    const exposed = exposeStoreReplay(store, history !== undefined ? {history} : {})

    // -------- rejection-driven repair: the relay's {seq: N} verdict IS the repair
    // request. One repair at a time; envelopes racing past it get re-rejected with
    // a fresh coordinate, so the loop converges by induction.
    let repairing: Promise<void> | null = null

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

    async function runRepair(from: number) {
        for (const env of repairEnvelopes(from)) {
            const res = await remote.publish(env)
            if (res != null && typeof res == 'object') {
                throw new Error('peer publish: repair rejected at relay seq ' + res.seq)
            }
        }
    }

    function queueRepair(from: number) {
        if (repairing) return
        repairing = runRepair(from)
            .catch(function reportRepairError(e) {
                if (onPublishError) onPublishError(e)
                else setTimeout(function rethrowRepairError() { throw e }, 0)
            })
            .finally(() => { repairing = null })
    }

    function handleVerdict(res: RelayPushResult | void) {
        if (res != null && typeof res == 'object' && typeof res.seq == 'number') queueRepair(res.seq)
    }

    const offPublish = exposed.replay.line.on(function publishEnvelope(env: PatchEnvelope) {
        Promise.resolve(remote.publish(env)).then(handleVerdict, function onPublishReject(e) {
            // transport hiccup: the NEXT publish gets a {seq} verdict and repairs the gap
            onPublishError?.(e)
        })
    })
    const warmup = exposed.replay.keyframe()
    if (warmup) Promise.resolve(remote.publish(warmup)).then(handleVerdict, e => onPublishError?.(e))

    /** Reconnect hook: compare the relay's coordinate with the local line and repair the gap. */
    async function resync() {
        const node = remote.peers[account]
        const relaySeq = Number(await node?.seq?.() ?? -1)
        const localSeq = exposed.replay.keyframe()?.seq ?? -1
        if (relaySeq >= localSeq) return
        await runRepair(relaySeq)
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
                return {
                    line: {on: (cb: (ev: any) => void) => node.line.on(cb)},
                    since: (seq: number) => node.since(seq),
                    keyframe: () => node.keyframe(),
                    frame: (seq: number, hint?: unknown) => node.frame!(seq, hint),
                }
            },
            close: () => { state = 'closed' },
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
            for (const view of Array.from(views.values())) view.close()
            coord.close()
            stopAccept?.()
            offPublish()
            exposed.close()
        },
    }
}

export type PeerClient<T extends object> = ReturnType<typeof createPeerClient<T>>
