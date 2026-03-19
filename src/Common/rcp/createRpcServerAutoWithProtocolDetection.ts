import { isListenCallback, funcListenCallbackBase } from "../events/Listen";
import { listenSocket } from "./listen-socket";
import { createRpcServer, type PromiseServerHooks, type RpcLimits } from "./rpc-server";
import { DeepSocketListen } from "./listen-deep";
import { Pkt, type SocketTmpl } from "./rpc-protocol";
import { promiseServer } from "./oldСommonsServerMini";
import { isNoStrict } from "./rpc-dynamic";
import { isSafeKey } from "./rpc-limits";

type ListenCallbackBase<T extends any[] = any[]> = ReturnType<typeof funcListenCallbackBase<T>>;

// ── Старая версия (без изменений) ──────────────────────────────────

function createRpcServerAuto<T extends object>({ socket, object: target, socketKey: key, debug, hooks, disconnectListen, limits }: {
    socket: SocketTmpl;
    object: T;
    socketKey: string;
    debug?: boolean;
    hooks?: Omit<PromiseServerHooks<DeepSocketListen<T>>, "resolveTransform">;
    disconnectListen?: ListenCallbackBase<any>;
    limits?: RpcLimits;
}) {
    const cache = new WeakMap<object, ReturnType<typeof listenSocket>>();

    function getListenSocket(parent: any, disconnectListen?: ListenCallbackBase<any>): ReturnType<typeof listenSocket> {
        let result = cache.get(parent);
        if (!result) {
            result = listenSocket(parent, { addListenClose: disconnectListen });
            cache.set(parent, result);
        }
        return result;
    }

    createRpcServer({
        socket, object: target as any, socketKey: key, debug, limits,
        hooks: {
            ...hooks,
            resolveTransform: (obj: any) => {
                if (!isListenCallback(obj)) return obj;
                return getListenSocket(obj, disconnectListen);
            },
        } as any,
    });
}

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
    // ── Общий кэш listenSocket для обоих протоколов ─────────────
    const cache = new WeakMap<object, ReturnType<typeof listenSocket>>();

    function getListenSocket(parent: any): ReturnType<typeof listenSocket> {
        let result = cache.get(parent);
        if (!result) {
            result = listenSocket(parent, { addListenClose: disconnectListen });
            cache.set(parent, result);
        }
        return result;
    }

    /** Общий трансформер: Listen → listenSocket({ callback, removeCallback }) */
    function resolveTransform(obj: any): any {
        if (!isListenCallback(obj)) return obj;
        return getListenSocket(obj);
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
            out[k] = typeof v === 'function' ? v : (v != null && typeof v === 'object') ? transformTree(v) : v;
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

    /** V2 сообщение: Pkt.STRICT (число 4) или массив [Pkt.CALL|PIPE, ...] */
    function isV2Message(msg: any): boolean {
        if (msg === Pkt.STRICT) return true;
        if (Array.isArray(msg) && (msg[0] === Pkt.CALL || msg[0] === Pkt.PIPE)) return true;
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
                resolveTransform,
            } as any,
        });

        v2Handler = (msg: any) => {
            if (!onMsgCb) return;
            onMsgCb(msg);
        };
    }

    // ── Главный обработчик сообщений ────────────────────────────
    socket.on(key, (msg: any) => {
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
    });

    return {
        getProtocol: () => protocol,
        getLegacySchema: () => legacySchema,
        getResolved: () => resolved,
    };
}