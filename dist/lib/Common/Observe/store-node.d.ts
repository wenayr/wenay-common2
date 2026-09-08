import type { RpcOpt } from '../rcp/rpc-caps';
import type { SocketTmpl } from '../rcp/rpc-protocol';
import { type CommandTokenFragment } from '../command/command-token';
import type { CommandFragment, tCommandMap } from '../command/command-host';
import { type StoreLineCoordinates, type StoreReplicaRemote, type StoreReplicaSession } from './store-replica-set';
import type { StoreReplayRemote } from './store-replay';
import type { Store } from './store';
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
export type StoreNodeUpstream<T extends object = any, Cmds extends tCommandMap = tCommandMap> = {
    replica: StoreReplicaSession<T>['remote'];
    control: StoreReplayRemote<StoreNodeControlState>;
    commandsByToken?: CommandTokenFragment<Cmds>;
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
export type StoreNodeReaderDefaults<T extends object = any> = {
    replica: StoreReplicaRemote<T>;
    node: () => string;
    store: Store<T>;
};
export type StoreNodePrincipalDefaults<T extends object = any, Cmds extends tCommandMap = tCommandMap> = {
    whoami: () => string;
    commands?: CommandFragment<Cmds>;
    store: Store<T>;
};
export type StoreNodeSession = {
    nodeId: string;
    onGone: (cb: () => void) => () => void;
};
export type StoreNodeAudience<T extends Record<string, any>, Cmds extends tCommandMap = tCommandMap> = {
    reader?: (defaults: StoreNodeReaderDefaults<T>) => Record<string, unknown> | null;
    principal?: (principal: StoreNodePrincipal, defaults: StoreNodePrincipalDefaults<T, Cmds>, session: StoreNodeSession) => Record<string, unknown>;
};
export type StoreNodeDeps<T extends Record<string, any>, Cmds extends tCommandMap = tCommandMap> = {
    line: StoreLineCoordinates & {
        initial?: T;
    };
    roster: {
        url: () => string;
        weight?: number;
        heartbeatMs?: number;
        graceMs?: number;
    };
    upstream: () => Promise<StoreNodeUpstream<NoInfer<T>, Cmds>> | StoreNodeUpstream<NoInfer<T>, Cmds>;
    auth?: {
        verify: (token: unknown) => StoreNodePrincipal;
        renewBeforeMs?: number;
    };
    commands?: readonly (keyof NoInfer<Cmds> & string)[];
    serve: {
        onConnection(handler: (socket: SocketTmpl) => void): void;
        wrap?: (fragment: Record<string, unknown>) => object;
        keys?: {
            read?: string;
            write?: string;
        };
        opt?: RpcOpt;
        audience?: StoreNodeAudience<T, Cmds>;
    };
    onLeave: (reason: string) => void;
    log?: (line: string) => void;
};
export declare function createStoreNode<T extends Record<string, any>, Cmds extends tCommandMap = tCommandMap>(deps: StoreNodeDeps<T, Cmds>): {
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
export type StoreNodeInstance<T extends Record<string, any> = Record<string, any>, Cmds extends tCommandMap = tCommandMap> = ReturnType<typeof createStoreNode<T, Cmds>>;
