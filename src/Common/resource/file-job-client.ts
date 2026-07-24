// =====================================================================
// File/job client — one local Store mirror over an existing RPC fragment
// =====================================================================

import {createStore, StoreDrain} from '../Observe/store'
import {StoreReplayRemote, syncStoreReplay} from '../Observe/store-replay'
import {FileJob, FileJobStore, FileResource, FileUploadRequest} from './file-job-host'

export type FileJobRemote = {
    state: StoreReplayRemote
    startUpload: (request: FileUploadRequest) => Promise<{file: FileResource, upload: unknown}> | {file: FileResource, upload: unknown}
    confirmUpload: (fileId: string) => Promise<FileResource> | FileResource
    startJob: (fileId: string, input: unknown) => Promise<FileJob> | FileJob
    cancelJob: (jobId: string) => Promise<FileJob> | FileJob
    download: (fileId: string) => Promise<unknown> | unknown
}

export type FileJobClientDeps = {
    /** Deep proxy of `host.connection(account).fragment` on the existing RPC connection. */
    remote: FileJobRemote
    initial?: FileJobStore
    drain?: StoreDrain
    /** Prefer compact Store coordinates; false preserves legacy seq values. */
    batch?: boolean
}

export function createFileJobClient(deps: FileJobClientDeps) {
    const {remote, initial = {files: {}, jobs: {}}, drain, batch = true} = deps
    const store = createStore<FileJobStore>(initial, drain !== undefined ? {drain} : {})
    const sync = syncStoreReplay(store, remote.state, {batch})

    async function startUpload(request: FileUploadRequest) {
        return remote.startUpload(request)
    }

    async function confirmUpload(fileId: string) {
        return remote.confirmUpload(fileId)
    }

    async function startJob(fileId: string, input: unknown) {
        return remote.startJob(fileId, input)
    }

    async function cancelJob(jobId: string) {
        return remote.cancelJob(jobId)
    }

    async function download(fileId: string) {
        return remote.download(fileId)
    }

    return {
        /** Account-filtered metadata + progress; file bytes never enter this Store. */
        store,
        ready: sync.ready,
        seq: sync.seq,
        stateMode: () => sync.mode,
        startUpload,
        confirmUpload,
        startJob,
        cancelJob,
        download,
        close: sync,
    }
}

export type FileJobClient = ReturnType<typeof createFileJobClient>
