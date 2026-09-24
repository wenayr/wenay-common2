"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reactive = reactive;
exports.isReactive = isReactive;
exports.toRaw = toRaw;
exports.onUpdate = onUpdate;
exports.onUpdatePaths = onUpdatePaths;
exports.flushReactive = flushReactive;
exports.flushReactiveNow = flushReactiveNow;
exports.listenUpdate = listenUpdate;
exports.listenUpdatePaths = listenUpdatePaths;
const Listen_1 = require("../events/Listen");
const defer_immediate_1 = require("../core/defer-immediate");
const reactive_value_1 = require("./reactive-value");
const observe_private_1 = require("./observe-private");
const NODE = Symbol('reactive.node');
function scheduler(drain) {
    if (drain == 'micro')
        return f => queueMicrotask(f);
    if (typeof drain == 'number')
        return f => { setTimeout(f, drain); };
    if (typeof drain == 'function')
        return f => drain(f);
    return defer_immediate_1.deferImmediate;
}
function reactive(root, opts = {}) {
    const { drain = 'immediate', depth = Infinity, eager = false } = opts;
    const internalOpts = opts;
    const hasMutationHook = '_onMutation' in internalOpts;
    const fire = scheduler(drain);
    const eng = {
        live: 0, pathLive: 0, dirty: new Set(), dirtyPaths: [],
        dirtyPathKeys: new Set(), pathKey: createPathKeyer(),
        arrayMutationPaths: [], arrayMutationPathKeys: new Set(),
        arrayReplacementPaths: [], arrayReplacementPathKeys: new Set(),
        arrayPathKey: createPathKeyer(),
        scheduled: false, waiters: new Set(), depth,
        schedule() {
            if (eng.scheduled)
                return;
            eng.scheduled = true;
            fire(eng.flush);
        },
        flush() {
            {
                if (!eng.scheduled)
                    return;
                eng.scheduled = false;
                const batch = [...eng.dirty];
                eng.dirty.clear();
                const dirtyPaths = eng.dirtyPaths;
                eng.dirtyPaths = [];
                const arrayMutations = {
                    paths: eng.arrayMutationPaths,
                    replacements: eng.arrayReplacementPaths,
                };
                eng.dirtyPathKeys = new Set();
                eng.pathKey = createPathKeyer();
                eng.arrayMutationPaths = [];
                eng.arrayMutationPathKeys = new Set();
                eng.arrayReplacementPaths = [];
                eng.arrayReplacementPathKeys = new Set();
                eng.arrayPathKey = createPathKeyer();
                let err;
                for (const n of batch) {
                    if (n.subs)
                        for (const cb of [...n.subs]) {
                            try {
                                cb();
                            }
                            catch (e) {
                                err ??= e;
                            }
                        }
                    if (n.pathSubs?.size) {
                        const paths = pathsForNode(n, dirtyPaths);
                        if (paths.length)
                            for (const cb of [...n.pathSubs]) {
                                try {
                                    const change = { paths };
                                    Object.defineProperty(change, observe_private_1.REACTIVE_ARRAY_MUTATIONS, { value: arrayMutations });
                                    cb(change);
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
            }
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
    const rootNode = new Node((0, reactive_value_1.prepareReactiveValue)(root, toRaw), null, undefined, eng);
    if (eager)
        prewalk(rootNode);
    return rootNode.proxy;
}
function ObjectDummy() { }
ObjectDummy.prototype = Object.prototype;
function makeDummy(target) {
    return Array.isArray(target) ? new Array(target.length) : new ObjectDummy();
}
class Node {
    target;
    parent;
    key;
    active = true;
    subs = null;
    pathSubs = null;
    kids = null;
    proxy;
    eng;
    constructor(target, parent, key, eng) {
        this.target = target;
        this.parent = parent;
        this.key = key;
        this.eng = eng;
        this.proxy = new Proxy(makeDummy(target), this);
    }
    get(dummy, k) {
        if (k == NODE)
            return this;
        if (k == 'toJSON' && Array.isArray(dummy) && !Array.isArray(this.target) && this.target?.toJSON === undefined)
            return () => this.target;
        const v = toRaw(this.target[k]);
        if ((0, reactive_value_1.isReactiveObj)(v) && (this.eng.depth == Infinity || levelOf(this) < this.eng.depth)) {
            let kid = this.kids?.get(k);
            if (!kid) {
                kid = new Node(v, this, k, this.eng);
                (this.kids ??= new Map()).set(k, kid);
            }
            else if (kid.target !== v)
                kid.target = v;
            return kid.proxy;
        }
        return v;
    }
    set(dummy, k, v) {
        const eng = this.eng;
        v = (0, reactive_value_1.prepareReactiveValue)(v, toRaw);
        const had = Object.prototype.hasOwnProperty.call(this.target, k);
        const old = this.target[k];
        if (had && Object.is(old, v))
            return true;
        let accepted = true;
        if (had) {
            accepted = Reflect.set(this.target, k, v, this.target);
        }
        else {
            if (!Reflect.defineProperty(this.target, k, {
                configurable: true,
                enumerable: true,
                value: v,
                writable: true,
            }))
                return false;
        }
        const next = this.target[k];
        if (!accepted && Object.is(old, next))
            return false;
        if (Array.isArray(this.target) && k == 'length') {
            syncArrayLength(dummy, this);
            if (next < old)
                detachTruncatedChildren(this);
        }
        const kid = this.kids?.get(k);
        if (kid)
            rebind(kid, next);
        eng.onMutation?.(dirtyPathFor(this, k));
        if (eng.live > 0)
            bubble(this, k, Array.isArray(old) || Array.isArray(v));
        return accepted;
    }
    defineProperty(dummy, k, d) {
        const eng = this.eng;
        const had = Object.prototype.hasOwnProperty.call(this.target, k);
        const old = this.target[k];
        const desc = 'value' in d ? { ...d, value: (0, reactive_value_1.prepareReactiveValue)(d.value, toRaw) } : d;
        const ok = Reflect.defineProperty(this.target, k, desc);
        const v = this.target[k];
        if (!ok && Object.is(old, v))
            return false;
        if (Array.isArray(this.target) && k == 'length')
            syncArrayLength(dummy, this);
        else if (desc.configurable === false) {
            const mirror = Reflect.defineProperty(dummy, k, desc);
            if (!mirror)
                return false;
        }
        if (!had || !Object.is(old, v)) {
            if (Array.isArray(this.target) && k == 'length' && v < old)
                detachTruncatedChildren(this);
            const kid = this.kids?.get(k);
            if (kid) {
                if ((0, reactive_value_1.isReactiveObj)(v))
                    rebind(kid, v);
                else {
                    this.kids.delete(k);
                    markChanged(kid);
                    detachTree(kid);
                }
            }
            eng.onMutation?.(dirtyPathFor(this, k));
            if (eng.live > 0)
                bubble(this, k, Array.isArray(old) || Array.isArray(v));
        }
        return ok;
    }
    deleteProperty(dummy, k) {
        const eng = this.eng;
        if (!Object.prototype.hasOwnProperty.call(this.target, k))
            return true;
        const old = this.target[k];
        if (!Reflect.deleteProperty(this.target, k))
            return false;
        const kid = this.kids?.get(k);
        if (kid) {
            this.kids.delete(k);
            markChanged(kid);
            detachTree(kid);
        }
        eng.onMutation?.(dirtyPathFor(this, k));
        if (eng.live > 0)
            bubble(this, k, Array.isArray(old));
        return true;
    }
    has(dummy, k) { return k in this.target; }
    ownKeys(dummy) {
        const keys = Reflect.ownKeys(this.target);
        for (const k of Reflect.ownKeys(dummy)) {
            const d = Reflect.getOwnPropertyDescriptor(dummy, k);
            if (d?.configurable === false && !keys.includes(k))
                keys.push(k);
        }
        return keys;
    }
    getOwnPropertyDescriptor(dummy, k) {
        if (Array.isArray(dummy) && k == "length") {
            syncArrayLength(dummy, this);
            return Reflect.getOwnPropertyDescriptor(dummy, k);
        }
        const pd = Reflect.getOwnPropertyDescriptor(dummy, k);
        if (pd && pd.configurable === false)
            return pd;
        const d = Reflect.getOwnPropertyDescriptor(this.target, k);
        if (d)
            d.configurable = true;
        return d;
    }
}
function syncArrayLength(dummy, node) {
    if (!Array.isArray(dummy) || !Array.isArray(node.target))
        return;
    const descriptor = Reflect.getOwnPropertyDescriptor(node.target, 'length');
    Reflect.defineProperty(dummy, 'length', descriptor);
}
function levelOf(node) {
    let level = 0;
    let n = node;
    while (n.parent) {
        level++;
        n = n.parent;
    }
    if (Array.isArray(n.key))
        level += n.key.length;
    return level;
}
function pathTo(node, extra = 0) {
    let depth = 0;
    let n = node;
    while (n.parent) {
        depth++;
        n = n.parent;
    }
    const frozen = Array.isArray(n.key) ? n.key : null;
    const base = frozen ? frozen.length : 0;
    const out = new Array(base + depth + extra);
    if (frozen)
        for (let i = 0; i < base; i++)
            out[i] = frozen[i];
    let at = base + depth;
    for (let m = node; m.parent; m = m.parent)
        out[--at] = m.key;
    return out;
}
function pathOf(node, key) {
    const out = pathTo(node, 1);
    out[out.length - 1] = key;
    return out;
}
function bubble(from, key, replacedArrayBranch = false) {
    const eng = from.eng;
    if (eng.pathLive > 0) {
        const dirtyPath = dirtyPathFor(from, key);
        addDirtyPath(eng, dirtyPath);
        if (Array.isArray(from.target))
            addArrayPath(eng, pathOf(from, key), false);
        else if (replacedArrayBranch)
            addArrayPath(eng, dirtyPath, true);
    }
    for (let n = from; n && n.active; n = n.parent)
        if (n.subs?.size || n.pathSubs?.size)
            eng.dirty.add(n);
    eng.schedule();
}
function rebind(node, next) {
    node.target = next = toRaw(next);
    if (node.subs?.size || node.pathSubs?.size)
        node.eng.dirty.add(node);
    if (!node.kids)
        return;
    for (const [k, kid] of [...node.kids]) {
        const cv = (0, reactive_value_1.isReactiveObj)(next) ? next[k] : undefined;
        if ((0, reactive_value_1.isReactiveObj)(cv))
            rebind(kid, cv);
        else {
            node.kids.delete(k);
            markChanged(kid);
            detachTree(kid);
        }
    }
}
function markChanged(node) {
    if (node.subs?.size || node.pathSubs?.size)
        node.eng.dirty.add(node);
    if (node.kids)
        for (const kid of node.kids.values())
            markChanged(kid);
}
function dirtyPathFor(node, key) {
    return Array.isArray(node.target) ? pathTo(node) : pathOf(node, key);
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
function addArrayPath(eng, path, replacement) {
    const key = eng.arrayPathKey(path);
    const keys = replacement ? eng.arrayReplacementPathKeys : eng.arrayMutationPathKeys;
    if (keys.has(key))
        return;
    keys.add(key);
    const paths = replacement ? eng.arrayReplacementPaths : eng.arrayMutationPaths;
    paths.push(path);
}
function startsWithPath(path, prefix) {
    return prefix.length <= path.length && prefix.every((k, i) => Object.is(k, path[i]));
}
function pathsForNode(node, dirtyPaths) {
    const out = [];
    const seen = new Set();
    const pathKey = createPathKeyer();
    const nodePath = pathTo(node);
    for (const path of dirtyPaths) {
        let next = null;
        if (startsWithPath(path, nodePath))
            next = path.slice(nodePath.length);
        else if (startsWithPath(nodePath, path))
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
    node.key = pathTo(node);
    node.parent = null;
    if (node.kids)
        for (const kid of node.kids.values())
            detachTree(kid);
    node.kids = null;
}
function detachTruncatedChildren(node) {
    if (!node.kids)
        return;
    for (const [key, child] of node.kids) {
        if (Object.prototype.hasOwnProperty.call(node.target, key))
            continue;
        node.kids.delete(key);
        markChanged(child);
        detachTree(child);
    }
}
function prewalk(node, ancestors = new WeakSet()) {
    if ((node.eng.depth != Infinity && levelOf(node) >= node.eng.depth) || ancestors.has(node.target))
        return;
    ancestors.add(node.target);
    for (const k of Reflect.ownKeys(node.target)) {
        if ((0, reactive_value_1.isReactiveObj)(node.target[k])) {
            node.proxy[k];
            const kid = node.kids?.get(k);
            if (kid)
                prewalk(kid, ancestors);
        }
    }
    ancestors.delete(node.target);
}
function isReactive(p) {
    const node = typeof p == 'object' && p != null ? p[NODE] : undefined;
    return !!node && node.active;
}
function toRaw(p) {
    const node = typeof p == 'object' && p != null ? p[NODE] : undefined;
    return node ? node.target : p;
}
function onUpdate(p, cb) {
    const node = p && p[NODE];
    if (!node)
        throw new Error('onUpdate: not a reactive object');
    if (!node.active)
        throw new Error('onUpdate: reactive object is detached');
    const sub = () => cb();
    (node.subs ??= new Set()).add(sub);
    node.eng.live++;
    let done = false;
    return () => { if (done)
        return; done = true; if (node.subs?.delete(sub))
        node.eng.live--; };
}
function onUpdatePaths(p, cb) {
    const node = p && p[NODE];
    if (!node)
        throw new Error('onUpdatePaths: not a reactive object');
    if (!node.active)
        throw new Error('onUpdatePaths: reactive object is detached');
    const sub = (change) => cb(change);
    (node.pathSubs ??= new Set()).add(sub);
    node.eng.live++;
    node.eng.pathLive++;
    let done = false;
    return () => {
        if (done)
            return;
        done = true;
        if (node.pathSubs?.delete(sub)) {
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
function flushReactiveNow(p) {
    const node = p && p[NODE];
    if (!node)
        throw new Error('flushReactiveNow: not a reactive object');
    if (node.eng.scheduled)
        node.eng.flush();
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
