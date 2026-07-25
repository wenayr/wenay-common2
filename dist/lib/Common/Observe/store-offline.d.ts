import { createStore, Store } from './store';
import { StoreReplayRemote, StoreReplaySyncOpts, tStoreReplayMode } from './store-replay';
export type OfflineStorage = {
    read<T>(key: string): Promise<T | undefined>;
    write<T>(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
    transaction?<R>(fn: (tx: OfflineStorage) => Promise<R>): Promise<R>;
};
export type OfflineStoreRecord<T extends object> = {
    version: number;
    seq: number;
    replayMode?: tStoreReplayMode;
    snapshot: T;
    savedAt: number;
};
export type OfflineStoreStatus = {
    ready: boolean;
    syncing: boolean;
    offline: boolean;
    stale: boolean;
    saving: boolean;
    seq: number;
    savedAt?: number;
    error?: unknown;
};
export type PersistStoreOpts = {
    key: string;
    storage: OfflineStorage;
    version?: number;
    seq?: number;
    replayMode?: tStoreReplayMode;
    savedAt?: number;
    debounceMs?: number;
    now?: () => number;
    onError?: (error: unknown) => void;
    onStatus?: (status: OfflineStoreStatus) => void;
};
export type CreateOfflineStoreOpts<T extends object> = {
    key: string;
    remote?: StoreReplayRemote;
    initial: T;
    storage: OfflineStorage;
    version?: number;
    debounceMs?: number;
    mode?: 'snapshot' | 'topLevel';
    migrate?: (oldSnapshot: unknown, fromVersion: number, toVersion: number) => T | Promise<T>;
    now?: () => number;
    storeOpts?: Parameters<typeof createStore<T>>[1];
    syncOpts?: StoreReplaySyncOpts<T>;
    onError?: (error: unknown) => void;
    onStatus?: (status: OfflineStoreStatus) => void;
};
export type PersistedStoreControl = ReturnType<typeof persistStore>;
export type OfflineStore<T extends object> = Store<T> & {
    ready: Promise<void>;
    close(): void;
    flush(): Promise<void>;
    status(): OfflineStoreStatus;
    statusListen: PersistedStoreControl['statusListen'];
    reconnect(remote: StoreReplayRemote, opts?: StoreReplaySyncOpts<T>): Promise<void>;
};
export declare function createMemoryOfflineStorage(initial?: Record<string, unknown>): OfflineStorage & {
    dump(): Record<string, unknown>;
};
export declare function persistStore<T extends object>(store: Store<T>, opts: PersistStoreOpts): {
    flush: () => Promise<void>;
    forceFlush: () => Promise<void>;
    close: () => void;
    setSeq: (nextSeq: number) => void;
    setReplayMode: (nextMode: tStoreReplayMode) => boolean;
    replayMode: () => "v2";
    seq: () => number;
    status: () => OfflineStoreStatus;
    statusListen: {
        on: import("../events/Listen").ListenOnCurrent<[OfflineStoreStatus]>;
        once: (cb: import("../events/Listen").Listener<[OfflineStoreStatus]>, opts?: {
            key?: import("../events/Listen").ListenKey;
            current?: import("../events/Listen").ListenCurrent<[OfflineStoreStatus]> | undefined;
        }) => import("../events/Listen").ListenOff;
        emit: import("../events/Listen").Listener<[OfflineStoreStatus]>;
        has(key: import("../events/Listen").ListenKey): boolean;
        off(keyOrCallback: import("../events/Listen").ListenKey | import("../events/Listen").Listener<[OfflineStoreStatus]> | null): void;
        close(): void;
        count(): number;
        keys(): import("../events/Listen").ListenKey[];
        isRunning(): boolean;
        run(): void;
        onClose(cb: () => void): import("../events/Listen").ListenOff;
    };
    setSyncStatus: (patch: Partial<OfflineStoreStatus>) => void;
};
export declare function createOfflineStore<T extends object>(opts: CreateOfflineStoreOpts<T>): Promise<OfflineStore<T>>;
