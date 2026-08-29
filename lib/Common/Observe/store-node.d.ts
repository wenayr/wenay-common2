import type { RpcOpt } from '../rcp/rpc-caps';
import type { SocketTmpl } from '../rcp/rpc-protocol';
import { type CommandTokenFragment } from '../command/command-token';
import type { tCommandMap } from '../command/command-host';
import { type StoreReplicaSession } from './store-replica-set';
import { type ReplicatedMapRemote } from './replicated-map';
import { type NodeDirectoryEntry } from './node-directory';
export type StoreNodeRevocation = {
    account: string;
    ts: number;
};
export type StoreNodePrincipal = {
    account: string;
    expiresAt?: number;
};
export type StoreNodeUpstream = {
    replica: StoreReplicaSession['remote'];
    directory: ReplicatedMapRemote<NodeDirectoryEntry>;
    revoked?: ReplicatedMapRemote<StoreNodeRevocation>;
    commandsByToken?: CommandTokenFragment<tCommandMap>;
    register: (entry: {
        nodeId: string;
        url: string;
        weight: number;
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
    nodeId: string;
    storeId: string;
    originId: string;
    lineId?: string;
    initial?: T;
    weight?: number;
    heartbeatMs?: number;
    graceMs?: number;
    auth?: {
        verify: (token: unknown) => StoreNodePrincipal;
        renewBeforeMs?: number;
    };
    commands?: readonly string[];
    upstream: () => Promise<StoreNodeUpstream> | StoreNodeUpstream;
    serve: {
        onConnection(handler: (socket: SocketTmpl) => void): void;
    };
    selfUrl: () => string;
    onLeave: (reason: string) => void;
    wrap?: (fragment: Record<string, unknown>) => object;
    socketKeys?: {
        read?: string;
        write?: string;
    };
    opt?: RpcOpt;
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
            readers: number;
            seq: number | undefined;
        };
    };
    close: () => void;
};
export type StoreNodeInstance = ReturnType<typeof createStoreNode>;
