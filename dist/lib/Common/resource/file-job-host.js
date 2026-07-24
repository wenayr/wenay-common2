"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFileJobHost = createFileJobHost;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
const store_projection_1 = require("../Observe/store-projection");
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
function clampProgress(value) {
    return Math.max(0, Math.min(1, value));
}
function copyFile(file) {
    return { ...file };
}
function copyJob(job) {
    return {
        ...job,
        ...(job.result !== undefined ? { result: (0, store_projection_1.cloneStoreProjectionValue)(job.result) } : {}),
    };
}
function createFileJobHost(deps) {
    const { storage, runner, policy, history, drain, now = Date.now } = deps;
    let nextId = 0;
    const makeId = deps.id ?? function defaultId() { return 'resource-' + (++nextId); };
    const store = (0, store_1.createStore)({ files: {}, jobs: {} }, drain !== undefined ? { drain } : {});
    const views = new Set();
    const cancelled = new Set();
    let closed = false;
    function readable(account, file) {
        return policy?.canRead ? policy.canRead(account, file) : file.owner == account;
    }
    function writable(account, file) {
        return policy?.canWrite ? policy.canWrite(account, file) : file.owner == account;
    }
    function requireFile(account, fileId, action) {
        const file = store.state.files[fileId];
        if (!file || !writable(account, file))
            throw new Error('file ' + action + ': forbidden or missing');
        return file;
    }
    function project(account) {
        const files = {};
        const jobs = {};
        for (const [id, file] of Object.entries(store.state.files)) {
            if (readable(account, file))
                files[id] = copyFile(file);
        }
        for (const [id, job] of Object.entries(store.state.jobs)) {
            if (files[job.fileId])
                jobs[id] = copyJob(job);
        }
        return { files, jobs };
    }
    function refreshViews(change) {
        if (closed)
            return;
        for (const view of views)
            view.refresh(change);
    }
    const offStore = store.listenPaths().on(refreshViews);
    function createView(account) {
        const state = (0, store_1.createStore)(project(account), drain !== undefined ? { drain } : {});
        const replay = (0, store_replay_1.exposeStoreReplay)(state, history == undefined ? { batch: true } : { history, batch: true });
        function refreshJob(id) {
            const job = store.state.jobs[id];
            const visible = !!job && !!state.state.files[job.fileId];
            (0, store_projection_1.reconcileStoreProjectionRecord)(state, 'jobs', id, {
                exists: visible,
                ...(visible ? { value: copyJob(job) } : {}),
            });
        }
        function refreshFile(id) {
            const file = store.state.files[id];
            const wasVisible = !!state.state.files[id];
            const visible = !!file && readable(account, file);
            (0, store_projection_1.reconcileStoreProjectionRecord)(state, 'files', id, {
                exists: visible,
                ...(visible ? { value: copyFile(file) } : {}),
            });
            if (visible == wasVisible)
                return;
            const jobs = visible ? store.state.jobs : state.state.jobs;
            for (const job of Object.values(jobs))
                if (job.fileId == id)
                    refreshJob(job.id);
        }
        function refreshProjection(change) {
            if (policy?.canRead) {
                (0, store_projection_1.reconcileStoreProjection)(state, project(account));
                return;
            }
            const changed = (0, store_projection_1.collectStoreProjectionChanges)(change, ['files', 'jobs']);
            if (!changed) {
                (0, store_projection_1.reconcileStoreProjection)(state, project(account));
                return;
            }
            for (const id of changed.get('files') ?? [])
                refreshFile(String(id));
            for (const id of changed.get('jobs') ?? [])
                refreshJob(String(id));
        }
        let view;
        view = {
            refresh: refreshProjection,
            close() {
                views.delete(view);
                replay.close();
            },
        };
        return { view, replay };
    }
    function touch(file) {
        file.updatedAt = now();
    }
    function touchJob(job) {
        job.updatedAt = now();
    }
    async function startUpload(account, request) {
        if (!request || typeof request.name != 'string' || !request.name.trim())
            throw new Error('file upload: name is required');
        if (!Number.isFinite(request.size) || request.size < 0)
            throw new Error('file upload: size must be a non-negative number');
        const createdAt = now();
        const file = {
            id: makeId(), owner: account, name: request.name, size: request.size,
            state: 'uploading', createdAt, updatedAt: createdAt,
            ...(request.mime ? { mime: request.mime } : {}),
        };
        const upload = await storage.beginUpload({ file: copyFile(file) });
        if (closed)
            throw new Error('file upload: host closed');
        store.state.files[file.id] = file;
        return { file: copyFile(file), upload };
    }
    async function confirmUpload(account, fileId) {
        const file = requireFile(account, fileId, 'confirm');
        if (file.state != 'uploading')
            throw new Error('file confirm: expected uploading resource');
        try {
            await storage.confirmUpload?.({ file: copyFile(file) });
            file.state = 'uploaded';
            delete file.error;
        }
        catch (error) {
            file.state = 'failed';
            file.error = errorText(error);
            throw error;
        }
        finally {
            touch(file);
        }
        return copyFile(file);
    }
    function reportJob(jobId, next) {
        const job = store.state.jobs[jobId];
        if (!job || job.state == 'cancelled' || job.state == 'failed' || job.state == 'ready')
            return;
        if (next.progress != null) {
            if (!Number.isFinite(next.progress))
                throw new Error('file job: progress must be finite');
            job.progress = clampProgress(next.progress);
        }
        if (next.message != null)
            job.message = next.message;
        if (next.result !== undefined)
            job.result = (0, store_projection_1.cloneStoreProjectionValue)(next.result);
        touchJob(job);
    }
    async function runJob(jobId, input) {
        const job = store.state.jobs[jobId];
        if (!job || job.state == 'cancelled' || closed)
            return;
        const file = store.state.files[job.fileId];
        if (!file)
            return;
        job.state = 'running';
        touchJob(job);
        try {
            const output = await runner.run({
                file: copyFile(file),
                job: copyJob(job),
                input,
                report: next => reportJob(jobId, next),
                cancelled: () => cancelled.has(jobId) || closed,
            });
            if (cancelled.has(jobId) || closed || store.state.jobs[jobId]?.state == 'cancelled')
                return;
            job.state = 'ready';
            job.progress = 1;
            if (output?.result !== undefined)
                job.result = (0, store_projection_1.cloneStoreProjectionValue)(output.result);
            touchJob(job);
        }
        catch (error) {
            if (cancelled.has(jobId) || closed || store.state.jobs[jobId]?.state == 'cancelled')
                return;
            job.state = 'failed';
            job.error = errorText(error);
            touchJob(job);
        }
    }
    function startJob(account, fileId, input) {
        const file = requireFile(account, fileId, 'process');
        if (file.state != 'uploaded')
            throw new Error('file process: expected uploaded resource');
        const createdAt = now();
        const job = {
            id: makeId(), fileId, owner: account, state: 'queued', progress: 0,
            createdAt, updatedAt: createdAt,
        };
        store.state.jobs[job.id] = job;
        void runJob(job.id, input);
        return copyJob(job);
    }
    function cancelJob(account, jobId) {
        const job = store.state.jobs[jobId];
        const file = job && store.state.files[job.fileId];
        if (!job || !file || !writable(account, file))
            throw new Error('file job cancel: forbidden or missing');
        if (job.state == 'ready' || job.state == 'failed' || job.state == 'cancelled')
            return copyJob(job);
        cancelled.add(jobId);
        job.state = 'cancelled';
        job.message = 'cancelled';
        touchJob(job);
        return copyJob(job);
    }
    async function download(account, fileId) {
        const file = requireFile(account, fileId, 'download');
        if (file.state != 'uploaded')
            throw new Error('file download: expected uploaded resource');
        if (!storage.download)
            throw new Error('file download: storage does not expose downloads');
        return storage.download({ file: copyFile(file) });
    }
    function connection(account) {
        if (closed)
            throw new Error('file job host closed');
        const { view, replay } = createView(account);
        views.add(view);
        let connectionClosed = false;
        return {
            fragment: {
                state: replay.api.replay,
                startUpload: (request) => startUpload(account, request),
                confirmUpload: (fileId) => confirmUpload(account, fileId),
                startJob: (fileId, input) => startJob(account, fileId, input),
                cancelJob: (jobId) => cancelJob(account, jobId),
                download: (fileId) => download(account, fileId),
            },
            close() {
                if (connectionClosed)
                    return;
                connectionClosed = true;
                view.close();
            },
        };
    }
    return {
        connection,
        store,
        close() {
            if (closed)
                return;
            closed = true;
            offStore();
            for (const view of Array.from(views))
                view.close();
            cancelled.clear();
        },
    };
}
