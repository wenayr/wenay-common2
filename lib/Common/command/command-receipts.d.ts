import { type Store } from '../Observe/store';
import { type StoreReplayOpts, type StoreReplayRemote } from '../Observe/store-replay';
export type CommandReceiptRecord = {
    account: string;
    requestId: string;
    command: string;
    ts: number;
    result: unknown;
};
export type CommandReceiptsState = {
    receipts: Record<string, CommandReceiptRecord>;
};
export declare function commandReceiptKey(account: string, requestId: string): string;
export type CommandReceiptLine = {
    set(record: CommandReceiptRecord): void;
    delete(key: string): void;
    snapshot(): Record<string, CommandReceiptRecord | undefined>;
};
export type CommandReceiptsDeps<S extends CommandReceiptsState = CommandReceiptsState> = {
    store?: Store<S>;
    initial?: Iterable<CommandReceiptRecord>;
    replay?: Pick<StoreReplayOpts, 'history' | 'keepMs' | 'describe'>;
};
export type CommandReceiptsRemote = StoreReplayRemote;
export declare function createCommandReceipts<S extends CommandReceiptsState = CommandReceiptsState>(deps?: CommandReceiptsDeps<S>): {
    api: StoreReplayRemote | null;
    control: CommandReceiptLine & {
        get: (key: string) => CommandReceiptRecord;
        flush: () => void;
        close: () => void;
    };
    store: Store<CommandReceiptsState>;
    close: () => void;
};
export type CommandReceipts = ReturnType<typeof createCommandReceipts>;
