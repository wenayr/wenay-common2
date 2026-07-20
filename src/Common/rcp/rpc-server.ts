import {isNoStrict} from "./rpc-dynamic";
import { isSafeKey, resolveLimits, PayloadLimitError, type RpcLimits } from "./rpc-limits";
import {unpack, errToObj, packResult} from "./rpc-walk";
import { isPlainObject, createCbShapeServer } from "./rpc-shape";
import { Pkt, IS_RPC_LISTEN, type SocketTmpl } from "./rpc-protocol";
import { rpcPathKey } from "./rpc-path";
import { Caps, hasCap, optToCaps, type tCaps, type RpcOpt } from "./rpc-caps";
import { MyError } from "../../toError/myThrow";

type Func = (...args: any[]) => any;

type PromiseServerHooks<T> = {
    onRequest?: (ctx: { key: string[]; request: any[]; fnName: string; fn: Func }) => boolean | Promise<boolean>;
    onInvalid?: (ctx: { reason: "invalid_payload" | "not_function" | "resolve_error" | "rate_limit"; key?: any; request?: any; error?: any }) => void | Promise<void>;
    resolveTransform?: (value: any) => any;
    onDispose?: () => void;
};

// In-band authorization (P3 "confirmation"): client sends Pkt.HELLO with token, server
// validates it and (opt.) replaces served object with facade of this principal, then sends
// Pkt.MAP with authAck. Without auth previous behavior. Token source and admission — outside core.
type RpcServerAuth = {
    /** token → { object?: principal facade, ack?: what to send to client in authAck }. throw/ack.ok===false = rejection. */
    resolveAuth: (token: any) => { object?: any; ack?: any } | Promise<{ object?: any; ack?: any }>;
    /** true → CALL/PIPE before successful HELLO are rejected ("Unauthorized").
     *  MANDATORY for access control: without gate initial `object` is called BEFORE HELLO,
     *  and its schema is exposed in response to STRICT — so keep initial `object` EMPTY,
     *  and serve protected surface as facade from resolveAuth(principal). */
    gate?: boolean;
};

// Repeated createRpcServer on same socket+key ADDED a second socket.on
// (each request executed twice). SocketTmpl can't off → last one wins,
// previous handler becomes inert.
const SERVERS = new WeakMap<object, Map<string, () => void>>();

