import { ReplayEvent } from '../Common/events/replay-listen';
export type FsReplayStorageOpts = {
    codec?: {
        stringify: (v: any) => string;
        parse: (line: string) => any;
    };
    maxBytes?: number;
};
export declare function openFsReplayStorage<Z extends any[] = any[]>(file: string, opts?: FsReplayStorageOpts): {
    putEvent: (event: ReplayEvent<Z>) => void;
    putEvents: (events: readonly ReplayEvent<Z>[]) => void;
    putKeyframe: (keyframe: ReplayEvent<Z>) => void;
    getKeyframe: (at?: {
        seq?: number;
        ts?: number;
    }) => ReplayEvent<Z>;
    getEvents: (from: number, to: number) => ReplayEvent<Z>[];
    compact: () => void;
    size: () => {
        events: number;
        keyframes: number;
        bytes: number;
        overBudget: boolean;
    };
};
export type FsReplayStorage = ReturnType<typeof openFsReplayStorage>;
