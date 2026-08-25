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
const rpc_callback_batch_1 = require("./rpc-callback-batch");
const rpc_flow_1 = require("./rpc-flow");
const myThrow_1 = require("../../toError/myThrow");
const SERVERS = new WeakMap();
const MAX_CLIENT_SESSIONS = 16;
let serverGenerationCounter = 0;
function nextServerGeneration() {
    if (serverGenerationCounter >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError('RPC server generation space exhausted');
    }
    return ++serverGenerationCounter;
}
function invalidPipeStep(steps) {
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step == null || typeof step != "object" || Array.isArray(step))
            return `pipe step ${i}: not an object`;
        if (step.type === "get") {
            if (typeof step.prop != "string")
                return `pipe step ${i}: get prop must be a string`;
            if (!(0, rpc_limits_1.isSafeKey)(step.prop))
                return `pipe step ${i}: forbidden path segment`;
            continue;
        }
        if (step.type === "call") {
            if (!Array.isArray(step.args))
                return `pipe step ${i}: call args must be an array`;
            continue;
        }
        return `pipe step ${i}: unknown step type`;
    }
    return null;
}
const reachableMember = (obj, key, dynamic) => dynamic ? key in obj : Object.prototype.hasOwnProperty.call(obj, key);
function createServer(socket, key, target, hooks, limits, auth, opt, debug = false) {
    const lim = (0, rpc_limits_1.resolveLimits)(limits);
    const onReserved = debug
        ? function reportReservedKey(markerKey) {
            console.log('[RPC OUT] reserved key', markerKey, '— an application value of this shape is decoded as a library value by the peer');
        }
        : undefined;
    const IS_RPC_PIPE = Symbol.for("isRpcPipe");
    const hasRpcListen = (obj) => !!obj && typeof obj == "object" && Object.prototype.hasOwnProperty.call(obj, rpc_protocol_1.IS_RPC_LISTEN);
    const listenNodeOrigin = new WeakMap();
    function transformTree(obj) {
        let current = obj;
        if (hooks?.resolveTransform && !(0, rpc_dynamic_1.isNoStrict)(current)) {
            current = hooks.resolveTransform(current);
        }
        if (current == null || typeof current != "object" || (0, rpc_dynamic_1.isNoStrict)(current))
            return current;
        const out = {};
        if (hasRpcListen(current)) {
            out[rpc_protocol_1.IS_RPC_LISTEN] = true;
            listenNodeOrigin.set(out, current);
        }
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
    let listenNodes = [];
    let strictSchema = {};
    let currentTarget = target;
    function buildDispatch(t) {
        const m = [], cx = [], paths = [], rm = {}, lp = [], ln = [];
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
                    if (hasRpcListen(v)) {
                        lp.push((0, rpc_path_1.rpcPathKey)(path));
                        ln.push(listenNodeOrigin.get(v) ?? v);
                    }
                    index(v, path);
                }
            }
        })(resolved, []);
        methods = m;
        contexts = cx;
        methodPaths = paths;
        routeMap = rm;
        listenPaths = lp;
        listenNodes = ln;
        strictSchema = serialize(resolved);
        currentTarget = t;
    }
    buildDispatch(target);
    let detached = false;
    function sendRaw(d) {
        if (!detached)
            socket.emit(key, d);
    }
    const serverCaps = (0, rpc_caps_1.optToCaps)(opt);
    const serverGeneration = nextServerGeneration();
    const shapeRegistry = (0, rpc_shape_1.createShapeRegistry)();
    const rowEncoder = (0, rpc_shape_1.createRowEncoder)(shapeRegistry);
    const rawCallbackBatch = (0, rpc_callback_batch_1.createCallbackPacketBatcher)({
        send: sendRaw,
        opt: opt?.callbackBatch,
    });
    const rawRequestBatch = (0, rpc_callback_batch_1.createCallbackPacketBatcher)({
        send: sendRaw,
        opt: opt?.requestBatch,
        envelope: rpc_protocol_1.Pkt.BATCH,
    });
    function createSession(id, peerCaps) {
        const reqBatch = (0, rpc_caps_1.hasCap)(serverCaps & peerCaps, rpc_caps_1.Caps.CB_BATCH | rpc_caps_1.Caps.REQ_BATCH);
        const rowsOn = (0, rpc_caps_1.hasCap)(serverCaps & peerCaps, rpc_caps_1.Caps.COMPACT | rpc_caps_1.Caps.ROWS);
        return {
            id,
            peerCaps,
            reqBatch,
            rows: rowsOn ? rowEncoder : undefined,
            rawBatch: reqBatch ? rawRequestBatch : rawCallbackBatch,
        };
    }
    const legacySession = createSession(0, 0);
    const sessions = new Map();
    const sessionByClient = new Map();
    const clientBySession = new Map();
    const legacyChannel = { session: legacySession };
    function removeSession(sessionId) {
        const session = sessions.get(sessionId);
        if (session)
            flushSession(session);
        sessions.delete(sessionId);
        shapeRegistry.forgetSession(sessionId);
        const clientId = clientBySession.get(sessionId);
        clientBySession.delete(sessionId);
        if (clientId != undefined && sessionByClient.get(clientId) == sessionId) {
            sessionByClient.delete(clientId);
        }
    }
    function flushSession(session) {
        session.rawBatch.flush();
    }
    function flushAllSessions() {
        rawCallbackBatch.flush();
        rawRequestBatch.flush();
    }
    function sendChannel(channel, d) {
        if (detached)
            return;
        if (channel.session.reqBatch) {
            channel.session.rawBatch.enqueue(d);
            return;
        }
        flushSession(channel.session);
        sendRaw(d);
    }
    function callbackBatchOn(channel) {
        return (0, rpc_caps_1.hasCap)(serverCaps & channel.session.peerCaps, rpc_caps_1.Caps.CB_BATCH);
    }
    function sendCallbackPacket(channel, packet) {
        if (detached)
            return;
        if (!callbackBatchOn(channel)) {
            sendChannel(channel, packet);
            return;
        }
        channel.session.rawBatch.enqueue(packet);
    }
    const flows = new Map();
    function defaultFlowPending() {
        const conn = socket?.conn;
        if (conn && Array.isArray(conn.writeBuffer)) {
            return function pendingTransportPackets() { return conn.writeBuffer.length; };
        }
        return undefined;
    }
    function transportDown() {
        const s = socket;
        return s.disconnected === true || s.connected === false;
    }
    function creditBlocked(flow) {
        return flow.negotiated && flow.sent - flow.acked >= flow.window;
    }
    function watermarkBlocked(flow) {
        if (!flow.pending)
            return false;
        const n = flow.pending();
        if (flow.draining) {
            if (n > flow.lowWater)
                return true;
            flow.draining = false;
            return false;
        }
        if (n > flow.highWater) {
            flow.draining = true;
            return true;
        }
        return false;
    }
    function flowWait(flow) {
        if (flow.closedReason != null)
            return Promise.reject((0, rpc_flow_1.rpcFlowClosedError)(flow.closedReason));
        if (!creditBlocked(flow) && !watermarkBlocked(flow))
            return Promise.resolve();
        return new Promise(function waitForFlowWindow(resolve, reject) {
            flow.waiters.push({ resolve, reject });
            if (!flow.timer) {
                flow.timer = setInterval(function pollFlowWindow() {
                    if (transportDown()) {
                        closeFlow(flow.cbId, 'disconnected');
                        return;
                    }
                    wakeFlow(flow);
                }, flow.pollMs);
                flow.timer.unref?.();
            }
        });
    }
    function wakeFlow(flow) {
        if (flow.closedReason != null || flow.waiters.length == 0)
            return;
        if (creditBlocked(flow) || watermarkBlocked(flow))
            return;
        const waiters = flow.waiters;
        flow.waiters = [];
        if (flow.timer) {
            clearInterval(flow.timer);
            flow.timer = null;
        }
        for (const w of waiters)
            w.resolve();
    }
    function closeFlow(cbId, reason) {
        const flow = flows.get(cbId);
        if (!flow)
            return;
        flows.delete(cbId);
        flow.closedReason = reason;
        if (flow.timer) {
            clearInterval(flow.timer);
            flow.timer = null;
        }
        const waiters = flow.waiters;
        flow.waiters = [];
        for (const w of waiters)
            w.reject((0, rpc_flow_1.rpcFlowClosedError)(reason));
    }
    function closeAllFlows(reason) {
        for (const cbId of [...flows.keys()])
            closeFlow(cbId, reason);
    }
    function createFlowHost(channel, settleScope) {
        return function flowHostForCallback(cbId) {
            return function openFlow(opts) {
                const existing = flows.get(cbId);
                if (existing)
                    return existing.gate;
                const window = Number.isSafeInteger(opts?.window) && opts.window > 0 ? opts.window : 32;
                const ackEvery = Number.isSafeInteger(opts?.ackEvery) && opts.ackEvery > 0
                    ? Math.min(opts.ackEvery, window)
                    : Math.max(1, window >> 2);
                const highWater = Number.isFinite(opts?.highWater) && opts.highWater > 0 ? opts.highWater : 128;
                const lowWater = Number.isFinite(opts?.lowWater) && opts.lowWater >= 0
                    ? Math.min(opts.lowWater, highWater)
                    : Math.floor(highWater / 4);
                const flow = {
                    cbId,
                    negotiated: !detached && (0, rpc_caps_1.hasCap)(serverCaps & channel.session.peerCaps, rpc_caps_1.Caps.CB_FLOW),
                    window,
                    sent: 0,
                    acked: 0,
                    draining: false,
                    closedReason: null,
                    waiters: [],
                    pending: opts?.pending ?? defaultFlowPending(),
                    highWater,
                    lowWater,
                    pollMs: Number.isFinite(opts?.pollMs) && opts.pollMs > 0 ? opts.pollMs : 25,
                    timer: null,
                    gate: undefined,
                };
                flow.gate = {
                    wait: function waitFlow() { return flowWait(flow); },
                    pending: function pendingFlow() {
                        return flow.negotiated ? flow.sent - flow.acked : (flow.pending?.() ?? 0);
                    },
                    closedReason: function flowClosedReason() { return flow.closedReason; },
                };
                if (detached) {
                    flow.closedReason = 'detached';
                    return flow.gate;
                }
                flows.set(cbId, flow);
                settleScope?.add(cbId);
                if (flow.negotiated)
                    sendCallbackPacket(channel, [rpc_protocol_1.Pkt.CB_FLOW, cbId, ackEvery]);
                return flow.gate;
            };
        };
    }
    const cbShapes = (0, rpc_shape_1.createCbShapeServer)();
    function sendCb(channel, cbId, cbArgs) {
        const flow = flows.get(cbId);
        if (flow)
            flow.sent++;
        const compactOn = (0, rpc_caps_1.hasCap)(serverCaps & channel.session.peerCaps, rpc_caps_1.Caps.COMPACT);
        const rows = channel.session.rows;
        if (compactOn && cbArgs.length == 1 && (0, rpc_shape_1.isPlainObject)(cbArgs[0])) {
            const obj = cbArgs[0];
            const r = rows ? shapeRegistry.offerTick(channel.session.id, obj) : cbShapes.offer(cbId, obj);
            function packShapeValue(key) {
                return (0, rpc_walk_1.packResult)(obj[key], rows, onReserved);
            }
            if (r.mode == 'register') {
                sendCallbackPacket(channel, [rpc_protocol_1.Pkt.SHAPE, cbId, r.shapeId, r.keys]);
                sendCallbackPacket(channel, [rpc_protocol_1.Pkt.CBV, cbId, r.shapeId, r.keys.map(packShapeValue)]);
                return;
            }
            if (r.mode == 'compact') {
                sendCallbackPacket(channel, [rpc_protocol_1.Pkt.CBV, cbId, r.shapeId, r.keys.map(packShapeValue)]);
                return;
            }
        }
        sendCallbackPacket(channel, [rpc_protocol_1.Pkt.CB, cbId, cbArgs.map(function packCbArg(a) { return (0, rpc_walk_1.packResult)(a, rows, onReserved); })]);
    }
    function sendCbEnd(channel, cbId) {
        closeFlow(cbId, 'ended');
        cbShapes.drop(cbId);
        sendChannel(channel, [rpc_protocol_1.Pkt.CB_END, cbId]);
    }
    function sendResult(channel, reqId, value) {
        sendChannel(channel, [rpc_protocol_1.Pkt.RESP, reqId, (0, rpc_walk_1.packResult)(value, channel.session.rows, onReserved)]);
    }
    function fallbackSerializationError(error) {
        const source = error instanceof Error ? error.message : String(error);
        const reason = source.length > 2_000 ? source.slice(0, 2_000) + '…' : source;
        return new TypeError('RPC response serialization failed: ' + reason);
    }
    function reportInvalid(ctx) {
        try {
            void Promise.resolve(hooks?.onInvalid?.(ctx)).catch(function ignoreInvalidHookFailure() { });
        }
        catch { }
    }
    function sendError(channel, reqId, error) {
        try {
            sendChannel(channel, [rpc_protocol_1.Pkt.RESP, reqId, null, (0, rpc_walk_1.errToObj)(error)]);
        }
        catch (serializationError) {
            sendChannel(channel, [
                rpc_protocol_1.Pkt.RESP,
                reqId,
                null,
                (0, rpc_walk_1.errToObj)(fallbackSerializationError(serializationError)),
            ]);
        }
    }
    let authed = !auth?.gate;
    let authAck = undefined;
    let helloInFlight = null;
    function sendCapsChallenge() {
        flushAllSessions();
        sendRaw([rpc_protocol_1.Pkt.CAPS, serverCaps, null, serverGeneration]);
    }
    function mapReply(ack, helloId) {
        return helloId === undefined
            ? [rpc_protocol_1.Pkt.MAP, routeMap, strictSchema, listenPaths, ack]
            : [rpc_protocol_1.Pkt.MAP, routeMap, strictSchema, listenPaths, ack, helloId];
    }
    function replyHelloId(raw) {
        if (!(0, rpc_caps_1.hasCap)(serverCaps, rpc_caps_1.Caps.HELLO_ID))
            return undefined;
        return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
    }
    function sendMap(helloId) {
        sendCapsChallenge();
        flushAllSessions();
        sendRaw(authAck !== undefined
            ? mapReply(authAck, helloId)
            : [rpc_protocol_1.Pkt.MAP, routeMap, strictSchema, listenPaths]);
    }
    const DEFAULT_RENEW_BEFORE_MS = 30_000;
    const MAX_TIMER_MS = 2_147_483_647;
    let expiringTimer = null;
    let expiryTimer = null;
    function authStateOn() {
        if (!(0, rpc_caps_1.hasCap)(serverCaps, rpc_caps_1.Caps.AUTH_STATE))
            return false;
        if ((0, rpc_caps_1.hasCap)(legacySession.peerCaps, rpc_caps_1.Caps.AUTH_STATE))
            return true;
        for (const session of sessions.values()) {
            if ((0, rpc_caps_1.hasCap)(session.peerCaps, rpc_caps_1.Caps.AUTH_STATE))
                return true;
        }
        return false;
    }
    function sendAuthState(notice) {
        if (detached || !authStateOn())
            return;
        flushAllSessions();
        sendRaw([rpc_protocol_1.Pkt.AUTH, notice]);
    }
    function clearAuthTimers() {
        if (expiringTimer) {
            expiringTimer.cancel();
            expiringTimer = null;
        }
        if (expiryTimer) {
            expiryTimer.cancel();
            expiryTimer = null;
        }
    }
    function startAuthTimer(at, fn) {
        let timer = null;
        function armChunk() {
            const left = at - Date.now();
            timer = left > MAX_TIMER_MS ? setTimeout(armChunk, MAX_TIMER_MS) : setTimeout(fn, Math.max(left, 0));
            timer.unref?.();
        }
        armChunk();
        return { cancel: () => clearTimeout(timer) };
    }
    function armAuthTimers(expiresAt, renewBeforeMs) {
        clearAuthTimers();
        if (detached)
            return;
        if (expiresAt == Infinity)
            return;
        const deadline = Number.isFinite(expiresAt) ? expiresAt : Date.now();
        const remaining = deadline - Date.now();
        const before = Math.min(Math.max(renewBeforeMs ?? DEFAULT_RENEW_BEFORE_MS, 0), Math.max(remaining, 0));
        if (remaining > 0) {
            expiringTimer = startAuthTimer(deadline - before, function warnExpiring() {
                expiringTimer = null;
                sendAuthState({ state: 'expiring', expiresAt: deadline });
            });
        }
        expiryTimer = startAuthTimer(deadline, function expirePrincipal() {
            expiryTimer = null;
            downgradePrincipal('expired', 'token expired');
        });
    }
    function applyPrincipal(object) {
        const previous = listenNodes;
        buildDispatch(object);
        const keep = new Set(listenNodes);
        hooks?.onPrincipalChange?.({ keep, drop: new Set(previous.filter(node => !keep.has(node))) });
    }
    function withGrantDeadline(ack, expiresAt) {
        if (expiresAt == undefined || !Number.isFinite(expiresAt))
            return ack;
        if (!(0, rpc_shape_1.isPlainObject)(ack) || rpc_protocol_1.GRANT_FACTS_KEY in ack)
            return ack;
        return { ...ack, [rpc_protocol_1.GRANT_FACTS_KEY]: { expiresAt } };
    }
    function applyGrant(r, helloId) {
        if (detached)
            return false;
        clearAuthTimers();
        if (r && r.object !== undefined)
            applyPrincipal(r.object);
        authAck = withGrantDeadline(r && r.ack !== undefined ? r.ack : { ok: true }, r?.expiresAt);
        authed = authAck?.ok !== false ? true : !auth?.gate;
        if (r && r.expiresAt != undefined)
            armAuthTimers(r.expiresAt, r.renewBeforeMs);
        sendMap(helloId);
        return true;
    }
    function downgradePrincipal(state, reason, helloId) {
        if (detached)
            return;
        clearAuthTimers();
        sendAuthState({ state, reason });
        applyPrincipal(target);
        authAck = { ok: false, state, reason };
        authed = !auth?.gate;
        sendMap(helloId);
    }
    let revokeEpoch = 0;
    const control = {
        revoke: function revokePrincipal(reason) {
            if (detached)
                return false;
            revokeEpoch++;
            downgradePrincipal('revoked', reason ?? 'revoked by application');
            return true;
        },
        grant: function grantPrincipal(grant) {
            return applyGrant(grant);
        },
    };
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
    function detachServer() {
        if (detached)
            return;
        flushAllSessions();
        clearAuthTimers();
        closeAllFlows('detached');
        detached = true;
        sessions.clear();
        sessionByClient.clear();
        clientBySession.clear();
        hooks?.onDispose?.();
    }
    byKey.set(key, detachServer);
    async function handleServerPacket(incoming) {
        if (detached)
            return;
        const msg = incoming;
        let channel = legacyChannel;
        if (typeof msg == 'number' && msg == rpc_protocol_1.Pkt.STRICT) {
            const hello = helloInFlight;
            if (hello) {
                await hello;
                return;
            }
            sendMap();
            return;
        }
        if (Array.isArray(msg) && msg[0] == rpc_protocol_1.Pkt.CAPS) {
            flushAllSessions();
            const announced = typeof msg[1] == 'number' ? msg[1] : rpc_caps_1.Caps.COMPACT;
            const sessionId = msg[2];
            const generation = msg[3];
            const clientId = msg[4];
            if (Number.isSafeInteger(sessionId) && sessionId > 0
                && generation == serverGeneration) {
                if (!Number.isSafeInteger(clientId) || clientId <= 0) {
                    await hooks?.onInvalid?.({
                        reason: 'invalid_payload',
                        request: msg,
                        error: 'RPC session requires a client id',
                    });
                    return;
                }
                const owner = clientBySession.get(sessionId);
                if (owner != undefined && owner != clientId) {
                    await hooks?.onInvalid?.({
                        reason: 'invalid_payload',
                        request: msg,
                        error: 'RPC session belongs to another client',
                    });
                    return;
                }
                const previousId = sessionByClient.get(clientId);
                if (previousId != undefined && previousId != sessionId) {
                    removeSession(previousId);
                }
                sessionByClient.set(clientId, sessionId);
                clientBySession.set(sessionId, clientId);
                let session = sessions.get(sessionId);
                if (!session || session.peerCaps != announced) {
                    if (!session && sessions.size >= MAX_CLIENT_SESSIONS) {
                        sessionByClient.delete(clientId);
                        clientBySession.delete(sessionId);
                        await hooks?.onInvalid?.({
                            reason: 'rate_limit',
                            request: msg,
                            error: 'too many RPC sessions',
                        });
                        return;
                    }
                    if (session)
                        flushSession(session);
                    session = createSession(sessionId, announced);
                    sessions.set(sessionId, session);
                }
                sendRaw([rpc_protocol_1.Pkt.CAPS, serverCaps, sessionId, serverGeneration]);
                return;
            }
            legacySession.peerCaps = announced & (rpc_caps_1.Caps.COMPACT | rpc_caps_1.Caps.AUTH_STATE);
            sendRaw([rpc_protocol_1.Pkt.CAPS, serverCaps]);
            sendCapsChallenge();
            return;
        }
        if (Array.isArray(msg) && msg[0] === rpc_protocol_1.Pkt.HELLO) {
            const helloId = replyHelloId(msg[2]);
            if (!auth?.resolveAuth) {
                sendCapsChallenge();
                sendRaw(mapReply(null, helloId));
                return;
            }
            async function resolveHello() {
                const epoch = revokeEpoch;
                try {
                    const r = await auth.resolveAuth(msg[1]);
                    if (detached)
                        return;
                    if (revokeEpoch != epoch) {
                        sendCapsChallenge();
                        sendRaw(mapReply(authAck, helloId));
                        return;
                    }
                    applyGrant(r, helloId);
                }
                catch (e) {
                    if (e?.revoke === true) {
                        downgradePrincipal('revoked', e?.message ?? String(e), helloId);
                        return;
                    }
                    sendCapsChallenge();
                    sendRaw(mapReply({ ok: false, reason: e?.message ?? String(e) }, helloId));
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
        if (Array.isArray(msg) && msg[0] == rpc_protocol_1.Pkt.CB_ACK) {
            const cbId = msg[1];
            const count = msg[2];
            if (!Number.isSafeInteger(cbId) || !Number.isSafeInteger(count) || count < 0)
                return;
            const flow = flows.get(cbId);
            if (!flow || count <= flow.acked)
                return;
            flow.acked = Math.min(count, flow.sent);
            wakeFlow(flow);
            return;
        }
        if (Array.isArray(msg) && msg[0] == rpc_protocol_1.Pkt.BATCH) {
            if (!(0, rpc_caps_1.hasCap)(serverCaps, rpc_caps_1.Caps.CB_BATCH | rpc_caps_1.Caps.REQ_BATCH))
                return;
            const batched = msg[1];
            if (!Array.isArray(batched) || batched.length > rpc_callback_batch_1.MAX_BATCH_ITEMS)
                return;
            for (const packet of batched) {
                if (!Array.isArray(packet) || (packet[0] != rpc_protocol_1.Pkt.CALL && packet[0] != rpc_protocol_1.Pkt.PIPE))
                    continue;
                void handleServerPacket(packet);
            }
            return;
        }
        if (!Array.isArray(msg) || (msg[0] != rpc_protocol_1.Pkt.CALL && msg[0] != rpc_protocol_1.Pkt.PIPE))
            return;
        if (Number.isSafeInteger(msg[5])) {
            const session = sessions.get(msg[5]);
            if (session)
                channel = { session };
        }
        const hello = helloInFlight;
        if (hello) {
            await hello;
            if (detached)
                return;
        }
        const isPipe = msg[0] == rpc_protocol_1.Pkt.PIPE;
        const [, reqId, ref, rawArgsOrSteps, w] = msg;
        const wait = w !== false;
        if (!Number.isSafeInteger(reqId) || reqId < 0) {
            reportInvalid({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "reqId is not a valid number" });
            return;
        }
        if (!authed) {
            if (wait)
                sendError(channel, reqId, new myThrow_1.MyError("Unauthorized", "E_UNAUTHORIZED"));
            return;
        }
        if (typeof ref !== "number" && !Array.isArray(ref)) {
            reportInvalid({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "ref must be number or string[]" });
            if (wait)
                sendError(channel, reqId, new Error("Invalid ref type"));
            return;
        }
        if (!Array.isArray(rawArgsOrSteps)) {
            reportInvalid({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "args/steps must be an array" });
            if (wait)
                sendError(channel, reqId, new Error("Invalid args: expected array"));
            return;
        }
        if (isPipe) {
            const badStep = invalidPipeStep(rawArgsOrSteps);
            if (badStep) {
                reportInvalid({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: badStep });
                if (wait)
                    sendError(channel, reqId, new Error(badStep));
                return;
            }
        }
        const settleScope = wait ? new Set() : undefined;
        try {
            let fn, ctx;
            if (typeof ref == "number") {
                fn = methods[ref];
                ctx = contexts[ref];
            }
            else {
                if (!ref.every((s) => typeof s == "string" && (0, rpc_limits_1.isSafeKey)(s))) {
                    reportInvalid({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps });
                    if (wait)
                        sendError(channel, reqId, new Error("Forbidden path segment"));
                    return;
                }
                if (ref.length > lim.maxPathLen) {
                    reportInvalid({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "path too long" });
                    if (wait)
                        sendError(channel, reqId, new rpc_limits_1.PayloadLimitError("path too long"));
                    return;
                }
                const idx = routeMap[(0, rpc_path_1.rpcPathKey)(ref)];
                if (idx !== undefined) {
                    fn = methods[idx];
                    ctx = contexts[idx];
                }
                else {
                    let curr = currentTarget;
                    let dynamic = (0, rpc_dynamic_1.isNoStrict)(curr);
                    for (let i = 0; i < ref.length - 1; i++) {
                        const seg = ref[i];
                        if (curr == null || typeof curr !== "object" || !reachableMember(curr, seg, dynamic)) {
                            curr = undefined;
                            break;
                        }
                        curr = curr[seg];
                        if (hooks?.resolveTransform && !(0, rpc_dynamic_1.isNoStrict)(curr))
                            curr = hooks.resolveTransform(curr);
                        if ((0, rpc_dynamic_1.isNoStrict)(curr))
                            dynamic = true;
                    }
                    const last = ref[ref.length - 1];
                    if (curr != null && typeof curr == "object") {
                        ctx = curr;
                        fn = reachableMember(curr, last, dynamic) ? curr[last] : undefined;
                    }
                }
            }
            if (typeof fn !== "function") {
                reportInvalid({ reason: "not_function", key: ref, request: rawArgsOrSteps });
                if (wait)
                    sendError(channel, reqId, new Error("Not a function: " + ref));
                return;
            }
            if (hooks?.onRequest) {
                const keyArr = typeof ref == "number"
                    ? methodPaths[ref] ?? []
                    : ref;
                const allowed = await hooks.onRequest({ key: keyArr, request: rawArgsOrSteps, fnName: keyArr[keyArr.length - 1] ?? "", fn: fn });
                if (allowed == false) {
                    if (wait)
                        sendError(channel, reqId, new Error("Rejected by hook"));
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
                        const stepArgs = (0, rpc_walk_1.unpack)(step.args, (id, args) => sendCb(channel, id, args), id => sendCbEnd(channel, id), lim, createFlowHost(channel, settleScope));
                        current = current(...stepArgs);
                    }
                }
                if (current && typeof current.then === "function") {
                    current = await current;
                }
                if (wait)
                    sendResult(channel, reqId, current);
            }
            else {
                const args = (0, rpc_walk_1.unpack)(rawArgsOrSteps, (id, values) => sendCb(channel, id, values), id => sendCbEnd(channel, id), lim, createFlowHost(channel, settleScope));
                const res = await fn.apply(ctx, args);
                if (wait)
                    sendResult(channel, reqId, res);
            }
        }
        catch (e) {
            if (wait)
                sendError(channel, reqId, e);
        }
        finally {
            if (settleScope)
                for (const id of settleScope)
                    closeFlow(id, 'settled');
        }
    }
    socket.on(key, handleServerPacket);
    if (auth?.resolveAuth)
        sendCapsChallenge();
    else
        sendMap();
    return { control };
}
function createRpcServer({ socket, object: target, socketKey: key, debug = false, hooks, limits, auth, opt }) {
    if (debug) {
        const origOn = socket.on.bind(socket);
        function debugPacket(value) {
            if (value instanceof ArrayBuffer)
                return `[binary ${value.byteLength} bytes]`;
            if (ArrayBuffer.isView(value))
                return `[binary ${value.byteLength} bytes]`;
            if (typeof value != 'object')
                return value;
            try {
                return JSON.stringify(value);
            }
            catch {
                return String(value);
            }
        }
        socket.on = (e, cb) => origOn(e, (d) => { console.log('[RPC IN]', debugPacket(d)); cb(d); });
    }
    return createServer(socket, key, target, hooks, limits, auth, opt, debug);
}
