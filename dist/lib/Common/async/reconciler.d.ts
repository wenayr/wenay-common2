import { type ResourceScopeOptions } from './resource-scope';
export declare function createReconciler<T>(deps: ResourceScopeOptions & {
    read: () => T;
    run: (snapshot: T, context: {
        signal: AbortSignal;
        retry: (key: string, delayMs: number) => void;
    }) => void | Promise<void>;
    subscribe?: (request: () => void) => () => void;
}): {
    control: {
        request: () => void;
        retry: (key: string, delayMs: number) => void;
        cancelRetry: (key: string) => void;
        idle: () => Promise<void>;
    };
    events: {
        errors: import("../..").ListenOn<[unknown]>;
    };
    view: {
        error: () => unknown;
    };
    signal: AbortSignal;
    close: () => Promise<void>;
    settled: () => Promise<void>;
};
export type Reconciler<T> = ReturnType<typeof createReconciler<T>>;
