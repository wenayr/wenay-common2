import type { ReplayEvent } from '../events/replay-listen';
import type { StorePatch } from './store';
export declare const STORE_REPLAY_BATCH_V2_VERSION: 2;
export type tStoreReplayWirePatchV2 = [key: PropertyKey, value: unknown] | [key: PropertyKey] | [path: PropertyKey[], value: unknown] | [path: PropertyKey[]] | [target: PropertyKey | PropertyKey[], op: 2, marker: 0];
export type tStoreReplayWireBatchV2 = [
    version: typeof STORE_REPLAY_BATCH_V2_VERSION,
    seq: number,
    ts: number,
    patches: tStoreReplayWirePatchV2[]
];
export declare function encodeStoreReplayPatchV2(patch: StorePatch): tStoreReplayWirePatchV2;
export declare function decodeStoreReplayPatchV2(wire: tStoreReplayWirePatchV2 | unknown): StorePatch;
export declare function encodeStoreReplayBatchV2(event: ReplayEvent<[readonly StorePatch[]]>): tStoreReplayWireBatchV2;
export declare function decodeStoreReplayBatchV2(wire: tStoreReplayWireBatchV2 | unknown): ReplayEvent<[StorePatch[]]>;
export declare function storeReplayBatchV2JsonBytes(wire: tStoreReplayWireBatchV2 | ReplayEvent<[readonly StorePatch[]]>): number;
export declare function storeReplayPatchV2WireMetrics(patch: StorePatch, firstBinaryIndex?: number): {
    byteLength: number;
    binaryCount: number;
};
export declare function storeReplayPatchV2WireBytes(patch: StorePatch): number;
export declare function storeReplayBatchV2WireMetrics(patches: readonly StorePatch[]): {
    byteLength: number;
    binaryCount: number;
};
