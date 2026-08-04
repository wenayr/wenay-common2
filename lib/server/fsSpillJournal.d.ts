import { ReplayEvent } from '../Common/events/replay-listen';
export type FsSpillJournalOpts = {
    history: number;
    maxBytes: number;
    codec?: {
        stringify: (v: any) => string;
        parse: (line: string) => any;
    };
};
export declare function openFsSpillJournal<Z extends any[] = any[]>(file: string, opts: FsSpillJournalOpts): {
    line: {
        getSince: (seq: number) => ReplayEvent<Z>[] | undefined;
        onJournal: (ev: ReplayEvent<Z>) => void;
    };
    size: () => {
        ramEvents: number;
        diskEvents: number;
        diskBytes: number;
        oldestSeq: number | null;
        head: number;
        spillErrors: number;
    };
    close: () => void;
};
export type FsSpillJournal = ReturnType<typeof openFsSpillJournal>;
