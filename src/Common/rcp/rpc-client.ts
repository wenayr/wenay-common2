import { Pkt, GRANT_FACTS_KEY, type RpcAuthNotice, type SocketTmpl, type tAuthState } from "./rpc-protocol";
import { rpcPathKey } from "./rpc-path";
import {createIdPool, type idPool} from "../id-pool";
import {pack, resolveCA, unpackResult} from "./rpc-walk";
import {isSafeKey, resolveLimits, type RpcLimits} from './rpc-limits'
import {rpcResultLimitsProperty} from './rpc-result-limits'
import {createShapeDecoder, createRowDecoder} from './rpc-shape'
import {MyError} from "../../toError/myThrow";
import {makeOff} from "./rpc-off";
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
import {
    createTransportLifecycle,
    RPC_MEMBER_LOOKUP,
    RPC_SCHEMA_READY,
    RPC_TRANSPORT_CONTROL,
    RPC_TRANSPORT_LIFECYCLE,
} from '../events/transport-lifecycle'
// Types only (no runtime cycle): replay members of the API are projected into the client
// replay surface (line/since/keyframe/frame) — replaySubscribe(client.func.key) without casts
import type { IsReplayMember, IsListenMember, InferArgs, ReplaySocketListen, SocketListenMember } from "./listen-deep";

// Shared id pool per (socket × key): two clients on the same socket+key share the id space,
// otherwise their reqId collide and a foreign RESP resolves both waits.
const SHARED_POOLS = new WeakMap<object, Map<string, idPool>>();
const SHARED_SESSION_IDS = new WeakMap<object, Map<string, number>>()

function sharedPool(socket: object, key: string) {
    let byKey = SHARED_POOLS.get(socket);
    if (!byKey) { byKey = new Map(); SHARED_POOLS.set(socket, byKey); }
    let pool = byKey.get(key);
    if (!pool) { pool = createIdPool(); byKey.set(key, pool); }
    return pool;
}

function nextSessionId(socket: object, key: string) {
    let byKey = SHARED_SESSION_IDS.get(socket)
    if (!byKey) {
        byKey = new Map()
        SHARED_SESSION_IDS.set(socket, byKey)
    }
    const id = (byKey.get(key) ?? 0) + 1
    if (!Number.isSafeInteger(id)) {
        throw new RangeError('RPC session id space exhausted')
    }
    byKey.set(key, id)
    return id
}

// Wire error object → MyError instance (name/stack/code/data/cause are preserved).
// Non-objects and foreign shapes are returned as-is.
const reviveErr = (o: any): any => {
    if (o == null || typeof o != "object" || typeof o.message != "string" || typeof o.name != "string") return o;
    // data is unpacked symmetrically with errToObj (rich types: BigInt/Date/Map/Set). For plain JSON
    // unpackResult is identity, so with an old server (raw data) it also works correctly.
    const o2 = o.data !== undefined ? { ...o, data: unpackResult(o.data) } : o;
    const err = MyError.fromWire(o2);
    if (o.cause !== undefined) (err as any).cause = reviveErr(o.cause);
    return err;
};

function listenKeyArg(a: any): any {
    if (typeof a == "function") return "@fn";
    if (typeof a == "bigint") return {$_b: a.toString()};
    if (a instanceof Date) return {$_d: a.valueOf()};
    if (a instanceof Map) return {$_m: [...a.entries()].map(([k, v]) => [listenKeyArg(k), listenKeyArg(v)])};
    if (a instanceof Set) return {$_s: [...a.values()].map(listenKeyArg)};
    if (Array.isArray(a)) return a.map(listenKeyArg);
    if (a && typeof a == "object") {
        const out: any = {};
        for (const k of Object.keys(a).sort()) out[k] = listenKeyArg(a[k]);
        return out;
    }
    return a;
}

type tProxyEntry = {ref: WeakRef<object>; token: object}

function createPathProxyCache() {
    const WeakRefConstructor = globalThis.WeakRef
    const FinalizationRegistryConstructor = globalThis.FinalizationRegistry

    if (typeof WeakRefConstructor != 'function' || typeof FinalizationRegistryConstructor != 'function') {
        const values = new Map<string, object>()

        function get(path: string[]) {
            return values.get(rpcPathKey(path))
        }

        function set(path: string[], proxy: object) {
            values.set(rpcPathKey(path), proxy)
            return proxy
        }

        return {get, set}
    }

    const values = new Map<string, tProxyEntry>()
    const registry = new FinalizationRegistryConstructor<{key: string; token: object}>(function releaseProxy(entry) {
        if (values.get(entry.key)?.token == entry.token) values.delete(entry.key)
    })

    function get(path: string[]) {
        const key = rpcPathKey(path)
        const proxy = values.get(key)?.ref.deref()
        if (!proxy) values.delete(key)
        return proxy
    }

    function set(path: string[], proxy: object) {
        const key = rpcPathKey(path)
        const token = {}
        values.set(key, {ref: new WeakRefConstructor(proxy), token})
        registry.register(proxy, {key, token})
        return proxy
    }

    return {get, set}
}
// Helper types
type UnwrapPromise<T> = T extends Promise<infer R> ? R : T;

export type DeepDataOnly<T> = T extends Function
    ? never
    : T extends ArrayBuffer | ArrayBufferView
        ? T
        : T extends readonly any[]
            // mapped tuple: tuples are preserved ([string, number] does not degrade to (string|number)[] —
            // important for replay converts {seq, ts, event: Z}); regular arrays are mapped as before
            ? { [I in keyof T]: DeepDataOnly<T[I]> }
            : T extends object
                ? { [K in keyof T as T[K] extends Function ? never : K]: DeepDataOnly<T[K]> }
                : T;

// --- 1. TYPING FOR REGULAR CALLS (WITHOUT PIPE) ---
export type ClientAPIAll<T> = {
    [K in keyof T as NonNullable<T[K]> extends Function ? K : NonNullable<T[K]> extends object ? K : never]:
        // replay member (detection as in listen-deep) → client replay surface,
        // structurally compatible with ReplayRemote: replaySubscribe(client.func.key) without casts
        IsReplayMember<NonNullable<T[K]>> extends true
            ? ReplaySocketListen<InferArgs<NonNullable<T[K]>>> | Extract<T[K], undefined | null>
            // plain Listen member → the same subscription surface DeepSocketListen gives.
            // Without this branch the object recursion below reaches `on` as an ordinary
            // method and maps it to Promise<DeepDataOnly<SubscriptionHandle>>; the handle is
            // callable, DeepDataOnly kills Function, and the result collapses to
            // Promise<never> — which is why subscribing used to need a cast.
            : IsListenMember<NonNullable<T[K]>> extends true
            ? SocketListenMember<InferArgs<NonNullable<T[K]>>> | Extract<T[K], undefined | null>
            : NonNullable<T[K]> extends (...args: infer A) => infer R
                // Regular call returns ONLY Promise with clean data. No chain continuation.
                ? ((...args: A) => Promise<DeepDataOnly<UnwrapPromise<R>>>) | Extract<T[K], undefined | null>
                : NonNullable<T[K]> extends object
                    ? ClientAPIAll<NonNullable<T[K]>> | Extract<T[K], undefined | null>
                    : never;
};

type NonFalsy<T> = Exclude<T, false | null | 0 | "" | undefined>;

export type ClientAPIStrict<T> = {
    [K in keyof T as NonFalsy<T[K]> extends Function
        ? K
        : NonFalsy<T[K]> extends object
            ? K
            : never]:
    // replay member — as in ClientAPIAll; already projected ReplaySocketListen (auto-path,
    // ClientAPIStrict<DeepSocketListen<T>>) does not reach here (it has no getSince) and is mapped below
    IsReplayMember<NonFalsy<T[K]>> extends true
        ? ReplaySocketListen<InferArgs<NonFalsy<T[K]>>>
        // plain Listen member — same branch as ClientAPIAll, same reason
        : IsListenMember<NonFalsy<T[K]>> extends true
        ? SocketListenMember<InferArgs<NonFalsy<T[K]>>>
        : NonFalsy<T[K]> extends (...args: infer A) => infer R
            ? (...args: A) => Promise<DeepDataOnly<UnwrapPromise<R>>>
            : NonFalsy<T[K]> extends object
                ? ClientAPIStrict<NonFalsy<T[K]>>
                : never;
};



// --- 2. TYPING FOR PIPE CALLS ---
// Interface for working with arrays inside pipe (if the server returns an array,
// we can continue the path by index or via map)
export interface PipeArrayAPI<T> extends Promise<DeepDataOnly<T[]>> {
    [index: number]: PipeAPI<T>;
    // map and filter can be added if the server side (and our Proxy) learns to handle them
}

export type PipeAPI<T> = T extends Array<infer U>
    ? PipeArrayAPI<U>
    : {
        [K in keyof T as T[K] extends Function ? K : T[K] extends object ? K : never]:
            T[K] extends (...args: infer A) => infer R
                // Pipe call returns both Promise (for await) and continues PipeAPI for chaining
                ? (...args: A) => Promise<DeepDataOnly<UnwrapPromise<R>>> & PipeAPI<UnwrapPromise<R>>
                : T[K] extends object
                    ? PipeAPI<T[K]>
                    : never;
    };

type ClientApiHandle = {
    log: (s: boolean) => void;
    pending: () => number;
    callbacks: () => number;
    clearPromises: (reject?: boolean) => void;
    clearCallbacks: () => void;
    remove: (fn: Function) => void;
    end: (fn: Function) => void;
    /** Live network subscriptions (dedup enabled): address + number of local consumers. */
    subscriptions: () => { key: string; consumers: number }[];
};

