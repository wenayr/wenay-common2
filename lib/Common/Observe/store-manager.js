"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.managedStore = void 0;
exports.createStoreManager = createStoreManager;
const Listen_1 = require("../events/Listen");
const store_1 = require("./store");
const store_offline_1 = require("./store-offline");
const store_replay_1 = require("./store-replay");
function kindOf(resource) {
    return resource.kind ?? 'mirror';
}
function hasAnyTag(resourceTags, tags) {
    if (!tags?.length)
        return true;
    if (!resourceTags?.length)
        return false;
    return tags.some(tag => resourceTags.includes(tag));
}
function resourceScore(key, resource, usage, now) {
    const base = typeof resource.priority == 'function'
        ? resource.priority({ key, usage, now })
        : resource.priority ?? 0;
    const usageScore = usage ? usage.weight + Math.min(usage.count, 50) : 0;
    const recency = usage?.lastUsedAt ? Math.max(0, 1_000_000 - (now - usage.lastUsedAt)) / 1_000_000 : 0;
    return base + usageScore + recency;
}
exports.managedStore = {
    mirror(resource) {
        return { ...resource, kind: 'mirror' };
    },
    replay(resource) {
        return { ...resource, kind: 'replay' };
    },
    offline(resource) {
        return { ...resource, kind: 'offline' };
    },
};
function createStoreManager(resources) {
    const usages = new Map();
    const [emitStatus, statusListen] = (0, Listen_1.listen)();
    function usageFor(key, resource) {
        const usageKey = resource.usageKey ?? key;
        let usage = usages.get(usageKey);
        if (!usage) {
            usage = { count: 0, weight: 0 };
            usages.set(usageKey, usage);
        }
        return usage;
    }
    function createHandle(key, resource) {
        const kind = kindOf(resource);
        let state = 'idle';
        let store;
        let stopSync;
        let pending;
        let error;
        let startedAt;
        let stoppedAt;
        function setState(next, nextError) {
            state = next;
            error = nextError;
            if (next == 'ready')
                startedAt = Date.now();
            if (next == 'stopped')
                stoppedAt = Date.now();
            emitStatus(status());
        }
        function status() {
            return { key, state, kind, error, startedAt, stoppedAt };
        }
        async function start(opts = {}) {
            if (resource.explicitOnly && !opts.explicit) {
                throw new Error(`store manager: ${key} is explicitOnly`);
            }
            if (state == 'ready' && store)
                return store;
            if (pending)
                return pending;
            pending = (async () => {
                setState('starting');
                try {
                    if (kind == 'mirror') {
                        const r = resource;
                        store ??= (0, store_1.createStoreMirror)(r.remote, r.initial, r.storeOpts);
                        const mode = r.sync?.mode ?? 'pull';
                        const opts = r.sync?.opts;
                        stopSync = mode == 'patches'
                            ? await store.syncPatches(r.mask, opts)
                            : mode == 'changedData'
                                ? await store.syncChangedData(r.mask, opts)
                                : await store.sync(r.mask, opts);
                    }
                    else if (kind == 'replay') {
                        const r = resource;
                        store ??= (0, store_1.createStore)(r.initial, r.storeOpts);
                        const sub = (0, store_replay_1.syncStoreReplay)(store, r.remote, r.syncOpts);
                        stopSync = sub;
                        await sub.ready;
                    }
                    else {
                        const r = resource;
                        store = await (0, store_offline_1.createOfflineStore)({
                            key: r.storageKey ?? key,
                            remote: r.remote,
                            initial: r.initial,
                            storage: r.storage,
                            version: r.version,
                            debounceMs: r.debounceMs,
                            storeOpts: r.storeOpts,
                            syncOpts: r.syncOpts,
                            migrate: r.migrate,
                        });
                        await store.ready;
                    }
                    setState('ready');
                    return store;
                }
                catch (e) {
                    setState('error', e);
                    throw e;
                }
                finally {
                    pending = undefined;
                }
            })();
            return pending;
        }
        function stop() {
            stopSync?.();
            stopSync = undefined;
            if (kind == 'offline') {
                store?.close?.();
                store = undefined;
            }
            if (state != 'idle')
                setState('stopped');
        }
        function touch(weight = 1) {
            const usage = usageFor(key, resource);
            usage.count++;
            usage.weight += weight;
            usage.lastUsedAt = Date.now();
        }
        return { key, kind, start, stop, get: () => store, status, touch };
    }
    const handles = {};
    for (const key of Object.keys(resources))
        handles[key] = createHandle(key, resources[key]);
    function plan(opts = {}) {
        const now = opts.now ?? Date.now();
        const keySet = opts.keys ? new Set([...opts.keys].map(String)) : null;
        const out = [];
        for (const key of Object.keys(resources)) {
            if (keySet && !keySet.has(key))
                continue;
            const resource = resources[key];
            if (!hasAnyTag(resource.tags, opts.tags))
                continue;
            if (resource.explicitOnly && !opts.includeExplicit)
                continue;
            if (resource.large && !opts.includeLarge)
                continue;
            const usage = usages.get(resource.usageKey ?? key);
            out.push({
                key,
                kind: kindOf(resource),
                score: resourceScore(key, resource, usage, now),
                state: handles[key].status().state,
                large: !!resource.large,
                explicitOnly: !!resource.explicitOnly,
                tags: resource.tags ?? [],
            });
        }
        out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
        return opts.limit == null ? out : out.slice(0, opts.limit);
    }
    async function start(key, opts) {
        const handle = handles[key];
        if (!handle)
            throw new Error(`store manager: unknown resource ${key}`);
        return handle.start(opts);
    }
    async function startMany(keys, opts) {
        const out = {};
        for (const key of keys)
            out[key] = await start(key, opts);
        return out;
    }
    async function startPlanned(opts = {}) {
        const out = {};
        for (const item of plan(opts))
            out[item.key] = await handles[item.key].start(opts);
        return out;
    }
    function stop(key) {
        const handle = handles[key];
        if (!handle)
            throw new Error(`store manager: unknown resource ${key}`);
        handle.stop();
    }
    function stopAll() {
        for (const handle of Object.values(handles))
            handle.stop();
    }
    function get(key) {
        return handles[key]?.get();
    }
    function touch(key, weight) {
        const handle = handles[key];
        if (!handle)
            throw new Error(`store manager: unknown resource ${key}`);
        handle.touch(weight);
    }
    return {
        handles: handles,
        statusListen,
        plan,
        start,
        startMany,
        startPlanned,
        stop,
        stopAll,
        get,
        touch,
        usage: () => new Map(usages),
    };
}
