import { StoreDrain, StorePatch } from './store';
import { exposeStoreReplay, StoreReplayOpts } from './store-replay';
import { ReplayStorage } from '../events/replay-history';
import { ReplayEvent } from '../events/replay-listen';
export type DurableStoreDeps<T extends object> = {
    storage: ReplayStorage<[readonly StorePatch[]]>;
    initial?: T;
    everyEvents?: number;
    everyMs?: number;
    drain?: StoreDrain;
    onJournal?: StoreReplayOpts['onJournal'];
};
export type DurableStoreLine = {
    replay: ReturnType<typeof exposeStoreReplay<object>>['replay'];
    flushPending?: () => void;
};
export declare function openDurableStore<T extends object>(deps: DurableStoreDeps<T>): {
    store: import("./store").Store<T>;
    restored: {
        seq: number;
        fromArchive: boolean;
    };
    expose: Pick<StoreReplayOpts, "firstSeq" | "getSince" | "onJournal" | "onJournalBatch">;
    attach: (line: DurableStoreLine) => {
        stats: () => {
            events: number;
            keyframes: number;
        };
        retry: () => void;
        flush(): void;
        close(): void;
    };
};
export type DurableStore<T extends object> = ReturnType<typeof openDurableStore<T>>;
export type DurableStoreReplayDeps<T extends object> = Omit<DurableStoreDeps<T>, 'onJournal'> & {
    expose?: Pick<StoreReplayOpts, 'describe' | 'onJournal' | 'now' | 'maxItems' | 'maxBytes' | 'maxDelayMs'>;
};
export declare function createDurableStoreReplay<T extends object>(deps: DurableStoreReplayDeps<T>): {
    store: import("./store").Store<T>;
    api: {
        get: import("./store").StoreGetter<T>;
        set(path: import("./store").StorePath, value: any): void;
        replace(path: import("./store").StorePath, value: any): void;
        changed: any;
        changedPaths: any;
        replay: ({
            line: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            } & import("./store-replay").StoreReplayLineLocal;
            since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
            keyframe: () => Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
            frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
            frameLine?: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            } | undefined;
            chunks?: {
                begin: (opts?: {
                    budgetBytes?: number;
                }) => Promise<import("./store-replay").StoreReplayChunksBegin<import("./store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("./store-replay").StoreReplayChunksBegin<import("./store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                pull: (snapshotId: string, index: number) => Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                end?: (snapshotId: string) => unknown;
            } | undefined;
            describe: () => Record<string, any>;
        } | ({
            line: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            };
            since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
            keyframe: () => Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
            frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
            frameLine?: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            } | undefined;
            chunks?: {
                begin: (opts?: {
                    budgetBytes?: number;
                }) => Promise<import("./store-replay").StoreReplayChunksBegin<import("./store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("./store-replay").StoreReplayChunksBegin<import("./store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                pull: (snapshotId: string, index: number) => Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                end?: (snapshotId: string) => unknown;
            } | undefined;
        } & {
            line: import("./store-replay").StoreReplayLineLocal;
        })) & import("./store-replay").StoreReplayState<T>;
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
        }) => import("../..").ListenOff;
        getSince(seq: number): ReplayEvent<[readonly StorePatch[]]>[] | undefined;
        keyframe(): ReplayEvent<[readonly StorePatch[]]> | undefined;
        frame(seq: number, hint?: unknown): ReplayEvent<[readonly StorePatch[]]>[];
    };
    restored: {
        seq: number;
        fromArchive: boolean;
    };
    stats: () => {
        events: number;
        keyframes: number;
    };
    retry: () => void;
    close(): void;
};
export type DurableStoreReplay<T extends object> = ReturnType<typeof createDurableStoreReplay<T>>;
