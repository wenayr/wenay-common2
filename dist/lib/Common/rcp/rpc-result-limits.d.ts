import type { RpcLimits } from './rpc-limits';
export declare function rpcResultLimitsProperty(property: PropertyKey): boolean;
export declare function getRpcResultLimits(value: unknown): Required<RpcLimits> | undefined;
