import { Store, StoreDrain } from './store';
import { StoreReplayOpts, StoreReplayRemote, StoreReplaySyncOpts, tStoreReplayMode } from './store-replay';
export type tReplicatedMapDelivery = 'latest' | 'lossless';
export type ReplicatedMapState<V, K extends string = string> = Partial<Record<K, V>>;
export type ReplicatedMapSetOperation<V, K extends string = string> = {
    type: 'set';
    key: K;
    value: V;
};
export type ReplicatedMapDeleteOperation<K extends string = string> = {
    type: 'delete';
    key: K;
};
export type ReplicatedMapOperation<V, K extends string = string> = ReplicatedMapSetOperation<V, K> | ReplicatedMapDeleteOperation<K>;
export type ReplicatedMapChange<V, K extends string = string> = {
    delivery: tReplicatedMapDelivery;
    set: readonly (readonly [key: K, value: V])[];
    delete: readonly K[];
    operations: readonly ReplicatedMapOperation<V, K>[];
};
export type ReplicatedMapKeyContext<K extends string = string> = {
    key: K;
    exists: boolean;
};
export type tReplicatedMapFollowState = 'connecting' | 'live' | 'reconnecting' | 'stale' | 'error' | 'closed';
export type ReplicatedMapStatus = {
    state: tReplicatedMapFollowState;
    ready: boolean;
    stale: boolean;
    delivery: tReplicatedMapDelivery;
    replayMode: tStoreReplayMode;
    seq: number;
    error: unknown | null;
};
export type ReplicatedMapCursor = Pick<ReplicatedMapStatus, 'delivery' | 'replayMode' | 'seq'> & {
    lineId: string;
};
export type ReplicatedMapCheckpoint<V, K extends string = string> = {
    cursor: ReplicatedMapCursor;
    snapshot: ReplicatedMapState<V, K>;
};
export type ReplicatedMapDescriptor<V = unknown, K extends string = string> = {
    version: 1;
    delivery: tReplicatedMapDelivery;
    lineId: string;
    types?: {
        value: V;
        key: K;
    };
};
export type ReplicatedMapWireDescriptor<V = unknown, K extends string = string> = Record<string, any> & {
    replicatedMap: ReplicatedMapDescriptor<V, K>;
};
export type ReplicatedMapRemote<V, K extends string = string> = Omit<StoreReplayRemote, 'describe'> & {
    describe(): ReplicatedMapWireDescriptor<V, K> | Promise<ReplicatedMapWireDescriptor<V, K>>;
};
type ReplicatedMapOwnedDeps<V> = {
    initial?: Iterable<V>;
    store?: never;
};
type ReplicatedMapInjectedDeps<V, K extends string> = {
    initial?: never;
    store: Store<ReplicatedMapState<V, K>>;
    delivery: 'latest';
};
export type CreateReplicatedMapDeps<V, K extends string = string> = (ReplicatedMapOwnedDeps<V> | ReplicatedMapInjectedDeps<V, K>) & {
    keyOf(value: V): K;
    delivery: tReplicatedMapDelivery;
    lineId?: string;
    replay?: Omit<StoreReplayOpts, 'patchSource' | 'describe'> & {
        describe?: Record<string, any>;
    };
};
type FollowReplicatedMapBaseOpts<V, K extends string> = Omit<StoreReplaySyncOpts<ReplicatedMapState<V, K>>, 'onBatch' | 'policy' | 'catchUp' | 'gapPolicy' | 'prepareCatchUp' | 'since'> & {
    delivery?: tReplicatedMapDelivery;
    drain?: StoreDrain;
    onBatch?: (change: ReplicatedMapChange<V, K>) => void;
    onStatus?: (status: ReplicatedMapStatus) => void;
};
type ReplicatedMapColdFollow<V, K extends string> = {
    initial?: Readonly<ReplicatedMapState<V, K>>;
    checkpoint?: never;
};
type ReplicatedMapCheckpointFollow<V, K extends string> = {
    initial?: never;
    checkpoint: ReplicatedMapCheckpoint<V, K>;
};
export type FollowReplicatedMapOpts<V, K extends string = string> = FollowReplicatedMapBaseOpts<V, K> & (ReplicatedMapColdFollow<V, K> | ReplicatedMapCheckpointFollow<V, K>);
export declare function createReplicatedMap<V, K extends string = string>(deps: CreateReplicatedMapDeps<V, K>): {
    api: ReplicatedMapRemote<V, K>;
    control: {
        set: (value: V) => void;
        setMany: (values: Iterable<V>) => void;
        delete: (key: K) => void;
        deleteMany: (keys: Iterable<K>) => void;
        replaceAll: (values: Iterable<V>) => void;
        has: (key: K) => boolean;
        get: (key: K) => Partial<Record<K, V>>[K] | undefined;
        snapshot: () => Partial<Record<K, V>>;
        flush: () => void;
        close: () => void;
    };
};
export declare function followReplicatedMap<V, K extends string = string>(remote: ReplicatedMapRemote<V, K> | StoreReplayRemote, opts?: FollowReplicatedMapOpts<V, K>): {
    get: (key: K) => Partial<Record<K, V>>[K] | undefined;
    has: (key: K) => boolean;
    snapshot: () => Partial<Record<K, V>>;
    onKey: (key: K, cb: (value: V | undefined, ctx: ReplicatedMapKeyContext<K>) => void, keyOpts?: {
        current?: boolean;
    }) => import("../..").ListenOff;
    batches: import("../..").ListenApi<[ReplicatedMapChange<V, K>]>;
    keys: import("../..").ListenApi<[K, V | undefined, ReplicatedMapKeyContext<K>]>;
    ready: Promise<void>;
    status: () => ReplicatedMapStatus;
    statusChanges: {
        emit: import("../..").Listener<[ReplicatedMapStatus]>;
        has(key: import("../..").ListenKey): boolean;
        off(keyOrCallback: import("../..").Listener<[ReplicatedMapStatus]> | import("../..").ListenKey | null): void;
        close(): void;
        count(): number;
        keys(): import("../..").ListenKey[];
        isRunning(): boolean;
        run(): void;
        onClose(cb: () => void): import("../..").ListenOff;
        on: import("../..").ListenOnCurrent<[ReplicatedMapStatus]>;
        once: (cb: import("../..").Listener<[ReplicatedMapStatus]>, opts?: {
            key?: import("../..").ListenKey;
            current?: import("../..").ListenCurrent<[ReplicatedMapStatus]> | undefined;
        }) => import("../..").ListenOff;
    };
    seq: () => number;
    replayMode: () => "v2";
    delivery: () => tReplicatedMapDelivery;
    checkpoint: () => ReplicatedMapCheckpoint<V, K>;
    isStale: () => boolean;
    close: () => void;
    debug: {
        store: Store<Partial<Record<K, V>>>;
    };
};
export type ReplicatedMap<V, K extends string = string> = ReturnType<typeof createReplicatedMap<V, K>>;
export type FollowedReplicatedMap<V, K extends string = string> = ReturnType<typeof followReplicatedMap<V, K>>;
export {};
