export declare const Caps: {
    readonly COMPACT: number;
    readonly CB_BATCH: number;
    readonly BINARY: number;
    readonly BINARY_SCHEMA: number;
};
export type tCaps = number;
export declare const CAPS_ALL: tCaps;
export declare const RPC_BINARY_MAX_SHAPES = 1000;
export declare const RPC_BINARY_MAX_SCHEMAS = 1000;
export declare const RPC_BINARY_DEFAULT_PROMOTION_THRESHOLD = 3;
export declare const hasCap: (caps: tCaps, c: number) => boolean;
export type RpcOpt = {
    compact?: boolean;
    callbackBatch?: boolean | {
        maxItems?: number;
        maxBytes?: number;
    };
    binary?: boolean | {
        schema?: boolean;
        maxShapes?: number;
        maxSchemas?: number;
        promotionThreshold?: number;
        predeclared?: readonly unknown[];
    };
};
export declare function optToCaps(opt?: RpcOpt): tCaps;
export declare function rpcBinarySchemaOptions(opt?: RpcOpt): {
    maxSchemas: number;
    promotionThreshold: number;
    predeclared: readonly unknown[];
};
export declare function rpcBinaryMaxShapes(opt?: RpcOpt): number;
