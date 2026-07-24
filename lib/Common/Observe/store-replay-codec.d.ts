import type { ReplayEvent } from '../events/replay-listen';
import type { StorePatch } from './store';
import type { tStoreReplayWireBatchV4 as tStoreReplayWireBatchV4ForMetrics, tStoreReplayWireBatchV5 as tStoreReplayWireBatchV5ForMetrics } from './store-replay-columnar';
export { STORE_REPLAY_BATCH_V4_VERSION, prepareStoreReplayBatchPlan, decodeStoreReplayBatchPlan, encodeStoreReplayBatchV4, decodeStoreReplayBatchV4, encodeStoreReplayBatchV5, decodeStoreReplayBatchV5, } from './store-replay-columnar';
export type { tStoreReplayBatchPlan, tStoreReplayBatchPlanRun, tStoreReplayWireBatchV4, tStoreReplayWireBatchV5, } from './store-replay-columnar';
export declare const STORE_REPLAY_BATCH_VERSION: 1;
export declare const STORE_REPLAY_BATCH_V2_VERSION: 2;
export declare const STORE_REPLAY_BATCH_V3_VERSION: 3;
export type tStoreReplayWirePatch = [path: PropertyKey[], op: 1, value: unknown] | [path: PropertyKey[], op: 0] | [path: PropertyKey[], op: 2];
export type tStoreReplayWireBatch = [
    version: typeof STORE_REPLAY_BATCH_VERSION,
    seq: number,
    ts: number,
    patches: tStoreReplayWirePatch[]
];
export type tStoreReplayWirePatchV2 = [key: PropertyKey, value: unknown] | [key: PropertyKey] | [path: PropertyKey[], value: unknown] | [path: PropertyKey[]] | [target: PropertyKey | PropertyKey[], op: 2, marker: 0];
export type tStoreReplayWireBatchV2 = [
    version: typeof STORE_REPLAY_BATCH_V2_VERSION,
    seq: number,
    ts: number,
    patches: tStoreReplayWirePatchV2[]
];
export type tStoreReplayWirePatchV3 = tStoreReplayWirePatchV2 | [target: PropertyKey | PropertyKey[], op: 3, value: unknown];
export type tStoreReplayWireBatchV3 = [
    version: typeof STORE_REPLAY_BATCH_V3_VERSION,
    seq: number,
    ts: number,
    patches: tStoreReplayWirePatchV3[]
];
export declare function encodeStoreReplayPatch(patch: StorePatch): tStoreReplayWirePatch;
export declare function decodeStoreReplayPatch(wire: tStoreReplayWirePatch | unknown): StorePatch;
export declare function encodeStoreReplayPatchV2(patch: StorePatch): tStoreReplayWirePatchV2;
export declare function decodeStoreReplayPatchV2(wire: tStoreReplayWirePatchV2 | unknown): StorePatch;
export declare function encodeStoreReplayPatchV3(patch: StorePatch): tStoreReplayWirePatchV3;
export declare function decodeStoreReplayPatchV3(wire: tStoreReplayWirePatchV3 | unknown): StorePatch;
export declare function encodeStoreReplayBatch(event: ReplayEvent<[readonly StorePatch[]]>): tStoreReplayWireBatch;
export declare function decodeStoreReplayBatch(wire: tStoreReplayWireBatch | unknown): ReplayEvent<[StorePatch[]]>;
export declare function encodeStoreReplayBatchV2(event: ReplayEvent<[readonly StorePatch[]]>): tStoreReplayWireBatchV2;
export declare function decodeStoreReplayBatchV2(wire: tStoreReplayWireBatchV2 | unknown): ReplayEvent<[StorePatch[]]>;
export declare function encodeStoreReplayBatchV3(event: ReplayEvent<[readonly StorePatch[]]>): tStoreReplayWireBatchV3;
export declare function decodeStoreReplayBatchV3(wire: tStoreReplayWireBatchV3 | unknown): ReplayEvent<[StorePatch[]]>;
export declare function storeReplayBatchJsonBytes(wire: tStoreReplayWireBatch | ReplayEvent<[readonly StorePatch[]]>): number;
export declare function storeReplayBatchV2JsonBytes(wire: tStoreReplayWireBatchV2 | ReplayEvent<[readonly StorePatch[]]>): number;
export declare function storeReplayBatchV3JsonBytes(wire: tStoreReplayWireBatchV3 | ReplayEvent<[readonly StorePatch[]]>): number;
export declare function storeReplayBatchV4WireBytes(wire: tStoreReplayWireBatchV4ForMetrics | ReplayEvent<[readonly StorePatch[]]>): number;
export declare function storeReplayBatchV5WireBytes(wire: tStoreReplayWireBatchV5ForMetrics | ReplayEvent<[readonly StorePatch[]]>): number;
export declare function storeReplayPatchJsonBytes(patch: StorePatch): number;
export declare function storeReplayPatchMaxWireMetrics(patch: StorePatch, firstBinaryIndex?: number): {
    byteLength: number;
    binaryCount: number;
};
export declare function storeReplayPatchMaxWireBytes(patch: StorePatch): number;
export declare function storeReplayBatchMaxWireMetrics(patches: readonly StorePatch[]): {
    byteLength: number;
    binaryCount: number;
};
