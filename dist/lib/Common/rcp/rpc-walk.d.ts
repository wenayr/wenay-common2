import { idPool } from "../id-pool";
import { type RpcLimits } from "./rpc-limits";
export declare const ROW_MARKER = "$_t";
export declare const RESERVED_MARKER_KEYS: ReadonlySet<string>;
export declare function reservedMarkerKeyOf(value: any): string | undefined;
export type tReservedKeyReport = (key: string, value: any) => void;
export type tRowCodec = {
    encode?: (arr: any[], packValue: (v: any) => any) => any[] | null;
    decode?: (payload: any, decodeValue: (v: any, depth: number) => any, depth: number) => {
        value: any;
    } | null;
};
export declare function walk(val: any, onLeaf: (v: any) => any, lim?: Required<RpcLimits>, depth?: number, rows?: tRowCodec, onReserved?: tReservedKeyReport): any;
export declare function pack(args: any[], pool: idPool, cbStore: Map<number, Function>, cbIds: number[], onReserved?: tReservedKeyReport): any[];
export declare function packResult(value: any, rows?: tRowCodec, onReserved?: tReservedKeyReport): any;
export declare function createRpcCallbackWrapper({ id, sender, onEnd, legacyStopSentinel, }: {
    id: number;
    sender: (id: number, args: any[]) => void;
    onEnd: (id: number) => void;
    legacyStopSentinel?: boolean;
}): (...args: any[]) => void;
export declare function rpcEndCallback(fn: Function): void;
export declare function unpack(args: any[], sender: (id: number, a: any[]) => void, onEnd: (id: number) => void, lim?: Required<RpcLimits>): any[];
export declare function unpackResult(value: any, lim?: Required<RpcLimits>, rows?: tRowCodec): any;
export declare const errToObj: (e: any) => any;
export declare const resolveCA: (path: string[], args: any[]) => [string[], any[]];
