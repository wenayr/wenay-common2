import { isListenCallback, createListen, isListenOn, getListenByOn } from "../events/Listen";
import { IS_REPLAY_LISTEN } from "../events/replay-listen";
import { listenSocket, type RpcListenSubscribeOpts } from "./listen-socket";
import { createRpcServer, type PromiseServerHooks, type RpcLimits, type RpcServerAuth, type RpcOpt } from "./rpc-server";
import {DeepSocketListen} from "./listen-deep";
import {SocketTmpl, IS_RPC_LISTEN, RPC_STOP} from "./rpc-protocol";

type ListenCallbackBase<T extends any[] = any[]> = ReturnType<typeof createListen<T>>;

/** Server backpressure gate thresholds for 'frame' subscribers (Feature B). Units of pending()
 *  and thresholds are the same (bytes/packets/frames — from transport). */
export type RpcReplayOpts = {
    /** Outgoing buffer fullness of THIS connection. Default — socket.io writeBuffer. */
    pending?: () => number
    /** Gate enters skip: pending() > highWater → frameLine envelopes stop being sent. */
    highWater?: number
    /** Exit (default 0): pending() <= lowWater → frame(lastSent) and then live. */
    lowWater?: number
    /** Polling period for pending() in skip mode, ms (default 25). */
    pollMs?: number
}

