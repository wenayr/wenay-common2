import { Pkt, type SocketTmpl } from "./rpc-protocol";
import { rpcPathKey } from "./rpc-path";
import {createIdPool, type idPool} from "../id-pool";
import {pack, resolveCA, unpackResult} from "./rpc-walk";
import {resolveLimits, type RpcLimits} from "./rpc-limits";
import {MyError} from "../../toError/myThrow";
import {makeOff} from "./rpc-off";
import { optToCaps, type tCaps, type RpcOpt } from "./rpc-caps";
import {
    createTransportLifecycle,
    RPC_MEMBER_LOOKUP,
    RPC_TRANSPORT_CONTROL,
    RPC_TRANSPORT_LIFECYCLE,
} from '../events/transport-lifecycle'
// Types only (no runtime cycle): replay members of the API are projected into the client
// replay surface (line/since/keyframe/frame) — replaySubscribe(client.func.key) without casts
import type { IsReplayMember, InferArgs, ReplaySocketListen } from "./listen-deep";

// Shared id pool per (socket × key): two clients on the same socket+key share the id space,
// otherwise their reqId collide and a foreign RESP resolves both waits.
const SHARED_POOLS = new WeakMap<object, Map<string, idPool>>();
function sharedPool(socket: object, key: string) {
    let byKey = SHARED_POOLS.get(socket);
    if (!byKey) { byKey = new Map(); SHARED_POOLS.set(socket, byKey); }
    let pool = byKey.get(key);
    if (!pool) { pool = createIdPool(); byKey.set(key, pool); }
    return pool;
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
    const values = new Map<string, tProxyEntry>()
    const registry = new FinalizationRegistry<{key: string; token: object}>(function releaseProxy(entry) {
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
        values.set(key, {ref: new WeakRef(proxy), token})
        registry.register(proxy, {key, token})
        return proxy
    }

    return {get, set}
}
// Helper types
type UnwrapPromise<T> = T extends Promise<infer R> ? R : T;

export type DeepDataOnly<T> = T extends Function
    ? never
    : T extends readonly any[]
        // mapped tuple: tuples are preserved ([string, number] does not degrade to (string|number)[] —
        // important for replay converts {seq, ts, event: Z}); regular arrays are mapped as before
        ? { [I in keyof T]: DeepDataOnly<T[I]> }
        : T extends object
            ? { [K in keyof T as T[K] extends Function ? never : K]: DeepDataOnly<T[K]> }
            : T;

// --- 1. TYPING FOR REGULAR CALLS (WITHOUT PIPE) ---
export type ClientAPIAll<T> = {
    [K in keyof T as T[K] extends Function ? K : T[K] extends object ? K : never]:
        // replay member (detection as in listen-deep) → client replay surface,
        // structurally compatible with ReplayRemote: replaySubscribe(client.func.key) without casts
        IsReplayMember<T[K]> extends true
            ? ReplaySocketListen<InferArgs<T[K]>>
            : T[K] extends (...args: infer A) => infer R
                // Regular call returns ONLY Promise with clean data. No chain continuation.
                ? (...args: A) => Promise<DeepDataOnly<UnwrapPromise<R>>>
                : T[K] extends object
                    ? ClientAPIAll<T[K]>
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

const IS_RPC_PIPE = Symbol.for("isRpcPipe");

function createClient<T extends object>(socket: SocketTmpl, key: string, opts?: { limit?: number; limits?: RpcLimits; dedupeListen?: boolean; token?: any; opt?: RpcOpt }) {
    const limit = opts?.limit ?? 10000;
    // opt-in: without the limits option, behavior is as before (server responses are unlimited)
    const lim = opts?.limits ? resolveLimits(opts.limits) : undefined;
    const pool = sharedPool(socket, key);
    type tPending = {ok: Function; fail: Function; cbs: number[]; promise?: Promise<any>}
    const pending = new Map<number, tPending>();
    const callbacks = new Map<number, Function>();
    // compact subscription ticks: cbId → (shapeId → key order), declared by server in Pkt.SHAPE
    const compactShapes = new Map<number, string[][]>();
    let capsSent = false; // CAPS (own feature bitset) sent once on first MAP arrival
    const clientCaps = optToCaps(opts?.opt); // what we declare to server (0 = nothing → server does not compact)
    let peerServerCaps: tCaps = 0; // what the server declared (for future bidirectional features)
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
    let debug = false;

    // --- in-band auth (Pkt.HELLO/authAck) ---
    let authToken: any = opts?.token ?? null;
    let authStatus: any = undefined; // server's last authAck; null = server without auth (4-element MAP)
    let authWaiters: ((s: any) => void)[] = [];
    let authPending = false; // HELLO/reauth in progress → auth() waits for fresh ack, not the old one
    const drainAuth = (s: any) => { authPending = false; const w = authWaiters; authWaiters = []; for (const r of w) r(s); };
    const setAuthStatus = (s: any) => { authStatus = s; drainAuth(s); };

    socket.on(key, (msg: any) => {
        if (!Array.isArray(msg)) return;
        if (disposed) {
            // after dispose, only return zombie-ids to the shared pool, ignore everything else
            if ((msg[0] == Pkt.RESP || msg[0] == Pkt.CB_END) && zombies.delete(msg[1])) pool.release(msg[1]);
            return;
        }
        switch (msg[0]) {
            case Pkt.RESP: {
                const req = pending.get(msg[1]);
                if (!req) { if (zombies.delete(msg[1])) pool.release(msg[1]); break; }
                pending.delete(msg[1]);
                pool.release(msg[1]);
                for (const cbId of req.cbs) { if (callbacks.delete(cbId)) pool.release(cbId); }
                if (msg[3]) req.fail(reviveErr(msg[3]));
                else {
                    // limit violation/corrupt payload in response — reject this request only
                    try { req.ok(unpackResult(msg[2], lim)); }
                    catch (e) { req.fail(e); }
                }
                break;
            }
            case Pkt.CB: {
                const cb = callbacks.get(msg[1]);
                if (!cb) break;
                let cbArgs: any[];
                // stream has no error channel — drop corrupt/limit-exceeding packet
                // (previously .map(unpackResult) also passed index as a second argument like lim)
                try { cbArgs = (msg[2] || []).map((a: any) => unpackResult(a, lim)); }
                catch (e) { if (debug) console.log("[RPC CB] dropped:", e); break; }
                cb(...cbArgs);
                break;
            }
            case Pkt.SHAPE: {
                // Late shape from dead transport-generation should not create state tail.
                if (!callbacks.has(msg[1])) break
                // server declared shape of compact ticks for cbId: shapeId → key order
                let m = compactShapes.get(msg[1]);
                if (!m) { m = []; compactShapes.set(msg[1], m); }
                m[msg[2]] = msg[3];
                break;
            }
            case Pkt.CBV: {
                // compact tick: reconstruct object from shape + values and call callback as regular CB
                const cb = callbacks.get(msg[1]);
                if (!cb) break;
                const keys = compactShapes.get(msg[1])?.[msg[2]];
                if (!keys) break;
                const vals = msg[3] || [];
                let obj: any;
                try { obj = {}; keys.forEach((k: string, i: number) => { obj[k] = unpackResult(vals[i], lim); }); }
                catch (e) { if (debug) console.log("[RPC CBV] dropped:", e); break; }
                cb(obj);
                break;
            }
            case Pkt.CB_END: {
                const cbId = msg[1] as number;
                compactShapes.delete(cbId);
                // release only if id is ours (tracked) — foreign/late CB_END must not
                // release id occupied by another request
                if (callbacks.delete(cbId)) pool.release(cbId);
                else if (zombies.delete(cbId)) pool.release(cbId);
                break;
            }
            case Pkt.CAPS: {
                // server declared its bitset of contract features — remember (bidirectional half
                // of handshake). For COMPACT client does not gate: CBV arrives only if WE declared COMPACT.
                peerServerCaps = typeof msg[1] === "number" ? msg[1] : 0;
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
                    for (const r of strictWaiters) r(undefined);
                    strictWaiters = [];
                }
                // Response to HELLO is ALWAYS 5-element (authAck or null for server without auth) — only it
                // touches auth. 4-element MAP (STRICT/initial push) is schema-only: does not resolve auth(),
                // so waiting auth() will not catch premature null from STRICT companion.
                if (msg.length > 4) setAuthStatus(msg[4]);
                // CAPS once on MAP arrival: connection established, server listening, ticks not yet sent.
                // Here, not in init(): dynamic c.func init() does not call it (server pushes MAP itself).
                // Send CAPS only if we have something to declare: clientCaps==0 (opt.compact:false) → silence,
                // so even OLD server (interprets CAPS fact itself as "I can compact") stays on regular CB.
                if (!capsSent) { capsSent = true; if (clientCaps) socket.emit(key, [Pkt.CAPS, clientCaps]); }
                break;
            }
        }
    });

    const sendPipe = (path: string[], steps: any[], wait: boolean): any => {
        if (disposed) return wait ? Promise.reject(new Error('RPC client disposed')) : Promise.resolve()
        if (!transport.api.connected()) return wait ? Promise.reject(new Error('RPC transport disconnected')) : Promise.resolve()
        const cbIds: number[] = [];
        // Pack arguments in all call steps
        const cleanSteps = steps.map(step => {
            if (step.type === 'call') {
                return { type: 'call', args: pack(step.args, pool, callbacks, cbIds) };
            }
            return step;
        });
        const ref: number | string[] = routeCache[rpcPathKey(path)] ?? path;

        if (!wait) {
            socket.emit(key, [Pkt.PIPE, 0, ref, cleanSteps, false]);
            return Promise.resolve();
        }
        // off() idiom does NOT extend to PIPE — intentional layer boundary:
        //   1) pipe-proxy is LAZY: buildPipeProxy gives proxy chain, sendPipe
        //      is called only from `.then`/`.catch` getter (for await) — any makeOff-handle
        //      here does NOT reach the caller (it is immediately wrapped by `(...a)=>p.then(...a)`).
        //   2) PIPE protocol gives no addressable teardown point for opaque chain:
        //      one RESP, no server stop (contrast with CALL `removeCallback`).
        // Long-lived subscriptions with off() live on CALL/listen surface (subscribeShared
        // + makeOff). PIPE — for transforms; rich types/limits in it already at parity with CALL.
        let record: tPending | undefined
        const promise = new Promise(function trackPipe(resolve, reject) {
            if (pending.size >= limit) { reject(new Error('RPC limit')); return }
            const reqId = pool.next()
            record = {ok: resolve, fail: reject, cbs: cbIds}
            pending.set(reqId, record)
            if (debug) console.log('[RPC PIPE]', path.join('.'), 'steps=', steps.length, 'id=', reqId)
            socket.emit(key, [Pkt.PIPE, reqId, ref, cleanSteps])
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

    function createCallAttempt(path: string[], args: any[]): tCallAttempt {
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
        const clean = pack(args, pool, callbacks, cbIds)
        const ref: number | string[] = routeCache[rpcPathKey(path)] ?? path
        const reqId = pool.next()
        let record!: tPending
        const promise = new Promise(function trackCall(resolve, reject) {
            record = {ok: resolve, fail: reject, cbs: cbIds}
            pending.set(reqId, record)
        })
        record.promise = promise
        if (debug) console.log('[RPC]', path.join('.'), 'id=', reqId)
        socket.emit(key, [Pkt.CALL, reqId, ref, clean])

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
        if (wait) return createCallAttempt(path, args).promise

        const cbIds: number[] = []
        const clean = pack(args, pool, callbacks, cbIds)
        const ref: number | string[] = routeCache[rpcPathKey(path)] ?? path
        socket.emit(key, [Pkt.CALL, 0, ref, clean, false])
        return Promise.resolve()
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
                    let error: any
                    for (const consumer of created.consumers) {
                        try { consumer.fns[index]?.(...event) }
                        catch (caught) { error ??= caught }
                    }
                    if (error != undefined) setTimeout(function rethrowConsumerError() { throw error }, 0)
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
    }

    function transportDisconnected(reason: string) {
        abandonTransportGeneration('RPC transport disconnected: ' + reason)
        schemaKnown = false
        capsSent = false
        peerServerCaps = 0
        declaredListens = declaredListens ? new Set() : null
        for (const route of Object.keys(routeCache)) delete routeCache[route]
        authStatus = undefined
        authPending = false
        const strict = strictWaiters
        strictWaiters = []
        for (const resolve of strict) resolve(undefined)
        const auths = authWaiters
        authWaiters = []
        for (const resolve of auths) resolve({ok: false, reason})
    }

    function transportConnected() {
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
                if (p == RPC_TRANSPORT_LIFECYCLE) return transport.api
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
                if (p == RPC_TRANSPORT_LIFECYCLE) return transport.api
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
        transport.control.close(reason)
        authPending = false
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

    let _ready: null | Promise<void> = null;
    let ready = () => _ready ? _ready : _ready = init()
    const init = async (obj?: object) => {
        if (obj) { strictData = obj; schemaKnown = true; return; }
        // with token — present it (HELLO); response to HELLO always arrives as 5-element (ack/null).
        if (authToken != null) { authPending = true; socket.emit(key, [Pkt.HELLO, authToken]); }
        // STRICT always: schema request and fallback for OLD server that doesn't know HELLO (no hang).
        socket.emit(key, Pkt.STRICT);
        await new Promise(r => { strictWaiters.push(r); });
    }

    // Soft re-auth on LIVE socket: subscriptions are not broken (same socket, same cb-id);
    // server re-verifies and sends new MAP (routeMap of new principal) + authAck.
    // WARNING: do not run concurrent reauths — waiters are shared, without correlation; wait for each.
    function reauth(token: any) {
        if (disposed) return Promise.resolve({ok: false, reason: 'RPC client disposed'})
        if (!transport.api.connected()) return Promise.resolve({ok: false, reason: 'RPC transport disconnected'})
        authToken = token;
        authPending = true;
        clearListenEventCaches()
        socket.emit(key, [Pkt.HELLO, token]);
        return new Promise<any>(res => authWaiters.push(res));
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
        /** Current server authAck; waits for first/fresh. Resolves null for server without auth. */
        auth,
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
    /** Current server authAck (5th element of Pkt.MAP); resolves null for server without auth. */
    auth: () => Promise<any>;
    /** Watch client teardown (dispose/break/rotation). Callable off-handle; await — on disconnect. */
    onDisconnect: (cb: (reason: string) => void) => ReturnType<typeof makeOff>;
};

export function createRpcClient<T extends object>({ socket, socketKey: key, limit, limits, dedupeListen, token, opt }: {
    socket: SocketTmpl; socketKey: string; limit?: number;
    /** Opt-in limits on INCOMING data (server responses/callbacks); without option — as before, unlimited. */
    limits?: RpcLimits;
    /** Dedup subscriptions (enabled by default): one network connection per Listen address,
     *  new consumers relayed locally, network stop — after last one leaves.
     *  Subscription (`*.on(cb)`, legacy `*.callback(cb)`) returns callable off-handle with `.off()/.unsubscribe()`. */
    dedupeListen?: boolean;
    /** Authorization token: on initStrict() client presents it via Pkt.HELLO (in-band auth).
     *  In-band auth assumes ONE logical client per socket+key (hub model): two
     *  token clients on one socket would wipe routeCache/authAck of each other on principal change. */
    token?: any;
    /** Wire optimizations (negotiated by handshake): { compact?: false } disables
     *  adaptive tick compression (Pkt.SHAPE/CBV) for this connection. Default — enabled. */
    opt?: RpcOpt;
}): RpcClientReturn<T> {
    return createClient<T>(socket, key, { limit, limits, dedupeListen, token, opt });
}

export type { ClientApiHandle };
