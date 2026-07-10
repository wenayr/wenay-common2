import { NormalizeTuple } from './Listen';
import { ListenReplayApi, ReplayEvent } from './replay-listen';
export type ConflateOpts<Z extends any[] = any[]> = {
    pending: () => number;
    highWater: number;
    lowWater?: number;
    pollMs?: number;
    keyOf?: (...event: Z) => PropertyKey | null | undefined;
    maxKeys?: number;
};
export declare function conflateReplay<T>(replay: ListenReplayApi<T>, opts: ConflateOpts<NormalizeTuple<T>>): {
    api: {
        line: import("./Listen").ListenApi<[ReplayEvent<NormalizeTuple<T>>]>;
        since: (seq: number) => ReplayEvent<NormalizeTuple<T>>[] | null;
        keyframe: () => ReplayEvent<NormalizeTuple<T>> | null;
        frame: (seq: number, hint?: unknown) => ReplayEvent<NormalizeTuple<T>>[];
    };
    close: () => void;
    stats: () => {
        conflating: boolean;
        dropped: number;
        keyframes: number;
        coalesced: number;
        flushes: number;
    };
};
