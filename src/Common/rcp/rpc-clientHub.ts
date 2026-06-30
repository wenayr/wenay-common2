import {SocketTmpl} from "./rpc-protocol";
import {createRpcClient} from "./rpc-client";
import {DeepSocketListen, DeepSocketListenSmart} from "./listen-deep";
import { type RpcOpt } from "./rpc-caps";

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
    hubOpts?: { opt?: RpcOpt },
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
    let currentToken: string | null = null; // удерживаем для мягкого reauth по живому сокету
    let connectCount = 0;
    let onConnectCb: ((count: number) => void) | null = null;
    let onDisconnectCb: ((reason: string) => void) | null = null;
    let resolveFunc: ((facade: FacadeClients) => void)|null = null;
    let promise = new Promise<FacadeClients>((resolve) => {
        resolveFunc = resolve;
    })
    function setToken(token: string | null) {
        const hadSocket = socket != null;
        socket?.disconnect?.();
        // клиенты прошлого токена: висящие отклоняем, их пакеты игнорируются. Сокет только что
        // разорван → socketAlive:false (wire removeCallback не дойдёт, но потребители подписок
        // всё равно резолвятся — честный teardown без авто-resubscribe).
        for (const key in schema) (facade[key] as { dispose?: (r?: string, o?: { socketAlive?: boolean }) => void } | undefined)?.dispose?.("token rotated", { socketAlive: false });
        // hub-уровень onDisconnect: только при РОТАЦИИ (был прежний сокет), не на первом setToken.
        if (hadSocket) onDisconnectCb?.("token rotated");
        // прошлый promise уже мог резолвиться — ожидающим НОВОГО подключения нужен свежий
        if (!resolveFunc) promise = new Promise<FacadeClients>((resolve) => { resolveFunc = resolve; });
        currentToken = token;
        socket = createSocket(token);

        for (const key in schema) {
            const targetSocketKey = schema[key].socketKey || key;
            // token → клиент предъявит его через Pkt.HELLO в initStrict() на "connect" (см. hi()).
            const client = createRpcClient<any>({ socketKey: targetSocketKey, socket, token, opt: hubOpts?.opt });
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

    // Мягкий re-auth по ЖИВОМУ сокету (БЕЗ дисконнекта/ротации — это работа setToken):
    // каждому клиенту фасада предъявляем новый токен через Pkt.HELLO; подписки сохраняются.
    function reauth(token: string | null) {
        currentToken = token;
        const ps: Promise<any>[] = [];
        for (const key in schema) {
            const client = facade[key] as { reauth?: (t: any) => Promise<any> } | undefined;
            if (client && typeof client.reauth === "function") ps.push(client.reauth(token));
        }
        return Promise.all(ps);
    }

    const result = {
        get promise() { return promise; },
        facade,
        /** @deprecated используй {@link connect} — то же жёсткое (пере)подключение по токену. */
        setToken,
        /** Жёсткое (пере)подключение по токену: рвёт прежний сокет, дренирует фасад, поднимает
         *  новый сокет и переинициализирует клиентов. `connect(null)` — анонимно. Парный к onConnect
         *  (мягкая смена принципала — {@link reauth}). Делегирует в setToken. */
        connect: setToken,
        /** Мягкий re-auth: меняет принципала по живому сокету, не рвёт подписки (vs жёсткий setToken). */
        reauth,
        get socket() { return socket as T2; },
        onConnect: (func?: ((count: number) => void) | null) => { onConnectCb = func ?? null; },
        /** Наблюдать разрыв/ротацию (setToken по живому сокету). Подписки к этому моменту сняты
         *  (честный teardown) — переподписку делай в onConnect. Зеркало onConnect. */
        onDisconnect: (func?: ((reason: string) => void) | null) => { onDisconnectCb = func ?? null; },
        connectCount: () => connectCount,
    };

    return result;
}