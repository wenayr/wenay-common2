"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRpcServer = createRpcServer;
const rpc_dynamic_1 = require("./rpc-dynamic");
const rpc_limits_1 = require("./rpc-limits");
const rpc_walk_1 = require("./rpc-walk");
const rpc_shape_1 = require("./rpc-shape");
const rpc_protocol_1 = require("./rpc-protocol");
const rpc_path_1 = require("./rpc-path");
const rpc_caps_1 = require("./rpc-caps");
const myThrow_1 = require("../../toError/myThrow");
const SERVERS = new WeakMap();
function createServer(socket, key, target, hooks, limits, auth, opt) {
    const lim = (0, rpc_limits_1.resolveLimits)(limits);
    const IS_RPC_PIPE = Symbol.for("isRpcPipe");
    const hasRpcListen = (obj) => !!obj && typeof obj == "object" && Object.prototype.hasOwnProperty.call(obj, rpc_protocol_1.IS_RPC_LISTEN);
    function transformTree(obj) {
        let current = obj;
        if (hooks?.resolveTransform && !(0, rpc_dynamic_1.isNoStrict)(current)) {
            current = hooks.resolveTransform(current);
        }
        if (current == null || typeof current != "object" || (0, rpc_dynamic_1.isNoStrict)(current))
            return current;
        const out = {};
        if (hasRpcListen(current))
            out[rpc_protocol_1.IS_RPC_LISTEN] = true;
        for (const k of Object.keys(current)) {
            if (!(0, rpc_limits_1.isSafeKey)(k))
                continue;
            const v = current[k];
            if ((0, rpc_dynamic_1.isNoStrict)(v)) {
                out[k] = v;
                continue;
            }
            out[k] = typeof v == "function" ? (hooks?.resolveTransform ? hooks.resolveTransform(v) : v)
                : v != null && typeof v == "object" ? transformTree(v) : v;
        }
        return out;
    }
    function serialize(obj) {
        const out = {};
        for (const k of Object.keys(obj)) {
            if (!(0, rpc_limits_1.isSafeKey)(k))
                continue;
            const v = obj[k];
            switch (true) {
                case v == null:
                    out[k] = "null";
                    break;
                case (0, rpc_dynamic_1.isNoStrict)(v):
                    out[k] = "dynamic";
                    break;
                case typeof v == "function":
                    out[k] = "func";
                    break;
                case typeof v == "object":
                    out[k] = serialize(v);
                    break;
                default:
                    out[k] = "unknown";
                    break;
            }
        }
        return out;
    }
    let methods = [];
    let contexts = [];
    let methodPaths = [];
    let routeMap = {};
    let listenPaths = [];
    let strictSchema = {};
    let currentTarget = target;
    function buildDispatch(t) {
        const m = [], cx = [], paths = [], rm = {}, lp = [];
        const resolved = transformTree(t);
        (function index(obj, prefix) {
            for (const k of Object.keys(obj)) {
                if (!(0, rpc_limits_1.isSafeKey)(k))
                    continue;
                const v = obj[k];
                const path = [...prefix, k];
                if (typeof v == "function") {
                    rm[(0, rpc_path_1.rpcPathKey)(path)] = m.length;
                    m.push(v);
                    cx.push(obj);
                    paths.push(path);
                }
                else if (v && typeof v == "object" && !(0, rpc_dynamic_1.isNoStrict)(v)) {
                    if (hasRpcListen(v))
                        lp.push((0, rpc_path_1.rpcPathKey)(path));
                    index(v, path);
                }
            }
        })(resolved, []);
        methods = m;
        contexts = cx;
        methodPaths = paths;
        routeMap = rm;
        listenPaths = lp;
        strictSchema = serialize(resolved);
        currentTarget = t;
    }
    buildDispatch(target);
    const send = (d) => socket.emit(key, d);
    const serverCaps = (0, rpc_caps_1.optToCaps)(opt);
    let peerCaps = 0;
    const compactOn = () => (0, rpc_caps_1.hasCap)(serverCaps & peerCaps, rpc_caps_1.Caps.COMPACT);
    const cbShapes = (0, rpc_shape_1.createCbShapeServer)();
    const sendCb = (cbId, cbArgs) => {
        if (compactOn() && cbArgs.length == 1 && (0, rpc_shape_1.isPlainObject)(cbArgs[0])) {
            const obj = cbArgs[0];
            const r = cbShapes.offer(cbId, obj);
            if (r.mode == "register") {
                send([rpc_protocol_1.Pkt.SHAPE, cbId, r.shapeId, r.keys]);
                send([rpc_protocol_1.Pkt.CBV, cbId, r.shapeId, r.keys.map(k => (0, rpc_walk_1.packResult)(obj[k]))]);
                return;
            }
            if (r.mode == "compact") {
                send([rpc_protocol_1.Pkt.CBV, cbId, r.shapeId, r.keys.map(k => (0, rpc_walk_1.packResult)(obj[k]))]);
                return;
            }
        }
        send([rpc_protocol_1.Pkt.CB, cbId, cbArgs.map(rpc_walk_1.packResult)]);
    };
    const sendCbEnd = (cbId) => { cbShapes.drop(cbId); send([rpc_protocol_1.Pkt.CB_END, cbId]); };
    let authed = !auth?.gate;
    let authAck = undefined;
    let helloInFlight = null;
    const sendMap = () => send(authAck !== undefined
        ? [rpc_protocol_1.Pkt.MAP, routeMap, strictSchema, listenPaths, authAck]
        : [rpc_protocol_1.Pkt.MAP, routeMap, strictSchema, listenPaths]);
    if (!auth?.resolveAuth)
        sendMap();
    if (serverCaps)
        send([rpc_protocol_1.Pkt.CAPS, serverCaps]);
    let detached = false;
    let byKey = SERVERS.get(socket);
    if (!byKey) {
        byKey = new Map();
        SERVERS.set(socket, byKey);
    }
    const detachPrev = byKey.get(key);
    if (detachPrev) {
        detachPrev();
        console.warn(`[RPC] createRpcServer: repeated initialization on socket+key "${key}" — previous server detached`);
    }
    byKey.set(key, () => { detached = true; hooks?.onDispose?.(); });
    socket.on(key, async (msg) => {
        if (detached)
            return;
        if (msg == rpc_protocol_1.Pkt.STRICT) {
            const hello = helloInFlight;
            if (hello) {
                await hello;
                return;
            }
            sendMap();
            return;
        }
        if (Array.isArray(msg) && msg[0] === rpc_protocol_1.Pkt.CAPS) {
            peerCaps = typeof msg[1] === "number" ? msg[1] : rpc_caps_1.Caps.COMPACT;
            return;
        }
        if (Array.isArray(msg) && msg[0] === rpc_protocol_1.Pkt.HELLO) {
            if (!auth?.resolveAuth) {
                send([rpc_protocol_1.Pkt.MAP, routeMap, strictSchema, listenPaths, null]);
                return;
            }
            async function resolveHello() {
                try {
                    const r = await auth.resolveAuth(msg[1]);
                    if (r && r.object !== undefined)
                        buildDispatch(r.object);
                    authAck = r && r.ack !== undefined ? r.ack : { ok: true };
                    authed = authAck?.ok !== false;
                    sendMap();
                }
                catch (e) {
                    send([rpc_protocol_1.Pkt.MAP, routeMap, strictSchema, listenPaths, { ok: false, reason: e?.message ?? String(e) }]);
                }
            }
            const hello = resolveHello();
            helloInFlight = hello;
            try {
                await hello;
            }
            finally {
                if (helloInFlight == hello)
                    helloInFlight = null;
            }
            return;
        }
        if (!Array.isArray(msg) || (msg[0] !== rpc_protocol_1.Pkt.CALL && msg[0] !== rpc_protocol_1.Pkt.PIPE))
            return;
        const hello = helloInFlight;
        if (hello) {
            await hello;
            if (detached)
                return;
        }
        const isPipe = msg[0] === rpc_protocol_1.Pkt.PIPE;
        const [, reqId, ref, rawArgsOrSteps, w] = msg;
        const wait = w !== false;
        if (typeof reqId !== "number" || !Number.isFinite(reqId)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "reqId is not a valid number" });
            return;
        }
        if (!authed) {
            if (wait)
                send([rpc_protocol_1.Pkt.RESP, reqId, null, (0, rpc_walk_1.errToObj)(new myThrow_1.MyError("Unauthorized", "E_UNAUTHORIZED"))]);
            return;
        }
        if (typeof ref !== "number" && !Array.isArray(ref)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "ref must be number or string[]" });
            if (wait)
                send([rpc_protocol_1.Pkt.RESP, reqId, null, (0, rpc_walk_1.errToObj)(new Error("Invalid ref type"))]);
            return;
        }
        if (!Array.isArray(rawArgsOrSteps)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "args/steps must be an array" });
            if (wait)
                send([rpc_protocol_1.Pkt.RESP, reqId, null, (0, rpc_walk_1.errToObj)(new Error("Invalid args: expected array"))]);
            return;
        }
        try {
            let fn, ctx;
            if (typeof ref == "number") {
                fn = methods[ref];
                ctx = contexts[ref];
            }
            else {
                if (!ref.every((s) => typeof s == "string" && (0, rpc_limits_1.isSafeKey)(s))) {
                    hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps });
                    if (wait)
                        send([rpc_protocol_1.Pkt.RESP, reqId, null, (0, rpc_walk_1.errToObj)(new Error("Forbidden path segment"))]);
                    return;
                }
                if (ref.length > lim.maxPathLen) {
                    hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "path too long" });
                    if (wait)
                        send([rpc_protocol_1.Pkt.RESP, reqId, null, (0, rpc_walk_1.errToObj)(new rpc_limits_1.PayloadLimitError("path too long"))]);
                    return;
                }
                const idx = routeMap[(0, rpc_path_1.rpcPathKey)(ref)];
                if (idx !== undefined) {
                    fn = methods[idx];
                    ctx = contexts[idx];
                }
                else {
                    let curr = currentTarget;
                    for (let i = 0; i < ref.length - 1; i++) {
                        const seg = ref[i];
                        if (curr == null || typeof curr !== "object" || !(seg in curr)) {
                            curr = undefined;
                            break;
                        }
                        curr = curr[seg];
                        if (hooks?.resolveTransform && !(0, rpc_dynamic_1.isNoStrict)(curr))
                            curr = hooks.resolveTransform(curr);
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
                if (wait)
                    send([rpc_protocol_1.Pkt.RESP, reqId, null, (0, rpc_walk_1.errToObj)(new Error("Not a function: " + ref))]);
                return;
            }
            if (hooks?.onRequest) {
                const keyArr = typeof ref == "number"
                    ? methodPaths[ref] ?? []
                    : ref;
                const allowed = await hooks.onRequest({ key: keyArr, request: rawArgsOrSteps, fnName: keyArr[keyArr.length - 1] ?? "", fn: fn });
                if (allowed == false) {
                    if (wait)
                        send([rpc_protocol_1.Pkt.RESP, reqId, null, (0, rpc_walk_1.errToObj)(new Error("Rejected by hook"))]);
                    return;
                }
            }
            if (isPipe) {
                const steps = rawArgsOrSteps;
                let current = fn.bind(ctx);
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
                        if (current == null)
                            throw new Error(`Cannot read property '${step.prop}' of ${current}`);
                        current = current[step.prop];
                    }
                    else if (step.type === 'call') {
                        if (typeof current !== "function")
                            throw new Error("Attempted to call a non-function in pipe");
                        const stepArgs = (0, rpc_walk_1.unpack)(step.args, sendCb, sendCbEnd, lim);
                        current = current(...stepArgs);
                    }
                }
                if (current && typeof current.then === "function") {
                    current = await current;
                }
                if (wait)
                    send([rpc_protocol_1.Pkt.RESP, reqId, (0, rpc_walk_1.packResult)(current)]);
            }
            else {
                const args = (0, rpc_walk_1.unpack)(rawArgsOrSteps, sendCb, sendCbEnd, lim);
                const res = await fn.apply(ctx, args);
                if (wait)
                    send([rpc_protocol_1.Pkt.RESP, reqId, (0, rpc_walk_1.packResult)(res)]);
            }
        }
        catch (e) {
            if (wait)
                send([rpc_protocol_1.Pkt.RESP, reqId, null, (0, rpc_walk_1.errToObj)(e)]);
        }
    });
}
function createRpcServer({ socket, object: target, socketKey: key, debug = false, hooks, limits, auth, opt }) {
    if (debug) {
        const origOn = socket.on.bind(socket);
        socket.on = (e, cb) => origOn(e, (d) => { console.log("[RPC IN]", typeof d == "object" ? JSON.stringify(d) : d); cb(d); });
    }
    createServer(socket, key, target, hooks, limits, auth, opt);
}
