import { ReplayEvent } from '../Common/events/replay-listen';
export type FsReplayStorageOpts = {
    codec?: {
        stringify: (v: any) => string;
        parse: (line: string) => any;
    };
};
export declare function openFsReplayStorage<Z extends any[] = any[]>(file: string, opts?: FsReplayStorageOpts): {
    putEvent: (ev: ReplayEvent<Z>) => void;
    putKeyframe: (kf: ReplayEvent<Z>) => void;
    getKeyframe: (at?: {
        seq?: number;
        ts?: number;
    }) => ReplayEvent<Z>;
    getEvents: (from: number, to: number) => ReplayEvent<Z>[];
    compact: () => void;
    size: () => {
        events: number;
        keyframes: number;
    };
};
export type FsReplayStorage = ReturnType<typeof openFsReplayStorage>;
