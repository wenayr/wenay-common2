// =====================================================================
// Peer host — the server-side SDK fragment (legacy-friendly by design)
// =====================================================================
// connection(account) returns an object FRAGMENT to spread into the app's
// EXISTING createRpcServerAuto object: {...legacyObject, peer: fragment}.
// Old keys keep working untouched; the fragment adds three things:
//   signal  — the per-account signaling port (WebRTC offer/answer/ICE/revoke)
//   publish — the owner's patch line lands in its relay journal (owner seq space)
//   peers   — noStrict dynamic map: every account's relay journal, ReplayRemote-shaped
// The relay journal outlives the connection: late subscribers get a folded
// keyframe even while the owner is offline.

import {noStrict} from '../rcp/rpc-dynamic'
import {StorePatch} from '../Observe/store'
import {ReplayRemote} from '../events/replay-wire'
import {createSignalHub, SignalEnvelope} from '../events/route-signal-webrtc'
import {createPatchRelayJournal, PatchEnvelope, PatchRelayJournal} from './peer-relay'

export type PeerHostDeps = {
    /** Server-side canExposeEndpoint: the only place endpoint/session material may pass. */
    authorize?: (env: SignalEnvelope) => boolean | Promise<boolean>
    /** Relay journal depth per account. */
    history?: number
}

export function createPeerHost(deps: PeerHostDeps = {}) {
    const {authorize, history} = deps
    const hub = createSignalHub({authorize})
    const relays = new Map<string, PatchRelayJournal>()
    // dynamic keyspace: accounts appear at runtime, clients resolve them by string path
    const peersView: Record<string, ReplayRemote<[StorePatch]>> = noStrict({})

    function ensureRelay(account: string) {
        let relay = relays.get(account)
        if (!relay) {
            relay = createPatchRelayJournal({history})
            relays.set(account, relay)
            peersView[account] = relay.remote
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
        const port = hub.register(account)
        const mine = ensureRelay(account)
        return {
            fragment: {
                signal: {send: port.send, signals: port.signals},
                publish: (env: PatchEnvelope) => mine.push(env),
                peers: peersView,
            },
            close: () => port.close(),
        }
    }

    return {
        connection,
        /** Direct access to an account's relay journal (server-side consumers, tests). */
        relay: ensureRelay,
        accounts: () => Array.from(relays.keys()),
        /** Server-side route revoke (policy change): both parties fall back to relay. */
        revoke: hub.revoke,
        close() {
            hub.close()
            for (const relay of relays.values()) relay.close()
            relays.clear()
        },
    }
}

export type PeerHost = ReturnType<typeof createPeerHost>
