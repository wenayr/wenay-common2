import {isNoStrict} from "./rpc-dynamic";
import { isSafeKey, resolveLimits, PayloadLimitError, type RpcLimits } from "./rpc-limits";
import {unpack, errToObj, packResult, type tReservedKeyReport} from "./rpc-walk";
import { isPlainObject, createCbShapeServer, createShapeRegistry, createRowEncoder } from "./rpc-shape";
import { Pkt, IS_RPC_LISTEN, GRANT_FACTS_KEY, type SocketTmpl, type RpcAuthNotice, type tAuthState } from "./rpc-protocol";
import { rpcPathKey } from "./rpc-path";
import {
    Caps,
    hasCap,
    optToCaps,
    type tCaps,
    type RpcOpt,
} from './rpc-caps'
import {
    createCallbackPacketBatcher,
    MAX_BATCH_ITEMS,
} from './rpc-callback-batch'
import { MyError } from "../../toError/myThrow";

type Func = (...args: any[]) => any;

// Which Listen nodes a principal switch touched. `drop` is the ONLY teardown evidence: a node the
// schema walk never declared (a noStrict subtree is resolved by string path at CALL time, not
// walked) lands in neither set and keeps its subscribers — invisible to the walk is not proof of
// unreachability, and a routine token renewal must not silently kill a dynamic facade's streams.
type RpcPrincipalChange = {
    /** Listen nodes the NEW facade declares. */
    keep: ReadonlySet<object>;
    /** Nodes the OLD facade declared and the new one does not — reach genuinely lost. */
    drop: ReadonlySet<object>;
};

type PromiseServerHooks<T> = {
    onRequest?: (ctx: { key: string[]; request: any[]; fnName: string; fn: Func }) => boolean | Promise<boolean>;
    onInvalid?: (ctx: { reason: "invalid_payload" | "not_function" | "resolve_error" | "rate_limit"; key?: any; request?: any; error?: any }) => void | Promise<void>;
    resolveTransform?: (value: any) => any;
    /** Principal switched (HELLO / expiry / revocation). One Listen node is deliberately shared
     *  by facades of different principals, so a privilege decrease must END the streams of the
     *  nodes it lost, otherwise an expired token keeps receiving data. The layer that owns
     *  subscriptions ends exactly `drop` — see RpcPrincipalChange. */
    onPrincipalChange?: (ctx: RpcPrincipalChange) => void;
    onDispose?: () => void;
};

// In-band authorization (P3 "confirmation"): client sends Pkt.HELLO with token, server
// validates it and (opt.) replaces served object with facade of this principal, then sends
// Pkt.MAP with authAck. Without auth previous behavior. Token source and admission — outside core.
// What resolveAuth grants for a presented token. Every field is optional and additive:
// without expiresAt the session has no lifetime and behaves exactly as before.
type RpcAuthGrant = {
    /** Principal facade to serve. Absent = keep the currently served object. */
    object?: any;
    /** What the client receives in authAck (5th element of Pkt.MAP). */
    ack?: any;
    /** Absolute ms deadline of this token: 'expiring' warning before it, downgrade at it. */
    expiresAt?: number;
    /** Lead time of the 'expiring' warning (default 30s, clamped into the remaining time). */
    renewBeforeMs?: number;
};

