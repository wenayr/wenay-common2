"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPatchRelayJournal = createPatchRelayJournal;
const Listen_1 = require("../events/Listen");
const store_1 = require("../Observe/store");
const peer_publish_batch_1 = require("./peer-publish-batch");
function storePatchKey(patch) {
    for (const key of patch.path)
        if (typeof key == 'symbol')
            return null;
    return JSON.stringify(patch.path);
}
function condensePatchTail(tail) {
    const held = new Map();
    for (const ev of tail) {
        const key = storePatchKey(ev.event[0]);
        if (key == null)
            return tail;
        held.delete(key);
        held.set(key, ev);
    }
    return Array.from(held.values());
}
function createPatchRelayJournal(opts = {}) {
    const { history = 1024, gap = 'resume' } = opts;
    const folding = gap != 'sacred';
    const ringCapacity = Number.isFinite(history)
        ? Math.max(0, Math.floor(history))
        : Number.MAX_SAFE_INTEGER;
    let batchDeliveryErrors = null;
    const [emitLine, line] = (0, Listen_1.listen)({
        [Listen_1.LISTEN_DISPATCH_ERROR]: function captureDeliveryError(error) {
            if (batchDeliveryErrors) {
                batchDeliveryErrors.push(error);
                return;
            }
            rethrowDeliveryErrors([error]);
        },
    });
    let fold = folding ? (0, store_1.createStore)({}, { drain: 'micro' }) : null;
    let ring = [];
    let ringStart = 0;
    let ringLength = 0;
    let last = -1;
    let lastTs = 0;
    let hasState = false;
    let closed = false;
    const deliveryQueue = [];
    let deliveryCursor = 0;
    let deliveryHold = 0;
    let delivering = false;
    function rethrowDeliveryErrors(errors) {
        if (!errors.length)
            return;
        const error = errors.length == 1
            ? errors[0]
            : new AggregateError(errors, 'peer relay subscriber errors');
        setTimeout(function throwDeliveryErrors() { throw error; }, 0);
    }
    function drainDeliveries() {
        if (delivering || deliveryHold > 0)
            return;
        delivering = true;
        try {
            while (deliveryCursor < deliveryQueue.length) {
                emitLine(deliveryQueue[deliveryCursor++]);
            }
        }
        finally {
            if (deliveryCursor == deliveryQueue.length)
                deliveryQueue.length = 0;
            else if (deliveryCursor > 0)
                deliveryQueue.splice(0, deliveryCursor);
            deliveryCursor = 0;
            delivering = false;
        }
    }
    function deliver(env) {
        deliveryQueue.push(env);
        drainDeliveries();
    }
    function clearRing() {
        ring = [];
        ringStart = 0;
        ringLength = 0;
    }
    function appendRing(env) {
        if (ringCapacity <= 0)
            return;
        if (ringLength < ringCapacity) {
            ring[(ringStart + ringLength) % ringCapacity] = env;
            ringLength++;
            return;
        }
        ring[ringStart] = env;
        ringStart = (ringStart + 1) % ringCapacity;
    }
    function ringAt(index) {
        return ring[(ringStart + index) % ringCapacity];
    }
    function accept(env, reset) {
        try {
            if (fold)
                (0, store_1.applyStorePatch)(fold, env.event[0]);
            else {
                const validationFold = (0, store_1.createStore)({}, { drain: 'micro' });
                (0, store_1.applyStorePatch)(validationFold, env.event[0]);
            }
        }
        catch {
            return false;
        }
        if (reset)
            clearRing();
        last = env.seq;
        lastTs = env.ts ?? lastTs;
        hasState = true;
        appendRing(env);
        deliver(env);
        return true;
    }
    function push(env) {
        if (closed)
            return false;
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
    function pushBatch(envelopes) {
        if (closed)
            return false;
        if (!Array.isArray(envelopes))
            return false;
        if (!envelopes.length)
            return true;
        if (envelopes.length > peer_publish_batch_1.PEER_PUBLISH_BATCH_MAX_ITEMS)
            return false;
        try {
            if ((0, peer_publish_batch_1.peerPublishBatchBytes)(envelopes) > peer_publish_batch_1.PEER_PUBLISH_BATCH_MAX_BYTES)
                return false;
        }
        catch {
            return false;
        }
        let point = last;
        let state = hasState;
        let previous = -Infinity;
        const accepted = [];
        const ignoredPatches = [];
        for (const env of envelopes) {
            if (env == null || typeof env.seq != 'number' || env.seq <= previous)
                return false;
            const patch = env.event?.[0];
            if (patch == null || !Array.isArray(patch.path))
                return false;
            previous = env.seq;
            const isRoot = patch.path.length == 0;
            if (env.seq <= point) {
                if (folding && isRoot && env.seq < point) {
                    accepted.push({ env, reset: true });
                    point = env.seq;
                    state = true;
                }
                else
                    ignoredPatches.push(patch);
                continue;
            }
            let reset = false;
            if (state && env.seq > point + 1) {
                if (!folding || !isRoot)
                    return { seq: last };
                reset = true;
            }
            else if (folding && !state && !isRoot) {
                return { seq: last };
            }
            accepted.push({ env, reset });
            point = env.seq;
            state = true;
        }
        try {
            if (ignoredPatches.length) {
                const validationFold = (0, store_1.createStore)({}, { drain: 'micro' });
                (0, store_1.applyStorePatches)(validationFold, ignoredPatches);
            }
            const acceptedPatches = accepted.map(action => action.env.event[0]);
            if (fold)
                (0, store_1.applyStorePatches)(fold, acceptedPatches);
            else if (acceptedPatches.length) {
                const validationFold = (0, store_1.createStore)({}, { drain: 'micro' });
                (0, store_1.applyStorePatches)(validationFold, acceptedPatches);
            }
        }
        catch {
            return false;
        }
        const errors = [];
        const previousErrors = batchDeliveryErrors;
        batchDeliveryErrors = errors;
        deliveryHold++;
        try {
            for (const { env, reset } of accepted) {
                if (reset)
                    clearRing();
                last = env.seq;
                lastTs = env.ts ?? lastTs;
                hasState = true;
                appendRing(env);
                deliver(env);
            }
        }
        finally {
            deliveryHold--;
            drainDeliveries();
            batchDeliveryErrors = previousErrors;
        }
        rethrowDeliveryErrors(errors);
        return true;
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
        if (!ringLength || seq < ringAt(0).seq - 1)
            return null;
        const tail = [];
        for (let i = 0; i < ringLength; i++) {
            const env = ringAt(i);
            if (env.seq > seq)
                tail.push(env);
        }
        return tail;
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
    function close() {
        if (closed)
            return;
        closed = true;
        deliveryQueue.length = 0;
        clearRing();
        fold = null;
        hasState = false;
        line.close();
    }
    return {
        push,
        pushBatch,
        remote,
        gap,
        seq: () => last,
        snapshot: () => fold?.snapshot(),
        close,
    };
}
