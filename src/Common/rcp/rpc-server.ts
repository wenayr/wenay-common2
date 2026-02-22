import {isNoStrict} from "./rpc-dynamic";
import { isSafeKey, resolveLimits, type RpcLimits } from "./rpc-limits";
import { unpack, errToObj } from "./rpc-walk";
import { Pkt, type SocketTmpl } from "./rpc-protocol";

type Func = (...args: any[]) => any;

type PromiseServerHooks<T> = {
    onRequest?: (ctx: { key: string[]; request: any[]; fnName: string; fn: Func }) => boolean | Promise<boolean>;
    onInvalid?: (ctx: { reason: "invalid_payload" | "not_function" | "resolve_error" | "rate_limit"; key?: any; request?: any; error?: any }) => void | Promise<void>;
    resolveTransform?: (value: any) => any;
};

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
        let current = obj;
        if (hooks?.resolveTransform && !isNoStrict(current)) {
            current = hooks.resolveTransform(current);
        }
        if (current == null || typeof current != "object" || isNoStrict(current)) return current;
        const out: any = {};
        for (const k of Object.keys(current)) {
            if (!isSafeKey(k)) continue;
            const v = current[k];
            if (isNoStrict(v)) { out[k] = v; continue; }
            out[k] = typeof v == "function" ? v : v != null && typeof v == "object" ? transformTree(v) : v;
        }
        return out;
    }

    const resolved = transformTree(target);

    function index(obj: any, prefix: string) {
        for (const k of Object.keys(obj)) {
            if (!isSafeKey(k)) continue;
            const v = obj[k];
            const path = prefix ? prefix + "." + k : k;
            if (typeof v == "function") { routeMap[path] = methods.length; methods.push(v); contexts.push(obj); }
            else if (v && typeof v == "object" && !isNoStrict(v)) index(v, path);
        }
    }
    index(resolved, "");

    function serialize(obj: any): any {
        const out: any = {};
        for (const k of Object.keys(obj)) {
            if (!isSafeKey(k)) continue;
            const v = obj[k];
            switch (true) {
                case v == null:              out[k] = "null";    break;
                case isNoStrict(v):          out[k] = "dynamic"; break;
                case typeof v == "function": out[k] = "func";    break;
                case typeof v == "object":   out[k] = serialize(v); break;
                default:                     out[k] = "unknown"; break;
            }
        }
        return out;
    }

    const strictSchema = serialize(resolved);
    const send = (d: any) => socket.emit(key, d);

    send([Pkt.MAP, routeMap, strictSchema]);

    socket.on(key, async (msg: any) => {
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
                        if (curr == null || typeof curr !== "object" || !(seg in curr)) { curr = undefined; break; }
                        curr = curr[seg];
                        if (hooks?.resolveTransform && !isNoStrict(curr)) curr = hooks.resolveTransform(curr);
                    }
                    const last = ref[ref.length - 1];
                    if (curr != null && typeof curr == "object") {
                        ctx = curr;
                        fn = last in curr ? curr[last] : undefined;
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

export function createRpcServer<T extends object>({ socket, object: target, socketKey: key, debug = false, hooks, limits }: {
    socket: SocketTmpl; object: T; socketKey: string; debug?: boolean; hooks?: PromiseServerHooks<T>; limits?: RpcLimits;
}) {
    if (debug) {
        const origOn = socket.on.bind(socket);
        socket.on = (e: string, cb: (d: any) => void) =>
            origOn(e, (d: any) => { console.log("[RPC IN]", typeof d == "object" ? JSON.stringify(d) : d); cb(d); });
    }
    createServer(socket, key, target, hooks, limits);
}

export type { PromiseServerHooks, RpcLimits };
