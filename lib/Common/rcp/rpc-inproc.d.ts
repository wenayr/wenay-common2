import { type RpcLimits, type RpcServerAuth, type RpcOpt } from './rpc-server';
import type { SocketTmpl } from './rpc-protocol';
import type { DeepSocketListen } from './listen-deep';
export declare function createInProcSocketPair(): [SocketTmpl, SocketTmpl];
export declare function createLoopbackSocketPair(opts?: {
    delivery?: 'micro' | 'sync';
}): {
    client: SocketTmpl;
    server: SocketTmpl;
    kill: () => boolean;
    setOnline(value: boolean): void;
    online: () => boolean;
};
export declare function createRpcInProc<T extends object>({ object: target, socketKey, listen, debug, hooks, limits, auth, token, throttle, maxPerListen, opt, }: {
    object: T;
    socketKey?: string;
    listen?: boolean;
    debug?: boolean;
    hooks?: any;
    limits?: RpcLimits;
    auth?: RpcServerAuth;
    token?: any;
    throttle?: number;
    maxPerListen?: number;
    opt?: RpcOpt;
}): import("./rpc-client").RpcClientReturn<DeepSocketListen<T>>;
