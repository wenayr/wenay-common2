import { FollowReplicatedMapOpts, ReplicatedMapRemote, ReplicatedMapState, tReplicatedMapDelivery } from './replicated-map';
import { StoreReplicaOffer, StoreReplicaSession } from './store-replica-set';
export type tNodeDirectoryRole = 'leader' | 'mirror';
export type NodeDirectoryEntry = {
    nodeId: string;
    url: string;
    role: tNodeDirectoryRole;
    weight: number;
    draining: boolean;
    ts: number;
    meta?: Record<string, unknown>;
};
export type NodeDirectoryView = NodeDirectoryEntry & {
    stale: boolean;
    eligible: boolean;
};
export declare const NODE_DIRECTORY_STALE_MS = 15000;
export type NodeDirectoryDeps = {
    now?: () => number;
    lineId?: string;
    replay?: {
        history?: number;
        keepMs?: number;
        describe?: Record<string, any>;
    };
};
export declare function createNodeDirectory(deps?: NodeDirectoryDeps): {
    api: ReplicatedMapRemote<NodeDirectoryEntry, string>;
    control: {
        upsert: (entry: Omit<NodeDirectoryEntry, 'ts' | 'draining'> & {
            draining?: boolean;
        }) => void;
        heartbeat: (nodeId: string, patch?: Partial<Omit<NodeDirectoryEntry, 'nodeId' | 'ts'>>) => boolean;
        drain: (nodeId: string) => boolean;
        undrain: (nodeId: string, weight?: number) => boolean;
        remove: (nodeId: string) => void;
        get: (key: string) => NodeDirectoryEntry | undefined;
        snapshot: () => Partial<Record<string, NodeDirectoryEntry>>;
        flush: () => void;
        close: () => void;
    };
};
export type NodeDirectory = ReturnType<typeof createNodeDirectory>;
export type NodeDirectoryViewOpts = {
    staleMs?: number;
    now?: () => number;
};
export declare function nodeDirectoryViews(state: Readonly<ReplicatedMapState<NodeDirectoryEntry>>, opts?: NodeDirectoryViewOpts): NodeDirectoryView[];
export type PickDirectoryNodeOpts = {
    exclude?: string | readonly string[];
    rng?: () => number;
};
export declare function pickDirectoryNode(views: readonly NodeDirectoryView[], opts?: PickDirectoryNodeOpts): NodeDirectoryView | null;
export type FollowNodeDirectoryOpts = NodeDirectoryViewOpts & Pick<FollowReplicatedMapOpts<NodeDirectoryEntry>, 'initial' | 'drain' | 'onStatus' | 'onError'>;
export declare function followNodeDirectory(remote: ReplicatedMapRemote<NodeDirectoryEntry>, opts?: FollowNodeDirectoryOpts): {
    nodes: () => NodeDirectoryView[];
    pick: (pickOpts?: PickDirectoryNodeOpts) => NodeDirectoryView | null;
    onNodes: (cb: (views: NodeDirectoryView[]) => void) => import("../..").ListenOff;
    ready: Promise<void>;
    status: () => import("./replicated-map").ReplicatedMapStatus;
    statusChanges: {
        emit: import("../..").Listener<[import("./replicated-map").ReplicatedMapStatus]>;
        has(key: import("../..").ListenKey): boolean;
        off(keyOrCallback: import("../..").Listener<[import("./replicated-map").ReplicatedMapStatus]> | import("../..").ListenKey | null): void;
        close(): void;
        count(): number;
        keys(): import("../..").ListenKey[];
        isRunning(): boolean;
        run(): void;
        onClose(cb: () => void): import("../..").ListenOff;
        on: import("../..").ListenOnCurrent<[import("./replicated-map").ReplicatedMapStatus]>;
        once: (cb: import("../..").Listener<[import("./replicated-map").ReplicatedMapStatus]>, opts?: {
            key?: import("../..").ListenKey;
            current?: import("../..").ListenCurrent<[import("./replicated-map").ReplicatedMapStatus]> | undefined;
        }) => import("../..").ListenOff;
    };
    isStale: () => boolean;
    close: () => void;
    follow: {
        get: (key: string) => NodeDirectoryEntry | undefined;
        has: (key: string) => boolean;
        snapshot: () => Partial<Record<string, NodeDirectoryEntry>>;
        onKey: (key: string, cb: (value: NodeDirectoryEntry | undefined, ctx: import("./replicated-map").ReplicatedMapKeyContext<string>) => void, keyOpts?: {
            current?: boolean;
        }) => import("../..").ListenOff;
        batches: import("../..").ListenApi<[import("./replicated-map").ReplicatedMapChange<NodeDirectoryEntry, string>]>;
        keys: import("../..").ListenApi<[string, NodeDirectoryEntry | undefined, import("./replicated-map").ReplicatedMapKeyContext<string>]>;
        ready: Promise<void>;
        status: () => import("./replicated-map").ReplicatedMapStatus;
        statusChanges: {
            emit: import("../..").Listener<[import("./replicated-map").ReplicatedMapStatus]>;
            has(key: import("../..").ListenKey): boolean;
            off(keyOrCallback: import("../..").Listener<[import("./replicated-map").ReplicatedMapStatus]> | import("../..").ListenKey | null): void;
            close(): void;
            count(): number;
            keys(): import("../..").ListenKey[];
            isRunning(): boolean;
            run(): void;
            onClose(cb: () => void): import("../..").ListenOff;
            on: import("../..").ListenOnCurrent<[import("./replicated-map").ReplicatedMapStatus]>;
            once: (cb: import("../..").Listener<[import("./replicated-map").ReplicatedMapStatus]>, opts?: {
                key?: import("../..").ListenKey;
                current?: import("../..").ListenCurrent<[import("./replicated-map").ReplicatedMapStatus]> | undefined;
            }) => import("../..").ListenOff;
        };
        seq: () => number;
        replayMode: () => "v2";
        delivery: () => tReplicatedMapDelivery;
        checkpoint: () => import("./replicated-map").ReplicatedMapCheckpoint<NodeDirectoryEntry, string>;
        isStale: () => boolean;
        close: () => void;
        debug: {
            store: import("./store").Store<Partial<Record<string, NodeDirectoryEntry>>>;
        };
    };
};
export type FollowedNodeDirectory = ReturnType<typeof followNodeDirectory>;
export type DirectoryReplicaOffersDeps = {
    directory: Pick<FollowedNodeDirectory, 'nodes' | 'onNodes'>;
    connect: (node: NodeDirectoryView) => StoreReplicaSession | Promise<StoreReplicaSession>;
    priorityOf?: (node: NodeDirectoryView) => number;
};
export declare function directoryReplicaOffers(deps: DirectoryReplicaOffersDeps): {
    api: {
        list: () => StoreReplicaOffer[];
        changes: import("../..").ListenApi<[readonly StoreReplicaOffer[]]>;
    };
    refresh(): void;
    close(): void;
};
export type DirectoryReplicaOffers = ReturnType<typeof directoryReplicaOffers>;
