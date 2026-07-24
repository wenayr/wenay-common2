import {isNoStrict} from "./rpc-dynamic";
import { isSafeKey, resolveLimits, PayloadLimitError, type RpcLimits } from "./rpc-limits";
import {unpack, errToObj, packResult} from "./rpc-walk";
import { isPlainObject, createCbShapeServer } from "./rpc-shape";
import { Pkt, IS_RPC_LISTEN, type SocketTmpl } from "./rpc-protocol";
import { rpcPathKey } from "./rpc-path";
import {
    Caps,
    hasCap,
    optToCaps,
    rpcBinaryMaxShapes,
    rpcBinarySchemaOptions,
    type tCaps,
    type RpcOpt,
} from './rpc-caps'
import {
    callbackBatchDirectBinaryOversize,
    createCallbackPacketBatcher,
} from './rpc-callback-batch'
import {
    inspectRpcBinaryEnvelope,
    encodeRpcBinaryControl,
    RPC_BINARY_PROTOCOL_VERSION,
    RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
    RpcBinaryFrame,
} from './rpc-binary-envelope'
import {
    createRpcBinaryPeer,
    type RpcBinaryPeer,
} from './rpc-binary-peer'
import {
    rpcBinaryErrorToDto,
    snapshotRpcBinaryResult,
    unpackRpcBinaryArgs,
    unpackRpcBinaryArgsTrusted,
    validateRpcBinaryResult,
} from './rpc-binary-walk'
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
// A socket/key normally owns one logical client, but a small bounded fan-out is
// supported. Each session can retain up to 1,000 layouts, so 1,024 sessions was
// an avoidable memory-amplification surface.
const MAX_BINARY_SESSIONS = 16
let serverGenerationCounter = 0

