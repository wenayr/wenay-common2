"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reactive = reactive;
exports.isReactive = isReactive;
exports.toRaw = toRaw;
exports.onUpdate = onUpdate;
exports.onUpdatePaths = onUpdatePaths;
exports.flushReactive = flushReactive;
exports.listenUpdate = listenUpdate;
exports.listenUpdatePaths = listenUpdatePaths;
const Listen_1 = require("../events/Listen");
const NODE = Symbol('reactive.node');
const isObj = (v) => v != null && typeof v == 'object';
const isReactiveObj = (v) => {
    if (!isObj(v))
        return false;
    if (Array.isArray(v))
        return true;
    const p = Object.getPrototypeOf(v);
    return p == Object.prototype || p == null;
};
const hasSetImmediate = typeof setImmediate == 'function';
function scheduler(drain) {
    if (drain == 'micro')
        return f => queueMicrotask(f);
    if (typeof drain == 'number')
        return f => { setTimeout(f, drain); };
    if (typeof drain == 'function')
        return f => drain(f);
    return hasSetImmediate ? f => { setImmediate(f); } : f => { setTimeout(f, 0); };
}
function reactive(root, opts = {}) {
    const { drain = 'immediate', depth = Infinity, eager = false } = opts;
    const internalOpts = opts;
    const hasMutationHook = '_onMutation' in internalOpts;
    const fire = scheduler(drain);
    const eng = {
        live: 0, pathLive: 0, dirty: new Set(), dirtyPaths: [],
        dirtyPathKeys: new Set(), pathKey: createPathKeyer(),
        scheduled: false, waiters: new Set(), depth,
        schedule() {
            if (eng.scheduled)
                return;
            eng.scheduled = true;
            fire(function flush() {
                eng.scheduled = false;
                const batch = [...eng.dirty];
                eng.dirty.clear();
                const dirtyPaths = eng.dirtyPaths;
                eng.dirtyPaths = [];
                eng.dirtyPathKeys = new Set();
                eng.pathKey = createPathKeyer();
                let err;
                for (const n of batch) {
                    for (const cb of [...n.subs]) {
                        try {
                            cb();
                        }
                        catch (e) {
                            err ??= e;
                        }
                    }
                    if (n.pathSubs.size) {
                        const paths = pathsForNode(n, dirtyPaths);
                        if (paths.length)
                            for (const cb of [...n.pathSubs]) {
                                try {
                                    cb({ paths });
                                }
                                catch (e) {
                                    err ??= e;
                                }
                            }
                    }
                }
                if (!eng.scheduled && eng.dirty.size == 0 && eng.dirtyPaths.length == 0) {
                    const waiters = [...eng.waiters];
                    eng.waiters.clear();
                    for (const w of waiters)
                        w();
                }
                if (err !== undefined)
                    setTimeout(() => { throw err; }, 0);
            });
        },
    };
    if (hasMutationHook) {
        let onMutation = internalOpts._onMutation;
        Object.defineProperty(internalOpts, '_onMutation', {
            configurable: true,
            get: () => onMutation,
            set: next => { onMutation = next; eng.onMutation = next; },
        });
        eng.onMutation = onMutation;
    }
    const rootNode = makeNode(root, null, [], 0, eng);
    if (eager)
        prewalk(rootNode);
    return rootNode.proxy;
}
function makeNode(target, parent, path, level, eng) {
    const node = {
        target, parent, path, active: true, level,
        subs: new Set(), pathSubs: new Set(), kids: new Map(), proxy: null, eng,
    };
    const proxyTarget = (Array.isArray(target) ? [] : {});
    node.proxy = new Proxy(proxyTarget, {
        get(_, k) {
            if (k == NODE)
                return node;
            if (k == 'toJSON' && Array.isArray(proxyTarget) && !Array.isArray(node.target) && node.target?.toJSON === undefined)
                return () => node.target;
            const v = node.target[k];
            if (isReactiveObj(v) && level < eng.depth) {
                let kid = node.kids.get(k);
                if (!kid) {
                    kid = makeNode(v, node, [...node.path, k], level + 1, eng);
                    node.kids.set(k, kid);
                }
                else if (kid.target !== v)
                    kid.target = v;
                return kid.proxy;
            }
            return v;
        },
        set(_, k, v) {
            v = toRaw(v);
            const had = Object.prototype.hasOwnProperty.call(node.target, k);
            if (had && Object.is(node.target[k], v))
                return true;
            if (had) {
                if (!Reflect.set(node.target, k, v, node.target))
                    return false;
            }
            else {
                if (!Reflect.defineProperty(node.target, k, {
                    configurable: true,
                    enumerable: true,
                    value: v,
                    writable: true,
                }))
                    return false;
            }
            if (Array.isArray(proxyTarget) && k == "length")
                proxyTarget.length = v;
            const kid = node.kids.get(k);
            if (kid)
                rebind(kid, v);
            node.eng.onMutation?.(dirtyPathFor(node, k));
            if (eng.live > 0)
                bubble(node, k);
            return true;
        },
        defineProperty(_, k, d) {
            const had = Object.prototype.hasOwnProperty.call(node.target, k);
            const old = node.target[k];
            const desc = 'value' in d ? { ...d, value: toRaw(d.value) } : d;
            const ok = Reflect.defineProperty(node.target, k, desc);
            if (!ok)
                return false;
            if (desc.configurable === false) {
                const mirror = Reflect.defineProperty(proxyTarget, k, desc);
                if (!mirror)
                    return false;
            }
            const v = node.target[k];
            if (!had || !Object.is(old, v)) {
                const kid = node.kids.get(k);
                if (kid) {
                    if (isReactiveObj(v))
                        rebind(kid, v);
                    else {
                        node.kids.delete(k);
                        markChanged(kid);
                        detachTree(kid);
                    }
                }
                node.eng.onMutation?.(dirtyPathFor(node, k));
                if (eng.live > 0)
                    bubble(node, k);
            }
            return true;
        },
        deleteProperty(_, k) {
            if (!Object.prototype.hasOwnProperty.call(node.target, k))
                return true;
            if (!Reflect.deleteProperty(node.target, k))
                return false;
            const kid = node.kids.get(k);
            if (kid) {
                node.kids.delete(k);
                markChanged(kid);
                detachTree(kid);
            }
            node.eng.onMutation?.(dirtyPathFor(node, k));
            if (eng.live > 0)
                bubble(node, k);
            return true;
        },
        has(_, k) { return k in node.target; },
        ownKeys() {
            const keys = Reflect.ownKeys(node.target);
            for (const k of Reflect.ownKeys(proxyTarget)) {
                const d = Reflect.getOwnPropertyDescriptor(proxyTarget, k);
                if (d?.configurable === false && !keys.includes(k))
                    keys.push(k);
            }
            return keys;
        },
        getOwnPropertyDescriptor(_, k) {
            if (Array.isArray(proxyTarget) && k == "length")
                return Reflect.getOwnPropertyDescriptor(proxyTarget, k);
            const pd = Reflect.getOwnPropertyDescriptor(proxyTarget, k);
            if (pd && pd.configurable === false)
                return pd;
            const d = Reflect.getOwnPropertyDescriptor(node.target, k);
            if (d)
                d.configurable = true;
            return d;
        },
    });
    return node;
}
function bubble(from, key) {
    const eng = from.eng;
    if (eng.pathLive > 0)
        addDirtyPath(eng, dirtyPathFor(from, key));
    for (let n = from; n && n.active; n = n.parent)
        if (n.subs.size || n.pathSubs.size)
            eng.dirty.add(n);
    eng.schedule();
}
function rebind(node, next) {
    node.target = next;
    if (node.subs.size || node.pathSubs.size)
        node.eng.dirty.add(node);
    for (const [k, kid] of [...node.kids]) {
        const cv = isReactiveObj(next) ? next[k] : undefined;
        if (isReactiveObj(cv))
            rebind(kid, cv);
        else {
            node.kids.delete(k);
            markChanged(kid);
            detachTree(kid);
        }
    }
}
function markChanged(node) {
    if (node.subs.size || node.pathSubs.size)
        node.eng.dirty.add(node);
    for (const kid of node.kids.values())
        markChanged(kid);
}
function dirtyPathFor(node, key) {
    return Array.isArray(node.target) ? [...node.path] : [...node.path, key];
}
function createPathKeyer() {
    let symIds = null;
    return function pathKey(path) {
        let out = '';
        for (const p of path) {
            if (typeof p == 'symbol') {
                symIds ??= new Map();
                let id = symIds.get(p);
                if (id == null) {
                    id = symIds.size;
                    symIds.set(p, id);
                }
                out += 'y' + id + '|';
            }
            else {
                const s = String(p);
                out += (typeof p)[0] + s.length + ':' + s + '|';
            }
        }
        return out;
    };
}
function addDirtyPath(eng, path) {
    const k = eng.pathKey(path);
    if (eng.dirtyPathKeys.has(k))
        return;
    eng.dirtyPathKeys.add(k);
    eng.dirtyPaths.push(path);
}
function startsWithPath(path, prefix) {
    return prefix.length <= path.length && prefix.every((k, i) => Object.is(k, path[i]));
}
function pathsForNode(node, dirtyPaths) {
    const out = [];
    const seen = new Set();
    const pathKey = createPathKeyer();
    for (const path of dirtyPaths) {
        let next = null;
        if (startsWithPath(path, node.path))
            next = path.slice(node.path.length);
        else if (startsWithPath(node.path, path))
            next = [];
        if (next == null)
            continue;
        const k = pathKey(next);
        if (seen.has(k))
            continue;
        seen.add(k);
        out.push(next);
    }
    return out;
}
function detachTree(node) {
    if (!node.active)
        return;
    node.active = false;
    node.parent = null;
    for (const kid of node.kids.values())
        detachTree(kid);
    node.kids.clear();
}
function prewalk(node) {
    if (node.level >= node.eng.depth)
        return;
    for (const k of Reflect.ownKeys(node.target)) {
        if (isReactiveObj(node.target[k])) {
            node.proxy[k];
            const kid = node.kids.get(k);
            if (kid)
                prewalk(kid);
        }
    }
}
function isReactive(p) {
    const node = p && p[NODE];
    return !!node && node.active;
}
function toRaw(p) {
    const node = p && p[NODE];
    return node ? node.target : p;
}
function onUpdate(p, cb) {
    const node = p && p[NODE];
    if (!node)
        throw new Error('onUpdate: not a reactive object');
    if (!node.active)
        throw new Error('onUpdate: reactive object is detached');
    const sub = () => cb();
    node.subs.add(sub);
    node.eng.live++;
    let done = false;
    return () => { if (done)
        return; done = true; if (node.subs.delete(sub))
        node.eng.live--; };
}
function onUpdatePaths(p, cb) {
    const node = p && p[NODE];
    if (!node)
        throw new Error('onUpdatePaths: not a reactive object');
    if (!node.active)
        throw new Error('onUpdatePaths: reactive object is detached');
    const sub = (change) => cb(change);
    node.pathSubs.add(sub);
    node.eng.live++;
    node.eng.pathLive++;
    let done = false;
    return () => {
        if (done)
            return;
        done = true;
        if (node.pathSubs.delete(sub)) {
            node.eng.live--;
            node.eng.pathLive--;
        }
    };
}
function flushReactive(p) {
    const node = p && p[NODE];
    if (!node)
        throw new Error('flushReactive: not a reactive object');
    const eng = node.eng;
    if (!eng.scheduled && eng.dirty.size == 0 && eng.dirtyPaths.length == 0)
        return Promise.resolve();
    return new Promise(resolve => { eng.waiters.add(resolve); });
}
function listenUpdate(p) {
    const listen = (0, Listen_1.createListen)((emit) => onUpdate(p, () => emit()), {
        event: (type, count, api) => {
            if (type == "add" && count == 1 && !api.isRunning())
                api.run();
            if (type == "remove" && count == 0 && api.isRunning())
                api.close();
        },
    });
    return listen;
}
function listenUpdatePaths(p) {
    const listen = (0, Listen_1.createListen)((emit) => onUpdatePaths(p, change => emit(change)), {
        event: (type, count, api) => {
            if (type == "add" && count == 1 && !api.isRunning())
                api.run();
            if (type == "remove" && count == 0 && api.isRunning())
                api.close();
        },
    });
    return listen;
}
