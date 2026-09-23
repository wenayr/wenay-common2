export type tServiceDisposer = () => void | Promise<void>;
export type ServiceHostOptions = {
    host?: string;
    publicUrl?: string;
    origins?: readonly string[];
    closeTimeoutMs?: number;
    startTimeoutMs?: number;
    signal?: AbortSignal;
};
export declare function createHostLifecycle(deps: ServiceHostOptions): {
    own: (dispose: tServiceDisposer) => void;
    start: <T>(work: () => Promise<T>) => Promise<T>;
    close: () => Promise<void>;
    signal: AbortSignal;
};
export declare function installServiceSignals(deps: {
    close: tServiceDisposer;
}): {
    close: () => Promise<void>;
    remove: () => void;
};
