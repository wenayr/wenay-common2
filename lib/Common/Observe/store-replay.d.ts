import { type Store, type StorePatch, type StoreDrain, type StoreEachCtx } from './store';
import { replayListen, type ReplayListenOptions, type ReplayEvent } from '../events/replay-listen';
import { type ReplayExpose, type ReplayRemote, type ReplaySubscribeOpts } from '../events/replay-wire';
import { type ReplayRouteSubscribeOpts, type ReplayRouteSwitchOpts } from '../events/replay-route';
import { type ReplayStorage } from '../events/replay-history';
import { type tStoreReplayWireBatch, type tStoreReplayWireBatchV2, type tStoreReplayWireBatchV3, type tStoreReplayWireBatchV4, type tStoreReplayWireBatchV5 } from './store-replay-codec';
export type StoreReplayBatchOpts = Pick<ReplayListenOptions<[readonly StorePatch[]]>, 'history' | 'getSince' | 'onJournal' | 'onJournalBatch' | 'now' | 'firstSeq'> & {
    maxItems?: number;
    maxBytes?: number;
    maxDelayMs?: number;
};
export type StoreReplayPatchSource = {
    on(cb: (patches: readonly StorePatch[]) => void): () => void;
};
export type StoreReplayOpts = Pick<ReplayListenOptions<[StorePatch]>, 'history' | 'getSince' | 'onJournal' | 'onJournalBatch' | 'now' | 'firstSeq'> & {
    describe?: Record<string, any>;
    batch?: boolean | StoreReplayBatchOpts;
    patchSource?: StoreReplayPatchSource;
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
};
export type StoreReplayBatchV2Remote = StoreReplayWireRemote<tStoreReplayWireBatchV2>;
export type StoreReplayBatchV3Remote = StoreReplayWireRemote<tStoreReplayWireBatchV3>;
export type StoreReplayBatchV4Remote = StoreReplayWireRemote<tStoreReplayWireBatchV4>;
export type StoreReplayBatchV5Remote = StoreReplayWireRemote<tStoreReplayWireBatchV5>;
export type StoreReplayBatchV6Remote = StoreReplayWireRemote<ReplayEvent<[readonly StorePatch[]]>>;
export type StoreReplayBatchRemote = StoreReplayWireRemote<tStoreReplayWireBatch> & {
    v2?: StoreReplayBatchV2Remote;
    v3?: StoreReplayBatchV3Remote;
    v4?: StoreReplayBatchV4Remote;
    v5?: StoreReplayBatchV5Remote;
    v6?: StoreReplayBatchV6Remote;
};
export type StoreReplayRemote = ReplayRemote<[StorePatch]> & {
    batch?: StoreReplayBatchRemote;
};
export type tStoreReplayMode = 'legacy' | 'batch';
export type StoreReplaySyncOpts<T extends object = any> = ReplaySubscribeOpts & {
    batch?: boolean;
    onBatch?: (patches: readonly StorePatch[], store: Store<T>) => void;
    validateBatch?: (patches: readonly StorePatch[], store: Store<T>) => void;
};
export type StoreReplayRouteOpts<T extends object = any> = ReplayRouteSubscribeOpts & {
    batch?: boolean;
    onBatch?: (patches: readonly StorePatch[], store: Store<T>) => void;
    validateBatch?: (patches: readonly StorePatch[], store: Store<T>) => void;
};
export declare function storeReplayMode(remote: StoreReplayRemote, preferBatch?: boolean): tStoreReplayMode;
export declare function storePatchKey(patch: StorePatch): string | null;
type StoreReplayBatchLine = ReturnType<typeof replayListen<[readonly StorePatch[]]>>[1];
declare function exposeStoreReplayBatch(replay: StoreReplayBatchLine, prepareRead: () => void): {
    v2: StoreReplayWireRemote<tStoreReplayWireBatchV2>;
    v3: StoreReplayWireRemote<tStoreReplayWireBatchV3>;
    v4: StoreReplayWireRemote<tStoreReplayWireBatchV4>;
    v5: StoreReplayWireRemote<tStoreReplayWireBatchV5>;
    v6: StoreReplayWireRemote<ReplayEvent<[readonly StorePatch[]]>>;
    line: {
        on: (cb: (batch: tStoreReplayWireBatch) => void) => any;
    };
    since: (seq: number) => tStoreReplayWireBatch[] | Promise<tStoreReplayWireBatch[] | null | undefined> | null | undefined;
    keyframe: () => tStoreReplayWireBatch | Promise<tStoreReplayWireBatch | null | undefined> | null | undefined;
    frame?: ((seq: number, hint?: unknown) => tStoreReplayWireBatch[] | Promise<tStoreReplayWireBatch[] | null | undefined> | null | undefined) | undefined;
    frameLine?: {
        on: (cb: (batch: tStoreReplayWireBatch) => void) => any;
    } | undefined;
};
export declare function exposeStoreReplay<T extends object>(store: Store<T>, opts?: StoreReplayOpts): {
    api: {
        replay: (ReplayExpose<[StorePatch]> & {
            batch?: ReturnType<typeof exposeStoreReplayBatch>;
        }) | {
            describe: () => Record<string, any>;
            line: import("../..").ListenApi<[ReplayEvent<[StorePatch]>]>;
            since: (seq: number) => ReplayEvent<[StorePatch]>[] | null;
            keyframe: () => ReplayEvent<[StorePatch]> | null;
            frame: (sinceSeq: number, hint?: unknown) => ReplayEvent<[StorePatch]>[];
            batch?: ReturnType<typeof exposeStoreReplayBatch>;
        };
        get(): T;
        get<M extends import("./store").StoreMask<T>>(mask: M): import("./store").StorePick<T, M>;
        set(path: import("./store").StorePath, value: any): void;
        replace(path: import("./store").StorePath, value: any): void;
        changed: any;
        changedPaths: any;
    };
    replay: {
        emit: import("../..").Listener<[StorePatch]>;
        emitBatch: (events: readonly [StorePatch][]) => void;
        head: () => number;
        isStale: () => boolean;
        lastTs: () => number;
        close: () => void;
        getSince: (seq: number) => ReplayEvent<[StorePatch]>[] | undefined;
        line: import("../..").ListenApi<[ReplayEvent<[StorePatch]>]>;
        hasKeyframe: boolean;
        keyframe: () => ReplayEvent<[StorePatch]> | undefined;
        frame: (sinceSeq: number, hint?: unknown) => ReplayEvent<[StorePatch]>[];
        on: import("../events/replay-listen").ListenOnReplay<[StorePatch]>;
        once: (cb: import("../..").Listener<[StorePatch]>, opts?: {
            key?: string | symbol;
            current?: import("../..").ListenCurrent<[StorePatch]> | undefined;
        }) => () => void;
        has(key: import("../..").ListenKey): boolean;
        off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<[StorePatch]> | null): void;
        count(): number;
        keys(): import("../..").ListenKey[];
        isRunning(): boolean;
        run(): void;
        onClose(cb: () => void): import("../..").ListenOff;
    };
    replayBatch: {
        getSince(seq: number): ReplayEvent<[readonly StorePatch[]]>[] | undefined;
        keyframe(): ReplayEvent<[readonly StorePatch[]]> | undefined;
        frame(seq: number, hint?: unknown): ReplayEvent<[readonly StorePatch[]]>[];
        emit: import("../..").Listener<[readonly StorePatch[]]>;
        emitBatch: (events: readonly [readonly StorePatch[]][]) => void;
        head: () => number;
        isStale: () => boolean;
        lastTs: () => number;
        close: () => void;
        line: import("../..").ListenApi<[ReplayEvent<[readonly StorePatch[]]>]>;
        hasKeyframe: boolean;
        on: import("../events/replay-listen").ListenOnReplay<[readonly StorePatch[]]>;
        once: (cb: import("../..").Listener<[readonly StorePatch[]]>, opts?: {
            key?: string | symbol;
            current?: import("../..").ListenCurrent<[readonly StorePatch[]]> | undefined;
        }) => () => void;
        has(key: import("../..").ListenKey): boolean;
        off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<[readonly StorePatch[]]> | null): void;
        count(): number;
        keys(): import("../..").ListenKey[];
        isRunning(): boolean;
        run(): void;
        onClose(cb: () => void): import("../..").ListenOff;
    } | undefined;
    batchStats: (() => {
        sourceBatches: number;
        sourcePatches: number;
        emittedBatches: number;
        emittedPatches: number;
        estimatedBytes: number;
    }) | undefined;
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
    mode: tStoreReplayMode;
};
export declare function syncStoreReplayRoute<T extends object>(store: Store<T>, remote: StoreReplayRemote, opts?: StoreReplayRouteOpts<T>): (() => void) & {
    ready: Promise<void>;
    switch: (nextRemote: StoreReplayRemote, nextOpts?: ReplayRouteSwitchOpts) => Promise<void>;
    seq: () => number;
    label: () => string | undefined;
    active: () => boolean;
    mode: tStoreReplayMode;
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
export declare function storeReplayAt<T extends object>(storage: ReplayStorage<[StorePatch]>, at?: {
    seq?: number;
    ts?: number;
}): T | undefined;
export {};
