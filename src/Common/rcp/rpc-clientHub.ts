import {SocketTmpl} from "./rpc-protocol";
import {createRpcClientAuto} from "./rpc-client-auto";

export interface RpcHubSocket extends SocketTmpl {
    disconnect?: () => void;
}

export function rpc<T extends object>(socketKey?: string) {
    return { socketKey };
}

export function createRpcClientHub<T extends Record<string, ReturnType<typeof rpc<any>>>>(
    createSocket: (token: string | null) => RpcHubSocket,
    schemaBuilder: (helper: typeof rpc) => T
) {
    const schema = schemaBuilder(rpc);

    type SchemaTypes = {
        [K in keyof T]: T[K] extends ReturnType<typeof rpc<infer U extends object>>
            ? ReturnType<typeof createRpcClientAuto<U>>
            : never;
    };

    type FacadeClients = { [K in keyof SchemaTypes]: SchemaTypes[K] | null };

    const facade = {} as FacadeClients;
    for (const key in schema) {
        facade[key] = null;
    }

    let socket: RpcHubSocket | null = null;
    let connectCount = 0;
    let onConnectCb: ((count: number) => void) | null = null;

    function setToken(token: string | null) {
        // Если сокет уже был, отключаем его
        socket?.disconnect?.();

        // Делегируем создание сокета пользовательскому коду
        socket = createSocket(token);

        for (const key in schema) {
            const targetSocketKey = schema[key].socketKey || key;

            const client = createRpcClientAuto<any>({ socketKey: targetSocketKey, socket });
            facade[key] = client as any;

            if (client && typeof client['initStrict'] === 'function') {
                client['initStrict']();
            }
        }

        // Подписываемся на connect. 
        // Важно: Socket.IO шлет 'connect', мы просто полагаемся, что пользовательский сокет это поддерживает.
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