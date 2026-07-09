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
import {PatchEnvelope} from './peer-relay'

/** Runtime shape of the host fragment as seen through the client deep proxy. */
export type PeerRemote = {
    signal: {
        send: (env: SignalEnvelope) => Promise<boolean | void>
        signals: {on: (cb: (env: SignalEnvelope) => void) => any}
    }
    publish: (env: PatchEnvelope) => Promise<boolean | void> | boolean | void
    peers: Record<string, ReplayRemote<[StorePatch]>>
}

export type PeerClientDeps<T extends object> = {
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
    history?: number
    drain?: StoreDrain
}

export function createPeerClient<T extends object>(deps: PeerClientDeps<T>) {
    const {
        remote, account, initial, rtc, session, accept, policy,
        peerInitial = () => ({} as T), history, drain,
    } = deps

    // ============== own state: a plain store, published as a patch line ==============
    const store = createStore<T>(initial, drain !== undefined ? {drain} : {})
    const exposed = exposeStoreReplay(store, history !== undefined ? {history} : {})
    const offPublish = exposed.replay.line.on(function publishEnvelope(env: PatchEnvelope) {
        void remote.publish(env)
    })
    const warmup = exposed.replay.keyframe()
    if (warmup) void remote.publish(warmup)

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
