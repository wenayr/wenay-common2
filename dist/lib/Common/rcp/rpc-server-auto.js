"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRpcServerAuto = createRpcServerAuto;
const Listen_1 = require("../events/Listen");
const replay_listen_1 = require("../events/replay-listen");
const listen_socket_1 = require("./listen-socket");
const rpc_server_1 = require("./rpc-server");
const rpc_protocol_1 = require("./rpc-protocol");
const rpc_walk_1 = require("./rpc-walk");
function createRpcServerAuto({ socket, object: target, socketKey: key, debug, hooks, disconnectListen, limits, auth, maxPerListen, throttle, opt, replay = "auto", replayOpts }) {
    const cache = new WeakMap();
    const registry = new Map();
    function unsubscribeAllActive() {
        for (const { subs } of registry.values()) {
            subs.forEach(w => w.off());
            subs.clear();
        }
        registry.clear();
    }
    function getListenSocket(parent, disconnectListen, nodeOpt) {
        const nodeThrottle = nodeOpt ? nodeOpt.throttle : throttle;
        let result = cache.get(parent);
        if (!result) {
            const subs = new Map();
            function subscribe(z, opts) {
                if (typeof z !== "function")
                    return Promise.reject(new TypeError("Listen callback expects a function"));
                if (maxPerListen != null && subs.size >= maxPerListen)
                    return Promise.resolve();
                if (!registry.has(parent))
                    registry.set(parent, { subs });
                subs.get(z)?.off();
                const w = (0, listen_socket_1.listenSocket)(parent, { closeOn: disconnectListen, throttle: nodeThrottle });
                subs.set(z, w);
                const done = w.on(z, opts);
                done.then(() => {
                    if (subs.get(z) == w)
                        subs.delete(z);
                    if (subs.size == 0)
                        registry.delete(parent);
                });
                return done;
            }
            function subscribeOnce(z, opts) {
                if (typeof z !== "function")
                    return Promise.reject(new TypeError("Listen once expects a function"));
                if (maxPerListen != null && subs.size >= maxPerListen)
                    return Promise.resolve();
                if (!registry.has(parent))
                    registry.set(parent, { subs });
                subs.get(z)?.off();
                const w = (0, listen_socket_1.listenSocket)(parent, { closeOn: disconnectListen, throttle: nodeThrottle });
                let fired = false;
                const oneShot = (...a) => {
                    if (fired)
                        return;
                    fired = true;
                    try {
                        z(...a);
                        (0, rpc_walk_1.rpcEndCallback)(z);
                    }
                    finally {
                        w.off();
                    }
                };
                subs.set(z, w);
                const done = w.on(oneShot, opts);
                done.then(() => { if (subs.get(z) == w)
                    subs.delete(z); if (subs.size == 0)
                    registry.delete(parent); });
                return done;
            }
            function unsubscribeAll() {
                subs.forEach(w => w.off());
                subs.clear();
                registry.delete(parent);
                return true;
            }
            result = { on: subscribe, off: unsubscribeAll, callback: subscribe, removeCallback: unsubscribeAll, once: subscribeOnce, close: () => parent.close?.() };
            result[rpc_protocol_1.IS_RPC_LISTEN] = true;
            cache.set(parent, result);
        }
        return result;
    }
    function isReplayNode(obj) {
        if (replay == false || obj == null || typeof obj != "object")
            return false;
        if (Object.prototype.hasOwnProperty.call(obj, replay_listen_1.IS_REPLAY_LISTEN))
            return true;
        return replay == "force"
            && (0, Listen_1.isListenCallback)(obj)
            && typeof obj.getSince == "function"
            && typeof obj.keyframe == "function"
            && !!obj.line && typeof obj.line == "object";
    }
    function lineFrame(parent, seq, hint) {
        if (typeof parent.frame == "function")
            return parent.frame(seq, hint);
        const tail = parent.getSince(seq);
        if (tail)
            return tail;
        const kf = parent.keyframe();
        if (kf)
            return [kf];
        throw new Error(`replay frame(${seq}): journal evicted and no keyframe (sacred line)`);
    }
    const gateClosers = new Set();
    function closeAllGates() { for (const c of [...gateClosers])
        c(); }
    let gatesHooked = false;
    function hookGateTeardown() {
        if (gatesHooked || !disconnectListen)
            return;
        gatesHooked = true;
        disconnectListen.on(closeAllGates);
    }
    function gatedLineNode(parent) {
        const { pending: pendingOpt, highWater = Infinity, lowWater = 0, pollMs = 25 } = replayOpts ?? {};
        const pending = pendingOpt ?? (() => socket?.conn?.writeBuffer?.length ?? 0);
        const out = (0, Listen_1.createListen)(() => { });
        out.run();
        let lastSent = typeof parent.head == "function" ? parent.head() : 0;
        let gated = false;
        let closed = false;
        let timer = null;
        function stopPoll() { if (timer) {
            clearInterval(timer);
            timer = null;
        } }
        function startPoll() {
            if (timer || closed)
                return;
            timer = setInterval(recoverIfDrained, pollMs);
            timer.unref?.();
        }
        function close() {
            if (closed)
                return;
            closed = true;
            stopPoll();
            offLine();
            gateClosers.delete(close);
        }
        function fail(e) {
            if (debug)
                console.error("[rpc replay gate] frame recovery failed:", e);
            const emitStop = !closed;
            close();
            if (emitStop)
                out.emit(rpc_protocol_1.RPC_STOP);
            out.close?.();
        }
        function recoverIfDrained() {
            if (!gated || closed)
                return;
            if (pending() > lowWater)
                return;
            gated = false;
            stopPoll();
            let envs;
            try {
                envs = lineFrame(parent, lastSent);
            }
            catch (e) {
                fail(e);
                return;
            }
            for (const ev of envs) {
                if (ev.seq > lastSent)
                    lastSent = ev.seq;
                out.emit(ev);
            }
        }
        const offLine = parent.line.on(function gateForward(ev) {
            if (closed)
                return;
            if (!gated && pending() > highWater) {
                gated = true;
                startPoll();
            }
            if (gated) {
                recoverIfDrained();
                return;
            }
            lastSent = ev.seq;
            out.emit(ev);
        });
        gateClosers.add(close);
        hookGateTeardown();
        return getListenSocket(out, disconnectListen, { throttle: undefined });
    }
    const replayCache = new WeakMap();
    function getReplayExpose(parent) {
        let node = replayCache.get(parent);
        if (node)
            return node;
        const legacy = getListenSocket(parent, disconnectListen);
        const lineNode = getListenSocket(parent.line, disconnectListen, { throttle: undefined });
        const frameLineNode = replayOpts?.highWater != null ? gatedLineNode(parent) : lineNode;
        node = {
            ...legacy,
            line: lineNode,
            frameLine: frameLineNode,
            since: (seq) => parent.getSince(seq) ?? null,
            keyframe: () => parent.keyframe() ?? null,
            frame: (seq, hint) => lineFrame(parent, seq, hint),
        };
        node[rpc_protocol_1.IS_RPC_LISTEN] = true;
        replayCache.set(parent, node);
        return node;
    }
    const api = {
        subscriptions: () => Array.from(registry, ([parent, e], i) => ({
            key: parent?.constructor?.name ? `${parent.constructor.name}#${i}` : `listen#${i}`,
            consumers: e.subs.size,
        })),
    };
    (0, rpc_server_1.createRpcServer)({
        socket, object: target, socketKey: key, debug, limits, auth, opt,
        hooks: {
            ...hooks,
            onDispose: () => { closeAllGates(); unsubscribeAllActive(); hooks?.onDispose?.(); },
            resolveTransform: (obj) => {
                if (isReplayNode(obj))
                    return getReplayExpose(obj);
                if ((0, Listen_1.isListenCallback)(obj))
                    return getListenSocket(obj, disconnectListen);
                if ((0, Listen_1.isListenOn)(obj)) {
                    const byOn = (0, Listen_1.getListenByOn)(obj);
                    return isReplayNode(byOn) ? getReplayExpose(byOn) : getListenSocket(byOn, disconnectListen);
                }
                return obj;
            },
        },
    });
    return { api };
}
