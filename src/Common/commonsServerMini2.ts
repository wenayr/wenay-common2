// ==========================================
// commonsServerMini2.ts — Optimized RPC v7.2
// ==========================================

import {createIdPool, idPool} from "./mini";
import {isProxy} from "./isProxy";

const Pkt = { CALL: 0, RESP: 1, CB: 2, MAP: 3, STRICT: 4, CB_END: 5 } as const;
const FN_MARKER = "$_f";

const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isSafeKey = (k: string) => !BANNED_KEYS.has(k);
const hasOwn = (obj: any, k: string) => Object.prototype.hasOwnProperty.call(obj, k);

// ---- Payload Safety Limits ----
export type RpcLimits = {
    /** Макс. глубина вложенности объекта (default: 32) */
    maxDepth?: number;
    /** Макс. кол-во ключей в одном объекте (default: 1000) */
    maxKeys?: number;
    /** Макс. кол-во аргументов вызова (default: 64) */
    maxArgs?: number;
    /** Макс. длина любого вложенного массива (default: 10000) */
    maxArrayLen?: number;
    /** Макс. длина строки в символах (default: 1_000_000) */
    maxStringLen?: number;
    /** Макс. кол-во callback-маркеров в одном вызове (default: 100) */
    maxCallbacks?: number;
    /** Макс. длина ref path — string[] (default: 16) */
    maxPathLen?: number;
};

const DEFAULT_LIMITS: Required<RpcLimits> = {
    maxDepth: 32,
    maxKeys: 1000,
    maxArgs: 64,
    maxArrayLen: 10_000,
    maxStringLen: 1_000_000,
    maxCallbacks: 100,
    maxPathLen: 16,
};

const resolveLimits = (opts?: RpcLimits): Required<RpcLimits> =>
    opts ? { ...DEFAULT_LIMITS, ...opts } : DEFAULT_LIMITS;

class PayloadLimitError extends Error {
    constructor(reason: string) {
        super(`Payload limit exceeded: ${reason}`);
        this.name = "PayloadLimitError";
    }
}

export type SocketTmpl = { emit: (e: string, d: any) => void; on: (e: string, cb: (d: any) => void) => void };
type Func = (...args: any[]) => any;

// ---- LIFO ID Pool ----

// ---- Deep walk: functions ↔ markers ----
function walk(val: any, onLeaf: (v: any) => any, lim?: Required<RpcLimits>, depth = 0): any {
    if (lim) {
        if (depth > lim.maxDepth) throw new PayloadLimitError("max depth exceeded");
        if (typeof val == "string" && val.length > lim.maxStringLen) throw new PayloadLimitError("string too long");
    }
    if (val == null || typeof val !== "object") return onLeaf(val);
    if (val[FN_MARKER] !== undefined) return onLeaf(val);
    if (Array.isArray(val)) {
        if (lim && val.length > lim.maxArrayLen) throw new PayloadLimitError("array too long");
        return val.map(v => walk(v, onLeaf, lim, depth + 1));
    }
    const keys = Object.keys(val);
    if (lim && keys.length > lim.maxKeys) throw new PayloadLimitError("too many keys in object");
    const o: any = {};
    for (const k of keys) if (isSafeKey(k)) o[k] = walk(val[k], onLeaf, lim, depth + 1);
    return o;
}

function pack(args: any[], pool: idPool, cbStore: Map<number, Function>, cbIds: number[]): any[] {
    return args.map(v => walk(v, leaf => {
        if (typeof leaf == "function") {
            const id = pool.next();
            cbStore.set(id, leaf);
            cbIds.push(id);
            return { [FN_MARKER]: id };
        }
        return leaf;
    }));
}

function unpack(
    args: any[],
    sender: (id: number, a: any[]) => void,
    onEnd: (id: number) => void,
    lim?: Required<RpcLimits>,
): any[] {
    let cbCount = 0;
    return args.map(v => walk(v, leaf => {
        if (leaf != null && typeof leaf == "object" && leaf[FN_MARKER] !== undefined) {
            if (lim && ++cbCount > lim.maxCallbacks) throw new PayloadLimitError("too many callbacks");
            const id = leaf[FN_MARKER];
            if (typeof id !== "number" || !Number.isFinite(id)) throw new PayloadLimitError("invalid callback id");
            const wrapper = (...a: any[]) => {
                if (a[0] == "___STOP") { onEnd(id); return; }
                sender(id, a);
            };
            _stopRegistry.set(wrapper, () => onEnd(id));
            return wrapper;
        }
        return leaf;
    }, lim));
}

const errToObj = (e: any) =>
    e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e;

const _stopRegistry = new WeakMap<Function, () => void>();