type RpcServerAuth = {
    /** token → { object?: principal facade, ack?: what to send to client in authAck }. throw/ack.ok===false = rejection.
     *  REVOCATION is explicit: throw a value carrying `revoke === true`
     *  (`throw Object.assign(new Error("revoked"), { revoke: true })`) — that takes the full
     *  downgrade path (Pkt.AUTH 'revoked' + base facade). Any OTHER throw is treated as a
     *  transient failure and keeps the live session exactly as before. */
    resolveAuth: (token: any) => RpcAuthGrant | Promise<RpcAuthGrant>;
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
// supported. Bound per-client capability state on a shared socket/key.
const MAX_CLIENT_SESSIONS = 16
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
    debug = false,
) {
    const lim = resolveLimits(limits);
    // The one place a marker collision is DECIDABLE: on the way out a plain object under a
    // reserved key is application data the peer will read back as a library type. Undefined
    // unless the application asked for debug, so the packer's check costs nothing otherwise.
    const onReserved: tReservedKeyReport | undefined = debug
        ? function reportReservedKey(markerKey: string) {
            console.log('[RPC OUT] reserved key', markerKey,
                '— an application value of this shape is decoded as a library value by the peer')
        }
        : undefined;
    const IS_RPC_PIPE = Symbol.for("isRpcPipe");

    const hasRpcListen = (obj: any) => !!obj && typeof obj == "object" && Object.prototype.hasOwnProperty.call(obj, IS_RPC_LISTEN);
    // transformTree REBUILDS the declared tree, so a Listen node in the result is a copy.
    // Principal-change teardown must address the ORIGINAL node (the object whose layer owns
    // subscriptions) — remember where every copy came from. Never travels on wire.
    const listenNodeOrigin = new WeakMap<object, object>();

    function transformTree(obj: any): any {
        let current = obj;
        if (hooks?.resolveTransform && !isNoStrict(current)) {
            current = hooks.resolveTransform(current);
        }
        if (current == null || typeof current != "object" || isNoStrict(current)) return current;
        const out: any = {};
        if (hasRpcListen(current)) { out[IS_RPC_LISTEN] = true; listenNodeOrigin.set(out, current); } // mark — Symbol, Object.keys doesn't copy it
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
    let listenNodes: object[] = []; // the same nodes by IDENTITY — surviving set for principal change
    let strictSchema: any = {};
    let currentTarget: any = target; // active object (facade of current principal)

    function buildDispatch(t: any) {
        const m: Function[] = [], cx: any[] = [], paths: string[][] = [], rm: Record<string, number> = {}, lp: string[] = [], ln: object[] = [];
        const resolved = transformTree(t);
        (function index(obj: any, prefix: string[]) {
            for (const k of Object.keys(obj)) {
                if (!isSafeKey(k)) continue;
                const v = obj[k];
                const path = [...prefix, k];
                if (typeof v == "function") { rm[rpcPathKey(path)] = m.length; m.push(v); cx.push(obj); paths.push(path); }
                else if (v && typeof v == "object" && !isNoStrict(v)) {
                    if (hasRpcListen(v)) { lp.push(rpcPathKey(path)); ln.push(listenNodeOrigin.get(v) ?? v); }
                    index(v, path);
                }
            }
        })(resolved, []);
        methods = m; contexts = cx; methodPaths = paths; routeMap = rm; listenPaths = lp; listenNodes = ln; strictSchema = serialize(resolved); currentTarget = t;
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

    type tServerSession = {
        id: number
        peerCaps: tCaps
        /** Caps.REQ_BATCH: this session batches CALL/PIPE, RESP and callbacks in ONE queue. */
        reqBatch: boolean
        /** Caps.ROWS: row-encoded record arrays against the connection-scoped registry. */
        rows: ReturnType<typeof createRowEncoder> | undefined
        rawBatch: ReturnType<typeof createCallbackPacketBatcher>
    }
    type tSendChannel = {session: tServerSession}
    // ONE registry per server instance, not per session: its ids are what a session declares,
    // and a monotonic id space shared by every session on this socket is what keeps an evicted
    // id from being confused with a live one. WHO has been told about a shape is tracked per
    // session inside the registry, so a rebuilt session re-declares — see rpc-shape.ts.
    const shapeRegistry = createShapeRegistry()
    const rowEncoder = createRowEncoder(shapeRegistry)

    // Legacy packets have no session envelope. Callback ids already share one
    // socket/key id space, so one physical batch safely combines raw sessions.
    const rawCallbackBatch = createCallbackPacketBatcher({
        send: sendRaw,
        opt: opt?.callbackBatch,
    })
    // The second envelope, for sessions that negotiated Caps.REQ_BATCH. A SEPARATE queue and not
    // a widened first one: a peer without the bit shares this socket's id space and would
    // silently drop a Pkt.BATCH frame, taking its own callbacks down with it.
    const rawRequestBatch = createCallbackPacketBatcher({
        send: sendRaw,
        opt: opt?.requestBatch,
        envelope: Pkt.BATCH,
    })

    // REQ_BATCH extends the callback envelope, so it needs CB_BATCH as well: the whole reason a
    // response may skip the ordering barrier is that it shares ONE queue with the callbacks it
    // must follow. The choice is fixed at construction — a session whose announced caps change
    // is flushed and rebuilt, never mutated in place (the legacy session masks the bit away).
    function createSession(id: number, peerCaps: tCaps): tServerSession {
        const reqBatch = hasCap(serverCaps & peerCaps, Caps.CB_BATCH | Caps.REQ_BATCH)
        // ROWS needs COMPACT for the same reason REQ_BATCH needs CB_BATCH: the tick half of
        // this registry IS the Pkt.SHAPE/CBV wire, and half a feature is not a feature.
        const rowsOn = hasCap(serverCaps & peerCaps, Caps.COMPACT | Caps.ROWS)
        return {
            id,
            peerCaps,
            reqBatch,
            rows: rowsOn ? rowEncoder : undefined,
            rawBatch: reqBatch ? rawRequestBatch : rawCallbackBatch,
        }
    }

    const legacySession = createSession(0, 0)
    const sessions = new Map<number, tServerSession>()
    const sessionByClient = new Map<number, number>()
    const clientBySession = new Map<number, number>()
    const legacyChannel: tSendChannel = {session: legacySession}

    function removeSession(sessionId: number) {
        const session = sessions.get(sessionId)
        if (session) flushSession(session)
        sessions.delete(sessionId)
        // The registry outlives one session, so a dead session must stop counting as declared:
        // an id it was told about means nothing to whoever takes this session id next.
        shapeRegistry.forgetSession(sessionId)
        const clientId = clientBySession.get(sessionId)
        clientBySession.delete(sessionId)
        if (clientId != undefined && sessionByClient.get(clientId) == sessionId) {
            sessionByClient.delete(clientId)
        }
    }

    function flushSession(session: tServerSession) {
        session.rawBatch.flush()
    }

    function flushAllSessions() {
        // Both envelopes by identity, not by walking sessions: a control packet is a barrier for
        // every queue on this socket, including one whose only session was just dropped.
        rawCallbackBatch.flush()
        rawRequestBatch.flush()
    }

    // Control packets are ordering barriers: callbacks stay before the response,
    // error, or stream end which followed them in server execution.
    // With Caps.REQ_BATCH the barrier is not merely skipped, it is UNNECESSARY: the response
    // rides the same ordered queue as those callbacks, so its position in the batch already
    // carries the order the flush existed to preserve. Dropping it is the whole optimization —
    // it is what turns a burst of N calls into one frame instead of N.
    function sendChannel(channel: tSendChannel, d: any[]) {
        if (detached) return
        if (channel.session.reqBatch) { channel.session.rawBatch.enqueue(d); return }
        flushSession(channel.session)
        sendRaw(d)
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
        channel.session.rawBatch.enqueue(packet)
    }

    const cbShapes = createCbShapeServer()
    function sendCb(channel: tSendChannel, cbId: number, cbArgs: any[]) {
        const compactOn = hasCap(serverCaps & channel.session.peerCaps, Caps.COMPACT)
        const rows = channel.session.rows
        if (compactOn && cbArgs.length == 1 && isPlainObject(cbArgs[0])) {
            const obj = cbArgs[0]
            // Same three decisions either way; only the id space and the lifetime differ. The
            // connection-scoped registry can answer 'compact' on a callback's FIRST tick,
            // because a response may already have paid for that shape — which is the whole
            // point of sharing it. Without the bit this is byte-for-byte the previous path.
            const r = rows ? shapeRegistry.offerTick(channel.session.id, obj) : cbShapes.offer(cbId, obj)
            function packShapeValue(key: string) {
                return packResult(obj[key], rows, onReserved)
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
        // Callback batching defers encoding to a microtask. Preserve the same
        // call-time snapshot semantics as the ordinary packResult path.
        // A tick that is an ARRAY of records reaches the wire here, not through CBV: one row
        // table inside an ordinary Pkt.CB is the same saving without a second tick opcode.
        sendCallbackPacket(channel, [Pkt.CB, cbId, cbArgs.map(function packCbArg(a: any) { return packResult(a, rows, onReserved) })])
    }

    function sendCbEnd(channel: tSendChannel, cbId: number) {
        cbShapes.drop(cbId)
        sendChannel(channel, [Pkt.CB_END, cbId])
    }

    function sendResult(channel: tSendChannel, reqId: number, value: unknown) {
        // The half sendResult never had: a result carrying an array of uniform records is where
        // half the bytes of a real payload live, and until Caps.ROWS nothing here compacted at
        // all. Without the bit `rows` is undefined and packResult is the previous call exactly.
        sendChannel(channel, [Pkt.RESP, reqId, packResult(value, channel.session.rows, onReserved)])
    }

    function fallbackSerializationError(error: unknown) {
        const source = error instanceof Error ? error.message : String(error)
        const reason = source.length > 2_000 ? source.slice(0, 2_000) + '…' : source
        return new TypeError('RPC response serialization failed: ' + reason)
    }

    function sendError(channel: tSendChannel, reqId: number, error: unknown) {
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
    // Socket.IO preserves packet order, but EventEmitter does not await an async
    // HELLO handler. STRICT/CALL therefore wait on the matching principal build.
    let helloInFlight: Promise<void> | null = null;
    // 5th element of MAP appears ONLY when authAck exists — else wire byte-for-byte as before.
    function sendCapsChallenge() {
        flushAllSessions()
        sendRaw([Pkt.CAPS, serverCaps, null, serverGeneration])
    }

    // A MAP that ANSWERS a HELLO echoes back the id that HELLO carried (6th element,
    // Caps.HELLO_ID). An unsolicited MAP — STRICT push, expiry/revocation downgrade — never
    // carries one: that is how the client tells an answer from a notification.
    function mapReply(ack: any, helloId?: number) {
        return helloId === undefined
            ? [Pkt.MAP, routeMap, strictSchema, listenPaths, ack]
            : [Pkt.MAP, routeMap, strictSchema, listenPaths, ack, helloId]
    }

    // The echo is negotiated like every other wire feature: a server built with
    // opt.helloId === false never sends it, and a client that sent no id gets today's wire.
    function replyHelloId(raw: any) {
        if (!hasCap(serverCaps, Caps.HELLO_ID)) return undefined
        return Number.isSafeInteger(raw) && raw > 0 ? raw as number : undefined
    }

    function sendMap(helloId?: number) {
        sendCapsChallenge()
        flushAllSessions()
        sendRaw(authAck !== undefined
            ? mapReply(authAck, helloId)
            : [Pkt.MAP, routeMap, strictSchema, listenPaths])
    }

    // ===================================================================
    // token lifetime and principal downgrade
    // ===================================================================
    // resolveAuth may declare an absolute deadline: shortly before it the client is warned
    // ('expiring'), at it the principal falls back to the object the server was constructed
    // with. Facades of different principals deliberately share ONE Listen node per identity,
    // so a privilege DECREASE must also END the streams the new principal can no longer see —
    // otherwise an expired token keeps receiving data.
    //
    // CLOCK: expiresAt is an absolute WALL-clock instant, setTimeout is relative. Every chunk
    // re-reads Date.now(), so a forward clock jump or a resumed process costs at most one chunk
    // of drift instead of a deadline that never fires. A deadline already in the past downgrades
    // ONCE on the next tick (the downgrade clears its own timers — no storm). `Infinity` means
    // "no deadline"; any other non-finite value is a caller bug and fails CLOSED.
    const DEFAULT_RENEW_BEFORE_MS = 30_000
    // setTimeout keeps the delay in a signed 32-bit int: a larger one fires IMMEDIATELY (and
    // warns), so a month-long token would read as already expired. Long waits go in chunks.
    const MAX_TIMER_MS = 2_147_483_647
    let expiringTimer: ReturnType<typeof startAuthTimer> | null = null
    let expiryTimer: ReturnType<typeof startAuthTimer> | null = null

    // Auth state is per socket+key, not per session: any negotiated peer enables the push.
    function authStateOn() {
        if (!hasCap(serverCaps, Caps.AUTH_STATE)) return false
        if (hasCap(legacySession.peerCaps, Caps.AUTH_STATE)) return true
        for (const session of sessions.values()) {
            if (hasCap(session.peerCaps, Caps.AUTH_STATE)) return true
        }
        return false
    }

    function sendAuthState(notice: RpcAuthNotice) {
        if (detached || !authStateOn()) return
        flushAllSessions() // control packet is an ordering barrier, like CAPS/MAP
        sendRaw([Pkt.AUTH, notice])
    }

    function clearAuthTimers() {
        if (expiringTimer) { expiringTimer.cancel(); expiringTimer = null }
        if (expiryTimer) { expiryTimer.cancel(); expiryTimer = null }
    }

    // Waits for an ABSOLUTE instant, in chunks setTimeout can actually hold.
    // unref: a token deadline must not by itself hold the process alive.
    function startAuthTimer(at: number, fn: () => void) {
        let timer: any = null
        function armChunk() {
            const left = at - Date.now()
            timer = left > MAX_TIMER_MS ? setTimeout(armChunk, MAX_TIMER_MS) : setTimeout(fn, Math.max(left, 0))
            timer.unref?.()
        }
        armChunk()
        return {cancel: () => clearTimeout(timer)}
    }

    function armAuthTimers(expiresAt: number, renewBeforeMs?: number) {
        clearAuthTimers()
        if (detached) return // this socket+key already belongs to another server
        if (expiresAt == Infinity) return // explicit "no deadline"
        // A NaN/garbage deadline is not one this server can honour: downgrade instead of
        // granting an unlimited session (fail closed on a caller's broken arithmetic).
        const deadline = Number.isFinite(expiresAt) ? expiresAt : Date.now()
        const remaining = deadline - Date.now()
        // the warning can't outrun the token itself, and after the deadline it is pure noise
        const before = Math.min(Math.max(renewBeforeMs ?? DEFAULT_RENEW_BEFORE_MS, 0), Math.max(remaining, 0))
        if (remaining > 0) {
            expiringTimer = startAuthTimer(deadline - before, function warnExpiring() {
                expiringTimer = null
                sendAuthState({state: 'expiring', expiresAt: deadline})
            })
        }
        expiryTimer = startAuthTimer(deadline, function expirePrincipal() {
            expiryTimer = null
            downgradePrincipal('expired', 'token expired')
        })
    }

    // ONE corridor for every principal switch: HELLO success, expiry, revocation.
    function applyPrincipal(object: any) {
        // Teardown evidence is the DECLARED set losing a node, not the new set missing one:
        // nodes the walk never saw (noStrict subtrees) belong to neither and survive.
        const previous = listenNodes
        buildDispatch(object)
        const keep = new Set(listenNodes)
        // Streams of nodes that vanished from the facade must END (RPC_STOP → CB_END), else
        // client consumers wait forever on a stream this principal is no longer allowed to see.
        hooks?.onPrincipalChange?.({keep, drop: new Set(previous.filter(node => !keep.has(node)))})
    }

    // The deadline is a fact the RENEWING side needs, but authAck is the APPLICATION's value, so
    // it goes into the reserved GRANT_FACTS_KEY sub-object (the wire contract lives in
    // rpc-protocol.ts, which also states why an ack of the wrong shape passes through untouched).
    // Only a finite deadline is attached: Infinity means "no deadline" and would travel as null.
    function withGrantDeadline(ack: any, expiresAt?: number) {
        if (expiresAt == undefined || !Number.isFinite(expiresAt)) return ack
        if (!isPlainObject(ack) || GRANT_FACTS_KEY in ack) return ack
        return {...ack, [GRANT_FACTS_KEY]: {expiresAt}}
    }

    // ONE grant corridor: a HELLO success and an application grant apply the same steps in the
    // same order. helloId is set only when the grant ANSWERS a HELLO — an application grant is
    // unsolicited, so its MAP carries no correlation and settles no pending reauth().
    function applyGrant(r: RpcAuthGrant | null | undefined, helloId?: number) {
        if (detached) return false // this socket+key already belongs to another server
        clearAuthTimers() // the previous grant's deadline is void from here on
        if (r && r.object !== undefined) applyPrincipal(r.object) // new principal facade
        authAck = withGrantDeadline(r && r.ack !== undefined ? r.ack : {ok: true}, r?.expiresAt)
        authed = authAck?.ok !== false
        if (r && r.expiresAt != undefined) armAuthTimers(r.expiresAt, r.renewBeforeMs) // absent = no lifetime, as before
        sendMap(helloId) // principal-specific routeMap + authAck
        return true
    }

    // Expiry/revocation: back to the object the server was constructed with (anonymous facade).
    // helloId is set only when the downgrade IS the answer to a HELLO (explicit revocation):
    // that reply must settle the reauth() which presented the refused token. A timer-driven
    // downgrade stays uncorrelated — it answers no question.
    function downgradePrincipal(state: Extract<tAuthState, 'expired' | 'revoked'>, reason: any, helloId?: number) {
        if (detached) return
        clearAuthTimers()
        sendAuthState({state, reason}) // state first: client learns WHY before its streams end
        applyPrincipal(target)
        authAck = {ok: false, state, reason}
        authed = !auth?.gate
        sendMap(helloId)
    }

    // ===================================================================
    // control: the application's own grip on THIS connection's principal
    // ===================================================================
    // Until now a principal could only fall when the CLIENT asked for it: the expiry timer, or
    // resolveAuth throwing `revoke: true` — which needs a HELLO to throw from. An admin action, a
    // logout from another device or a fraud signal has no HELLO to ride on, so the application
    // drives the SAME corridors directly: revoke = downgradePrincipal, grant = the HELLO success
    // path with no correlation id. Both are safe at any moment — before HELLO, twice in a row, on
    // a detached server — and `false` means only "this connection is gone", nothing was sent.
    //
    // An application revocation must not be undone by a token check that STARTED before it:
    // resolveAuth is awaited, so a grant resolving afterwards would silently restore the principal.
    // The HELLO in flight is still answered (with the revocation ack), so its reauth() settles.
    let revokeEpoch = 0

    const control = {
        /** Cut this connection's principal NOW: notify, end the streams it loses, push the base
         *  facade. Exactly the corridor an expiring token takes, with the application's reason. */
        revoke: function revokePrincipal(reason?: any) {
            if (detached) return false
            revokeEpoch++
            // Revoking again is not an error and never resurrects anything: it re-states the fact
            // (a revocation after an expiry is a DIFFERENT reason the client should hear).
            downgradePrincipal('revoked', reason ?? 'revoked by application')
            return true
        },
        /** Apply a principal the application decided on, without waiting for a client HELLO
         *  (step-up finished elsewhere, admin impersonation, a token the app renewed itself).
         *  Same grant corridor as HELLO: facade, ack, deadline, timers — only uncorrelated. */
        grant: function grantPrincipal(grant: RpcAuthGrant) {
            return applyGrant(grant)
        },
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
        clearAuthTimers() // a deadline firing on a dead socket is a leak, not a feature
        detached = true
        sessions.clear()
        sessionByClient.clear()
        clientBySession.clear()
        hooks?.onDispose?.()
    }
    byKey.set(key, detachServer)

    async function handleServerPacket(incoming: any) {
        if (detached) return
        const msg = incoming
        let channel = legacyChannel
        // ONE Pkt.MAP per connection was attacked twice and does not have a shippable form.
        // See the note above the unsolicited push at the end of this factory for the whole
        // finding; the short version is that the push and this answer are not a duplicate
        // pair, because on a real socket.io connection the PUSH is the half nobody receives.
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
                // Correlated client ids prevent one shared socket client from
                // overwriting another client's negotiated callback policy.
                if (!Number.isSafeInteger(clientId) || clientId <= 0) {
                    await hooks?.onInvalid?.({
                        reason: 'invalid_payload',
                        request: msg,
                        error: 'RPC session requires a client id',
                    })
                    return
                }
                const owner = clientBySession.get(sessionId)
                if (owner != undefined && owner != clientId) {
                    await hooks?.onInvalid?.({
                        reason: 'invalid_payload',
                        request: msg,
                        error: 'RPC session belongs to another client',
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
                    if (!session && sessions.size >= MAX_CLIENT_SESSIONS) {
                        sessionByClient.delete(clientId)
                        clientBySession.delete(sessionId)
                        await hooks?.onInvalid?.({
                            reason: 'rate_limit',
                            request: msg,
                            error: 'too many RPC sessions',
                        })
                        return
                    }
                    if (session) flushSession(session)
                    session = createSession(sessionId, announced)
                    sessions.set(sessionId, session)
                }
                sendRaw([Pkt.CAPS, serverCaps, sessionId, serverGeneration])
                return
            }
            // Anonymous CAPS is the historical COMPACT handshake. Newer features
            // are per-client: letting one uncorrelated client enable CB_BATCH here
            // changes the wire format of another client's pre-generation callbacks.
            // AUTH_STATE is allowed here too: it is a CONTROL packet about this connection's
            // authorization, not a re-framing of another client's callback packets.
            legacySession.peerCaps = announced & (Caps.COMPACT | Caps.AUTH_STATE)
            sendRaw([Pkt.CAPS, serverCaps])
            sendCapsChallenge()
            return
        }
        // HELLO: in-band authorization. Without auth strategy — ignore (old client vs server without auth).
        if (Array.isArray(msg) && msg[0] === Pkt.HELLO) {
            const helloId = replyHelloId(msg[2]);
            // Server without auth: reply to HELLO is still 5-element (authAck=null) — so client
            // can distinguish "HELLO reply" from 4-element STRICT and not hang/confuse them.
            if (!auth?.resolveAuth) {
                sendCapsChallenge()
                sendRaw(mapReply(null, helloId))
                return
            }
            async function resolveHello() {
                const epoch = revokeEpoch; // an out-of-band revocation during the await wins
                try {
                    const r: any = await auth!.resolveAuth!(msg[1]);
                    // Resolving is async: the socket+key may have moved to another server
                    // meanwhile. A detached server neither rebuilds a principal nor arms a timer.
                    if (detached) return;
                    // The application revoked WHILE this token was being checked: a grant that
                    // started earlier must not resurrect the principal — but the HELLO still owns
                    // an answer, so it gets the current (revocation) ack, correlated.
                    if (revokeEpoch != epoch) { sendCapsChallenge(); sendRaw(mapReply(authAck, helloId)); return; }
                    // One grant corridor, shared with control.grant(): facade, ack, deadline, timers.
                    applyGrant(r, helloId);
                } catch (e: any) {
                    // Explicit revocation is the ONE rejection that kills the live session.
                    if (e?.revoke === true) {
                        downgradePrincipal('revoked', e?.message ?? String(e), helloId);
                        return;
                    }
                    // Reauth rejection DOES NOT drop live session: don't touch principal/authed/routeMap,
                    // just report ok:false to client via local ack (their reauth() resolves as-is).
                    sendCapsChallenge()
                    sendRaw(mapReply({ok: false, reason: e?.message ?? String(e)}, helloId))
                }
            }
            const hello = resolveHello();
            helloInFlight = hello;
            try { await hello; }
            finally { if (helloInFlight == hello) helloInFlight = null; }
            return;
        }
        // Caps.REQ_BATCH: the client's ordered envelope. Unwrapping is the whole of it — every
        // item still carries its own session id at index 5, so each is dispatched exactly as a
        // separate frame would have been, in array order. Dispatch is deliberately not awaited:
        // that is what separate frames do too, and it is what keeps one failing item from
        // discarding its siblings.
        if (Array.isArray(msg) && msg[0] == Pkt.BATCH) {
            if (!hasCap(serverCaps, Caps.CB_BATCH | Caps.REQ_BATCH)) return
            const batched = msg[1]
            if (!Array.isArray(batched) || batched.length > MAX_BATCH_ITEMS) return
            for (const packet of batched) {
                if (!Array.isArray(packet) || (packet[0] != Pkt.CALL && packet[0] != Pkt.PIPE)) continue
                void handleServerPacket(packet)
            }
            return
        }
        if (!Array.isArray(msg) || (msg[0] != Pkt.CALL && msg[0] != Pkt.PIPE)) return
        if (Number.isSafeInteger(msg[5])) {
            const session = sessions.get(msg[5])
            if (session) channel = {session}
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
                        const stepArgs = unpack(
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
                const args = unpack(
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
    // MEASURED WASTE THAT SURVIVES ON PURPOSE — third attempt, and the first one that could
    // explain why. An anonymous server puts Pkt.MAP on the wire twice per connection: this
    // unsolicited push, and again in answer to the client's Pkt.STRICT — 142 B and a frame
    // (experiments/rpc-perf-2026-07). They are NOT a duplicate pair:
    //   * On a socket.io connection with the client built after `await once('connect')`, this
    //     push reaches NOBODY. engine.io hands CONNECT_ACK, this challenge and this MAP to the
    //     namespace inside ONE synchronous ws read, so the RPC client — created a microtask
    //     later — is not subscribed yet and socket.io drops an event with no listener. The
    //     STRICT answer is then the only MAP that ever arrives. Measured directly: without
    //     ready() such a client never gets a schema at all and calls travel by path.
    //   * Where the peer IS attached first (createRpcInProc, a hub client built before
    //     connect), the push lands and the STRICT answer is the redundant one.
    // Which half is waste therefore depends on a race the server cannot observe, and the peer
    // that CAN observe it only learns the answer one round trip after it had to ask.
    //
    // What was tried, and why none of it shipped:
    //   * Dropping the push breaks every client that never calls ready().
    //   * Making the client always ask instead breaks in-band auth and costs a round trip.
    //   * Dropping the racing STRICT (a capability bit, with a forced [Pkt.STRICT, 1] the
    //     client sends once it has proof the push was lost) works and is hang-free — but it
    //     saves two frames only where the push landed and costs one where it did not, i.e. it
    //     regresses exactly the `connect` family the stand measures.
    //   * Deferring the push to the peer's FIRST packet removes the waste in every topology
    //     (measured: connect s2c control packets 9 → 4, and a client that never calls ready()
    //     starts getting its schema) — but an old peer observes it too, which the caps
    //     contract forbids, and replay/rpc-optional-capability.test.ts requires this MAP to be
    //     emitted synchronously inside createRpcServer so it can intercept and replay it.
    // Removing the second MAP needs the intercept assumption of that oracle relaxed first.
    if (auth?.resolveAuth) sendCapsChallenge()
    else sendMap()

    // Additive: this factory used to return nothing. ONE facet — commands inward, for the
    // application that owns this connection. Reads (schema, subscriptions) are not here.
    return {control}
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
    // Returns the server's control facet (additive — callers that ignore it are unchanged).
    return createServer(socket, key, target, hooks, limits, auth, opt, debug);
}

/** Commands inward over ONE connection's principal — what an application keeps per session
 *  (`Map<userId, RpcServerControl>`) to revoke or grant out of band. Derived, not handwritten. */
export type RpcServerControl = ReturnType<typeof createRpcServer>['control']

export type { PromiseServerHooks, RpcLimits, RpcServerAuth, RpcAuthGrant, RpcPrincipalChange };
export type { RpcOpt } from "./rpc-caps";
