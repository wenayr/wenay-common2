import { Listener, ListenApi, ListenCurrent, ListenCurrentProvider, ListenOnBrand, ListenOptions, NormalizeTuple } from './Listen';
type key = string | symbol;
type cbClose = () => void;
export declare const IS_REPLAY_LISTEN: unique symbol;
export declare function isReplayListen(obj: any): obj is ListenReplayApi<any>;
export type ReplayEvent<Z extends any[] = any[]> = {
    seq: number;
    ts: number;
    event: Z;
};
export type StaleInfo = {
    stale: boolean;
    lastTs: number;
    age: number;
};
export type ReplayListenOptions<Z extends any[]> = {
    current?: ListenCurrentProvider<Z> | 'last';
    frame?: (tail: ReplayEvent<Z>[], hint?: unknown) => ReplayEvent<Z>[];
    history?: number;
    getSince?: (seq: number) => ReplayEvent<Z>[] | undefined;
    onJournal?: (ev: ReplayEvent<Z>) => void;
    onJournalBatch?: (events: readonly ReplayEvent<Z>[]) => void;
    now?: () => number;
    firstSeq?: number;
    staleMs?: number;
    onStale?: (info: StaleInfo) => void;
};
type ReplayOnOptions<Z extends any[]> = {
    cbClose?: cbClose;
    key?: key;
    current?: ListenCurrent<Z>;
    since?: number;
    onSeq?: (seq: number) => void;
};
export type ListenOnReplay<Z extends any[] = any[]> = ((cb: Listener<Z>, opts?: ReplayOnOptions<Z>) => (() => void)) & ListenOnBrand<Z>;
export declare function withReplayListen<T>(base: ListenApi<T>, options?: ReplayListenOptions<NormalizeTuple<T>>): {
    emit: Listener<NormalizeTuple<T>>;
    emitBatch: (events: readonly NormalizeTuple<T>[]) => void;
    head: () => number;
    isStale: () => boolean;
    lastTs: () => number;
    close: () => void;
    getSince: (seq: number) => ReplayEvent<NormalizeTuple<T>>[] | undefined;
    line: ListenApi<[ReplayEvent<NormalizeTuple<T>>]>;
    hasKeyframe: boolean;
    keyframe: () => ReplayEvent<NormalizeTuple<T>> | undefined;
    frame: (sinceSeq: number, hint?: unknown) => ReplayEvent<NormalizeTuple<T>>[];
    on: ListenOnReplay<NormalizeTuple<T>>;
    once: (cb: Listener<NormalizeTuple<T>>, opts?: {
        key?: key;
        current?: ListenCurrent<NormalizeTuple<T>> | undefined;
    }) => () => void;
    has(key: import("./Listen").ListenKey): boolean;
    off(keyOrCallback: import("./Listen").ListenKey | Listener<NormalizeTuple<T>> | null): void;
    count(): number;
    keys(): import("./Listen").ListenKey[];
    isRunning(): boolean;
    run(): void;
    onClose(cb: () => void): import("./Listen").ListenOff;
};
export type ListenReplayApi<T> = ReturnType<typeof withReplayListen<T>>;
export type ReplayListenUseOptions<T> = ListenOptions<T> & ReplayListenOptions<NormalizeTuple<T>>;
export declare function replayListen<T>(options?: ReplayListenUseOptions<T>): readonly [(...a: NormalizeTuple<T>) => void, {
    emit: Listener<NormalizeTuple<T>>;
    emitBatch: (events: readonly NormalizeTuple<T>[]) => void;
    head: () => number;
    isStale: () => boolean;
    lastTs: () => number;
    close: () => void;
    getSince: (seq: number) => ReplayEvent<NormalizeTuple<T>>[] | undefined;
    line: ListenApi<[ReplayEvent<NormalizeTuple<T>>]>;
    hasKeyframe: boolean;
    keyframe: () => ReplayEvent<NormalizeTuple<T>> | undefined;
    frame: (sinceSeq: number, hint?: unknown) => ReplayEvent<NormalizeTuple<T>>[];
    on: ListenOnReplay<NormalizeTuple<T>>;
    once: (cb: Listener<NormalizeTuple<T>>, opts?: {
        key?: key;
        current?: ListenCurrent<NormalizeTuple<T>> | undefined;
    }) => () => void;
    has(key: import("./Listen").ListenKey): boolean;
    off(keyOrCallback: import("./Listen").ListenKey | Listener<NormalizeTuple<T>> | null): void;
    count(): number;
    keys(): import("./Listen").ListenKey[];
    isRunning(): boolean;
    run(): void;
    onClose(cb: () => void): import("./Listen").ListenOff;
}];
export {};
