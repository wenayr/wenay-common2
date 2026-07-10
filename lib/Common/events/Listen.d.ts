export type Listener<T extends any[]> = (...args: T) => void;
export type NormalizeTuple<T> = T extends any[] ? T : [T];
export type ListenKey = string | symbol;
export type ListenOff = () => void;
type CloseCallback = () => void;
declare const LISTEN_ON_BRAND: unique symbol;
export type ListenOn<Z extends any[] = any[]> = ((cb: Listener<Z>, opts?: {
    cbClose?: CloseCallback;
    key?: ListenKey;
}) => ListenOff) & {
    readonly [LISTEN_ON_BRAND]: Z;
};
export type ListenOnCurrent<Z extends any[] = any[]> = ((cb: Listener<Z>, opts?: {
    cbClose?: CloseCallback;
    key?: ListenKey;
    current?: ListenCurrent<Z>;
}) => ListenOff) & {
    readonly [LISTEN_ON_BRAND]: Z;
};
export type ListenCurrentProvider<Z extends any[]> = () => Z | undefined;
export type ListenCurrent<Z extends any[]> = boolean | ListenCurrentProvider<Z>;
export type ListenCoreApi<T = any> = {
    emit: Listener<NormalizeTuple<T>>;
    has(key: ListenKey): boolean;
    on: ListenOn<NormalizeTuple<T>>;
    off(keyOrCallback: Listener<NormalizeTuple<T>> | null | ListenKey): void;
    once(cb: Listener<NormalizeTuple<T>>, opts?: {
        key?: ListenKey;
    }): ListenOff;
    close(): void;
    count(): number;
    keys(): ListenKey[];
};
export type ListenApi<T = any> = ListenCoreApi<T> & {
    isRunning(): boolean;
    run(): void;
    onClose(cb: CloseCallback): ListenOff;
};
export type ListenCoreOptions<T = any> = {
    fast?: boolean;
    onRemove?: (key: ListenKey) => void;
    event?: (type: 'add' | 'remove', count: number, api: ListenCoreApi<T>) => void;
};
export type ListenOptions<T = any> = {
    event?: (type: 'add' | 'remove', count: number, api: ListenApi<T>) => void;
    fast?: boolean;
    closeOn?: ListenApi<any>;
};
export type ListenStoreOptions<T> = ListenOptions<T> & {
    current: ListenCurrentProvider<NormalizeTuple<T>>;
};
export type ListenOnBrand<Z extends any[] = any[]> = {
    readonly [LISTEN_ON_BRAND]: Z;
};
export declare function getListenByOn(fn: any): any;
export declare function isListenOn(fn: any): boolean;
export declare function registerListenOn(on: Function, api: any): void;
export declare function createListenCore<T>(options?: ListenCoreOptions<T>): ListenCoreApi<T>;
export declare function createListen<T>(producer: (emit: Listener<NormalizeTuple<T>>) => (void | ListenOff), options?: ListenOptions<T>): ListenApi<T>;
export declare function createFastListen<T>(producer: (emit: Listener<NormalizeTuple<T>>) => (void | ListenOff)): ListenApi<T>;
export declare function listen<T>(options?: ListenOptions<T>): readonly [Listener<NormalizeTuple<T>>, ListenApi<T>];
export declare function withStoreListen<T>(base: ListenApi<T>, currentProvider: ListenCurrentProvider<NormalizeTuple<T>>): {
    on: ListenOnCurrent<NormalizeTuple<T>>;
    once: (cb: Listener<NormalizeTuple<T>>, opts?: {
        key?: ListenKey;
        current?: ListenCurrent<NormalizeTuple<T>>;
    }) => ListenOff;
    emit: Listener<NormalizeTuple<T>>;
    has(key: ListenKey): boolean;
    off(keyOrCallback: ListenKey | Listener<NormalizeTuple<T>> | null): void;
    close(): void;
    count(): number;
    keys(): ListenKey[];
    isRunning(): boolean;
    run(): void;
    onClose(cb: CloseCallback): ListenOff;
};
export type ListenStoreApi<T> = ReturnType<typeof withStoreListen<T>>;
export declare function createStoreListen<T>(producer: (emit: Listener<NormalizeTuple<T>>) => (void | ListenOff), options: ListenStoreOptions<T>): {
    on: ListenOnCurrent<NormalizeTuple<T>>;
    once: (cb: Listener<NormalizeTuple<T>>, opts?: {
        key?: ListenKey;
        current?: ListenCurrent<NormalizeTuple<T>> | undefined;
    }) => ListenOff;
    emit: Listener<NormalizeTuple<T>>;
    has(key: ListenKey): boolean;
    off(keyOrCallback: ListenKey | Listener<NormalizeTuple<T>> | null): void;
    close(): void;
    count(): number;
    keys(): ListenKey[];
    isRunning(): boolean;
    run(): void;
    onClose(cb: CloseCallback): ListenOff;
};
export declare function listenStore<T>(options: ListenStoreOptions<T>): readonly [Listener<NormalizeTuple<T>>, {
    on: ListenOnCurrent<NormalizeTuple<T>>;
    once: (cb: Listener<NormalizeTuple<T>>, opts?: {
        key?: ListenKey;
        current?: ListenCurrent<NormalizeTuple<T>> | undefined;
    }) => ListenOff;
    emit: Listener<NormalizeTuple<T>>;
    has(key: ListenKey): boolean;
    off(keyOrCallback: ListenKey | Listener<NormalizeTuple<T>> | null): void;
    close(): void;
    count(): number;
    keys(): ListenKey[];
    isRunning(): boolean;
    run(): void;
    onClose(cb: CloseCallback): ListenOff;
}];
export declare function toSlimListen<T>(full: ListenApi<T>): {
    on: (cb: Listener<NormalizeTuple<T>>, opts?: {
        key?: ListenKey;
    }) => ListenOff;
    off: (keyOrCallback: Listener<NormalizeTuple<T>> | null | ListenKey) => void;
    close: () => void;
    count: () => number;
};
export type SlimListen<T> = ReturnType<typeof toSlimListen<T>>;
export declare function slimListen<T>(options?: ListenOptions<T>): readonly [Listener<NormalizeTuple<T>>, {
    on: (cb: Listener<NormalizeTuple<T>>, opts?: {
        key?: ListenKey;
    } | undefined) => ListenOff;
    off: (keyOrCallback: ListenKey | Listener<NormalizeTuple<T>> | null) => void;
    close: () => void;
    count: () => number;
}];
export declare function isListenCallback(obj: any): obj is ListenApi;
export {};
