import { Listener, NormalizeTuple } from './Listen';
import { ListenOnReplay, ListenReplayApi, ReplayEvent } from './replay-listen';
export type ReplayStorage<Z extends any[] = any[]> = {
    putEvent: (ev: ReplayEvent<Z>) => void;
    putEvents?: (events: readonly ReplayEvent<Z>[]) => void;
    putKeyframe: (kf: ReplayEvent<Z>) => void;
    getKeyframe: (at?: {
        seq?: number;
        ts?: number;
    }) => ReplayEvent<Z> | undefined;
    getEvents: (from: number, to: number) => ReplayEvent<Z>[];
};
export declare function createMemoryReplayStorage<Z extends any[] = any[]>(opts?: {
    maxEvents?: number;
    maxKeyframes?: number;
}): {
    putEvent: (ev: ReplayEvent<Z>) => void;
    putEvents: (batch: readonly ReplayEvent<Z>[]) => void;
    putKeyframe: (kf: ReplayEvent<Z>) => void;
    getKeyframe: (at?: {
        seq?: number;
        ts?: number;
    }) => ReplayEvent<Z> | undefined;
    getEvents: (from: number, to: number) => ReplayEvent<Z>[];
    size: () => {
        events: number;
        keyframes: number;
    };
};
export type ArchiveReplayOpts<Z extends any[]> = {
    storage: ReplayStorage<Z>;
    everyEvents?: number;
    everyMs?: number;
};
export declare function archiveReplay<T>(replay: ListenReplayApi<T>, opts: ArchiveReplayOpts<NormalizeTuple<T>>): {
    close: () => void;
    stats: () => {
        events: number;
        keyframes: number;
    };
};
export type HistorySubscribeOpts = {
    since?: number;
    ts?: number;
    onSeq?: (seq: number) => void;
};
export declare function openHistory<Z extends any[]>(storage: ReplayStorage<Z>, live?: {
    on: ListenOnReplay<Z>;
}): {
    at: (where?: {
        seq?: number;
        ts?: number;
    }) => ReplayEvent<Z>[] | undefined;
    subscribe: (cb: Listener<Z>, opts?: HistorySubscribeOpts) => (() => void) & {
        seq: () => number;
    };
};
