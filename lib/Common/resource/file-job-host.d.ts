import { StoreDrain } from '../Observe/store';
export type FileResourceState = 'uploading' | 'uploaded' | 'failed';
export type FileJobState = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';
export type FileResource = {
    id: string;
    owner: string;
    name: string;
    mime?: string;
    size: number;
    state: FileResourceState;
    createdAt: number;
    updatedAt: number;
    error?: string;
};
export type FileJob = {
    id: string;
    fileId: string;
    owner: string;
    state: FileJobState;
    progress: number;
    message?: string;
    result?: unknown;
    error?: string;
    createdAt: number;
    updatedAt: number;
};
export type FileJobStore = {
    files: Record<string, FileResource>;
    jobs: Record<string, FileJob>;
};
export type FileUploadRequest = {
    name: string;
    size: number;
    mime?: string;
};
export type FileStoragePort = {
    beginUpload(input: {
        file: FileResource;
    }): unknown | Promise<unknown>;
    confirmUpload?(input: {
        file: FileResource;
    }): void | Promise<void>;
    download?(input: {
        file: FileResource;
    }): unknown | Promise<unknown>;
};
export type FileJobReport = {
    progress?: number;
    message?: string;
    result?: unknown;
};
export type FileJobRunner = {
    run(input: {
        file: FileResource;
        job: FileJob;
        input: unknown;
        report: (next: FileJobReport) => void;
        cancelled: () => boolean;
    }): {
        result?: unknown;
    } | void | Promise<{
        result?: unknown;
    } | void>;
};
export type FileJobPolicy = {
    canRead?: (account: string, file: FileResource) => boolean;
    canWrite?: (account: string, file: FileResource) => boolean;
};
export type FileJobHostDeps = {
    storage: FileStoragePort;
    runner: FileJobRunner;
    policy?: FileJobPolicy;
    id?: () => string;
    now?: () => number;
    history?: number;
    drain?: StoreDrain;
};
export declare function createFileJobHost(deps: FileJobHostDeps): {
    connection: (account: string) => {
        fragment: {
            state: import("../events/replay-wire").ReplayExpose<[import("../Observe/store").StorePatch]> | {
                describe: () => {
                    [x: string]: any;
                };
                line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>]>;
                since: (seq: number) => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>[] | null;
                keyframe: () => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]> | null;
                frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>[];
            };
            startUpload: (request: FileUploadRequest) => Promise<{
                file: {
                    id: string;
                    owner: string;
                    name: string;
                    mime?: string;
                    size: number;
                    state: FileResourceState;
                    createdAt: number;
                    updatedAt: number;
                    error?: string;
                };
                upload: unknown;
            }>;
            confirmUpload: (fileId: string) => Promise<{
                id: string;
                owner: string;
                name: string;
                mime?: string;
                size: number;
                state: FileResourceState;
                createdAt: number;
                updatedAt: number;
                error?: string;
            }>;
            startJob: (fileId: string, input: unknown) => {
                id: string;
                fileId: string;
                owner: string;
                state: FileJobState;
                progress: number;
                message?: string;
                result?: unknown;
                error?: string;
                createdAt: number;
                updatedAt: number;
            };
            cancelJob: (jobId: string) => {
                id: string;
                fileId: string;
                owner: string;
                state: FileJobState;
                progress: number;
                message?: string;
                result?: unknown;
                error?: string;
                createdAt: number;
                updatedAt: number;
            };
            download: (fileId: string) => Promise<unknown>;
        };
        close(): void;
    };
    store: import("../Observe/store").Store<FileJobStore>;
    close(): void;
};
export type FileJobHost = ReturnType<typeof createFileJobHost>;
