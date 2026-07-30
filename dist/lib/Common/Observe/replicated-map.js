"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createReplicatedMap = createReplicatedMap;
exports.followReplicatedMap = followReplicatedMap;
const Listen_1 = require("../events/Listen");
const replay_wire_1 = require("../events/replay-wire");
const transport_lifecycle_1 = require("../events/transport-lifecycle");
const rpc_limits_1 = require("../rcp/rpc-limits");
const store_projection_1 = require("./store-projection");
const store_1 = require("./store");
const store_replay_1 = require("./store-replay");
const reactive_1 = require("./reactive");
const deep_equal_1 = require("../core/deep-equal");
function owns(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function requireReplicatedMapKey(key) {
    if (typeof key != 'string')
        throw new TypeError('replicated map key must be a string');
    if (!(0, rpc_limits_1.isSafeKey)(key))
        throw new TypeError(`replicated map key is not wire-safe: ${key}`);
    return key;
}
function requireReplicatedMapLineId(value) {
    if (typeof value != 'string' || value.length == 0) {
        throw new TypeError('replicated map lineId must be a non-empty string');
    }
    return value;
}
function createReplicatedMapLineId() {
    const random = Math.random().toString(36).slice(2);
    return `map-${Date.now().toString(36)}-${random}`;
}
function emptyReplicatedMapState() {
    return Object.create(null);
}
function requireReplicatedMapOwnKey(value, key) {
    if (typeof key != 'string')
        throw new TypeError('replicated map root accepts only string keys');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError('replicated map root accepts only enumerable data keys');
    }
    return requireReplicatedMapKey(key);
}
function requireReplicatedMapRoot(value) {
    if (value == null || typeof value != 'object' || Array.isArray(value)) {
        throw new TypeError('replicated map root must be a keyed object');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype != null && prototype != Object.prototype) {
        throw new TypeError('replicated map root must be a plain keyed object');
    }
    return value;
}
function replicatedMapKeys(value) {
    const root = requireReplicatedMapRoot(value);
    const keys = [];
    for (const key of Reflect.ownKeys(root))
        keys.push(requireReplicatedMapOwnKey(root, key));
    return keys;
}
function collectValues(values, keyOf) {
    const entries = [];
    for (const value of values) {
        entries.push({
            key: requireReplicatedMapKey(keyOf(value)),
            value: (0, store_projection_1.cloneStoreProjectionValue)(value),
        });
    }
    return entries;
}
function lastRawValuesByKey(values, keyOf) {
    const latest = new Map();
    for (const value of values) {
        const key = requireReplicatedMapKey(keyOf(value));
        latest.delete(key);
        latest.set(key, value);
    }
    return [...latest].map(function mapLatestRawValue([key, value]) { return { key, value }; });
}
function lastValuesByKey(entries) {
    const latest = new Map();
    for (const entry of entries) {
        latest.delete(entry.key);
        latest.set(entry.key, entry.value);
    }
    return [...latest].map(function mapLatestValue([key, value]) { return { key, value }; });
}
function copyInitialState(initial) {
    const state = emptyReplicatedMapState();
    if (!initial)
        return state;
    for (const safeKey of replicatedMapKeys(initial)) {
        state[safeKey] = (0, store_projection_1.cloneStoreProjectionValue)(initial[safeKey]);
    }
    return state;
}
function copyReplicatedMapRoot(source) {
    const target = Object.create(Object.getPrototypeOf(source));
    for (const key of replicatedMapKeys(source)) {
        Reflect.defineProperty(target, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: source[key],
        });
    }
    return target;
}
function applyPublishedMapPatches(state, patches) {
    let next = state;
    for (const patch of patches) {
        if (patch.path.length == 0) {
            next = copyReplicatedMapRoot(requireReplicatedMapRoot(patch.value));
            continue;
        }
        const key = requireReplicatedMapKey(patch.path[0]);
        if (!patch.exists) {
            delete next[key];
            continue;
        }
        Reflect.defineProperty(next, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: patch.value,
        });
    }
    return next;
}
function replicatedMapDescriptor(descriptor) {
    const map = descriptor?.['replicatedMap'];
    if (map?.version == 1 && (map.delivery == 'latest' || map.delivery == 'lossless')
        && typeof map.lineId == 'string' && map.lineId.length > 0) {
        return map;
    }
    return undefined;
}
function copyStatus(status) {
    return { ...status };
}
function operationsChange(delivery, operations) {
    const set = [];
    const deleted = [];
    for (const operation of operations) {
        if (operation.type == 'set')
            set.push([operation.key, operation.value]);
        else
            deleted.push(operation.key);
    }
    return { delivery, set, delete: deleted, operations };
}
function createReplicatedMap(deps) {
    const uncheckedDeps = deps;
    if (uncheckedDeps.store && uncheckedDeps.delivery == 'lossless') {
        throw new Error('lossless replicated map must own its Store');
    }
    const initialEntries = collectValues(deps.store ? [] : (deps.initial ?? []), deps.keyOf);
    const initialState = emptyReplicatedMapState();
    for (const entry of initialEntries)
        initialState[entry.key] = entry.value;
    const store = deps.store ?? (0, store_1.createStore)(initialState);
    const [emitPatches, patchSource] = (0, Listen_1.listen)();
    const ownsPatchSource = deps.store == undefined;
    const replayOpts = deps.replay ?? {};
    const lineId = requireReplicatedMapLineId(deps.lineId ?? createReplicatedMapLineId());
    const descriptor = {
        ...replayOpts.describe,
        replicatedMap: { version: 1, delivery: deps.delivery, lineId },
    };
    validateState(rawState());
    let lastPublishedState = ownsPatchSource ? undefined : store.snapshot();
    const exposed = (0, store_replay_1.exposeStoreReplay)(store, {
        ...replayOpts,
        describe: descriptor,
        patchSource,
    });
    let closed = false;
    function ensureOpen() {
        if (closed)
            throw new Error('replicated map is closed');
    }
    function rawState() {
        return (0, reactive_1.toRaw)(store.state);
    }
    function validateValueKey(key, value) {
        if (requireReplicatedMapKey(deps.keyOf(value)) != key) {
            throw new Error(`replicated map store key does not match keyOf(value): ${key}`);
        }
    }
    function validateState(state) {
        for (const safeKey of replicatedMapKeys(state)) {
            validateValueKey(safeKey, state[safeKey]);
        }
    }
    function normalizeInjectedPatches(patches) {
        const state = rawState();
        if (patches.some(function hasRootStorePatch(patch) { return patch.path.length == 0; })) {
            validateState(state);
            const snapshot = store.snapshot();
            return [{ path: [], exists: true, value: snapshot }];
        }
        const touched = new Map();
        for (const patch of patches) {
            const key = requireReplicatedMapKey(patch.path[0]);
            touched.delete(key);
            touched.set(key, true);
        }
        const normalized = [];
        for (const key of touched.keys()) {
            if (!owns(state, key)) {
                normalized.push({ path: [key], exists: false, value: undefined });
                continue;
            }
            requireReplicatedMapOwnKey(state, key);
            const value = state[key];
            validateValueKey(key, value);
            normalized.push({ path: [key], exists: true, value: (0, store_projection_1.cloneStoreProjectionValue)(value) });
        }
        return normalized;
    }
    const offInjectedStore = ownsPatchSource
        ? function noInjectedStoreListener() { }
        : (0, store_1.listenStorePatches)(store).on(function forwardInjectedStorePatches(patches) {
            const normalized = normalizeInjectedPatches(patches);
            emitPatches(normalized);
            if (!lastPublishedState)
                throw new Error('injected replicated map baseline is missing');
            lastPublishedState = applyPublishedMapPatches(lastPublishedState, normalized);
        });
    function publish(patches) {
        if (patches.length == 0) {
            exposed.flushPending();
            return;
        }
        if (ownsPatchSource)
            emitPatches(patches);
    }
    function applyOwnedEntries(entries) {
        const patches = [];
        for (const entry of entries) {
            store.state[entry.key] = entry.value;
            patches.push({ path: [entry.key], exists: true, value: (0, store_projection_1.cloneStoreProjectionValue)(entry.value) });
        }
        publish(patches);
    }
    function collectLatestChanges(values) {
        const winners = lastRawValuesByKey(values, deps.keyOf);
        const state = rawState();
        const changes = [];
        for (const entry of winners) {
            if (owns(state, entry.key) && (0, deep_equal_1.compareDeepValues)(state[entry.key], entry.value))
                continue;
            changes.push({ key: entry.key, value: (0, store_projection_1.cloneStoreProjectionValue)(entry.value) });
        }
        return changes;
    }
    function applyValues(values) {
        const entries = deps.delivery == 'latest'
            ? collectLatestChanges(values)
            : collectValues(values, deps.keyOf);
        applyOwnedEntries(entries);
    }
    function set(value) {
        ensureOpen();
        applyValues([value]);
    }
    function setMany(values) {
        ensureOpen();
        applyValues(values);
    }
    function deleteKey(key) {
        deleteMany([key]);
    }
    function deleteMany(keys) {
        ensureOpen();
        const safeKeys = [...keys].map(function validateDeleteKey(key) {
            return requireReplicatedMapKey(key);
        });
        const state = rawState();
        const patches = [];
        for (const key of safeKeys) {
            if (!owns(state, key))
                continue;
            delete store.state[key];
            patches.push({ path: [key], exists: false, value: undefined });
        }
        publish(patches);
    }
    function replaceAll(values) {
        ensureOpen();
        if (deps.delivery == 'latest') {
            const entries = lastRawValuesByKey(values, deps.keyOf);
            const nextKeys = new Set();
            const current = rawState();
            const changes = [];
            for (const entry of entries) {
                nextKeys.add(entry.key);
                if (owns(current, entry.key) && (0, deep_equal_1.compareDeepValues)(current[entry.key], entry.value))
                    continue;
                changes.push({ key: entry.key, value: (0, store_projection_1.cloneStoreProjectionValue)(entry.value) });
            }
            const deleted = [];
            for (const safeKey of replicatedMapKeys(current)) {
                if (!nextKeys.has(safeKey))
                    deleted.push(safeKey);
            }
            const patches = deleted.map(function deleteReplicatedMapEntry(key) {
                return { path: [key], exists: false, value: undefined };
            });
            for (const entry of changes) {
                patches.push({
                    path: [entry.key],
                    exists: true,
                    value: (0, store_projection_1.cloneStoreProjectionValue)(entry.value),
                });
            }
            for (const key of deleted)
                delete store.state[key];
            for (const entry of changes)
                store.state[entry.key] = entry.value;
            publish(patches);
            return;
        }
        const entries = collectValues(values, deps.keyOf);
        const finalEntries = lastValuesByKey(entries);
        const next = emptyReplicatedMapState();
        for (const entry of finalEntries)
            next[entry.key] = entry.value;
        const current = rawState();
        const patches = [];
        for (const safeKey of replicatedMapKeys(current)) {
            if (!owns(next, safeKey))
                patches.push({ path: [safeKey], exists: false, value: undefined });
        }
        for (const entry of entries) {
            patches.push({ path: [entry.key], exists: true, value: (0, store_projection_1.cloneStoreProjectionValue)(entry.value) });
        }
        store.replace(next);
        publish(patches);
    }
    function has(key) {
        return owns(rawState(), requireReplicatedMapKey(key));
    }
    function get(key) {
        const safeKey = requireReplicatedMapKey(key);
        const state = rawState();
        return owns(state, safeKey) ? (0, store_projection_1.cloneStoreProjectionValue)(state[safeKey]) : undefined;
    }
    function snapshot() {
        validateState(rawState());
        return store.snapshot();
    }
    function close() {
        if (closed)
            return;
        if (!ownsPatchSource) {
            validateState(rawState());
            const current = store.snapshot();
            if (!lastPublishedState)
                throw new Error('injected replicated map baseline is missing');
            if (!(0, deep_equal_1.compareDeepValues)(lastPublishedState, current)) {
                emitPatches([{ path: [], exists: true, value: current }]);
                lastPublishedState = current;
            }
        }
        exposed.flushPending();
        closed = true;
        offInjectedStore();
        exposed.close();
        patchSource.close();
    }
    function flush() {
        ensureOpen();
        exposed.flushPending();
    }
    return {
        api: exposed.api.replay,
        control: {
            set,
            setMany,
            delete: deleteKey,
            deleteMany,
            replaceAll,
            has,
            get,
            snapshot,
            flush,
            close,
        },
    };
}
function followReplicatedMap(remote, opts = {}) {
    const { initial, drain, onBatch, onStatus, delivery: requestedDelivery, checkpoint, onSeq, onError, onLive, onStale, validateBatch, ...wireOpts } = opts;
    const requestedCursor = checkpoint?.cursor;
    const store = (0, store_1.createStore)(copyInitialState(checkpoint?.snapshot ?? initial), drain !== undefined ? { drain } : {});
    let delivery = requestedDelivery ?? requestedCursor?.delivery ?? 'latest';
    let lineId = requestedCursor?.lineId ?? '';
    let sync;
    let closed = false;
    let failed = false;
    let liveOnce = false;
    let resolveClosed = function resolveClosedLater() { };
    const closedFirst = new Promise(function waitForReplicatedMapClose(resolve) {
        resolveClosed = function settleReplicatedMapClose() { resolve('closed'); };
    });
    let status = {
        state: 'connecting', ready: false, stale: false, delivery,
        replayMode: 'v2', seq: requestedCursor?.seq ?? -1, error: null,
    };
    function reportConsumerError(error) {
        setTimeout(function rethrowReplicatedMapConsumerError() { throw error; }, 0);
    }
    const dispatchOptions = { [Listen_1.LISTEN_DISPATCH_ERROR]: reportConsumerError };
    const [emitBatch, batches] = (0, Listen_1.listen)(dispatchOptions);
    const [emitKey, keys] = (0, Listen_1.listen)(dispatchOptions);
    const [emitStatus, statusChanges] = (0, Listen_1.listenStore)({
        ...dispatchOptions,
        current: function currentReplicatedMapStatus() { return [copyStatus(status)]; },
    });
    function setStatus(patch) {
        const next = { ...status, ...patch };
        if (next.state == status.state && next.ready == status.ready && next.stale == status.stale
            && next.delivery == status.delivery && next.replayMode == status.replayMode
            && next.seq == status.seq && next.error == status.error)
            return;
        status = next;
        emitStatus(copyStatus(status));
    }
    if (onBatch)
        batches.on(onBatch);
    if (onStatus) {
        try {
            onStatus(copyStatus(status));
        }
        catch (error) {
            reportConsumerError(error);
        }
        statusChanges.on(onStatus);
    }
    const knownKeys = new Set(replicatedMapKeys((0, reactive_1.toRaw)(store.state)));
    const pendingChanges = [];
    function validateReplicatedMapPatches(patches) {
        for (const patch of patches) {
            if (patch.path.length == 0) {
                if (!patch.exists)
                    continue;
                replicatedMapKeys(patch.value);
                continue;
            }
            if (patch.path.length != 1) {
                throw new TypeError('replicated map accepts only root or top-level patches');
            }
            requireReplicatedMapKey(patch.path[0]);
        }
        validateBatch?.(patches, store);
    }
    function replaceKnownKeys(keys = replicatedMapKeys((0, reactive_1.toRaw)(store.state))) {
        knownKeys.clear();
        for (const key of keys)
            knownKeys.add(key);
    }
    function touchKey(touched, key) {
        touched.delete(key);
        touched.set(key, true);
    }
    function latestChange(patches) {
        const touched = new Map();
        const state = (0, reactive_1.toRaw)(store.state);
        let rootKeys;
        for (const patch of patches) {
            if (patch.path.length == 0) {
                rootKeys ??= replicatedMapKeys(state);
                for (const key of knownKeys)
                    touchKey(touched, key);
                for (const key of rootKeys)
                    touchKey(touched, key);
                continue;
            }
            touchKey(touched, requireReplicatedMapKey(patch.path[0]));
        }
        const operations = [];
        for (const key of touched.keys()) {
            if (owns(state, key)) {
                operations.push({ type: 'set', key, value: (0, store_projection_1.cloneStoreProjectionValue)(state[key]) });
            }
            else
                operations.push({ type: 'delete', key });
        }
        if (rootKeys)
            replaceKnownKeys(rootKeys);
        else
            for (const key of touched.keys()) {
                if (owns(state, key))
                    knownKeys.add(key);
                else
                    knownKeys.delete(key);
            }
        return operationsChange('latest', operations);
    }
    function losslessChange(patches) {
        const operations = [];
        for (const patch of patches) {
            if (patch.path.length == 0) {
                const root = patch.exists && patch.value != null && typeof patch.value == 'object'
                    ? patch.value
                    : {};
                const nextKeys = new Set();
                for (const key of replicatedMapKeys(root))
                    nextKeys.add(key);
                for (const key of knownKeys)
                    if (!nextKeys.has(key))
                        operations.push({ type: 'delete', key });
                for (const key of nextKeys) {
                    operations.push({ type: 'set', key, value: (0, store_projection_1.cloneStoreProjectionValue)(root[key]) });
                }
                knownKeys.clear();
                for (const key of nextKeys)
                    knownKeys.add(key);
                continue;
            }
            if (patch.path.length != 1) {
                throw new Error('lossless replicated map accepts only root or top-level patches');
            }
            const key = requireReplicatedMapKey(patch.path[0]);
            if (patch.exists) {
                operations.push({ type: 'set', key, value: (0, store_projection_1.cloneStoreProjectionValue)(patch.value) });
                knownKeys.add(key);
            }
            else {
                operations.push({ type: 'delete', key });
                knownKeys.delete(key);
            }
        }
        return operationsChange('lossless', operations);
    }
    function trackKnownKeys(patches) {
        const state = (0, reactive_1.toRaw)(store.state);
        for (const patch of patches) {
            if (patch.path.length == 0) {
                replaceKnownKeys();
                return;
            }
            const key = requireReplicatedMapKey(patch.path[0]);
            if (owns(state, key))
                knownKeys.add(key);
            else
                knownKeys.delete(key);
        }
    }
    function receivePatches(patches) {
        if (batches.count() == 0) {
            trackKnownKeys(patches);
            pendingChanges.push(undefined);
            return;
        }
        pendingChanges.push(delivery == 'lossless' ? losslessChange(patches) : latestChange(patches));
    }
    const offEach = store.each().on(function forwardReplicatedMapKey(key, _value) {
        if (keys.count() == 0)
            return;
        const safeKey = requireReplicatedMapKey(key);
        const state = (0, reactive_1.toRaw)(store.state);
        const exists = owns(state, safeKey);
        emitKey(safeKey, exists ? (0, store_projection_1.cloneStoreProjectionValue)(state[safeKey]) : undefined, { key: safeKey, exists });
    });
    function reportSyncError(error) {
        if (closed)
            return;
        failed = true;
        setStatus({ state: 'error', error });
        if (!onError)
            return;
        try {
            onError(error);
        }
        catch (caught) {
            reportConsumerError(caught);
        }
    }
    function trackSeq(seq) {
        setStatus({ seq, replayMode: sync?.mode ?? status.replayMode });
        const change = pendingChanges.shift();
        if (change)
            emitBatch(change);
        if (!onSeq)
            return;
        try {
            onSeq(seq);
        }
        catch (error) {
            reportConsumerError(error);
        }
    }
    function reportLive() {
        liveOnce = true;
        setStatus({ state: sync?.isStale() ? 'stale' : 'live', ready: true, stale: sync?.isStale() ?? false, error: null });
        if (!onLive)
            return;
        try {
            onLive();
        }
        catch (error) {
            reportConsumerError(error);
        }
    }
    function reportStale(info) {
        setStatus({ state: info.stale ? 'stale' : 'live', stale: info.stale });
        if (!onStale)
            return;
        try {
            onStale(info);
        }
        catch (error) {
            reportConsumerError(error);
        }
    }
    const lifecycle = (0, transport_lifecycle_1.getRpcTransportLifecycle)(remote);
    const offDisconnect = lifecycle?.onDisconnect(function replicatedMapDisconnected() {
        if (!closed && !failed)
            setStatus({ state: 'reconnecting' });
    }) ?? function noDisconnectListener() { };
    const offConnect = lifecycle?.onConnect(function replicatedMapConnected() {
        if (!closed && !failed)
            setStatus({ state: liveOnce ? 'reconnecting' : 'connecting' });
    }) ?? function noConnectListener() { };
    const offTransportClose = lifecycle?.onClose(function replicatedMapTransportClosed() {
        close();
    }) ?? function noTransportCloseListener() { };
    function waitForTransportConnect() {
        if (!lifecycle || lifecycle.closed())
            return Promise.resolve(false);
        if (lifecycle.connected())
            return Promise.resolve(true);
        return new Promise(function waitForReplicatedMapTransport(resolve) {
            let settled = false;
            let offReady = function offReadyLater() { };
            let offClosed = function offClosedLater() { };
            function finish(connected) {
                if (settled)
                    return;
                settled = true;
                offReady();
                offClosed();
                resolve(connected);
            }
            offReady = lifecycle.onConnect(function replicatedMapTransportReady() { finish(true); });
            offClosed = lifecycle.onClose(function replicatedMapTransportGone() { finish(false); });
            if (lifecycle.closed())
                finish(false);
            else if (lifecycle.connected())
                finish(true);
        });
    }
    async function readInitialDescriptor() {
        while (!closed) {
            if (lifecycle?.closed())
                throw new Error('replicated map transport is already closed');
            const generation = lifecycle?.generation();
            try {
                const descriptor = await (0, replay_wire_1.readReplayDescriptor)(remote);
                if (!lifecycle)
                    return descriptor;
                if (lifecycle.closed())
                    throw new Error('replicated map transport closed during descriptor read');
                if (lifecycle.generation() == generation && lifecycle.connected())
                    return descriptor;
                if (!await waitForTransportConnect()) {
                    throw new Error('replicated map transport closed during descriptor retry');
                }
            }
            catch (error) {
                if (!lifecycle)
                    throw error;
                if (lifecycle.closed())
                    throw error;
                if (lifecycle.generation() != generation)
                    continue;
                if (lifecycle.connected())
                    throw error;
                if (!await waitForTransportConnect())
                    throw error;
            }
        }
        return null;
    }
    async function prepareReplicatedMapCatchUp(context) {
        const phase = context.initial ? 'before initial catch-up' : 'on reconnect';
        const nextWireDescriptor = await (0, replay_wire_1.readReplayDescriptor)(remote);
        const next = replicatedMapDescriptor(nextWireDescriptor);
        if (next && next.delivery != delivery) {
            throw new Error(`replicated map delivery changed ${phase}: ${delivery} -> ${next.delivery}`);
        }
        if (!next && delivery == 'lossless') {
            throw new Error(`lossless replicated map lost its producer descriptor ${phase}`);
        }
        const nextMode = (0, store_replay_1.storeReplayMode)();
        if (nextMode != replayMode()) {
            throw new Error(`replicated map replay mode changed ${phase}: ${replayMode()} -> ${nextMode}`);
        }
        if (next?.lineId == lineId)
            return;
        if (delivery == 'lossless') {
            throw new Error(`lossless replicated map replay line changed ${phase}: ${lineId} -> ${next?.lineId ?? 'unknown'}`);
        }
        lineId = next?.lineId ?? '';
        setStatus({ seq: -1 });
        return { reset: true };
    }
    async function start() {
        const descriptorReady = readInitialDescriptor().then(function replicatedMapDescriptorReady(value) { return { state: 'ready', value }; }, function replicatedMapDescriptorFailed(error) { return { state: 'error', error }; });
        const negotiated = await Promise.race([
            descriptorReady,
            closedFirst.then(function replicatedMapClosedBeforeDescriptor() { return { state: 'closed' }; }),
        ]);
        if (negotiated.state == 'closed' || closed)
            return;
        if (negotiated.state == 'error') {
            reportSyncError(negotiated.error);
            return;
        }
        if (requestedCursor && (!Number.isInteger(requestedCursor.seq) || requestedCursor.seq < -1)) {
            reportSyncError(new TypeError('replicated map cursor seq must be an integer greater than or equal to -1'));
            return;
        }
        if (requestedCursor) {
            try {
                requireReplicatedMapLineId(requestedCursor.lineId);
            }
            catch (error) {
                reportSyncError(error);
                return;
            }
        }
        if (requestedDelivery && requestedCursor && requestedDelivery != requestedCursor.delivery) {
            reportSyncError(new Error(`replicated map delivery mismatch: requested ${requestedDelivery}, cursor ${requestedCursor.delivery}`));
            return;
        }
        const preferredDelivery = requestedDelivery ?? requestedCursor?.delivery;
        const declared = replicatedMapDescriptor(negotiated.value);
        const declaredDelivery = declared?.delivery;
        if (preferredDelivery == 'lossless' && !declared) {
            reportSyncError(new Error('lossless replicated map requires a compatible producer descriptor'));
            return;
        }
        if (preferredDelivery && declaredDelivery && preferredDelivery != declaredDelivery) {
            reportSyncError(new Error(`replicated map delivery mismatch: requested ${preferredDelivery}, remote ${declaredDelivery}`));
            return;
        }
        delivery = preferredDelivery ?? declaredDelivery ?? 'latest';
        lineId = declared?.lineId ?? '';
        const replayMode = (0, store_replay_1.storeReplayMode)();
        if (requestedCursor && requestedCursor.delivery != delivery) {
            reportSyncError(new Error(`replicated map delivery mismatch: cursor ${requestedCursor.delivery}, remote ${delivery}`));
            return;
        }
        if (requestedCursor && requestedCursor.lineId != lineId && delivery == 'lossless') {
            reportSyncError(new Error(`lossless replicated map cannot resume another replay line: ${requestedCursor.lineId} -> ${lineId || 'unknown'}`));
            return;
        }
        if (requestedCursor && requestedCursor.replayMode != replayMode && delivery == 'lossless') {
            reportSyncError(new Error(`lossless replicated map cannot translate a ${requestedCursor.replayMode} cursor to ${replayMode}`));
            return;
        }
        const sameCheckpointSpace = requestedCursor?.lineId == lineId && requestedCursor.replayMode == replayMode;
        const since = sameCheckpointSpace ? requestedCursor.seq : -1;
        setStatus({ delivery, replayMode, seq: since });
        try {
            sync = (0, store_replay_1.syncStoreReplay)(store, remote, {
                ...wireOpts,
                since,
                policy: delivery == 'latest' ? 'frame' : 'queue',
                catchUp: delivery == 'latest' ? 'frame' : 'tail',
                gapPolicy: delivery == 'latest' ? 'keyframe' : 'error',
                prepareCatchUp: prepareReplicatedMapCatchUp,
                validateBatch: validateReplicatedMapPatches,
                onBatch: receivePatches,
                onSeq: trackSeq,
                onError: reportSyncError,
                onLive: reportLive,
                onStale: reportStale,
            });
            await Promise.race([sync.ready, closedFirst]);
        }
        catch (error) {
            if (!closed && !failed)
                reportSyncError(error);
        }
    }
    const ready = start();
    function get(key) {
        const safeKey = requireReplicatedMapKey(key);
        const state = (0, reactive_1.toRaw)(store.state);
        return owns(state, safeKey) ? (0, store_projection_1.cloneStoreProjectionValue)(state[safeKey]) : undefined;
    }
    function has(key) {
        return owns((0, reactive_1.toRaw)(store.state), requireReplicatedMapKey(key));
    }
    function snapshot() {
        return store.snapshot();
    }
    function onKey(key, cb, keyOpts = {}) {
        if (closed)
            throw new Error('replicated map follower is closed');
        const safeKey = requireReplicatedMapKey(key);
        const off = keys.on(function forwardSelectedReplicatedMapKey(changedKey, value, ctx) {
            if (changedKey == safeKey)
                cb(value, ctx);
        });
        if (keyOpts.current) {
            try {
                cb(get(safeKey), { key: safeKey, exists: has(safeKey) });
            }
            catch (error) {
                reportConsumerError(error);
            }
        }
        return off;
    }
    function currentStatus() {
        return copyStatus(status);
    }
    function seq() {
        return sync?.seq() ?? status.seq;
    }
    function replayMode() {
        return sync?.mode ?? status.replayMode;
    }
    function checkpointSnapshot() {
        if (!lineId)
            throw new Error('replicated map remote has no safe checkpoint identity');
        return {
            cursor: { lineId, delivery, replayMode: replayMode(), seq: seq() },
            snapshot: snapshot(),
        };
    }
    function isStale() {
        return sync?.isStale() ?? status.stale;
    }
    function close() {
        if (closed)
            return;
        closed = true;
        resolveClosed();
        offConnect();
        offDisconnect();
        offTransportClose();
        sync?.();
        pendingChanges.length = 0;
        offEach();
        setStatus({ state: 'closed' });
        batches.close();
        keys.close();
        statusChanges.close();
    }
    return {
        get,
        has,
        snapshot,
        onKey,
        batches,
        keys,
        ready,
        status: currentStatus,
        statusChanges,
        seq,
        replayMode,
        delivery: () => delivery,
        checkpoint: checkpointSnapshot,
        isStale,
        close,
        debug: { store },
    };
}
