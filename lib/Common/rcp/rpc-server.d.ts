import { type RpcLimits } from "./rpc-limits";
import { type SocketTmpl } from "./rpc-protocol";
import { type RpcOpt } from './rpc-caps';
type Func = (...args: any[]) => any;
type PromiseServerHooks<T> = {
    onRequest?: (ctx: {
        key: string[];
        request: any[];
        fnName: string;
        fn: Func;
    }) => boolean | Promise<boolean>;
    onInvalid?: (ctx: {
        reason: "invalid_payload" | "not_function" | "resolve_error" | "rate_limit";
        key?: any;
        request?: any;
        error?: any;
    }) => void | Promise<void>;
    resolveTransform?: (value: any) => any;
    onDispose?: () => void;
};
type RpcServerAuth = {
    resolveAuth: (token: any) => {
        object?: any;
        ack?: any;
    } | Promise<{
        object?: any;
        ack?: any;
    }>;
    gate?: boolean;
};
export declare function createRpcServer<T extends object>({ socket, object: target, socketKey: key, debug, hooks, limits, auth, opt }: {
    socket: SocketTmpl;
    object: T;
    socketKey: string;
    debug?: boolean;
    hooks?: PromiseServerHooks<T>;
    limits?: RpcLimits;
    auth?: RpcServerAuth;
    opt?: RpcOpt;
}): void;
export type { PromiseServerHooks, RpcLimits, RpcServerAuth };
export type { RpcOpt } from "./rpc-caps";
