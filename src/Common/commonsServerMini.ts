type Socket = { emit: (e: string, p: any) => any; on: (e: string, cb: (d: any) => any) => any };
export type RequestScreener<T> = { key: string[]; callbacksId?: string[]; request: any[] };
type Obj = { [k: string]: any };
type SocketData<T> = (
    { data: T; error?: undefined } | { error: any; data?: undefined }
    ) & { mapId: number; wait?: boolean; callbacksId?: number[] };
type PromiseServerHooks<T> = {
    onRequest?: (ctx: { key: string[]; request: any[]; fnName: string; fn: Func; msg: SocketData<RequestScreener<T>> }) => boolean | Promise<boolean>;
    onInvalid?: (ctx: { reason: "invalid_payload" | "not_function" | "resolve_error" | "rate_limit"; key?: any; request?: any; error?: any; msg: SocketData<RequestScreener<T>> }) => void | Promise<void>;
};
function createSimpleRateLimitHook(options: { max: number; intervalMs: number }): PromiseServerHooks<any>["onRequest"] {
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
type ScreenerSoc<T> = { sendMessage: (d: T) => void; api: (h: { onMessage: (m: T) => void | Promise<void> }) => void };

export function promiseServer<T extends Obj>(
    soc: ScreenerSoc<SocketData<RequestScreener<T>>> & { hooks?: PromiseServerHooks<T> },
    target: T,

) {
    const serializeError = (err: any) => {
        if (err instanceof Error) {
            return { name: err.name, message: err.message, stack: err.stack };
        }
        return err;
    };
    const hooks = soc.hooks;
    soc.api({ onMessage: async (msg) => {
            if (!msg || typeof msg !== "object" || !msg.data || !Array.isArray(msg.data.key) || !Array.isArray(msg.data.request)) {
                const err = serializeError(new Error("Invalid request payload"));
                try { await hooks?.onInvalid?.({ reason: "invalid_payload", key: msg?.data?.key, request: msg?.data?.request, error: err, msg }); }
                catch (hookErr) { console.error({ error: serializeError(hookErr), where: "onInvalid" }); }
                soc.sendMessage({ mapId: msg?.mapId ?? -1, error: { error: err, key: msg?.data?.key, arguments: msg?.data?.request } });
                console.error({ error: err, key: msg?.data?.key, arguments: msg?.data?.request });
                return;
            }
            const { key, request } = msg.data!;
            let curr = target, fnName = "";
            try {
                for (const k of key) { fnName = k; if (typeof curr[fnName] === "function") break; curr = curr[fnName]; }
            } catch (e) {
                const err = serializeError(e);
                try { await hooks?.onInvalid?.({ reason: "resolve_error", key, request, error: err, msg }); }
                catch (hookErr) { console.error({ error: serializeError(hookErr), where: "onInvalid" }); }
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
                    } catch (hookErr) {
                        const err = serializeError(hookErr);
                        soc.sendMessage({ mapId: msg.mapId, error: { error: err, key, arguments: request } });
                        console.error({ error: err, key, arguments: request });
                        return;
                    }
                }
                const { callbacksId } = msg;
                if (callbacksId && Array.isArray(callbacksId)) {
                    const cbArr = callbacksId.map(id => (data: any) => {
                        try { soc.sendMessage({ mapId: id, data: data ?? undefined }); }
                        catch (err) { console.log("Ошибка callback", err); }
                    });
                    let idx = 0; request.forEach((item, i) => { if (item === "___FUNC") request[i] = cbArr[idx++]; });
                }
                try {
                    const res = await curr[fnName](...request);
                    if (msg.wait !== false) soc.sendMessage({ mapId: msg.mapId, data: res ?? undefined });
                } catch (e) {
                    console.log(fnName, request, key);
                    const err = serializeError(e);
                    soc.sendMessage({ mapId: msg.mapId, error: { error: err, key, arguments: request } });
                    console.error({ error: err, key, arguments: request });
                }
            } else {
                try { await hooks?.onInvalid?.({ reason: "not_function", key, request, msg }); }
                catch (hookErr) { console.error({ error: serializeError(hookErr), where: "onInvalid" }); }
                soc.sendMessage({ mapId: msg.mapId, error: JSON.stringify({ data: "это не функция", key, arguments: request }) });
                console.error({ data: "это не функция", key, arguments: request });
            }
        }});
}

