import { type ReplicatedMap, type ReplicatedMapRemote } from '../Observe/replicated-map';
export type CommandReceiptRecord = {
    account: string;
    requestId: string;
    command: string;
    ts: number;
    result: unknown;
};
export declare function commandReceiptKey(account: string, requestId: string): string;
export type CommandReceiptsDeps = {
    initial?: Iterable<CommandReceiptRecord>;
    lineId?: string;
    replay?: {
        history?: number;
        keepMs?: number;
        describe?: Record<string, any>;
    };
};
export type CommandReceiptLine = Pick<ReplicatedMap<CommandReceiptRecord>['control'], 'set' | 'delete' | 'snapshot'>;
export type CommandReceiptsRemote = ReplicatedMapRemote<CommandReceiptRecord>;
export declare function createCommandReceipts(deps?: CommandReceiptsDeps): {
    api: ReplicatedMapRemote<CommandReceiptRecord, string>;
    control: {
        set: (value: CommandReceiptRecord) => void;
        setMany: (values: Iterable<CommandReceiptRecord>) => void;
        delete: (key: string) => void;
        deleteMany: (keys: Iterable<string>) => void;
        replaceAll: (values: Iterable<CommandReceiptRecord>) => void;
        has: (key: string) => boolean;
        get: (key: string) => CommandReceiptRecord | undefined;
        snapshot: () => Partial<Record<string, CommandReceiptRecord>>;
        flush: () => void;
        close: () => void;
    };
};
export type CommandReceipts = ReturnType<typeof createCommandReceipts>;