/** Завершить callback на стороне клиента. Альтернатива вызову fn("___STOP"). */
export function rpcEndCallback(fn: Function) {
    _stopRegistry.get(fn)?.();
}

const resolveCA = (path: string[], args: any[]): [string[], any[]] => {
    const last = path[path.length - 1];
    if (last == "call") return [path.slice(0, -1), args.slice(1)];
    if (last == "apply") return [path.slice(0, -1), args[1] ?? []];
    return [path, args];
};

// ==========================================
//  SERVER
// ==========================================

type PromiseServerHooks<T> = {
    onRequest?: (ctx: { key: string[]; request: any[]; fnName: string; fn: Func }) => boolean | Promise<boolean>;
    onInvalid?: (ctx: { reason: "invalid_payload" | "not_function" | "resolve_error" | "rate_limit"; key?: any; request?: any; error?: any }) => void | Promise<void>;
    resolveTransform?: (value: any) => any;
};

// Входящие сообщения на сервер
type ServerIncomingMsg =
    | typeof Pkt.STRICT                                                          // запрос схемы
    | [type: typeof Pkt.CALL, reqId: number, ref: number | string[], args: any[], wait?: false]; // вызов

// Входящие сообщения на клиент
type ClientIncomingMsg =
    | [type: typeof Pkt.RESP, reqId: number, result: unknown]                     // успех
    | [type: typeof Pkt.RESP, reqId: number, result: null, error: SerializedError] // ошибка
    | [type: typeof Pkt.CB,   cbId: number, args: unknown[]]                      // вызов колбэка
    | [type: typeof Pkt.CB_END, cbId: number]                                      // завершение колбэка
    | [type: typeof Pkt.MAP,  routes: Record<string, number> | null, schema: Record<string, unknown> | null]; // карта методов

type SerializedError = {
    name?: string;
    message?: string;
    stack?: string;
} | unknown;

function createServer<T extends object>(
        socket: SocketTmpl,
        key: string,
        target: T,
        hooks?: PromiseServerHooks<T>,
        limits?: RpcLimits,
    ) {
        const lim = resolveLimits(limits);
        const methods: Function[] = [];
        const contexts: any[] = [];
        const routeMap: Record<string, number> = {};

    function transformTree(obj: any): any {
        if (obj == null || typeof obj != "object" || isProxy(obj)) return obj;
        const out: any = {};
        for (const k of Object.keys(obj)) {
            if (!isSafeKey(k)) continue;
            const v = obj[k];
            if (isProxy(v)) {obj[k] = v; continue;}
            out[k] = typeof v == "function" ? v : v != null && typeof v == "object" ? transformTree(v) : v;
        }
        return out;
    }

    const resolved = hooks?.resolveTransform ? transformTree(target) : target;

    function index(obj: any, prefix: string) {
        for (const k of Object.keys(obj)) {
            if (!isSafeKey(k)) continue;
            const v = obj[k];
            const path = prefix ? prefix + "." + k : k;
            if (typeof v == "function") { routeMap[path] = methods.length; methods.push(v); contexts.push(obj); }
            else if (v && typeof v == "object" && !isProxy(v)) index(v, path);
        }
    }
    index(resolved, "");

        function serialize(obj: any): any {
            const out: any = {};
            for (const k of Object.keys(obj)) {
                if (!isSafeKey(k)) continue;
                const v = obj[k];
                switch (true) {
                    case v == null:        out[k] = "null";        break;
                    case isProxy(v):       out[k] = "dynamic";     break;
                    case typeof v == "function": out[k] = "func";  break;
                    case typeof v == "object":   out[k] = serialize(v); break;
                    default:               out[k] = "unknown";
                    break;
                }

            }
            return out;
        }

    const strictSchema = serialize(resolved);
    const send = (d: any) => socket.emit(key, d);

    send([Pkt.MAP, routeMap, strictSchema]);

    socket.on(key, async (msg: ServerIncomingMsg) => {
        if (msg == Pkt.STRICT) { send([Pkt.MAP, routeMap, strictSchema]); return; }
        if (!Array.isArray(msg) || msg[0] !== Pkt.CALL) return;

        const [, reqId, ref, rawArgs, w] = msg;
        const wait = w !== false;

        if (typeof reqId !== "number" || !Number.isFinite(reqId)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgs, error: "reqId is not a valid number" });
            return;
        }
        if (typeof ref !== "number" && !Array.isArray(ref)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgs, error: "ref must be number or string[]" });
            if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Invalid ref type"))]);
            return;
        }
        if (!Array.isArray(rawArgs)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgs, error: "args must be an array" });
            if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Invalid args: expected array"))]);
            return;
        }

        try {
            let fn: Function | undefined, ctx: any;

            if (typeof ref == "number") {
                fn = methods[ref]; ctx = contexts[ref];
            } else {
                if (!ref.every((s: any) => typeof s == "string" && isSafeKey(s))) {
                    hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgs });
                    if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Forbidden path segment"))]);
                    return;
                }
                const idx = routeMap[ref.join(".")];
                if (idx !== undefined) {
                    fn = methods[idx]; ctx = contexts[idx];
                } else {
                    let curr: any = target;
                    for (let i = 0; i < ref.length - 1; i++) {
                        const seg = ref[i];
                        if (curr == null || typeof curr !== "object" || !hasOwn(curr, seg)) { curr = undefined; break; }

                        curr = curr[seg];
                        if (hooks?.resolveTransform && !isProxy(curr)) curr = hooks.resolveTransform(curr);
                    }
                    const last = ref[ref.length - 1];
                    if (curr != null && typeof curr == "object") {
                        ctx = curr;
                        fn = hasOwn(curr, last) ? curr[last] : undefined;
                    }
                }
            }
            if (typeof fn !== "function") {
                hooks?.onInvalid?.({ reason: "not_function", key: ref, request: rawArgs });
                if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Not a function: " + ref))]);
                return;
            }

            if (hooks?.onRequest) {
                const keyArr = typeof ref == "number"
                    ? Object.keys(routeMap).find(k => routeMap[k] == ref)?.split(".") ?? []
                    : ref;
                const allowed = await hooks.onRequest({ key: keyArr, request: rawArgs, fnName: keyArr[keyArr.length - 1] ?? "", fn: fn as Func });
                if (allowed == false) {
                    if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Rejected by hook"))]);
                    return;
                }
            }

            const args = unpack(rawArgs, (cbId, cbArgs) => send([Pkt.CB, cbId, cbArgs]), (cbId) => send([Pkt.CB_END, cbId]), lim);
            const res = await fn.apply(ctx, args);
            if (wait) send([Pkt.RESP, reqId, res]);
        } catch (e) {
            if (wait) send([Pkt.RESP, reqId, null, errToObj(e)]);
        }
    });
}

