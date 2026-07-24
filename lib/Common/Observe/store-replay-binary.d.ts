import { type RpcLimits } from '../rcp/rpc-limits';
export declare const STORE_REPLAY_BINARY_MAX_WIRE_BYTES = 16000000;
export declare function encodeStoreReplayBinary(value: unknown): Uint8Array<ArrayBuffer>;
export declare function decodeStoreReplayBinary(wire: unknown, requestedLimits?: RpcLimits): unknown;
