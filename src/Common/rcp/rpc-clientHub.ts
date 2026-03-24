import {SocketTmpl} from "./rpc-protocol";
import {createRpcClient} from "./rpc-client";
import {DeepSocketListen, DeepSocketListenSmart} from "./listen-deep";

export interface RpcHubSocket extends SocketTmpl {
    disconnect?: () => void;
}

export type RpcDescriptor<T extends object> = {
    socketKey?: string;
    __type?: T;
};

export function rpc<T extends object>(socketKey?: string): RpcDescriptor<T> {
    return { socketKey };
}

type RpcClientResult<T extends object> = ReturnType<typeof createRpcClient<DeepSocketListenSmart<T>>>;

export function createRpcClientHub<T extends Record<string, RpcDescriptor<any>>, T2 extends RpcHubSocket>(
    createSocket: (token: string | null) => T2,
    schemaBuilder: (helper: typeof rpc) => T,
) {
    const schema = schemaBuilder(rpc);

    type SchemaTypes = {
        [K in keyof T]: T[K] extends RpcDescriptor<infer U extends object>
            ? RpcClientResult<U>
            : never;
    };

    type FacadeClients = { [K in keyof SchemaTypes]: SchemaTypes[K]  };

    const facade = {} as FacadeClients;
    // for (const key in schema) {
    //     facade[key] = null;
    // }

    let socket: RpcHubSocket | null = null;
    let connectCount = 0;
    let onConnectCb: ((count: number) => void) | null = null;
    let resolveFunc: ((facade: FacadeClients) => void)|null = null;
    let promise = new Promise<FacadeClients>((resolve) => {
        resolveFunc = resolve;
    })
    function setToken(token: string | null) {
        socket?.disconnect?.();
        socket = createSocket(token);


        for (const key in schema) {
            const targetSocketKey = schema[key].socketKey || key;
            const client = createRpcClient<any>({ socketKey: targetSocketKey, socket });
            facade[key] = client as FacadeClients[typeof key];
        }
        // порядок инициализации
        function hi(){
            for (const key in schema) {
                const client = facade[key]
                if (client && typeof client.initStrict === "function") {
                    client.initStrict();
                }
            }
        }

        socket?.on("connect", () => {
            connectCount++;
            hi()
            onConnectCb?.(connectCount);
            if (resolveFunc) {
                const a = resolveFunc;
                resolveFunc = null;
                a(facade);
            }
        });
        return promise
    }

    const result = {
        get promise() { return promise; },
        facade,
        setToken,
        get socket() { return socket as T2; },
        onConnect: (func?: ((count: number) => void) | null) => { onConnectCb = func ?? null; },
        connectCount: () => connectCount,
    };

    return result;
}