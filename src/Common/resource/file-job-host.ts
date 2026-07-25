// =====================================================================
// File/job host — storage intents + authorized metadata/replay
// =====================================================================
// File bytes belong to the injected storage port. This layer owns the API
// lifecycle around them: an upload intent, a confirmed resource, a cancellable
// job, and an account-filtered Store/replay view for each RPC connection.

import {createStore, StoreChange, StoreDrain} from '../Observe/store'
import {exposeStoreReplay} from '../Observe/store-replay'
import {
    cloneStoreProjectionValue,
    collectStoreProjectionChanges,
    reconcileStoreProjection,
    reconcileStoreProjectionRecord,
} from '../Observe/store-projection'

export type FileResourceState = 'uploading' | 'uploaded' | 'failed'
export type FileJobState = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'

export type FileResource = {
    id: string
    owner: string
    name: string
    mime?: string
    size: number
    state: FileResourceState
    createdAt: number
    updatedAt: number
    error?: string
}

export type FileJob = {
    id: string
    fileId: string
    owner: string
    state: FileJobState
    progress: number
    message?: string
    result?: unknown
    error?: string
    createdAt: number
    updatedAt: number
}

export type FileJobStore = {
    files: Record<string, FileResource>
    jobs: Record<string, FileJob>
}

export type FileUploadRequest = {
    name: string
    size: number
    mime?: string
}

export type FileStoragePort = {
    /** Return an opaque, short-lived upload instruction (for example a presigned URL). */
    beginUpload(input: {file: FileResource}): unknown | Promise<unknown>
    /** Check that the storage provider accepted the bytes before the resource becomes usable. */
    confirmUpload?(input: {file: FileResource}): void | Promise<void>
    /** Return an opaque, authorized download instruction; never put it in the shared Store. */
    download?(input: {file: FileResource}): unknown | Promise<unknown>
}

export type FileJobReport = {
    progress?: number
    message?: string
    /** Keep results as descriptors/links/structured output, not file bytes. */
    result?: unknown
}

export type FileJobRunner = {
    run(input: {
        file: FileResource
        job: FileJob
        input: unknown
        report: (next: FileJobReport) => void
        cancelled: () => boolean
    }): {result?: unknown} | void | Promise<{result?: unknown} | void>
}

export type FileJobPolicy = {
    /** Default: only the owning account may see a file/job. */
    canRead?: (account: string, file: FileResource) => boolean
    /** Default: only the owning account may confirm, process, cancel, or download. */
    canWrite?: (account: string, file: FileResource) => boolean
}

export type FileJobHostDeps = {
    storage: FileStoragePort
    runner: FileJobRunner
    policy?: FileJobPolicy
    id?: () => string
    now?: () => number
    history?: number
    drain?: StoreDrain
}

type FileJobView = {
    refresh: (change: StoreChange) => void
    close: () => void
}

