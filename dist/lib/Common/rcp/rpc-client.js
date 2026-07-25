"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRpcClient = createRpcClient;
const rpc_protocol_1 = require("./rpc-protocol");
const rpc_path_1 = require("./rpc-path");
const id_pool_1 = require("../id-pool");
const rpc_walk_1 = require("./rpc-walk");
const rpc_limits_1 = require("./rpc-limits");
const rpc_result_limits_1 = require("./rpc-result-limits");
const myThrow_1 = require("../../toError/myThrow");
const rpc_off_1 = require("./rpc-off");
const rpc_caps_1 = require("./rpc-caps");
const transport_lifecycle_1 = require("../events/transport-lifecycle");
const SHARED_POOLS = new WeakMap();
const SHARED_SESSION_IDS = new WeakMap();
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
function nextSessionId(socket, key) {
    let byKey = SHARED_SESSION_IDS.get(socket);
    if (!byKey) {
        byKey = new Map();
        SHARED_SESSION_IDS.set(socket, byKey);
    }
    const id = (byKey.get(key) ?? 0) + 1;
    if (!Number.isSafeInteger(id)) {
        throw new RangeError('RPC session id space exhausted');
    }
    byKey.set(key, id);
    return id;
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
function createPathProxyCache() {
    const values = new Map();
    const registry = new FinalizationRegistry(function releaseProxy(entry) {
        if (values.get(entry.key)?.token == entry.token)
            values.delete(entry.key);
    });
    function get(path) {
        const key = (0, rpc_path_1.rpcPathKey)(path);
        const proxy = values.get(key)?.ref.deref();
        if (!proxy)
            values.delete(key);
        return proxy;
    }
    function set(path, proxy) {
        const key = (0, rpc_path_1.rpcPathKey)(path);
        const token = {};
        values.set(key, { ref: new WeakRef(proxy), token });
        registry.register(proxy, { key, token });
        return proxy;
    }
    return { get, set };
}
const IS_RPC_PIPE = Symbol.for("isRpcPipe");
function createClient(socket, key, opts) {
    const limit = opts?.limit ?? 10000;
    const lim = opts?.limits ? (0, rpc_limits_1.resolveLimits)(opts.limits) : undefined;
    const pool = sharedPool(socket, key);
    const pending = new Map();
    const callbacks = new Map();
    const compactShapes = new Map();
    const clientCaps = (0, rpc_caps_1.optToCaps)(opts?.opt);
    let peerServerCaps = 0;
    const callbackBatchOn = () => (0, rpc_caps_1.hasCap)(clientCaps & peerServerCaps, rpc_caps_1.Caps.CB_BATCH);
    let serverGeneration;
    const clientId = nextSessionId(socket, key);
    let sessionId = nextSessionId(socket, key);
    let serverGenerationRecoveryPending = false;
    function beginTransportGeneration(generation) {
        serverGeneration = generation;
        sessionId = nextSessionId(socket, key);
    }
    function advertiseClientCaps() {
        socket.emit(key, serverGeneration == undefined
            ? [rpc_protocol_1.Pkt.CAPS, clientCaps]
            : [
                rpc_protocol_1.Pkt.CAPS,
                clientCaps,
                sessionId,
                serverGeneration,
                clientId,
            ]);
    }
    const zombies = new Set();
    const retire = (id) => { zombies.add(id); };
    let disposed = false;
    const transport = (0, transport_lifecycle_1.createTransportLifecycle)(true);
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
    let schemaKnown = false;
    let strictData = {};
    let strictWaiters = [];
    let _ready = null;
    let debug = false;
    let authToken = opts?.token ?? null;
    let authStatus = undefined;
    let authWaiters = [];
    let authPending = false;
    const drainAuth = (s) => { authPending = false; const w = authWaiters; authWaiters = []; for (const r of w)
        r(s); };
    const setAuthStatus = (s) => { authStatus = s; drainAuth(s); };
    function rethrowConsumerErrors(errors, message) {
        if (errors.length == 0)
            return;
        const error = errors.length == 1 ? errors[0] : new AggregateError(errors, message);
        setTimeout(function rethrowRpcConsumerErrors() { throw error; }, 0);
    }
    function handlePacket(incoming, batchErrors) {
        const msg = incoming;
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
                if (msg.length > 3) {
                    try {
                        req.fail(reviveErr(msg[3]));
                    }
                    catch (error) {
                        req.fail(error);
                    }
                }
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
                try {
                    cb(...cbArgs);
                }
                catch (error) {
                    if (batchErrors)
                        batchErrors.push(error);
                    else
                        rethrowConsumerErrors([error], 'RPC callback consumer failed');
                }
                break;
            }
            case rpc_protocol_1.Pkt.SHAPE: {
                if (!callbacks.has(msg[1]))
                    break;
                const shapeId = msg[2];
                const keys = msg[3];
                if (!Number.isSafeInteger(shapeId) || shapeId < 0)
                    break;
                if (!Array.isArray(keys) || !keys.every((k) => typeof k == 'string' && (0, rpc_limits_1.isSafeKey)(k)))
                    break;
                if (new Set(keys).size != keys.length)
                    break;
                let m = compactShapes.get(msg[1]);
                if (!m) {
                    m = new Map();
                    compactShapes.set(msg[1], m);
                }
                m.set(shapeId, [...keys]);
                break;
            }
            case rpc_protocol_1.Pkt.CBV: {
                const cb = callbacks.get(msg[1]);
                if (!cb)
                    break;
                const keys = compactShapes.get(msg[1])?.get(msg[2]);
                if (!keys)
                    break;
                const vals = msg[3];
                if (!Array.isArray(vals) || vals.length != keys.length)
                    break;
                let obj;
                try {
                    obj = {};
                    keys.forEach(function reconstructShapeValue(k, i) {
                        if (!(0, rpc_limits_1.isSafeKey)(k))
                            throw new Error('Unsafe compact shape key');
                        obj[k] = (0, rpc_walk_1.unpackResult)(vals[i], lim);
                    });
                }
                catch (e) {
                    if (debug)
                        console.log("[RPC CBV] dropped:", e);
                    break;
                }
                try {
                    cb(obj);
                }
                catch (error) {
                    if (batchErrors)
                        batchErrors.push(error);
                    else
                        rethrowConsumerErrors([error], 'RPC compact callback consumer failed');
                }
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
                const declared = typeof msg[1] == 'number' ? msg[1] : 0;
                const declaredSessionId = msg[2];
                const generation = msg[3];
                if (declaredSessionId == null && Number.isSafeInteger(generation)
                    && generation > 0) {
                    if (serverGeneration != generation) {
                        const replacingLiveServer = serverGeneration != undefined;
                        if (replacingLiveServer)
                            prepareServerGenerationReplacement();
                        beginTransportGeneration(generation);
                        if (replacingLiveServer)
                            requestSchema();
                    }
                    peerServerCaps = declared;
                    advertiseClientCaps();
                    break;
                }
                if (declaredSessionId == sessionId && generation == serverGeneration) {
                    peerServerCaps = declared;
                    finishServerGenerationRecovery();
                    break;
                }
                if (declaredSessionId == undefined && generation == undefined) {
                    peerServerCaps = declared;
                }
                break;
            }
            case rpc_protocol_1.Pkt.CB_BATCH: {
                if (!callbackBatchOn() || !Array.isArray(msg[1]))
                    break;
                const packets = msg[1];
                if (packets.length > 1024)
                    break;
                const valid = packets.every(function isCallbackPacket(packet) {
                    return Array.isArray(packet)
                        && (packet[0] == rpc_protocol_1.Pkt.CB || packet[0] == rpc_protocol_1.Pkt.SHAPE || packet[0] == rpc_protocol_1.Pkt.CBV);
                });
                if (!valid)
                    break;
                const callbackErrors = [];
                for (const packet of packets) {
                    try {
                        handlePacket(packet, callbackErrors);
                    }
                    catch (error) {
                        callbackErrors.push(error);
                    }
                }
                rethrowConsumerErrors(callbackErrors, 'Multiple RPC callback consumers failed');
                break;
            }
            case rpc_protocol_1.Pkt.MAP: {
                schemaKnown = true;
                if (msg[1]) {
                    for (const k of Object.keys(routeCache))
                        delete routeCache[k];
                    Object.assign(routeCache, msg[1]);
                }
                if (Array.isArray(msg[3])) {
                    declaredListens = new Set(msg[3]);
                    for (const sub of wireSubs.values()) {
                        sub.recoverable = declaredListens.has((0, rpc_path_1.rpcPathKey)(sub.path.slice(0, -1)));
                    }
                }
                if (msg[2]) {
                    for (const k of Object.keys(strictData))
                        delete strictData[k];
                    Object.assign(strictData, msg[2]);
                }
                const schemaWaiters = strictWaiters;
                strictWaiters = [];
                for (const resolve of schemaWaiters)
                    resolve(undefined);
                if (msg.length > 4)
                    setAuthStatus(msg[4]);
                advertiseClientCaps();
                finishServerGenerationRecovery();
                break;
            }
        }
    }
    socket.on(key, handlePacket);
    advertiseClientCaps();
    function emitApplicationPacket(packet) {
        if (serverGeneration != undefined) {
            const correlated = [...packet];
            while (correlated.length < 5)
                correlated.push(undefined);
            correlated[5] = sessionId;
            socket.emit(key, correlated);
            return;
        }
        socket.emit(key, packet);
    }
    function rollbackCallbacks(callbackIds) {
        while (callbackIds.length > 0) {
            const id = callbackIds.pop();
            callbacks.delete(id);
            pool.release(id);
        }
    }
    const sendPipe = (path, steps, wait) => {
        if (disposed)
            return wait ? Promise.reject(new Error('RPC client disposed')) : Promise.resolve();
        if (!transport.api.connected())
            return wait ? Promise.reject(new Error('RPC transport disconnected')) : Promise.resolve();
        if (wait && pending.size >= limit)
            return Promise.reject(new Error('RPC limit'));
        const cbIds = [];
        let cleanSteps;
        try {
            cleanSteps = steps.map(step => {
                if (step.type === 'call') {
                    return {
                        type: 'call',
                        args: (0, rpc_walk_1.pack)(step.args, pool, callbacks, cbIds),
                    };
                }
                return step;
            });
        }
        catch (error) {
            rollbackCallbacks(cbIds);
            return Promise.reject(error);
        }
        const ref = routeCache[(0, rpc_path_1.rpcPathKey)(path)] ?? path;
        if (!wait) {
            try {
                emitApplicationPacket([rpc_protocol_1.Pkt.PIPE, 0, ref, cleanSteps, false]);
                return Promise.resolve();
            }
            catch (error) {
                rollbackCallbacks(cbIds);
                return Promise.reject(error);
            }
        }
        let reqId;
        try {
            reqId = pool.next();
        }
        catch (error) {
            rollbackCallbacks(cbIds);
            return Promise.reject(error);
        }
        let record;
        function failPipePacket(error) {
            if (!record || pending.get(reqId) != record)
                return;
            pending.delete(reqId);
            pool.release(reqId);
            rollbackCallbacks(cbIds);
            record.fail(error);
        }
        const promise = new Promise(function trackPipe(resolve, reject) {
            record = { ok: resolve, fail: reject, cbs: cbIds };
            pending.set(reqId, record);
            if (debug)
                console.log('[RPC PIPE]', path.join('.'), 'steps=', steps.length, 'id=', reqId);
            try {
                emitApplicationPacket([rpc_protocol_1.Pkt.PIPE, reqId, ref, cleanSteps]);
            }
            catch (error) {
                failPipePacket(error);
            }
        });
        if (record)
            record.promise = promise;
        return promise;
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
    function createCallAttempt(path, args) {
        if (disposed) {
            return { promise: Promise.reject(new Error('RPC client disposed')), abandon: function abandonDisposed() { } };
        }
        if (!transport.api.connected()) {
            return { promise: Promise.reject(new Error('RPC transport disconnected')), abandon: function abandonOffline() { } };
        }
        if (pending.size >= limit) {
            return { promise: Promise.reject(new Error('RPC limit')), abandon: function abandonLimited() { } };
        }
        const cbIds = [];
        let clean;
        try {
            clean = (0, rpc_walk_1.pack)(args, pool, callbacks, cbIds);
        }
        catch (error) {
            rollbackCallbacks(cbIds);
            return {
                promise: Promise.reject(error),
                abandon: function abandonInvalidCall() { },
            };
        }
        const ref = routeCache[(0, rpc_path_1.rpcPathKey)(path)] ?? path;
        let reqId;
        try {
            reqId = pool.next();
        }
        catch (error) {
            rollbackCallbacks(cbIds);
            return {
                promise: Promise.reject(error),
                abandon: function abandonExhaustedCall() { },
            };
        }
        let record;
        const promise = new Promise(function trackCall(resolve, reject) {
            record = { ok: resolve, fail: reject, cbs: cbIds };
            pending.set(reqId, record);
        });
        record.promise = promise;
        if (debug)
            console.log('[RPC]', path.join('.'), 'id=', reqId);
        function failCallPacket(error) {
            if (pending.get(reqId) != record)
                return;
            pending.delete(reqId);
            pool.release(reqId);
            rollbackCallbacks(cbIds);
            record.fail(error);
        }
        try {
            emitApplicationPacket([rpc_protocol_1.Pkt.CALL, reqId, ref, clean]);
        }
        catch (error) {
            failCallPacket(error);
        }
        function abandon(reason) {
            if (pending.get(reqId) != record)
                return;
            pending.delete(reqId);
            for (const cbId of cbIds) {
                callbacks.delete(cbId);
                compactShapes.delete(cbId);
            }
            record.fail(new Error(reason));
        }
        return { promise, abandon };
    }
    function sendCallWire(path, args, wait) {
        if (disposed)
            return wait ? Promise.reject(new Error('RPC client disposed')) : Promise.resolve();
        if (!transport.api.connected())
            return wait ? Promise.reject(new Error('RPC transport disconnected')) : Promise.resolve();
        if (wait)
            return createCallAttempt(path, args).promise;
        const cbIds = [];
        try {
            const clean = (0, rpc_walk_1.pack)(args, pool, callbacks, cbIds);
            const ref = routeCache[(0, rpc_path_1.rpcPathKey)(path)] ?? path;
            emitApplicationPacket([rpc_protocol_1.Pkt.CALL, 0, ref, clean, false]);
            return Promise.resolve();
        }
        catch (error) {
            rollbackCallbacks(cbIds);
            return Promise.reject(error);
        }
    }
    const dedupe = opts?.dedupeListen ?? true;
    const wireSubs = new Map();
    let declaredListens = null;
    const OMIT_LISTEN_FUNCTION = Symbol('omit listen function');
    function sanitizeListenWireValue(value) {
        if (typeof value == 'function')
            return OMIT_LISTEN_FUNCTION;
        if (value == null || typeof value != 'object')
            return value;
        if (value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer || ArrayBuffer.isView(value))
            return value;
        if (value instanceof Map) {
            const clean = new Map();
            for (const [key, item] of value) {
                const cleanKey = sanitizeListenWireValue(key);
                const cleanItem = sanitizeListenWireValue(item);
                if (cleanKey != OMIT_LISTEN_FUNCTION && cleanItem != OMIT_LISTEN_FUNCTION)
                    clean.set(cleanKey, cleanItem);
            }
            return clean;
        }
        if (value instanceof Set) {
            const clean = new Set();
            for (const item of value) {
                const cleanItem = sanitizeListenWireValue(item);
                if (cleanItem != OMIT_LISTEN_FUNCTION)
                    clean.add(cleanItem);
            }
            return clean;
        }
        if (Array.isArray(value)) {
            return value.map(function sanitizeListenArrayItem(item) {
                const clean = sanitizeListenWireValue(item);
                return clean == OMIT_LISTEN_FUNCTION ? undefined : clean;
            });
        }
        const clean = {};
        for (const key of Object.keys(value)) {
            const item = sanitizeListenWireValue(value[key]);
            if (item != OMIT_LISTEN_FUNCTION)
                clean[key] = item;
        }
        return clean;
    }
    function normalizeListenWireArgs(path, args) {
        const method = path[path.length - 1];
        if ((method != 'on' && method != 'callback' && method != 'once') || typeof args[0] != 'function')
            return args;
        const nodeKey = (0, rpc_path_1.rpcPathKey)(path.slice(0, -1));
        if (method == 'once' && declaredListens == null)
            return args;
        if (declaredListens != null && !declaredListens.has(nodeKey))
            return args;
        const clean = [args[0]];
        for (let i = 1; i < args.length; i++) {
            const value = sanitizeListenWireValue(args[i]);
            clean.push(value == OMIT_LISTEN_FUNCTION ? undefined : value);
        }
        return clean;
    }
    function clearListenEventCaches() {
        for (const sub of wireSubs.values())
            sub.lastEvents.clear();
    }
    function finishLogical(sub) {
        if (sub.ended)
            return;
        sub.ended = true;
        sub.attempt = null;
        sub.lastEvents.clear();
        if (wireSubs.get(sub.key) == sub)
            wireSubs.delete(sub.key);
        for (const consumer of sub.consumers)
            consumer.resolve();
        sub.consumers.clear();
    }
    function finishAttempt(sub, attempt) {
        if (sub.attempt != attempt)
            return;
        sub.attempt = null;
        finishLogical(sub);
    }
    function startAttempt(sub) {
        if (disposed || sub.ended || sub.attempt || sub.consumers.size == 0 || !transport.api.connected())
            return;
        const attempt = { call: createCallAttempt(sub.path, sub.realArgs) };
        sub.attempt = attempt;
        attempt.call.promise.then(function physicalListenEnded() { finishAttempt(sub, attempt); }, function physicalListenFailed() { finishAttempt(sub, attempt); });
    }
    function stopLogical(sub, socketAlive = transport.api.connected()) {
        if (sub.ended)
            return;
        const attempt = sub.attempt;
        sub.attempt = null;
        if (wireSubs.get(sub.key) == sub)
            wireSubs.delete(sub.key);
        sub.ended = true;
        sub.lastEvents.clear();
        if (socketAlive && transport.api.connected()) {
            sendCallWire([...sub.path.slice(0, -1), 'removeCallback'], [], false);
        }
        else {
            attempt?.call.abandon('RPC Listen stopped while transport is disconnected');
        }
        for (const consumer of sub.consumers)
            consumer.resolve();
        sub.consumers.clear();
    }
    function subscribeShared(path, args) {
        if (disposed)
            return Promise.reject(new Error('RPC client disposed'));
        const listenPathKey = (0, rpc_path_1.rpcPathKey)(path.slice(0, -1));
        const skey = listenPathKey + '::' + JSON.stringify(args.map(listenKeyArg));
        let sub = wireSubs.get(skey);
        if (!sub) {
            let fnPos = 0;
            const created = {
                key: skey,
                path: [...path],
                realArgs: [],
                lastEvents: new Map(),
                consumers: new Set(),
                attempt: null,
                recoverable: declaredListens?.has(listenPathKey) == true,
                ended: false,
                stop: function stopCreated(socketAlive) { stopLogical(created, socketAlive); },
            };
            created.realArgs = args.map(function buildMultiplexer(arg) {
                if (typeof arg != 'function')
                    return arg;
                const index = fnPos++;
                return function multicastListenEvent(...event) {
                    created.lastEvents.set(index, event);
                    const errors = [];
                    for (const consumer of created.consumers) {
                        try {
                            consumer.fns[index]?.(...event);
                        }
                        catch (caught) {
                            errors.push(caught);
                        }
                    }
                    rethrowConsumerErrors(errors, 'Multiple RPC Listen consumers failed');
                };
            });
            wireSubs.set(skey, created);
            sub = created;
        }
        const consumer = {
            fns: args.filter(a => typeof a == 'function'),
            resolve: function resolveLater() { },
        };
        sub.consumers.add(consumer);
        if (args[1]?.current == true) {
            const current = sub.lastEvents.get(0);
            const currentConsumer = consumer.fns[0];
            if (current && currentConsumer) {
                try {
                    currentConsumer(...current);
                }
                catch (error) {
                    setTimeout(function rethrowCurrentConsumerError() { throw error; }, 0);
                }
            }
        }
        const promise = new Promise(function waitForListenEnd(resolve) { consumer.resolve = resolve; });
        startAttempt(sub);
        function unsubscribe() {
            if (!sub.consumers.delete(consumer))
                return;
            consumer.resolve();
            if (sub.consumers.size == 0)
                sub.stop();
        }
        return (0, rpc_off_1.makeOff)(promise, unsubscribe, { off: unsubscribe, unsubscribe, removeCallback: unsubscribe });
    }
    function abandonTransportGeneration(reason) {
        for (const sub of [...wireSubs.values()]) {
            sub.lastEvents.clear();
            const attempt = sub.attempt;
            sub.attempt = null;
            attempt?.call.abandon(reason);
            if (!sub.recoverable)
                finishLogical(sub);
        }
        const error = new Error(reason);
        for (const [id, request] of [...pending]) {
            pending.delete(id);
            for (const cbId of request.cbs) {
                callbacks.delete(cbId);
                compactShapes.delete(cbId);
            }
            request.promise?.catch(function consumeAbandonedTransportReject() { });
            request.fail(error);
        }
        callbacks.clear();
        compactShapes.clear();
    }
    function transportDisconnected(reason) {
        abandonTransportGeneration('RPC transport disconnected: ' + reason);
        schemaKnown = false;
        peerServerCaps = 0;
        beginTransportGeneration();
        serverGenerationRecoveryPending = false;
        _ready = null;
        declaredListens = declaredListens ? new Set() : null;
        for (const route of Object.keys(routeCache))
            delete routeCache[route];
        authStatus = undefined;
        authPending = false;
        const strict = strictWaiters;
        strictWaiters = [];
        for (const resolve of strict)
            resolve(undefined);
        const auths = authWaiters;
        authWaiters = [];
        for (const resolve of auths)
            resolve({ ok: false, reason });
    }
    function prepareServerGenerationReplacement() {
        const reason = 'RPC server generation changed';
        abandonTransportGeneration(reason);
        schemaKnown = false;
        peerServerCaps = 0;
        serverGenerationRecoveryPending = true;
        _ready = null;
        declaredListens = declaredListens ? new Set() : null;
        for (const route of Object.keys(routeCache))
            delete routeCache[route];
        authStatus = undefined;
        authPending = false;
        const auths = authWaiters;
        authWaiters = [];
        for (const resolve of auths)
            resolve({ ok: false, reason });
    }
    function restartRecoveredListens() {
        serverGenerationRecoveryPending = false;
        for (const sub of [...wireSubs.values()]) {
            if (!sub.recoverable) {
                finishLogical(sub);
                continue;
            }
            startAttempt(sub);
        }
    }
    function finishServerGenerationRecovery() {
        if (!serverGenerationRecoveryPending || !schemaKnown)
            return;
        restartRecoveredListens();
    }
    function transportConnected() {
        if (!schemaKnown && strictWaiters.length > 0)
            requestSchema();
        for (const sub of [...wireSubs.values()]) {
            if (sub.recoverable)
                startAttempt(sub);
            else
                finishLogical(sub);
        }
    }
    transport.api.onDisconnect(transportDisconnected);
    transport.api.onConnect(transportConnected);
    const sendCall = (path, args, wait) => {
        const last = path[path.length - 1];
        const wireArgs = normalizeListenWireArgs(path, args);
        if (dedupe && wait && path.length > 1 && (last == "callback" || last == "on") && wireArgs.some(a => typeof a == "function")) {
            if (!transport.api.connected())
                return sendCallWire(path, wireArgs, wait);
            const isListen = declaredListens ? declaredListens.has((0, rpc_path_1.rpcPathKey)(path.slice(0, -1))) : true;
            if (isListen)
                return subscribeShared(path, wireArgs);
        }
        return sendCallWire(path, wireArgs, wait);
    };
    function lookupRpcMemberState(path, member) {
        if (!schemaKnown)
            return undefined;
        const memberPath = [...path, member];
        const memberKey = (0, rpc_path_1.rpcPathKey)(memberPath);
        if (Object.prototype.hasOwnProperty.call(routeCache, memberKey))
            return true;
        if (declaredListens?.has(memberKey))
            return true;
        const target = resolveStrictTarget(memberPath);
        if (target == 'dynamic')
            return undefined;
        return target != undefined && target != null && target != 'null';
    }
    function createRpcMemberLookup(path) {
        const lookup = function lookupRpcMember(member) { return lookupRpcMemberState(path, member); };
        Object.defineProperty(lookup, transport_lifecycle_1.RPC_MEMBER_LOOKUP, { value: true });
        return lookup;
    }
    const proxyCaches = {
        func: createPathProxyCache(),
        space: createPathProxyCache(),
        strict: createPathProxyCache(),
    };
    function buildProxy(path, wait, cache) {
        const cached = cache.get(path);
        if (cached)
            return cached;
        const proxy = new Proxy(function () { }, {
            get(_, p) {
                if (p == transport_lifecycle_1.RPC_MEMBER_LOOKUP)
                    return createRpcMemberLookup(path);
                if (p == transport_lifecycle_1.RPC_SCHEMA_READY)
                    return waitForRpcSchema;
                if (p == transport_lifecycle_1.RPC_TRANSPORT_LIFECYCLE)
                    return transport.api;
                if ((0, rpc_result_limits_1.rpcResultLimitsProperty)(p))
                    return lim;
                if (p == 'then' || p == 'catch' || p == Symbol.toPrimitive)
                    return undefined;
                return buildProxy([...path, String(p)], wait, cache);
            },
            apply(_, __, args) {
                const [fp, fa] = (0, rpc_walk_1.resolveCA)(path, args);
                return sendCall(fp, fa, wait);
            },
        });
        return cache.set(path, proxy);
    }
    function resolveStrictTarget(path) {
        let target = strictData;
        for (const segment of path) {
            if (target == 'dynamic')
                return target;
            target = target?.[segment];
            if (target == null || target == 'null')
                return undefined;
        }
        return target;
    }
    function buildStrict(path, wait) {
        const initialTarget = resolveStrictTarget(path);
        if (initialTarget == null || initialTarget == 'null')
            return undefined;
        const cached = proxyCaches.strict.get(path);
        if (cached)
            return cached;
        const target = () => { };
        const proxy = new Proxy(target, {
            has: (_, p) => {
                const target = resolveStrictTarget(path);
                return target == 'dynamic' || (target?.[String(p)] != 'null' && target?.[String(p)] != undefined);
            },
            ownKeys: () => {
                const target = resolveStrictTarget(path);
                return target && typeof target == 'object' ? Object.keys(target) : [];
            },
            getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
            getPrototypeOf: () => {
                const target = resolveStrictTarget(path);
                return target == 'func' || target == 'dynamic' ? Function.prototype : target ? null : Object.prototype;
            },
            get(_, p) {
                if (p == transport_lifecycle_1.RPC_MEMBER_LOOKUP)
                    return createRpcMemberLookup(path);
                if (p == transport_lifecycle_1.RPC_SCHEMA_READY)
                    return waitForRpcSchema;
                if (p == transport_lifecycle_1.RPC_TRANSPORT_LIFECYCLE)
                    return transport.api;
                if ((0, rpc_result_limits_1.rpcResultLimitsProperty)(p))
                    return lim;
                if (p == 'then' || p == 'catch' || p == Symbol.toPrimitive)
                    return undefined;
                const target = resolveStrictTarget(path);
                if (p == 'call' && target == 'func') {
                    return function strictCall(_, ...args) { return sendCall(path, args, wait); };
                }
                if (target == 'func')
                    return undefined;
                if (target != 'dynamic') {
                    const child = target?.[String(p)];
                    if (child == 'null' || child == undefined)
                        return undefined;
                }
                return buildStrict([...path, String(p)], wait);
            },
            apply(_, __, args) {
                const target = resolveStrictTarget(path);
                if (target != 'func' && target != 'dynamic') {
                    throw new TypeError('RPC strict path is not callable');
                }
                const [fp, fa] = (0, rpc_walk_1.resolveCA)(path, args);
                return sendCall(fp, fa, wait);
            },
        });
        return proxyCaches.strict.set(path, proxy);
    }
    const releaseCbs = (fn) => {
        callbacks.forEach((cb, id) => { if (cb == fn) {
            callbacks.delete(id);
            retire(id);
        } });
    };
    function abortAll(reason) {
        const err = { error: { name: 'RPC_ABORT', message: reason } };
        pending.forEach(function abortPending(p, id) {
            retire(id);
            for (const cbId of p.cbs)
                compactShapes.delete(cbId);
            p.fail(err);
        });
        pending.clear();
        callbacks.forEach(function abortCallback(_, id) { retire(id); });
        callbacks.clear();
        compactShapes.clear();
    }
    function drainWireSubs(socketAlive) {
        const subs = [...wireSubs.values()];
        wireSubs.clear();
        for (const sub of subs)
            sub.stop(socketAlive);
    }
    function dispose(reason = 'RPC client disposed', opts) {
        if (disposed)
            return;
        const socketAlive = opts?.socketAlive ?? true;
        drainWireSubs(socketAlive);
        abortAll(reason);
        disposed = true;
        transport.control.close(reason);
        authPending = false;
        const sw = strictWaiters;
        strictWaiters = [];
        for (const resolve of sw)
            resolve(undefined);
        const aw = authWaiters;
        authWaiters = [];
        for (const resolve of aw)
            resolve({ ok: false, reason });
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
    const func = buildProxy([], true, proxyCaches.func);
    const space = buildProxy([], false, proxyCaches.space);
    const strict = buildStrict([], true);
    const pipe = buildPipeProxy([], [], true);
    const pipeStrict = buildPipeProxy([], [], true);
    function ready() {
        return _ready ? _ready : _ready = init();
    }
    function requestSchema() {
        if (authToken != null) {
            authPending = true;
            socket.emit(key, [rpc_protocol_1.Pkt.HELLO, authToken]);
        }
        socket.emit(key, rpc_protocol_1.Pkt.STRICT);
    }
    async function init(obj) {
        if (obj) {
            strictData = obj;
            schemaKnown = true;
            return;
        }
        if (!schemaKnown || (authToken != null && authStatus === undefined)) {
            const waitForMap = new Promise(function registerSchemaWaiter(resolve) {
                strictWaiters.push(function resolveSchemaWaiter() { resolve(); });
            });
            requestSchema();
            await waitForMap;
        }
    }
    async function waitForRpcSchema() {
        while (!schemaKnown) {
            if (disposed)
                throw new Error('RPC client disposed');
            await ready();
        }
    }
    Object.defineProperty(waitForRpcSchema, transport_lifecycle_1.RPC_SCHEMA_READY, { value: true });
    function reauth(token) {
        if (disposed)
            return Promise.resolve({ ok: false, reason: 'RPC client disposed' });
        if (!transport.api.connected())
            return Promise.resolve({ ok: false, reason: 'RPC transport disconnected' });
        authToken = token;
        authPending = true;
        clearListenEventCaches();
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
        space,
        all: func,
        strict,
        api,
        [transport_lifecycle_1.RPC_TRANSPORT_CONTROL]: transport.control,
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
