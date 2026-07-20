import { createListen, type Listener } from "../events/Listen";
import { type Off } from "./rpc-off";
type ListenCallbackResult<T extends any[] = any[]> = ReturnType<typeof createListen<T>>;
export type SubscriptionHandle = Off<void, {
    off: () => void;
    unsubscribe: () => void;
    removeCallback: () => void;
}>;
export type RpcListenSubscribeOpts = {
    current?: boolean;
};
export declare function listenSocket<Z extends any[] = any[]>(e: ListenCallbackResult<Z>, d?: {
    readonly status?: () => boolean;
    readonly closeOn?: ListenCallbackResult<any>;
    readonly stop?: (x: Listener<Z>) => any;
    readonly paramsModify?: (...e: Z) => any[];
    readonly throttle?: number;
}): {
    on: (z: Listener<Z>, opts?: RpcListenSubscribeOpts) => Promise<void>;
    off: () => boolean;
    callback: (z: Listener<Z>, opts?: RpcListenSubscribeOpts) => Promise<void>;
    removeCallback: () => boolean;
    once: (z: Listener<Z>, opts?: RpcListenSubscribeOpts) => Promise<void>;
    close: () => void;
};
export declare function listenSocketFirst<Z extends any[] = any[]>(e: ListenCallbackResult<Z>, options?: Omit<Parameters<typeof listenSocket>[1], "paramsModify">): {
    callback: (z: (a: Z[0]) => void, opts?: RpcListenSubscribeOpts) => SubscriptionHandle;
    on: (z: (a: Z[0]) => void, opts?: RpcListenSubscribeOpts) => SubscriptionHandle;
    once: (z: (a: Z[0]) => void, opts?: RpcListenSubscribeOpts) => SubscriptionHandle;
    close: () => void;
    off: () => boolean;
    removeCallback: () => boolean;
};
export declare function listenSocketAll<Z extends any[] = any[]>(e: ListenCallbackResult<Z>, options?: Omit<Parameters<typeof listenSocket>[1], "paramsModify">): {
    callback: (z: (...args: Z) => void, opts?: RpcListenSubscribeOpts) => SubscriptionHandle;
    on: (z: (...args: Z) => void, opts?: RpcListenSubscribeOpts) => SubscriptionHandle;
    once: (z: (...args: Z) => void, opts?: RpcListenSubscribeOpts) => SubscriptionHandle;
    close: () => void;
    off: () => boolean;
    removeCallback: () => boolean;
};
type SmartCallback<Z extends any[]> = Z extends [infer Single] ? (a: Single) => void : (...args: Z) => void;
export declare function listenSocketSmart<Z extends any[] = any[]>(e: ListenCallbackResult<Z>, options?: Omit<Parameters<typeof listenSocket>[1], "paramsModify">): {
    callback: (z: SmartCallback<Z>, opts?: RpcListenSubscribeOpts) => SubscriptionHandle;
    on: (z: SmartCallback<Z>, opts?: RpcListenSubscribeOpts) => SubscriptionHandle;
    once: (z: SmartCallback<Z>, opts?: RpcListenSubscribeOpts) => SubscriptionHandle;
    close: () => void;
    off: () => boolean;
    removeCallback: () => boolean;
};
export {};
