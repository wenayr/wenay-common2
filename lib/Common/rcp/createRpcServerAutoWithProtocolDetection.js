"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRpcServerAutoDetect = createRpcServerAutoDetect;
const Listen_1 = require("../events/Listen");
const listen_socket_1 = require("./listen-socket");
const rpc_server_1 = require("./rpc-server");
const rpc_protocol_1 = require("./rpc-protocol");
const oldCommonsServerMini_1 = require("./oldCommonsServerMini");
const rpc_dynamic_1 = require("./rpc-dynamic");
const rpc_limits_1 = require("./rpc-limits");
function createRpcServerAutoDetect({ socket, object: target, socketKey: key, debug = false, hooks, disconnectListen, limits, opt, onProtocolDetect, }) {
    const cache = new WeakMap();
    const listenSockets = new Set();
    function unsubscribeAllActive() {
        for (const w of [...listenSockets])
            w.off();
    }
    function getListenSocket(parent) {
        let result = cache.get(parent);
        if (result)
            listenSockets.add(result);
        if (!result) {
            const subs = new Map();
            function subscribe(z) {
                if (typeof z !== "function")
                    return Promise.reject(new TypeError("Listen callback expects a function"));
                subs.get(z)?.off();
                const w = (0, listen_socket_1.listenSocket)(parent, { closeOn: disconnectListen });
                subs.set(z, w);
                const done = w.on(z);
                done.then(() => { if (subs.get(z) == w)
                    subs.delete(z); });
                return done;
            }
            function subscribeOnce(z) {
                if (typeof z !== "function")
                    return Promise.reject(new TypeError("Listen once expects a function"));
                subs.get(z)?.off();
                const w = (0, listen_socket_1.listenSocket)(parent, { closeOn: disconnectListen });
                subs.set(z, w);
                const done = w.once(z);
                done.then(() => { if (subs.get(z) == w)
                    subs.delete(z); });
                return done;
            }
            function unsubscribeAll() {
                subs.forEach(w => w.off());
                subs.clear();
                return true;
            }
            result = { on: subscribe, off: unsubscribeAll, callback: subscribe, removeCallback: unsubscribeAll, once: subscribeOnce, close: () => parent.close?.() };
            listenSockets.add(result);
            cache.set(parent, result);
        }
        return result;
    }
    function resolveTransform(obj) {
        if ((0, Listen_1.isListenCallback)(obj))
            return getListenSocket(obj);
        if ((0, Listen_1.isListenOn)(obj))
            return getListenSocket((0, Listen_1.getListenByOn)(obj));
        return obj;
    }
    function transformTree(obj) {
        let current = obj;
        if (!(0, rpc_dynamic_1.isNoStrict)(current)) {
            current = resolveTransform(current);
        }
        if (current == null || typeof current !== 'object' || (0, rpc_dynamic_1.isNoStrict)(current))
            return current;
        const out = {};
        for (const k of Object.keys(current)) {
            if (!(0, rpc_limits_1.isSafeKey)(k))
                continue;
            const v = current[k];
            if ((0, rpc_dynamic_1.isNoStrict)(v)) {
                out[k] = v;
                continue;
            }
            out[k] = typeof v === 'function' ? resolveTransform(v) : (v != null && typeof v === 'object') ? transformTree(v) : v;
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
                    out[k] = 'null';
                    break;
                case (0, rpc_dynamic_1.isNoStrict)(v):
                    out[k] = 'dynamic';
                    break;
                case typeof v === 'function':
                    out[k] = 'func';
                    break;
                case typeof v === 'object':
                    out[k] = serialize(v);
                    break;
                default:
                    out[k] = 'unknown';
                    break;
            }
        }
        return out;
    }
    const resolved = transformTree(target);
    const legacySchema = serialize(resolved);
    let protocol = null;
    let v2Handler = null;
    let legacyHandler = null;
    let disposed = false;
    let activeHandler = null;
    function isLegacyStrictRequest(msg) {
        return msg === '___STRICTLY';
    }
    function isLegacyMessage(msg) {
        return (typeof msg === 'object' &&
            msg !== null &&
            !Array.isArray(msg) &&
            typeof msg.mapId === 'number');
    }
    function isV2Message(msg) {
        if (msg === rpc_protocol_1.Pkt.STRICT)
            return true;
        if (Array.isArray(msg) && (msg[0] === rpc_protocol_1.Pkt.CALL || msg[0] === rpc_protocol_1.Pkt.PIPE
            || msg[0] === rpc_protocol_1.Pkt.HELLO || msg[0] === rpc_protocol_1.Pkt.CAPS))
            return true;
        return false;
    }
    function initLegacy() {
        if (legacyHandler)
            return;
        let onMessageCb = null;
        (0, oldCommonsServerMini_1.promiseServer)({
            sendMessage: (msg) => socket.emit(key, msg),
            api: ({ onMessage }) => { onMessageCb = onMessage; },
        }, resolved);
        legacyHandler = (msg) => {
            if (!onMessageCb)
                return;
            onMessageCb(msg);
        };
    }
    function initV2() {
        if (v2Handler)
            return;
        let onMsgCb = null;
        const innerSocket = {
            emit: (e, d) => socket.emit(e, d),
            on: (e, cb) => { if (e === key)
                onMsgCb = cb; },
        };
        (0, rpc_server_1.createRpcServer)({
            socket: innerSocket,
            object: target,
            socketKey: key,
            debug,
            limits,
            opt,
            hooks: {
                ...hooks,
                onDispose: () => { unsubscribeAllActive(); hooks?.onDispose?.(); },
                resolveTransform,
            },
        });
        v2Handler = (msg) => {
            if (!onMsgCb)
                return;
            onMsgCb(msg);
        };
    }
    function handleMessage(msg) {
        if (debug) {
            const binary = msg instanceof ArrayBuffer || ArrayBuffer.isView(msg);
            let shown = msg;
            if (binary)
                shown = `[binary ${msg.byteLength} bytes]`;
            else if (typeof msg == 'object') {
                try {
                    shown = JSON.stringify(msg);
                }
                catch {
                    shown = String(msg);
                }
            }
            console.log('[RPC-AUTO-DETECT IN]', shown);
        }
        if (protocol === 'legacy') {
            if (isLegacyStrictRequest(msg)) {
                socket.emit(key, { STRICTLY: legacySchema });
                return;
            }
            legacyHandler(msg);
            return;
        }
        if (protocol === 'v2') {
            v2Handler(msg);
            return;
        }
        if (isLegacyStrictRequest(msg)) {
            protocol = 'legacy';
            if (debug)
                console.log('[RPC-AUTO-DETECT] Protocol detected: legacy (___STRICTLY)');
            onProtocolDetect?.('legacy');
            initLegacy();
            socket.emit(key, { STRICTLY: legacySchema });
            return;
        }
        if (isLegacyMessage(msg)) {
            protocol = 'legacy';
            if (debug)
                console.log('[RPC-AUTO-DETECT] Protocol detected: legacy (mapId message)');
            onProtocolDetect?.('legacy');
            initLegacy();
            legacyHandler(msg);
            return;
        }
        if (isV2Message(msg)) {
            protocol = 'v2';
            if (debug)
                console.log('[RPC-AUTO-DETECT] Protocol detected: v2');
            onProtocolDetect?.('v2');
            initV2();
            v2Handler(msg);
            return;
        }
        if (debug)
            console.warn('[RPC-AUTO-DETECT] Unknown message format, ignoring:', msg);
    }
    activeHandler = handleMessage;
    socket.on(key, (msg) => activeHandler?.(msg));
    function reset() { unsubscribeAllActive(); protocol = null; legacyHandler = null; v2Handler = null; }
    function dispose(reason) {
        if (disposed)
            return;
        disposed = true;
        activeHandler = null;
        reset();
        if (debug)
            console.log('[RPC-AUTO-DETECT] disposed', reason ?? '');
    }
    return {
        getProtocol: () => protocol,
        getLegacySchema: () => legacySchema,
        getResolved: () => resolved,
        dispose,
        reset,
    };
}