function errorText(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

function clampProgress(value: number) {
    return Math.max(0, Math.min(1, value))
}

function copyFile(file: FileResource) {
    return {...file}
}

function copyJob(job: FileJob) {
    return {
        ...job,
        ...(job.result !== undefined ? {result: cloneStoreProjectionValue(job.result)} : {}),
    }
}

export function createFileJobHost(deps: FileJobHostDeps) {
    const {storage, runner, policy, history, drain, now = Date.now} = deps
    let nextId = 0
    const makeId = deps.id ?? function defaultId() { return 'resource-' + (++nextId) }
    const store = createStore<FileJobStore>({files: {}, jobs: {}}, drain !== undefined ? {drain} : {})
    const views = new Set<FileJobView>()
    const cancelled = new Set<string>()
    let closed = false

    // === Business policy ===

    function readable(account: string, file: FileResource) {
        return policy?.canRead ? policy.canRead(account, file) : file.owner == account
    }

    function writable(account: string, file: FileResource) {
        return policy?.canWrite ? policy.canWrite(account, file) : file.owner == account
    }

    function requireFile(account: string, fileId: string, action: string) {
        const file = store.state.files[fileId]
        if (!file || !writable(account, file)) throw new Error('file ' + action + ': forbidden or missing')
        return file
    }

    function project(account: string): FileJobStore {
        const files: Record<string, FileResource> = {}
        const jobs: Record<string, FileJob> = {}
        for (const [id, file] of Object.entries(store.state.files)) {
            if (readable(account, file)) files[id] = copyFile(file)
        }
        for (const [id, job] of Object.entries(store.state.jobs)) {
            if (files[job.fileId]) jobs[id] = copyJob(job)
        }
        return {files, jobs}
    }

    function refreshViews(change: StoreChange) {
        if (closed) return
        for (const view of views) view.refresh(change)
    }

    const offStore = store.listenPaths().on(refreshViews)

    function createView(account: string) {
        const state = createStore<FileJobStore>(project(account), drain !== undefined ? {drain} : {})
        const replay = exposeStoreReplay(state, history == undefined ? {} : {history})
        function refreshJob(id: string) {
            const job = store.state.jobs[id]
            const visible = !!job && !!state.state.files[job.fileId]
            reconcileStoreProjectionRecord(state, 'jobs', id, {
                exists: visible,
                ...(visible ? {value: copyJob(job!)} : {}),
            })
        }
        function refreshFile(id: string) {
            const file = store.state.files[id]
            const wasVisible = !!state.state.files[id]
            const visible = !!file && readable(account, file)
            reconcileStoreProjectionRecord(state, 'files', id, {
                exists: visible,
                ...(visible ? {value: copyFile(file!)} : {}),
            })
            if (visible == wasVisible) return
            const jobs = visible ? store.state.jobs : state.state.jobs
            for (const job of Object.values(jobs)) if (job.fileId == id) refreshJob(job.id)
        }
        function refreshProjection(change: StoreChange) {
            // A custom policy may close over tenant membership outside the changed record.
            if (policy?.canRead) { reconcileStoreProjection(state, project(account)); return }
            const changed = collectStoreProjectionChanges(change, ['files', 'jobs'])
            if (!changed) { reconcileStoreProjection(state, project(account)); return }
            for (const id of changed.get('files') ?? []) refreshFile(String(id))
            for (const id of changed.get('jobs') ?? []) refreshJob(String(id))
        }
        let view: FileJobView
        view = {
            refresh: refreshProjection,
            close() {
                views.delete(view)
                replay.close()
            },
        }
        return {view, replay}
    }

    function touch(file: FileResource) {
        file.updatedAt = now()
    }

    function touchJob(job: FileJob) {
        job.updatedAt = now()
    }

    async function startUpload(account: string, request: FileUploadRequest) {
        if (!request || typeof request.name != 'string' || !request.name.trim()) throw new Error('file upload: name is required')
        if (!Number.isFinite(request.size) || request.size < 0) throw new Error('file upload: size must be a non-negative number')
        const createdAt = now()
        const file: FileResource = {
            id: makeId(), owner: account, name: request.name, size: request.size,
            state: 'uploading', createdAt, updatedAt: createdAt,
            ...(request.mime ? {mime: request.mime} : {}),
        }
        const upload = await storage.beginUpload({file: copyFile(file)})
        if (closed) throw new Error('file upload: host closed')
        store.state.files[file.id] = file
        return {file: copyFile(file), upload}
    }

    async function confirmUpload(account: string, fileId: string) {
        const file = requireFile(account, fileId, 'confirm')
        if (file.state != 'uploading') throw new Error('file confirm: expected uploading resource')
        try {
            await storage.confirmUpload?.({file: copyFile(file)})
            file.state = 'uploaded'
            delete file.error
        } catch (error) {
            file.state = 'failed'
            file.error = errorText(error)
            throw error
        } finally {
            touch(file)
        }
        return copyFile(file)
    }

    function reportJob(jobId: string, next: FileJobReport) {
        const job = store.state.jobs[jobId]
        if (!job || job.state == 'cancelled' || job.state == 'failed' || job.state == 'ready') return
        if (next.progress != null) {
            if (!Number.isFinite(next.progress)) throw new Error('file job: progress must be finite')
            job.progress = clampProgress(next.progress)
        }
        if (next.message != null) job.message = next.message
        if (next.result !== undefined) job.result = cloneStoreProjectionValue(next.result)
        touchJob(job)
    }

    async function runJob(jobId: string, input: unknown) {
        const job = store.state.jobs[jobId]
        if (!job || job.state == 'cancelled' || closed) return
        const file = store.state.files[job.fileId]
        if (!file) return
        job.state = 'running'
        touchJob(job)
        try {
            const output = await runner.run({
                file: copyFile(file),
                job: copyJob(job),
                input,
                report: next => reportJob(jobId, next),
                cancelled: () => cancelled.has(jobId) || closed,
            })
            if (cancelled.has(jobId) || closed || store.state.jobs[jobId]?.state == 'cancelled') return
            job.state = 'ready'
            job.progress = 1
            if (output?.result !== undefined) job.result = cloneStoreProjectionValue(output.result)
            touchJob(job)
        } catch (error) {
            if (cancelled.has(jobId) || closed || store.state.jobs[jobId]?.state == 'cancelled') return
            job.state = 'failed'
            job.error = errorText(error)
            touchJob(job)
        }
    }

    function startJob(account: string, fileId: string, input: unknown) {
        const file = requireFile(account, fileId, 'process')
        if (file.state != 'uploaded') throw new Error('file process: expected uploaded resource')
        const createdAt = now()
        const job: FileJob = {
            id: makeId(), fileId, owner: account, state: 'queued', progress: 0,
            createdAt, updatedAt: createdAt,
        }
        store.state.jobs[job.id] = job
        void runJob(job.id, input)
        return copyJob(job)
    }

    function cancelJob(account: string, jobId: string) {
        const job = store.state.jobs[jobId]
        const file = job && store.state.files[job.fileId]
        if (!job || !file || !writable(account, file)) throw new Error('file job cancel: forbidden or missing')
        if (job.state == 'ready' || job.state == 'failed' || job.state == 'cancelled') return copyJob(job)
        cancelled.add(jobId)
        job.state = 'cancelled'
        job.message = 'cancelled'
        touchJob(job)
        return copyJob(job)
    }

    async function download(account: string, fileId: string) {
        const file = requireFile(account, fileId, 'download')
        if (file.state != 'uploaded') throw new Error('file download: expected uploaded resource')
        if (!storage.download) throw new Error('file download: storage does not expose downloads')
        return storage.download({file: copyFile(file)})
    }

    function connection(account: string) {
        if (closed) throw new Error('file job host closed')
        const {view, replay} = createView(account)
        views.add(view)
        let connectionClosed = false
        return {
            fragment: {
                state: replay.api.replay,
                startUpload: (request: FileUploadRequest) => startUpload(account, request),
                confirmUpload: (fileId: string) => confirmUpload(account, fileId),
                startJob: (fileId: string, input: unknown) => startJob(account, fileId, input),
                cancelJob: (jobId: string) => cancelJob(account, jobId),
                download: (fileId: string) => download(account, fileId),
            },
            close() {
                if (connectionClosed) return
                connectionClosed = true
                view.close()
            },
        }
    }

    return {
        connection,
        /** Server-side, authoritative metadata. Do not expose this global Store to RPC clients. */
        store,
        close() {
            if (closed) return
            closed = true
            offStore()
            for (const view of Array.from(views)) view.close()
            cancelled.clear()
        },
    }
}

export type FileJobHost = ReturnType<typeof createFileJobHost>
