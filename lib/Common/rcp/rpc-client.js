"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRpcClient = createRpcClient;
const rpc_protocol_1 = require("./rpc-protocol");
const rpc_path_1 = require("./rpc-path");
const id_pool_1 = require("../id-pool");
const rpc_walk_1 = require("./rpc-walk");
const rpc_limits_1 = require("./rpc-limits");
const myThrow_1 = require("../../toError/myThrow");
const rpc_off_1 = require("./rpc-off");
const rpc_caps_1 = require("./rpc-caps");
const SHARED_POOLS = new WeakMap();
function sharedPool(socket, key) {
    let byKey = SHARED_POOLS.get(socket);
    if (!byKey) {
        byKey = new Map();
        SHARED_POOLS.set(socket, byKey);
    }
    let pool = byKey.get(key);
    if (!pool) {
        pool = (0, id_pool_1.createIdPool)();
        byKey.set(key, pool);
    }
    return pool;
}
const reviveErr = (o) => {
    if (o == null || typeof o != "object" || typeof o.message != "string" || typeof o.name != "string")
        return o;
    const o2 = o.data !== undefined ? { ...o, data: (0, rpc_walk_1.unpackResult)(o.data) } : o;
    const err = myThrow_1.MyError.fromWire(o2);
    if (o.cause !== undefined)
        err.cause = reviveErr(o.cause);
    return err;
};
function listenKeyArg(a) {
    if (typeof a == "function")
        return "@fn";
    if (typeof a == "bigint")
        return { $_b: a.toString() };
    if (a instanceof Date)
        return { $_d: a.valueOf() };
    if (a instanceof Map)
        return { $_m: [...a.entries()].map(([k, v]) => [listenKeyArg(k), listenKeyArg(v)]) };
    if (a instanceof Set)
        return { $_s: [...a.values()].map(listenKeyArg) };
    if (Array.isArray(a))
        return a.map(listenKeyArg);
    if (a && typeof a == "object") {
        const out = {};
        for (const k of Object.keys(a).sort())
            out[k] = listenKeyArg(a[k]);
        return out;
    }
    return a;
}
const IS_RPC_PIPE = Symbol.for("isRpcPipe");
function createClient(socket, key, opts) {
    const limit = opts?.limit ?? 10000;
    const lim = opts?.limits ? (0, rpc_limits_1.resolveLimits)(opts.limits) : undefined;
    const pool = sharedPool(socket, key);
    const pending = new Map();
    const callbacks = new Map();
    const compactShapes = new Map();
    let capsSent = false;
    const clientCaps = (0, rpc_caps_1.optToCaps)(opts?.opt);
    let peerServerCaps = 0;
    const zombies = new Set();
    const retire = (id) => { zombies.add(id); };
    let disposed = false;
    let disconnectCbs = [];
    let disconnectResolve = () => { };
    const disconnectPromise = new Promise(res => { disconnectResolve = res; });
    function onDisconnect(cb) {
        disconnectCbs.push(cb);
        function offDisconnect() { const i = disconnectCbs.indexOf(cb); if (i >= 0)
            disconnectCbs.splice(i, 1); }
        return (0, rpc_off_1.makeOff)(disconnectPromise, offDisconnect);
    }
    const routeCache = {};
    let strictData = {};
    let strictWaiters = [];
    let debug = false;
    let authToken = opts?.token ?? null;
    let authStatus = undefined;
    let authWaiters = [];
    let authPending = false;
    const drainAuth = (s) => { authPending = false; const w = authWaiters; authWaiters = []; for (const r of w)
        r(s); };
    const setAuthStatus = (s) => { authStatus = s; drainAuth(s); };
    socket.on(key, (msg) => {
        if (!Array.isArray(msg))
            return;
        if (disposed) {
            if ((msg[0] == rpc_protocol_1.Pkt.RESP || msg[0] == rpc_protocol_1.Pkt.CB_END) && zombies.delete(msg[1]))
                pool.release(msg[1]);
            return;
        }
        switch (msg[0]) {
            case rpc_protocol_1.Pkt.RESP: {
                const req = pending.get(msg[1]);
                if (!req) {
                    if (zombies.delete(msg[1]))
                        pool.release(msg[1]);
                    break;
                }
                pending.delete(msg[1]);
                pool.release(msg[1]);
                for (const cbId of req.cbs) {
                    if (callbacks.delete(cbId))
                        pool.release(cbId);
                }
                if (msg[3])
                    req.fail(reviveErr(msg[3]));
                else {
                    try {
                        req.ok((0, rpc_walk_1.unpackResult)(msg[2], lim));
                    }
                    catch (e) {
                        req.fail(e);
                    }
                }
                break;
            }
            case rpc_protocol_1.Pkt.CB: {
                const cb = callbacks.get(msg[1]);
                if (!cb)
                    break;
                let cbArgs;
                try {
                    cbArgs = (msg[2] || []).map((a) => (0, rpc_walk_1.unpackResult)(a, lim));
                }
                catch (e) {
                    if (debug)
                        console.log("[RPC CB] dropped:", e);
                    break;
                }
                cb(...cbArgs);
                break;
            }
            case rpc_protocol_1.Pkt.SHAPE: {
                let m = compactShapes.get(msg[1]);
                if (!m) {
                    m = [];
                    compactShapes.set(msg[1], m);
                }
                m[msg[2]] = msg[3];
                break;
            }
            case rpc_protocol_1.Pkt.CBV: {
                const cb = callbacks.get(msg[1]);
                if (!cb)
                    break;
                const keys = compactShapes.get(msg[1])?.[msg[2]];
                if (!keys)
                    break;
                const vals = msg[3] || [];
                let obj;
                try {
                    obj = {};
                    keys.forEach((k, i) => { obj[k] = (0, rpc_walk_1.unpackResult)(vals[i], lim); });
                }
                catch (e) {
                    if (debug)
                        console.log("[RPC CBV] dropped:", e);
                    break;
                }
                cb(obj);
                break;
            }
            case rpc_protocol_1.Pkt.CB_END: {
                const cbId = msg[1];
                compactShapes.delete(cbId);
                if (callbacks.delete(cbId))
                    pool.release(cbId);
                else if (zombies.delete(cbId))
                    pool.release(cbId);
                break;
            }
            case rpc_protocol_1.Pkt.CAPS: {
                peerServerCaps = typeof msg[1] === "number" ? msg[1] : 0;
                break;
            }
            case rpc_protocol_1.Pkt.MAP: {
                if (msg[1]) {
                    for (const k of Object.keys(routeCache))
                        delete routeCache[k];
                    Object.assign(routeCache, msg[1]);
                }
                if (Array.isArray(msg[3])) {
                    declaredListens ??= new Set();
                    for (const p of msg[3])
                        declaredListens.add(p);
                }
                if (msg[2]) {
                    for (const k of Object.keys(strictData))
                        delete strictData[k];
                    Object.assign(strictData, msg[2]);
                    for (const r of strictWaiters)
                        r(undefined);
                    strictWaiters = [];
                }
                if (msg.length > 4)
                    setAuthStatus(msg[4]);
                if (!capsSent) {
                    capsSent = true;
                    if (clientCaps)
                        socket.emit(key, [rpc_protocol_1.Pkt.CAPS, clientCaps]);
                }
                break;
            }
        }
    });
    const sendPipe = (path, steps, wait) => {
        if (disposed)
            return wait ? Promise.reject(new Error("RPC client disposed")) : Promise.resolve();
        const cbIds = [];
        const cleanSteps = steps.map(step => {
            if (step.type === 'call') {
                return { type: 'call', args: (0, rpc_walk_1.pack)(step.args, pool, callbacks, cbIds) };
            }
            return step;
        });
        const ref = routeCache[(0, rpc_path_1.rpcPathKey)(path)] ?? path;
        if (!wait) {
            socket.emit(key, [rpc_protocol_1.Pkt.PIPE, 0, ref, cleanSteps, false]);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            if (pending.size >= limit)
                return reject(new Error("RPC limit"));
            const reqId = pool.next();
            pending.set(reqId, { ok: resolve, fail: reject, cbs: cbIds });
            if (debug)
                console.log("[RPC PIPE]", path.join("."), "steps=", steps.length, "id=", reqId);
            socket.emit(key, [rpc_protocol_1.Pkt.PIPE, reqId, ref, cleanSteps]);
        });
    };
    const buildPipeProxy = (path, steps, wait) => {
        const proxy = new Proxy(function () { }, {
            get(_, p) {
                if (p === IS_RPC_PIPE)
                    return true;
                if (p === "then") {
                    if (path.length === 0)
                        return undefined;
                    const promise = sendPipe(path, steps, wait);
                    return (...a) => promise.then(...a);
                }
                if (p === "catch") {
                    if (path.length === 0)
                        return undefined;
                    const promise = sendPipe(path, steps, wait);
                    return (...a) => promise.catch(...a);
                }
                if (p === "finally") {
                    if (path.length === 0)
                        return undefined;
                    const promise = sendPipe(path, steps, wait);
                    return (...a) => promise.finally(...a);
                }
                if (p === "__executeRemainingPipe") {
                    return (remaining) => sendPipe(path, [...steps, ...remaining], wait);
                }
                if (p === Symbol.toPrimitive)
                    return undefined;
                if (path.length === 0) {
                    return buildPipeProxy([String(p)], steps, wait);
                }
                return buildPipeProxy(path, [...steps, { type: 'get', prop: String(p) }], wait);
            },
            apply(_, __, args) {
                if (path.length === 0)
                    throw new Error("Cannot call root pipe object");
                return buildPipeProxy(path, [...steps, { type: 'call', args }], wait);
            },
        });
        return proxy;
    };
    const sendCallWire = (path, args, wait) => {
        if (disposed)
            return wait ? Promise.reject(new Error("RPC client disposed")) : Promise.resolve();
        const cbIds = [];
        const clean = (0, rpc_walk_1.pack)(args, pool, callbacks, cbIds);
        const ref = routeCache[(0, rpc_path_1.rpcPathKey)(path)] ?? path;
        if (!wait) {
            socket.emit(key, [rpc_protocol_1.Pkt.CALL, 0, ref, clean, false]);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            if (pending.size >= limit)
                return reject(new Error("RPC limit"));
            const reqId = pool.next();
            pending.set(reqId, { ok: resolve, fail: reject, cbs: cbIds });
            if (debug)
                console.log("[RPC]", path.join("."), "id=", reqId);
            socket.emit(key, [rpc_protocol_1.Pkt.CALL, reqId, ref, clean]);
        });
    };
    const dedupe = opts?.dedupeListen ?? true;
    const wireSubs = new Map();
    let declaredListens = null;
    function subscribeShared(path, args) {
        if (disposed)
            return Promise.reject(new Error("RPC client disposed"));
        const listenPathKey = (0, rpc_path_1.rpcPathKey)(path.slice(0, -1));
        const skey = listenPathKey + "::" + JSON.stringify(args.map(listenKeyArg));
        let sub = wireSubs.get(skey);
        if (!sub) {
            const created = { consumers: new Set(), stop: () => { } };
            wireSubs.set(skey, created);
            let fnPos = 0;
            const realArgs = args.map(a => {
                if (typeof a != "function")
                    return a;
                const i = fnPos++;
                return (...ev) => {
                    let err;
                    created.consumers.forEach(c => {
                        try {
                            c.fns[i]?.(...ev);
                        }
                        catch (e) {
                            err ??= e;
                        }
                    });
                    if (err !== undefined)
                        setTimeout(() => { throw err; }, 0);
                };
            });
            const finish = () => {
                if (wireSubs.get(skey) == created)
                    wireSubs.delete(skey);
                created.consumers.forEach(c => c.resolve());
                created.consumers.clear();
            };
            created.stop = () => {
                sendCallWire([...path.slice(0, -1), "removeCallback"], [], false);
                finish();
            };
            sendCallWire(path, realArgs, true).then(finish, finish);
            sub = created;
        }
        const consumer = { fns: args.filter(a => typeof a == "function"), resolve: () => { } };
        sub.consumers.add(consumer);
        const p = new Promise(res => { consumer.resolve = res; });
        const unsub = function unsubscribe() {
            if (!sub.consumers.delete(consumer))
                return;
            consumer.resolve();
            if (sub.consumers.size == 0)
                sub.stop();
        };
        return (0, rpc_off_1.makeOff)(p, unsub, { off: unsub, unsubscribe: unsub, removeCallback: unsub });
    }
    const sendCall = (path, args, wait) => {
        const last = path[path.length - 1];
        if (dedupe && wait && path.length > 1 && (last == "callback" || last == "on") && args.some(a => typeof a == "function")) {
            const isListen = declaredListens ? declaredListens.has((0, rpc_path_1.rpcPathKey)(path.slice(0, -1))) : true;
            if (isListen)
                return subscribeShared(path, args);
        }
        return sendCallWire(path, args, wait);
    };
    const buildProxy = (path, wait) => new Proxy(function () { }, {
        get(_, p) {
            if (p == "then" || p == "catch" || p == Symbol.toPrimitive)
                return undefined;
            return buildProxy([...path, String(p)], wait);
        },
        apply(_, __, args) {
            const [fp, fa] = (0, rpc_walk_1.resolveCA)(path, args);
            return sendCall(fp, fa, wait);
        },
    });
    const buildStrict = (path, wait) => {
        let tgt = strictData;
        for (const seg of path) {
            tgt = tgt?.[seg];
            if (tgt == null || tgt == "null")
                return undefined;
            if (tgt == "dynamic")
                return buildProxy([...path], wait);
        }
        if (tgt == "dynamic")
            return buildProxy(path, wait);
        return new Proxy(tgt == "func" ? function () { } : {}, {
            has: (_, p) => tgt?.[String(p)] !== "null",
            ownKeys: () => tgt && typeof tgt == "object" ? Object.keys(tgt) : [],
            getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
            getPrototypeOf: () => !tgt || tgt == "null" ? Object.prototype : tgt == "func" ? Function.prototype : null,
            get(_, p) {
                if (p == "then" || p == "catch" || p == Symbol.toPrimitive)
                    return undefined;
                if (p == "call" && tgt == "func")
                    return (_, ...args) => sendCall(path, args, wait);
                if (tgt === "func")
                    return undefined;
                const child = tgt?.[String(p)];
                return child == "null" || child == undefined ? undefined : buildStrict([...path, String(p)], wait);
            },
            apply(_, __, args) {
                const [fp, fa] = (0, rpc_walk_1.resolveCA)(path, args);
                return sendCall(fp, fa, wait);
            },
        });
    };
    const releaseCbs = (fn) => {
        callbacks.forEach((cb, id) => { if (cb == fn) {
            callbacks.delete(id);
            retire(id);
        } });
    };
    function abortAll(reason) {
        const err = { error: { name: "RPC_ABORT", message: reason } };
        pending.forEach((p, id) => { retire(id); p.fail(err); });
        pending.clear();
        callbacks.forEach((_, id) => retire(id));
        callbacks.clear();
    }
    function drainWireSubs(socketAlive) {
        const subs = Array.from(wireSubs.values());
        wireSubs.clear();
        for (const s of subs) {
            if (socketAlive)
                s.stop();
            else {
                s.consumers.forEach(c => c.resolve());
                s.consumers.clear();
            }
        }
    }
    function dispose(reason = "RPC client disposed", opts) {
        if (disposed)
            return;
        const socketAlive = opts?.socketAlive ?? true;
        abortAll(reason);
        drainWireSubs(socketAlive);
        disposed = true;
        authPending = false;
        const sw = strictWaiters;
        strictWaiters = [];
        for (const r of sw)
            r(undefined);
        const aw = authWaiters;
        authWaiters = [];
        for (const r of aw)
            r({ ok: false, reason });
        const dc = disconnectCbs;
        disconnectCbs = [];
        for (const cb of dc)
            try {
                cb(reason);
            }
            catch { }
        disconnectResolve(reason);
    }
    const api = {
        log: s => { debug = s; },
        pending: () => pending.size,
        callbacks: () => callbacks.size,
        clearPromises: (rej = true) => {
            pending.forEach((p, id) => { retire(id); rej ? p.fail("promiseDeleteAll") : p.ok(undefined); });
            pending.clear();
        },
        clearCallbacks: () => { callbacks.forEach((_, id) => retire(id)); callbacks.clear(); },
        remove: releaseCbs,
        end: releaseCbs,
        subscriptions: () => Array.from(wireSubs, ([k, s]) => ({ key: k, consumers: s.consumers.size })),
    };
    const func = buildProxy([], true);
    const pipe = buildPipeProxy([], [], true);
    const pipeStrict = buildPipeProxy([], [], true);
    let _ready = null;
    let ready = () => _ready ? _ready : _ready = init();
    const init = async (obj) => {
        if (obj) {
            strictData = obj;
            return;
        }
        if (authToken != null) {
            authPending = true;
            socket.emit(key, [rpc_protocol_1.Pkt.HELLO, authToken]);
        }
        socket.emit(key, rpc_protocol_1.Pkt.STRICT);
        await new Promise(r => { strictWaiters.push(r); });
    };
    function reauth(token) {
        if (disposed)
            return Promise.resolve({ ok: false, reason: "RPC client disposed" });
        authToken = token;
        authPending = true;
        socket.emit(key, [rpc_protocol_1.Pkt.HELLO, token]);
        return new Promise(res => authWaiters.push(res));
    }
    const auth = () => disposed
        ? Promise.resolve(authStatus !== undefined ? authStatus : { ok: false, reason: "RPC client disposed" })
        : (authStatus !== undefined && !authPending) ? Promise.resolve(authStatus) : new Promise(res => authWaiters.push(res));
    return {
        func,
        pipe,
        pipeStrict,
        space: buildProxy([], false),
        all: func,
        strict: buildStrict([], true),
        api,
        abortAll,
        dispose,
        close: dispose,
        schema: () => strictData,
        readyStrict: ready,
        ready,
        initStrict: init,
        init,
        reauth,
        auth,
        onDisconnect,
    };
}
function createRpcClient({ socket, socketKey: key, limit, limits, dedupeListen, token, opt }) {
    return createClient(socket, key, { limit, limits, dedupeListen, token, opt });
}
