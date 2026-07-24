import { type idPool } from '../id-pool';
import { type RpcLimits } from './rpc-limits';
export type tRpcBinaryErrorDto = [kind: 0, value: unknown] | [
    kind: 1,
    name: string,
    message: string,
    stack: string | undefined,
    code: unknown,
    data: unknown,
    cause: tRpcBinaryErrorDto | undefined
];
export declare function rollbackRpcBinaryCallbacks(pool: idPool, callbacks: Map<number, Function>, callbackIds: number[], from?: number): void;
export declare function packRpcBinaryArgs(args: any[], pool: idPool, callbacks: Map<number, Function>, callbackIds: number[], snapshot?: boolean): any[];
export declare function unpackRpcBinaryArgs(args: any[], sender: (id: number, args: any[]) => void, onEnd: (id: number) => void, limits?: RpcLimits): any[];
export declare function unpackRpcBinaryArgsTrusted(args: any[], sender: (id: number, args: any[]) => void, onEnd: (id: number) => void, limits?: RpcLimits): any[];
export declare function validateRpcBinaryResultTrusted(value: unknown, limits?: RpcLimits): any;
export declare function validateRpcBinaryResult(value: unknown, limits?: RpcLimits): any;
export declare function snapshotRpcBinaryResult(value: unknown, limits?: RpcLimits): any;
export declare function rpcBinaryErrorToDto(error: unknown, limits?: RpcLimits): tRpcBinaryErrorDto;
export declare function reviveRpcBinaryError(dto: unknown, limits?: RpcLimits): unknown;
