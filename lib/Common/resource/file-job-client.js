"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFileJobClient = createFileJobClient;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
function createFileJobClient(deps) {
    const { remote, initial = { files: {}, jobs: {} }, drain } = deps;
    const store = (0, store_1.createStore)(initial, drain !== undefined ? { drain } : {});
    const sync = (0, store_replay_1.syncStoreReplay)(store, remote.state);
    async function startUpload(request) {
        return remote.startUpload(request);
    }
    async function confirmUpload(fileId) {
        return remote.confirmUpload(fileId);
    }
    async function startJob(fileId, input) {
        return remote.startJob(fileId, input);
    }
    async function cancelJob(jobId) {
        return remote.cancelJob(jobId);
    }
    async function download(fileId) {
        return remote.download(fileId);
    }
    return {
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
    };
}
