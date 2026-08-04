import { MyError } from '../../toError/myThrow';
export type RpcFlowOpts = {
    window?: number;
    ackEvery?: number;
    pending?: () => number;
    highWater?: number;
    lowWater?: number;
    pollMs?: number;
};
export type tRpcFlowGate = {
    wait: () => Promise<void>;
    pending: () => number;
    closedReason: () => string | null;
};
type tRpcFlowOpen = (opts?: RpcFlowOpts) => tRpcFlowGate;
export declare function registerRpcFlowHost(cb: Function, open: tRpcFlowOpen): void;
export declare function rpcFlowClosedError(reason: string): MyError<unknown>;
export type RpcFlow<A extends any[] = any[]> = {
    push: (...args: A) => Promise<void>;
    pending: () => number;
    closed: () => boolean;
};
export declare function flowCallback<A extends any[]>(cb: (...args: A) => any, opts?: RpcFlowOpts): RpcFlow<A>;
export {};
