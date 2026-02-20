import { isListenCallback, funcListenCallbackBase } from "./Listen";
import {listenSocket, DeepSocketListen, deepListenFirst, deepListenAll, deepListenSmart} from "./ListenBySocket2";
import {
    CreatAPIFacadeServer2,
    type PromiseServerHooks,
    type ClientAPI, SocketTmpl,
    type RpcLimits,
} from "./commonsServerMini2";

type ListenCallbackBase<T extends any[] = any[]> = ReturnType<typeof funcListenCallbackBase<T>>;

export function CreatAPIFacadeServerAuto2<T extends object>({ socket, object: target, socketKey: key, debug, hooks, disconnectListen, limits }: {
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
    CreatAPIFacadeServer2({
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



type ClientAutoOptions = {
    /** Режим маппинга подписок: smart (по умолчанию), first, all */
    readonly mode?: "smart" | "first" | "all";
    /** Проверка статуса соединения */
    readonly status?: () => boolean;
    /** Подписка на закрытие (для авто-отписки) */
    readonly addListenClose?: ReturnType<typeof funcListenCallbackBase<any>>;
};

// ── Тип результата: рекурсивно заменяет Listen → SocketListen ───

export type ClientAuto2Result<T> = DeepSocketListen<T>;

// ── Фабрика клиентского фасада ──────────────────────────────────

export function CreatAPIFacadeClientAuto2<T>(
    api: T,
    options?: ClientAutoOptions,
): ClientAuto2Result<T> {
    const { mode = "smart", status, addListenClose } = options ?? {};

    const listenOptions = {
        ...(status ? { status } : {}),
        ...(addListenClose ? { addListenClose } : {}),
    };

    switch (mode) {
        case "first":
            return deepListenFirst(api, listenOptions) as ClientAuto2Result<T>;
        case "all":
            return deepListenAll(api, listenOptions) as ClientAuto2Result<T>;
        case "smart":
        default:
            return deepListenSmart(api, listenOptions) as ClientAuto2Result<T>;
    }
}

export type AutoClientAPI<T> = ClientAPI<DeepSocketListen<T>>;