export function createRpcServerAuto<T extends object>({ socket, object: target, socketKey: key, debug, hooks, disconnectListen, limits, auth, maxPerListen, throttle, opt, replay = "auto", replayOpts }: {
    socket: SocketTmpl;
    object: T;
    socketKey: string;
    debug?: boolean;
    hooks?: Omit<PromiseServerHooks<DeepSocketListen<T>>, "resolveTransform">;
    disconnectListen?: ListenCallbackBase<any>;
    limits?: RpcLimits;
    auth?: RpcServerAuth;
    /** Opt-in ceiling for subscriber count on ONE Listen node of this socket. undefined = no
     *  limit (previous behavior, byte-for-byte). Extra subscriptions are silently ignored —
     *  defense against buggy/malicious client calling `*.callback(fn)` in a loop. */
    maxPerListen?: number;
    /** Opt-in min-interval (ms) for EACH server Listen node of this socket:
     *  emit no more than once per `throttle` ms (leading + trailing-latest). undefined/0 =
     *  no throttling. Server side is the best place for back-to-back: extra
     *  emissions are suppressed BEFORE packing/sending to wire. */
    throttle?: number;
    /** Wire optimizations (contractual): { compact?: false } disables tick compaction. */
    opt?: RpcOpt;
    /** Auto-detection of replay lines in facade: 'auto' (default) — by brand; 'force' — plus
     *  structural (lines from foreign module copy without brand); false — disabled, replay-line
     *  behaves as normal Listen (previous behavior). */
    replay?: false | "auto" | "force";
    /** Backpressure gates for 'frame' subscribers of replay lines. Without highWater no gates:
     *  frameLine = alias line (policy is selected, but server doesn't skip). */
    replayOpts?: RpcReplayOpts;
}) {
    // One listenSocket wrapper per Listen OVERWROTE the previous subscriber on re-subscribe
    // (its callback replaces last/active). Multiplexer: each subscriber
    // gets its own listenSocket; records are cleaned up on subscription completion.
    // Cache by Listen-node IDENTITY. Important for re-auth: facades of different principals should
    // reuse ONE and the same Listen object (one listen handle), otherwise on principal change
    // the old server subscription isn't removed and continues sending events. To CHANGE visibility
    // of the stream on the client — reconnect (dispose+reconnect), not reauth on live socket.
    const cache = new WeakMap<object, ReturnType<typeof listenSocket>>();
    // WeakMap can't be iterated — we keep a parallel ITERABLE registry of nodes with ACTIVE
    // subscribers, ONLY for stats/ceiling. Key — same node identity as in cache.
    // Registry FILLS LAZILY in subscribe() (not in getListenSocket): resolveTransform calls
    // getListenSocket EAGERLY for each declared Listen at startup and on every re-auth,
    // so registration there would (a) show zero nodes in stats and (b) pin old principal
    // nodes on a strong Map → leak per re-auth count. We register only real subscriptions.
    const registry = new Map<object, { subs: Map<Function, ReturnType<typeof listenSocket>> }>();
    function unsubscribeAllActive() {
        for (const {subs} of registry.values()) {
            subs.forEach(w => w.off());
            subs.clear();
        }
        registry.clear();
    }

    function getListenSocket(parent: any, disconnectListen?: ListenCallbackBase<any>, nodeOpt?: { throttle?: number }): ReturnType<typeof listenSocket> {
        // replay lines can't be throttled: dropped envelope = silent gap in seq,
        // so their nodes are created with explicit {throttle: undefined}
        const nodeThrottle = nodeOpt ? nodeOpt.throttle : throttle;
        let result = cache.get(parent);
        if (!result) {
            const subs = new Map<Function, ReturnType<typeof listenSocket>>();
            function subscribe(z: any, opts?: RpcListenSubscribeOpts) {
                if (typeof z !== "function") return Promise.reject(new TypeError("Listen callback expects a function"));
                // Opt-in ceiling per node: extra subscriber is silently ignored — stream for it
                // doesn't start, server subscription isn't created. Without option branch not taken.
                if (maxPerListen != null && subs.size >= maxPerListen) return Promise.resolve();
                // lazy (re-)registration of node on REAL subscription — survives drain→re-sub
                if (!registry.has(parent)) registry.set(parent, { subs });
                subs.get(z)?.off();
                const w = listenSocket(parent, { closeOn: disconnectListen, throttle: nodeThrottle });
                subs.set(z, w);
                const done = w.on(z, opts);
                done.then(() => {
                    if (subs.get(z) == w) subs.delete(z);
                    if (subs.size == 0) registry.delete(parent); // node emptied — remove from stats() count
                });
                return done;
            }
            // once — one-time subscription: first event → CB, then RPC_STOP→CB_END and off.
            function subscribeOnce(z: any, opts?: RpcListenSubscribeOpts) {
                if (typeof z !== "function") return Promise.reject(new TypeError("Listen once expects a function"));
                if (maxPerListen != null && subs.size >= maxPerListen) return Promise.resolve();
                if (!registry.has(parent)) registry.set(parent, { subs });
                subs.get(z)?.off();
                const w = listenSocket(parent, { closeOn: disconnectListen, throttle: nodeThrottle });
                let fired = false;
                const oneShot = (...a: any[]) => {
                    if (fired) return;
                    fired = true;
                    try {
                        z(...a);        // first event → CB
                        z(RPC_STOP);    // stream end → CB_END
                    }
                    finally {
                        w.off();
                    }
                };
                subs.set(z, w);
                const done = w.on(oneShot, opts);
                done.then(() => { if (subs.get(z) == w) subs.delete(z); if (subs.size == 0) registry.delete(parent); });
                return done;
            }
            function unsubscribeAll() {
                subs.forEach(w => w.off());
                subs.clear();
                registry.delete(parent); // node torn down — remove from registry
                return true;
            }
            // close — close entire Listen source (full teardown; affects ALL node consumers).
            result = { on: subscribe, off: unsubscribeAll, callback: subscribe, removeCallback: unsubscribeAll, once: subscribeOnce, close: () => (parent as any).close?.() };
            (result as any)[IS_RPC_LISTEN] = true; // server will declare node address in Pkt.MAP
            cache.set(parent, result);
        }
        return result;
    }

    // ===================================================================
    // replay-transparent exposure (Feature A): replay line in facade → BOTH
    // surfaces under THE SAME key. Legacy path (plain listen) byte-for-byte,
    // plus wire replay: line / frameLine / since / keyframe / frame.
    // Transport sees only seq — event semantics remain in line lambdas.
    // ===================================================================
    function isReplayNode(obj: any): boolean {
        if (replay == false || obj == null || typeof obj != "object") return false;
        if (Object.prototype.hasOwnProperty.call(obj, IS_REPLAY_LISTEN)) return true;
        // 'force': structural detection — for lines from foreign module copy without brand
        return replay == "force"
            && isListenCallback(obj)
            && typeof (obj as any).getSince == "function"
            && typeof (obj as any).keyframe == "function"
            && !!(obj as any).line && typeof (obj as any).line == "object";
    }

    // line frame with fallback for old replay-listen copies without frame method
    function lineFrame(parent: any, seq: number, hint?: unknown) {
        if (typeof parent.frame == "function") return parent.frame(seq, hint);
        const tail = parent.getSince(seq);
        if (tail) return tail;
        const kf = parent.keyframe();
        if (kf) return [kf];
        throw new Error(`replay frame(${seq}): journal evicted and no keyframe (sacred line)`);
    }

    // --- backpressure gates (Feature B): content-blind, per subscriber — one number (lastSent) ---
    const gateClosers = new Set<() => void>();
    function closeAllGates() { for (const c of [...gateClosers]) c(); }
    let gatesHooked = false;
    function hookGateTeardown() {
        if (gatesHooked || !disconnectListen) return;
        gatesHooked = true;
        disconnectListen.on(closeAllGates);
    }

    function gatedLineNode(parent: any) {
        const { pending: pendingOpt, highWater = Infinity, lowWater = 0, pollMs = 25 } = replayOpts ?? {};
        const pending = pendingOpt ?? (() => (socket as any)?.conn?.writeBuffer?.length ?? 0);
        // personal envelope line of this connection behind the gates
        const out = createListen<any[]>(() => {});
        out.run();
        let lastSent: number = typeof parent.head == "function" ? parent.head() : 0;
        let gated = false;
        let closed = false;
        let timer: any = null;
        function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }
        function startPoll() {
            if (timer || closed) return;
            timer = setInterval(recoverIfDrained, pollMs);
            timer.unref?.();
        }
        function close() {
            if (closed) return;
            closed = true;
            stopPoll();
            offLine();
            gateClosers.delete(close);
        }
        // loud rejection to THIS subscriber (sacred line + eviction): stream end
        // (RPC_STOP → CB_END on client), no silent loss
        function fail(e: any) {
            if (debug) console.error("[rpc replay gate] frame recovery failed:", e);
            const emitStop = !closed;
            close();
            if (emitStop) out.emit(RPC_STOP);
            (out as any).close?.();
        }
        function recoverIfDrained() {
            if (!gated || closed) return;
            if (pending() > lowWater) return;
            gated = false;
            stopPoll();
            let envs: any[];
            try { envs = lineFrame(parent, lastSent); }
            catch (e) { fail(e); return; }
            for (const ev of envs) {
                if (ev.seq > lastSent) lastSent = ev.seq;
                out.emit(ev);
            }
        }
        const offLine = parent.line.on(function gateForward(ev: any) {
            if (closed) return;
            if (!gated && pending() > highWater) { gated = true; startPoll(); }
            // drained right now → frame will include THIS envelope (journal written before fan-out);
            // still gated → envelope dropped, frame(lastSent) will cover it
            if (gated) { recoverIfDrained(); return; }
            lastSent = ev.seq;
            out.emit(ev);
        });
        gateClosers.add(close);
        hookGateTeardown();
        return getListenSocket(out, disconnectListen, { throttle: undefined });
    }

    // merged node under same key; cache by line identity (like cache of regular Listen)
    const replayCache = new WeakMap<object, any>();
    function getReplayExpose(parent: any) {
        let node = replayCache.get(parent);
        if (node) return node;
        const legacy = getListenSocket(parent, disconnectListen); // legacy surface as-is (including throttle)
        const lineNode = getListenSocket(parent.line, disconnectListen, { throttle: undefined });
        const frameLineNode = replayOpts?.highWater != null ? gatedLineNode(parent) : lineNode;
        node = {
            ...legacy,
            line: lineNode,
            frameLine: frameLineNode,
            since: (seq: number) => parent.getSince(seq) ?? null,
            keyframe: () => parent.keyframe() ?? null,
            // throw (sacred line + eviction) goes to client as rejected promise — loud
            frame: (seq: number, hint?: unknown) => lineFrame(parent, seq, hint),
        };
        node[IS_RPC_LISTEN] = true; // server will declare node address in Pkt.MAP (legacy subscription)
        replayCache.set(parent, node);
        return node;
    }

    // ===================================================================
    // api: subscription observability (additive — previously factory returned void)
    // ===================================================================
    const api = {
        /** Active server Listen nodes of this socket and count of their local consumers. */
        subscriptions: () => Array.from(registry, ([parent, e], i) => ({
            // key — stable identity token of node (NOT wire address): for debug/metrics.
            key: (parent as any)?.constructor?.name ? `${(parent as any).constructor.name}#${i}` : `listen#${i}`,
            consumers: e.subs.size,
        })),
    };

    createRpcServer({
        socket, object: target as any, socketKey: key, debug, limits, auth, opt,
        hooks: {
            ...hooks,
            onDispose: () => { closeAllGates(); unsubscribeAllActive(); hooks?.onDispose?.(); },
            resolveTransform: (obj: any) => {
                // IMPORTANT: replay detection BEFORE isListenCallback — replay-api passes
                // plain-Listen check structurally, and without brand its replay surface would be lost.
                if (isReplayNode(obj)) return getReplayExpose(obj);
                if (isListenCallback(obj)) return getListenSocket(obj, disconnectListen);
                // bare `on` function: find its api by registry (WeakMap) and wrap — allows
                // passing through web ONLY the on reference, client gets subscription {on, once, close}.
                if (isListenOn(obj)) {
                    const byOn = getListenByOn(obj);
                    return isReplayNode(byOn) ? getReplayExpose(byOn) : getListenSocket(byOn, disconnectListen);
                }
                return obj;
            },
        } as any,
    });

    return { api }; // additive: previously void. Old calls (harness x3, test.ts) ignore return.
}