type Func = (a: any) => any;
export type ScreenerSoc2<T> = { send: (d: RequestScreener<T>, wait?: boolean, cbs?: Func[]) => Promise<any>; api: ScreenerSocApi<T>, abortAll: (textError: string) => void };
export type ScreenerSocApi<T> = {
    log: (s: boolean) => void; promiseTotal: () => number; callbackTotal: () => number;
    promiseDeleteAll: (rej: boolean) => void; callbackDeleteAll: () => void; callbackDelete: (fn: Func) => void;
};
type UnwrapPromise<T> = T extends Promise<infer R> ? R : T;
export type MethodToPromise<T extends object> = {
    [P in keyof T]: T[P] extends (...args: infer Z) => infer X ? (...args: Z) => Promise<UnwrapPromise<X>> : T[P] extends object ? MethodToPromise<T[P]> : never;
};
export type MethodToPromiseStrict<T extends object> = {
    [P in keyof T]: T[P] extends (...args: infer Z) => infer X ? (...args: Z) => Promise<UnwrapPromise<X>> : T[P] extends object ? MethodToPromiseStrict<T[P]> : T[P];
};

export function wsWrapper<T>(soc: ScreenerSoc<SocketData<RequestScreener<T>>> & { limit?: number }): ScreenerSoc2<T> {
    const max = soc.limit, sendMsg = soc.sendMessage;
    const pool = (() => { const free: number[] = []; let tot = 0, pos = 0; return { log: () => console.log({ free, tot, pos }), next: () => pos > 0 ? free[--pos] : ++tot, release: (id: number) => { free[pos++] = id; } }; })();
    const promises = new Map<number, { resolve: Func; reject: Func }>(), cbsMap = new Map<number, Func>();
    const forceRejectAll = (reason: string) => {
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

            if (promises.has(id)) { const p = promises.get(id)!; promises.delete(id); pool.release(id); msg.error ? p.reject(msg.error) : p.resolve(msg.data); }
            else if (cbsMap.has(id)) {
                const cb = cbsMap.get(id)!;
                // @ts-ignore
                if (msg.data === "___STOP") { cbsMap.delete(id); pool.release(id); }
                cb(msg.data);
            } else console.error("Неожиданный ответ", msg);
        }
    });
    let debug = false;
    const api: ScreenerSocApi<T> = {
        log: (s: boolean) => { debug = s; },
        promiseTotal: () => promises.size,
        callbackTotal: () => cbsMap.size,
        promiseDeleteAll: (rej = true) => {
            const arr = [...promises.values()], keys = [...promises.keys()];
            promises.clear(); keys.forEach(k => pool.release(k));
            arr.forEach(p => (rej ? p.reject("promiseDeleteAll") : p.resolve(undefined)));
        },
        callbackDeleteAll: () => { const keys = [...cbsMap.keys()]; cbsMap.clear(); keys.forEach(k => pool.release(k)); },
        callbackDelete: (fn: Func) => { cbsMap.forEach((cb, key) => { if (cb === fn) { cbsMap.delete(key); pool.release(key); } }); }
    };
    return {

        abortAll: forceRejectAll,
        api,
        send: (data, wait?: boolean, cbs?: Func[]) => new Promise((resolve, reject) => {
            const msg: SocketData<RequestScreener<T>> = { mapId: pool.next(), data, wait, callbacksId: [] };
            for (const fn of cbs ?? []) { const id = pool.next(); msg.callbacksId!.push(id); if (debug) console.log("Ключ callback", id, msg); cbsMap.set(id, fn); }
            if (wait !== false) promises.set(msg.mapId, { resolve, reject });
            if (debug) { pool.log(); console.log("Ключ сокета", msg.mapId, msg); }
            if (max && cbsMap.size >= max) console.log("callbacksMap.size =", cbsMap.size);
            if (max && promises.size >= max) console.log("promises.size =", promises.size);
            sendMsg(msg);
        }) };
}

export function createClientProxy<T extends object>(soc2: ScreenerSoc2<T>, wait?: boolean) {
    const chain = (path: string[]): any => new Proxy(() => {}, {
        get: (_, p: string | symbol) => { path.push(String(p)); return chain(path); },
        apply: (_, __, args: any[]) => {
            const fns: Func[] = [];
            args.forEach((arg, i) => { if (typeof arg === "function") { fns.push(arg); args[i] = "___FUNC"; } });
            return soc2.send({ key: path, request: args }, wait, fns);
        }
    });
    return new Proxy({}, { get: (_, p: string | symbol) => chain([String(p)]) }) as unknown as MethodToPromise<T>;
}

