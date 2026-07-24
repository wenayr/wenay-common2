// =====================================================================
// Peer host — the server-side SDK fragment (legacy-friendly by design)
// =====================================================================
// connection(account) returns an object FRAGMENT to spread into the app's
// EXISTING createRpcServerAuto object: {...legacyObject, peer: fragment}.
// Old keys keep working untouched; the fragment adds three things:
//   signal   — the per-account signaling port (WebRTC + call envelopes)
//   publish  — the owner's patch line lands in its relay journal (owner seq space)
//   peers    — noStrict dynamic map: every account's relay journal, ReplayRemote-shaped
//   presence — who is connected right now: list() + changes edge Listen
// The relay journal outlives the connection: late subscribers get a folded
// keyframe even while the owner is offline.

import {noStrict} from '../rcp/rpc-dynamic'
import {StorePatch} from '../Observe/store'
import {listen} from '../events/Listen'
import {ReplayRemote} from '../events/replay-wire'
import {createSignalHub, SignalEnvelope} from '../events/route-signal-webrtc'
import {createPatchRelayJournal, PatchEnvelope, PatchRelayJournal, tRelayGap} from './peer-relay'

/** Presence edge: emitted on the 0->1 / 1->0 connection-count transitions only. */
export type PresenceChange = {account: string, online: boolean}

export type PeerHostDeps = {
    /** Server-side canExposeEndpoint: the only place endpoint/session material may pass. */
    authorize?: (env: SignalEnvelope) => boolean | Promise<boolean>
    /** Relay journal depth per account. */
    history?: number
    /** Journal semantics for every account (data-type decision — see peer-relay). */
    gap?: tRelayGap
    /**
     * Which account keys may exist in the peers map. A subscriber may resolve
     * peers[other] BEFORE that account ever connected — the journal is auto-created
     * empty and fills when the owner publishes (no subscribe-order race). Omitted =
     * any key (demo/trusted); provide it on public servers to stop junk-key journals.
     */
    accounts?: (account: string) => boolean
}

export function createPeerHost(deps: PeerHostDeps = {}) {
    const {authorize, history, gap, accounts: accountAllowed} = deps
    const hub = createSignalHub({authorize})
    const relays = new Map<string, PatchRelayJournal>()
    const connections = new Set<() => void>()
    let closed = false
    // dynamic keyspace: accounts appear at runtime, clients resolve them by string path.
    // The Proxy auto-creates an EMPTY journal on first touch, so a mirror subscribed
    // before its owner ever connected simply waits for the first publish instead of
    // failing loudly (the rpc dynamic walk does `seg in curr` + `curr[seg]`).
    const peersMap: Record<string, ReplayRemote<[StorePatch]>> = {}
    const peersView: Record<string, ReplayRemote<[StorePatch]>> = noStrict(new Proxy(peersMap, {
        has(_t, k) { return !closed && typeof k == 'string' && (!accountAllowed || accountAllowed(k)) },
        get(t, k) {
            if (typeof k != 'string') return (t as any)[k]
            if (closed) return undefined
            if (accountAllowed && !accountAllowed(k)) return undefined
            return ensureRelay(k).remote
        },
    }))

    // ============== presence: who is connected right now ==============
    // Refcount per account (an account may hold several connections); the edge
    // rides as a plain Listen — subscribe FIRST, then list(), to avoid the race.
    const online = new Map<string, number>()
    const [emitPresence, presenceChanges] = listen<[PresenceChange]>()
    const presence = {
        list: () => Array.from(online.keys()),
        changes: presenceChanges,
    }

    function presenceJoin(account: string) {
        const n = (online.get(account) ?? 0) + 1
        online.set(account, n)
        if (n == 1) emitPresence({account, online: true})
    }

    function presenceLeave(account: string) {
        const n = (online.get(account) ?? 0) - 1
        if (n > 0) { online.set(account, n); return }
        online.delete(account)
        emitPresence({account, online: false})
    }

    function ensureRelay(account: string) {
        if (closed) throw new Error('peer host closed')
        let relay = relays.get(account)
        if (!relay) {
            relay = createPatchRelayJournal({history, gap})
            relays.set(account, relay)
            peersMap[account] = relay.remote
        }
        return relay
    }

    /**
     * Per-connection fragment. Wire it next to the legacy object:
     *     const peer = host.connection(account)
     *     createRpcServerAuto({socket, object: {...legacyObject, peer: peer.fragment}, disconnectListen})
     *     disconnectListen.on(peer.close)
     */
    function connection(account: string) {
        if (closed) throw new Error('peer host closed')
        const port = hub.register(account)
        const mine = ensureRelay(account)
        presenceJoin(account)
        let connectionClosed = false
        function publish(envelope: PatchEnvelope) {
            return mine.push(envelope)
        }
        function publishBatch(envelopes: PatchEnvelope[]) {
            return mine.pushBatch(envelopes)
        }
        function closeConnection() {
            if (connectionClosed) return
            connectionClosed = true
            connections.delete(closeConnection)
            port.close()
            presenceLeave(account)
        }
        connections.add(closeConnection)
        return {
            fragment: {
                signal: {send: port.send, signals: port.signals},
                publish,
                publishBatch,
                peers: peersView,
                presence,
            },
            close: closeConnection,
        }
    }

    return {
        connection,
        /** Direct access to an account's relay journal (server-side consumers, tests). */
        relay: ensureRelay,
        accounts: () => Array.from(relays.keys()),
        /** Who is connected right now (server-side view; the fragment carries the same object). */
        presence,
        /** Server-side route revoke (policy change): both parties fall back to relay. */
        revoke: hub.revoke,
        close() {
            if (closed) return
            closed = true
            presenceChanges.close()
            for (const closeConnection of Array.from(connections)) closeConnection()
            connections.clear()
            hub.close()
            online.clear()
            for (const relay of relays.values()) relay.close()
            relays.clear()
            for (const account of Object.keys(peersMap)) delete peersMap[account]
        },
    }
}

export type PeerHost = ReturnType<typeof createPeerHost>
