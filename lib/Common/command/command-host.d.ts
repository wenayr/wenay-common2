export type CommandCtx = {
    account: string;
    requestId: string;
    command: string;
};
export type tCommandMap = Record<string, (ctx: CommandCtx, input: any) => unknown>;
export type CommandFragment<Cmds extends tCommandMap> = {
    [K in keyof Cmds]: (requestId: string, input: Parameters<Cmds[K]>[1]) => Promise<Awaited<ReturnType<Cmds[K]>>>;
};
export type CommandForwardFragment<Cmds extends tCommandMap> = {
    [K in keyof Cmds]: (account: string, requestId: string, input: Parameters<Cmds[K]>[1]) => Promise<Awaited<ReturnType<Cmds[K]>>>;
};
export type CommandHostDeps<Cmds extends tCommandMap> = {
    commands: Cmds;
    limits?: {
        perMinute?: number;
    };
    receipts?: {
        keepMs?: number;
        maxPerAccount?: number;
    };
    now?: () => number;
};
export declare const COMMAND_RECEIPT_KEEP_MS: number;
export declare const COMMAND_RECEIPTS_PER_ACCOUNT = 1024;
export declare function createCommandHost<Cmds extends tCommandMap>(deps: CommandHostDeps<Cmds>): {
    execute: <K extends keyof Cmds & string>(account: string, command: K, requestId: string, input: Parameters<Cmds[K]>[1]) => Promise<Awaited<ReturnType<Cmds[K]>>>;
    fragment: (account: string) => CommandFragment<Cmds>;
    forwardFragment: () => CommandForwardFragment<Cmds>;
    names: (keyof Cmds & string)[];
    stats: () => {
        accounts: number;
        receipts: number;
        executions: number;
        duplicates: number;
    };
    close(): void;
};
export type CommandHost<Cmds extends tCommandMap = tCommandMap> = ReturnType<typeof createCommandHost<Cmds>>;
export type ForwardCommandsDeps<Cmds extends tCommandMap> = {
    upstream: CommandForwardFragment<Cmds>;
    names: readonly (keyof Cmds & string)[];
};
export declare function forwardCommands<Cmds extends tCommandMap>(deps: ForwardCommandsDeps<Cmds>): {
    fragment: (account: string) => CommandFragment<Cmds>;
    names: readonly (keyof Cmds & string)[];
};
export type ForwardedCommands<Cmds extends tCommandMap = tCommandMap> = ReturnType<typeof forwardCommands<Cmds>>;
