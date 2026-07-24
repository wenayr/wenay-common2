import { isListenCallback, createListen, isListenOn, getListenByOn } from "../events/Listen";
import { listenSocket } from "./listen-socket";
import { createRpcServer, type PromiseServerHooks, type RpcLimits, type RpcOpt } from "./rpc-server";
import { DeepSocketListen } from "./listen-deep";
import { Pkt, type SocketTmpl } from "./rpc-protocol";
import { promiseServer } from "./oldCommonsServerMini";
import { isNoStrict } from "./rpc-dynamic";
import { isSafeKey } from "./rpc-limits";

type ListenCallbackBase<T extends any[] = any[]> = ReturnType<typeof createListen<T>>;

// ── New version with compatibility ───────────────────────────────────
//
// Protocol detection:
//   Legacy client sends "___STRICTLY" (string) or { mapId, data } (object) first
//   V2 client sends Pkt.STRICT (number 4) or [Pkt.CALL, ...] (array) first
//
// Formats do NOT overlap:
//   "___STRICTLY" — string (legacy only)
//   { mapId, data } — plain object (legacy only)
//   4              — number (v2 only)
//   [0, ...]       — array (v2 only)
//

type ClientProtocol = 'v2' | 'legacy' | null;

export function createRpcServerAutoDetect<T extends object>({
                                                           socket,
                                                           object: target,
                                                           socketKey: key,
                                                           debug = false,
                                                           hooks,
                                                           disconnectListen,
                                                           limits,
                                                           opt,
                                                           onProtocolDetect,
                                                       }: {
    socket: SocketTmpl;
    object: T;
    socketKey: string;
    debug?: boolean;
    hooks?: Omit<PromiseServerHooks<DeepSocketListen<T>>, "resolveTransform">;
    disconnectListen?: ListenCallbackBase<any>;
    limits?: RpcLimits;
    opt?: RpcOpt;
    onProtocolDetect?: (protocol: 'v2' | 'legacy') => void;
}) {
    // ── Common cache of Listen multiplexers for both protocols ─────────────
    const cache = new WeakMap<object, ReturnType<typeof listenSocket>>();
    const listenSockets = new Set<ReturnType<typeof listenSocket>>();
    function unsubscribeAllActive() {
        for (const w of [...listenSockets]) w.off();
    }

    function getListenSocket(parent: any): ReturnType<typeof listenSocket> {
        let result = cache.get(parent);
        if (result) listenSockets.add(result);
        if (!result) {
            const subs = new Map<Function, ReturnType<typeof listenSocket>>();
            function subscribe(z: any) {
                if (typeof z !== "function") return Promise.reject(new TypeError("Listen callback expects a function"));
                subs.get(z)?.off();
                const w = listenSocket(parent, { closeOn: disconnectListen });
                subs.set(z, w);
                const done = w.on(z);
                done.then(() => { if (subs.get(z) == w) subs.delete(z); });
                return done;
            }
            function subscribeOnce(z: any) {
                if (typeof z !== "function") return Promise.reject(new TypeError("Listen once expects a function"));
                subs.get(z)?.off();
                const w = listenSocket(parent, { closeOn: disconnectListen });
                subs.set(z, w);
                const done = w.once(z);
                done.then(() => { if (subs.get(z) == w) subs.delete(z); });
                return done;
            }
            function unsubscribeAll() {
                subs.forEach(w => w.off());
                subs.clear();
                return true;
            }
            result = { on: subscribe, off: unsubscribeAll, callback: subscribe, removeCallback: unsubscribeAll, once: subscribeOnce, close: () => (parent as any).close?.() } as ReturnType<typeof listenSocket>;
            listenSockets.add(result);
            cache.set(parent, result);
        }
        return result;
    }

    /** Common transformer: Listen → listenSocket({ callback, removeCallback }) */
    function resolveTransform(obj: any): any {
        if (isListenCallback(obj)) return getListenSocket(obj);
        if (isListenOn(obj)) return getListenSocket(getListenByOn(obj)); // bare `on` → Listen wrapper from registry
        return obj;
    }

    // ── Object tree transformation (Listen → listenSocket) ─────
    // Mirrors transformTree logic from rpc-server.ts:
    // - isNoStrict objects pass through as-is
    // - isSafeKey filters keys
    // - resolveTransform applied to each node
    function transformTree(obj: any): any {
        let current = obj;
        if (!isNoStrict(current)) {
            current = resolveTransform(current);
        }
        if (current == null || typeof current !== 'object' || isNoStrict(current)) return current;
        const out: any = {};
        for (const k of Object.keys(current)) {
            if (!isSafeKey(k)) continue;
            const v = current[k];
            if (isNoStrict(v)) { out[k] = v; continue; }
            out[k] = typeof v === 'function' ? resolveTransform(v) : (v != null && typeof v === 'object') ? transformTree(v) : v;
        }
        return out;
    }

    // ── Schema serialization (mirrors serialize logic from rpc-server.ts) ──
    function serialize(obj: any): any {
        const out: any = {};
        for (const k of Object.keys(obj)) {
            if (!isSafeKey(k)) continue;
            const v = obj[k];
            switch (true) {
                case v == null:              out[k] = 'null';    break;
                case isNoStrict(v):          out[k] = 'dynamic'; break;
                case typeof v === 'function': out[k] = 'func';   break;
                case typeof v === 'object':   out[k] = serialize(v); break;
                default:                      out[k] = 'unknown'; break;
            }
        }
        return out;
    }

    // resolved — tree with Listen replaced by { callback, removeCallback }
    const resolved = transformTree(target);
    // legacySchema — serialized schema for legacy client
    const legacySchema = serialize(resolved);

    // ── Protocol detection ───────────────────────────────────
    let protocol: ClientProtocol = null;
    let v2Handler: ((msg: any) => void) | null = null;
    let legacyHandler: ((msg: any) => void) | null = null;
    let disposed = false;
    let activeHandler: ((msg: any) => void) | null = null; // stable router delegate; null = inert

    /** Legacy client requests schema with string "___STRICTLY" */
    function isLegacyStrictRequest(msg: any): boolean {
        return msg === '___STRICTLY';
    }

    /** Legacy message: plain object with { mapId: number } */
    function isLegacyMessage(msg: any): boolean {
        return (
            typeof msg === 'object' &&
            msg !== null &&
            !Array.isArray(msg) &&
            typeof msg.mapId === 'number'
        );
    }

    /** V2 message: Pkt.STRICT (number 4) or array [Pkt.CALL|PIPE|HELLO, ...].
     *  HELLO — token client sends it FIRST (in-band auth); without it detector would drop HELLO,
     *  and client auth() would hang. Inner createRpcServer handles HELLO itself. */
    function isV2Message(msg: any): boolean {
        if (msg === Pkt.STRICT) return true;
        if (Array.isArray(msg) && (msg[0] === Pkt.CALL || msg[0] === Pkt.PIPE
            || msg[0] === Pkt.HELLO || msg[0] === Pkt.CAPS)) return true;
        return false;
    }

    // ── Legacy server initialization (lazy) ───────────────────
    function initLegacy() {
        if (legacyHandler) return;

        let onMessageCb: ((msg: any) => void | Promise<void>) | null = null;

        promiseServer(
            {
                sendMessage: (msg) => socket.emit(key, msg),
                api: ({ onMessage }) => { onMessageCb = onMessage; },
            },
            resolved as any,
        );

        legacyHandler = (msg: any) => {
            if (!onMessageCb) return;
            onMessageCb(msg);
        };
    }

    // ── V2 server initialization (lazy) ───────────────────────
    function initV2() {
        if (v2Handler) return;

        let onMsgCb: ((msg: any) => void) | null = null;
        const innerSocket: SocketTmpl = {
            emit: (e, d) => socket.emit(e, d),
            on: (e, cb) => { if (e === key) onMsgCb = cb; },
        };

        createRpcServer({
            socket: innerSocket,
            object: target as any,
            socketKey: key,
            debug,
            limits,
            opt,
            hooks: {
                ...hooks,
                onDispose: () => { unsubscribeAllActive(); hooks?.onDispose?.(); },
                resolveTransform,
            } as any,
        });

        v2Handler = (msg: any) => {
            if (!onMsgCb) return;
            onMsgCb(msg);
        };
    }

    // ── Main message handler ────────────────────────────
    // SocketTmpl doesn't support off → register ONE stable router delegating to activeHandler;
    // dispose() nullifies activeHandler → router becomes inert (idiom from rpc-server.ts:26-29).
    function handleMessage(msg: any) {
        if (debug) {
            const binary = msg instanceof ArrayBuffer || ArrayBuffer.isView(msg)
            let shown = msg
            if (binary) shown = `[binary ${msg.byteLength} bytes]`
            else if (typeof msg == 'object') {
                try { shown = JSON.stringify(msg) }
                catch { shown = String(msg) }
            }
            console.log('[RPC-AUTO-DETECT IN]', shown)
        }

        // ── Fast path: protocol already detected ───────────────
        if (protocol === 'legacy') {
            if (isLegacyStrictRequest(msg)) {
                socket.emit(key, { STRICTLY: legacySchema });
                return;
            }
            legacyHandler!(msg);
            return;
        }
        if (protocol === 'v2') {
            v2Handler!(msg);
            return;
        }

        // ── Handshake: detect protocol from first message ──

        if (isLegacyStrictRequest(msg)) {
            protocol = 'legacy';
            if (debug) console.log('[RPC-AUTO-DETECT] Protocol detected: legacy (___STRICTLY)');
            onProtocolDetect?.('legacy');
            initLegacy();
            socket.emit(key, { STRICTLY: legacySchema });
            return;
        }

        if (isLegacyMessage(msg)) {
            protocol = 'legacy';
            if (debug) console.log('[RPC-AUTO-DETECT] Protocol detected: legacy (mapId message)');
            onProtocolDetect?.('legacy');
            initLegacy();
            legacyHandler!(msg);
            return;
        }

        if (isV2Message(msg)) {
            protocol = 'v2';
            if (debug) console.log('[RPC-AUTO-DETECT] Protocol detected: v2');
            onProtocolDetect?.('v2');
            initV2();
            v2Handler!(msg);
            return;
        }

        // Unknown format
        if (debug) console.warn('[RPC-AUTO-DETECT] Unknown message format, ignoring:', msg);
    }
    activeHandler = handleMessage;
    socket.on(key, (msg: any) => activeHandler?.(msg));

    // reset() — clear detection latch (reconnect: new peer may speak different protocol, old
    // protocol value would latch forever, misrouting). dispose() — detach (router
    // inert) + reset. SocketTmpl no off, so null delegate; lazy inner servers
    // have no separate teardown, but stopping incoming dispatch — that's the leak that matters.
    function reset() { unsubscribeAllActive(); protocol = null; legacyHandler = null; v2Handler = null; }
    function dispose(reason?: string) {
        if (disposed) return;
        disposed = true;
        activeHandler = null;
        reset();
        if (debug) console.log('[RPC-AUTO-DETECT] disposed', reason ?? '');
    }

    return {
        getProtocol: () => protocol,
        getLegacySchema: () => legacySchema,
        getResolved: () => resolved,
        dispose,
        reset,
    };
}
