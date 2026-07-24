import type { ReplayEvent } from '../events/replay-listen';
import type { RpcLimits } from '../rcp/rpc-limits';
import type { StorePatch } from './store';
export declare const STORE_REPLAY_BATCH_V4_VERSION: 4;
export type tStoreReplayWireBatchV5 = Uint8Array;
type tStoreReplayPlanKey = string | number;
type tStoreReplayPlanTarget = tStoreReplayPlanKey | tStoreReplayPlanKey[];
type tStoreReplayPlanRawPatch = [target: tStoreReplayPlanTarget] | [target: tStoreReplayPlanTarget, value: unknown];
export type tStoreReplayBatchPlanRun = [op: 0, patches: tStoreReplayPlanRawPatch[]] | [op: 1, targets: tStoreReplayPlanTarget[]] | [
    op: 2,
    fields: string[],
    derivedField: number,
    targets: tStoreReplayPlanTarget[],
    columns: unknown[][]
] | [op: 3, entries: tStoreReplayBatchPlanRun[]] | [op: 4, entries: tStoreReplayBatchPlanRun[]];
export type tStoreReplayBatchPlan = tStoreReplayBatchPlanRun[];
export type tStoreReplayWireBatchV4 = [
    version: typeof STORE_REPLAY_BATCH_V4_VERSION,
    seq: number,
    ts: number,
    plan: tStoreReplayBatchPlan
];
export declare function prepareStoreReplayBatchPlan(patches: readonly StorePatch[]): tStoreReplayBatchPlan;
export declare function decodeStoreReplayBatchPlan(plan: unknown, decodeValue?: (value: unknown) => unknown): StorePatch[];
export declare function encodeStoreReplayBatchV4(event: ReplayEvent<[readonly StorePatch[]]>): tStoreReplayWireBatchV4;
export declare function decodeStoreReplayBatchV4(wire: tStoreReplayWireBatchV4 | unknown): ReplayEvent<[StorePatch[]]>;
export declare function encodeStoreReplayBatchV5(event: ReplayEvent<[readonly StorePatch[]]>): tStoreReplayWireBatchV5;
export declare function decodeStoreReplayBatchV5(wire: tStoreReplayWireBatchV5 | unknown, limits?: RpcLimits): ReplayEvent<[StorePatch[]]>;
export {};
