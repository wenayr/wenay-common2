"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storePatchKey = storePatchKey;
exports.exposeStoreReplay = exposeStoreReplay;
exports.syncStoreReplay = syncStoreReplay;
exports.syncStoreReplayRoute = syncStoreReplayRoute;
exports.syncStoreReplayEach = syncStoreReplayEach;
exports.storeReplayAt = storeReplayAt;
const store_1 = require("./store");
const replay_listen_1 = require("../events/replay-listen");
const replay_wire_1 = require("../events/replay-wire");
const replay_route_1 = require("../events/replay-route");
const replay_history_1 = require("../events/replay-history");
function storePatchKey(patch) {
    for (const k of patch.path)
        if (typeof k == 'symbol')
            return null;
    return JSON.stringify(patch.path);
}
function condensePatchTail(tail) {
    const held = new Map();
    for (const ev of tail) {
        const k = storePatchKey(ev.event[0]);
        if (k == null)
            return tail;
        held.delete(k);
        held.set(k, ev);
    }
    return [...held.values()];
}
function exposeStoreReplay(store, opts = {}) {
    const [emitPatch, lineApi] = (0, replay_listen_1.replayListen)({
        current: () => [{ path: [], exists: true, value: store.snapshot() }],
        frame: condensePatchTail,
        history: opts.getSince ? undefined : (opts.history ?? 1024),
        getSince: opts.getSince,
        onJournal: opts.onJournal,
        now: opts.now,
    });
    const { patches, changedData: _changedData, ...storeApi } = (0, store_1.exposeStore)(store, { push: true });
    const offStore = patches.on(function journalStoreChange(patch) {
        emitPatch(patch);
    });
    return {
        api: { ...storeApi, replay: (0, replay_wire_1.exposeReplay)(lineApi) },
        replay: lineApi,
        close: () => { offStore(); },
    };
}
function syncStoreReplay(store, remote, opts = {}) {
    return (0, replay_wire_1.replaySubscribe)(remote, function applyLine(patch) { (0, store_1.applyStorePatch)(store, patch); }, opts);
}
function syncStoreReplayRoute(store, remote, opts = {}) {
    return (0, replay_route_1.replayRouteSubscribe)(remote, function applyRoutePatch(patch) { (0, store_1.applyStorePatch)(store, patch); }, opts);
}
function syncStoreReplayEach(remote, cb, opts = {}) {
    const { drain, initial, ...wireOpts } = opts;
    const store = (0, store_1.createStore)((initial ?? {}), drain !== undefined ? { drain } : {});
    const offEach = store.each().on(cb);
    const sub = syncStoreReplay(store, remote, wireOpts);
    function off() { offEach(); sub(); }
    return Object.assign(off, {
        store,
        ready: sub.ready,
        seq: sub.seq,
        isStale: sub.isStale,
        lastTs: sub.lastTs,
    });
}
function storeReplayAt(storage, at = {}) {
    const envelopes = (0, replay_history_1.openHistory)(storage).at(at);
    if (!envelopes)
        return undefined;
    const scratch = (0, store_1.createStore)({});
    for (const ev of envelopes)
        (0, store_1.applyStorePatch)(scratch, ev.event[0]);
    return scratch.snapshot();
}
