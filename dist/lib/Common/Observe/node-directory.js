"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NODE_DIRECTORY_STALE_MS = void 0;
exports.createNodeDirectory = createNodeDirectory;
exports.nodeDirectoryViews = nodeDirectoryViews;
exports.pickDirectoryNode = pickDirectoryNode;
exports.followNodeDirectory = followNodeDirectory;
exports.directoryRoutePriority = directoryRoutePriority;
exports.directoryReplicaOffers = directoryReplicaOffers;
const deep_equal_1 = require("../core/deep-equal");
const store_1 = require("./store");
const reactive_1 = require("./reactive");
const store_replay_1 = require("./store-replay");
const store_follower_1 = require("./store-follower");
const store_replica_set_1 = require("./store-replica-set");
exports.NODE_DIRECTORY_STALE_MS = 15_000;
function requireNodeId(value) {
    if (typeof value != 'string' || value.length == 0)
        throw new TypeError('node directory nodeId must be a non-empty string');
    return value;
}
function requireEntry(entry) {
    requireNodeId(entry.nodeId);
    if (typeof entry.url != 'string')
        throw new TypeError('node directory url must be a string');
    if (!Number.isFinite(entry.weight))
        throw new TypeError('node directory weight must be a finite number');
    return entry;
}
function createNodeDirectory(deps = {}) {
    const { now = Date.now } = deps;
    const staleMs = deps.staleMs ?? exports.NODE_DIRECTORY_STALE_MS;
    const owned = !deps.store;
    const store = deps.store ?? (0, store_1.createStore)({ nodes: {} });
    const exposed = owned ? (0, store_replay_1.exposeStoreReplay)(store, {
        ...deps.replay,
        describe: { ...deps.replay?.describe, nodeDirectory: { version: 2 } },
    }) : null;
    const lastBeat = new Map();
    let closed = false;
    function rows() {
        return store.state.nodes;
    }
    function rawRows() {
        return (0, reactive_1.toRaw)(store.state).nodes;
    }
    function get(nodeId) {
        return rawRows()[requireNodeId(nodeId)];
    }
    function snapshot() {
        return store.snapshot().nodes;
    }
    function set(row) {
        const moment = now();
        const current = get(row.nodeId);
        const entry = requireEntry({
            draining: false, ...row,
            alive: true,
            since: current?.alive ? current.since : moment,
        });
        lastBeat.set(entry.nodeId, moment);
        if (!current || !(0, deep_equal_1.compareDeepValues)(current, entry))
            rows()[entry.nodeId] = entry;
    }
    function patch(nodeId, partial) {
        const current = get(nodeId);
        if (!current)
            return false;
        const meta = partial.meta ? { ...current.meta, ...partial.meta } : current.meta;
        const next = requireEntry({ ...current, ...partial, ...(meta ? { meta } : {}), nodeId, alive: current.alive, since: current.since });
        if (!(0, deep_equal_1.compareDeepValues)(current, next))
            rows()[nodeId] = next;
        return true;
    }
    function heartbeat(nodeId, partial = {}) {
        const current = get(nodeId);
        if (!current)
            return false;
        lastBeat.set(nodeId, now());
        if (!current.alive)
            rows()[nodeId] = { ...current, alive: true, since: now() };
        return patch(nodeId, partial);
    }
    function drain(nodeId) {
        return patch(nodeId, { draining: true });
    }
    function undrain(nodeId, weight) {
        return patch(nodeId, weight == undefined ? { draining: false } : { draining: false, weight });
    }
    function remove(nodeId) {
        requireNodeId(nodeId);
        lastBeat.delete(nodeId);
        if (rawRows()[nodeId])
            delete rows()[nodeId];
    }
    function grace() {
        const moment = now();
        for (const nodeId of Object.keys(rawRows()))
            lastBeat.set(nodeId, moment);
    }
    function sweep() {
        if (staleMs <= 0)
            return;
        const moment = now();
        for (const nodeId of Object.keys(rawRows())) {
            const entry = rawRows()[nodeId];
            if (!entry || !entry.alive)
                continue;
            const beat = lastBeat.get(nodeId);
            if (beat == undefined) {
                lastBeat.set(nodeId, moment);
                continue;
            }
            if (moment - beat > staleMs)
                rows()[nodeId] = { ...entry, alive: false, since: moment };
        }
    }
    const sweeper = staleMs > 0 ? setInterval(sweep, deps.sweepMs ?? Math.max(50, Math.floor(staleMs / 2))) : null;
    sweeper?.unref?.();
    function flush() {
        exposed?.flushPending();
    }
    function close() {
        if (closed)
            return;
        closed = true;
        if (sweeper)
            clearInterval(sweeper);
        exposed?.close();
    }
    if (deps.initial)
        for (const row of deps.initial)
            set(row);
    return {
        api: (exposed?.api.replay ?? null),
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
        store,
        close,
    };
}
function nodeDirectoryViews(state) {
    const views = [];
    for (const nodeId of Object.keys(state)) {
        const entry = state[nodeId];
        if (!entry)
            continue;
        views.push({ ...entry, eligible: entry.alive && !entry.draining && entry.weight > 0 });
    }
    return views;
}
function pickDirectoryNode(views, opts = {}) {
    const excluded = new Set(typeof opts.exclude == 'string' ? [opts.exclude] : opts.exclude ?? []);
    const eligible = views.filter(function placeable(view) {
        return view.eligible && !excluded.has(view.nodeId);
    });
    if (eligible.length == 0)
        return null;
    const total = eligible.reduce(function sumWeights(sum, view) { return sum + view.weight; }, 0);
    let roll = (opts.rng ?? Math.random)() * total;
    for (const view of eligible) {
        roll -= view.weight;
        if (roll < 0)
            return view;
    }
    return eligible[eligible.length - 1];
}
function followNodeDirectory(remote, opts = {}) {
    const follower = (0, store_follower_1.createStoreFollower)({
        remote,
        initial: opts.initial ?? { nodes: {} },
        ...(opts.staleMs != undefined ? { staleMs: opts.staleMs } : {}),
        ...(opts.expose ? { expose: opts.expose } : {}),
    });
    function nodes() {
        return nodeDirectoryViews(follower.store.snapshot().nodes ?? {});
    }
    function pick(pickOpts = {}) {
        return pickDirectoryNode(nodes(), pickOpts);
    }
    function onNodes(cb) {
        return follower.store.node.at('nodes').on(function forwardRosterChange() { cb(nodes()); });
    }
    function onNode(nodeId, cb, watchOpts = {}) {
        return follower.store.node.at('nodes').at(nodeId).on(function forwardRowChange(value) {
            cb(value);
        }, watchOpts);
    }
    return {
        nodes,
        pick,
        onNodes,
        onNode,
        ready: follower.ready,
        status: follower.status,
        isStale: follower.isStale,
        api: follower.api,
        store: follower.store,
        close: follower.close,
    };
}
function directoryRoutePriority(view) {
    return Math.round(1000 / Math.max(view.weight, 1e-3));
}
function directoryReplicaOffers(deps) {
    const source = (0, store_replica_set_1.createStoreReplicaOffers)();
    const stable = new Map();
    function offerOf(view) {
        let entry = stable.get(view.nodeId);
        if (!entry) {
            const created = {
                view,
                connect: function connectDirectoryNode() { return deps.connect(created.view); },
            };
            stable.set(view.nodeId, created);
            entry = created;
        }
        entry.view = view;
        return {
            id: view.nodeId,
            priority: deps.priorityOf?.(view) ?? directoryRoutePriority(view),
            connect: entry.connect,
        };
    }
    let lastSignature = '';
    function syncOffers(views) {
        const wanted = views.filter(function usable(view) { return view.eligible; });
        const wantedIds = new Set(wanted.map(function idOf(view) { return view.nodeId; }));
        for (const nodeId of [...stable.keys()]) {
            if (!wantedIds.has(nodeId))
                stable.delete(nodeId);
        }
        const offers = wanted.map(offerOf);
        const signature = offers.map(function priceOf(offer) { return offer.id + '@' + offer.priority; }).join('|');
        if (signature == lastSignature)
            return;
        lastSignature = signature;
        source.control.replace(offers);
    }
    const offNodes = deps.directory.onNodes(syncOffers);
    syncOffers(deps.directory.nodes());
    return {
        api: source.api,
        refresh() { syncOffers(deps.directory.nodes()); },
        close() {
            offNodes();
            source.control.clear();
        },
    };
}
