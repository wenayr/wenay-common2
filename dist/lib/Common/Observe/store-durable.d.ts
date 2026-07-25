import { StoreDrain, StorePatch } from './store';
import { StoreReplayOpts } from './store-replay';
import { ReplayStorage } from '../events/replay-history';
import { ReplayEvent } from '../events/replay-listen';
export type DurableStoreReplayDeps<T extends object> = {
    storage: ReplayStorage<[readonly StorePatch[]]>;
    initial?: T;
    everyEvents?: number;
    everyMs?: number;
    drain?: StoreDrain;
    expose?: Pick<StoreReplayOpts, 'describe' | 'onJournal' | 'now' | 'maxItems' | 'maxBytes' | 'maxDelayMs'>;
};
export declare function createDurableStoreReplay<T extends object>(deps: DurableStoreReplayDeps<T>): {
    store: import("./store").Store<T>;
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
            };
            since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
            keyframe: () => Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
            frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
            frameLine?: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            } | undefined;
        } | {
            line: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            };
            since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
            keyframe: () => Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
            frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
            frameLine?: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            } | undefined;
            describe: () => Record<string, any>;
        };
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
