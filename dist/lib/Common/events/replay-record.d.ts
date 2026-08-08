import { ReplayEvent } from './replay-listen';
import { ReplayStorage } from './replay-history';
export type ReplayRecordCodec = {
    stringify: (v: any) => string;
    parse: (line: string) => any;
};
export declare function createJsonlReplayWriter<Z extends any[] = any[]>(write: (line: string) => void, codec?: ReplayRecordCodec): ReplayStorage<Z>;
export declare function loadJsonlReplay<Z extends any[] = any[]>(lines: Iterable<string> | string, codec?: ReplayRecordCodec): {
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
