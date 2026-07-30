export declare const Caps: {
    readonly COMPACT: number;
    readonly CB_BATCH: number;
    readonly AUTH_STATE: number;
    readonly HELLO_ID: number;
    readonly REQ_BATCH: number;
    readonly ROWS: number;
};
export type tCaps = number;
export declare const CAPS_ALL: tCaps;
export declare const hasCap: (caps: tCaps, c: number) => boolean;
export type RpcBatchOpt = boolean | {
    maxItems?: number;
    maxBytes?: number;
};
export type RpcOpt = {
    compact?: boolean;
    callbackBatch?: RpcBatchOpt;
    requestBatch?: RpcBatchOpt;
    compactRows?: boolean;
    authState?: boolean;
    helloId?: boolean;
};
export declare function optToCaps(opt?: RpcOpt): tCaps;
