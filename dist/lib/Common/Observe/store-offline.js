"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMemoryOfflineStorage = createMemoryOfflineStorage;
exports.persistStore = persistStore;
exports.createOfflineStore = createOfflineStore;
const common_1 = require("../core/common");
const Listen_1 = require("../events/Listen");
const store_1 = require("./store");
const store_replay_1 = require("./store-replay");
function isRecord(v) {
    return !!v && typeof v == 'object' && typeof v.version == 'number'
        && typeof v.seq == 'number' && 'snapshot' in v;
}
function cloneValue(value) {
    return (0, common_1.clone)(value);
}
function createMemoryOfflineStorage(initial) {
    const data = new Map();
    for (const [k, v] of Object.entries(initial ?? {}))
        data.set(k, cloneValue(v));
    const api = {
        async read(key) {
            return data.has(key) ? cloneValue(data.get(key)) : undefined;
        },
        async write(key, value) {
            data.set(key, cloneValue(value));
        },
        async remove(key) {
            data.delete(key);
        },
        async transaction(fn) {
            return fn(api);
        },
        dump() {
            const out = {};
            for (const [k, v] of data)
                out[k] = cloneValue(v);
            return out;
        },
    };
    return api;
}
function emitError(opts, error) {
    if (opts.onError)
        opts.onError(error);
    else
        setTimeout(function rethrowOfflineStoreError() { throw error; }, 0);
}
function copyStatus(status) {
    return { ...status };
}
function persistStore(store, opts) {
    const { key, storage, version = 1, debounceMs = 250, now = Date.now, onStatus } = opts;
    let seq = opts.seq ?? -1;
    let savedAt = opts.savedAt;
    let closed = false;
    let dirty = false;
    let timer = null;
    let chain = Promise.resolve();
    const status = {
        ready: true,
        syncing: false,
        offline: false,
        stale: false,
        saving: false,
        seq,
        savedAt,
    };
    const [emitStatus, statusListen] = (0, Listen_1.listenStore)({
        current: () => [copyStatus(status)],
    });
    function updateStatus(patch = {}) {
        Object.assign(status, patch, { seq, savedAt });
        const snap = copyStatus(status);
        emitStatus(snap);
        onStatus?.(snap);
    }
    function clearTimer() {
        if (timer)
            clearTimeout(timer);
        timer = null;
    }
    function scheduleSave() {
        if (closed)
            return;
        dirty = true;
        clearTimer();
        timer = setTimeout(function flushOfflineStoreTimer() {
            timer = null;
            flush().catch(e => emitError(opts, e));
        }, Math.max(0, debounceMs));
        timer.unref?.();
    }
    async function writeRecord(record) {
        if (storage.transaction) {
            await storage.transaction(async function writeOfflineStoreTx(tx) {
                await tx.write(key, record);
            });
        }
        else {
            await storage.write(key, record);
        }
    }
    async function runFlush(force = false) {
        if (closed)
            return;
        if (!dirty && !force)
            return;
        dirty = false;
        updateStatus({ saving: true, error: undefined });
        const nextSavedAt = now();
        const record = {
            version,
            seq,
            snapshot: store.snapshot(),
            savedAt: nextSavedAt,
        };
        try {
            await writeRecord(record);
            savedAt = nextSavedAt;
            updateStatus({ saving: false, error: undefined });
        }
        catch (e) {
            updateStatus({ saving: false, error: e });
            throw e;
        }
        finally {
            if (dirty && !closed)
                scheduleSave();
        }
    }
    function flush() {
        clearTimer();
        const task = chain.catch(() => { }).then(function flushOfflineStore() { return runFlush(false); });
        chain = task.catch(() => { });
        return task;
    }
    function forceFlush() {
        clearTimer();
        dirty = true;
        const task = chain.catch(() => { }).then(function forceFlushOfflineStore() { return runFlush(true); });
        chain = task.catch(() => { });
        return task;
    }
    function setSeq(nextSeq) {
        if (nextSeq == seq)
            return;
        seq = nextSeq;
        updateStatus();
        scheduleSave();
    }
    const offStore = store.listenPaths().on(function persistStoreChange() {
        scheduleSave();
    });
    function close() {
        if (closed)
            return;
        closed = true;
        clearTimer();
        offStore();
        statusListen.close();
    }
    function setSyncStatus(patch) {
        updateStatus(patch);
    }
    return {
        flush,
        forceFlush,
        close,
        setSeq,
        seq: () => seq,
        status: () => copyStatus(status),
        statusListen,
        setSyncStatus,
    };
}
async function loadSnapshot(opts) {
    const { key, storage, initial, version = 1, migrate } = opts;
    const raw = await storage.read(key);
    if (raw == null)
        return { snapshot: initial, seq: -1 };
    if (isRecord(raw)) {
        if (raw.version == version)
            return { snapshot: raw.snapshot, seq: raw.seq, savedAt: raw.savedAt };
        if (migrate)
            return {
                snapshot: await migrate(raw.snapshot, raw.version, version),
                seq: raw.seq,
                savedAt: raw.savedAt,
            };
        return { snapshot: initial, seq: -1 };
    }
    if (migrate)
        return { snapshot: await migrate(raw, 0, version), seq: -1 };
    return { snapshot: initial, seq: -1 };
}
async function createOfflineStore(opts) {
    const { remote, storeOpts, syncOpts = {}, onStatus } = opts;
    if (opts.mode && opts.mode != 'snapshot')
        throw new Error('createOfflineStore: only snapshot mode is implemented');
    let loaded;
    try {
        loaded = await loadSnapshot(opts);
    }
    catch (e) {
        emitError(opts, e);
        loaded = { snapshot: opts.initial, seq: -1 };
    }
    const store = (0, store_1.createStore)(loaded.snapshot, storeOpts);
    const persist = persistStore(store, {
        key: opts.key,
        storage: opts.storage,
        version: opts.version,
        seq: loaded.seq,
        savedAt: loaded.savedAt,
        debounceMs: opts.debounceMs,
        now: opts.now,
        onError: opts.onError,
        onStatus,
    });
    let sub = null;
    let ready = Promise.resolve();
    async function reconnect(nextRemote, nextSyncOpts = syncOpts) {
        sub?.();
        persist.setSyncStatus({ syncing: true, offline: false, ready: false, error: undefined });
        const { onSeq, onError, onStale, since, ...rest } = nextSyncOpts;
        const effectiveSince = since ?? (persist.seq() >= 0 ? persist.seq() : undefined);
        try {
            sub = (0, store_replay_1.syncStoreReplay)(store, nextRemote, {
                ...rest,
                since: effectiveSince,
                onSeq: function offlineStoreOnSeq(seq) {
                    persist.setSeq(seq);
                    onSeq?.(seq);
                },
                onError: function offlineStoreOnError(error) {
                    persist.setSyncStatus({ offline: true, syncing: false, error });
                    onError?.(error);
                    if (!onError)
                        opts.onError?.(error);
                },
                onStale: onStale && function offlineStoreOnStale(info) {
                    persist.setSyncStatus({ stale: info.stale });
                    onStale(info);
                },
            });
            ready = sub.ready.then(function offlineStoreReady() {
                persist.setSyncStatus({ ready: true, syncing: false });
            });
            await ready;
        }
        catch (e) {
            persist.setSyncStatus({ ready: true, syncing: false, offline: true, error: e });
            emitError(opts, e);
        }
    }
    if (remote) {
        ready = reconnect(remote);
    }
    else {
        persist.setSyncStatus({ ready: true, syncing: false, offline: true });
    }
    function close() {
        sub?.();
        persist.close();
    }
    function flush() {
        return persist.flush();
    }
    return Object.assign(store, {
        get ready() { return ready; },
        close,
        flush,
        status: persist.status,
        statusListen: persist.statusListen,
        reconnect,
    });
}
