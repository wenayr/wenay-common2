import { isListenCallback, funcListenCallbackBase, isListenOn, getListenByOn } from "../events/Listen";
import { listenSocket } from "./listen-socket";
import { createRpcServer, type PromiseServerHooks, type RpcLimits } from "./rpc-server";
import { DeepSocketListen } from "./listen-deep";
import { Pkt, type SocketTmpl } from "./rpc-protocol";
import { promiseServer } from "./oldСommonsServerMini";
import { isNoStrict } from "./rpc-dynamic";
import { isSafeKey } from "./rpc-limits";

type ListenCallbackBase<T extends any[] = any[]> = ReturnType<typeof funcListenCallbackBase<T>>;

// ── Новая версия с совместимостью ───────────────────────────────────
//
// Определение протокола:
//   Legacy клиент первым сообщением шлёт "___STRICTLY" (строка) или { mapId, data } (объект)
//   V2 клиент первым сообщением шлёт Pkt.STRICT (число 4) или [Pkt.CALL, ...] (массив)
//
// Форматы НЕ пересекаются:
//   "___STRICTLY" — строка (только legacy)
//   { mapId, data } — plain object (только legacy)
//   4              — число (только v2)
//   [0, ...]       — массив (только v2)
//

type ClientProtocol = 'v2' | 'legacy' | null;