// ============================================================
// Dynamic token lifecycle — client-side vocabulary
// ============================================================
// The server pushes [Pkt.AUTH, notice] when the current token nears its deadline, expires or
// is revoked. 'renewFailed' and 'renewed' are added HERE and never travel on the wire: they are
// the two LOCAL outcomes of an installed renewer — nothing minted, or a fresh grant the server
// acknowledged — so a consumer watches ONE stream instead of correlating a wire state with a
// silent renewal. Both report what happened WITHOUT being asked, which is the rule for this
// stream: a manual reauth() answers its own caller with the same ack and is not an event.

/** State of the client auth stream: the protocol states plus the local renewal outcome. */
export type tAuthEventState = tAuthState | 'renewFailed' | 'renewed'

/** What auth observers receive: the server notice, widened by the local state. */
export type RpcAuthEvent = Omit<RpcAuthNotice, 'state'> & {state: tAuthEventState}

/** Why the client asks the installed renewer for a token. */
export type tAuthRenewReason = 'connect' | 'notice' | 'unauthorized'

/** Request handed to the renewer; `notice` is present only for reason 'notice'. */
export type RpcAuthRenewRequest = {reason: tAuthRenewReason; notice?: RpcAuthEvent}

/** Renewal seam: resolve with a fresh token, or null/undefined when there is none. */
export type RpcTokenRenew = (request: RpcAuthRenewRequest) => any

const IS_RPC_PIPE = Symbol.for("isRpcPipe");

