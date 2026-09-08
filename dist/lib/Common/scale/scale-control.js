"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyControlState = emptyControlState;
exports.createControlLine = createControlLine;
exports.projectStoreSection = projectStoreSection;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
const store_follower_1 = require("../Observe/store-follower");
function emptyControlState() {
    return { nodes: {}, revoked: {}, receipts: {} };
}
function createControlLine(deps) {
    const label = deps.label ?? 'control line';
    const expose = deps.describe ? { describe: deps.describe } : {};
    let owner = null;
    let follower = null;
    let lastKnown = deps.initial;
    let closed = false;
    let seedStore = deps.store ?? null;
    function role() {
        return owner ? 'owner' : follower ? 'follower' : 'idle';
    }
    let idleStore = null;
    function store() {
        if (owner)
            return owner.store;
        if (follower)
            return follower.store;
        return idleStore ??= (0, store_1.createStore)(lastKnown);
    }
    function stopFollowing() {
        if (!follower)
            return;
        lastKnown = follower.store.snapshot();
        follower.close();
        follower = null;
    }
    function stopOwning() {
        if (!owner)
            return;
        lastKnown = owner.store.snapshot();
        owner.close();
        owner = null;
    }
    function follow(remote) {
        if (closed)
            throw new Error(label + ' is closed');
        stopOwning();
        stopFollowing();
        idleStore = null;
        follower = (0, store_follower_1.createStoreFollower)({ remote, initial: lastKnown, expose });
        return follower.ready;
    }
    function promote() {
        if (closed)
            throw new Error(label + ' is closed');
        if (owner)
            return owner.store;
        if (follower && follower.status.state.upstream != 'closed') {
            const taken = follower;
            taken.promote();
            owner = { store: taken.store, api: taken.api.replay, close: taken.close };
            follower = null;
        }
        else {
            stopFollowing();
            const fresh = idleStore ?? seedStore ?? (0, store_1.createStore)(lastKnown);
            idleStore = null;
            seedStore = null;
            const exposed = (0, store_replay_1.exposeStoreReplay)(fresh, { ...expose, ...deps.expose });
            owner = { store: fresh, api: exposed.api.replay, close: exposed.close };
            deps.onOwned?.({ replay: exposed.replay, flushPending: exposed.flushPending });
        }
        deps.log?.(`${label}: owned`);
        return owner.store;
    }
    function demote() {
        if (!owner)
            return;
        stopOwning();
        deps.log?.(`${label}: released`);
    }
    function api(verb = 'serve') {
        if (!owner)
            throw new Error(`${label}: ${verb} refused — this process does not own the line (${role()})`);
        return owner.api;
    }
    function close() {
        if (closed)
            return;
        closed = true;
        stopFollowing();
        stopOwning();
    }
    if (deps.own)
        promote();
    return {
        role,
        store,
        api,
        owner: () => owner != null,
        follow,
        promote,
        demote,
        followStatus: () => follower?.status ?? null,
        close,
    };
}
function projectStoreSection(source, key, describe) {
    const projected = (0, store_1.createStore)({ [key]: source.snapshot()[key] });
    const exposed = (0, store_replay_1.exposeStoreReplay)(projected, describe ? { describe } : {});
    const off = (0, store_1.listenStorePatches)(source).on(function forwardSectionPatches(patches) {
        const mine = [];
        for (const patch of patches) {
            if (patch.path.length == 0) {
                mine.push({ path: [key], exists: true, value: patch.value?.[key] ?? {} });
            }
            else if (patch.path[0] == key) {
                mine.push(patch);
            }
        }
        if (mine.length)
            (0, store_1.applyStorePatches)(projected, mine);
    });
    return {
        api: exposed.api.replay,
        store: projected,
        close() {
            off();
            exposed.close();
        },
    };
}
