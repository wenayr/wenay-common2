export declare const Caps: {
    readonly COMPACT: number;
};
export type tCaps = number;
export declare const CAPS_ALL: tCaps;
export declare const hasCap: (caps: tCaps, c: number) => boolean;
export type RpcOpt = {
    compact?: boolean;
};
export declare function optToCaps(opt?: RpcOpt): tCaps;
