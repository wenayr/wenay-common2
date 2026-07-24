import { createStore, Store, StoreMask, StoreSyncOpts } from './store';
import { OfflineStorage, OfflineStore } from './store-offline';
import { StoreReplayRemote, StoreReplaySyncOpts } from './store-replay';
type RemoteStore<T extends object> = {
    get(mask?: any): T | Promise<T>;
    changed: any;
    changedPaths?: any;
    patches?: any;
    patchesBatch?: any;
    changedData?: any;
};
export type StoreMirror<T extends object> = Store<T> & {
    sync<M extends StoreMask<T>>(mask: M, opts?: StoreSyncOpts): Promise<() => void>;
    syncPatches<M extends StoreMask<T>>(mask: M, opts?: StoreSyncOpts): Promise<() => void>;
    syncChangedData<M extends StoreMask<T>>(mask: M, opts?: StoreSyncOpts): Promise<() => void>;
};
export type ManagedStoreKind = 'mirror' | 'replay' | 'offline';
export type ManagedStoreState = 'idle' | 'starting' | 'ready' | 'stopped' | 'error';
export type ManagedStoreSyncMode = 'pull' | 'patches' | 'changedData';
export type ManagedStoreUsage = {
    count: number;
    weight: number;
    lastUsedAt?: number;
};
export type ManagedStorePriorityContext = {
    key: string;
    now: number;
    usage?: ManagedStoreUsage;
};
type CommonResource<T extends object> = {
    key?: string;
    initial: T;
    tags?: readonly string[];
    priority?: number | ((ctx: ManagedStorePriorityContext) => number);
    usageKey?: string;
    explicitOnly?: boolean;
    large?: boolean;
    autoStart?: boolean;
    storeOpts?: Parameters<typeof createStore<T>>[1];
};
export type ManagedMirrorResource<T extends object> = CommonResource<T> & {
    kind?: 'mirror';
    remote: RemoteStore<T>;
    mask: StoreMask<T>;
    sync?: {
        mode?: ManagedStoreSyncMode;
        opts?: StoreSyncOpts;
    };
};
export type ManagedReplayResource<T extends object> = CommonResource<T> & {
    kind?: 'replay';
    remote: StoreReplayRemote;
    syncOpts?: StoreReplaySyncOpts<T>;
};
export type ManagedOfflineResource<T extends object> = CommonResource<T> & {
    kind?: 'offline';
    remote?: StoreReplayRemote;
    storage: OfflineStorage;
    storageKey?: string;
    version?: number;
    debounceMs?: number;
    syncOpts?: StoreReplaySyncOpts<T>;
    migrate?: (oldSnapshot: unknown, fromVersion: number, toVersion: number) => T | Promise<T>;
};
export type ManagedStoreResource<T extends object = any> = ManagedMirrorResource<T> | ManagedReplayResource<T> | ManagedOfflineResource<T>;
export type ManagedStoreResources = Record<string, ManagedStoreResource<any>>;
export type ManagedStoreOf<R> = R extends ManagedOfflineResource<infer T> ? OfflineStore<T> : R extends ManagedReplayResource<infer T> ? Store<T> : R extends ManagedMirrorResource<infer T> ? StoreMirror<T> : never;
export type ManagedStoreStatus = {
    key: string;
    state: ManagedStoreState;
    kind: ManagedStoreKind;
    error?: unknown;
    startedAt?: number;
    stoppedAt?: number;
};
export type ManagedStorePlanItem = {
    key: string;
    kind: ManagedStoreKind;
    score: number;
    state: ManagedStoreState;
    large: boolean;
    explicitOnly: boolean;
    tags: readonly string[];
};
export type ManagedStoreStartOpts = {
    explicit?: boolean;
    reason?: string;
};
export type ManagedStorePlanOpts = {
    keys?: Iterable<string>;
    tags?: readonly string[];
    includeLarge?: boolean;
    includeExplicit?: boolean;
    limit?: number;
    now?: number;
};
export type ManagedStoreHandle<TStore> = {
    readonly key: string;
    readonly kind: ManagedStoreKind;
    start(opts?: ManagedStoreStartOpts): Promise<TStore>;
    stop(): void;
    get(): TStore | undefined;
    status(): ManagedStoreStatus;
    touch(weight?: number): void;
};
export declare const managedStore: {
    mirror<T extends object>(resource: ManagedMirrorResource<T>): ManagedMirrorResource<T>;
    replay<T extends object>(resource: ManagedReplayResource<T>): ManagedReplayResource<T>;
    offline<T extends object>(resource: ManagedOfflineResource<T>): ManagedOfflineResource<T>;
};
export declare function createStoreManager<const R extends ManagedStoreResources>(resources: R): {
    handles: { [K in keyof R]: ManagedStoreHandle<ManagedStoreOf<R[K]>>; };
    statusListen: import("../events/Listen").ListenApi<[ManagedStoreStatus]>;
    plan: (opts?: ManagedStorePlanOpts) => ManagedStorePlanItem[];
    start: <K extends keyof R & string>(key: K, opts?: ManagedStoreStartOpts) => Promise<ManagedStoreOf<R[K]>>;
    startMany: (keys: Iterable<keyof R & string>, opts?: ManagedStoreStartOpts) => Promise<Partial<{ [K in keyof R]: ManagedStoreOf<R[K]>; }>>;
    startPlanned: (opts?: ManagedStorePlanOpts & ManagedStoreStartOpts) => Promise<Partial<{ [K in keyof R]: ManagedStoreOf<R[K]>; }>>;
    stop: <K extends keyof R & string>(key: K) => void;
    stopAll: () => void;
    get: <K extends keyof R & string>(key: K) => ManagedStoreOf<R[K]> | undefined;
    touch: <K extends keyof R & string>(key: K, weight?: number) => void;
    usage: () => Map<string, ManagedStoreUsage>;
};
export {};
