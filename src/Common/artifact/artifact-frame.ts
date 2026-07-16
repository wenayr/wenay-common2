// =====================================================================
// Artifact iframe runtime — strict, origin-pinned browser mounting helper
// =====================================================================
// This helper deliberately has no parent bridge. An artifact app receives only
// its sandboxed document; app-specific capabilities need a separate protocol.

import {ArtifactClient} from './artifact-client'
import {ArtifactOpenInstruction, ArtifactRecord} from './artifact-host'

export type ArtifactFrame = {
    src: string
    setAttribute: (name: string, value: string) => void
}

export type ArtifactFrameDeps = {
    artifacts: ArtifactClient
    frame: ArtifactFrame
    /** Required: open instructions from any other origin are rejected before mounting. */
    allowedOrigins: readonly string[]
}

function instructionOrigin(instruction: ArtifactOpenInstruction) {
    try { return new URL(instruction.url).origin }
    catch { throw new Error('artifact frame: open instruction must use an absolute URL') }
}

function configureFrame(frame: ArtifactFrame) {
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.setAttribute('allow', '')
}

export function createArtifactFrame(deps: ArtifactFrameDeps) {
    const {artifacts, frame, allowedOrigins} = deps
    if (allowedOrigins.length == 0) throw new Error('artifact frame: allowedOrigins is required')
    const origins = new Set(allowedOrigins)
    let current: string | undefined

    async function mount(artifactId: string) {
        const artifact = artifacts.store.state.artifacts[artifactId]
        if (!artifact) throw new Error('artifact frame: artifact is missing from the local mirror')
        if (artifact.descriptor.runtime != 'sandboxed-iframe') throw new Error('artifact frame: descriptor is not an iframe artifact')
        const instruction = await artifacts.open(artifactId)
        if (!origins.has(instructionOrigin(instruction))) throw new Error('artifact frame: open origin is not allowed')
        configureFrame(frame)
        frame.src = instruction.url
        current = artifactId
        return {artifact, instruction}
    }

    function clear() {
        frame.src = 'about:blank'
        current = undefined
    }

    return {
        mount,
        clear,
        current: () => current,
    }
}

export type ArtifactFrameRuntime = ReturnType<typeof createArtifactFrame>
