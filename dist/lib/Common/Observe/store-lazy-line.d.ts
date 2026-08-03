import { type Store } from './store';
export type StoreLazyCursor = {
    key: string | null;
    revision: number;
};
export type StoreLazyChunkV1 = {
    index: number;
    values: Record<string, unknown>;
    deleted: readonly string[];
    kind: 'fill' | 'live';
};
export type StoreLazyReadV1 = {
    cursor: StoreLazyCursor;
    remaining: number;
    filled: boolean;
    revision: number;
    stale?: true;
};
export type StoreLazyRemote = {
    describe?: () => Record<string, any> | Promise<Record<string, any>>;
    read: (request: {
        cursor?: StoreLazyCursor | null;
        maxBytes?: number;
        maxItems?: number;
    }, emit: (chunk: StoreLazyChunkV1) => void) => StoreLazyReadV1 | Promise<StoreLazyReadV1>;
};
export type StoreLazyLineOpts = {
    chunkBytes?: number;
    maxItems?: number;
    windowBytes?: number;
    tombstoneKeepMs?: number;
    describe?: Record<string, any>;
    now?: () => number;
};
export declare function exposeStoreLazyLine<T extends object>(store: Store<T>, opts?: StoreLazyLineOpts): {
    api: StoreLazyRemote;
    view: {
        snapshot: () => {
            revision: number;
            oldestProvableRevision: number;
            keys: number;
            tombstones: number;
            trackedKeys: number;
            chunkBytes: number;
            windowBytes: number;
            tombstoneKeepMs: number;
        };
    };
    close: () => void;
};
export type StoreLazyLineHost = ReturnType<typeof exposeStoreLazyLine>;
export type StoreLazySyncOpts = {
    readBytes?: number;
    cursor?: StoreLazyCursor | null;
    fillIntervalMs?: number;
    liveIntervalMs?: number;
    fillOnly?: boolean;
    onCursor?: (cursor: StoreLazyCursor) => void;
    onProgress?: (progress: {
        received: number;
        remaining: number;
        filled: boolean;
        chunks: number;
    }) => void;
    onError?: (error: unknown) => void;
};
export declare function syncStoreLazyLine<T extends object>(mirror: Store<T>, remote: StoreLazyRemote, opts?: StoreLazySyncOpts): {
    filled: Promise<void>;
    view: {
        snapshot: () => {
            received: number;
            chunks: number;
            running: boolean;
            cursor: StoreLazyCursor | null;
        };
    };
    close: () => void;
};
