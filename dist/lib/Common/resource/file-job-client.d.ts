import { StoreDrain } from '../Observe/store';
import { StoreReplayRemote } from '../Observe/store-replay';
import { FileJob, FileJobStore, FileResource, FileUploadRequest } from './file-job-host';
export type FileJobRemote = {
    state: StoreReplayRemote;
    startUpload: (request: FileUploadRequest) => Promise<{
        file: FileResource;
        upload: unknown;
    }> | {
        file: FileResource;
        upload: unknown;
    };
    confirmUpload: (fileId: string) => Promise<FileResource> | FileResource;
    startJob: (fileId: string, input: unknown) => Promise<FileJob> | FileJob;
    cancelJob: (jobId: string) => Promise<FileJob> | FileJob;
    download: (fileId: string) => Promise<unknown> | unknown;
};
export type FileJobClientDeps = {
    remote: FileJobRemote;
    initial?: FileJobStore;
    drain?: StoreDrain;
};
export declare function createFileJobClient(deps: FileJobClientDeps): {
    store: import("../Observe").Store<FileJobStore>;
    ready: Promise<void>;
    seq: () => number;
    stateMode: () => "v2";
    startUpload: (request: FileUploadRequest) => Promise<{
        file: FileResource;
        upload: unknown;
    } | {
        file: FileResource;
        upload: unknown;
    }>;
    confirmUpload: (fileId: string) => Promise<FileResource>;
    startJob: (fileId: string, input: unknown) => Promise<FileJob>;
    cancelJob: (jobId: string) => Promise<FileJob>;
    download: (fileId: string) => Promise<unknown>;
    close: (() => void) & {
        ready: Promise<void>;
        seq: () => number;
        isStale: () => boolean;
        lastTs: () => number;
        mode: 'v2';
    };
};
export type FileJobClient = ReturnType<typeof createFileJobClient>;
