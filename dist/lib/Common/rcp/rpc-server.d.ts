import { type RpcLimits } from "./rpc-limits";
import { type SocketTmpl } from "./rpc-protocol";
import { type RpcOpt } from './rpc-caps';
type Func = (...args: any[]) => any;
type RpcPrincipalChange = {
    keep: ReadonlySet<object>;
    drop: ReadonlySet<object>;
};
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
    onPrincipalChange?: (ctx: RpcPrincipalChange) => void;
    onDispose?: () => void;
};
type RpcAuthGrant = {
    object?: any;
    ack?: any;
    expiresAt?: number;
    renewBeforeMs?: number;
};
type RpcServerAuth = {
    resolveAuth: (token: any) => RpcAuthGrant | Promise<RpcAuthGrant>;
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
}): {
    control: {
        revoke: (reason?: any) => boolean;
        grant: (grant: RpcAuthGrant) => boolean;
    };
};
export type RpcServerControl = ReturnType<typeof createRpcServer>['control'];
export type { PromiseServerHooks, RpcLimits, RpcServerAuth, RpcAuthGrant, RpcPrincipalChange };
export type { RpcOpt } from "./rpc-caps";
