import { createListen, type ListenApi } from '../events/Listen';
import { listenUpdate, listenUpdatePaths, reactive, ReactiveChange } from "./reactive";
export type StorePath = readonly PropertyKey[];
export type StoreDrain = "micro" | "immediate" | number | ((flush: () => void) => void);
export type StoreSubOpts = {
    current?: boolean;
    drain?: StoreDrain;
    key?: string;
};
export type StoreChange = ReactiveChange;
export type StorePatch = {
    path: PropertyKey[];
    value: any;
    exists: boolean;
};
export type StoreChangedData<M = any> = {
    mask: M;
    data: any;
};
export type StoreSyncOpts = StoreSubOpts & {
    partial?: boolean;
    batch?: boolean;
    onError?: (error: any) => void;
};
export type StorePatchBatchOpts = {
    maxItems?: number;
    maxBytes?: number;
};
export type StoreExposeOpts = {
    push?: boolean | StorePatchBatchOpts;
};
export type StoreCtx<T = any> = {
    store: Store<any>;
    node: StoreNode<T>;
    path: PropertyKey[];
    pathString: string;
    exists: boolean;
};
export type StoreMask<T> = true | (NonNullable<T> extends object ? {
    [K in keyof NonNullable<T>]?: StoreMask<NonNullable<T>[K]>;
} : true);
export type StorePick<T, M> = M extends true ? T : NonNullable<T> extends object ? M extends object ? {
    [K in keyof M & keyof NonNullable<T>]: StorePick<NonNullable<T>[K], NonNullable<M[K]>>;
} : T : T;
export type StoreNode<T> = StoreNodeApi<T> & (NonNullable<T> extends object ? {
    readonly [K in keyof NonNullable<T>]-?: StoreNode<NonNullable<T>[K]>;
} : {});
export type StoreNodeApi<T> = {
    readonly path: PropertyKey[];
    readonly pathString: string;
    get(): T;
    has(): boolean;
    snapshot(): T;
    set(value: T): void;
    replace(value: T): void;
    on(cb: (value: T, ctx: StoreCtx<T>) => void, opts?: StoreSubOpts): () => void;
    once(cb: (value: T, ctx: StoreCtx<T>) => void, opts?: StoreSubOpts): () => void;
    update<M extends StoreMask<T>>(mask: M, opts?: StoreSubOpts): StoreSelection<T, M>;
    at<K extends PropertyKey>(key: K): StoreNode<any>;
    count(): number;
};
export type StoreSelection<T, M> = {
    readonly mask: M;
    readonly paths: PropertyKey[][];
    get(): StorePick<T, M>;
    on(cb: (value: StorePick<T, M>, ctx: StoreSelectionCtx<T, M>) => void, opts?: StoreSubOpts): () => void;
    once(cb: (value: StorePick<T, M>, ctx: StoreSelectionCtx<T, M>) => void, opts?: StoreSubOpts): () => void;
    onEach(cb: (value: any, ctx: StoreCtx<any>) => void, opts?: StoreSubOpts): () => void;
};
export type StoreSelectionCtx<T, M> = {
    store: Store<any>;
    node: StoreNode<T>;
    mask: M;
    paths: PropertyKey[][];
};
export type StoreEachOpts = {
    depth?: number;
};
export type StoreEachCtx = {
    path: PropertyKey[];
};
export type Store<T extends object> = {
    readonly state: T;
    readonly node: StoreNode<T>;
    get(): T;
    snapshot(): T;
    replace(value: T): void;
    on(cb: (value: T, ctx: StoreCtx<T>) => void, opts?: StoreSubOpts): () => void;
    once(cb: (value: T, ctx: StoreCtx<T>) => void, opts?: StoreSubOpts): () => void;
    update<M extends StoreMask<T>>(mask: M, opts?: StoreSubOpts): StoreSelection<T, M>;
    each(opts?: StoreEachOpts): ReturnType<typeof createListen<[key: string, value: T[keyof T] | undefined, ctx: StoreEachCtx]>>;
    listen(): ReturnType<typeof listenUpdate>;
    listenPaths(): ReturnType<typeof listenUpdatePaths>;
    count(): number;
};
type RemoteStore<T extends object> = {
    get(mask?: any): T | Promise<T>;
    changed: any;
    changedPaths?: any;
    patches?: any;
    patchesBatch?: any;
    changedData?: any;
};
export type StoreRemoteApi<T extends object> = {
    get(): T;
    get<M extends StoreMask<T>>(mask: M): StorePick<T, M>;
    set(path: StorePath, value: any): void;
    replace(path: StorePath, value: any): void;
    changed: any;
    changedPaths: any;
    patches?: any;
    patchesBatch?: any;
    changedData?: any;
};
export declare function cloneStoreValue<T>(value: T): T;
export declare function applyStoreMask<T extends object>(store: Store<T>, mask: StoreMask<T> | any, data: any): void;
export declare function applyStorePatch<T extends object>(store: Store<T>, patch: StorePatch): void;
export declare function applyStorePatches<T extends object>(store: Store<T>, patches: readonly StorePatch[]): void;
export declare function listenStorePatches<T extends object>(store: Store<T>): ListenApi<[readonly StorePatch[]]>;
export declare function createStore<T extends object>(initial: T, opts?: Parameters<typeof reactive<T>>[1]): Store<T>;
export declare function exposeStore<T extends object>(store: Store<T>, opts?: StoreExposeOpts): StoreRemoteApi<T>;
export declare function createStoreMirror<T extends object>(remote: RemoteStore<T>, initial?: T, opts?: Parameters<typeof createStore<T>>[1]): Store<T> & {
    sync: <M extends StoreMask<T>>(mask: M, subOpts?: StoreSyncOpts) => Promise<() => void>;
    syncPatches: <M extends StoreMask<T>>(mask: M, subOpts?: StoreSyncOpts) => Promise<() => void>;
    syncChangedData: <M extends StoreMask<T>>(mask: M, subOpts?: StoreSyncOpts) => Promise<() => void>;
};
export {};
