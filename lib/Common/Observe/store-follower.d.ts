import { StoreReplayOpts, StoreReplayRemote, tStoreReplayMode } from './store-replay';
export type tFollowerUpstream = 'catching-up' | 'live' | 'offline' | 'promoted' | 'closed';
export type FollowerStatus = {
    upstream: tFollowerUpstream;
    seq: number;
    replayMode?: tStoreReplayMode;
    epoch: number;
    error: string | null;
};
export type StoreFollowerDeps<T extends object> = {
    remote: StoreReplayRemote;
    initial?: T;
    expose?: StoreReplayOpts;
    staleMs?: number;
    epoch?: number;
};
export declare function createStoreFollower<T extends object>(deps: StoreFollowerDeps<T>): {
    store: import("./store").Store<T>;
    status: import("./store").Store<FollowerStatus>;
    isStale: () => boolean;
    api: {
        get(): T;
        get<M extends import("./store").StoreMask<T>>(mask: M): import("./store").StorePick<T, M>;
        set(path: import("./store").StorePath, value: any): void;
        replace(path: import("./store").StorePath, value: any): void;
        changed: any;
        changedPaths: any;
        replay: {
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
        });
    };
    replay: {
        has(key: import("../..").ListenKey): boolean;
        off(keyOrCallback: import("../..").Listener<[readonly import("./store").StorePatch[]]> | import("../..").ListenKey | null): void;
        count(): number;
        keys(): import("../..").ListenKey[];
        isRunning(): boolean;
        run(): void;
        onClose(cb: () => void): import("../..").ListenOff;
        emit: import("../..").Listener<[readonly import("./store").StorePatch[]]>;
        emitBatch: (events: readonly [readonly import("./store").StorePatch[]][]) => void;
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
        line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>]>;
        hasKeyframe: boolean;
        on: import("../events/replay-listen").ListenOnReplay<[readonly import("./store").StorePatch[]]>;
        once: (cb: import("../..").Listener<[readonly import("./store").StorePatch[]]>, opts?: {
            key?: string | symbol;
            current?: import("../..").ListenCurrent<[readonly import("./store").StorePatch[]]> | undefined;
        }) => () => void;
        getSince(seq: number): import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[] | undefined;
        keyframe(): import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]> | undefined;
        frame(seq: number, hint?: unknown): import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[];
    };
    ready: Promise<void>;
    promote: () => {
        store: import("./store").Store<T>;
        replay: {
            has(key: import("../..").ListenKey): boolean;
            off(keyOrCallback: import("../..").Listener<[readonly import("./store").StorePatch[]]> | import("../..").ListenKey | null): void;
            count(): number;
            keys(): import("../..").ListenKey[];
            isRunning(): boolean;
            run(): void;
            onClose(cb: () => void): import("../..").ListenOff;
            emit: import("../..").Listener<[readonly import("./store").StorePatch[]]>;
            emitBatch: (events: readonly [readonly import("./store").StorePatch[]][]) => void;
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
            line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>]>;
            hasKeyframe: boolean;
            on: import("../events/replay-listen").ListenOnReplay<[readonly import("./store").StorePatch[]]>;
            once: (cb: import("../..").Listener<[readonly import("./store").StorePatch[]]>, opts?: {
                key?: string | symbol;
                current?: import("../..").ListenCurrent<[readonly import("./store").StorePatch[]]> | undefined;
            }) => () => void;
            getSince(seq: number): import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[] | undefined;
            keyframe(): import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]> | undefined;
            frame(seq: number, hint?: unknown): import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[];
        };
        epoch: number;
    };
    close(): void;
};
export type StoreFollower<T extends object> = ReturnType<typeof createStoreFollower<T>>;
export type KeyedConflict<T> = {
    key: string;
    local: T;
    authority: T;
};
export declare function diffKeyedState<T extends object>(local: Record<string, T>, authority: Record<string, T>): {
    localOnly: T[];
    authorityOnly: T[];
    conflicts: KeyedConflict<T>[];
};
