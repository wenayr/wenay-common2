"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPatchRelayJournal = createPatchRelayJournal;
const Listen_1 = require("../events/Listen");
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
function condensePatchTail(tail) {
    const held = new Map();
    for (const ev of tail) {
        const k = (0, store_replay_1.storePatchKey)(ev.event[0]);
        if (k == null)
            return tail;
        held.delete(k);
        held.set(k, ev);
    }
    return Array.from(held.values());
}
function createPatchRelayJournal(opts = {}) {
    const { history = 1024, gap = 'resume' } = opts;
    const folding = gap != 'sacred';
    const [emitLine, line] = (0, Listen_1.listen)();
    const fold = folding ? (0, store_1.createStore)({}, { drain: 'micro' }) : null;
    let ring = [];
    let last = -1;
    let lastTs = 0;
    let hasState = false;
    function accept(env, reset) {
        if (reset)
            ring = [];
        last = env.seq;
        lastTs = env.ts ?? lastTs;
        hasState = true;
        if (fold)
            (0, store_1.applyStorePatch)(fold, env.event[0]);
        ring.push(env);
        if (ring.length > history)
            ring.splice(0, ring.length - history);
        emitLine(env);
        return true;
    }
    function push(env) {
        if (env == null || typeof env.seq != 'number')
            return false;
        const patch = env.event?.[0];
        if (patch == null || !Array.isArray(patch.path))
            return false;
        const isRoot = patch.path.length == 0;
        if (env.seq <= last) {
            if (folding && isRoot && env.seq < last)
                return accept(env, true);
            return true;
        }
        if (hasState && env.seq > last + 1) {
            if (folding && isRoot)
                return accept(env, true);
            return { seq: last };
        }
        if (folding && !hasState && !isRoot)
            return { seq: -1 };
        return accept(env, false);
    }
    function keyframe() {
        if (!fold || !hasState)
            return null;
        return { seq: last, ts: lastTs, event: [{ path: [], exists: true, value: fold.snapshot() }] };
    }
    function since(seq) {
        if (!hasState)
            return null;
        if (seq >= last)
            return [];
        if (!ring.length || seq < ring[0].seq - 1)
            return null;
        return ring.filter(ev => ev.seq > seq);
    }
    function frame(seq, _hint) {
        const tail = since(seq);
        if (tail)
            return condensePatchTail(tail);
        const kf = keyframe();
        if (kf)
            return [kf];
        if (!folding && hasState)
            throw new Error('sacred relay journal: tail evicted, no keyframe to invent');
        return null;
    }
    const remote = {
        line, since, keyframe, frame,
        seq: () => last,
    };
    return {
        push,
        remote,
        gap,
        seq: () => last,
        snapshot: () => fold?.snapshot(),
        close: () => { line.close(); },
    };
}
