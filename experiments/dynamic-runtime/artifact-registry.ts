import {createArtifactByteCache} from '../../src/Common/artifact/artifact-cache'
import {sha256Hex} from '../../src/Common/artifact/artifact-hash'
import {ArtifactRecord} from '../../src/Common/artifact/artifact-host'
import {listen as createListenPair} from '../../src/Common/events/Listen'
import {
    canonicalModuleManifest,
    tSerializedModuleManifest,
} from '../../src/Common/dynamic/module-manifest'
import {
    ModuleArtifactVerifier,
    tModuleArtifactBytes,
} from '../../src/Common/dynamic/module-verifier'

export type tModuleArtifactRef = `sha256:${string}`

export type ModuleArtifactSource = {
    kind: 'git'
    repository: string
    commit: string
    path: string
}

export type ModuleArtifactDescriptor = {
    artifactRef: tModuleArtifactRef
    moduleId: string
    version: string
    contentHash: tModuleArtifactRef
    manifestHash: tModuleArtifactRef
    publisherKeyId: string
    source: ModuleArtifactSource
    publishedAt: number
}

export type ModuleArtifactPublication = {
    manifest: tSerializedModuleManifest
    bytes: tModuleArtifactBytes
    source: ModuleArtifactSource
    expectedRef?: tModuleArtifactRef
}

export type tModuleArtifactRegistryEvent =
    | {type: 'published', descriptor: ModuleArtifactDescriptor}
    | {type: 'fetched', artifactRef: tModuleArtifactRef}

export type ModuleArtifactRegistryDeps = {
    verifier: ModuleArtifactVerifier
    now?: () => number
}

type StoredArtifact = {
    descriptor: ModuleArtifactDescriptor
    manifest: string
    bytes: Uint8Array
}

function ownedBytes(bytes: Uint8Array) {
    const owned = new Uint8Array(bytes.byteLength)
    owned.set(bytes)
    return owned
}

function copySource(source: ModuleArtifactSource): ModuleArtifactSource {
    return {...source}
}

function copyDescriptor(descriptor: ModuleArtifactDescriptor): ModuleArtifactDescriptor {
    return {...descriptor, source: copySource(descriptor.source)}
}

function sameSource(a: ModuleArtifactSource, b: ModuleArtifactSource) {
    return a.kind == b.kind
        && a.repository == b.repository
        && a.commit == b.commit
        && a.path == b.path
}

export function createModuleArtifactRegistry(deps: ModuleArtifactRegistryDeps) {
    const now = deps.now ?? Date.now
    const artifacts = new Map<tModuleArtifactRef, StoredArtifact>()
    const [emitEvent, events] = createListenPair<[tModuleArtifactRegistryEvent]>()
    let fetches = 0

    async function publish(input: ModuleArtifactPublication) {
        const verified = await deps.verifier.control.verify({
            manifest: input.manifest,
            bytes: input.bytes,
        })
        const artifactRef = verified.descriptor.manifestHash as tModuleArtifactRef
        if (input.expectedRef != undefined && input.expectedRef != artifactRef) {
            throw new Error('module artifact registry: expectedRef does not match the verified manifest')
        }
        const existing = artifacts.get(artifactRef)
        if (existing) {
            if (!sameSource(existing.descriptor.source, input.source)) {
                throw new Error('module artifact registry: immutable source provenance conflicts for ' + artifactRef)
            }
            return copyDescriptor(existing.descriptor)
        }
        const descriptor: ModuleArtifactDescriptor = {
            artifactRef,
            moduleId: verified.descriptor.moduleId,
            version: verified.descriptor.version,
            contentHash: verified.descriptor.contentHash as tModuleArtifactRef,
            manifestHash: artifactRef,
            publisherKeyId: verified.descriptor.publisherKeyId,
            source: copySource(input.source),
            publishedAt: now(),
        }
        const stored: StoredArtifact = {
            descriptor,
            manifest: canonicalModuleManifest(verified.manifest),
            bytes: verified.resource.bytes(),
        }
        artifacts.set(artifactRef, stored)
        emitEvent({type: 'published', descriptor: copyDescriptor(descriptor)})
        return copyDescriptor(descriptor)
    }

    function describe(artifactRef: tModuleArtifactRef) {
        const stored = artifacts.get(artifactRef)
        if (!stored) throw new Error('module artifact registry: artifact is unavailable: ' + artifactRef)
        return {
            descriptor: copyDescriptor(stored.descriptor),
            manifest: stored.manifest,
        }
    }

    async function fetch(artifactRef: tModuleArtifactRef) {
        const stored = artifacts.get(artifactRef)
        if (!stored) throw new Error('module artifact registry: artifact is unavailable: ' + artifactRef)
        fetches++
        emitEvent({type: 'fetched', artifactRef})
        return {
            descriptor: copyDescriptor(stored.descriptor),
            manifest: stored.manifest,
            bytes: ownedBytes(stored.bytes),
        }
    }

    return {
        control: {
            publish,
        },
        resource: {
            describe,
            fetch,
        } satisfies ModuleArtifactResource,
        events: {
            on: events.on,
        },
        view: {
            snapshot() {
                return [...artifacts.values()].map(stored => copyDescriptor(stored.descriptor))
            },
            stats: () => ({artifacts: artifacts.size, fetches}),
        },
    }
}

