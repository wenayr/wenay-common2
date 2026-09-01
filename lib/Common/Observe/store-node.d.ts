import type { RpcOpt } from '../rcp/rpc-caps';
import type { SocketTmpl } from '../rcp/rpc-protocol';
import { type CommandTokenFragment } from '../command/command-token';
import type { tCommandMap } from '../command/command-host';
import { type StoreLineCoordinates, type StoreReplicaSession } from './store-replica-set';
import type { StoreReplayRemote } from './store-replay';
import type { NodeDirectoryState } from './node-directory';
export type StoreNodeRevocation = {
    account: string;
    ts: number;
};
export type StoreNodePrincipal = {
    account: string;
    expiresAt?: number;
};
export type StoreNodeControlState = NodeDirectoryState & {
    revoked: Record<string, StoreNodeRevocation>;
};
export type StoreNodeUpstream = {
    replica: StoreReplicaSession['remote'];
    control: StoreReplayRemote;
    commandsByToken?: CommandTokenFragment<tCommandMap>;
    register: (entry: {
        nodeId: string;
        url: string;
        weight: number;
        pid?: number;
        readers?: number;
    }) => unknown;
    heartbeat: (nodeId: string, facts?: {
        readers?: number;
    }) => unknown;
    goodbye: (nodeId: string) => unknown;
    onFail: {
        on: (cb: () => void) => () => void;
    };
};
export type StoreNodeDeps<T extends Record<string, any>> = {
    line: StoreLineCoordinates & {
        initial?: T;
    };
    roster: {
        url: () => string;
        weight?: number;
        heartbeatMs?: number;
        graceMs?: number;
    };
    upstream: () => Promise<StoreNodeUpstream> | StoreNodeUpstream;
    auth?: {
        verify: (token: unknown) => StoreNodePrincipal;
        renewBeforeMs?: number;
    };
    commands?: readonly string[];
    serve: {
        onConnection(handler: (socket: SocketTmpl) => void): void;
        wrap?: (fragment: Record<string, unknown>) => object;
        keys?: {
            read?: string;
            write?: string;
        };
        opt?: RpcOpt;
    };
    onLeave: (reason: string) => void;
    log?: (line: string) => void;
};
export declare function createStoreNode<T extends Record<string, any>>(deps: StoreNodeDeps<T>): {
    start: () => Promise<void>;
    leave: (reason: string) => void;
    view: {
        nodeId: string;
        status: () => {
            started: boolean;
            leaving: boolean;
            rehomes: number;
            readers: number;
            seq: number | undefined;
        };
    };
    close: () => void;
};
export type StoreNodeInstance = ReturnType<typeof createStoreNode>;
