export declare const Caps: {
    readonly COMPACT: number;
    readonly CB_BATCH: number;
};
export type tCaps = number;
export declare const CAPS_ALL: tCaps;
export declare const hasCap: (caps: tCaps, c: number) => boolean;
export type RpcOpt = {
    compact?: boolean;
    callbackBatch?: boolean | {
        maxItems?: number;
        maxBytes?: number;
    };
};
export declare function optToCaps(opt?: RpcOpt): tCaps;
