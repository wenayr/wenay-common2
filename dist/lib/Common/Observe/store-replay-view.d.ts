import { type Store, type StorePatch } from './store';
import type { replayListen } from '../events/replay-listen';
import { type tStoreReplayWireBatchV2 } from './store-replay-codec';
import type { StoreReplayBatchOpts, StoreReplayBatchRemote, StoreReplayPatchSource, StoreReplayRemote, StoreReplaySyncOpts, syncStoreReplay as syncStoreReplayBase } from './store-replay';
export type StoreReplayViewSnapshotOpts = {
    chunkBytes?: number;
    windowBytes?: number;
    maxItems?: number;
    maxSessions?: number;
    ttlMs?: number;
};
export type StoreReplayViewOpts<K extends string = string> = StoreReplayBatchOpts & {
    keys: readonly K[];
    lineId?: string;
    describe?: Record<string, any>;
    patchSource?: StoreReplayPatchSource;
    snapshot?: StoreReplayViewSnapshotOpts;
};
export type StoreReplayViewDescriptorV1 = {
    version: 1;
    lineId: string;
    selectionId: string;
    keyCount: number;
};
export type StoreReplayViewSnapshotOpenV1 = {
    version: 1;
    transferId: string;
    lineId: string;
    selectionId: string;
    baseSeq: number;
    ts: number;
};
export type StoreReplayViewSnapshotChunkV1 = {
    version: 1;
    transferId: string;
    page: number;
    index: number;
    wire: tStoreReplayWireBatchV2;
};
export type StoreReplayViewSnapshotReadV1 = {
    version: 1;
    transferId: string;
    lineId: string;
    after: number;
    next: number;
    emitted: number;
    done: boolean;
    retry?: true;
    seq?: number;
    ts?: number;
};
export type StoreReplayViewRemote = {
    describe: () => Record<string, any> | Promise<Record<string, any>>;
    replay: StoreReplayRemote;
    snapshot: {
        open: () => StoreReplayViewSnapshotOpenV1 | Promise<StoreReplayViewSnapshotOpenV1>;
        read: (request: {
            transferId: string;
            after: number;
            maxBytes?: number;
        }, emit: (chunk: StoreReplayViewSnapshotChunkV1) => void) => StoreReplayViewSnapshotReadV1 | Promise<StoreReplayViewSnapshotReadV1>;
        close: (transferId: string) => void | Promise<void>;
    };
};
export type StoreReplayViewCursor = {
    lineId: string;
    selectionId: string;
    seq: number;
};
export type StoreReplayViewSyncOpts<T extends object = any> = Omit<StoreReplaySyncOpts<T>, 'catchUp' | 'prepareCatchUp' | 'recoverGap' | 'since'> & {
    cursor?: StoreReplayViewCursor;
    snapshotWindowBytes?: number;
    snapshotRetries?: number;
    onSnapshotProgress?: (progress: {
        transferId: string;
        chunks: number;
        pages: number;
        done: boolean;
    }) => void;
};
type StoreReplayBatchLine = ReturnType<typeof replayListen<[readonly StorePatch[]]>>[1];
type StoreReplayViewBatch = {
    replay: StoreReplayBatchLine;
    push: (patches: readonly StorePatch[]) => void;
    flush: () => void;
    close: () => void;
    stats: () => {
        sourceBatches: number;
        sourcePatches: number;
        emittedBatches: number;
        emittedPatches: number;
        estimatedBytes: number;
    };
};
type StoreReplayViewLayerDeps = {
    createBatchReplay: (currentBatch: () => [readonly StorePatch[]], opts: StoreReplayBatchOpts, label?: string) => StoreReplayViewBatch;
    exposeStoreReplayBatch: (replay: StoreReplayBatchLine, prepareRead: () => void) => StoreReplayBatchRemote;
    syncStoreReplay: typeof syncStoreReplayBase;
};
export declare function createStoreReplayViewLayer(deps: StoreReplayViewLayerDeps): {
    createStoreReplayView: <T extends object, K extends Extract<keyof T, string> = Extract<keyof T, string>>(store: Store<T>, opts: StoreReplayViewOpts<K>) => {
        resource: StoreReplayViewRemote;
        events: {
            replay: {
                has(key: import("../..").ListenKey): boolean;
                off(keyOrCallback: import("../..").Listener<[readonly StorePatch[]]> | import("../..").ListenKey | null): void;
                count(): number;
                keys(): import("../..").ListenKey[];
                isRunning(): boolean;
                run(): void;
                onClose(cb: () => void): import("../..").ListenOff;
                emit: import("../..").Listener<[readonly StorePatch[]]>;
                emitBatch: (events: readonly [readonly StorePatch[]][]) => void;
                head: () => number;
                isStale: () => boolean;
                lastTs: () => number;
                close: () => void;
                getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly StorePatch[]]>[] | undefined;
                journalWindow: () => {
                    entries: number;
                    oldestSeq: number | null;
                    head: number;
                    ageMs: number;
                    bytes: number;
                    historyLimit: number;
                    keepMs: number;
                    keepBytes: number;
                    cappedByCount: boolean;
                    cappedByBytes: boolean;
                };
                line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly StorePatch[]]>]>;
                hasKeyframe: boolean;
                keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly StorePatch[]]> | undefined;
                frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly StorePatch[]]>[];
                on: import("../events/replay-listen").ListenOnReplay<[readonly StorePatch[]]>;
                once: (cb: import("../..").Listener<[readonly StorePatch[]]>, opts?: {
                    key?: string | symbol;
                    current?: import("../..").ListenCurrent<[readonly StorePatch[]]> | undefined;
                }) => () => void;
            };
        };
        view: {
            lineId: string;
            selectionId: string;
            keys: () => K[];
            stats: () => {
                lineId: string;
                selectionId: string;
                keyCount: number;
                activeSessions: number;
                openedSnapshots: number;
                completedSnapshots: number;
                expiredSnapshots: number;
                retrySnapshots: number;
                snapshotPages: number;
                snapshotChunks: number;
                snapshotPatches: number;
                snapshotBytes: number;
                replay: {
                    sourceBatches: number;
                    sourcePatches: number;
                    emittedBatches: number;
                    emittedPatches: number;
                    estimatedBytes: number;
                };
            };
        };
        close: () => void;
    };
    syncStoreReplayView: <T extends object>(store: Store<T>, remote: StoreReplayViewRemote, opts?: StoreReplayViewSyncOpts<T>) => (() => void) & {
        ready: Promise<void>;
        seq: () => number;
        isStale: () => boolean;
        lastTs: () => number;
        mode: 'v2';
    } & {
        viewMode: 'v1';
        cursor(): {
            lineId: string;
            selectionId: string;
            seq: number;
        } | null;
    };
};
export {};