function nextServerGeneration() {
    if (serverGenerationCounter >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError('RPC server generation space exhausted')
    }
    return ++serverGenerationCounter
}

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

    let detached = false
    function sendRaw(d: any) {
        if (!detached) socket.emit(key, d)
    }

    // Adaptive subscription tick compaction. Contractual: efficient, ONLY if both peers
    // announced Caps.COMPACT (serverCaps from opt, peerCaps from client Pkt.CAPS).
    // sendCb: frequent object of one shape → Pkt.SHAPE(once) + Pkt.CBV(values); else normal Pkt.CB.
    const serverCaps = optToCaps(opt)
    const serverGeneration = nextServerGeneration()
    const maxBinaryShapes = rpcBinaryMaxShapes(opt)
    const binarySchemaOptions = rpcBinarySchemaOptions(opt)

    type tServerSession = {
        id: number
        peerCaps: tCaps
        peer?: RpcBinaryPeer
        probeReceived: boolean
        rawBatch: ReturnType<typeof createCallbackPacketBatcher>
        binaryBatch?: ReturnType<typeof createCallbackPacketBatcher>
        lastCallbackBinary?: boolean
        binarySending: boolean
        binaryQueue: {packet: any[]}[]
    }
    type tSendChannel = {session: tServerSession, binary: boolean}

    function schemaBinaryOn(channel: tSendChannel) {
        return channel.binary
            && channel.session.peer?.protocolVersion == RPC_BINARY_SCHEMA_PROTOCOL_VERSION
    }

    function sendBinaryNow(session: tServerSession, packet: any[]) {
        if (!session.peer) throw new Error('RPC binary session is not initialized')
        // A synchronous transport may re-enter while the previous frame is prepared.
        // Snapshot nested output now; application code may mutate its object before
        // the outer emit unwinds and this queue can encode it.
        session.binaryQueue.push({
            packet: session.binarySending
                ? snapshotRpcBinaryResult(packet) as any[]
                : packet,
        })
        if (session.binarySending) return
        session.binarySending = true
        let index = 0
        try {
            while (index < session.binaryQueue.length) {
                const next = session.binaryQueue[index++]
                let prepared: ReturnType<RpcBinaryPeer['prepare']> | undefined
                try {
                    prepared = session.peer.prepare(next.packet)
                    if (detached) {
                        prepared.rollback()
                        session.binaryQueue.length = 0
                        return
                    }
                    socket.emit(key, prepared.wire)
                    prepared.commit()
                } catch (error) {
                    prepared?.rollback()
                    session.binaryQueue.length = 0
                    throw error
                }
            }
            session.binaryQueue.length = 0
        } finally {
            session.binarySending = false
        }
    }

    // Legacy packets have no session envelope. Callback ids already share one
    // socket/key id space, so one physical batch safely combines raw sessions.
    const rawCallbackBatch = createCallbackPacketBatcher({
        send: sendRaw,
        opt: opt?.callbackBatch,
    })

    function createSession(id: number, peerCaps: tCaps, binary = true): tServerSession {
        const protocolVersion = hasCap(serverCaps & peerCaps, Caps.BINARY_SCHEMA)
            ? RPC_BINARY_SCHEMA_PROTOCOL_VERSION
            : RPC_BINARY_PROTOCOL_VERSION
        const peer = binary
            ? createRpcBinaryPeer({
                sessionId: id,
                maxShapes: maxBinaryShapes,
                protocolVersion,
                ...binarySchemaOptions,
            })
            : undefined
        let session!: tServerSession
        const binaryBatch = peer
            ? createCallbackPacketBatcher({
                send: function sendBinaryCallbackBatch(packet) {
                    sendBinaryNow(session, packet)
                },
                opt: opt?.callbackBatch,
                acceptBinary: true,
                // The peer already has a prepared frame while a synchronous transport
                // re-enters the server. Treat that nested packet as oversize so it is
                // queued directly; returning zero would defeat the byte bound.
                measure: packet => session?.binarySending
                    ? Number.MAX_SAFE_INTEGER
                    : peer.measure(packet),
            })
            : undefined
        session = {
            id,
            peerCaps,
            peer,
            probeReceived: false,
            rawBatch: rawCallbackBatch,
            binaryBatch,
            binarySending: false,
            binaryQueue: [],
        }
        return session
    }

    const legacySession = createSession(0, 0, false)
    const sessions = new Map<number, tServerSession>()
    const sessionByClient = new Map<number, number>()
    const clientBySession = new Map<number, number>()
    const legacyChannel: tSendChannel = {session: legacySession, binary: false}

    function removeSession(sessionId: number) {
        const session = sessions.get(sessionId)
        if (session) flushSession(session)
        sessions.delete(sessionId)
        const clientId = clientBySession.get(sessionId)
        clientBySession.delete(sessionId)
        if (clientId != undefined && sessionByClient.get(clientId) == sessionId) {
            sessionByClient.delete(clientId)
        }
    }

    function flushSession(session: tServerSession) {
        session.rawBatch.flush()
        session.binaryBatch?.flush()
        session.lastCallbackBinary = undefined
    }

    function flushAllSessions() {
        flushSession(legacySession)
        for (const session of sessions.values()) flushSession(session)
    }

    function sendChannelNow(channel: tSendChannel, packet: any[]) {
        if (channel.binary) sendBinaryNow(channel.session, packet)
        else sendRaw(packet)
    }

    // Control packets are ordering barriers: callbacks stay before the response,
    // error, or stream end which followed them in server execution.
    function sendChannel(channel: tSendChannel, d: any[]) {
        if (detached) return
        flushSession(channel.session)
        sendChannelNow(channel, d)
    }

    function callbackBatchOn(channel: tSendChannel) {
        return hasCap(serverCaps & channel.session.peerCaps, Caps.CB_BATCH)
    }

    function sendCallbackPacket(channel: tSendChannel, packet: any[]) {
        if (detached) return
        if (!callbackBatchOn(channel)) {
            sendChannel(channel, packet)
            return
        }
        if (channel.session.lastCallbackBinary != undefined
            && channel.session.lastCallbackBinary != channel.binary) {
            flushSession(channel.session)
        }
        channel.session.lastCallbackBinary = channel.binary
        if (channel.binary) channel.session.binaryBatch!.enqueue(packet)
        else channel.session.rawBatch.enqueue(packet)
    }

    const cbShapes = createCbShapeServer()
    function sendCb(channel: tSendChannel, cbId: number, cbArgs: any[]) {
        const compactOn = !channel.binary
            && hasCap(serverCaps & channel.session.peerCaps, Caps.COMPACT)
        if (compactOn && cbArgs.length == 1 && isPlainObject(cbArgs[0])) {
            const obj = cbArgs[0]
            const r = cbShapes.offer(cbId, obj)
            function packShapeValue(key: string) {
                return packResult(obj[key])
            }
            if (r.mode == 'register') {
                sendCallbackPacket(channel, [Pkt.SHAPE, cbId, r.shapeId, r.keys])
                sendCallbackPacket(channel, [Pkt.CBV, cbId, r.shapeId, r.keys.map(packShapeValue)])
                return
            }
            if (r.mode == 'compact') {
                sendCallbackPacket(channel, [Pkt.CBV, cbId, r.shapeId, r.keys.map(packShapeValue)])
                return
            }
        }
        if (channel.binary && (
            !callbackBatchOn(channel)
            || callbackBatchDirectBinaryOversize(cbArgs, opt?.callbackBatch)
        )) {
            // Encoding happens synchronously before sendChannel returns, so a
            // direct packet already owns its call-time bytes. Validate limits
            // without first cloning a large media leaf or measuring the frame
            // through a complete throw-away encode.
            const directArgs = schemaBinaryOn(channel)
                ? cbArgs
                : cbArgs.map(value => validateRpcBinaryResult(value, lim))
            sendChannel(channel, [Pkt.CB, cbId, directArgs])
            return
        }
        // Callback batching defers encoding to a microtask. Preserve the same
        // call-time snapshot semantics as the legacy packResult path.
        const binaryArgs = channel.binary
            ? cbArgs.map(value => snapshotRpcBinaryResult(value, lim))
            : undefined
        const packet = [
            Pkt.CB,
            cbId,
            channel.binary
                ? binaryArgs
                : cbArgs.map(packResult),
        ]
        if (!channel.binary) {
            sendCallbackPacket(channel, packet)
            return
        }
        sendCallbackPacket(channel, packet)
    }

    function sendCbEnd(channel: tSendChannel, cbId: number) {
        cbShapes.drop(cbId)
        sendChannel(channel, [Pkt.CB_END, cbId])
    }

    function sendResult(channel: tSendChannel, reqId: number, value: unknown) {
        if (!channel.binary) {
            sendChannel(channel, [Pkt.RESP, reqId, packResult(value)])
            return
        }
        if (schemaBinaryOn(channel)) {
            try {
                sendChannel(channel, [Pkt.RESP, reqId, value])
            } catch (error) {
                if (!isFunctionValueSerializationError(error)) throw error
                // Legacy JSON omits methods held by returned data objects. Keep
                // ordinary schema results on the zero-walk hot path and pay for
                // that projection only after a function leaf actually rejects.
                sendChannel(channel, [
                    Pkt.RESP,
                    reqId,
                    validateRpcBinaryResult(value, lim),
                ])
            }
            return
        }
        const packet = [
            Pkt.RESP,
            reqId,
            validateRpcBinaryResult(value, lim),
        ]
        sendChannel(channel, packet)
    }

    function fallbackSerializationError(error: unknown) {
        const source = error instanceof Error ? error.message : String(error)
        const reason = source.length > 2_000 ? source.slice(0, 2_000) + '…' : source
        return new TypeError('RPC response serialization failed: ' + reason)
    }

    function isFunctionValueSerializationError(error: unknown) {
        return error instanceof TypeError
            && error.message.includes('function values are not supported')
    }

    function sendError(channel: tSendChannel, reqId: number, error: unknown) {
        if (channel.binary) {
            try {
                sendChannel(
                    channel,
                    [Pkt.RESP, reqId, null, rpcBinaryErrorToDto(error, lim)],
                )
            } catch (serializationError) {
                sendChannel(channel, [
                    Pkt.RESP,
                    reqId,
                    null,
                    rpcBinaryErrorToDto(fallbackSerializationError(serializationError), lim),
                ])
            }
            return
        }
        try {
            sendChannel(channel, [Pkt.RESP, reqId, null, errToObj(error)])
        } catch (serializationError) {
            sendChannel(channel, [
                Pkt.RESP,
                reqId,
                null,
                errToObj(fallbackSerializationError(serializationError)),
            ])
        }
    }

    // gate=true → calls rejected before successful HELLO; without auth — open, as before.
    let authed = !auth?.gate;
    let authAck: any = undefined;
    function acknowledgeProbedBinarySessions() {
        if (auth?.gate && !authed) return
        for (const session of sessions.values()) {
            if (session.probeReceived
                && hasCap(serverCaps & session.peerCaps, Caps.BINARY)) {
                sendRaw(encodeRpcBinaryControl(
                    RpcBinaryFrame.PROBE_ACK,
                    session.id,
                    session.peer!.protocolVersion,
                    session.peer!.encodePrelude(),
                ))
            }
        }
    }
    // Socket.IO preserves packet order, but EventEmitter does not await an async
    // HELLO handler. STRICT/CALL therefore wait on the matching principal build.
    let helloInFlight: Promise<void> | null = null;
    // 5th element of MAP appears ONLY when authAck exists — else wire byte-for-byte as before.
    function sendCapsChallenge() {
        flushAllSessions()
        sendRaw([Pkt.CAPS, serverCaps, null, serverGeneration])
    }

    function sendMap() {
        sendCapsChallenge()
        flushAllSessions()
        sendRaw(authAck !== undefined
            ? [Pkt.MAP, routeMap, strictSchema, listenPaths, authAck]
            : [Pkt.MAP, routeMap, strictSchema, listenPaths])
    }

    function resetRejectedBinarySession(sessionId: number) {
        if (!sessions.has(sessionId)) return
        removeSession(sessionId)
        sendRaw([Pkt.BINARY_RESET, sessionId, serverGeneration])
    }

    function resetAllRejectedBinarySessions() {
        for (const sessionId of [...sessions.keys()]) {
            resetRejectedBinarySession(sessionId)
        }
    }

    function isBinaryTransportValue(value: unknown) {
        return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
    }

    let byKey = SERVERS.get(socket);
    if (!byKey) { byKey = new Map(); SERVERS.set(socket, byKey); }
    const detachPrev = byKey.get(key);
    if (detachPrev) {
        detachPrev();
        console.warn(`[RPC] createRpcServer: repeated initialization on socket+key "${key}" — previous server detached`);
    }
    function detachServer() {
        if (detached) return
        // The old generation's queued callbacks form a final ordered prefix.
        flushAllSessions()
        detached = true
        sessions.clear()
        sessionByClient.clear()
        clientBySession.clear()
        hooks?.onDispose?.()
    }
    byKey.set(key, detachServer)

    async function handleServerPacket(incoming: any) {
        if (detached) return
        let msg = incoming
        let channel = legacyChannel
        let decodedSessionId: number | undefined
        try {
            const envelope = inspectRpcBinaryEnvelope(incoming)
            if (envelope) {
                decodedSessionId = envelope.sessionId
                const session = sessions.get(envelope.sessionId)
                if (!session || !hasCap(serverCaps & session.peerCaps, Caps.BINARY)) return
                if (envelope.version != session.peer!.protocolVersion) {
                    throw new TypeError('RPC binary envelope version does not match session')
                }
                if (envelope.kind == RpcBinaryFrame.PROBE) {
                    session.peer!.decodePrelude(envelope.payload)
                    session.probeReceived = true
                    if (!auth?.gate || authed) {
                        sendRaw(encodeRpcBinaryControl(
                            RpcBinaryFrame.PROBE_ACK,
                            session.id,
                            session.peer!.protocolVersion,
                            session.peer!.encodePrelude(),
                        ))
                    }
                    return
                }
                if (envelope.kind != RpcBinaryFrame.PACKET || !session.probeReceived
                    || (auth?.gate && !authed)) return
                const decoded = session.peer!.decode(envelope.payload)
                if (!Array.isArray(decoded)
                    || (decoded[0] != Pkt.CALL && decoded[0] != Pkt.PIPE)) {
                    throw new TypeError('RPC binary packet has an invalid client opcode')
                }
                msg = decoded
                channel = {session, binary: true}
            } else if (isBinaryTransportValue(incoming) && sessions.size > 0) {
                // A damaged magic/header cannot be attributed to one session. Reset
                // the bounded set so no sender keeps emitting references into a
                // decoder cache which never committed the lost definition.
                resetAllRejectedBinarySessions()
                await hooks?.onInvalid?.({
                    reason: 'invalid_payload',
                    request: incoming,
                    error: 'RPC binary envelope magic mismatch',
                })
                return
            }
        } catch (error) {
            if (decodedSessionId != undefined) {
                resetRejectedBinarySession(decodedSessionId)
            } else if (isBinaryTransportValue(incoming)) {
                resetAllRejectedBinarySessions()
            }
            await hooks?.onInvalid?.({
                reason: 'invalid_payload',
                request: incoming,
                error,
            })
            return
        }
        if (typeof msg == 'number' && msg == Pkt.STRICT) {
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
        if (Array.isArray(msg) && msg[0] == Pkt.CAPS) {
            flushAllSessions()
            const announced = typeof msg[1] == 'number' ? msg[1] : Caps.COMPACT
            const sessionId = msg[2]
            const generation = msg[3]
            const clientId = msg[4]
            if (Number.isSafeInteger(sessionId) && sessionId > 0
                && generation == serverGeneration) {
                // Binary was introduced with correlated client ids, so accepting an
                // anonymous session has no compatibility value and defeats the bound.
                if (!Number.isSafeInteger(clientId) || clientId <= 0) {
                    await hooks?.onInvalid?.({
                        reason: 'invalid_payload',
                        request: msg,
                        error: 'RPC binary session requires a client id',
                    })
                    return
                }
                const owner = clientBySession.get(sessionId)
                if (owner != undefined && owner != clientId) {
                    await hooks?.onInvalid?.({
                        reason: 'invalid_payload',
                        request: msg,
                        error: 'RPC binary session belongs to another client',
                    })
                    return
                }
                const previousId = sessionByClient.get(clientId)
                if (previousId != undefined && previousId != sessionId) {
                    removeSession(previousId)
                }
                sessionByClient.set(clientId, sessionId)
                clientBySession.set(sessionId, clientId)
                let session = sessions.get(sessionId)
                if (!session || session.peerCaps != announced) {
                    if (!session && sessions.size >= MAX_BINARY_SESSIONS) {
                        sessionByClient.delete(clientId)
                        clientBySession.delete(sessionId)
                        await hooks?.onInvalid?.({
                            reason: 'rate_limit',
                            request: msg,
                            error: 'too many RPC binary sessions',
                        })
                        return
                    }
                    if (session) flushSession(session)
                    session = createSession(
                        sessionId,
                        announced,
                        hasCap(serverCaps & announced, Caps.BINARY),
                    )
                    sessions.set(sessionId, session)
                }
                sendRaw([Pkt.CAPS, serverCaps, sessionId, serverGeneration])
                return
            }
            // Anonymous CAPS is the historical COMPACT handshake. Newer features
            // are per-client: letting one uncorrelated client enable CB_BATCH here
            // changes the wire format of another client's pre-generation callbacks.
            legacySession.peerCaps = announced & Caps.COMPACT
            sendRaw([Pkt.CAPS, serverCaps])
            sendCapsChallenge()
            return
        }
        // HELLO: in-band authorization. Without auth strategy — ignore (old client vs server without auth).
        if (Array.isArray(msg) && msg[0] === Pkt.HELLO) {
            // Server without auth: reply to HELLO is still 5-element (authAck=null) — so client
            // can distinguish "HELLO reply" from 4-element STRICT and not hang/confuse them.
            if (!auth?.resolveAuth) {
                sendCapsChallenge()
                sendRaw([Pkt.MAP, routeMap, strictSchema, listenPaths, null])
                return
            }
            async function resolveHello() {
                try {
                    const r: any = await auth!.resolveAuth!(msg[1]);
                    if (r && r.object !== undefined) buildDispatch(r.object); // new principal facade
                    authAck = r && r.ack !== undefined ? r.ack : { ok: true };
                    authed = authAck?.ok !== false;
                    sendMap(); // principal-specific routeMap + authAck
                    acknowledgeProbedBinarySessions()
                } catch (e: any) {
                    // Reauth rejection DOES NOT drop live session: don't touch principal/authed/routeMap,
                    // just report ok:false to client via local ack (their reauth() resolves as-is).
                    sendCapsChallenge()
                    sendRaw([Pkt.MAP, routeMap, strictSchema, listenPaths, {
                        ok: false,
                        reason: e?.message ?? String(e),
                    }])
                }
            }
            const hello = resolveHello();
            helloInFlight = hello;
            try { await hello; }
            finally { if (helloInFlight == hello) helloInFlight = null; }
            return;
        }
        if (!Array.isArray(msg) || (msg[0] != Pkt.CALL && msg[0] != Pkt.PIPE)) return
        if (!channel.binary && Number.isSafeInteger(msg[5])) {
            const session = sessions.get(msg[5])
            if (session) channel = {session, binary: false}
        }
        const hello = helloInFlight;
        if (hello) {
            await hello;
            if (detached) return;
        }

        const isPipe = msg[0] == Pkt.PIPE;
        const [, reqId, ref, rawArgsOrSteps, w] = msg;
        const wait = w !== false;

        if (!Number.isSafeInteger(reqId) || reqId < 0) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "reqId is not a valid number" });
            return;
        }
        if (!authed) { // gate: calls before successful HELLO
            if (wait) sendError(channel, reqId, new MyError("Unauthorized", "E_UNAUTHORIZED"))
            return;
        }
        if (typeof ref !== "number" && !Array.isArray(ref)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "ref must be number or string[]" });
            if (wait) sendError(channel, reqId, new Error("Invalid ref type"))
            return;
        }
        if (!Array.isArray(rawArgsOrSteps)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "args/steps must be an array" });
            if (wait) sendError(channel, reqId, new Error("Invalid args: expected array"))
            return;
        }

        try {
            let fn: Function | undefined, ctx: any;

            if (typeof ref == "number") {
                fn = methods[ref]; ctx = contexts[ref];
            } else {
                if (!ref.every((s: any) => typeof s == "string" && isSafeKey(s))) {
                    hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps });
                    if (wait) sendError(channel, reqId, new Error("Forbidden path segment"))
                    return;
                }
                if (ref.length > lim.maxPathLen) {
                    hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "path too long" });
                    if (wait) sendError(channel, reqId, new PayloadLimitError("path too long"))
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
                if (wait) sendError(channel, reqId, new Error("Not a function: " + ref))
                return;
            }

            if (hooks?.onRequest) {
                const keyArr = typeof ref == "number"
                    ? methodPaths[ref] ?? []
                    : ref;
                const allowed = await hooks.onRequest({ key: keyArr, request: rawArgsOrSteps, fnName: keyArr[keyArr.length - 1] ?? "", fn: fn as Func });
                if (allowed == false) {
                    if (wait) sendError(channel, reqId, new Error("Rejected by hook"))
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
                        const stepArgs = channel.binary
                            ? (schemaBinaryOn(channel)
                                ? unpackRpcBinaryArgsTrusted
                                : unpackRpcBinaryArgs)(
                                step.args,
                                (id, args) => sendCb(channel, id, args),
                                id => sendCbEnd(channel, id),
                                lim,
                            )
                            : unpack(
                                step.args,
                                (id, args) => sendCb(channel, id, args),
                                id => sendCbEnd(channel, id),
                                lim,
                            )
                        current = current(...stepArgs);
                    }
                }
                
                if (current && typeof current.then === "function") {
                    current = await current;
                }
                if (wait) sendResult(channel, reqId, current)

            } else {
                // --- STANDARD CALL LOGIC ---
                const args = channel.binary
                    ? (schemaBinaryOn(channel)
                        ? unpackRpcBinaryArgsTrusted
                        : unpackRpcBinaryArgs)(
                        rawArgsOrSteps,
                        (id, values) => sendCb(channel, id, values),
                        id => sendCbEnd(channel, id),
                        lim,
                    )
                    : unpack(
                        rawArgsOrSteps,
                        (id, values) => sendCb(channel, id, values),
                        id => sendCbEnd(channel, id),
                        lim,
                    )
                const res = await fn.apply(ctx, args);
                if (wait) sendResult(channel, reqId, res)
            }

        } catch (e) {
            if (wait) sendError(channel, reqId, e)
        }
    }
    // Listen before the first declaration: synchronous in-memory adapters may answer
    // CAPS while the server is still inside this factory.
    socket.on(key, handleServerPacket)
    if (auth?.resolveAuth) sendCapsChallenge()
    else sendMap()
}

export function createRpcServer<T extends object>({ socket, object: target, socketKey: key, debug = false, hooks, limits, auth, opt }: {
    socket: SocketTmpl; object: T; socketKey: string; debug?: boolean; hooks?: PromiseServerHooks<T>; limits?: RpcLimits; auth?: RpcServerAuth; opt?: RpcOpt;
}) {
    if (debug) {
        const origOn = socket.on.bind(socket);
        function debugPacket(value: any) {
            if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`
            if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`
            if (typeof value != 'object') return value
            try { return JSON.stringify(value) }
            catch { return String(value) }
        }
        socket.on = (e: string, cb: (d: any) => void) =>
            origOn(e, (d: any) => { console.log('[RPC IN]', debugPacket(d)); cb(d) });
    }
    createServer(socket, key, target, hooks, limits, auth, opt);
}

export type { PromiseServerHooks, RpcLimits, RpcServerAuth };
export type { RpcOpt } from "./rpc-caps";
