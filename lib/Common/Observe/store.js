"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyStoreMask = applyStoreMask;
exports.applyStorePatch = applyStorePatch;
exports.applyStorePatches = applyStorePatches;
exports.createStore = createStore;
exports.exposeStore = exposeStore;
exports.createStoreMirror = createStoreMirror;
const Listen_1 = require("../events/Listen");
const reactive_1 = require("./reactive");
const hasSetImmediate = typeof setImmediate == "function";
function pathText(path) {
    return path.map(String).join(".");
}
const symbolIds = new Map();
let nextSymbolId = 1;
function symbolKey(k) {
    let id = symbolIds.get(k);
    if (id == null) {
        id = nextSymbolId++;
        symbolIds.set(k, id);
    }
    return id;
}
function pathKey(path) {
    return JSON.stringify(path.map(k => typeof k == "symbol" ? ["symbol", symbolKey(k)] : ["key", String(k)]));
}
function schedule(drain, flush) {
    if (drain == null) {
        flush();
        return;
    }
    if (drain == "micro") {
        queueMicrotask(flush);
        return;
    }
    if (drain == "immediate") {
        (hasSetImmediate ? setImmediate : setTimeout)(flush, 0);
        return;
    }
    if (typeof drain == "number") {
        setTimeout(flush, drain);
        return;
    }
    drain(flush);
}
function createDrained(fn, drain) {
    let scheduled = false;
    let latest = null;
    let closed = false;
    return {
        push(...a) {
            if (closed)
                return;
            if (drain == null) {
                fn(...a);
                return;
            }
            latest = a;
            if (scheduled)
                return;
            scheduled = true;
            schedule(drain, () => {
                scheduled = false;
                const x = latest;
                latest = null;
                if (!closed && x)
                    fn(...x);
            });
        },
        close() { closed = true; latest = null; },
    };
}
function isObj(v) {
    return v != null && typeof v == "object";
}
function getAt(root, path) {
    let cur = root;
    for (const k of path) {
        if (!isObj(cur))
            return undefined;
        cur = cur[k];
    }
    return cur;
}
function hasAt(root, path) {
    let cur = root;
    for (const k of path) {
        if (!isObj(cur) || !(k in cur))
            return false;
        cur = cur[k];
    }
    return true;
}
function readRawAt(root, path) {
    let cur = (0, reactive_1.toRaw)(root);
    for (const k of path) {
        if (!isObj(cur) || !(k in cur))
            return { exists: false, value: undefined };
        cur = (0, reactive_1.toRaw)(cur[k]);
    }
    return { exists: true, value: cur };
}
function ensureParent(root, path) {
    let cur = root;
    for (let i = 0; i < path.length - 1; i++) {
        const k = path[i];
        if (!isObj(cur[k]))
            cur[k] = {};
        cur = cur[k];
    }
    return cur;
}
function replaceRoot(root, value) {
    for (const k of Reflect.ownKeys(root))
        if (!isObj(value) || !(k in value))
            delete root[k];
    if (isObj(value))
        for (const k of Reflect.ownKeys(value))
            root[k] = value[k];
}
function setAt(root, path, value) {
    if (path.length == 0) {
        replaceRoot(root, value);
        return;
    }
    const p = ensureParent(root, path);
    p[path[path.length - 1]] = value;
}
function snapshotValue(value, seen = new WeakMap()) {
    value = (0, reactive_1.toRaw)(value);
    if (!isObj(value))
        return value;
    const old = seen.get(value);
    if (old)
        return old;
    if (value instanceof Date)
        return new Date(value.valueOf());
    if (value instanceof RegExp)
        return new RegExp(value.source, value.flags);
    if (value instanceof Map) {
        const out = new Map();
        seen.set(value, out);
        value.forEach((v, k) => out.set(snapshotValue(k, seen), snapshotValue(v, seen)));
        return out;
    }
    if (value instanceof Set) {
        const out = new Set();
        seen.set(value, out);
        value.forEach(v => out.add(snapshotValue(v, seen)));
        return out;
    }
    const out = Array.isArray(value) ? [] : {};
    seen.set(value, out);
    for (const k of Reflect.ownKeys(value))
        out[k] = snapshotValue(value[k], seen);
    return out;
}
function maskPaths(mask, base = []) {
    if (mask === true || mask == null)
        return [base];
    if (!isObj(mask))
        return [base];
    const out = [];
    for (const k of Reflect.ownKeys(mask))
        out.push(...maskPaths(mask[k], [...base, k]));
    return out;
}
function pickSnapshot(root, mask, base = []) {
    root = (0, reactive_1.toRaw)(root);
    if (mask === true || mask == null)
        return snapshotValue(getAt(root, base));
    const out = {};
    for (const k of Reflect.ownKeys(mask))
        out[k] = pickSnapshot(root, mask[k], [...base, k]);
    return out;
}
function deleteAt(root, path) {
    if (path.length == 0) {
        replaceRoot(root, {});
        return;
    }
    const parent = getAt(root, path.slice(0, -1));
    if (isObj(parent))
        delete parent[path[path.length - 1]];
}
function applyMask(root, mask, data, base = []) {
    if (mask === true || mask == null) {
        if (data === undefined && base.length)
            deleteAt(root, base);
        else
            setAt(root, base, snapshotValue(data));
        return;
    }
    for (const k of Reflect.ownKeys(mask))
        applyMask(root, mask[k], data?.[k], [...base, k]);
}
function applyStoreMask(store, mask, data) {
    applyMask(store.state, mask ?? true, data);
}
function applyStorePatch(store, patch) {
    if (patch.exists === false)
        deleteAt(store.state, patch.path);
    else
        setAt(store.state, patch.path, snapshotValue(patch.value));
}
function applyStorePatches(store, patches) {
    for (const patch of patches)
        applyStorePatch(store, patch);
}
function pathToMask(path) {
    let out = true;
    for (let i = path.length - 1; i >= 0; i--)
        out = { [path[i]]: out };
    return out;
}
function hasMaskKey(mask, key) {
    return isObj(mask) && Reflect.ownKeys(mask).some(k => Object.is(k, key));
}
function mergeMasks(a, b) {
    if (a === undefined)
        return b;
    if (b === undefined)
        return a;
    if (a === true || a == null || b === true || b == null)
        return true;
    if (!isObj(a) || !isObj(b))
        return true;
    const out = {};
    for (const k of Reflect.ownKeys(a))
        out[k] = a[k];
    for (const k of Reflect.ownKeys(b)) {
        out[k] = hasMaskKey(a, k) ? mergeMasks(a[k], b[k]) : b[k];
    }
    return out;
}
function startsWithPath(path, prefix) {
    return prefix.length <= path.length && prefix.every((k, i) => Object.is(k, path[i]));
}
function intersectMaskWithPaths(mask, dirtyPaths) {
    const baseMask = mask ?? true;
    if (!Array.isArray(dirtyPaths))
        return baseMask;
    if (dirtyPaths.length == 0)
        return undefined;
    const selected = maskPaths(baseMask);
    let out = undefined;
    for (const dirty of dirtyPaths) {
        if (!Array.isArray(dirty))
            continue;
        if (dirty.length == 0) {
            out = mergeMasks(out, baseMask);
            continue;
        }
        for (const selectedPath of selected) {
            if (startsWithPath(dirty, selectedPath))
                out = mergeMasks(out, pathToMask(dirty));
            else if (startsWithPath(selectedPath, dirty))
                out = mergeMasks(out, pathToMask(selectedPath));
        }
    }
    return out;
}
function maskFromPaths(paths) {
    let out = undefined;
    for (const path of paths)
        out = mergeMasks(out, pathToMask(path));
    return out ?? true;
}
function makePatch(root, path) {
    root = (0, reactive_1.toRaw)(root);
    const exists = hasAt(root, path);
    return {
        path: [...path],
        exists,
        value: exists ? snapshotValue(getAt(root, path)) : undefined,
    };
}
function patchesForMask(patch, mask) {
    const selected = maskPaths(mask ?? true);
    const out = [];
    let emittedWholePatch = false;
    for (const selectedPath of selected) {
        if (startsWithPath(patch.path, selectedPath)) {
            if (!emittedWholePatch) {
                out.push(patch);
                emittedWholePatch = true;
            }
            continue;
        }
        if (!startsWithPath(selectedPath, patch.path))
            continue;
        const rel = selectedPath.slice(patch.path.length);
        const exists = patch.exists && hasAt(patch.value, rel);
        out.push({
            path: [...selectedPath],
            exists,
            value: exists ? snapshotValue(getAt(patch.value, rel)) : undefined,
        });
    }
    return out;
}
function createPatchesListen(store) {
    return (0, Listen_1.createListen)((emit) => {
        const off = store.listenPaths().on((change) => {
            for (const path of change.paths)
                emit(makePatch(store.state, path));
        });
        return off;
    }, {
        event: (type, count, api) => {
            if (type == "add" && count == 1 && !api.isRunning())
                api.run();
            if (type == "remove" && count == 0 && api.isRunning())
                api.close();
        },
    });
}
function createEachListen(store, opts = {}) {
    if (opts.depth != null && opts.depth != 1)
        throw new Error("store.each: only depth 1 is supported (reserved option)");
    return (0, Listen_1.createListen)((emit) => {
        const known = new Set(Reflect.ownKeys((0, reactive_1.toRaw)(store.state)));
        function emitKey(key) {
            const raw = (0, reactive_1.toRaw)(store.state);
            const exists = isObj(raw) && key in raw;
            if (exists)
                known.add(key);
            else
                known.delete(key);
            emit(key, exists ? store.state[key] : undefined, { path: [key] });
        }
        const off = store.listenPaths().on(function eachStoreChange(change) {
            const keys = new Set();
            let root = false;
            for (const path of change.paths) {
                if (path.length == 0)
                    root = true;
                else
                    keys.add(path[0]);
            }
            if (root) {
                for (const key of Reflect.ownKeys((0, reactive_1.toRaw)(store.state)))
                    keys.add(key);
                for (const key of known)
                    keys.add(key);
            }
            for (const key of keys)
                emitKey(key);
        });
        return off;
    }, {
        event: (type, count, api) => {
            if (type == "add" && count == 1 && !api.isRunning())
                api.run();
            if (type == "remove" && count == 0 && api.isRunning())
                api.close();
        },
    });
}
function createChangedDataListen(store) {
    return (0, Listen_1.createListen)((emit) => {
        const off = store.listenPaths().on((change) => {
            const mask = maskFromPaths(change.paths);
            emit({ mask, data: pickSnapshot(store.state, mask) });
        });
        return off;
    }, {
        event: (type, count, api) => {
            if (type == "add" && count == 1 && !api.isRunning())
                api.run();
            if (type == "remove" && count == 0 && api.isRunning())
                api.close();
        },
    });
}
function watchTarget(root, path) {
    let cur = root;
    let lastReactive = root;
    for (const k of path) {
        if (!isObj(cur) || !(k in cur))
            return lastReactive;
        const next = cur[k];
        if ((0, reactive_1.isReactive)(next)) {
            cur = next;
            lastReactive = next;
        }
        else
            return lastReactive;
    }
    return lastReactive;
}
function sameLeaf(a, b, ae, be) {
    if (ae !== be)
        return false;
    if (!ae && !be)
        return true;
    return Object.is(a, b);
}
function makeCtx(store, path) {
    return {
        store,
        node: getNode(store, path),
        path: [...path],
        pathString: pathText(path),
        exists: hasAt(store._state, path),
    };
}
function getNodeEntry(store, path) {
    const k = pathKey(path);
    const cached = store._nodeCache.get(k);
    if (cached)
        return cached;
    const parent = path.length ? getNodeEntry(store, path.slice(0, -1)) : undefined;
    const entry = {
        key: k,
        path: [...path],
        parent,
        parentKey: path[path.length - 1],
        children: new Map(),
    };
    store._nodeCache.set(k, entry);
    if (parent)
        parent.children.set(entry.parentKey, entry);
    else
        store._nodeRoot = entry;
    refreshNodePruner(store);
    return entry;
}
function cachedNodeEntry(store, path) {
    let entry = store._nodeRoot;
    if (!entry)
        return undefined;
    for (const key of path) {
        entry = entry.children.get(key);
        if (!entry)
            return undefined;
    }
    return entry;
}
function removeNodeEntry(store, entry) {
    if (entry.path.length == 0)
        return;
    for (const child of [...entry.children.values()])
        removeNodeEntry(store, child);
    entry.parent?.children.delete(entry.parentKey);
    store._nodeCache.delete(entry.key);
}
function pruneNodeEntry(store, entry, exists, value) {
    for (const [key, child] of [...entry.children]) {
        const childExists = exists && isObj(value) && key in value;
        const childValue = childExists ? (0, reactive_1.toRaw)(value[key]) : undefined;
        if (!pruneNodeEntry(store, child, childExists, childValue))
            removeNodeEntry(store, child);
    }
    return entry.path.length == 0 || exists || (store._counts.get(entry.key) ?? 0) > 0 || entry.children.size > 0;
}
function pruneCachedPath(store, path) {
    const entry = cachedNodeEntry(store, path);
    if (!entry)
        return;
    const current = readRawAt(store._state, path);
    if (!pruneNodeEntry(store, entry, current.exists, current.value))
        removeNodeEntry(store, entry);
    let parent = entry.parent;
    while (parent && parent.path.length) {
        const currentParent = readRawAt(store._state, parent.path);
        if (pruneNodeEntry(store, parent, currentParent.exists, currentParent.value))
            break;
        const next = parent.parent;
        removeNodeEntry(store, parent);
        parent = next;
    }
    refreshNodePruner(store);
}
function refreshNodePruner(store) {
    if (store._nodeCache.size > 1) {
        store._reactiveOpts._onMutation ??= function pruneStoreNodeCache(path) {
            pruneCachedPath(store, path);
        };
    }
    else
        store._reactiveOpts._onMutation = undefined;
}
function incCount(store, path) {
    const k = pathKey(path);
    getNodeEntry(store, path);
    store._counts.set(k, (store._counts.get(k) ?? 0) + 1);
}
function decCount(store, path) {
    const k = pathKey(path);
    const n = (store._counts.get(k) ?? 0) - 1;
    if (n > 0)
        store._counts.set(k, n);
    else
        store._counts.delete(k);
    pruneCachedPath(store, path);
}
function subscribePath(store, path, cb, opts = {}, once = false) {
    let done = false;
    let offUpdate = null;
    let lastExists = hasAt(store._state, path);
    let lastValue = getAt(store._state, path);
    const drained = createDrained((value, ctx) => {
        if (done)
            return;
        cb(value, ctx);
        if (once)
            off();
    }, opts.drain);
    function emitNow() {
        drained.push(getAt(store._state, path), makeCtx(store, path));
    }
    function attach() {
        offUpdate?.();
        const target = watchTarget(store._state, path);
        offUpdate = (0, reactive_1.onUpdate)(target, () => {
            const exists = hasAt(store._state, path);
            const value = getAt(store._state, path);
            const valueIsObject = (0, reactive_1.isReactive)(value);
            const watchedSelf = target === value;
            if (!valueIsObject && !watchedSelf && sameLeaf(lastValue, value, lastExists, exists))
                return;
            lastExists = exists;
            lastValue = value;
            const nextTarget = watchTarget(store._state, path);
            if (nextTarget !== target && !done)
                attach();
            emitNow();
        });
    }
    function off() {
        if (done)
            return;
        done = true;
        drained.close();
        offUpdate?.();
        offUpdate = null;
        decCount(store, path);
    }
    incCount(store, path);
    if (opts.current && lastExists) {
        cb(lastValue, makeCtx(store, path));
        if (once) {
            off();
            return off;
        }
    }
    attach();
    return off;
}
function getNode(store, path) {
    const entry = getNodeEntry(store, path);
    if (entry.proxy)
        return entry.proxy;
    const api = {
        get path() { return [...path]; },
        get pathString() { return pathText(path); },
        get: () => getAt(store._state, path),
        has: () => hasAt(store._state, path),
        snapshot: () => snapshotValue(getAt(store._state, path)),
        set: (value) => setAt(store._state, path, value),
        replace: (value) => setAt(store._state, path, value),
        on: (cb, opts) => subscribePath(store, path, cb, opts, false),
        once: (cb, opts) => subscribePath(store, path, cb, opts, true),
        update: (mask, opts) => createSelection(store, path, mask, opts),
        at: (key) => getNode(store, [...path, key]),
        count: () => store._counts.get(pathKey(path)) ?? 0,
    };
    const proxy = new Proxy(api, {
        get(target, p) {
            if (p === "then")
                return undefined;
            if (p in target)
                return target[p];
            if (typeof p == "symbol")
                return undefined;
            return getNode(store, [...path, p]);
        },
        ownKeys() {
            const v = getAt(store._state, path);
            return isObj(v) ? Reflect.ownKeys(v) : [];
        },
        getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
    });
    entry.proxy = proxy;
    return entry.proxy;
}
let warnedRootOnEach = false;
function createSelection(store, base, mask, defaults = {}) {
    const fullPaths = maskPaths(mask, base);
    const rootNode = getNode(store, base);
    const ctx = () => ({ store, node: rootNode, mask, paths: fullPaths.map(p => [...p]) });
    const get = () => pickSnapshot(store._state, mask, base);
    return {
        mask,
        paths: fullPaths.map(p => [...p]),
        get,
        on(cb, opts = {}) {
            const o = { ...defaults, ...opts, current: false };
            const drained = createDrained(() => cb(get(), ctx()), opts.drain ?? defaults.drain ?? "micro");
            const offs = fullPaths.map(p => subscribePath(store, p, () => drained.push(), o, false));
            if ((opts.current ?? defaults.current))
                cb(get(), ctx());
            return () => { drained.close(); for (const off of offs)
                off(); };
        },
        once(cb, opts = {}) {
            let done = false;
            let off = () => { };
            off = this.on(function fireOnce(v, c) { if (done)
                return; done = true; off(); cb(v, c); }, { ...opts, current: opts.current ?? defaults.current });
            if (done)
                off();
            return off;
        },
        onEach(cb, opts = {}) {
            if (fullPaths.some(p => p.length == base.length) && !warnedRootOnEach) {
                warnedRootOnEach = true;
                console.warn("store: update(true).onEach fires ONCE per drain window with the WHOLE value (per selected path, not per key). For per-changed-key delivery use store.each(); for a subset — an explicit key mask.");
            }
            const o = { ...defaults, ...opts };
            const offs = fullPaths.map(p => subscribePath(store, p, cb, o, false));
            return () => { for (const off of offs)
                off(); };
        },
    };
}
function createStore(initial, opts = {}) {
    const reactiveOpts = { ...opts, _onMutation: undefined };
    const state = (0, reactive_1.reactive)(initial, reactiveOpts);
    let store;
    store = {
        _state: state,
        _nodeCache: new Map(),
        _counts: new Map(),
        _reactiveOpts: reactiveOpts,
        state,
        get node() { return getNode(store, []); },
        get: () => state,
        snapshot: () => snapshotValue(state),
        replace: (value) => replaceRoot(state, value),
        on: (cb, opts) => getNode(store, []).on(cb, opts),
        once: (cb, opts) => getNode(store, []).once(cb, opts),
        update: (mask, opts) => createSelection(store, [], mask, opts),
        each: (opts) => createEachListen(store, opts),
        listen: () => (0, reactive_1.listenUpdate)(state),
        listenPaths: () => (0, reactive_1.listenUpdatePaths)(state),
        count: () => Array.from(store._counts.values()).reduce((a, b) => a + b, 0),
    };
    return store;
}
function exposeStore(store, opts = {}) {
    const get = ((mask) => mask ? store.update(mask).get() : store.snapshot());
    const api = {
        get,
        set: (path, value) => setAt(store.state, path, value),
        replace: (path, value) => setAt(store.state, path, value),
        changed: store.listen(),
        changedPaths: store.listenPaths(),
    };
    if (opts.push) {
        api.patches = createPatchesListen(store);
        api.changedData = createChangedDataListen(store);
    }
    return api;
}
function isRemoteListen(listen) {
    return typeof listen?.on == "function";
}
function subscribeRemote(listen, cb) {
    if (typeof listen?.on != "function")
        return () => { };
    const handle = listen.on(cb);
    return () => {
        if (typeof handle == "function")
            handle();
        else if (typeof handle?.off == "function")
            handle.off();
        else if (typeof listen?.off == "function")
            listen.off(cb);
    };
}
function createStoreMirror(remote, initial = {}, opts = {}) {
    const store = createStore(initial, opts);
    const makeReport = (subOpts) => (error) => {
        if (subOpts.onError)
            subOpts.onError(error);
        else
            setTimeout(() => { throw error; }, 0);
    };
    async function pull(mask) {
        const snap = await remote.get(mask);
        applyMask(store.state, mask, snap);
    }
    async function sync(mask, subOpts = { current: true }) {
        const baseMask = mask ?? true;
        const report = makeReport(subOpts);
        if (subOpts.current !== false)
            await pull(baseMask);
        let pendingMask = undefined;
        let chain = Promise.resolve();
        const drained = createDrained(() => {
            const nextMask = pendingMask === undefined ? baseMask : pendingMask;
            pendingMask = undefined;
            chain = chain.then(() => pull(nextMask)).catch(report);
        }, subOpts.drain);
        const queue = (nextMask) => {
            pendingMask = pendingMask === undefined ? nextMask : mergeMasks(pendingMask, nextMask);
            drained.push();
        };
        const changedPaths = remote.changedPaths;
        const usePaths = subOpts.partial !== false && isRemoteListen(changedPaths);
        const off = usePaths
            ? subscribeRemote(changedPaths, (change) => {
                const nextMask = intersectMaskWithPaths(baseMask, change?.paths);
                if (nextMask !== undefined)
                    queue(nextMask);
            })
            : subscribeRemote(remote.changed, () => queue(baseMask));
        return () => { drained.close(); off(); };
    }
    async function syncPatches(mask, subOpts = { current: true }) {
        if (!isRemoteListen(remote.patches))
            throw new Error("createStoreMirror.syncPatches: remote.patches is not exposed");
        const baseMask = mask ?? true;
        const report = makeReport(subOpts);
        if (subOpts.current !== false)
            await pull(baseMask);
        const pending = [];
        const drained = createDrained(() => {
            const batch = pending.splice(0);
            try {
                applyStorePatches(store, batch);
            }
            catch (e) {
                report(e);
            }
        }, subOpts.drain);
        const off = subscribeRemote(remote.patches, (patch) => {
            const next = patchesForMask(patch, baseMask);
            if (next.length == 0)
                return;
            pending.push(...next);
            drained.push();
        });
        return () => { drained.close(); off(); };
    }
    async function syncChangedData(mask, subOpts = { current: true }) {
        if (!isRemoteListen(remote.changedData))
            throw new Error("createStoreMirror.syncChangedData: remote.changedData is not exposed");
        const baseMask = mask ?? true;
        const report = makeReport(subOpts);
        if (subOpts.current !== false)
            await pull(baseMask);
        const pending = [];
        const drained = createDrained(() => {
            const batch = pending.splice(0);
            try {
                for (const change of batch) {
                    const nextMask = intersectMaskWithPaths(baseMask, maskPaths(change?.mask ?? true));
                    if (nextMask !== undefined)
                        applyMask(store.state, nextMask, change.data);
                }
            }
            catch (e) {
                report(e);
            }
        }, subOpts.drain);
        const off = subscribeRemote(remote.changedData, (change) => {
            pending.push(change);
            drained.push();
        });
        return () => { drained.close(); off(); };
    }
    return Object.assign(store, { sync, syncPatches, syncChangedData });
}