export function createRpcServerAuto2<T extends object>({
                                                           socket,
                                                           object: target,
                                                           socketKey: key,
                                                           debug = false,
                                                           hooks,
                                                           disconnectListen,
                                                           limits,
                                                           onProtocolDetect,
                                                       }: {
    socket: SocketTmpl;
    object: T;
    socketKey: string;
    debug?: boolean;
    hooks?: Omit<PromiseServerHooks<DeepSocketListen<T>>, "resolveTransform">;
    disconnectListen?: ListenCallbackBase<any>;
    limits?: RpcLimits;
    onProtocolDetect?: (protocol: 'v2' | 'legacy') => void;
}) {
    // ── Общий кэш Listen-мультиплексоров для обоих протоколов ─────────────
    const cache = new WeakMap<object, ReturnType<typeof listenSocket>>();
    const listenSockets = new Set<ReturnType<typeof listenSocket>>();
    function unsubscribeAllActive() {
        for (const w of [...listenSockets]) w.removeCallback();
    }

    function getListenSocket(parent: any): ReturnType<typeof listenSocket> {
        let result = cache.get(parent);
        if (result) listenSockets.add(result);
        if (!result) {
            const subs = new Map<Function, ReturnType<typeof listenSocket>>();
            function subscribe(z: any) {
                if (typeof z !== "function") return Promise.reject(new TypeError("Listen callback expects a function"));
                subs.get(z)?.removeCallback();
                const w = listenSocket(parent, { addListenClose: disconnectListen });
                subs.set(z, w);
                const done = w.callback(z);
                done.then(() => { if (subs.get(z) == w) subs.delete(z); });
                return done;
            }
            function subscribeOnce(z: any) {
                if (typeof z !== "function") return Promise.reject(new TypeError("Listen once expects a function"));
                subs.get(z)?.removeCallback();
                const w = listenSocket(parent, { addListenClose: disconnectListen });
                subs.set(z, w);
                const done = w.once(z);
                done.then(() => { if (subs.get(z) == w) subs.delete(z); });
                return done;
            }
            function unsubscribeAll() {
                subs.forEach(w => w.removeCallback());
                subs.clear();
                return true;
            }
            result = { callback: subscribe, removeCallback: unsubscribeAll, on: subscribe, once: subscribeOnce, close: () => (parent as any).close?.() } as ReturnType<typeof listenSocket>;
            listenSockets.add(result);
            cache.set(parent, result);
        }
        return result;
    }

    /** Общий трансформер: Listen → listenSocket({ callback, removeCallback }) */
    function resolveTransform(obj: any): any {
        if (isListenCallback(obj)) return getListenSocket(obj);
        if (isListenOn(obj)) return getListenSocket(getListenByOn(obj)); // bare `on` → Listen-обёртка по реестру
        return obj;
    }

    // ── Трансформация дерева объекта (Listen → listenSocket) ─────
    // Повторяет логику transformTree из rpc-server.ts:
    // - isNoStrict объекты пропускаются как есть
    // - isSafeKey фильтрует ключи
    // - resolveTransform применяется к каждому узлу
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

    // ── Сериализация схемы (повторяет логику serialize из rpc-server.ts) ──
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

    // resolved — дерево с Listen заменёнными на { callback, removeCallback }
    const resolved = transformTree(target);
    // legacySchema — сериализованная схема для legacy клиента
    const legacySchema = serialize(resolved);

    // ── Определение протокола ───────────────────────────────────
    let protocol: ClientProtocol = null;
    let v2Handler: ((msg: any) => void) | null = null;
    let legacyHandler: ((msg: any) => void) | null = null;
    let disposed = false;
    let activeHandler: ((msg: any) => void) | null = null; // делегат стабильного роутера; null = инертен

    /** Legacy клиент запрашивает схему строкой "___STRICTLY" */
    function isLegacyStrictRequest(msg: any): boolean {
        return msg === '___STRICTLY';
    }

    /** Legacy сообщение: plain object с { mapId: number } */
    function isLegacyMessage(msg: any): boolean {
        return (
            typeof msg === 'object' &&
            msg !== null &&
            !Array.isArray(msg) &&
            typeof msg.mapId === 'number'
        );
    }

    /** V2 сообщение: Pkt.STRICT (число 4) или массив [Pkt.CALL|PIPE|HELLO, ...].
     *  HELLO — токен-клиент шлёт его ПЕРВЫМ (in-band auth); без него детектор ронял бы HELLO,
     *  и auth() клиента висел бы. Внутренний createRpcServer обрабатывает HELLO сам. */
    function isV2Message(msg: any): boolean {
        if (msg === Pkt.STRICT) return true;
        if (Array.isArray(msg) && (msg[0] === Pkt.CALL || msg[0] === Pkt.PIPE || msg[0] === Pkt.HELLO)) return true;
        return false;
    }

    // ── Инициализация Legacy сервера (лениво) ───────────────────
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

    // ── Инициализация V2 сервера (лениво) ───────────────────────
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

    // ── Главный обработчик сообщений ────────────────────────────
    // SocketTmpl не умеет off → регистрируем ОДИН стабильный роутер, делегирующий в activeHandler;
    // dispose() обнуляет activeHandler → роутер становится инертным (идиома rpc-server.ts:26-29).
    function handleMessage(msg: any) {
        if (debug) {
            console.log('[RPC-AUTO2 IN]', typeof msg === 'object' ? JSON.stringify(msg) : msg);
        }

        // ── Быстрый путь: протокол уже определён ───────────────
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

        // ── Рукопожатие: определяем протокол по первому сообщению ──

        if (isLegacyStrictRequest(msg)) {
            protocol = 'legacy';
            if (debug) console.log('[RPC-AUTO2] Protocol detected: legacy (___STRICTLY)');
            onProtocolDetect?.('legacy');
            initLegacy();
            socket.emit(key, { STRICTLY: legacySchema });
            return;
        }

        if (isLegacyMessage(msg)) {
            protocol = 'legacy';
            if (debug) console.log('[RPC-AUTO2] Protocol detected: legacy (mapId message)');
            onProtocolDetect?.('legacy');
            initLegacy();
            legacyHandler!(msg);
            return;
        }

        if (isV2Message(msg)) {
            protocol = 'v2';
            if (debug) console.log('[RPC-AUTO2] Protocol detected: v2');
            onProtocolDetect?.('v2');
            initV2();
            v2Handler!(msg);
            return;
        }

        // Неизвестный формат
        if (debug) console.warn('[RPC-AUTO2] Unknown message format, ignoring:', msg);
    }
    activeHandler = handleMessage;
    socket.on(key, (msg: any) => activeHandler?.(msg));

    // reset() — сбросить латч детекции (reconnect: новый пир может говорить иным протоколом, и
    // прежнее значение protocol латчилось бы навсегда, мисроутя). dispose() — отцепить (роутер
    // инертен) + сброс. SocketTmpl без off, поэтому обнуляем делегата; ленивые внутренние серверы
    // отдельного teardown не имеют, но остановка входящей диспетчеризации — та утечка, что важна.
    function reset() { unsubscribeAllActive(); protocol = null; legacyHandler = null; v2Handler = null; }
    function dispose(reason?: string) {
        if (disposed) return;
        disposed = true;
        activeHandler = null;
        reset();
        if (debug) console.log('[RPC-AUTO2] disposed', reason ?? '');
    }

    return {
        getProtocol: () => protocol,
        getLegacySchema: () => legacySchema,
        getResolved: () => resolved,
        dispose,
        reset,
    };
}
