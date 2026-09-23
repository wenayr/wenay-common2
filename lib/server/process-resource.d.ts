import { type ChildProcess } from 'node:child_process';
export type ProcessResourceDeps<T> = {
    command: string;
    args?: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    ipc?: boolean;
    ready: (fact: {
        type: 'message';
        value: unknown;
    } | {
        type: 'stdout' | 'stderr';
        value: string;
        tail: string;
    }) => T | undefined;
    startTimeoutMs?: number;
    stopTimeoutMs?: number;
    tailChars?: number;
    signal?: AbortSignal;
    shutdown?: (child: ChildProcess) => void | Promise<void>;
};
export declare function createProcessResource<T>(deps: ProcessResourceDeps<T>): {
    ready: Promise<T>;
    done: Promise<void>;
    close: () => Promise<void>;
    events: {
        failure: {
            on: import("..").ListenOn<[unknown]>;
        };
        message: {
            on: import("..").ListenOn<[unknown]>;
        };
    };
    view: {
        pid: () => number | undefined;
        stopped: () => boolean;
        output: () => string;
        failure: () => unknown;
    };
};
export type ProcessResource<T> = ReturnType<typeof createProcessResource<T>>;