function createClientProxyStrict<T extends object>(soc2: ScreenerSoc2<T>, getTarget: () => any, wait?: boolean) {

    const chain = (path: string[]): any => {
        let tgt = getTarget();
        for (const a of path) { tgt = tgt?.[a]}
        if (!tgt || tgt === "null" || tgt === "unknown") return undefined// Object.defineProperty({}, 'isNull', { value: true });
        const baseObject = tgt === "func" ? function(){} : {};
        const r = new Proxy(baseObject, {
            has: (_, p: string | symbol) => {
                console.log(_,p,"has",path)
                return tgt?.[p] !== "null";
            },
            getPrototypeOf(_){
                if (!tgt || tgt === "null") return Object.prototype
                if (tgt == "func") return Function.prototype
                return null
            },
            ownKeys: typeof tgt != "object" ? undefined : (target) => Object.keys(tgt),
            getOwnPropertyDescriptor: typeof tgt != "object" ? undefined : (target: any, prop: string | symbol) => ({enumerable: true, configurable: true}),
            get: (_, p: string | symbol) => {
                if (p == "call" && tgt == "func") {
                    // Первый параметр будет добавлен как this его надо удалить
                    return (_: any, ...args: any[]) => {
                        const fns: Func[] = [];
                        args.forEach((arg, i) => { if (typeof arg === "function") { fns.push(arg); args[i] = "___FUNC"; } });
                        return soc2.send({ key: path, request: args }, wait, fns);
                    }
                }
                return tgt?.[p] === "null" ? undefined : chain([...path, String(p)]);
            },
            // скорее всего больше не нужно прокси на apply
            apply: (_, __, args: any[]) => {
                console.log(path)
                if (path.at(-1) === "call") {
                    // Первый параметр будет добавлен как this его надо удалить
                    path.length--; args.splice(0, 1);
                }
                const fns: Func[] = [];
                args.forEach((arg, i) => { if (typeof arg === "function") { fns.push(arg); args[i] = "___FUNC"; } });
                return soc2.send({ key: path, request: args }, wait, fns);
            }
        });
        return r;
    }
    return new Proxy({}, {
        has: (_, p: string | symbol) => getTarget()?.[p] !== "null",
        get: (_, p: string | symbol) => (getTarget() && getTarget()[p] === "null" ? undefined : chain([String(p)]))
    }) as unknown as MethodToPromise<T>;
}

export type NoVoid<T> = { [P in Exclude<keyof T, { [K in keyof T]: T[K] extends (...args: any[]) => any ? ReturnType<T[K]> extends void ? K : never : never; }[keyof T]>]: T[P] };
export type OnlyVoid<T> = { [P in Exclude<keyof T, { [K in keyof T]: T[K] extends (...args: any[]) => any ? ReturnType<T[K]> extends void ? never : K : never; }[keyof T]>]: T[P] };

export function createAPIFacadeClient<T extends object>({ socket: sock, socketKey: key, limit }: { socket: Socket; socketKey: string; limit?: number }) {
    let strictData: any = {}, resolveStrict: (v: unknown) => void;
    const wsWrap = wsWrapper<any>({
        sendMessage: (msg) => sock.emit(key, msg),
        api: ({ onMessage }) => { sock.on(key, (d: any) => {
            if (typeof d === "object" && d?.STRICTLY) { Object.keys(strictData).forEach(k => delete strictData[k]); Object.assign(strictData, d.STRICTLY); resolveStrict?.(undefined); }
            else onMessage(d);
        }); },
        limit,
    });
    const func = createClientProxy<NoVoid<T>>(wsWrap);
    const strict = createClientProxyStrict(wsWrap, () => strictData) as MethodToPromiseStrict<T>;
    const space = createClientProxy<OnlyVoid<T>>(wsWrap, false);
    return { api: wsWrap.api, func, space, all: func as MethodToPromise<T>, strict, infoStrict: () => strictData, async strictInit(obj?: object) {
            if (obj) strictData = obj; else { sock.emit(key, "___STRICTLY"); return new Promise(resolve => { resolveStrict = resolve; }); }
        } };
}

export function createAPIFacadeServer<T extends object>({ socket: sock, object: targetObj, socketKey: key, debug = false }: { socket: Socket; object: T; socketKey: string; debug?: boolean }) {
    function serialize(obj: any): any {
        return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === "object" && v != null ? serialize(v) : typeof v === "function" ? "func" : !v ? "null" : "unknown"]));
    }
    const ser = serialize(targetObj);
    promiseServer({ sendMessage: (msg) => sock.emit(key, msg), api: ({ onMessage }) => { sock.on(key, (d: any) => {
            if (debug) console.log(typeof d === "object" ? JSON.stringify(d) : d);
            if (d === "___STRICTLY") sock.emit(key, { STRICTLY: ser });
            else onMessage(d);
        }); } }, targetObj);
}

export const CreatAPIFacadeServer = createAPIFacadeServer;
export const CreatAPIFacadeClient = createAPIFacadeClient;
