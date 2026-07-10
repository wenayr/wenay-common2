import { createListen } from "../events/Listen";
import type { DeepSocketListen } from "./listen-deep";
import type { ClientAPIStrict } from "./rpc-client";
type ClientAutoOptions = {
    readonly mode?: "smart" | "first" | "all";
    readonly status?: () => boolean;
    readonly closeOn?: ReturnType<typeof createListen<any>>;
};
export type ClientAutoResult<T> = DeepSocketListen<T>;
export type AutoClientAPI<T> = ClientAPIStrict<DeepSocketListen<T>>;
export declare function createRpcClientAuto<T>(api: T, options?: ClientAutoOptions): ClientAutoResult<T>;
export {};