export type ModuleArtifactRegistry = ReturnType<typeof createModuleArtifactRegistry>

export type ModuleArtifactResource = {
    describe: (artifactRef: tModuleArtifactRef) => {
        descriptor: ModuleArtifactDescriptor
        manifest: string
    } | Promise<{
        descriptor: ModuleArtifactDescriptor
        manifest: string
    }>
    fetch: (artifactRef: tModuleArtifactRef) => {
        descriptor: ModuleArtifactDescriptor
        manifest: string
        bytes: Uint8Array
    } | Promise<{
        descriptor: ModuleArtifactDescriptor
        manifest: string
        bytes: Uint8Array
    }>
}

export type ModuleArtifactProviderDeps = {
    registry: {resource: ModuleArtifactResource}
    maxBytes?: number
}

export function createModuleArtifactProvider(deps: ModuleArtifactProviderDeps) {
    const cache = createArtifactByteCache({
        maxBytes: deps.maxBytes,
        async fetch(artifact) {
            const fetched = await deps.registry.resource.fetch(artifact.id as tModuleArtifactRef)
            return fetched.bytes
        },
    })

    function cacheRecord(descriptor: ModuleArtifactDescriptor): ArtifactRecord {
        return {
            id: descriptor.artifactRef,
            owner: descriptor.publisherKeyId,
            descriptor: {
                kind: 'dynamic-module',
                label: descriptor.moduleId + '@' + descriptor.version,
                runtime: 'download',
                version: descriptor.contentHash.slice('sha256:'.length),
            },
            state: 'ready',
            retention: {class: 'persistent'},
            createdAt: descriptor.publishedAt,
            updatedAt: descriptor.publishedAt,
        }
    }

    async function fetch(artifactRef: tModuleArtifactRef) {
        const described = await deps.registry.resource.describe(artifactRef)
        if (described.descriptor.artifactRef != artifactRef
            || described.descriptor.manifestHash != artifactRef) {
            throw new Error('module artifact provider: registry descriptor does not match artifactRef')
        }
        const manifestHash = 'sha256:' + await sha256Hex(described.manifest)
        if (manifestHash != artifactRef) {
            throw new Error('module artifact provider: manifest does not match artifactRef')
        }
        const cached = await cache.get(cacheRecord(described.descriptor))
        return {
            descriptor: described.descriptor,
            manifest: described.manifest,
            bytes: cached.bytes,
        }
    }

    return {
        resource: {
            fetch,
        },
        view: {
            stats: cache.stats,
        },
        control: {
            clear: cache.clear,
        },
    }
}

export type ModuleArtifactProvider = ReturnType<typeof createModuleArtifactProvider>
