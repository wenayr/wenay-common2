import { Listener, NormalizeTuple } from './Listen';
import { ListenReplayApi, ReplayEvent, StaleInfo } from './replay-listen';
import { conflateReplay, ConflateOpts } from './replay-conflate';
export type ReplayExpose<T> = {
    line: ListenReplayApi<T>['line'];
    since: (seq: number) => ReplayEvent<NormalizeTuple<T>>[] | null;
    keyframe: () => ReplayEvent<NormalizeTuple<T>> | null;
    frame: ListenReplayApi<T>['frame'];
};
export declare function exposeReplay<T>(replay: ListenReplayApi<T>): ReplayExpose<T>;
export declare function exposeReplay<T>(replay: ListenReplayApi<T>, opts: {
    conflate: ConflateOpts<NormalizeTuple<T>>;
}): ReplayExpose<T> & {
    close: () => void;
    stats: ReturnType<typeof conflateReplay<T>>['stats'];
};
export type ReplayRemote<Z extends any[] = any[]> = {
    line: {
        on: (cb: (ev: ReplayEvent<Z>) => void) => any;
    };
    since: (seq: number) => Promise<ReplayEvent<Z>[] | null | undefined> | ReplayEvent<Z>[] | null | undefined;
    keyframe: () => Promise<ReplayEvent<Z> | null | undefined> | ReplayEvent<Z> | null | undefined;
    frame?: (seq: number, hint?: unknown) => Promise<ReplayEvent<Z>[] | null | undefined> | ReplayEvent<Z>[] | null | undefined;
    frameLine?: {
        on: (cb: (ev: ReplayEvent<Z>) => void) => any;
    };
    describe?: () => Promise<Record<string, any> | null | undefined> | Record<string, any> | null | undefined;
};
export type ReplaySubscribeOpts = {
    since?: number;
    onSeq?: (seq: number) => void;
    onError?: (e: any) => void;
    onLive?: () => void;
    staleMs?: number;
    onStale?: (info: StaleInfo) => void;
    skewMs?: number;
    now?: () => number;
    policy?: 'queue' | 'frame';
    hint?: unknown;
};
export declare function readReplayDescriptor(remote: Pick<ReplayRemote, 'describe'>): Promise<Record<string, any> | null>;
export declare function replaySubscribe<Z extends any[]>(remote: ReplayRemote<Z>, cb: Listener<Z>, opts?: ReplaySubscribeOpts): (() => void) & {
    ready: Promise<void>;
    seq: () => number;
    isStale: () => boolean;
    lastTs: () => number;
};
