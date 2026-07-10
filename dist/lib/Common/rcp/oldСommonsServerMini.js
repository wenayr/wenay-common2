"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreatAPIFacadeClient = exports.CreatAPIFacadeServer = void 0;
exports.promiseServer = promiseServer;
exports.wsWrapper = wsWrapper;
exports.createClientProxy = createClientProxy;
exports.createAPIFacadeClient = createAPIFacadeClient;
exports.createAPIFacadeServer = createAPIFacadeServer;
function createSimpleRateLimitHook(options) {
    let count = 0;
    let resetAt = 0;
    return () => {
        const now = Date.now();
        if (now >= resetAt) {
            resetAt = now + options.intervalMs;
            count = 0;
        }
        count += 1;
        if (count > options.max) {
            throw new Error("Rate limit exceeded");
        }
        return true;
    };
}
function promiseServer(soc, target) {
    const serializeError = (err) => {
        if (err instanceof Error) {
            return { name: err.name, message: err.message, stack: err.stack };
        }
        return err;
    };
    const hooks = soc.hooks;
    soc.api({ onMessage: async (msg) => {
            if (!msg || typeof msg !== "object" || !msg.data || !Array.isArray(msg.data.key) || !Array.isArray(msg.data.request)) {
                const err = serializeError(new Error("Invalid request payload"));
                try {
                    await hooks?.onInvalid?.({ reason: "invalid_payload", key: msg?.data?.key, request: msg?.data?.request, error: err, msg });
                }
                catch (hookErr) {
                    console.error({ error: serializeError(hookErr), where: "onInvalid" });
                }
                soc.sendMessage({ mapId: msg?.mapId ?? -1, error: { error: err, key: msg?.data?.key, arguments: msg?.data?.request } });
                console.error({ error: err, key: msg?.data?.key, arguments: msg?.data?.request });
                return;
            }
            const { key, request } = msg.data;
            let curr = target, fnName = "";
            try {
                for (const k of key) {
                    fnName = k;
                    if (typeof curr[fnName] === "function")
                        break;
                    curr = curr[fnName];
                }
            }
            catch (e) {
                const err = serializeError(e);
                try {
                    await hooks?.onInvalid?.({ reason: "resolve_error", key, request, error: err, msg });
                }
                catch (hookErr) {
                    console.error({ error: serializeError(hookErr), where: "onInvalid" });
                }
                soc.sendMessage({ mapId: msg.mapId, error: { error: err, key, arguments: request } });
                console.error({ error: err, key, arguments: request });
                return;
            }
            if (typeof curr[fnName] === "function") {
                const fn = curr[fnName];
                if (hooks?.onRequest) {
                    try {
                        const allowed = await hooks.onRequest({ key, request, fnName, fn, msg });
                        if (allowed === false) {
                            const err = serializeError(new Error("Request rejected by hook"));
                            soc.sendMessage({ mapId: msg.mapId, error: { error: err, key, arguments: request } });
                            console.error({ error: err, key, arguments: request });
                            return;
                        }
                    }
                    catch (hookErr) {
                        const err = serializeError(hookErr);
                        soc.sendMessage({ mapId: msg.mapId, error: { error: err, key, arguments: request } });
                        console.error({ error: err, key, arguments: request });
                        return;
                    }
                }
                const { callbacksId } = msg;
                if (callbacksId && Array.isArray(callbacksId)) {
                    const cbArr = callbacksId.map(id => (data) => {
                        try {
                            soc.sendMessage({ mapId: id, data: data ?? undefined });
                        }
                        catch (err) {
                            console.log("Ошибка callback", err);
                        }
                    });
                    let idx = 0;
                    request.forEach((item, i) => { if (item === "___FUNC")
                        request[i] = cbArr[idx++]; });
                }
                try {
                    const res = await curr[fnName](...request);
                    if (msg.wait !== false)
                        soc.sendMessage({ mapId: msg.mapId, data: res ?? undefined });
                }
                catch (e) {
                    console.log(fnName, request, key);
                    const err = serializeError(e);
                    soc.sendMessage({ mapId: msg.mapId, error: { error: err, key, arguments: request } });
                    console.error({ error: err, key, arguments: request });
                }
            }
            else {
                try {
                    await hooks?.onInvalid?.({ reason: "not_function", key, request, msg });
                }
                catch (hookErr) {
                    console.error({ error: serializeError(hookErr), where: "onInvalid" });
                }
                soc.sendMessage({ mapId: msg.mapId, error: JSON.stringify({ data: "это не функция", key, arguments: request }) });
                console.error({ data: "это не функция", key, arguments: request });
            }
        } });
}
function wsWrapper(soc) {
    const max = soc.limit, sendMsg = soc.sendMessage;
    const pool = (() => { const free = []; let tot = 0, pos = 0; return { log: () => console.log({ free, tot, pos }), next: () => pos > 0 ? free[--pos] : ++tot, release: (id) => { free[pos++] = id; } }; })();
    const promises = new Map(), cbsMap = new Map();
    const forceRejectAll = (reason) => {
        promises.forEach((p, id) => {
            p.reject({
                error: { name: "RPC_ABORT", message: reason },
                mapId: id
            });
            pool.release(id);
        });
        promises.clear();
        cbsMap.clear();
    };
    soc.api({ onMessage: (msg) => {
            const id = msg.mapId;
            if (promises.has(id)) {
                const p = promises.get(id);
                promises.delete(id);
                pool.release(id);
                msg.error ? p.reject(msg.error) : p.resolve(msg.data);
            }
            else if (cbsMap.has(id)) {
                const cb = cbsMap.get(id);
                if (msg.data === "___STOP") {
                    cbsMap.delete(id);
                    pool.release(id);
                    return;
                }
                cb(msg.data);
            }
            else
                console.error("Неожиданный ответ", msg);
        }
    });
    let debug = false;
    const api = {
        log: (s) => { debug = s; },
        promiseTotal: () => promises.size,
        callbackTotal: () => cbsMap.size,
        promiseDeleteAll: (rej = true) => {
            const arr = [...promises.values()], keys = [...promises.keys()];
            promises.clear();
            keys.forEach(k => pool.release(k));
            arr.forEach(p => (rej ? p.reject("promiseDeleteAll") : p.resolve(undefined)));
        },
        callbackDeleteAll: () => { const keys = [...cbsMap.keys()]; cbsMap.clear(); keys.forEach(k => pool.release(k)); },
        callbackDelete: (fn) => { cbsMap.forEach((cb, key) => { if (cb === fn) {
            cbsMap.delete(key);
            pool.release(key);
        } }); }
    };
    return {
        abortAll: forceRejectAll,
        api,
        send: (data, wait, cbs) => new Promise((resolve, reject) => {
            const msg = { mapId: pool.next(), data, wait, callbacksId: [] };
            for (const fn of cbs ?? []) {
                const id = pool.next();
                msg.callbacksId.push(id);
                if (debug)
                    console.log("Ключ callback", id, msg);
                cbsMap.set(id, fn);
            }
            if (wait !== false)
                promises.set(msg.mapId, { resolve, reject });
            if (debug) {
                pool.log();
                console.log("Ключ сокета", msg.mapId, msg);
            }
            if (max && cbsMap.size >= max)
                console.log("callbacksMap.size =", cbsMap.size);
            if (max && promises.size >= max)
                console.log("promises.size =", promises.size);
            sendMsg(msg);
        })
    };
}
function createClientProxy(soc2, wait) {
    const chain = (path) => new Proxy(() => { }, {
        get: (_, p) => { path.push(String(p)); return chain(path); },
        apply: (_, __, args) => {
            const fns = [];
            args.forEach((arg, i) => { if (typeof arg === "function") {
                fns.push(arg);
                args[i] = "___FUNC";
            } });
            return soc2.send({ key: path, request: args }, wait, fns);
        }
    });
    return new Proxy({}, { get: (_, p) => chain([String(p)]) });
}
function createClientProxyStrict(soc2, getTarget, wait) {
    const chain = (path) => {
        let tgt = getTarget();
        for (const a of path) {
            tgt = tgt?.[a];
        }
        if (!tgt || tgt === "null" || tgt === "unknown")
            return undefined;
        const baseObject = tgt === "func" ? function () { } : {};
        const r = new Proxy(baseObject, {
            has: (_, p) => {
                console.log(_, p, "has", path);
                return tgt?.[p] !== "null";
            },
            getPrototypeOf(_) {
                if (!tgt || tgt === "null")
                    return Object.prototype;
                if (tgt == "func")
                    return Function.prototype;
                return null;
            },
            ownKeys: typeof tgt != "object" ? undefined : (target) => Object.keys(tgt),
            getOwnPropertyDescriptor: typeof tgt != "object" ? undefined : (target, prop) => ({ enumerable: true, configurable: true }),
            get: (_, p) => {
                if (p == "call" && tgt == "func") {
                    return (_, ...args) => {
                        const fns = [];
                        args.forEach((arg, i) => { if (typeof arg === "function") {
                            fns.push(arg);
                            args[i] = "___FUNC";
                        } });
                        return soc2.send({ key: path, request: args }, wait, fns);
                    };
                }
                return tgt?.[p] === "null" ? undefined : chain([...path, String(p)]);
            },
            apply: (_, __, args) => {
                console.log(path);
                if (path.at(-1) === "call") {
                    path.length--;
                    args.splice(0, 1);
                }
                const fns = [];
                args.forEach((arg, i) => { if (typeof arg === "function") {
                    fns.push(arg);
                    args[i] = "___FUNC";
                } });
                return soc2.send({ key: path, request: args }, wait, fns);
            }
        });
        return r;
    };
    return new Proxy({}, {
        has: (_, p) => getTarget()?.[p] !== "null",
        get: (_, p) => (getTarget() && getTarget()[p] === "null" ? undefined : chain([String(p)]))
    });
}
function createAPIFacadeClient({ socket: sock, socketKey: key, limit }) {
    let strictData = {}, resolveStrict;
    const wsWrap = wsWrapper({
        sendMessage: (msg) => sock.emit(key, msg),
        api: ({ onMessage }) => {
            sock.on(key, (d) => {
                if (typeof d === "object" && d?.STRICTLY) {
                    Object.keys(strictData).forEach(k => delete strictData[k]);
                    Object.assign(strictData, d.STRICTLY);
                    resolveStrict?.(undefined);
                }
                else
                    onMessage(d);
            });
        },
        limit,
    });
    const func = createClientProxy(wsWrap);
    const strict = createClientProxyStrict(wsWrap, () => strictData);
    const space = createClientProxy(wsWrap, false);
    return { api: wsWrap.api, func, space, all: func, strict, infoStrict: () => strictData, async strictInit(obj) {
            if (obj)
                strictData = obj;
            else {
                sock.emit(key, "___STRICTLY");
                return new Promise(resolve => { resolveStrict = resolve; });
            }
        } };
}
function createAPIFacadeServer({ socket: sock, object: targetObj, socketKey: key, debug = false }) {
    function serialize(obj) {
        return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === "object" && v != null ? serialize(v) : typeof v === "function" ? "func" : !v ? "null" : "unknown"]));
    }
    const ser = serialize(targetObj);
    promiseServer({ sendMessage: (msg) => sock.emit(key, msg), api: ({ onMessage }) => {
            sock.on(key, (d) => {
                if (debug)
                    console.log(typeof d === "object" ? JSON.stringify(d) : d);
                if (d === "___STRICTLY")
                    sock.emit(key, { STRICTLY: ser });
                else
                    onMessage(d);
            });
        } }, targetObj);
}
exports.CreatAPIFacadeServer = createAPIFacadeServer;
exports.CreatAPIFacadeClient = createAPIFacadeClient;
