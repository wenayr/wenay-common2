import type { CommandFragment, CommandHost, tCommandMap } from './command-host';
export type CommandTokenFragment<Cmds extends tCommandMap> = {
    [K in keyof Cmds]: (token: unknown, requestId: string, input: Parameters<Cmds[K]>[1]) => Promise<Awaited<ReturnType<Cmds[K]>>>;
};
export type VerifyCommandsDeps<Cmds extends tCommandMap> = {
    host: Pick<CommandHost<Cmds>, 'execute' | 'names'>;
    accountOf: (token: unknown) => string | Promise<string>;
};
export declare function verifyCommands<Cmds extends tCommandMap>(deps: VerifyCommandsDeps<Cmds>): {
    fragment: () => CommandTokenFragment<Cmds>;
    names: (keyof Cmds & string)[];
};
export type VerifiedCommands<Cmds extends tCommandMap = tCommandMap> = ReturnType<typeof verifyCommands<Cmds>>;
export type ForwardCommandsByTokenDeps<Cmds extends tCommandMap> = {
    upstream: CommandTokenFragment<Cmds>;
    names: readonly (keyof Cmds & string)[];
};
export declare function forwardCommandsByToken<Cmds extends tCommandMap>(deps: ForwardCommandsByTokenDeps<Cmds>): {
    fragment: (token: unknown) => CommandFragment<Cmds>;
    names: readonly (keyof Cmds & string)[];
};
export type TokenForwardedCommands<Cmds extends tCommandMap = tCommandMap> = ReturnType<typeof forwardCommandsByToken<Cmds>>;