function createClient<T extends object>(socket: SocketTmpl, key: string, opts?: { limit?: number; limits?: RpcLimits; dedupeListen?: boolean; token?: any; opt?: RpcOpt }) {
    const limit = opts?.limit ?? 10000;
    const lim = opts?.limits ? resolveLimits(opts.limits) : undefined;
    const pool = sharedPool(socket, key);
    type tPending = {ok: Function; fail: Function; cbs: number[]; promise?: Promise<any>}
    const pending = new Map<number, tPending>();
    const callbacks = new Map<number, Function>();
    // compact subscription ticks: cbId → (shapeId → key order), declared by server in Pkt.SHAPE
    const compactShapes = new Map<number, Map<number, string[]>>()
    const clientCaps = optToCaps(opts?.opt) // independently enabled wire features declared to server
    let peerServerCaps: tCaps = 0 // what the server declared (for future bidirectional features)
    const callbackBatchOn = () => hasCap(clientCaps & peerServerCaps, Caps.CB_BATCH)
    // Caps.REQ_BATCH extends that envelope to CALL/PIPE going out and RESP coming back, so it
    // needs CB_BATCH as well: one ordered queue per session is what lets a response ride behind
    // the callbacks it must follow. Off unless the application asked — see optToCaps.
    const reqBatchOn = () => hasCap(clientCaps & peerServerCaps, Caps.CB_BATCH | Caps.REQ_BATCH)
    // Caps.ROWS moves the shape table from `compactShapes` (per cbId, dropped only on CB_END —
    // the tail the benchmark found) to ONE bounded connection-scoped table, and adds the row
    // marker that a result or a tick may carry. Needs COMPACT: the tick half IS Pkt.SHAPE/CBV.
    const rowsOn = () => hasCap(clientCaps & peerServerCaps, Caps.COMPACT | Caps.ROWS)
    const shapeDecoder = createShapeDecoder()
    const rowCodec = createRowDecoder(lim)
    // The codec is handed to the walker ONLY when the bit is live, so an un-negotiated build
    // decodes a value the previous way — the reserved key stays an ordinary object there.
    const rows = () => rowsOn() ? rowCodec : undefined
    // The request queue. Same batcher, same microtask discipline, same escape hatches as the
    // server's callback queue; only the envelope opcode differs. Control packets (CAPS, HELLO,
    // STRICT) flush it first — they are ordering barriers in this direction too, and a HELLO
    // overtaking a queued CALL would change what a gated server does with that call.
    const requestBatch = createCallbackPacketBatcher({
        send: function sendRequestPacket(packet: any[]) { socket.emit(key, packet) },
        opt: opts?.opt?.requestBatch,
        envelope: Pkt.BATCH,
    })
    let serverGeneration: number | undefined
    const clientId = nextSessionId(socket, key)
    let sessionId = nextSessionId(socket, key)
    let serverGenerationRecoveryPending = false

    function beginTransportGeneration(generation?: number) {
        serverGeneration = generation
        sessionId = nextSessionId(socket, key)
        // A new server instance restarts shape ids at 0, and this session id is new to it, so
        // every id declared to the previous one is meaningless now. Keeping the table would be
        // the one way a bounded registry could still decode rows against the wrong keys.
        shapeDecoder.clear()
    }

    function advertiseClientCaps() {
        requestBatch.flush()
        socket.emit(key, serverGeneration == undefined
            ? [Pkt.CAPS, clientCaps]
            : [
                Pkt.CAPS,
                clientCaps,
                sessionId,
                serverGeneration,
                clientId,
            ])
    }
    // ids of canceled requests/callbacks: NOT returned to pool immediately — a late RESP/CB_END
    // from server could steal a newly reused id for a different request
    const zombies = new Set<number>();
    const retire = (id: number) => { zombies.add(id); };
    let disposed = false;
    // A direct createRpcClient owns no socket lifecycle and remains immediately usable.
    // createRpcClientHub explicitly switches this control to managed-offline until handshake.
    const transport = createTransportLifecycle(true)
    // onDisconnect: thin registrar in the style of strictWaiters/authWaiters of this file.
    // Called exactly ONCE from dispose() (teardown on break/rotation). off()-handle via
    // makeOff; promise resolves on actual disconnect.
    let disconnectCbs: ((reason: string) => void)[] = [];
    let disconnectResolve: (reason: string) => void = () => {};
    const disconnectPromise = new Promise<string>(res => { disconnectResolve = res; });
    function onDisconnect(cb: (reason: string) => void) {
        disconnectCbs.push(cb);
        function offDisconnect() { const i = disconnectCbs.indexOf(cb); if (i >= 0) disconnectCbs.splice(i, 1); }
        return makeOff(disconnectPromise, offDisconnect);
    }
    const routeCache: Record<string, number> = {};
    let schemaKnown = false
    let strictData: any = {};
    let strictWaiters: ((v: unknown) => void)[] = [];
    let _ready: null | Promise<void> = null
    let debug = false;
    // Arguments travel through the SAME walker as results, so the collision is symmetric and so
    // is the report. `debug` is flipped at runtime by api.log(), hence a getter and not a
    // constant: the packer receives undefined while logging is off and skips the check entirely.
    function reportReservedKey(markerKey: string) {
        console.log('[RPC OUT] reserved key', markerKey,
            '— an application value of this shape is decoded as a library value by the peer')
    }
    const reservedReport = () => debug ? reportReservedKey : undefined

    // --- in-band auth (Pkt.HELLO/authAck) ---
    let authToken: any = opts?.token ?? null;
    let authStatus: any = undefined; // server's last authAck; null = server without auth (4-element MAP)
    let authWaiters: ((s: any) => void)[] = [];
    let authPending = false; // HELLO/reauth in progress → auth() waits for fresh ack, not the old one

    // --- HELLO ↔ MAP correlation (Caps.HELLO_ID) ---
    // A reauth() may be settled ONLY by the answer to its OWN HELLO. The server echoes the id
    // back in the 6th element of Pkt.MAP; a MAP without one from a CORRELATING server is
    // unsolicited (token downgrade, STRICT push) — a state change, not an answer to a question
    // nobody asked. An old server never echoes, but it also never pushes a downgrade: there the
    // next authAck-bearing MAP answers the OLDEST outstanding HELLO, exactly as before.
    const helloIdOn = () => hasCap(clientCaps & peerServerCaps, Caps.HELLO_ID)
    const helloIdSent = hasCap(clientCaps, Caps.HELLO_ID)
    let helloSeq = 0
    const helloWaits = new Map<number, {resolve?: (ack: any) => void}>()

    // ONE place emits a HELLO. The id is registered BEFORE the packet leaves: a synchronous
    // adapter can deliver the answering MAP inside emit(). Even the resolver-less HELLO of
    // init() is tracked — it owns authPending, so its answer must be its own and not the next MAP.
    function sendHello(token: any, resolve?: (ack: any) => void) {
        const id = ++helloSeq
        helloWaits.set(id, {resolve})
        authPending = true
        requestBatch.flush()
        socket.emit(key, helloIdSent ? [Pkt.HELLO, token, id] : [Pkt.HELLO, token])
    }

    function settleHello(id: number, status: any) {
        const wait = helloWaits.get(id)
        if (!wait) return
        helloWaits.delete(id)
        authPending = helloWaits.size > 0
        wait.resolve?.(status)
    }

    // A reply that can no longer arrive must not become a new way to hang: every teardown that
    // releases authWaiters releases the outstanding HELLOs with the same {ok:false} shape.
    function abandonHellos(status: any) {
        const waits = [...helloWaits.values()]
        helloWaits.clear()
        authPending = false
        for (const wait of waits) wait.resolve?.(status)
    }

    // ONE MAP settles at most ONE HELLO.
    function drainAuth(status: any, helloId?: any) {
        if (Number.isSafeInteger(helloId)) settleHello(helloId, status)
        // No negotiated correlation: an old server never pushes an unsolicited authAck either,
        // so the oldest outstanding HELLO owns this reply — today's behavior, kept.
        else if (!helloIdOn()) for (const id of helloWaits.keys()) { settleHello(id, status); break }
        // While a HELLO is outstanding, auth() waits for ITS answer: resolving it from an
        // unsolicited downgrade would be the same stale answer, one layer up.
        if (authPending) return
        const waiters = authWaiters
        authWaiters = []
        for (const resolve of waiters) resolve(status)
    }

    const setAuthStatus = (s: any, helloId?: any) => { authStatus = s; drainAuth(s, helloId); };

    // A client that presented no token is acknowledged by nobody: against a gated server its
    // STRICT is answered by a four-element MAP, so auth() waited for an ack that by construction
    // could never come. The answer here is LOCAL and says exactly that — no server state is
    // invented, because from a client that never asked a gated server and a server without auth
    // look the same. The rule above stays intact: a client that HOLDS a token, or that has a
    // HELLO outstanding (reauth(null) issues one), is still answered only by its own authAck, so
    // no STRICT companion can resolve a pending HELLO with a premature null.
    function settleAnonymousAuth() {
        if (authToken != null || authPending || authStatus !== undefined) return
        authStatus = {ok: false, reason: 'RPC client presented no token'}
        const waiters = authWaiters
        authWaiters = []
        for (const resolve of waiters) resolve(authStatus)
    }

    // ===================================================================
    // Dynamic token lifecycle: Pkt.AUTH notices + one renewal seam
    // ===================================================================
    // Negotiated like every other wire feature — an un-negotiated AUTH packet is not ours to
    // interpret (same gate idiom as callbackBatchOn for Pkt.CB_BATCH). Without an installed
    // renewer nothing below ever runs: the client neither renews nor retries, as before.
    const authStateOn = () => hasCap(clientCaps & peerServerCaps, Caps.AUTH_STATE)
    let authStateCbs: ((event: RpcAuthEvent) => void)[] = []
    let tokenRenew: RpcTokenRenew | null = null
    let renewInFlight: Promise<boolean> | null = null

    function onAuthState(cb: (event: RpcAuthEvent) => void) {
        authStateCbs.push(cb)
        function offAuthState() { const i = authStateCbs.indexOf(cb); if (i >= 0) authStateCbs.splice(i, 1) }
        return makeOff(disconnectPromise, offAuthState)
    }

    function notifyAuthState(event: RpcAuthEvent) {
        const errors: any[] = []
        for (const cb of [...authStateCbs]) {
            try { cb(event) }
            catch (error) { errors.push(error) }
        }
        rethrowConsumerErrors(errors, 'Multiple RPC auth state consumers failed')
    }

    function setTokenRenew(renew: RpcTokenRenew | null) { tokenRenew = renew ?? null }

    // ONE renewal at a time: several unauthorized calls plus an 'expiring' notice must present
    // ONE fresh token. reauth waiters are shared and uncorrelated, so concurrent reauths would
    // resolve each other's promises.
    function renewAuth(request: RpcAuthRenewRequest) {
        if (!tokenRenew || disposed) return Promise.resolve(false)
        const running = renewInFlight
        if (running) return running
        const started = presentRenewedToken(request)
        renewInFlight = started
        function clearRenewInFlight() { if (renewInFlight == started) renewInFlight = null }
        started.then(clearRenewInFlight, clearRenewInFlight)
        return started
    }

    // Never rejects: a renewal is best-effort, its failure is a fact on the auth stream.
    async function presentRenewedToken(request: RpcAuthRenewRequest) {
        const renew = tokenRenew
        if (!renew) return false
        try {
            const token = await renew(request)
            if (disposed) return false
            // The SAME token is not a renewal: re-presenting a dead one would let expiry drive
            // an endless expire→renew→expire loop.
            if (token == null || token === authToken) {
                reportRenewFailure(request, token == null
                    ? 'RPC token renewer produced no token'
                    : 'RPC token renewer produced the token already in force')
                return false
            }
            // Before the handshake (hub-managed offline) HELLO has not gone out yet, so seeding
            // the token IS the renewal — requestSchema() presents it. Nothing is acknowledged
            // yet, so there is no grant to report: the handshake's own ack carries it.
            if (!transport.api.connected()) { authToken = token; return true }
            const ack = await reauth(token)
            if (ack?.ok === false) return false
            reportGrantRenewed(ack)
            return true
        } catch (error) {
            reportRenewFailure(request, error)
            return false
        }
    }

    // A renewer that yields nothing must leave a defined state, not a wedged connection.
    // 'connect' has nothing to report: the token the client already holds stays in force.
    function reportRenewFailure(request: RpcAuthRenewRequest, reason: any) {
        if (request.reason == 'connect') return
        notifyAuthState({state: 'renewFailed', reason})
    }

    // An AUTOMATIC renewal moves the grant behind the application's back, so its success is a
    // fact for the stream: without it a consumer showing the deadline can only poll auth() until
    // the ack changes. The counterpart of 'renewFailed', and the same boundary — a manual
    // reauth() resolves with this very ack and reports nothing here.
    function reportGrantRenewed(ack: any) {
        const event: RpcAuthEvent = {state: 'renewed'}
        const expiresAt = grantDeadline(ack)
        if (expiresAt != undefined) event.expiresAt = expiresAt
        notifyAuthState(event)
    }

    // The deadline of a granted token, when the server attached one. It lives in the reserved
    // GRANT_FACTS_KEY sub-object of the ack (wire contract in rpc-protocol.ts) because the ack
    // itself belongs to the application. Everything about it is optional: an old server sends
    // no such key, and an application ack that already owns it keeps its own value — hence
    // no shape is trusted, and an unknown deadline only means an event without one.
    function grantDeadline(ack: any) {
        const at = ack?.[GRANT_FACTS_KEY]?.expiresAt
        return Number.isFinite(at) ? at as number : undefined
    }

    function rethrowConsumerErrors(errors: any[], message: string) {
        if (errors.length == 0) return
        const error = errors.length == 1 ? errors[0] : new AggregateError(errors, message)
        setTimeout(function rethrowRpcConsumerErrors() { throw error }, 0)
    }

    // --- flow-paced streams (Caps.CB_FLOW) ---
    // The server declared cbId flow-paced (Pkt.CB_FLOW): frames are delivered one at a time —
    // the next one after the previous consumer call settles (its returned promise included), so
    // an async consumer paces the producer by its real speed. Acks are cumulative and coalesced
    // (one per ackEvery frames plus one on queue drain), never one per frame. A frame whose
    // payload the decoder drops is still COUNTED: the ack means "consumed from the wire", and a
    // silent gap would stall the producer forever.
    type tClientFlowStream = {
        ackEvery: number
        /** Decoded frame args in arrival order; null = payload dropped (counted anyway). */
        queue: (any[] | null)[]
        draining: boolean
        delivered: number
        acked: number
        onDrained?: (() => void)[]
    }
    const flowStreams = new Map<number, tClientFlowStream>()
    const flowOn = () => hasCap(clientCaps & peerServerCaps, Caps.CB_FLOW)

    function enqueueFlowFrame(cbId: number, stream: tClientFlowStream, args: any[] | null) {
        stream.queue.push(args)
        if (!stream.draining) void drainFlowStream(cbId, stream)
    }

    async function drainFlowStream(cbId: number, stream: tClientFlowStream) {
        stream.draining = true
        try {
            while (stream.queue.length) {
                if (disposed || flowStreams.get(cbId) != stream) return
                const args = stream.queue.shift()!
                if (args) {
                    const cb = callbacks.get(cbId)
                    if (cb) {
                        try {
                            const r = cb(...args)
                            if (r && typeof r.then == 'function') await r
                        } catch (error) {
                            rethrowConsumerErrors([error], 'RPC flow callback consumer failed')
                        }
                    }
                }
                stream.delivered++
                if (!disposed && flowStreams.get(cbId) == stream
                    && (stream.queue.length == 0 || stream.delivered - stream.acked >= stream.ackEvery)) {
                    stream.acked = stream.delivered
                    socket.emit(key, [Pkt.CB_ACK, cbId, stream.delivered])
                }
            }
        } finally {
            stream.draining = false
            if (stream.queue.length == 0) releaseFlowDrainWaiters(stream)
        }
    }

    function releaseFlowDrainWaiters(stream: tClientFlowStream) {
        const waiters = stream.onDrained
        if (!waiters) return
        stream.onDrained = undefined
        for (const resolve of waiters) resolve()
    }

    function dropFlowStream(cbId: number) {
        const stream = flowStreams.get(cbId)
        if (!stream) return
        flowStreams.delete(cbId)
        releaseFlowDrainWaiters(stream)
    }

    /** null when the stream has nothing queued; else a promise for its drain. */
    function flowDrained(cbId: number) {
        const stream = flowStreams.get(cbId)
        if (!stream || (!stream.draining && stream.queue.length == 0)) return null
        return new Promise<void>(function waitFlowDrain(resolve) { (stream.onDrained ??= []).push(resolve) })
    }

    // After dispose the only thing still owed is the shared id space: an id whose owner is gone
    // must come back, whether its RESP/CB_END arrived alone or inside an envelope.
    function releaseZombiePacket(packet: any) {
        if (!Array.isArray(packet)) return
        if ((packet[0] == Pkt.RESP || packet[0] == Pkt.CB_END) && zombies.delete(packet[1])) pool.release(packet[1])
    }

    function handlePacket(incoming: any, batchErrors?: any[]) {
        const msg = incoming
        if (!Array.isArray(msg)) return;
        if (disposed) {
            // after dispose, only return zombie-ids to the shared pool, ignore everything else
            if (msg[0] == Pkt.BATCH) {
                if (Array.isArray(msg[1])) for (const item of msg[1]) releaseZombiePacket(item);
                return;
            }
            releaseZombiePacket(msg);
            return;
        }
        switch (msg[0]) {
            case Pkt.RESP: {
                const req = pending.get(msg[1]);
                if (!req) { if (zombies.delete(msg[1])) pool.release(msg[1]); break; }
                // Flow streams deliver asynchronously, so their queued frames must land before
                // the response settles — the ordering the synchronous path had for free.
                const drains = req.cbs.map(flowDrained).filter(Boolean) as Promise<void>[]
                if (drains.length) {
                    void Promise.all(drains).then(function resumeRespAfterFlowDrain() { handlePacket(msg) })
                    break
                }
                pending.delete(msg[1]);
                pool.release(msg[1]);
                for (const cbId of req.cbs) { if (callbacks.delete(cbId)) pool.release(cbId); dropFlowStream(cbId); }
                // Presence of the fourth slot is the error discriminant. Truthiness
                // loses legitimate `throw false`, `throw 0`, `throw ''` and `throw undefined`.
                if (msg.length > 3) {
                    try {
                        req.fail(reviveErr(msg[3]))
                    } catch (error) {
                        req.fail(error)
                    }
                }
                else {
                    // limit violation/corrupt payload in response — reject this request only
                    try {
                        req.ok(unpackResult(msg[2], lim, rows()))
                    }
                    catch (e) { req.fail(e); }
                }
                break;
            }
            case Pkt.CB: {
                const cb = callbacks.get(msg[1]);
                if (!cb) break;
                const flow = flowStreams.get(msg[1])
                let cbArgs: any[];
                // stream has no error channel — drop corrupt/limit-exceeding packet
                // (previously .map(unpackResult) also passed index as a second argument like lim)
                try {
                    cbArgs = (msg[2] || []).map((a: any) => unpackResult(a, lim, rows()))
                }
                catch (e) {
                    if (debug) console.log("[RPC CB] dropped:", e);
                    if (flow) enqueueFlowFrame(msg[1], flow, null)
                    break;
                }
                if (flow) { enqueueFlowFrame(msg[1], flow, cbArgs); break }
                try {
                    cb(...cbArgs)
                } catch (error) {
                    if (batchErrors) batchErrors.push(error)
                    else rethrowConsumerErrors([error], 'RPC callback consumer failed')
                }
                break;
            }
            case Pkt.SHAPE: {
                // Late shape from dead transport-generation should not create state tail.
                // Under Caps.ROWS there is no per-cbId tail to create: the table is one bounded
                // connection-scoped map that a response may equally have filled, so a shape is
                // accepted on its own merits and the cbId only names the stream that used it.
                if (!rowsOn() && !callbacks.has(msg[1])) break
                const shapeId = msg[2]
                const keys = msg[3]
                if (!Number.isSafeInteger(shapeId) || shapeId < 0) break
                if (!Array.isArray(keys) || !keys.every((k: any) => typeof k == 'string' && isSafeKey(k))) break
                if (new Set(keys).size != keys.length) break
                if (rowsOn()) { shapeDecoder.declare(shapeId, [...keys]); break }
                // server declared shape of compact ticks for cbId: shapeId → key order
                let m = compactShapes.get(msg[1])
                if (!m) { m = new Map(); compactShapes.set(msg[1], m) }
                m.set(shapeId, [...keys])
                break;
            }
            case Pkt.CBV: {
                // compact tick: reconstruct object from shape + values and call callback as regular CB
                const cb = callbacks.get(msg[1]);
                if (!cb) break;
                const flow = flowStreams.get(msg[1])
                const keys = rowsOn() ? shapeDecoder.keysOf(msg[2]) : compactShapes.get(msg[1])?.get(msg[2])
                if (!keys) { if (flow) enqueueFlowFrame(msg[1], flow, null); break; }
                const vals = msg[3]
                if (!Array.isArray(vals) || vals.length != keys.length) {
                    if (flow) enqueueFlowFrame(msg[1], flow, null)
                    break
                }
                let obj: any;
                try {
                    obj = {}
                    keys.forEach(function reconstructShapeValue(k: string, i: number) {
                        if (!isSafeKey(k)) throw new Error('Unsafe compact shape key')
                        obj[k] = unpackResult(vals[i], lim, rows())
                    })
                }
                catch (e) {
                    if (debug) console.log("[RPC CBV] dropped:", e);
                    if (flow) enqueueFlowFrame(msg[1], flow, null)
                    break;
                }
                if (flow) { enqueueFlowFrame(msg[1], flow, [obj]); break }
                try {
                    cb(obj)
                } catch (error) {
                    if (batchErrors) batchErrors.push(error)
                    else rethrowConsumerErrors([error], 'RPC compact callback consumer failed')
                }
                break;
            }
            case Pkt.CB_END: {
                const cbId = msg[1] as number;
                compactShapes.delete(cbId);
                dropFlowStream(cbId);
                // release only if id is ours (tracked) — foreign/late CB_END must not
                // release id occupied by another request
                if (callbacks.delete(cbId)) pool.release(cbId);
                else if (zombies.delete(cbId)) pool.release(cbId);
                break;
            }
            case Pkt.CAPS: {
                // server declared its bitset of contract features — remember (bidirectional half
                // of handshake). For COMPACT client does not gate: CBV arrives only if WE declared COMPACT.
                const declared = typeof msg[1] == 'number' ? msg[1] : 0
                const declaredSessionId = msg[2]
                const generation = msg[3]
                if (declaredSessionId == null && Number.isSafeInteger(generation)
                    && generation > 0) {
                    if (serverGeneration != generation) {
                        const replacingLiveServer = serverGeneration != undefined
                        if (replacingLiveServer) prepareServerGenerationReplacement()
                        beginTransportGeneration(generation)
                        if (replacingLiveServer) requestSchema()
                    }
                    peerServerCaps = declared
                    advertiseClientCaps()
                    break
                }
                if (declaredSessionId == sessionId && generation == serverGeneration) {
                    peerServerCaps = declared
                    finishServerGenerationRecovery()
                    break
                }
                if (declaredSessionId == undefined && generation == undefined) {
                    peerServerCaps = declared
                }
                break;
            }
            case Pkt.CB_FLOW: {
                // Un-negotiated feature: the packet is not ours to interpret (as CB_BATCH).
                if (!flowOn()) break
                const cbId = msg[1]
                if (!Number.isSafeInteger(cbId) || !callbacks.has(cbId)) break
                const ackEvery = Number.isSafeInteger(msg[2]) && msg[2] >= 1 ? msg[2] : 1
                // Re-declaration must not reset counters: the server's sent/acked survive too.
                if (!flowStreams.has(cbId)) {
                    flowStreams.set(cbId, {ackEvery, queue: [], draining: false, delivered: 0, acked: 0})
                }
                break;
            }
            case Pkt.CB_BATCH: {
                if (!callbackBatchOn() || !Array.isArray(msg[1])) break
                const packets = msg[1]
                if (packets.length > 1024) break
                const valid = packets.every(function isCallbackPacket(packet: any) {
                    return Array.isArray(packet)
                        && (packet[0] == Pkt.CB || packet[0] == Pkt.SHAPE || packet[0] == Pkt.CBV
                            || packet[0] == Pkt.CB_FLOW)
                })
                if (!valid) break
                const callbackErrors: any[] = []
                for (const packet of packets) {
                    try { handlePacket(packet, callbackErrors) }
                    catch (error) { callbackErrors.push(error) }
                }
                // A user callback throwing must not discard later ticks which shared its
                // physical packet, and no sibling error may disappear either.
                rethrowConsumerErrors(callbackErrors, 'Multiple RPC callback consumers failed')
                break
            }
            case Pkt.BATCH: {
                // The Caps.REQ_BATCH envelope. Its own opcode, so today's builds — whose
                // Pkt.CB_BATCH validator accepts only CB/SHAPE/CBV — never see one and never
                // silently drop a frame carrying a response.
                if (!reqBatchOn() || !Array.isArray(msg[1])) break
                const batched = msg[1]
                if (batched.length > MAX_BATCH_ITEMS) break
                const valid = batched.every(function isBatchedPacket(packet: any) {
                    return Array.isArray(packet)
                        && (packet[0] == Pkt.CB || packet[0] == Pkt.SHAPE || packet[0] == Pkt.CBV
                            || packet[0] == Pkt.CB_END || packet[0] == Pkt.RESP
                            || packet[0] == Pkt.CB_FLOW)
                })
                if (!valid) break
                const batchedErrors: any[] = []
                for (const packet of batched) {
                    try { handlePacket(packet, batchedErrors) }
                    catch (error) { batchedErrors.push(error) }
                }
                // Same line as Pkt.CB_BATCH holds for callbacks, now for responses too: a
                // consumer throwing on one item must not discard the items that shared its
                // physical packet, and no sibling error may disappear either.
                rethrowConsumerErrors(batchedErrors, 'Multiple RPC batched packet consumers failed')
                break
            }
            case Pkt.AUTH: {
                // Un-negotiated feature: the packet is not ours to interpret (as CB_BATCH).
                if (!authStateOn()) break
                const notice = msg[1]
                if (!notice || typeof notice != 'object') break
                const state = notice.state
                if (state != 'expiring' && state != 'expired' && state != 'revoked') break
                const event: RpcAuthEvent = {state}
                if (notice.reason !== undefined) event.reason = notice.reason
                if (Number.isFinite(notice.expiresAt)) event.expiresAt = notice.expiresAt
                notifyAuthState(event)
                // Every state is a renewal trigger. 'expired'/'revoked' are already terminal for
                // THIS principal: a renewer yielding nothing new simply stops here.
                if (tokenRenew) renewAuth({reason: 'notice', notice: event}).catch(function ignoreRenewalFailure() {})
                break;
            }
            case Pkt.MAP: {
                schemaKnown = true
                // Clean before merging: on principal change (re-auth) routeMap indices differ —
                // stale entry would take numeric ref to wrong method.
                if (msg[1]) { for (const k of Object.keys(routeCache)) delete routeCache[k]; Object.assign(routeCache, msg[1]); }
                // A fresh declaration replaces the previous principal/connection schema.
                // Only declared Listen nodes are safe to recreate automatically: legacy
                // callback-shaped calls remain deduped, but are terminal on disconnect.
                if (Array.isArray(msg[3])) {
                    declaredListens = new Set(msg[3])
                    for (const sub of wireSubs.values()) {
                        sub.recoverable = declaredListens.has(rpcPathKey(sub.path.slice(0, -1)))
                    }
                }
                if (msg[2]) {
                    for (const k of Object.keys(strictData)) delete strictData[k];
                    Object.assign(strictData, msg[2]);
                }
                const schemaWaiters = strictWaiters
                strictWaiters = []
                for (const resolve of schemaWaiters) resolve(undefined)
                // Response to HELLO is ALWAYS 5-element (authAck or null for server without auth) — only it
                // touches auth. 4-element MAP (STRICT/initial push) is schema-only: does not resolve auth(),
                // so waiting auth() will not catch premature null from STRICT companion.
                // 6th element = id of the HELLO this MAP answers; an unsolicited MAP has none.
                // The one exception is a client with NO token to be acknowledged — see
                // settleAnonymousAuth: it answers locally and never touches a pending HELLO.
                if (msg.length > 4) setAuthStatus(msg[4], msg[5]);
                else settleAnonymousAuth();
                // CAPS once on MAP arrival: connection established, server listening, ticks not yet sent.
                // Here, not in init(): dynamic c.func init() does not call it (server pushes MAP itself).
                // Each optimization is independently advertised and negotiated by its bit.
                advertiseClientCaps()
                finishServerGenerationRecovery()
                break;
            }
        }
    }
    socket.on(key, handlePacket)
    // Direct clients do not have to call ready(); proactively discover a server
    // whose initial MAP/CAPS was emitted before this listener existed.
    advertiseClientCaps()

    // The negotiated request envelope. The session id at index 5 is already attached here, so
    // every item of a batch carries its own and the server unwraps into exactly the packets
    // separate frames would have delivered. A direct packet flushes first: it must not overtake
    // one already queued, which is possible the moment the bit stops being negotiated.
    function emitOrBatch(wire: any[]) {
        if (reqBatchOn()) { requestBatch.enqueue(wire); return }
        requestBatch.flush()
        socket.emit(key, wire)
    }

    function emitApplicationPacket(packet: any[]) {
        if (serverGeneration != undefined) {
            const correlated = [...packet]
            while (correlated.length < 5) correlated.push(undefined)
            correlated[5] = sessionId
            emitOrBatch(correlated)
            return
        }
        emitOrBatch(packet)
    }

    function rollbackCallbacks(callbackIds: number[]) {
        while (callbackIds.length > 0) {
            const id = callbackIds.pop()!
            callbacks.delete(id)
            pool.release(id)
        }
    }

    const sendPipe = (path: string[], steps: any[], wait: boolean): any => {
        if (disposed) return wait ? Promise.reject(new Error('RPC client disposed')) : Promise.resolve()
        if (!transport.api.connected()) return wait ? Promise.reject(new Error('RPC transport disconnected')) : Promise.resolve()
        if (wait && pending.size >= limit) return Promise.reject(new Error('RPC limit'))
        const cbIds: number[] = [];
        // Pack arguments in all call steps
        let cleanSteps: any[]
        try {
            cleanSteps = steps.map(step => {
                if (step.type === 'call') {
                    return {
                        type: 'call',
                        args: pack(step.args, pool, callbacks, cbIds, reservedReport()),
                    };
                }
                return step;
            });
        } catch (error) {
            rollbackCallbacks(cbIds)
            return Promise.reject(error)
        }
        const ref: number | string[] = routeCache[rpcPathKey(path)] ?? path;

        if (!wait) {
            try {
                emitApplicationPacket([Pkt.PIPE, 0, ref, cleanSteps, false])
                return Promise.resolve()
            } catch (error) {
                rollbackCallbacks(cbIds)
                return Promise.reject(error)
            }
        }
        // off() idiom does NOT extend to PIPE — intentional layer boundary:
        //   1) pipe-proxy is LAZY: buildPipeProxy gives proxy chain, sendPipe
        //      is called only from `.then`/`.catch` getter (for await) — any makeOff-handle
        //      here does NOT reach the caller (it is immediately wrapped by `(...a)=>p.then(...a)`).
        //   2) PIPE protocol gives no addressable teardown point for opaque chain:
        //      one RESP, no server stop (contrast with CALL `removeCallback`).
        // Long-lived subscriptions with off() live on CALL/listen surface (subscribeShared
        // + makeOff). PIPE — for transforms; rich types/limits in it already at parity with CALL.
        let reqId: number
        try {
            reqId = pool.next()
        } catch (error) {
            rollbackCallbacks(cbIds)
            return Promise.reject(error)
        }
        let record: tPending | undefined
        function failPipePacket(error: unknown) {
            if (!record || pending.get(reqId) != record) return
            pending.delete(reqId)
            pool.release(reqId)
            rollbackCallbacks(cbIds)
            record.fail(error)
        }
        const promise = new Promise(function trackPipe(resolve, reject) {
            record = {ok: resolve, fail: reject, cbs: cbIds}
            pending.set(reqId, record)
            if (debug) console.log('[RPC PIPE]', path.join('.'), 'steps=', steps.length, 'id=', reqId)
            try {
                emitApplicationPacket([Pkt.PIPE, reqId, ref, cleanSteps])
            } catch (error) {
                failPipePacket(error)
            }
        })
        if (record) record.promise = promise
        return promise
    };

    const buildPipeProxy = (path: string[], steps: any[], wait: boolean): any => {
        const proxy = new Proxy(function () {}, {
            get(_, p: string | symbol) {
                if (p === IS_RPC_PIPE) return true;
                if (p === "then") {
                    if (path.length === 0) return undefined;
                    const promise = sendPipe(path, steps, wait);
                    return (...a: any[]) => promise.then(...a);
                }
                if (p === "catch") {
                    if (path.length === 0) return undefined;
                    const promise = sendPipe(path, steps, wait);
                    return (...a: any[]) => promise.catch(...a);
                }
                if (p === "finally") {
                    if (path.length === 0) return undefined;
                    const promise = sendPipe(path, steps, wait);
                    return (...a: any[]) => (promise as any).finally(...a);
                }
                if (p === "__executeRemainingPipe") {
                    // For server-side transparent relay
                    return (remaining: any[]) => sendPipe(path, [...steps, ...remaining], wait);
                }
                if (p === Symbol.toPrimitive) return undefined;

                if (path.length === 0) {
                    return buildPipeProxy([String(p)], steps, wait);
                }
                return buildPipeProxy(path, [...steps, { type: 'get', prop: String(p) }], wait);
            },
            apply(_, __, args) {
                if (path.length === 0) throw new Error("Cannot call root pipe object");
                return buildPipeProxy(path, [...steps, { type: 'call', args }], wait);
            },
        });
        return proxy;
    };

    type tCallAttempt = {promise: Promise<any>; abandon: (reason: string) => void}

    // The server's gate rejection is machine-readable (MyError code), never a message match.
    const isUnauthorized = (error: any) => error?.code == 'E_UNAUTHORIZED'

    // retryUnauthorized: ONE extra attempt after the renewed principal is presented. The retry
    // itself is issued WITHOUT the flag, so "exactly once" is structural, not a counter.
    function createCallAttempt(path: string[], args: any[], retryUnauthorized = false): tCallAttempt {
        if (disposed) {
            return {promise: Promise.reject(new Error('RPC client disposed')), abandon: function abandonDisposed() {}}
        }
        if (!transport.api.connected()) {
            return {promise: Promise.reject(new Error('RPC transport disconnected')), abandon: function abandonOffline() {}}
        }
        if (pending.size >= limit) {
            return {promise: Promise.reject(new Error('RPC limit')), abandon: function abandonLimited() {}}
        }

        const cbIds: number[] = []
        let clean: any[]
        try {
            clean = pack(args, pool, callbacks, cbIds, reservedReport())
        } catch (error) {
            rollbackCallbacks(cbIds)
            return {
                promise: Promise.reject(error),
                abandon: function abandonInvalidCall() {},
            }
        }
        const ref: number | string[] = routeCache[rpcPathKey(path)] ?? path
        let reqId: number
        try {
            reqId = pool.next()
        } catch (error) {
            rollbackCallbacks(cbIds)
            return {
                promise: Promise.reject(error),
                abandon: function abandonExhaustedCall() {},
            }
        }
        let record!: tPending
        const promise = new Promise(function trackCall(resolve, reject) {
            record = {ok: resolve, fail: reject, cbs: cbIds}
            pending.set(reqId, record)
        })
        record.promise = promise
        // One retry in place of the rejection, so the caller keeps ONE promise: a derived
        // `.catch` promise would be invisible to abandonTransportGeneration, and an
        // intentionally ignored call would crash Node on a transport drop. A call whose args
        // carried callbacks is never replayed — the RESP already released those ids, so a
        // second packet would reference dangling ones (what `zombies` exists to prevent).
        if (retryUnauthorized && tokenRenew && cbIds.length == 0) {
            const settleOk = record.ok, settleFail = record.fail
            record.fail = function failOrRetryCall(error: any) {
                if (!isUnauthorized(error) || !tokenRenew || disposed) return settleFail(error)
                renewAuth({reason: 'unauthorized'}).then(function resendRenewedCall(renewed) {
                    // Nothing renewed, or the transport died meanwhile: the original rejection
                    // is the honest answer, a second packet would only add noise.
                    if (!renewed || disposed || !transport.api.connected()) return settleFail(error)
                    createCallAttempt(path, args).promise.then(
                        function settleRetriedCall(value) { settleOk(value) },
                        function failRetriedCall(retryError) { settleFail(retryError) },
                    )
                }, function renewalCrashed() { settleFail(error) })
            }
        }
        if (debug) console.log('[RPC]', path.join('.'), 'id=', reqId)
        function failCallPacket(error: unknown) {
            if (pending.get(reqId) != record) return
            pending.delete(reqId)
            pool.release(reqId)
            rollbackCallbacks(cbIds)
            record.fail(error)
        }
        try {
            emitApplicationPacket([Pkt.CALL, reqId, ref, clean])
        } catch (error) {
            failCallPacket(error)
        }

        function abandon(reason: string) {
            if (pending.get(reqId) != record) return
            pending.delete(reqId)
            for (const cbId of cbIds) {
                callbacks.delete(cbId)
                compactShapes.delete(cbId)
            }
            // Wire protocol has no generation field: an abandoned id is deliberately
            // never reused, so a late packet cannot settle a new request.
            record.fail(new Error(reason))
        }
        return {promise, abandon}
    }

    function sendCallWire(path: string[], args: any[], wait: boolean): any {
        if (disposed) return wait ? Promise.reject(new Error('RPC client disposed')) : Promise.resolve()
        if (!transport.api.connected()) return wait ? Promise.reject(new Error('RPC transport disconnected')) : Promise.resolve()
        // Only a waiting call can be retried: a fire-and-forget has no reply channel, so an
        // unauthorized rejection for it never even reaches this client.
        if (wait) return createCallAttempt(path, args, true).promise

        const cbIds: number[] = []
        try {
            const clean = pack(args, pool, callbacks, cbIds, reservedReport())
            const ref: number | string[] = routeCache[rpcPathKey(path)] ?? path
            emitApplicationPacket([Pkt.CALL, 0, ref, clean, false])
            return Promise.resolve()
        } catch (error) {
            rollbackCallbacks(cbIds)
            return Promise.reject(error)
        }
    }

    // ===================================================================
    // Logical Listen subscriptions survive a transient transport generation.
    // Only their physical CALL attempt is replaced after reconnect.
    // ===================================================================
    const dedupe = opts?.dedupeListen ?? true
    type tConsumer = {fns: Function[]; resolve: () => void}
    type tWireAttempt = {call: tCallAttempt}
    type tSub = {
        key: string
        path: string[]
        realArgs: any[]
        lastEvents: Map<number, any[]>
        consumers: Set<tConsumer>
        attempt: tWireAttempt | null
        recoverable: boolean
        ended: boolean
        stop: (socketAlive?: boolean) => void
    }
    const wireSubs = new Map<string, tSub>()
    // Listen node addresses declared by server in Pkt.MAP; null = old server (without declaration)
    let declaredListens: Set<string> | null = null

    const OMIT_LISTEN_FUNCTION = Symbol('omit listen function')

    function sanitizeListenWireValue(value: any): any {
        if (typeof value == 'function') return OMIT_LISTEN_FUNCTION
        if (value == null || typeof value != 'object') return value
        if (value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value
        if (value instanceof Map) {
            const clean = new Map<any, any>()
            for (const [key, item] of value) {
                const cleanKey = sanitizeListenWireValue(key)
                const cleanItem = sanitizeListenWireValue(item)
                if (cleanKey != OMIT_LISTEN_FUNCTION && cleanItem != OMIT_LISTEN_FUNCTION) clean.set(cleanKey, cleanItem)
            }
            return clean
        }
        if (value instanceof Set) {
            const clean = new Set<any>()
            for (const item of value) {
                const cleanItem = sanitizeListenWireValue(item)
                if (cleanItem != OMIT_LISTEN_FUNCTION) clean.add(cleanItem)
            }
            return clean
        }
        if (Array.isArray(value)) {
            return value.map(function sanitizeListenArrayItem(item) {
                const clean = sanitizeListenWireValue(item)
                return clean == OMIT_LISTEN_FUNCTION ? undefined : clean
            })
        }
        const clean: Record<string, any> = {}
        for (const key of Object.keys(value)) {
            const item = sanitizeListenWireValue(value[key])
            if (item != OMIT_LISTEN_FUNCTION) clean[key] = item
        }
        return clean
    }

    function normalizeListenWireArgs(path: string[], args: any[]) {
        const method = path[path.length - 1]
        if ((method != 'on' && method != 'callback' && method != 'once') || typeof args[0] != 'function') return args
        const nodeKey = rpcPathKey(path.slice(0, -1))
        if (method == 'once' && declaredListens == null) return args
        if (declaredListens != null && !declaredListens.has(nodeKey)) return args
        const clean = [args[0]]
        for (let i = 1; i < args.length; i++) {
            const value = sanitizeListenWireValue(args[i])
            clean.push(value == OMIT_LISTEN_FUNCTION ? undefined : value)
        }
        return clean
    }

    function clearListenEventCaches() {
        for (const sub of wireSubs.values()) sub.lastEvents.clear()
    }

    function finishLogical(sub: tSub) {
        if (sub.ended) return
        sub.ended = true
        sub.attempt = null
        sub.lastEvents.clear()
        if (wireSubs.get(sub.key) == sub) wireSubs.delete(sub.key)
        for (const consumer of sub.consumers) consumer.resolve()
        sub.consumers.clear()
    }

    function finishAttempt(sub: tSub, attempt: tWireAttempt) {
        if (sub.attempt != attempt) return
        sub.attempt = null
        finishLogical(sub)
    }

    function startAttempt(sub: tSub) {
        if (disposed || sub.ended || sub.attempt || sub.consumers.size == 0 || !transport.api.connected()) return
        const attempt: tWireAttempt = {call: createCallAttempt(sub.path, sub.realArgs)}
        sub.attempt = attempt
        attempt.call.promise.then(
            function physicalListenEnded() { finishAttempt(sub, attempt) },
            function physicalListenFailed() { finishAttempt(sub, attempt) },
        )
    }

    function stopLogical(sub: tSub, socketAlive = transport.api.connected()) {
        if (sub.ended) return
        const attempt = sub.attempt
        sub.attempt = null
        if (wireSubs.get(sub.key) == sub) wireSubs.delete(sub.key)
        sub.ended = true
        sub.lastEvents.clear()
        if (socketAlive && transport.api.connected()) {
            sendCallWire([...sub.path.slice(0, -1), 'removeCallback'], [], false)
        } else {
            attempt?.call.abandon('RPC Listen stopped while transport is disconnected')
        }
        for (const consumer of sub.consumers) consumer.resolve()
        sub.consumers.clear()
    }

    function subscribeShared(path: string[], args: any[]) {
        if (disposed) return Promise.reject(new Error('RPC client disposed'))
        const listenPathKey = rpcPathKey(path.slice(0, -1))
        const skey = listenPathKey + '::' + JSON.stringify(args.map(listenKeyArg))
        let sub = wireSubs.get(skey)
        if (!sub) {
            let fnPos = 0
            const created = {
                key: skey,
                path: [...path],
                realArgs: [] as any[],
                lastEvents: new Map<number, any[]>(),
                consumers: new Set<tConsumer>(),
                attempt: null,
                recoverable: declaredListens?.has(listenPathKey) == true,
                ended: false,
                stop: function stopCreated(socketAlive?: boolean) { stopLogical(created, socketAlive) },
            } satisfies tSub
            created.realArgs = args.map(function buildMultiplexer(arg) {
                if (typeof arg != 'function') return arg
                const index = fnPos++
                return function multicastListenEvent(...event: any[]) {
                    created.lastEvents.set(index, event)
                    const errors: any[] = []
                    for (const consumer of created.consumers) {
                        try { consumer.fns[index]?.(...event) }
                        catch (caught) { errors.push(caught) }
                    }
                    rethrowConsumerErrors(errors, 'Multiple RPC Listen consumers failed')
                }
            })
            wireSubs.set(skey, created)
            sub = created
        }

        const consumer: tConsumer = {
            fns: args.filter(a => typeof a == 'function') as Function[],
            resolve: function resolveLater() {},
        }
        sub.consumers.add(consumer)
        if (args[1]?.current == true) {
            const current = sub.lastEvents.get(0)
            const currentConsumer = consumer.fns[0]
            if (current && currentConsumer) {
                try { currentConsumer(...current) }
                catch (error) { setTimeout(function rethrowCurrentConsumerError() { throw error }, 0) }
            }
        }
        const promise = new Promise<void>(function waitForListenEnd(resolve) { consumer.resolve = resolve })
        startAttempt(sub)

        function unsubscribe() {
            if (!sub!.consumers.delete(consumer)) return
            consumer.resolve()
            if (sub!.consumers.size == 0) sub!.stop()
        }
        return makeOff(promise, unsubscribe, {off: unsubscribe, unsubscribe, removeCallback: unsubscribe})
    }

    // Arbitrary calls are never retried. Only logical Listen entries remain and
    // receive one fresh physical attempt after the next completed handshake.
    function abandonTransportGeneration(reason: string) {
        for (const sub of [...wireSubs.values()]) {
            sub.lastEvents.clear()
            const attempt = sub.attempt
            sub.attempt = null
            attempt?.call.abandon(reason)
            // An old server gives only a callback-shaped heuristic. Reissuing such
            // a call could repeat a side effect, so only a declared Listen survives.
            if (!sub.recoverable) finishLogical(sub)
        }

        const error = new Error(reason)
        for (const [id, request] of [...pending]) {
            pending.delete(id)
            for (const cbId of request.cbs) {
                callbacks.delete(cbId)
                compactShapes.delete(cbId)
            }
            // A transport teardown creates this rejection inside the library. Mark
            // the original Promise handled so an intentionally ignored call cannot
            // crash Node; await/catch on that same Promise still observes the reject.
            request.promise?.catch(function consumeAbandonedTransportReject() {})
            // No pool.release(): late wire packets carry no generation and must
            // never be able to target a newer call which reused this id.
            request.fail(error)
        }
        callbacks.clear()
        compactShapes.clear()
        shapeDecoder.clear()
    }

    function transportDisconnected(reason: string) {
        abandonTransportGeneration('RPC transport disconnected: ' + reason)
        schemaKnown = false
        peerServerCaps = 0
        beginTransportGeneration()
        serverGenerationRecoveryPending = false
        _ready = null
        declaredListens = declaredListens ? new Set() : null
        for (const route of Object.keys(routeCache)) delete routeCache[route]
        authStatus = undefined
        abandonHellos({ok: false, reason})
        const strict = strictWaiters
        strictWaiters = []
        for (const resolve of strict) resolve(undefined)
        const auths = authWaiters
        authWaiters = []
        for (const resolve of auths) resolve({ok: false, reason})
    }

    function prepareServerGenerationReplacement() {
        const reason = 'RPC server generation changed'
        abandonTransportGeneration(reason)
        schemaKnown = false
        peerServerCaps = 0
        serverGenerationRecoveryPending = true
        _ready = null
        declaredListens = declaredListens ? new Set() : null
        for (const route of Object.keys(routeCache)) delete routeCache[route]
        authStatus = undefined
        abandonHellos({ok: false, reason})
        const auths = authWaiters
        authWaiters = []
        for (const resolve of auths) resolve({ok: false, reason})
    }

    function restartRecoveredListens() {
        serverGenerationRecoveryPending = false
        for (const sub of [...wireSubs.values()]) {
            if (!sub.recoverable) {
                finishLogical(sub)
                continue
            }
            startAttempt(sub)
        }
    }

    function finishServerGenerationRecovery() {
        if (!serverGenerationRecoveryPending || !schemaKnown) return
        restartRecoveredListens()
    }

    function transportConnected() {
        // Reissue a schema request which a non-buffering offline transport dropped.
        if (!schemaKnown && strictWaiters.length > 0) requestSchema()
        for (const sub of [...wireSubs.values()]) {
            if (sub.recoverable) startAttempt(sub)
            else finishLogical(sub)
        }
    }

    transport.api.onDisconnect(transportDisconnected)
    transport.api.onConnect(transportConnected)

    const sendCall = (path: string[], args: any[], wait: boolean): any => {
        const last = path[path.length - 1];
        const wireArgs = normalizeListenWireArgs(path, args)
        // `.on(fn)` and `.callback(fn)` — both "subscription on callback setup fact". Name NOT rewritten:
        // `.on` goes on the wire AS `.on` (server has both methods). Dedup — by NODE ADDRESS
        // (see subscribeShared), so on/callback on one Listen node share one network subscription.
        if (dedupe && wait && path.length > 1 && (last == "callback" || last == "on") && wireArgs.some(a => typeof a == "function")) {
            // New calls made offline are never deferred into the next connection.
            if (!transport.api.connected()) return sendCallWire(path, wireArgs, wait)
            // exactly: server declared address as Listen (Pkt.MAP[3]);
            // fallback for old server — heuristic by route shape `*.callback(fn)`/`*.on(fn)`
            const isListen = declaredListens ? declaredListens.has(rpcPathKey(path.slice(0, -1))) : true;
            if (isListen) return subscribeShared(path, wireArgs);
        }
        return sendCallWire(path, wireArgs, wait);
    };

    function lookupRpcMemberState(path: string[], member: string) {
        if (!schemaKnown) return undefined
        const memberPath = [...path, member]
        const memberKey = rpcPathKey(memberPath)
        if (Object.prototype.hasOwnProperty.call(routeCache, memberKey)) return true
        if (declaredListens?.has(memberKey)) return true
        const target = resolveStrictTarget(memberPath)
        if (target == 'dynamic') return undefined
        return target != undefined && target != null && target != 'null'
    }

    function createRpcMemberLookup(path: string[]) {
        const lookup = function lookupRpcMember(member: string) { return lookupRpcMemberState(path, member) }
        Object.defineProperty(lookup, RPC_MEMBER_LOOKUP, {value: true})
        return lookup
    }

    const proxyCaches = {
        func: createPathProxyCache(),
        space: createPathProxyCache(),
        strict: createPathProxyCache(),
    } as const

    function buildProxy(path: string[], wait: boolean, cache: ReturnType<typeof createPathProxyCache>): any {
        const cached = cache.get(path)
        if (cached) return cached
        const proxy = new Proxy(function () {}, {
            get(_, p: string | symbol) {
                if (p == RPC_MEMBER_LOOKUP) return createRpcMemberLookup(path)
                if (p == RPC_SCHEMA_READY) return waitForRpcSchema
                if (p == RPC_TRANSPORT_LIFECYCLE) return transport.api
                if (rpcResultLimitsProperty(p)) return lim
                if (p == 'then' || p == 'catch' || p == Symbol.toPrimitive) return undefined
                return buildProxy([...path, String(p)], wait, cache)
            },
            apply(_, __, args) {
                const [fp, fa] = resolveCA(path, args)
                return sendCall(fp, fa, wait)
            },
        })
        return cache.set(path, proxy)
    }

    function resolveStrictTarget(path: string[]) {
        let target: any = strictData
        for (const segment of path) {
            if (target == 'dynamic') return target
            target = target?.[segment]
            if (target == null || target == 'null') return undefined
        }
        return target
    }

    function buildStrict(path: string[], wait: boolean): any {
        const initialTarget = resolveStrictTarget(path)
        if (initialTarget == null || initialTarget == 'null') return undefined
        const cached = proxyCaches.strict.get(path)
        if (cached) return cached
        // A Proxy target cannot change callability after creation. Keep every cached strict
        // path callable internally, while apply validates the current schema dynamically.
        const target = () => {}
        const proxy = new Proxy(target, {
            has: (_, p) => {
                const target = resolveStrictTarget(path)
                return target == 'dynamic' || (target?.[String(p)] != 'null' && target?.[String(p)] != undefined)
            },
            ownKeys: () => {
                const target = resolveStrictTarget(path)
                return target && typeof target == 'object' ? Object.keys(target) : []
            },
            getOwnPropertyDescriptor: () => ({enumerable: true, configurable: true}),
            getPrototypeOf: () => {
                const target = resolveStrictTarget(path)
                return target == 'func' || target == 'dynamic' ? Function.prototype : target ? null : Object.prototype
            },
            get(_, p: string | symbol) {
                if (p == RPC_MEMBER_LOOKUP) return createRpcMemberLookup(path)
                if (p == RPC_SCHEMA_READY) return waitForRpcSchema
                if (p == RPC_TRANSPORT_LIFECYCLE) return transport.api
                if (rpcResultLimitsProperty(p)) return lim
                if (p == 'then' || p == 'catch' || p == Symbol.toPrimitive) return undefined
                const target = resolveStrictTarget(path)
                if (p == 'call' && target == 'func') {
                    return function strictCall(_: any, ...args: any[]) { return sendCall(path, args, wait) }
                }
                if (target == 'func') return undefined
                if (target != 'dynamic') {
                    const child = target?.[String(p)]
                    if (child == 'null' || child == undefined) return undefined
                }
                return buildStrict([...path, String(p)], wait)
            },
            apply(_, __, args) {
                const target = resolveStrictTarget(path)
                if (target != 'func' && target != 'dynamic') {
                    throw new TypeError('RPC strict path is not callable')
                }
                const [fp, fa] = resolveCA(path, args)
                return sendCall(fp, fa, wait)
            },
        })
        return proxyCaches.strict.set(path, proxy)
    }

    const releaseCbs = (fn: Function) => {
        callbacks.forEach((cb, id) => { if (cb == fn) { callbacks.delete(id); retire(id); } });
    };

    function abortAll(reason: string) {
        const err = {error: {name: 'RPC_ABORT', message: reason}}
        pending.forEach(function abortPending(p, id) {
            retire(id)
            for (const cbId of p.cbs) compactShapes.delete(cbId)
            p.fail(err)
        })
        pending.clear()
        callbacks.forEach(function abortCallback(_, id) { retire(id) })
        callbacks.clear()
        compactShapes.clear()
        shapeDecoder.clear()
    }

    // Hard teardown finishes logical consumers; transient disconnect never calls this.
    function drainWireSubs(socketAlive: boolean) {
        const subs = [...wireSubs.values()]
        wireSubs.clear()
        for (const sub of subs) sub.stop(socketAlive)
    }

    // Detach client: reject pending, ignore subsequent packets, reject new calls.
    // socketAlive (default true) — whether to send wire removeCallback; on a dead socket
    // pass { socketAlive: false } (consumers will resolve anyway).
    function dispose(reason = 'RPC client disposed', opts?: {socketAlive?: boolean}) {
        if (disposed) return
        const socketAlive = opts?.socketAlive ?? true
        // Wire removeCallback must be emitted before disposed blocks outgoing calls.
        drainWireSubs(socketAlive)
        abortAll(reason)
        disposed = true
        // Flow drain waiters (deferred responses) resume into the disposed early-return.
        for (const cbId of [...flowStreams.keys()]) dropFlowStream(cbId)
        transport.control.close(reason)
        abandonHellos({ok: false, reason})
        const sw = strictWaiters
        strictWaiters = []
        for (const resolve of sw) resolve(undefined)
        const aw = authWaiters
        authWaiters = []
        for (const resolve of aw) resolve({ok: false, reason})
        const dc = disconnectCbs
        disconnectCbs = []
        for (const cb of dc) try { cb(reason) } catch {}
        disconnectResolve(reason)
    }

    const api: ClientApiHandle = {
        log: s => { debug = s; },
        pending: () => pending.size,
        callbacks: () => callbacks.size,
        clearPromises: (rej = true) => {
            pending.forEach((p, id) => { retire(id); rej ? p.fail("promiseDeleteAll") : p.ok(undefined); });
            pending.clear();
        },
        clearCallbacks: () => { callbacks.forEach((_, id) => retire(id)); callbacks.clear(); },
        remove: releaseCbs,
        end: releaseCbs,
        subscriptions: () => Array.from(wireSubs, ([k, s]) => ({ key: k, consumers: s.consumers.size })),
    };

    const func = buildProxy([], true, proxyCaches.func) as ClientAPIAll<T>;
    const space = buildProxy([], false, proxyCaches.space) as ClientAPIAll<T>
    const strict = buildStrict([], true) as ClientAPIStrict<T>
    const pipe = buildPipeProxy([], [], true) as PipeAPI<T>;
    const pipeStrict = buildPipeProxy([], [], true) as PipeAPI<T>; // currently ≡ pipe — strict validation not yet implemented (PLAN: API honesty)

    function ready() {
        return _ready ? _ready : _ready = init()
    }


    function requestSchema() {
        if (authToken != null) sendHello(authToken)
        requestBatch.flush()
        socket.emit(key, Pkt.STRICT)
    }

    // What THIS transport generation still owes: a schema, or an ack for a token already held.
    // Every teardown path (transport disconnect, server generation change) clears both, so a new
    // generation genuinely re-inits while a completed handshake stays idempotent.
    function handshakeNeeded() {
        return !schemaKnown || (authToken != null && authStatus === undefined)
    }

    async function init(obj?: object) {
        if (obj) { strictData = obj; schemaKnown = true; return; }
        // A fresh connection is the first renewal trigger: the HELLO below must carry the token
        // the application considers current. Without a renewer there is not even an await here.
        // Nothing is owed once the handshake completed, and the check comes BEFORE the renewal:
        // initStrict is the RAW init while ready() memoizes, and the documented consumer pattern
        // runs BOTH (the hub's handshake, then the application's readyStrict). A second pass
        // would otherwise mint and discard a provider token — real for a one-time or
        // rate-limited issuer — and re-HELLO a live socket for nothing.
        if (!handshakeNeeded()) return
        if (tokenRenew) await renewAuth({reason: 'connect'})
        // On a live socket the renewal presents the token itself, so the handshake this call
        // owed may already be complete by now.
        if (handshakeNeeded()) {
            // Register first: a synchronous adapter may deliver MAP inside emit().
            const waitForMap = new Promise<void>(function registerSchemaWaiter(resolve) {
                strictWaiters.push(function resolveSchemaWaiter() { resolve() })
            })
            requestSchema()
            await waitForMap
        }
    }

    async function waitForRpcSchema() {
        while (!schemaKnown) {
            if (disposed) throw new Error('RPC client disposed')
            await ready()
            // A disconnect intentionally releases STRICT waiters. In that case
            // transportDisconnected cleared _ready and the next generation must
            // produce its own MAP before this branded readiness hook resolves.
        }
    }
    Object.defineProperty(waitForRpcSchema, RPC_SCHEMA_READY, {value: true})

    // Soft re-auth on LIVE socket: subscriptions are not broken (same socket, same cb-id);
    // server re-verifies and sends new MAP (routeMap of new principal) + authAck.
    // WARNING: still do not run concurrent reauths. Correlation guarantees each reauth() sees ITS
    // OWN answer, but the server keeps ONE principal per socket+key, so racing tokens still end in
    // whichever HELLO the server resolved last; wait for each.
    function reauth(token: any) {
        if (disposed) return Promise.resolve({ok: false, reason: 'RPC client disposed'})
        if (!transport.api.connected()) return Promise.resolve({ok: false, reason: 'RPC transport disconnected'})
        authToken = token;
        clearListenEventCaches()
        // The waiter is registered by sendHello INSIDE the executor: a synchronous adapter can
        // deliver the answering MAP before this Promise is even returned.
        return new Promise<any>(function waitForAuthAck(resolve) { sendHello(token, resolve) });
    }
    // Current authAck (null = server without auth); during ongoing reauth waits for fresh one, not old.
    // After dispose resolve immediately (otherwise waiter never drains — MAP already ignored).
    const auth = () => disposed
        ? Promise.resolve(authStatus !== undefined ? authStatus : { ok: false, reason: "RPC client disposed" })
        : (authStatus !== undefined && !authPending) ? Promise.resolve(authStatus) : new Promise<any>(res => authWaiters.push(res));

    return {
        func,           // <- ClientAPI type (no chains)
        pipe,           // <- PipeAPI type (has chains)
        pipeStrict,     // <- PipeAPI type (has chains)
        space,
        all: func as ClientAPIAll<T>,
        strict, // <- ClientAPI type (no chains)
        api,
        [RPC_TRANSPORT_CONTROL]: transport.control,
        abortAll,
        dispose,
        /** Close the client (universal teardown, paired with onDisconnect): drains subscriptions,
         *  rejects pending, removes waiters. Delegates to {@link dispose}; advanced
         *  `{ socketAlive:false }` — there. */
        close: dispose,
        schema: () => strictData,
        readyStrict: ready,
        /** Wait for handshake/schema (STRICT). Delegates to {@link readyStrict}. */
        ready,
        initStrict: init,
        /** Initialize client (HELLO+STRICT) or seed schema with object. Delegates to {@link initStrict}. */
        init,
        /** Soft re-auth on live socket (subscriptions preserved). Resolves with new authAck. */
        reauth,
        /** Current server authAck; waits for first/fresh. Resolves null for a server without
         *  auth, and a local {ok:false} for a client that presented no token — nothing
         *  acknowledges such a client, so there is no ack to wait for. */
        auth,
        /** Watch the server's authorization state (Pkt.AUTH: expiring/expired/revoked) and the
         *  local outcome of an automatic renewal ('renewed', carrying the new deadline when the
         *  server sent one, or 'renewFailed'). Additive registrar; the off-handle removes only this
         *  consumer, await — client teardown. Silent unless Caps.AUTH_STATE is negotiated. */
        onAuthState,
        /** Install the token renewal seam (the hub installs its token provider here): consulted
         *  before the HELLO of a fresh connection, on an auth notice, and once per unauthorized
         *  call. Without it the client never renews and never retries — behavior as before. */
        setTokenRenew,
        /** Watch client teardown (dispose/break/rotation). Callable off-handle; await — on
         *  disconnect. Subscriptions already unsubscribed by then (honest teardown, no auto-resubscribe). */
        onDisconnect,
    };
}

export type RpcClientReturn<T extends object> = {
    func: ClientAPIAll<T>;
    pipe: PipeAPI<T>;
    /** Currently identical to {@link pipe}: strict schema validation not yet implemented. */
    pipeStrict: PipeAPI<T>;
    space: ClientAPIAll<T>;
    all: ClientAPIAll<T>;
    strict: ClientAPIStrict<T>;
    api: ClientApiHandle;
    abortAll: (reason: string) => void;
    /** Detach client: pending are rejected, subsequent packets ignored, new calls rejected.
     *  Subscriptions drained (honest teardown). On dead socket — `{ socketAlive: false }`.
     *  @deprecated use {@link close} — same teardown with same signature. */
    dispose: (reason?: string, opts?: { socketAlive?: boolean }) => void;
    /** Close the client (universal teardown, paired with onDisconnect). Delegates to {@link dispose}. */
    close: (reason?: string, opts?: { socketAlive?: boolean }) => void;
    schema: () => any;
    /** @deprecated use {@link ready} — Strict suffix has no meaning (no non-strict variant). */
    readyStrict: () => Promise<void>;
    /** Wait for handshake/schema. Delegates to {@link readyStrict}. */
    ready: () => Promise<void>;
    /** @deprecated use {@link init} — Strict suffix has no meaning (no non-strict variant). */
    initStrict: (obj?: object) => Promise<void>;
    /** Initialize client or seed schema with object. Delegates to {@link initStrict}. */
    init: (obj?: object) => Promise<void>;
    /** Soft re-auth on live socket: presents new token, subscriptions preserved. */
    reauth: (token: any) => Promise<any>;
    /** Current server authAck (5th element of Pkt.MAP); resolves null for a server without auth,
     *  and a local {ok:false} for a client that presented no token. */
    auth: () => Promise<any>;
    /** Watch server authorization state (Pkt.AUTH) and the local outcome of an automatic
     *  renewal ('renewed' with the new deadline when known, 'renewFailed'). */
    onAuthState: (cb: (event: RpcAuthEvent) => void) => ReturnType<typeof makeOff>;
    /** Install/remove the token renewal seam: consulted before a fresh HELLO, on an auth
     *  notice, and once per unauthorized call. */
    setTokenRenew: (renew: RpcTokenRenew | null) => void;
    /** Watch client teardown (dispose/break/rotation). Callable off-handle; await — on disconnect. */
    onDisconnect: (cb: (reason: string) => void) => ReturnType<typeof makeOff>;
};

export function createRpcClient<T extends object>({ socket, socketKey: key, limit, limits, dedupeListen, token, opt }: {
    socket: SocketTmpl; socketKey: string; limit?: number;
    /** Optional lower limits on incoming responses/callbacks. */
    limits?: RpcLimits;
    /** Dedup subscriptions (enabled by default): one network connection per Listen address,
     *  new consumers relayed locally, network stop — after last one leaves.
     *  Subscription (`*.on(cb)`, legacy `*.callback(cb)`) returns callable off-handle with `.off()/.unsubscribe()`. */
    dedupeListen?: boolean;
    /** Authorization token: on initStrict() client presents it via Pkt.HELLO (in-band auth).
     *  In-band auth assumes ONE logical client per socket+key (hub model): two
     *  token clients on one socket would wipe routeCache/authAck of each other on principal change. */
    token?: any;
    /** Negotiated JSON-wire optimizations. Compact shapes and callback batching default on. */
    opt?: RpcOpt;
}): RpcClientReturn<T> {
    return createClient<T>(socket, key, { limit, limits, dedupeListen, token, opt });
}

export type { ClientApiHandle };
