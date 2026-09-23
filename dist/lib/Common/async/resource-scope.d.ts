export type tResourceDisposer = () => void | Promise<void>;
export type ResourceScopeOptions = {
    signal?: AbortSignal;
    closeTimeoutMs?: number;
};
export declare class ResourceCloseTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number);
}
export declare function createResourceScope(deps?: ResourceScopeOptions): {
    resource: {
        own: (dispose: tResourceDisposer) => () => Promise<void>;
        acquire: <T>(resource: {
            open: (signal: AbortSignal) => T | Promise<T>;
            close: (value: T) => void | Promise<void>;
        }) => Promise<T>;
        parallel: (disposers: readonly tResourceDisposer[]) => () => Promise<void>;
    };
    signal: AbortSignal;
    start: <T>(work: (signal: AbortSignal) => T | Promise<T>) => Promise<T>;
    close: () => Promise<void>;
    settled: () => Promise<void>;
    events: {
        errors: import("../..").ListenOn<[unknown]>;
    };
};
export type ResourceScope = ReturnType<typeof createResourceScope>;
