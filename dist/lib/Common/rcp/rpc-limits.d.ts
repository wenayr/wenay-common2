export declare const isSafeKey: (k: string) => boolean;
export type RpcLimits = {
    maxDepth?: number;
    maxKeys?: number;
    maxArgs?: number;
    maxArrayLen?: number;
    maxStringLen?: number;
    maxCallbacks?: number;
    maxPathLen?: number;
    maxBinaryLen?: number;
};
export declare const resolveLimits: (opts?: RpcLimits) => Required<RpcLimits>;
export declare class PayloadLimitError extends Error {
    constructor(reason: string);
}