function createServer<T extends object>(
    socket: SocketTmpl,
    key: string,
    target: T,
    hooks?: PromiseServerHooks<T>,
    limits?: RpcLimits,
    auth?: RpcServerAuth,
    opt?: RpcOpt,
) {
    const lim = resolveLimits(limits);
    const IS_RPC_PIPE = Symbol.for("isRpcPipe");

    const hasRpcListen = (obj: any) => !!obj && typeof obj == "object" && Object.prototype.hasOwnProperty.call(obj, IS_RPC_LISTEN);

    function transformTree(obj: any): any {
        let current = obj;
        if (hooks?.resolveTransform && !isNoStrict(current)) {
            current = hooks.resolveTransform(current);
        }
        if (current == null || typeof current != "object" || isNoStrict(current)) return current;
        const out: any = {};
        if (hasRpcListen(current)) out[IS_RPC_LISTEN] = true; // mark — Symbol, Object.keys doesn't copy it
        for (const k of Object.keys(current)) {
            if (!isSafeKey(k)) continue;
            const v = current[k];
            if (isNoStrict(v)) { out[k] = v; continue; }
            // functions also pass through resolveTransform: bare `on` function (registered by WeakMap)
            // becomes Listen wrapper; normal function returned as-is → previous behavior.
            out[k] = typeof v == "function" ? (hooks?.resolveTransform ? hooks.resolveTransform(v) : v)
                : v != null && typeof v == "object" ? transformTree(v) : v;
        }
        return out;
    }

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

    // Dispatch tables are rebuilt on principal change (re-auth) → keep in let.
    let methods: Function[] = [];
    let contexts: any[] = [];
    let methodPaths: string[][] = [];
    let routeMap: Record<string, number> = {};
    let listenPaths: string[] = []; // Listen node addresses — declared to client in Pkt.MAP (4th element)
    let strictSchema: any = {};
    let currentTarget: any = target; // active object (facade of current principal)

    function buildDispatch(t: any) {
        const m: Function[] = [], cx: any[] = [], paths: string[][] = [], rm: Record<string, number> = {}, lp: string[] = [];
        const resolved = transformTree(t);
        (function index(obj: any, prefix: string[]) {
            for (const k of Object.keys(obj)) {
                if (!isSafeKey(k)) continue;
                const v = obj[k];
                const path = [...prefix, k];
                if (typeof v == "function") { rm[rpcPathKey(path)] = m.length; m.push(v); cx.push(obj); paths.push(path); }
                else if (v && typeof v == "object" && !isNoStrict(v)) {
                    if (hasRpcListen(v)) lp.push(rpcPathKey(path));
                    index(v, path);
                }
            }
        })(resolved, []);
        methods = m; contexts = cx; methodPaths = paths; routeMap = rm; listenPaths = lp; strictSchema = serialize(resolved); currentTarget = t;
    }
    buildDispatch(target);

    const send = (d: any) => socket.emit(key, d);

    // Adaptive subscription tick compaction. Contractual: efficient, ONLY if both peers
    // announced Caps.COMPACT (serverCaps from opt, peerCaps from client Pkt.CAPS).
    // sendCb: frequent object of one shape → Pkt.SHAPE(once) + Pkt.CBV(values); else normal Pkt.CB.
    const serverCaps = optToCaps(opt);
    let peerCaps: tCaps = 0;
    const compactOn = () => hasCap(serverCaps & peerCaps, Caps.COMPACT);
    const cbShapes = createCbShapeServer();
    const sendCb = (cbId: number, cbArgs: any[]) => {
        if (compactOn() && cbArgs.length == 1 && isPlainObject(cbArgs[0])) {
            const obj = cbArgs[0];
            const r = cbShapes.offer(cbId, obj);
            if (r.mode == "register") { send([Pkt.SHAPE, cbId, r.shapeId, r.keys]); send([Pkt.CBV, cbId, r.shapeId, r.keys.map(k => packResult(obj[k]))]); return; }
            if (r.mode == "compact") { send([Pkt.CBV, cbId, r.shapeId, r.keys.map(k => packResult(obj[k]))]); return; }
        }
        send([Pkt.CB, cbId, cbArgs.map(packResult)]);
    };
    const sendCbEnd = (cbId: number) => { cbShapes.drop(cbId); send([Pkt.CB_END, cbId]); };

    // gate=true → calls rejected before successful HELLO; without auth — open, as before.
    let authed = !auth?.gate;
    let authAck: any = undefined;
    // Socket.IO preserves packet order, but EventEmitter does not await an async
    // HELLO handler. STRICT/CALL therefore wait on the matching principal build.
    let helloInFlight: Promise<void> | null = null;
    // 5th element of MAP appears ONLY when authAck exists — else wire byte-for-byte as before.
    const sendMap = () => send(authAck !== undefined
        ? [Pkt.MAP, routeMap, strictSchema, listenPaths, authAck]
        : [Pkt.MAP, routeMap, strictSchema, listenPaths]);
    // Do not race HELLO with a pre-auth MAP: hub could treat it as a completed handshake.
    // No-auth servers keep the eager push; auth clients obtain their MAP from HELLO/STRICT.
    if (!auth?.resolveAuth) sendMap()
    // Announce OUR contractual features once (half of "ask" handshake): new client
    // will remember (peerServerCaps), old one ignores unfamiliar Pkt.CAPS.
    if (serverCaps) send([Pkt.CAPS, serverCaps]);

    let detached = false;
    let byKey = SERVERS.get(socket);
    if (!byKey) { byKey = new Map(); SERVERS.set(socket, byKey); }
    const detachPrev = byKey.get(key);
    if (detachPrev) {
        detachPrev();
        console.warn(`[RPC] createRpcServer: repeated initialization on socket+key "${key}" — previous server detached`);
    }
    byKey.set(key, () => { detached = true; hooks?.onDispose?.(); });

    socket.on(key, async (msg: any) => {
        if (detached) return;
        if (msg == Pkt.STRICT) {
            const hello = helloInFlight;
            if (hello) {
                await hello;
                // HELLO already sent the principal-specific five-element MAP.
                return;
            }
            sendMap();
            return;
        }
        // CAPS: client announced its feature bitset. Legacy client sends [CAPS,1]=COMPACT. Old
        // server ignored the value; now we read it and intersect with serverCaps (compactOn()).
        if (Array.isArray(msg) && msg[0] === Pkt.CAPS) { peerCaps = typeof msg[1] === "number" ? msg[1] : Caps.COMPACT; return; }
        // HELLO: in-band authorization. Without auth strategy — ignore (old client vs server without auth).
        if (Array.isArray(msg) && msg[0] === Pkt.HELLO) {
            // Server without auth: reply to HELLO is still 5-element (authAck=null) — so client
            // can distinguish "HELLO reply" from 4-element STRICT and not hang/confuse them.
            if (!auth?.resolveAuth) { send([Pkt.MAP, routeMap, strictSchema, listenPaths, null]); return; }
            async function resolveHello() {
                try {
                    const r: any = await auth!.resolveAuth!(msg[1]);
                    if (r && r.object !== undefined) buildDispatch(r.object); // new principal facade
                    authAck = r && r.ack !== undefined ? r.ack : { ok: true };
                    authed = authAck?.ok !== false;
                    sendMap(); // principal-specific routeMap + authAck
                } catch (e: any) {
                    // Reauth rejection DOES NOT drop live session: don't touch principal/authed/routeMap,
                    // just report ok:false to client via local ack (their reauth() resolves as-is).
                    send([Pkt.MAP, routeMap, strictSchema, listenPaths, { ok: false, reason: e?.message ?? String(e) }]);
                }
            }
            const hello = resolveHello();
            helloInFlight = hello;
            try { await hello; }
            finally { if (helloInFlight == hello) helloInFlight = null; }
            return;
        }
        if (!Array.isArray(msg) || (msg[0] !== Pkt.CALL && msg[0] !== Pkt.PIPE)) return;
        const hello = helloInFlight;
        if (hello) {
            await hello;
            if (detached) return;
        }

        const isPipe = msg[0] === Pkt.PIPE;
        const [, reqId, ref, rawArgsOrSteps, w] = msg;
        const wait = w !== false;

        if (typeof reqId !== "number" || !Number.isFinite(reqId)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "reqId is not a valid number" });
            return;
        }
        if (!authed) { // gate: calls before successful HELLO
            if (wait) send([Pkt.RESP, reqId, null, errToObj(new MyError("Unauthorized", "E_UNAUTHORIZED"))]);
            return;
        }
        if (typeof ref !== "number" && !Array.isArray(ref)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "ref must be number or string[]" });
            if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Invalid ref type"))]);
            return;
        }
        if (!Array.isArray(rawArgsOrSteps)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "args/steps must be an array" });
            if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Invalid args: expected array"))]);
            return;
        }

        try {
            let fn: Function | undefined, ctx: any;

            if (typeof ref == "number") {
                fn = methods[ref]; ctx = contexts[ref];
            } else {
                if (!ref.every((s: any) => typeof s == "string" && isSafeKey(s))) {
                    hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps });
                    if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Forbidden path segment"))]);
                    return;
                }
                if (ref.length > lim.maxPathLen) {
                    hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "path too long" });
                    if (wait) send([Pkt.RESP, reqId, null, errToObj(new PayloadLimitError("path too long"))]);
                    return;
                }
                const idx = routeMap[rpcPathKey(ref)];
                if (idx !== undefined) {
                    fn = methods[idx]; ctx = contexts[idx];
                } else {
                    let curr: any = currentTarget;
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
                hooks?.onInvalid?.({ reason: "not_function", key: ref, request: rawArgsOrSteps });
                if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Not a function: " + ref))]);
                return;
            }

            if (hooks?.onRequest) {
                const keyArr = typeof ref == "number"
                    ? methodPaths[ref] ?? []
                    : ref;
                const allowed = await hooks.onRequest({ key: keyArr, request: rawArgsOrSteps, fnName: keyArr[keyArr.length - 1] ?? "", fn: fn as Func });
                if (allowed == false) {
                    if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Rejected by hook"))]);
                    return;
                }
            }

            if (isPipe) {
                // --- PIPE LOGIC (PIPELINE) ---
                const steps = rawArgsOrSteps as any[];
                let current: any = fn.bind(ctx);

                for (let i = 0; i < steps.length; i++) {
                    const step = steps[i];

                    if (current && typeof current === "object" && current[IS_RPC_PIPE]) {
                        const remainingSteps = steps.slice(i);
                        current = current.__executeRemainingPipe(remainingSteps);
                        break; 
                    }

                    if (current && typeof current.then === "function") {
                        current = await current;
                    }

                    if (step.type === 'get') {
                        if (current == null) throw new Error(`Cannot read property '${step.prop}' of ${current}`);
                        current = current[step.prop];
                    } else if (step.type === 'call') {
                        if (typeof current !== "function") throw new Error("Attempted to call a non-function in pipe");
                        // like in CALL: else Date/Map/BigInt in callback args perish on JSON transport
                        const stepArgs = unpack(step.args, sendCb, sendCbEnd, lim);
                        current = current(...stepArgs);
                    }
                }
                
                if (current && typeof current.then === "function") {
                    current = await current;
                }
                if (wait) send([Pkt.RESP, reqId, packResult(current)]);

            } else {
                // --- STANDARD CALL LOGIC ---
                const args = unpack(rawArgsOrSteps, sendCb, sendCbEnd, lim);
                const res = await fn.apply(ctx, args);
                if (wait) send([Pkt.RESP, reqId, packResult(res)]);
            }

        } catch (e) {
            if (wait) send([Pkt.RESP, reqId, null, errToObj(e)]);
        }
    });
}

export function createRpcServer<T extends object>({ socket, object: target, socketKey: key, debug = false, hooks, limits, auth, opt }: {
    socket: SocketTmpl; object: T; socketKey: string; debug?: boolean; hooks?: PromiseServerHooks<T>; limits?: RpcLimits; auth?: RpcServerAuth; opt?: RpcOpt;
}) {
    if (debug) {
        const origOn = socket.on.bind(socket);
        socket.on = (e: string, cb: (d: any) => void) =>
            origOn(e, (d: any) => { console.log("[RPC IN]", typeof d == "object" ? JSON.stringify(d) : d); cb(d); });
    }
    createServer(socket, key, target, hooks, limits, auth, opt);
}

export type { PromiseServerHooks, RpcLimits, RpcServerAuth };
export type { RpcOpt } from "./rpc-caps";
