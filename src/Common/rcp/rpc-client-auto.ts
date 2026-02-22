import { funcListenCallbackBase } from "../events/Listen";
import { deepListenFirst, deepListenAll, deepListenSmart } from "./listen-deep";
import type { DeepSocketListen } from "./listen-deep";
import type { ClientAPI } from "./rpc-client";

type ClientAutoOptions = {
    readonly mode?: "smart" | "first" | "all";
    readonly status?: () => boolean;
    readonly addListenClose?: ReturnType<typeof funcListenCallbackBase<any>>;
};

export type ClientAutoResult<T> = DeepSocketListen<T>;
export type AutoClientAPI<T> = ClientAPI<DeepSocketListen<T>>;

export function createRpcClientAuto<T>(
    api: T,
    options?: ClientAutoOptions,
): ClientAutoResult<T> {
    const { mode = "smart", status, addListenClose } = options ?? {};

    const listenOptions = {
        ...(status ? { status } : {}),
        ...(addListenClose ? { addListenClose } : {}),
    };

    switch (mode) {
        case "first":
            return deepListenFirst(api, listenOptions) as ClientAutoResult<T>;
        case "all":
            return deepListenAll(api, listenOptions) as ClientAutoResult<T>;
        case "smart":
        default:
            return deepListenSmart(api, listenOptions) as ClientAutoResult<T>;
    }
}
