"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createArtifactMirror = createArtifactMirror;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
const artifact_host_1 = require("./artifact-host");
function createArtifactMirror(deps) {
    const { catalog, policy, history, drain, now = Date.now } = deps;
    const views = new Set();
    let closed = false;
    function readable(account, artifact) {
        return policy?.canRead ? policy.canRead(account, artifact) : artifact.owner == account;
    }
    function revokable(account, artifact) {
        return policy?.canRevoke ? policy.canRevoke(account, artifact) : artifact.owner == account;
    }
    function project(account) {
        const artifacts = {};
        for (const [id, artifact] of Object.entries(catalog.state.artifacts ?? {})) {
            if (readable(account, artifact))
                artifacts[id] = (0, artifact_host_1.copyArtifact)(artifact);
        }
        return { artifacts };
    }
    const offCatalog = catalog.listenPaths().on(function refreshMirrorViews() {
        if (closed)
            return;
        for (const view of views)
            view.refresh();
    });
    function isExpired(artifact) {
        return artifact.retention.expiresAt != null && artifact.retention.expiresAt <= now();
    }
    function requireReadableReady(account, artifactId) {
        const artifact = catalog.state.artifacts?.[artifactId];
        if (!artifact || !readable(account, artifact))
            throw new Error('artifact open: forbidden or missing');
        if (artifact.state != 'ready')
            throw new Error('artifact open: artifact is ' + artifact.state);
        if (isExpired(artifact))
            throw new Error('artifact open: artifact expired');
        return artifact;
    }
    async function open(account, artifactId) {
        if (closed)
            throw new Error('artifact mirror closed');
        const artifact = requireReadableReady(account, artifactId);
        const instruction = await deps.open({ artifact: (0, artifact_host_1.copyArtifact)(artifact), account });
        return (0, artifact_host_1.validateOpenInstruction)(instruction, now());
    }
    async function revoke(account, artifactId) {
        if (closed)
            throw new Error('artifact mirror closed');
        const artifact = catalog.state.artifacts?.[artifactId];
        if (!artifact || !revokable(account, artifact))
            throw new Error('artifact revoke: forbidden or missing');
        if (!deps.revoke)
            throw new Error('artifact revoke: this node is a read-only mirror');
        return deps.revoke(account, artifactId);
    }
    function connection(account) {
        if (closed)
            throw new Error('artifact mirror closed');
        const state = (0, store_1.createStore)(project(account), drain !== undefined ? { drain } : {});
        const replay = (0, store_replay_1.exposeStoreReplay)(state, history !== undefined ? { history } : {});
        const view = { refresh: function refreshProjection() { state.replace(project(account)); } };
        views.add(view);
        let connectionClosed = false;
        return {
            fragment: {
                state: replay.api.replay,
                open: (artifactId) => open(account, artifactId),
                revoke: (artifactId) => revoke(account, artifactId),
            },
            close() {
                if (connectionClosed)
                    return;
                connectionClosed = true;
                views.delete(view);
                replay.close();
            },
        };
    }
    return {
        connection,
        close() {
            if (closed)
                return;
            closed = true;
            offCatalog();
            views.clear();
        },
    };
}
