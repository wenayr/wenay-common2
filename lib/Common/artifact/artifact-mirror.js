"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createArtifactMirror = createArtifactMirror;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
const store_projection_1 = require("../Observe/store-projection");
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
    const offCatalog = catalog.listenPaths().on(function refreshMirrorViews(change) {
        if (closed)
            return;
        for (const view of views)
            view.refresh(change);
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
        const replay = (0, store_replay_1.exposeStoreReplay)(state, history == undefined ? { batch: true } : { history, batch: true });
        let connectionClosed = false;
        const view = {
            refresh: function refreshProjection(change) {
                if (policy?.canRead) {
                    (0, store_projection_1.reconcileStoreProjection)(state, project(account));
                    return;
                }
                const changed = (0, store_projection_1.collectStoreProjectionChanges)(change, ['artifacts']);
                if (!changed) {
                    (0, store_projection_1.reconcileStoreProjection)(state, project(account));
                    return;
                }
                for (const itemKey of changed.get('artifacts') ?? []) {
                    const id = String(itemKey);
                    const artifact = catalog.state.artifacts[id];
                    const visible = !!artifact && readable(account, artifact);
                    (0, store_projection_1.reconcileStoreProjectionRecord)(state, 'artifacts', id, {
                        exists: visible,
                        ...(visible ? { value: (0, artifact_host_1.copyArtifact)(artifact) } : {}),
                    });
                }
            },
            close: function closeConnectionView() {
                if (connectionClosed)
                    return;
                connectionClosed = true;
                views.delete(view);
                replay.close();
            }
        };
        views.add(view);
        return {
            fragment: {
                state: replay.api.replay,
                open: (artifactId) => open(account, artifactId),
                revoke: (artifactId) => revoke(account, artifactId),
            },
            close: view.close,
        };
    }
    return {
        connection,
        close() {
            if (closed)
                return;
            closed = true;
            offCatalog();
            for (const view of Array.from(views))
                view.close();
            views.clear();
        },
    };
}
