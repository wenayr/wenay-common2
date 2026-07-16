"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createArtifactFrame = createArtifactFrame;
function instructionOrigin(instruction) {
    try {
        return new URL(instruction.url).origin;
    }
    catch {
        throw new Error('artifact frame: open instruction must use an absolute URL');
    }
}
function configureFrame(frame) {
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', '');
}
function createArtifactFrame(deps) {
    const { artifacts, frame, allowedOrigins } = deps;
    if (allowedOrigins.length == 0)
        throw new Error('artifact frame: allowedOrigins is required');
    const origins = new Set(allowedOrigins);
    let current;
    async function mount(artifactId) {
        const artifact = artifacts.store.state.artifacts[artifactId];
        if (!artifact)
            throw new Error('artifact frame: artifact is missing from the local mirror');
        if (artifact.descriptor.runtime != 'sandboxed-iframe')
            throw new Error('artifact frame: descriptor is not an iframe artifact');
        const instruction = await artifacts.open(artifactId);
        if (!origins.has(instructionOrigin(instruction)))
            throw new Error('artifact frame: open origin is not allowed');
        configureFrame(frame);
        frame.src = instruction.url;
        current = artifactId;
        return { artifact, instruction };
    }
    function clear() {
        frame.src = 'about:blank';
        current = undefined;
    }
    return {
        mount,
        clear,
        current: () => current,
    };
}
