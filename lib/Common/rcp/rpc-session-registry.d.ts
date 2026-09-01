import type { RpcServerControl } from './rpc-server';
export declare function createSessionRegistry(): {
    track: (account: string, control: RpcServerControl) => void;
    untrack: (account: string, control: RpcServerControl) => void;
    cut: (account: string, reason: string) => number;
};
export type SessionRegistry = ReturnType<typeof createSessionRegistry>;
