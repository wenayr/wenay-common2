"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exposeStoreLazyLine = exposeStoreLazyLine;
exports.syncStoreLazyLine = syncStoreLazyLine;
const rpc_wire_size_1 = require("../rcp/rpc-wire-size");
const store_1 = require("./store");
const store_selection_1 = require("./store-selection");
let lazyLineCounter = 0;
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
    const lineId = opts.lineId ?? ('lazy-' + Date.now().toString(36) + '-' + (++lazyLineCounter));
    const selectedKeys = opts.keys == null
        ? null
        : (0, store_selection_1.normalizeStoreSelectionKeys)(opts.keys, 'exposeStoreLazyLine');
    const selected = selectedKeys == null ? null : new Set(selectedKeys);
    const selectionId = selectedKeys == null ? undefined : (0, store_selection_1.storeSelectionId)(selectedKeys);
    const keyRevision = new Map();
    const tombstones = new Map();
    let revision = 0;
    let oldestProvableRevision = 0;
    let sortedKeys = null;
    let closed = false;
    function keysInOrder() {
        if (sortedKeys == null) {
            const state = store.state;
            sortedKeys = selectedKeys == null
                ? Object.keys(state).sort()
                : selectedKeys.filter(function selectedKeyExists(key) {
                    return Object.prototype.hasOwnProperty.call(state, key);
                });
        }
        return sortedKeys;
    }
    function onStorePatches(patches) {
        if (closed)
            return;
        const state = store.state;
        let touched = false;
        for (const patch of patches) {
            if (patch.path.length == 0) {
                if (!touched) {
                    touched = true;
                    revision++;
                }
                applyRootReplacement(state);
                continue;
            }
            const key = String(patch.path[0]);
            if (selected != null && !selected.has(key))
                continue;
            if (!touched) {
                touched = true;
                revision++;
            }
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
    function applyRootReplacement(state) {
        sortedKeys = null;
        const scope = selectedKeys ?? [...new Set([...keyRevision.keys(), ...Object.keys(state)])];
        for (const key of scope) {
            if (Object.prototype.hasOwnProperty.call(state, key)) {
                keyRevision.set(key, revision);
                tombstones.delete(key);
            }
            else if (keyRevision.has(key)) {
                keyRevision.set(key, revision);
                if (!tombstones.has(key))
                    tombstones.set(key, now());
            }
        }
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
    for (const key of keysInOrder())
        keyRevision.set(key, 0);
    function currentValue(key) {
        const state = store.state;
        return Object.prototype.hasOwnProperty.call(state, key)
            ? { exists: true, value: state[key] }
            : { exists: false, value: undefined };
    }
    function read(request, emit) {
        if (closed)
            throw new Error('exposeStoreLazyLine: host is closed');
        pruneTombstones();
        const cursor = request.cursor ?? { lineId, selectionId, key: null, revision: 0 };
        if (cursor.key != null && (cursor.lineId != lineId || cursor.selectionId != selectionId
            || cursor.revision < oldestProvableRevision)) {
            return {
                cursor: { lineId, selectionId, key: null, revision: 0 },
                remaining: keysInOrder().length,
                filled: false,
                revision,
                stale: true,
            };
        }
        const budget = Math.min(positiveInteger(request.maxBytes, windowBytes, 'read: maxBytes'), windowBytes);
        const itemLimit = Math.min(positiveInteger(request.maxItems, maxItems, 'read: maxItems'), maxItems);
        const readRevision = revision;
        const keys = keysInOrder();
        let spent = 0;
        let chunkIndex = 0;
        let values = Object.create(null);
        let deleted = [];
        let count = 0;
        let chunkSize = 0;
        let chunkKind = 'live';
        let nextCursorKey = cursor.key;
        let catchUpKey = null;
        let caughtUp = true;
        let exhausted = false;
        function flush() {
            if (count == 0)
                return;
            emit({ index: chunkIndex++, values, deleted, kind: chunkKind });
            values = Object.create(null);
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
        const due = [];
        if (cursor.key != null) {
            const caught = cursor.catchUp;
            const floorFor = (key) => caught != null && key <= caught.key ? caught.revision : cursor.revision;
            for (const [key] of tombstones) {
                if (key <= cursor.key && (keyRevision.get(key) ?? 0) > floorFor(key))
                    due.push(key);
            }
            const end = firstAfter(keys, cursor.key);
            for (let i = 0; i < end; i++) {
                if ((keyRevision.get(keys[i]) ?? 0) > floorFor(keys[i]))
                    due.push(keys[i]);
            }
            due.sort();
        }
        for (const key of due) {
            if (spent >= budget) {
                caughtUp = false;
                exhausted = true;
                break;
            }
            send(key, 'live');
            catchUpKey = key;
        }
        if (!exhausted) {
            for (let i = firstAfter(keys, cursor.key); i < keys.length; i++) {
                if (spent >= budget) {
                    exhausted = true;
                    break;
                }
                send(keys[i], 'fill');
                nextCursorKey = keys[i];
            }
        }
        flush();
        const remaining = keys.length - firstAfter(keys, nextCursorKey);
        return {
            cursor: caughtUp
                ? { lineId, selectionId, key: nextCursorKey, revision: readRevision }
                : {
                    lineId, selectionId, key: nextCursorKey, revision: cursor.revision,
                    catchUp: { key: catchUpKey, revision: readRevision },
                },
            remaining,
            filled: remaining == 0 && caughtUp,
            revision,
        };
    }
    function firstAfter(keys, key) {
        if (key == null)
            return 0;
        let low = 0;
        let high = keys.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (keys[mid] <= key)
                low = mid + 1;
            else
                high = mid;
        }
        return low;
    }
    function snapshot() {
        return {
            revision,
            oldestProvableRevision,
            keys: keysInOrder().length,
            selectedKeys: selectedKeys?.length ?? null,
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
        view: {
            lineId,
            selectionId,
            keys: () => selectedKeys == null ? null : [...selectedKeys],
            snapshot,
        },
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
    let sweepSeen = cursor == null ? new Set() : null;
    let timer = null;
    let settleFirstPass = null;
    const firstPass = new Promise(function captureFirstPass(resolve) {
        settleFirstPass = resolve;
    });
    function applyChunk(chunk) {
        chunks++;
        const state = mirror.state;
        for (const key of Object.keys(chunk.values)) {
            if (key == '__proto__') {
                Reflect.defineProperty(state, key, {
                    configurable: true, enumerable: true, writable: true, value: chunk.values[key],
                });
            }
            else
                state[key] = chunk.values[key];
            sweepSeen?.add(key);
            received++;
        }
        for (const key of chunk.deleted) {
            delete state[key];
            sweepSeen?.add(key);
            received++;
        }
    }
    function sweepUnseen() {
        if (sweepSeen == null)
            return 0;
        const state = mirror.state;
        const seen = sweepSeen;
        sweepSeen = null;
        let swept = 0;
        for (const key of Object.keys(state)) {
            if (seen.has(key))
                continue;
            delete state[key];
            swept++;
        }
        return swept;
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
                sweepSeen = new Set();
                schedule(fillIntervalMs);
                return;
            }
            cursor = result.cursor;
            opts.onCursor?.(result.cursor);
            const swept = result.filled ? sweepUnseen() : 0;
            opts.onProgress?.({ received, remaining: result.remaining, filled: result.filled, chunks, swept });
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
        if (settleFirstPass == null)
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
