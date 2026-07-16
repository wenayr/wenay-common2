"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createArtifactHost = createArtifactHost;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
function copyDescriptor(descriptor) {
    return { ...descriptor };
}
function copyRetention(retention) {
    return { ...retention };
}
function copyArtifact(artifact) {
    return { ...artifact, descriptor: copyDescriptor(artifact.descriptor), retention: copyRetention(artifact.retention) };
}
function validateDescriptor(descriptor) {
    if (!descriptor || typeof descriptor.kind != 'string' || !descriptor.kind.trim())
        throw new Error('artifact register: descriptor kind is required');
    if (typeof descriptor.label != 'string' || !descriptor.label.trim())
        throw new Error('artifact register: descriptor label is required');
    if (descriptor.runtime != 'sandboxed-iframe' && descriptor.runtime != 'download')
        throw new Error('artifact register: unsupported runtime');
}
function validateRetention(retention, now) {
    if (retention.class != 'ephemeral' && retention.class != 'persistent')
        throw new Error('artifact register: invalid retention class');
    if (retention.class == 'ephemeral' && retention.expiresAt == null)
        throw new Error('artifact register: ephemeral expiry is required');
    if (retention.expiresAt != null && (!Number.isFinite(retention.expiresAt) || retention.expiresAt <= now)) {
        throw new Error('artifact register: expiry must be in the future');
    }
}
function validateOpenInstruction(instruction, now) {
    if (!instruction || typeof instruction.url != 'string' || !instruction.url)
        throw new Error('artifact storage: URL is required');
    if (!Number.isFinite(instruction.expiresAt) || instruction.expiresAt <= now)
        throw new Error('artifact storage: open instruction is already expired');
    try {
        new URL(instruction.url);
    }
    catch {
        throw new Error('artifact storage: URL must be absolute');
    }
    return { ...instruction };
}
function createArtifactHost(deps) {
    const { storage, policy, history, drain, now = Date.now } = deps;
    let nextId = 0;
    const makeId = deps.id ?? function defaultId() { return 'artifact-' + (++nextId); };
    const store = (0, store_1.createStore)({ artifacts: {} }, drain !== undefined ? { drain } : {});
    const storageKeys = new Map();
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
        for (const [id, artifact] of Object.entries(store.state.artifacts)) {
            if (readable(account, artifact))
                artifacts[id] = copyArtifact(artifact);
        }
        return { artifacts };
    }
    function refreshViews() {
        if (closed)
            return;
        for (const view of views)
            view.refresh();
    }
    const offStore = store.listenPaths().on(refreshViews);
    function createView(account) {
        const state = (0, store_1.createStore)(project(account), drain !== undefined ? { drain } : {});
        const replay = (0, store_replay_1.exposeStoreReplay)(state, history !== undefined ? { history } : {});
        let view;
        view = {
            refresh() { state.replace(project(account)); },
            close() {
                views.delete(view);
                replay.close();
            },
        };
        return { view, replay };
    }
    function touch(artifact) {
        artifact.updatedAt = now();
    }
    function isExpired(artifact, at = now()) {
        return artifact.retention.expiresAt != null && artifact.retention.expiresAt <= at;
    }
    async function removeStorage(artifact, reason) {
        const storageKey = storageKeys.get(artifact.id);
        if (storageKey === undefined)
            return;
        await storage.remove?.({ artifact: copyArtifact(artifact), storageKey, reason });
        storageKeys.delete(artifact.id);
    }
    async function invalidate(artifact, state) {
        if (artifact.state == 'ready') {
            artifact.state = state;
            touch(artifact);
        }
        if (artifact.state != state)
            return copyArtifact(artifact);
        await removeStorage(artifact, state);
        return copyArtifact(artifact);
    }
    async function requireReadableReady(account, artifactId) {
        const artifact = store.state.artifacts[artifactId];
        if (!artifact || !readable(account, artifact))
            throw new Error('artifact open: forbidden or missing');
        if (artifact.state != 'ready')
            throw new Error('artifact open: artifact is ' + artifact.state);
        if (isExpired(artifact)) {
            await invalidate(artifact, 'expired');
            throw new Error('artifact open: artifact expired');
        }
        return artifact;
    }
    function register(input) {
        if (closed)
            throw new Error('artifact host closed');
        if (!input || typeof input.owner != 'string' || !input.owner)
            throw new Error('artifact register: owner is required');
        if (input.storageKey === undefined)
            throw new Error('artifact register: storageKey is required');
        validateDescriptor(input.descriptor);
        const retention = input.retention;
        validateRetention(retention, now());
        if (policy?.canRegister && !policy.canRegister(input))
            throw new Error('artifact register: forbidden');
        const createdAt = now();
        const artifact = {
            id: makeId(),
            owner: input.owner,
            descriptor: copyDescriptor(input.descriptor),
            state: 'ready',
            retention: copyRetention(retention),
            createdAt,
            updatedAt: createdAt,
        };
        storageKeys.set(artifact.id, input.storageKey);
        store.state.artifacts[artifact.id] = artifact;
        return copyArtifact(artifact);
    }
    async function open(account, artifactId) {
        if (closed)
            throw new Error('artifact host closed');
        const artifact = await requireReadableReady(account, artifactId);
        const storageKey = storageKeys.get(artifact.id);
        if (storageKey === undefined)
            throw new Error('artifact open: storage key is unavailable');
        const instruction = await storage.open({ artifact: copyArtifact(artifact), storageKey, account });
        return validateOpenInstruction(instruction, now());
    }
    async function revoke(account, artifactId) {
        if (closed)
            throw new Error('artifact host closed');
        const artifact = store.state.artifacts[artifactId];
        if (!artifact || !revokable(account, artifact))
            throw new Error('artifact revoke: forbidden or missing');
        return invalidate(artifact, 'revoked');
    }
    async function reap(at = now()) {
        const reaped = [];
        for (const artifact of Object.values(store.state.artifacts)) {
            const shouldExpire = artifact.state == 'ready' && isExpired(artifact, at);
            const retryRemoval = (artifact.state == 'expired' || artifact.state == 'revoked') && storageKeys.has(artifact.id);
            if (!shouldExpire && !retryRemoval)
                continue;
            const state = artifact.state == 'revoked' ? 'revoked' : 'expired';
            reaped.push(await invalidate(artifact, state));
        }
        return reaped;
    }
    function connection(account) {
        if (closed)
            throw new Error('artifact host closed');
        const { view, replay } = createView(account);
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
                view.close();
            },
        };
    }
    return {
        register,
        reap,
        connection,
        store,
        close() {
            if (closed)
                return;
            closed = true;
            offStore();
            for (const view of Array.from(views))
                view.close();
            storageKeys.clear();
        },
    };
}
