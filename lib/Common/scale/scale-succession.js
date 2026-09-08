"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLineSuccession = createLineSuccession;
const replicated_map_1 = require("../Observe/replicated-map");
function createLineSuccession(deps) {
    const label = deps.label ?? 'line';
    let owner = null;
    let follower = null;
    let lastKnown = {};
    let closed = false;
    function role() {
        return owner ? 'owner' : follower ? 'follower' : 'idle';
    }
    function snapshot() {
        if (owner)
            return owner.control.snapshot();
        if (follower)
            return follower.snapshot();
        return lastKnown;
    }
    function rows() {
        return Object.values(snapshot()).filter(function present(value) { return value != undefined; });
    }
    function stopFollowing() {
        if (!follower)
            return;
        lastKnown = follower.snapshot();
        follower.close();
        follower = null;
    }
    function stopOwning() {
        if (!owner)
            return;
        lastKnown = owner.control.snapshot();
        owner.control.close();
        owner = null;
    }
    function follow(remote) {
        if (closed)
            throw new Error(label + ' succession is closed');
        stopOwning();
        stopFollowing();
        follower = (0, replicated_map_1.followReplicatedMap)(remote, {
            initial: lastKnown,
            ...(deps.onError ? { onError: deps.onError } : {}),
        });
        return follower.ready;
    }
    function promote() {
        if (closed)
            throw new Error(label + ' succession is closed');
        if (owner)
            return owner;
        const seed = rows();
        stopFollowing();
        owner = deps.produce(seed);
        deps.log?.(`${label}: promoted with ${seed.length} row(s)`);
        return owner;
    }
    function demote() {
        if (!owner)
            return;
        stopOwning();
        deps.log?.(`${label}: demoted`);
    }
    function requireOwner(verb = 'write') {
        if (!owner)
            throw new Error(`${label}: ${verb} refused — this process does not own the line (${role()})`);
        return owner;
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
        snapshot,
        rows,
        follow,
        promote,
        demote,
        requireOwner,
        owner: () => owner,
        close,
    };
}
