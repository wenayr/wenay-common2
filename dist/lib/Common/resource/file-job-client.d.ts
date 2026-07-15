import { StoreDrain } from '../Observe/store';
import { ReplayRemote } from '../events/replay-wire';
import { FileJob, FileJobStore, FileResource, FileUploadRequest } from './file-job-host';
export type FileJobRemote = {
    state: ReplayRemote<any>;
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
    store: import("../Observe/store").Store<FileJobStore>;
    ready: Promise<void>;
    seq: () => number;
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
    };
};
export type FileJobClient = ReturnType<typeof createFileJobClient>;
