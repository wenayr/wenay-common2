import { isListenCallback, funcListenCallbackBase } from "../events/Listen";
import { listenSocket } from "./listen-socket";
import { createRpcServer, type PromiseServerHooks, type RpcLimits } from "./rpc-server";
import { DeepSocketListen } from "./listen-deep";
import { Pkt, type SocketTmpl } from "./rpc-protocol";
import { promiseServer } from "./oldСommonsServerMini";

type ListenCallbackBase<T extends any[] = any[]> = ReturnType<typeof funcListenCallbackBase<T>>;

// ── Старая версия (без изменений) ──────────────────────────────────

export function createRpcServerAuto<T extends object>({ socket, object: target, socketKey: key, debug, hooks, disconnectListen, limits }: {
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
    // Рекурсивно обходим, заменяя ListenCallback на listenSocket-обёртку.
    // Результат используется обоими протоколами.
    function transformTree(obj: any): any {
        if (obj == null || typeof obj === 'function') return obj;
        if (typeof obj !== 'object') return obj;
        const transformed = resolveTransform(obj);
        if (transformed !== obj) return transformed;
        const out: any = {};
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (typeof v === 'function') out[k] = v;
            else if (v != null && typeof v === 'object') out[k] = transformTree(v);
            else out[k] = v;
        }
        return out;
    }

    // ── Сериализация схемы ──────────────────────────────────────
    // Legacy использует как { STRICTLY: schema }
    // V2 — createRpcServer сам строит свою serialize, но для legacy нам нужна отдельная
    function serialize(obj: any): any {
        const out: any = {};
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (v == null) out[k] = 'null';
            else if (typeof v === 'function') out[k] = 'func';
            else if (typeof v === 'object') out[k] = serialize(v);
            else out[k] = 'unknown';
        }
        return out;
    }

    // resolved — дерево с Listen заменёнными на { callback, removeCallback }
    const resolved = transformTree(target);
    // strictSchema — сериализованная схема для legacy клиента
    const legacySchema = serialize(resolved);

    // ── Определение протокола ───────────────────────────────────
    let protocol: ClientProtocol = null;
    let v2Handler: ((msg: any) => void) | null = null;
    let legacyHandler: ((msg: any) => void) | null = null;

    /** Legacy клиент запрашивает схему строкой "___STRICTLY" */
    function isLegacyStrictRequest(msg: any): boolean {
        return msg === '___STRICTLY';
    }

    /** Legacy сообщение: plain object с { mapId: number, data | error } */
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
        if (msg === Pkt.STRICT) return true;                           // число 4
        if (Array.isArray(msg) && (msg[0] === Pkt.CALL || msg[0] === Pkt.PIPE)) return true;
        return false;
    }

    // ── Инициализация Legacy сервера (лениво) ───────────────────
    // promiseServer принимает ScreenerSoc с sendMessage/api.
    // Мы подставляем свои: emit → sendMessage, захватываем onMessage.
    // promiseServer работает с `resolved` — уже трансформированным деревом.
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
    // Создаём "виртуальный" сокет, чтобы перехватить handler из createRpcServer.
    // createServer при инициализации делает send([Pkt.MAP, routeMap, strictSchema]) —
    // это уйдёт клиенту через socket.emit, что корректно (v2 клиент уже подключён).
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

        // 1) Legacy: запрос схемы
        if (isLegacyStrictRequest(msg)) {
            protocol = 'legacy';
            if (debug) console.log('[RPC-AUTO2] Protocol detected: legacy (___STRICTLY)');
            onProtocolDetect?.('legacy');
            initLegacy();
            socket.emit(key, { STRICTLY: legacySchema });
            return;
        }

        // 2) Legacy: обычный вызов (клиент может не запрашивать strictly)
        if (isLegacyMessage(msg)) {
            protocol = 'legacy';
            if (debug) console.log('[RPC-AUTO2] Protocol detected: legacy (mapId message)');
            onProtocolDetect?.('legacy');
            initLegacy();
            legacyHandler!(msg);
            return;
        }

        // 3) V2: STRICT / CALL / PIPE
        if (isV2Message(msg)) {
            protocol = 'v2';
            if (debug) console.log('[RPC-AUTO2] Protocol detected: v2');
            onProtocolDetect?.('v2');
            initV2();
            // initV2 → createRpcServer → createServer уже отправил [Pkt.MAP, ...]
            // Теперь прокидываем первое сообщение
            v2Handler!(msg);
            return;
        }

        // Неизвестный формат
        if (debug) console.warn('[RPC-AUTO2] Unknown message format, ignoring:', msg);
    });

    return {
        /** Какой протокол определён (null — ещё не было сообщений) */
        getProtocol: () => protocol,
        /** Схема для legacy */
        getLegacySchema: () => legacySchema,
        /** Трансформированное дерево */
        getResolved: () => resolved,
    };
}
