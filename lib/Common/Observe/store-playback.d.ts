import { StoreDrain, StorePatch } from './store';
import { StoreReplayOpts } from './store-replay';
import { ReplayEvent } from '../events/replay-listen';
import { ReplayStorage } from '../events/replay-history';
export type StorePlaybackOpts = {
    speed?: number;
    maxStepMs?: number;
    drain?: StoreDrain;
    expose?: Pick<StoreReplayOpts, 'describe' | 'history' | 'now' | 'maxItems' | 'maxBytes' | 'maxDelayMs'>;
};
export declare function playbackStoreReplay<T extends object>(storage: ReplayStorage<[readonly StorePatch[]]>, opts?: StorePlaybackOpts): {
    store: import("./store").Store<T>;
    api: {
        replay: {
            line: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            };
            since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
            keyframe: () => import("./store-replay-codec").tStoreReplayWireBatchV2 | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | null | undefined;
            frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
            frameLine?: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            } | undefined;
        } | {
            describe: () => Record<string, any>;
            line: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            };
            since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
            keyframe: () => import("./store-replay-codec").tStoreReplayWireBatchV2 | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | null | undefined;
            frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
            frameLine?: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            } | undefined;
        };
        get(): T;
        get<M extends import("./store").StoreMask<T>>(mask: M): import("./store").StorePick<T, M>;
        set(path: import("./store").StorePath, value: any): void;
        replace(path: import("./store").StorePath, value: any): void;
        changed: any;
        changedPaths: any;
    };
    replay: {
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
    };
    range: {
        from: number;
        to: number;
    };
    done: Promise<void>;
    close(): void;
};
export type StorePlayback<T extends object> = ReturnType<typeof playbackStoreReplay<T>>;
