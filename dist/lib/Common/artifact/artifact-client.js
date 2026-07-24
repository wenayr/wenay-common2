"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createArtifactClient = createArtifactClient;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
function createArtifactClient(deps) {
    const { remote, initial = { artifacts: {} }, drain, batch = true } = deps;
    const store = (0, store_1.createStore)(initial, drain !== undefined ? { drain } : {});
    const sync = (0, store_replay_1.syncStoreReplay)(store, remote.state, { batch });
    async function open(artifactId) {
        return remote.open(artifactId);
    }
    async function revoke(artifactId) {
        return remote.revoke(artifactId);
    }
    return {
        store,
        ready: sync.ready,
        seq: sync.seq,
        stateMode: () => sync.mode,
        open,
        revoke,
        close() { sync(); },
    };
}
