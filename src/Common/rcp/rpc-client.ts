import { Pkt, type SocketTmpl } from "./rpc-protocol";
import {createIdPool} from "../id-pool";
import {pack, resolveCA} from "./rpc-walk";
type UnwrapPromise<T> = T extends Promise<infer R> ? R : T;

export type ClientAPI<T> = {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R
        ? (...args: A) => Promise<UnwrapPromise<R>>
        : T[K] extends object ? ClientAPI<T[K]> : T[K];
};

type ClientApiHandle = {
    log: (s: boolean) => void;
    pending: () => number;
    callbacks: () => number;
    clearPromises: (reject?: boolean) => void;
    clearCallbacks: () => void;
    remove: (fn: Function) => void;
    end: (fn: Function) => void;
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

    socket.on(key, (msg: any) => {
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
                if (tgt === "func") return undefined;
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

    const api: ClientApiHandle = {
        log: s => { debug = s; },
        pending: () => pending.size,
        callbacks: () => callbacks.size,
        clearPromises: (rej = true) => {
            pending.forEach((p, id) => { pool.release(id); rej ? p.fail("promiseDeleteAll") : p.ok(undefined); });
            pending.clear();
        },
        clearCallbacks: () => { callbacks.forEach((_, id) => pool.release(id)); callbacks.clear(); },
        remove: releaseCbs,
        end: releaseCbs,
    };

    const func = buildProxy([], true) as ClientAPI<T>;
    let _ready: null | Promise<void> = null;
    let ready = () => _ready ? _ready : _ready = init()
    const init = async (obj?: object) => {
        if (obj) { strictData = obj; }
        else
        {
            socket.emit(key, Pkt.STRICT);
            await new Promise(r => { strictWaiters.push(r); });
        }
    }

    return {
        func,
        space: buildProxy([], false) as ClientAPI<T>,
        all: func as ClientAPI<T>,
        strict: buildStrict([], true) as ClientAPI<T>,
        api,
        abortAll: (reason: string) => {
            const err = { error: { name: "RPC_ABORT", message: reason } };
            pending.forEach((p, id) => { pool.release(id); p.fail(err); });
            pending.clear();
            callbacks.forEach((_, id) => pool.release(id));
            callbacks.clear();
        },
        schema: () => strictData,
        readyStrict: ready,
        initStrict: init,
    };
}

export function createRpcClient<T extends object>({ socket, socketKey: key, limit }: {
    socket: SocketTmpl; socketKey: string; limit?: number;
}) {
    return createClient<T>(socket, key, { limit });
}

export type { ClientApiHandle };
