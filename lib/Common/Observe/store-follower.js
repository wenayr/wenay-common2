"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStoreFollower = createStoreFollower;
exports.diffKeyedState = diffKeyedState;
const store_1 = require("./store");
const store_replay_1 = require("./store-replay");
const transport_lifecycle_1 = require("../events/transport-lifecycle");
const common_1 = require("../core/common");
function errorText(error) {
    if (typeof error?.message == 'string')
        return error.message;
    return String(error);
}
function createStoreFollower(deps) {
    const store = (0, store_1.createStore)((deps.initial ?? {}));
    const status = (0, store_1.createStore)({
        upstream: 'catching-up', seq: -1, replayMode: 'v2', epoch: deps.epoch ?? 0, error: null,
    });
    function setUpstream(next) {
        if (status.state.upstream == 'closed' || status.state.upstream == 'promoted')
            return;
        if (status.state.upstream != next)
            status.state.upstream = next;
    }
    const sub = (0, store_replay_1.syncStoreReplay)(store, deps.remote, {
        onSeq: function trackUpstreamSeq(seq) {
            status.state.seq = seq;
            status.state.replayMode = sub.mode;
        },
        onLive: function upstreamLive() { setUpstream('live'); },
        onError: function upstreamFailed(error) {
            status.state.error = errorText(error);
            status.state.upstream = 'closed';
        },
        ...(deps.staleMs != null ? { staleMs: deps.staleMs } : {}),
    });
    const lifecycle = (0, transport_lifecycle_1.getRpcTransportLifecycle)(deps.remote);
    const offDisconnect = lifecycle?.onDisconnect(function upstreamGone() {
        setUpstream('offline');
    }) ?? function noDisconnectListener() { };
    const offConnect = lifecycle?.onConnect(function upstreamBack() {
        setUpstream('catching-up');
    }) ?? function noConnectListener() { };
    const exposeOpts = deps.expose ?? {};
    const exposed = (0, store_replay_1.exposeStoreReplay)(store, exposeOpts);
    let promoted = false;
    function promote() {
        if (status.state.upstream == 'closed')
            throw new Error('store follower is closed');
        if (!promoted) {
            promoted = true;
            offConnect();
            offDisconnect();
            sub();
            status.state.upstream = 'promoted';
            status.state.epoch = (deps.epoch ?? 0) + 1;
        }
        return { store, replay: exposed.replay, epoch: status.state.epoch };
    }
    return {
        store,
        status,
        isStale: sub.isStale,
        api: exposed.api,
        replay: exposed.replay,
        ready: sub.ready,
        promote,
        close() {
            offConnect();
            offDisconnect();
            sub();
            exposed.close();
            if (status.state.upstream != 'closed')
                status.state.upstream = 'closed';
        },
    };
}
function diffKeyedState(local, authority) {
    const localOnly = [];
    const authorityOnly = [];
    const conflicts = [];
    for (const [key, value] of Object.entries(local)) {
        const winner = authority[key];
        if (winner === undefined)
            localOnly.push(value);
        else if (!(0, common_1.deepEqual)(value, winner))
            conflicts.push({ key, local: value, authority: winner });
    }
    for (const [key, value] of Object.entries(authority)) {
        if (local[key] === undefined)
            authorityOnly.push(value);
    }
    return { localOnly, authorityOnly, conflicts };
}