// ==========================================
//  CLIENT
// ==========================================

type UnwrapPromise<T> = T extends Promise<infer R> ? R : T;
type ClientAPI<T> = {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R
        ? (...args: A) => Promise<UnwrapPromise<R>>
        : T[K] extends object ? ClientAPI<T[K]> : T[K];
};
type ClientAPIStrict<T> = ClientAPI<T>;

type ClientApiHandle = {
    log: (s: boolean) => void;
    promiseTotal: () => number;
    callbackTotal: () => number;
    promiseDeleteAll: (reject?: boolean) => void;
    callbackDeleteAll: () => void;
    callbackDelete: (fn: Function) => void;
    callbackEnd: (fn: Function) => void;
};

function createClient<T extends object>(socket: SocketTmpl, key: string, opts?: { limit?: number }) {
    const limit = opts?.limit ?? 10000;
    const pool = createIdPool();
    const pending = new Map<number, { ok: Function; fail: Function; cbs: number[] }>();
    const callbacks = new Map<number, Function>();
    const routeCache: Record<string, number> = {};
    let strictData: any = {};
    let strictWaiters: ((v: unknown) => void)[] = [];
    let debug = false;

    socket.on(key, (msg: ClientIncomingMsg) => {
        if (!Array.isArray(msg)) return;
        switch (msg[0]) {
            case Pkt.RESP: {
                const req = pending.get(msg[1]);
                if (!req) break;
                pending.delete(msg[1]);
                pool.release(msg[1]);
                for (const cbId of req.cbs) { callbacks.delete(cbId); pool.release(cbId); }
                msg[3] ? req.fail(msg[3]) : req.ok(msg[2]);
                break;
            }
            case Pkt.CB: {
                callbacks.get(msg[1])?.(...(msg[2] || []));
                break;
            }
            case Pkt.CB_END: {
                const cbId = msg[1] as number;
                callbacks.delete(cbId);
                pool.release(cbId);
                break;
            }
            case Pkt.MAP: {
                if (msg[1]) Object.assign(routeCache, msg[1]);
                if (msg[2]) {
                    for (const k of Object.keys(strictData)) delete strictData[k];
                    Object.assign(strictData, msg[2]);
                    for (const r of strictWaiters) r(undefined);
                    strictWaiters = [];
                }
                break;
            }
        }
    });

    const sendCall = (path: string[], args: any[], wait: boolean): any => {
        const cbIds: number[] = [];
        const clean = pack(args, pool, callbacks, cbIds);
        const ref: number | string[] = routeCache[path.join(".")] ?? path;

        if (!wait) {
            socket.emit(key, [Pkt.CALL, 0, ref, clean, false]);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            if (pending.size >= limit) return reject(new Error("RPC limit"));
            const reqId = pool.next();
            pending.set(reqId, { ok: resolve, fail: reject, cbs: cbIds });
            if (debug) console.log("[RPC]", path.join("."), "id=", reqId);
            socket.emit(key, [Pkt.CALL, reqId, ref, clean]);
        });
    };

    const buildProxy = (path: string[], wait: boolean): any =>
        new Proxy(function () {}, {
            get(_, p: string | symbol) {
                if (p == "then" || p == "catch" || p == Symbol.toPrimitive) return undefined;
                return buildProxy([...path, String(p)], wait);
            },
            apply(_, __, args) {
                const [fp, fa] = resolveCA(path, args);
                return sendCall(fp, fa, wait);
            },
        });

    const buildStrict = (path: string[], wait: boolean): any => {
        let tgt: any = strictData;
        for (const seg of path) {
            tgt = tgt?.[seg];
            if (tgt == null || tgt == "null") return undefined;
            if (tgt == "dynamic") return buildProxy([...path], wait);
        }
        if (tgt == "dynamic") return buildProxy(path, wait);

        return new Proxy(tgt == "func" ? function () {} : {}, {
            has: (_, p) => tgt?.[String(p)] !== "null",
            ownKeys: () => tgt && typeof tgt == "object" ? Object.keys(tgt) : [],
            getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
            getPrototypeOf: () => !tgt || tgt == "null" ? Object.prototype : tgt == "func" ? Function.prototype : null,
            get(_, p: string | symbol) {
                if (p == "then" || p == "catch" || p == Symbol.toPrimitive) return undefined;
                if (p == "call" && tgt == "func") return (_: any, ...args: any[]) => sendCall(path, args, wait);
                const child = tgt?.[String(p)];
                return child == "null" || child == undefined ? undefined : buildStrict([...path, String(p)], wait);
            },
            apply(_, __, args) {
                const [fp, fa] = resolveCA(path, args);
                return sendCall(fp, fa, wait);
            },
        });
    };

    const releaseCbs = (fn: Function) => {
        callbacks.forEach((cb, id) => { if (cb == fn) { callbacks.delete(id); pool.release(id); } });
    };

    const clearAll = (rejectReason?: any) => {
        pending.forEach((p, id) => { pool.release(id); p.fail(rejectReason ?? "aborted"); });
        pending.clear();
        callbacks.forEach((_, id) => pool.release(id));
        callbacks.clear();
    };

    const api: ClientApiHandle = {
        log: s => { debug = s; },
        promiseTotal: () => pending.size,
        callbackTotal: () => callbacks.size,
        promiseDeleteAll: (rej = true) => {
            pending.forEach((p, id) => { pool.release(id); rej ? p.fail("promiseDeleteAll") : p.ok(undefined); });
            pending.clear();
        },
        callbackDeleteAll: () => { callbacks.forEach((_, id) => pool.release(id)); callbacks.clear(); },
        callbackDelete: releaseCbs,
        callbackEnd: releaseCbs,
    };

    const func = buildProxy([], true) as ClientAPI<T>;

    return {
        func,
        space: buildProxy([], false) as ClientAPI<T>,
        all: func as ClientAPI<T>,
        strict: buildStrict([], true) as ClientAPIStrict<T>,
        api,
        abortAll: (reason: string) => clearAll({ error: { name: "RPC_ABORT", message: reason } }),
        infoStrict: () => strictData,
        async strictInit(obj?: object) {
            if (obj) { strictData = obj; }
            else { socket.emit(key, Pkt.STRICT); return new Promise(r => { strictWaiters.push(r); }); }
        },
    };
}

// ==========================================
//  FACADE (backward compat)
// ==========================================

function createAPIFacadeServer<T extends object>({ socket, object: target, socketKey: key, debug = false, hooks, limits }: {
    socket: SocketTmpl; object: T; socketKey: string; debug?: boolean; hooks?: PromiseServerHooks<T>; limits?: RpcLimits;
}) {
        if (debug) {
            const origOn = socket.on.bind(socket);
            socket.on = (e: string, cb: (d: any) => void) =>
                origOn(e, (d: any) => { console.log("[RPC IN]", typeof d == "object" ? JSON.stringify(d) : d); cb(d); });
        }
        createServer(socket, key, target, hooks, limits);
    }

function createAPIFacadeClient<T extends object>({ socket, socketKey: key, limit }: {
    socket: SocketTmpl; socketKey: string; limit?: number;
}) {
    return createClient<T>(socket, key, { limit });
}

export { createAPIFacadeServer as CreatAPIFacadeServer2, createAPIFacadeClient as CreatAPIFacadeClient2 };
export type { ClientAPI, ClientAPIStrict, ClientApiHandle, PromiseServerHooks };