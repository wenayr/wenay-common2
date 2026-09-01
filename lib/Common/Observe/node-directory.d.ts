import { type Store } from './store';
import { type StoreReplayOpts, type StoreReplayRemote } from './store-replay';
import { type StoreFollowerDeps } from './store-follower';
import { type StoreReplicaOffer, type StoreReplicaSession } from './store-replica-set';
export type tNodeDirectoryRole = 'leader' | 'mirror' | 'standby';
export type NodeDirectoryEntry = {
    nodeId: string;
    url: string;
    role: tNodeDirectoryRole;
    weight: number;
    draining: boolean;
    alive: boolean;
    since: number;
    meta?: Record<string, unknown>;
};
export type NodeDirectoryView = NodeDirectoryEntry & {
    eligible: boolean;
};
export type NodeDirectoryState = {
    nodes: Record<string, NodeDirectoryEntry>;
};
export declare const NODE_DIRECTORY_STALE_MS = 15000;
export type NodeDirectoryDeps<S extends NodeDirectoryState = NodeDirectoryState> = {
    store?: Store<S>;
    now?: () => number;
    staleMs?: number;
    sweepMs?: number;
    initial?: Iterable<NodeDirectoryEntry>;
    replay?: Pick<StoreReplayOpts, 'history' | 'keepMs' | 'describe'>;
};
export type NodeDirectoryRow = Omit<NodeDirectoryEntry, 'alive' | 'since' | 'draining'> & {
    draining?: boolean;
};
export declare function createNodeDirectory<S extends NodeDirectoryState = NodeDirectoryState>(deps?: NodeDirectoryDeps<S>): {
    api: StoreReplayRemote | null;
    control: {
        set: (row: NodeDirectoryRow) => void;
        patch: (nodeId: string, partial: Partial<Omit<NodeDirectoryEntry, 'nodeId' | 'alive' | 'since'>>) => boolean;
        heartbeat: (nodeId: string, partial?: Parameters<(nodeId: string, partial: Partial<Omit<NodeDirectoryEntry, 'nodeId' | 'alive' | 'since'>>) => boolean>[1]) => boolean;
        drain: (nodeId: string) => boolean;
        undrain: (nodeId: string, weight?: number) => boolean;
        remove: (nodeId: string) => void;
        grace: () => void;
        sweep: () => void;
        get: (nodeId: string) => NodeDirectoryEntry | undefined;
        snapshot: () => Record<string, NodeDirectoryEntry>;
        flush: () => void;
        close: () => void;
    };
    view: {
        nodes: () => NodeDirectoryView[];
    };
    store: Store<NodeDirectoryState>;
    close: () => void;
};
export type NodeDirectory = ReturnType<typeof createNodeDirectory>;
export declare function nodeDirectoryViews(state: Readonly<Record<string, NodeDirectoryEntry | undefined>>): NodeDirectoryView[];
export type PickDirectoryNodeOpts = {
    exclude?: string | readonly string[];
    rng?: () => number;
};
export declare function pickDirectoryNode(views: readonly NodeDirectoryView[], opts?: PickDirectoryNodeOpts): NodeDirectoryView | null;
export type FollowNodeDirectoryOpts = Pick<StoreFollowerDeps<NodeDirectoryState>, 'initial' | 'staleMs' | 'expose'>;
export declare function followNodeDirectory(remote: StoreReplayRemote, opts?: FollowNodeDirectoryOpts): {
    nodes: () => NodeDirectoryView[];
    pick: (pickOpts?: PickDirectoryNodeOpts) => NodeDirectoryView | null;
    onNodes: (cb: (views: NodeDirectoryView[]) => void) => () => void;
    onNode: (nodeId: string, cb: (entry: NodeDirectoryEntry | undefined) => void, watchOpts?: {
        current?: boolean;
    }) => () => void;
    ready: Promise<void>;
    status: Store<import("./store-follower").FollowerStatus>;
    isStale: () => boolean;
    api: {
        get(): NodeDirectoryState;
        get<M extends import("./store").StoreMask<NodeDirectoryState>>(mask: M): import("./store").StorePick<NodeDirectoryState, M>;
        set(path: import("./store").StorePath, value: any): void;
        replace(path: import("./store").StorePath, value: any): void;
        changed: any;
        changedPaths: any;
        replay: {
            line: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            } & import("./store-replay").StoreReplayLineLocal;
            since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
            keyframe: () => Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
            frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
            frameLine?: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            } | undefined;
            chunks?: {
                begin: (opts?: {
                    budgetBytes?: number;
                }) => Promise<import("./store-replay").StoreReplayChunksBegin<import("./store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("./store-replay").StoreReplayChunksBegin<import("./store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                pull: (snapshotId: string, index: number) => Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                end?: (snapshotId: string) => unknown;
            } | undefined;
            describe: () => Record<string, any>;
        } | ({
            line: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            };
            since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
            keyframe: () => Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
            frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
            frameLine?: {
                on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
            } | undefined;
            chunks?: {
                begin: (opts?: {
                    budgetBytes?: number;
                }) => Promise<import("./store-replay").StoreReplayChunksBegin<import("./store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("./store-replay").StoreReplayChunksBegin<import("./store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                pull: (snapshotId: string, index: number) => Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                end?: (snapshotId: string) => unknown;
            } | undefined;
        } & {
            line: import("./store-replay").StoreReplayLineLocal;
        });
    };
    store: Store<NodeDirectoryState>;
    close: () => void;
};
export type FollowedNodeDirectory = ReturnType<typeof followNodeDirectory>;
export type DirectoryReplicaOffersDeps = {
    directory: Pick<FollowedNodeDirectory, 'nodes' | 'onNodes'>;
    connect: (node: NodeDirectoryView) => StoreReplicaSession | Promise<StoreReplicaSession>;
    priorityOf?: (node: NodeDirectoryView) => number;
};
export declare function directoryRoutePriority(view: Pick<NodeDirectoryView, 'weight'>): number;
export declare function directoryReplicaOffers(deps: DirectoryReplicaOffersDeps): {
    api: {
        list: () => StoreReplicaOffer[];
        changes: import("../..").ListenApi<[readonly StoreReplicaOffer[]]>;
    };
    refresh(): void;
    close(): void;
};
export type DirectoryReplicaOffers = ReturnType<typeof directoryReplicaOffers>;
