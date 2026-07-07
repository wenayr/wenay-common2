import { createListen } from "../events/Listen";
import { deepListenFirst, deepListenAll, deepListenSmart } from "./listen-deep";
import type { DeepSocketListen } from "./listen-deep";
import type { ClientAPIStrict } from "./rpc-client";

type ClientAutoOptions = {
    readonly mode?: "smart" | "first" | "all";
    readonly status?: () => boolean;
    readonly closeOn?: ReturnType<typeof createListen<any>>;
};

export type ClientAutoResult<T> = DeepSocketListen<T>;
export type AutoClientAPI<T> = ClientAPIStrict<DeepSocketListen<T>>;

export function createRpcClientAuto<T>(
    api: T,
    options?: ClientAutoOptions,
): ClientAutoResult<T> {
    const { mode = "smart", status } = options ?? {};
    const closeOn = options?.closeOn;

    const listenOptions = {
        ...(status ? { status } : {}),
        ...(closeOn ? { closeOn } : {}),
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
