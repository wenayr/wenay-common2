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
const rpc_binary_envelope_1 = require("./rpc-binary-envelope");
const rpc_binary_peer_1 = require("./rpc-binary-peer");
const rpc_binary_walk_1 = require("./rpc-binary-walk");
const myThrow_1 = require("../../toError/myThrow");
const SERVERS = new WeakMap();
const MAX_BINARY_SESSIONS = 16;
let serverGenerationCounter = 0;
function nextServerGeneration() {
    if (serverGenerationCounter >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError('RPC server generation space exhausted');
    }
    return ++serverGenerationCounter;
}
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
    let detached = false;
    function sendRaw(d) {
        if (!detached)
            socket.emit(key, d);
    }
    const serverCaps = (0, rpc_caps_1.optToCaps)(opt);
    const serverGeneration = nextServerGeneration();
    const maxBinaryShapes = (0, rpc_caps_1.rpcBinaryMaxShapes)(opt);
    const binarySchemaOptions = (0, rpc_caps_1.rpcBinarySchemaOptions)(opt);
    function trustedBinaryOn(channel) {
        return channel.binary
            && channel.session.peer?.protocolVersion != rpc_binary_envelope_1.RPC_BINARY_PROTOCOL_VERSION;
    }
    function sendBinaryNow(session, packet) {
        if (!session.peer)
            throw new Error('RPC binary session is not initialized');
        session.binaryQueue.push({
            packet: session.binarySending
                ? (0, rpc_binary_walk_1.snapshotRpcBinaryResult)(packet)
                : packet,
        });
        if (session.binarySending)
            return;
        session.binarySending = true;
        let index = 0;
        try {
            while (index < session.binaryQueue.length) {
                const next = session.binaryQueue[index++];
                let prepared;
                try {
                    prepared = session.peer.prepare(next.packet);
                    if (detached) {
                        prepared.rollback();
                        session.binaryQueue.length = 0;
                        return;
                    }
                    socket.emit(key, prepared.wire);
                    prepared.commit();
                }
                catch (error) {
                    prepared?.rollback();
                    session.binaryQueue.length = 0;
                    throw error;
                }
            }
            session.binaryQueue.length = 0;
        }
        finally {
            session.binarySending = false;
        }
    }
    const rawCallbackBatch = (0, rpc_callback_batch_1.createCallbackPacketBatcher)({
        send: sendRaw,
        opt: opt?.callbackBatch,
    });
    function createSession(id, peerCaps, binary = true) {
        const effectiveCaps = serverCaps & peerCaps;
        const protocolVersion = (0, rpc_caps_1.hasCap)(effectiveCaps, rpc_caps_1.Caps.BINARY_MSGPACK)
            ? rpc_binary_envelope_1.RPC_BINARY_MSGPACK_PROTOCOL_VERSION
            : (0, rpc_caps_1.hasCap)(effectiveCaps, rpc_caps_1.Caps.BINARY_SCHEMA)
                ? rpc_binary_envelope_1.RPC_BINARY_SCHEMA_PROTOCOL_VERSION
                : rpc_binary_envelope_1.RPC_BINARY_PROTOCOL_VERSION;
        const peer = binary
            ? (0, rpc_binary_peer_1.createRpcBinaryPeer)({
                sessionId: id,
                maxShapes: maxBinaryShapes,
                protocolVersion,
                ...binarySchemaOptions,
            })
            : undefined;
        let session;
        const binaryBatch = peer
            ? (0, rpc_callback_batch_1.createCallbackPacketBatcher)({
                send: function sendBinaryCallbackBatch(packet) {
                    sendBinaryNow(session, packet);
                },
                opt: opt?.callbackBatch,
                acceptBinary: true,
                measure: packet => session?.binarySending
                    ? Number.MAX_SAFE_INTEGER
                    : peer.measure(packet),
            })
            : undefined;
        session = {
            id,
            peerCaps,
            peer,
            probeReceived: false,
            rawBatch: rawCallbackBatch,
            binaryBatch,
            binarySending: false,
            binaryQueue: [],
        };
        return session;
    }
    const legacySession = createSession(0, 0, false);
    const sessions = new Map();
    const sessionByClient = new Map();
    const clientBySession = new Map();
    const legacyChannel = { session: legacySession, binary: false };
    function removeSession(sessionId) {
        const session = sessions.get(sessionId);
        if (session)
            flushSession(session);
        sessions.delete(sessionId);
        const clientId = clientBySession.get(sessionId);
        clientBySession.delete(sessionId);
        if (clientId != undefined && sessionByClient.get(clientId) == sessionId) {
            sessionByClient.delete(clientId);
        }
    }
    function flushSession(session) {
        session.rawBatch.flush();
        session.binaryBatch?.flush();
        session.lastCallbackBinary = undefined;
    }
    function flushAllSessions() {
        flushSession(legacySession);
        for (const session of sessions.values())
            flushSession(session);
    }
    function sendChannelNow(channel, packet) {
        if (channel.binary)
            sendBinaryNow(channel.session, packet);
        else
            sendRaw(packet);
    }
    function sendChannel(channel, d) {
        if (detached)
            return;
        flushSession(channel.session);
        sendChannelNow(channel, d);
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
        if (channel.session.lastCallbackBinary != undefined
            && channel.session.lastCallbackBinary != channel.binary) {
            flushSession(channel.session);
        }
        channel.session.lastCallbackBinary = channel.binary;
        if (channel.binary)
            channel.session.binaryBatch.enqueue(packet);
        else
            channel.session.rawBatch.enqueue(packet);
    }
    const cbShapes = (0, rpc_shape_1.createCbShapeServer)();
    function sendCb(channel, cbId, cbArgs) {
        const compactOn = !channel.binary
            && (0, rpc_caps_1.hasCap)(serverCaps & channel.session.peerCaps, rpc_caps_1.Caps.COMPACT);
        if (compactOn && cbArgs.length == 1 && (0, rpc_shape_1.isPlainObject)(cbArgs[0])) {
            const obj = cbArgs[0];
            const r = cbShapes.offer(cbId, obj);
            function packShapeValue(key) {
                return (0, rpc_walk_1.packResult)(obj[key]);
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
        if (channel.binary && (!callbackBatchOn(channel)
            || (0, rpc_callback_batch_1.callbackBatchDirectBinaryOversize)(cbArgs, opt?.callbackBatch))) {
            const directArgs = trustedBinaryOn(channel)
                ? cbArgs
                : cbArgs.map(value => (0, rpc_binary_walk_1.validateRpcBinaryResult)(value, lim));
            sendChannel(channel, [rpc_protocol_1.Pkt.CB, cbId, directArgs]);
            return;
        }
        const binaryArgs = channel.binary
            ? cbArgs.map(value => (0, rpc_binary_walk_1.snapshotRpcBinaryResult)(value, lim))
            : undefined;
        const packet = [
            rpc_protocol_1.Pkt.CB,
            cbId,
            channel.binary
                ? binaryArgs
                : cbArgs.map(rpc_walk_1.packResult),
        ];
        if (!channel.binary) {
            sendCallbackPacket(channel, packet);
            return;
        }
        sendCallbackPacket(channel, packet);
    }
    function sendCbEnd(channel, cbId) {
        cbShapes.drop(cbId);
        sendChannel(channel, [rpc_protocol_1.Pkt.CB_END, cbId]);
    }
    function sendResult(channel, reqId, value) {
        if (!channel.binary) {
            sendChannel(channel, [rpc_protocol_1.Pkt.RESP, reqId, (0, rpc_walk_1.packResult)(value)]);
            return;
        }
        if (trustedBinaryOn(channel)) {
            try {
                sendChannel(channel, [rpc_protocol_1.Pkt.RESP, reqId, value]);
            }
            catch (error) {
                if (!isFunctionValueSerializationError(error))
                    throw error;
                sendChannel(channel, [
                    rpc_protocol_1.Pkt.RESP,
                    reqId,
                    (0, rpc_binary_walk_1.validateRpcBinaryResult)(value, lim),
                ]);
            }
            return;
        }
        const packet = [
            rpc_protocol_1.Pkt.RESP,
            reqId,
            (0, rpc_binary_walk_1.validateRpcBinaryResult)(value, lim),
        ];
        sendChannel(channel, packet);
    }
    function fallbackSerializationError(error) {
        const source = error instanceof Error ? error.message : String(error);
        const reason = source.length > 2_000 ? source.slice(0, 2_000) + '…' : source;
        return new TypeError('RPC response serialization failed: ' + reason);
    }
    function isFunctionValueSerializationError(error) {
        return error instanceof TypeError
            && error.message.includes('function values are not supported');
    }
    function sendError(channel, reqId, error) {
        if (channel.binary) {
            try {
                sendChannel(channel, [rpc_protocol_1.Pkt.RESP, reqId, null, (0, rpc_binary_walk_1.rpcBinaryErrorToDto)(error, lim)]);
            }
            catch (serializationError) {
                sendChannel(channel, [
                    rpc_protocol_1.Pkt.RESP,
                    reqId,
                    null,
                    (0, rpc_binary_walk_1.rpcBinaryErrorToDto)(fallbackSerializationError(serializationError), lim),
                ]);
            }
            return;
        }
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
    function acknowledgeProbedBinarySessions() {
        if (auth?.gate && !authed)
            return;
        for (const session of sessions.values()) {
            if (session.probeReceived
                && (0, rpc_caps_1.hasCap)(serverCaps & session.peerCaps, rpc_caps_1.Caps.BINARY)) {
                sendRaw((0, rpc_binary_envelope_1.encodeRpcBinaryControl)(rpc_binary_envelope_1.RpcBinaryFrame.PROBE_ACK, session.id, session.peer.protocolVersion, session.peer.encodePrelude()));
            }
        }
    }
    let helloInFlight = null;
    function sendCapsChallenge() {
        flushAllSessions();
        sendRaw([rpc_protocol_1.Pkt.CAPS, serverCaps, null, serverGeneration]);
    }
    function sendMap() {
        sendCapsChallenge();
        flushAllSessions();
        sendRaw(authAck !== undefined
            ? [rpc_protocol_1.Pkt.MAP, routeMap, strictSchema, listenPaths, authAck]
            : [rpc_protocol_1.Pkt.MAP, routeMap, strictSchema, listenPaths]);
    }
    function resetRejectedBinarySession(sessionId) {
        if (!sessions.has(sessionId))
            return;
        removeSession(sessionId);
        sendRaw([rpc_protocol_1.Pkt.BINARY_RESET, sessionId, serverGeneration]);
    }
    function resetAllRejectedBinarySessions() {
        for (const sessionId of [...sessions.keys()]) {
            resetRejectedBinarySession(sessionId);
        }
    }
    function isBinaryTransportValue(value) {
        return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
    }
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
        let msg = incoming;
        let channel = legacyChannel;
        let decodedSessionId;
        try {
            const envelope = (0, rpc_binary_envelope_1.inspectRpcBinaryEnvelope)(incoming);
            if (envelope) {
                decodedSessionId = envelope.sessionId;
                const session = sessions.get(envelope.sessionId);
                if (!session || !(0, rpc_caps_1.hasCap)(serverCaps & session.peerCaps, rpc_caps_1.Caps.BINARY))
                    return;
                if (envelope.version != session.peer.protocolVersion) {
                    throw new TypeError('RPC binary envelope version does not match session');
                }
                if (envelope.kind == rpc_binary_envelope_1.RpcBinaryFrame.PROBE) {
                    session.peer.decodePrelude(envelope.payload);
                    session.probeReceived = true;
                    if (!auth?.gate || authed) {
                        sendRaw((0, rpc_binary_envelope_1.encodeRpcBinaryControl)(rpc_binary_envelope_1.RpcBinaryFrame.PROBE_ACK, session.id, session.peer.protocolVersion, session.peer.encodePrelude()));
                    }
                    return;
                }
                if (envelope.kind != rpc_binary_envelope_1.RpcBinaryFrame.PACKET || !session.probeReceived
                    || (auth?.gate && !authed))
                    return;
                const decoded = session.peer.decode(envelope.payload);
                if (!Array.isArray(decoded)
                    || (decoded[0] != rpc_protocol_1.Pkt.CALL && decoded[0] != rpc_protocol_1.Pkt.PIPE)) {
                    throw new TypeError('RPC binary packet has an invalid client opcode');
                }
                msg = decoded;
                channel = { session, binary: true };
            }
            else if (isBinaryTransportValue(incoming) && sessions.size > 0) {
                resetAllRejectedBinarySessions();
                await hooks?.onInvalid?.({
                    reason: 'invalid_payload',
                    request: incoming,
                    error: 'RPC binary envelope magic mismatch',
                });
                return;
            }
        }
        catch (error) {
            if (decodedSessionId != undefined) {
                resetRejectedBinarySession(decodedSessionId);
            }
            else if (isBinaryTransportValue(incoming)) {
                resetAllRejectedBinarySessions();
            }
            await hooks?.onInvalid?.({
                reason: 'invalid_payload',
                request: incoming,
                error,
            });
            return;
        }
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
                        error: 'RPC binary session requires a client id',
                    });
                    return;
                }
                const owner = clientBySession.get(sessionId);
                if (owner != undefined && owner != clientId) {
                    await hooks?.onInvalid?.({
                        reason: 'invalid_payload',
                        request: msg,
                        error: 'RPC binary session belongs to another client',
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
                    if (!session && sessions.size >= MAX_BINARY_SESSIONS) {
                        sessionByClient.delete(clientId);
                        clientBySession.delete(sessionId);
                        await hooks?.onInvalid?.({
                            reason: 'rate_limit',
                            request: msg,
                            error: 'too many RPC binary sessions',
                        });
                        return;
                    }
                    if (session)
                        flushSession(session);
                    session = createSession(sessionId, announced, (0, rpc_caps_1.hasCap)(serverCaps & announced, rpc_caps_1.Caps.BINARY));
                    sessions.set(sessionId, session);
                }
                sendRaw([rpc_protocol_1.Pkt.CAPS, serverCaps, sessionId, serverGeneration]);
                return;
            }
            legacySession.peerCaps = announced & rpc_caps_1.Caps.COMPACT;
            sendRaw([rpc_protocol_1.Pkt.CAPS, serverCaps]);
            sendCapsChallenge();
            return;
        }
        if (Array.isArray(msg) && msg[0] === rpc_protocol_1.Pkt.HELLO) {
            if (!auth?.resolveAuth) {
                sendCapsChallenge();
                sendRaw([rpc_protocol_1.Pkt.MAP, routeMap, strictSchema, listenPaths, null]);
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
                    acknowledgeProbedBinarySessions();
                }
                catch (e) {
                    sendCapsChallenge();
                    sendRaw([rpc_protocol_1.Pkt.MAP, routeMap, strictSchema, listenPaths, {
                            ok: false,
                            reason: e?.message ?? String(e),
                        }]);
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
        if (!Array.isArray(msg) || (msg[0] != rpc_protocol_1.Pkt.CALL && msg[0] != rpc_protocol_1.Pkt.PIPE))
            return;
        if (!channel.binary && Number.isSafeInteger(msg[5])) {
            const session = sessions.get(msg[5]);
            if (session)
                channel = { session, binary: false };
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
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "reqId is not a valid number" });
            return;
        }
        if (!authed) {
            if (wait)
                sendError(channel, reqId, new myThrow_1.MyError("Unauthorized", "E_UNAUTHORIZED"));
            return;
        }
        if (typeof ref !== "number" && !Array.isArray(ref)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "ref must be number or string[]" });
            if (wait)
                sendError(channel, reqId, new Error("Invalid ref type"));
            return;
        }
        if (!Array.isArray(rawArgsOrSteps)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "args/steps must be an array" });
            if (wait)
                sendError(channel, reqId, new Error("Invalid args: expected array"));
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
                        sendError(channel, reqId, new Error("Forbidden path segment"));
                    return;
                }
                if (ref.length > lim.maxPathLen) {
                    hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "path too long" });
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
                        const stepArgs = channel.binary
                            ? (trustedBinaryOn(channel)
                                ? rpc_binary_walk_1.unpackRpcBinaryArgsTrusted
                                : rpc_binary_walk_1.unpackRpcBinaryArgs)(step.args, (id, args) => sendCb(channel, id, args), id => sendCbEnd(channel, id), lim)
                            : (0, rpc_walk_1.unpack)(step.args, (id, args) => sendCb(channel, id, args), id => sendCbEnd(channel, id), lim);
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
                const args = channel.binary
                    ? (trustedBinaryOn(channel)
                        ? rpc_binary_walk_1.unpackRpcBinaryArgsTrusted
                        : rpc_binary_walk_1.unpackRpcBinaryArgs)(rawArgsOrSteps, (id, values) => sendCb(channel, id, values), id => sendCbEnd(channel, id), lim)
                    : (0, rpc_walk_1.unpack)(rawArgsOrSteps, (id, values) => sendCb(channel, id, values), id => sendCbEnd(channel, id), lim);
                const res = await fn.apply(ctx, args);
                if (wait)
                    sendResult(channel, reqId, res);
            }
        }
        catch (e) {
            if (wait)
                sendError(channel, reqId, e);
        }
    }
    socket.on(key, handleServerPacket);
    if (auth?.resolveAuth)
        sendCapsChallenge();
    else
        sendMap();
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
    createServer(socket, key, target, hooks, limits, auth, opt);
}
