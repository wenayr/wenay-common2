import type { io, Socket, ManagerOptions, SocketOptions } from "socket.io-client";
import {createRpcClientAuto} from "./rpc-client-auto";

const DEFAULT_SOCKET_OPTIONS: Partial<ManagerOptions & SocketOptions> = {
    transports: ['websocket'],
    forceNew: true,
    timeout: 90000,
};

export interface ApiFacadeConfig {
    io: typeof io;
    url: string | (() => string);
    socketOptions?: Partial<ManagerOptions & SocketOptions>;
}

// Утилита-маркер скрыта внутри модуля, наружу не экспортируется
function rpcHelper<T extends object>(socketKey?: string) {
    return { socketKey };
}

export function createRpcClientHub<T extends Record<string, ReturnType<typeof rpcHelper>>>(
    config: ApiFacadeConfig,
    schemaBuilder: (rpc: typeof rpcHelper) => T // Принимаем функцию-билдер
) {
    // Вызываем билдер, передавая ему наш хелпер, чтобы получить итоговую схему
    const schema = schemaBuilder(rpcHelper);

    // Вытаскиваем типы из схемы
    type SchemaTypes = {
        [K in keyof T]: T[K] extends ReturnType<typeof rpcHelper<infer U extends object>>
            ? ReturnType<typeof createRpcClientAuto<U>>
            : never;
    };

    type FacadeClients = { [K in keyof SchemaTypes]: SchemaTypes[K] | null };

    const facade = {} as FacadeClients;
    for (const key in schema) {
        facade[key] = null;
    }

    let socket: Socket | null = null;
    let connectCount = 0;
    let onConnectCb: ((count: number) => void) | null = null;

    function setToken(token: string | null) {
        socket?.disconnect();

        const targetUrl = typeof config.url === 'function' ? config.url() : config.url;
        const baseQuery = config.socketOptions?.query || {};
        const query = token ? { ...baseQuery, token } : baseQuery;

        socket = config.io(targetUrl, {
            ...DEFAULT_SOCKET_OPTIONS,
            ...config.socketOptions,
            query,
        });

        for (const key in schema) {
            const targetSocketKey = schema[key].socketKey || key;

            const client = createRpcClientAuto<any>({ socketKey: targetSocketKey, socket });
            facade[key] = client as any;

            if (client && typeof client['initStrict'] === 'function') {
                client['initStrict']();
            }
        }

        socket.on('connect', () => {
            connectCount++;
            onConnectCb?.(connectCount);
        });
    }

    return {
        facade,
        setToken,
        onConnect: (func?: ((count: number) => void) | null) => { onConnectCb = func ?? null; },
        connectCount: () => connectCount,
    };
}
