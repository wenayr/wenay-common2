import { createListen } from "../events/Listen";
import { type PromiseServerHooks, type RpcLimits, type RpcServerAuth, type RpcOpt } from "./rpc-server";
import { DeepSocketListen } from "./listen-deep";
import { SocketTmpl } from "./rpc-protocol";
type ListenCallbackBase<T extends any[] = any[]> = ReturnType<typeof createListen<T>>;
export type RpcReplayOpts = {
    pending?: () => number;
    highWater?: number;
    lowWater?: number;
    pollMs?: number;
};
export declare function createRpcServerAuto<T extends object>({ socket, object: target, socketKey: key, debug, hooks, disconnectListen, limits, auth, maxPerListen, throttle, opt, replay, replayOpts }: {
    socket: SocketTmpl;
    object: T;
    socketKey: string;
    debug?: boolean;
    hooks?: Omit<PromiseServerHooks<DeepSocketListen<T>>, "resolveTransform">;
    disconnectListen?: ListenCallbackBase<any>;
    limits?: RpcLimits;
    auth?: RpcServerAuth;
    maxPerListen?: number;
    throttle?: number;
    opt?: RpcOpt;
    replay?: false | "auto" | "force";
    replayOpts?: RpcReplayOpts;
}): {
    control: {
        revoke: (reason?: any) => boolean;
        grant: (grant: import("./rpc-server").RpcAuthGrant) => boolean;
    };
    api: {
        subscriptions: () => {
            key: string;
            consumers: number;
        }[];
    };
};
export {};
