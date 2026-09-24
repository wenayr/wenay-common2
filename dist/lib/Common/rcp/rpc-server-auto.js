"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRpcServerAuto = createRpcServerAuto;
const Listen_1 = require("../events/Listen");
const replay_listen_1 = require("../events/replay-listen");
const listen_socket_1 = require("./listen-socket");
const rpc_server_1 = require("./rpc-server");
const rpc_protocol_1 = require("./rpc-protocol");
const rpc_walk_1 = require("./rpc-walk");
const rpc_internal_1 = require("./rpc-internal");
const rpc_scope_1 = require("./rpc-scope");
const replay_rpc_wire_1 = require("../events/replay-rpc-wire");
function createRpcServerAuto({ socket, object: target, socketKey: key, debug, hooks, disconnectListen, limits, auth, maxPerListen, throttle, opt, replay = "auto", replayOpts }) {
    const cache = new WeakMap();
    const scopeKeys = new WeakMap();
    function ownedKey(parent) {
        const scope = (0, rpc_scope_1.currentRpcScope)(rpcHooks);
        if (!scope)
            return parent;
        let keys = scopeKeys.get(parent);
        if (!keys) {
            keys = new WeakMap();
            scopeKeys.set(parent, keys);
        }
        let key = keys.get(scope);
        if (!key) {
            key = {};
            keys.set(scope, key);
        }
        return key;
    }
    const registry = new Map();
    const sourceByNode = new WeakMap();
    function unsubscribeAllActive() {
        for (const { subs } of registry.values()) {
            subs.forEach(w => w.off());
            subs.clear();
        }
        registry.clear();
    }
    function unsubscribeUnreachable({ keep, drop }) {
        const kept = new Set();
        for (const node of keep) {
            const source = sourceByNode.get(node);
            if (source)
                kept.add(source);
        }
        for (const node of drop) {
            const source = sourceByNode.get(node);
            if (!source || kept.has(source))
                continue;
            const entry = registry.get(source);
            if (!entry)
                continue;
            entry.subs.forEach(function endSubscriber(w, z) { (0, rpc_walk_1.rpcEndCallback)(z); w.off(); });
            entry.subs.clear();
            registry.delete(source);
        }
    }
    function getListenSocket(parent, disconnectListen, nodeOpt) {
        const nodeThrottle = nodeOpt ? nodeOpt.throttle : throttle;
        const scope = (0, rpc_scope_1.currentRpcScope)(rpcHooks);
        const owner = ownedKey(parent);
        let result = cache.get(owner);
        if (!result) {
            const subs = new Map();
            const byCbId = new Map();
            function indexSubscriber(z, w) {
                subs.set(z, w);
                const cbId = (0, rpc_internal_1.rpcCallbackId)(z);
                if (cbId != undefined)
                    byCbId.set(cbId, z);
            }
            function forgetSubscriber(z) {
                subs.delete(z);
                const cbId = (0, rpc_internal_1.rpcCallbackId)(z);
                if (cbId != undefined && byCbId.get(cbId) == z)
                    byCbId.delete(cbId);
            }
            function subscribe(z, opts) {
                scope?.check();
                if (typeof z !== "function")
                    return Promise.reject(new TypeError("Listen callback expects a function"));
                if (maxPerListen != null && subs.size >= maxPerListen)
                    return Promise.resolve();
                if (!registry.has(owner))
                    registry.set(owner, { subs });
                subs.get(z)?.off();
                const w = (0, listen_socket_1.listenSocket)(parent, { closeOn: disconnectListen, throttle: nodeThrottle });
                indexSubscriber(z, w);
                const forget = scope?.own(function closeScopedSubscription() {
                    try {
                        (0, rpc_walk_1.rpcEndCallback)(z);
                    }
                    finally {
                        w.off();
                        forgetSubscriber(z);
                        if (!subs.size)
                            registry.delete(owner);
                    }
                });
                const done = w.on(z, opts);
                done.then(() => {
                    forget?.();
                    if (subs.get(z) == w)
                        forgetSubscriber(z);
                    if (subs.size == 0)
                        registry.delete(owner);
                });
                return done;
            }
            function subscribeOnce(z, opts) {
                scope?.check();
                if (typeof z !== "function")
                    return Promise.reject(new TypeError("Listen once expects a function"));
                if (maxPerListen != null && subs.size >= maxPerListen)
                    return Promise.resolve();
                if (!registry.has(owner))
                    registry.set(owner, { subs });
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
                indexSubscriber(z, w);
                const forget = scope?.own(function closeScopedOnce() {
                    try {
                        (0, rpc_walk_1.rpcEndCallback)(z);
                    }
                    finally {
                        w.off();
                        forgetSubscriber(z);
                        if (!subs.size)
                            registry.delete(owner);
                    }
                });
                const done = w.on(oneShot, opts);
                done.then(() => { forget?.(); if (subs.get(z) == w)
                    forgetSubscriber(z); if (subs.size == 0)
                    registry.delete(owner); });
                return done;
            }
            function unsubscribeAll() {
                subs.forEach(w => w.off());
                subs.clear();
                byCbId.clear();
                registry.delete(owner);
                return true;
            }
            function removeCallback(...cbIds) {
                const ids = cbIds.filter(function isCbId(x) { return typeof x == "number"; });
                if (ids.length == 0)
                    return unsubscribeAll();
                for (const id of ids) {
                    const z = byCbId.get(id);
                    if (!z)
                        continue;
                    const w = subs.get(z);
                    forgetSubscriber(z);
                    w?.off();
                }
                if (subs.size == 0)
                    registry.delete(owner);
                return true;
            }
            result = { on: subscribe, off: unsubscribeAll, callback: subscribe, removeCallback, once: subscribeOnce, close: () => scope ? unsubscribeAll() : parent.close?.() };
            result[rpc_protocol_1.IS_RPC_LISTEN] = true;
            cache.set(owner, result);
            sourceByNode.set(result, owner);
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
    function gatedLineNode(source) {
        const resourceScope = (0, rpc_scope_1.currentRpcScope)(rpcHooks);
        let forgetScope;
        const { pending: pendingOpt, highWater = Infinity, lowWater = 0, pollMs = 25 } = replayOpts ?? {};
        const pending = pendingOpt ?? (() => socket?.conn?.writeBuffer?.length ?? 0);
        const out = (0, Listen_1.createListen)(function holdReplayGateOutput() { }, {
            event(type, count) {
                if (type == 'add' && count == 1)
                    startSource();
                if (type == 'remove' && count == 0)
                    stopSource();
            },
        });
        out.run();
        let lastSent = 0;
        let gated = false;
        let closed = false;
        let active = false;
        let timer = null;
        let offLine = null;
        function stopPoll() { if (timer) {
            clearInterval(timer);
            timer = null;
        } }
        function startPoll() {
            if (timer || closed || !active)
                return;
            timer = setInterval(recoverIfDrained, pollMs);
            timer.unref?.();
        }
        function stopSource() {
            if (!active)
                return;
            active = false;
            stopPoll();
            offLine?.();
            offLine = null;
            gated = false;
        }
        function startSource() {
            if (closed || active)
                return;
            active = true;
            lastSent = source.head();
            offLine = source.line.on(gateForward);
        }
        function close() {
            if (closed)
                return;
            closed = true;
            forgetScope?.();
            stopSource();
            gateClosers.delete(close);
            out.close();
        }
        function fail(e) {
            forgetScope?.();
            if (debug)
                console.error("[rpc replay gate] frame recovery failed:", e);
            const emitStop = !closed;
            closed = true;
            stopSource();
            gateClosers.delete(close);
            if (emitStop)
                out.emit(rpc_protocol_1.RPC_STOP);
            out.close?.();
        }
        function recoverIfDrained() {
            if (!gated || closed || !active)
                return;
            if (pending() > lowWater)
                return;
            gated = false;
            stopPoll();
            let envs;
            try {
                envs = source.frame(lastSent);
            }
            catch (e) {
                fail(e);
                return;
            }
            for (const ev of envs) {
                const seq = source.sequenceOf(ev);
                if (seq == undefined) {
                    fail(new TypeError('replay gate received an envelope without a sequence'));
                    return;
                }
                if (seq > lastSent)
                    lastSent = seq;
                out.emit(ev);
            }
        }
        function gateForward(ev) {
            if (closed || !active)
                return;
            if (!gated && pending() > highWater) {
                gated = true;
                startPoll();
            }
            if (gated) {
                recoverIfDrained();
                return;
            }
            const seq = source.sequenceOf(ev);
            if (seq == undefined) {
                fail(new TypeError('replay gate received an envelope without a sequence'));
                return;
            }
            lastSent = seq;
            out.emit(ev);
        }
        gateClosers.add(close);
        forgetScope = resourceScope?.own(close);
        hookGateTeardown();
        return getListenSocket(out, disconnectListen, { throttle: undefined });
    }
    function rawReplayGateSource(parent) {
        return {
            line: parent.line,
            head: () => typeof parent.head == 'function' ? parent.head() : 0,
            frame: (seq, hint) => lineFrame(parent, seq, hint),
            sequenceOf(event) {
                const seq = event?.seq;
                return typeof seq == 'number' ? seq : undefined;
            },
        };
    }
    function wireReplayGateSource(parent, source) {
        return {
            ...source,
            line: parent.line,
            frame(seq, hint) {
                if (typeof parent.frame == 'function')
                    return parent.frame(seq, hint);
                const tail = parent.since(seq);
                if (tail)
                    return tail;
                const keyframe = parent.keyframe();
                return keyframe ? [keyframe] : [];
            },
        };
    }
    const replayCache = new WeakMap();
    function getReplayExpose(parent) {
        const owner = ownedKey(parent);
        let node = replayCache.get(owner);
        if (node)
            return node;
        const legacy = getListenSocket(parent, disconnectListen);
        const lineNode = getListenSocket(parent.line, disconnectListen, { throttle: undefined });
        const frameLineNode = replayOpts?.highWater != null
            ? gatedLineNode(rawReplayGateSource(parent))
            : lineNode;
        node = {
            ...legacy,
            line: lineNode,
            frameLine: frameLineNode,
            since: (seq) => parent.getSince(seq) ?? null,
            keyframe: () => parent.keyframe() ?? null,
            frame: (seq, hint) => lineFrame(parent, seq, hint),
        };
        node[rpc_protocol_1.IS_RPC_LISTEN] = true;
        replayCache.set(owner, node);
        sourceByNode.set(node, owner);
        return node;
    }
    function getReplayWireExpose(parent, source) {
        const owner = ownedKey(parent);
        let node = replayCache.get(owner);
        if (node)
            return node;
        const lineNode = getListenSocket(parent.line, disconnectListen, { throttle: undefined });
        const frameLineNode = replayOpts?.highWater != null
            ? gatedLineNode(wireReplayGateSource(parent, source))
            : lineNode;
        node = {
            ...parent,
            line: lineNode,
            frameLine: frameLineNode,
        };
        replayCache.set(owner, node);
        return node;
    }
    const api = {
        subscriptions: () => Array.from(registry, ([parent, e], i) => ({
            key: parent?.constructor?.name ? `${parent.constructor.name}#${i}` : `listen#${i}`,
            consumers: e.subs.size,
        })),
    };
    const rpcHooks = (0, rpc_scope_1.inheritRpcScopes)(hooks, {
        ...hooks,
        onDispose: () => { closeAllGates(); unsubscribeAllActive(); hooks?.onDispose?.(); },
        onPrincipalChange: (ctx) => { unsubscribeUnreachable(ctx); hooks?.onPrincipalChange?.(ctx); },
        resolveTransform: (obj) => {
            if (isReplayNode(obj))
                return getReplayExpose(obj);
            const replayWireSource = replay == false ? undefined : (0, replay_rpc_wire_1.getRpcReplayWireSource)(obj);
            if (replayWireSource)
                return getReplayWireExpose(obj, replayWireSource);
            if ((0, Listen_1.isListenCallback)(obj))
                return getListenSocket(obj, disconnectListen);
            if ((0, Listen_1.isListenOn)(obj)) {
                const byOn = (0, Listen_1.getListenByOn)(obj);
                return isReplayNode(byOn) ? getReplayExpose(byOn) : getListenSocket(byOn, disconnectListen);
            }
            return obj;
        },
    });
    const core = (0, rpc_server_1.createRpcServer)({
        socket, object: target, socketKey: key, debug, limits, auth, opt,
        hooks: rpcHooks,
    });
    if (disconnectListen) {
        const detachCore = (0, rpc_internal_1.coreDetachOf)(core);
        if (detachCore)
            disconnectListen.on(detachCore);
    }
    return { ...core, api };
}
