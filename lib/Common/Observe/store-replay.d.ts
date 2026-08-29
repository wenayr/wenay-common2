import { type Store, type StorePatch, type StoreDrain, type StoreEachCtx } from './store';
import { type ReplayListenOptions, type ReplayEvent } from '../events/replay-listen';
import { type ReplayRemote, type ReplaySubscribeOpts } from '../events/replay-wire';
import { type ReplayRouteSubscribeOpts, type ReplayRouteSwitchOpts } from '../events/replay-route';
import { type ReplayStorage } from '../events/replay-history';
import { type tStoreReplayWireBatchV2 } from './store-replay-codec';
import { type StoreReplayViewOpts, type StoreReplayViewRemote, type StoreReplayViewSyncOpts } from './store-replay-view';
export type { StoreReplayViewCursor, StoreReplayViewDescriptorV1, StoreReplayViewOpts, StoreReplayViewRemote, StoreReplayViewSnapshotChunkV1, StoreReplayViewSnapshotOpenV1, StoreReplayViewSnapshotOpts, StoreReplayViewSnapshotReadV1, StoreReplayViewSyncOpts, } from './store-replay-view';
export type StoreReplayBatchOpts = Pick<ReplayListenOptions<[readonly StorePatch[]]>, 'history' | 'keepMs' | 'keepBytes' | 'sizeOf' | 'getSince' | 'onJournal' | 'onJournalBatch' | 'now' | 'firstSeq'> & {
    maxItems?: number;
    maxBytes?: number;
    maxDelayMs?: number;
};
export type StoreReplayPatchSource = {
    on(cb: (patches: readonly StorePatch[]) => void): () => void;
};
export type StoreReplayOpts = StoreReplayBatchOpts & {
    describe?: Record<string, any>;
    patchSource?: StoreReplayPatchSource;
};
export type StoreReplayChunksBegin<W = unknown> = {
    snapshotId: string;
    seq: number;
    ts: number;
    total: number;
    budgetBytes: number;
    chunk0: W;
};
type StoreReplayWireRemote<W> = {
    line: {
        on: (cb: (batch: W) => void) => any;
    };
    since: (seq: number) => Promise<W[] | null | undefined> | W[] | null | undefined;
    keyframe: () => Promise<W | null | undefined> | W | null | undefined;
    frame?: (seq: number, hint?: unknown) => Promise<W[] | null | undefined> | W[] | null | undefined;
    frameLine?: {
        on: (cb: (batch: W) => void) => any;
    };
    chunks?: {
        begin: (opts?: {
            budgetBytes?: number;
        }) => Promise<StoreReplayChunksBegin<W> | null | undefined> | StoreReplayChunksBegin<W> | null | undefined;
        pull: (snapshotId: string, index: number) => Promise<W | null | undefined> | W | null | undefined;
        end?: (snapshotId: string) => unknown;
    };
};
export type StoreReplayLineLocal = {
    count(): number;
};
export type StoreReplayBatchRemote = StoreReplayWireRemote<tStoreReplayWireBatchV2>;
export type StoreReplayRemote = StoreReplayBatchRemote & {
    describe?: () => Record<string, any> | Promise<Record<string, any>>;
};
export type tStoreReplayMode = 'v2';
export type StoreReplayChunkedProgress = {
    snapshotId: string;
    received: number;
    total: number;
};
export type StoreReplayChunkedKeyframeOpt = boolean | {
    budgetBytes?: number;
    onProgress?: (progress: StoreReplayChunkedProgress) => void;
};
export type StoreReplaySyncOpts<T extends object = any> = ReplaySubscribeOpts & {
    onBatch?: (patches: readonly StorePatch[], store: Store<T>) => void;
    validateBatch?: (patches: readonly StorePatch[], store: Store<T>) => void;
    chunkedKeyframe?: StoreReplayChunkedKeyframeOpt;
};
export type StoreReplayRouteOpts<T extends object = any> = ReplayRouteSubscribeOpts & {
    onBatch?: (patches: readonly StorePatch[], store: Store<T>) => void;
    validateBatch?: (patches: readonly StorePatch[], store: Store<T>) => void;
    chunkedKeyframe?: StoreReplayChunkedKeyframeOpt;
};
export declare function storeReplayMode(): tStoreReplayMode;
export declare const STORE_REPLAY_CHUNK_BUDGET_DEFAULT: number;
export declare const STORE_REPLAY_CHUNK_BUDGET_MIN: number;
export declare const STORE_REPLAY_CHUNK_BUDGET_MAX: number;
export declare const STORE_REPLAY_CHUNK_TTL_MS = 60000;
export declare function exposeStoreReplay<T extends object>(store: Store<T>, opts?: StoreReplayOpts): {
    api: {
        get(): T;
        get<M extends import("./store").StoreMask<T>>(mask: M): import("./store").StorePick<T, M>;
        set(path: import("./store").StorePath, value: any): void;
        replace(path: import("./store").StorePath, value: any): void;
        changed: any;
        changedPaths: any;
        replay: {
            line: {
                on: (cb: (batch: tStoreReplayWireBatchV2) => void) => any;
            } & StoreReplayLineLocal;
            since: (seq: number) => tStoreReplayWireBatchV2[] | Promise<tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
            keyframe: () => Promise<tStoreReplayWireBatchV2 | null | undefined> | tStoreReplayWireBatchV2 | null | undefined;
            frame?: ((seq: number, hint?: unknown) => tStoreReplayWireBatchV2[] | Promise<tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
            frameLine?: {
                on: (cb: (batch: tStoreReplayWireBatchV2) => void) => any;
            } | undefined;
            chunks?: {
                begin: (opts?: {
                    budgetBytes?: number;
                }) => Promise<StoreReplayChunksBegin<tStoreReplayWireBatchV2> | null | undefined> | StoreReplayChunksBegin<tStoreReplayWireBatchV2> | null | undefined;
                pull: (snapshotId: string, index: number) => Promise<tStoreReplayWireBatchV2 | null | undefined> | tStoreReplayWireBatchV2 | null | undefined;
                end?: (snapshotId: string) => unknown;
            } | undefined;
            describe: () => Record<string, any>;
        } | (StoreReplayWireRemote<tStoreReplayWireBatchV2> & {
            line: StoreReplayLineLocal;
        });
    };
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
        line: import("../..").ListenApi<[ReplayEvent<[readonly StorePatch[]]>]>;
        hasKeyframe: boolean;
        on: import("../events/replay-listen").ListenOnReplay<[readonly StorePatch[]]>;
        once: (cb: import("../..").Listener<[readonly StorePatch[]]>, opts?: {
            key?: string | symbol;
            current?: import("../..").ListenCurrent<[readonly StorePatch[]]> | undefined;
        }) => () => void;
        getSince(seq: number): ReplayEvent<[readonly StorePatch[]]>[] | undefined;
        keyframe(): ReplayEvent<[readonly StorePatch[]]> | undefined;
        frame(seq: number, hint?: unknown): ReplayEvent<[readonly StorePatch[]]>[];
    };
    batchStats: () => {
        sourceBatches: number;
        sourcePatches: number;
        emittedBatches: number;
        emittedPatches: number;
        estimatedBytes: number;
    };
    flushPending: () => void;
    close: () => void;
};
export declare function syncStoreReplayBatch<T extends object>(store: Store<T>, remote: StoreReplayBatchRemote, opts?: StoreReplaySyncOpts<T>): (() => void) & {
    ready: Promise<void>;
    seq: () => number;
    isStale: () => boolean;
    lastTs: () => number;
};
export declare function syncStoreReplay<T extends object>(store: Store<T>, remote: StoreReplayRemote, opts?: StoreReplaySyncOpts<T>): (() => void) & {
    ready: Promise<void>;
    seq: () => number;
    isStale: () => boolean;
    lastTs: () => number;
    mode: 'v2';
};
export declare function createStoreReplayView<T extends object, K extends Extract<keyof T, string> = Extract<keyof T, string>>(store: Store<T>, opts: StoreReplayViewOpts<K>): {
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
            getSince: (seq: number) => ReplayEvent<[readonly StorePatch[]]>[] | undefined;
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
            line: import("../..").ListenApi<[ReplayEvent<[readonly StorePatch[]]>]>;
            hasKeyframe: boolean;
            keyframe: () => ReplayEvent<[readonly StorePatch[]]> | undefined;
            frame: (sinceSeq: number, hint?: unknown) => ReplayEvent<[readonly StorePatch[]]>[];
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
export declare function syncStoreReplayView<T extends object>(store: Store<T>, remote: StoreReplayViewRemote, opts?: StoreReplayViewSyncOpts<T>): (() => void) & {
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
export declare function syncStoreReplayRoute<T extends object>(store: Store<T>, remote: StoreReplayRemote, opts?: StoreReplayRouteOpts<T>): (() => void) & {
    ready: Promise<void>;
    switch: (nextRemote: StoreReplayRemote, nextOpts?: Parameters<(nextRemote: ReplayRemote<[StorePatch[]]>, nextOpts?: ReplayRouteSwitchOpts) => Promise<void>>[1]) => Promise<void>;
    seq: () => number;
    label: () => string | undefined;
    active: () => boolean;
    mode: 'v2';
};
export declare function syncStoreReplayEach<T extends object>(remote: StoreReplayRemote, cb: (key: string, value: T[keyof T] | undefined, ctx: StoreEachCtx) => void, opts?: StoreReplaySyncOpts<T> & {
    drain?: StoreDrain;
    initial?: T;
}): ((() => void) & {
    store: Store<T>;
    ready: Promise<void>;
    seq: () => number;
    isStale: () => boolean;
    lastTs: () => number;
}) & {
    readonly mode: tStoreReplayMode;
};
export declare function storeReplayAt<T extends object>(storage: ReplayStorage<[readonly StorePatch[]]>, at?: {
    seq?: number;
    ts?: number;
}): T | undefined;
