export declare function createThrottle(): {
    throttle: (ms: number, func: () => any) => void;
    debounce: (ms: number, func: () => any) => Promise<void>;
    throttleAsync: (ms: number, func: () => any) => void;
    debounceAsync: (ms: number, func: () => any) => Promise<void>;
};
export declare const enhancedWaitRun: typeof createThrottle;
export declare function createAsyncQueue(concurrency?: number): {
    add: <T>(task: () => Promise<T>) => Promise<T>;
    onIdle: () => Promise<void>;
    readonly size: number;
    enqueue: <T>(task: () => Promise<T>) => Promise<T>;
    getQueueSize: () => number;
};
export declare function enhancedQueueRun(maxParallelTasks?: number): {
    readonly queueSize: number;
    enqueue: (task: () => Promise<any>) => void;
    enqueueAndRun: (task: () => Promise<any>) => Promise<any>;
    runAll: () => Promise<void>;
};
export declare function waitRun(): {
    refreshAsync: (ms: number, func: () => any) => void;
    refreshAsync2: (ms: number, func: () => any) => Promise<void>;
};
export declare function queueRun(n?: number): {
    readonly size: number;
    next: () => Promise<any>;
    nextRun: () => Promise<any>;
    run: () => Promise<void>;
};
export declare function createReadyGate(): {
    add: (fn: () => any) => number | undefined;
    ready: () => Promise<void>;
    isReady: () => boolean;
    tasks: () => (() => any)[];
    setReady: () => Promise<void>;
};
export declare const createTaskQueue: typeof createReadyGate;
