"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exposeStoreLazyLine = exposeStoreLazyLine;
exports.syncStoreLazyLine = syncStoreLazyLine;
const rpc_wire_size_1 = require("../rcp/rpc-wire-size");
const store_1 = require("./store");
function positiveInteger(value, fallback, name) {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result <= 0)
        throw new RangeError(name + ' must be a positive safe integer');
    return result;
}
function valueBytes(value) {
    return (0, rpc_wire_size_1.rpcResultWireMetricsFast)(value).byteLength;
}
function exposeStoreLazyLine(store, opts = {}) {
    const chunkBytes = positiveInteger(opts.chunkBytes, 32 * 1024, 'exposeStoreLazyLine: chunkBytes');
    const maxItems = positiveInteger(opts.maxItems, 512, 'exposeStoreLazyLine: maxItems');
    const windowBytes = positiveInteger(opts.windowBytes, 512 * 1024, 'exposeStoreLazyLine: windowBytes');
    const tombstoneKeepMs = positiveInteger(opts.tombstoneKeepMs, 600_000, 'exposeStoreLazyLine: tombstoneKeepMs');
    const now = opts.now ?? Date.now;
    const keyRevision = new Map();
    const tombstones = new Map();
    let revision = 0;
    let oldestProvableRevision = 0;
    let sortedKeys = null;
    let closed = false;
    function keysInOrder() {
        if (sortedKeys == null)
            sortedKeys = Object.keys(store.state).sort();
        return sortedKeys;
    }
    function onStorePatches(patches) {
        if (closed)
            return;
        revision++;
        const state = store.state;
        for (const patch of patches) {
            if (patch.path.length == 0) {
                sortedKeys = null;
                for (const key of Object.keys(state))
                    keyRevision.set(key, revision);
                continue;
            }
            const key = String(patch.path[0]);
            const known = keyRevision.has(key);
            keyRevision.set(key, revision);
            const exists = Object.prototype.hasOwnProperty.call(state, key);
            if (exists) {
                if (tombstones.delete(key) || !known)
                    sortedKeys = null;
            }
            else {
                if (!tombstones.has(key))
                    sortedKeys = null;
                tombstones.set(key, now());
            }
        }
        pruneTombstones();
    }
    function pruneTombstones() {
        if (tombstones.size == 0)
            return;
        const deadline = now() - tombstoneKeepMs;
        for (const [key, removedAt] of tombstones) {
            if (removedAt >= deadline)
                continue;
            tombstones.delete(key);
            const at = keyRevision.get(key);
            keyRevision.delete(key);
            if (at != undefined && at > oldestProvableRevision)
                oldestProvableRevision = at;
        }
    }
    const offPatches = (0, store_1.listenStorePatches)(store).on(onStorePatches);
    function currentValue(key) {
        const state = store.state;
        return Object.prototype.hasOwnProperty.call(state, key)
            ? { exists: true, value: state[key] }
            : { exists: false, value: undefined };
    }
    function read(request, emit) {
        if (closed)
            throw new Error('exposeStoreLazyLine: host is closed');
        const cursor = request.cursor ?? { key: null, revision: 0 };
        if (cursor.key != null && cursor.revision < oldestProvableRevision) {
            return { cursor: { key: null, revision: 0 }, remaining: keysInOrder().length, filled: false, revision, stale: true };
        }
        const budget = Math.min(positiveInteger(request.maxBytes, windowBytes, 'read: maxBytes'), windowBytes);
        const itemLimit = Math.min(positiveInteger(request.maxItems, maxItems, 'read: maxItems'), maxItems);
        const readRevision = revision;
        const keys = keysInOrder();
        let spent = 0;
        let chunkIndex = 0;
        let values = {};
        let deleted = [];
        let count = 0;
        let chunkSize = 0;
        let chunkKind = 'live';
        let nextCursorKey = cursor.key;
        let caughtUp = true;
        let exhausted = false;
        function flush() {
            if (count == 0)
                return;
            emit({ index: chunkIndex++, values, deleted, kind: chunkKind });
            values = {};
            deleted = [];
            count = 0;
            chunkSize = 0;
        }
        function send(key, kind) {
            const current = currentValue(key);
            const size = key.length + 4 + (current.exists ? valueBytes(current.value) : 0);
            if (count > 0 && (kind != chunkKind || chunkSize + size > chunkBytes || count >= itemLimit))
                flush();
            chunkKind = kind;
            if (current.exists)
                values[key] = current.value;
            else
                deleted.push(key);
            count++;
            chunkSize += size;
            spent += size;
        }
        for (const [key] of tombstones) {
            if (cursor.key == null || key > cursor.key)
                continue;
            if ((keyRevision.get(key) ?? 0) <= cursor.revision)
                continue;
            if (spent >= budget) {
                caughtUp = false;
                exhausted = true;
                break;
            }
            send(key, 'live');
        }
        if (!exhausted) {
            for (const key of keys) {
                if (spent >= budget) {
                    exhausted = true;
                    if (cursor.key != null && key <= cursor.key)
                        caughtUp = false;
                    break;
                }
                if (cursor.key != null && key <= cursor.key) {
                    if ((keyRevision.get(key) ?? 0) > cursor.revision)
                        send(key, 'live');
                    continue;
                }
                send(key, 'fill');
                nextCursorKey = key;
            }
        }
        flush();
        const remaining = countRemaining(keys, nextCursorKey);
        return {
            cursor: { key: nextCursorKey, revision: caughtUp ? readRevision : cursor.revision },
            remaining,
            filled: remaining == 0,
            revision,
        };
    }
    function countRemaining(keys, cursorKey) {
        if (cursorKey == null)
            return keys.length;
        let low = 0;
        let high = keys.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (keys[mid] <= cursorKey)
                low = mid + 1;
            else
                high = mid;
        }
        return keys.length - low;
    }
    function snapshot() {
        return {
            revision,
            oldestProvableRevision,
            keys: keysInOrder().length,
            tombstones: tombstones.size,
            trackedKeys: keyRevision.size,
            chunkBytes,
            windowBytes,
            tombstoneKeepMs,
        };
    }
    const api = { read };
    if (opts.describe)
        api.describe = () => ({ ...opts.describe });
    return {
        api,
        view: { snapshot },
        close: function closeHost() {
            if (closed)
                return;
            closed = true;
            keyRevision.clear();
            tombstones.clear();
            sortedKeys = null;
            offPatches?.();
        },
    };
}
function syncStoreLazyLine(mirror, remote, opts = {}) {
    const readBytes = positiveInteger(opts.readBytes, 256 * 1024, 'syncStoreLazyLine: readBytes');
    const fillIntervalMs = opts.fillIntervalMs ?? 0;
    const liveIntervalMs = opts.liveIntervalMs ?? 250;
    let stopped = false;
    let cursor = opts.cursor ?? null;
    let received = 0;
    let chunks = 0;
    let timer = null;
    let settleFirstPass = null;
    const firstPass = new Promise(function captureFirstPass(resolve) {
        settleFirstPass = resolve;
    });
    function applyChunk(chunk) {
        chunks++;
        const state = mirror.state;
        for (const key of Object.keys(chunk.values)) {
            state[key] = chunk.values[key];
            received++;
        }
        for (const key of chunk.deleted) {
            delete state[key];
            received++;
        }
    }
    async function step() {
        if (stopped)
            return;
        try {
            const result = await remote.read({ cursor, maxBytes: readBytes }, applyChunk);
            if (stopped)
                return;
            if (result.stale) {
                cursor = null;
                schedule(fillIntervalMs);
                return;
            }
            cursor = result.cursor;
            opts.onCursor?.(result.cursor);
            opts.onProgress?.({ received, remaining: result.remaining, filled: result.filled, chunks });
            if (result.filled && settleFirstPass) {
                settleFirstPass();
                settleFirstPass = null;
                if (opts.fillOnly) {
                    close();
                    return;
                }
            }
            schedule(result.filled ? liveIntervalMs : fillIntervalMs);
        }
        catch (error) {
            if (stopped)
                return;
            opts.onError?.(error);
            schedule(liveIntervalMs);
        }
    }
    function schedule(delayMs) {
        if (stopped)
            return;
        timer = setTimeout(function runLazyStep() { void step(); }, delayMs);
        timer.unref?.();
    }
    function close() {
        if (stopped)
            return;
        stopped = true;
        if (timer != null)
            clearTimeout(timer);
        timer = null;
        settleFirstPass?.();
        settleFirstPass = null;
    }
    void step();
    return {
        filled: firstPass,
        view: {
            snapshot: () => ({ received, chunks, running: !stopped, cursor }),
        },
        close,
    };
}
