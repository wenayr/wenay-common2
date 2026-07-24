"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPeerHost = createPeerHost;
const rpc_dynamic_1 = require("../rcp/rpc-dynamic");
const Listen_1 = require("../events/Listen");
const route_signal_webrtc_1 = require("../events/route-signal-webrtc");
const peer_relay_1 = require("./peer-relay");
function createPeerHost(deps = {}) {
    const { authorize, history, gap, accounts: accountAllowed } = deps;
    const hub = (0, route_signal_webrtc_1.createSignalHub)({ authorize });
    const relays = new Map();
    const connections = new Set();
    let closed = false;
    const peersMap = {};
    const peersView = (0, rpc_dynamic_1.noStrict)(new Proxy(peersMap, {
        has(_t, k) { return !closed && typeof k == 'string' && (!accountAllowed || accountAllowed(k)); },
        get(t, k) {
            if (typeof k != 'string')
                return t[k];
            if (closed)
                return undefined;
            if (accountAllowed && !accountAllowed(k))
                return undefined;
            return ensureRelay(k).remote;
        },
    }));
    const online = new Map();
    const [emitPresence, presenceChanges] = (0, Listen_1.listen)();
    const presence = {
        list: () => Array.from(online.keys()),
        changes: presenceChanges,
    };
    function presenceJoin(account) {
        const n = (online.get(account) ?? 0) + 1;
        online.set(account, n);
        if (n == 1)
            emitPresence({ account, online: true });
    }
    function presenceLeave(account) {
        const n = (online.get(account) ?? 0) - 1;
        if (n > 0) {
            online.set(account, n);
            return;
        }
        online.delete(account);
        emitPresence({ account, online: false });
    }
    function ensureRelay(account) {
        if (closed)
            throw new Error('peer host closed');
        let relay = relays.get(account);
        if (!relay) {
            relay = (0, peer_relay_1.createPatchRelayJournal)({ history, gap });
            relays.set(account, relay);
            peersMap[account] = relay.remote;
        }
        return relay;
    }
    function connection(account) {
        if (closed)
            throw new Error('peer host closed');
        const port = hub.register(account);
        const mine = ensureRelay(account);
        presenceJoin(account);
        let connectionClosed = false;
        function publish(envelope) {
            return mine.push(envelope);
        }
        function publishBatch(envelopes) {
            return mine.pushBatch(envelopes);
        }
        function closeConnection() {
            if (connectionClosed)
                return;
            connectionClosed = true;
            connections.delete(closeConnection);
            port.close();
            presenceLeave(account);
        }
        connections.add(closeConnection);
        return {
            fragment: {
                signal: { send: port.send, signals: port.signals },
                publish,
                publishBatch,
                peers: peersView,
                presence,
            },
            close: closeConnection,
        };
    }
    return {
        connection,
        relay: ensureRelay,
        accounts: () => Array.from(relays.keys()),
        presence,
        revoke: hub.revoke,
        close() {
            if (closed)
                return;
            closed = true;
            presenceChanges.close();
            for (const closeConnection of Array.from(connections))
                closeConnection();
            connections.clear();
            hub.close();
            online.clear();
            for (const relay of relays.values())
                relay.close();
            relays.clear();
            for (const account of Object.keys(peersMap))
                delete peersMap[account];
        },
    };
}
