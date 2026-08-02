import {strict as assert} from 'node:assert'

import {sha256Hex} from '../src/Common/artifact/artifact-hash'
import {createModuleArtifactVerifier} from '../src/Common/dynamic/module-verifier'
import {
    createModuleArtifactProvider,
    createModuleArtifactRegistry,
    ModuleArtifactPublication,
} from '../experiments/dynamic-runtime/artifact-registry'

async function publication(): Promise<ModuleArtifactPublication> {
    const bytes = new TextEncoder().encode('function createModule() { return {} }')
    const digest = await sha256Hex(bytes)
    const base = {
        manifestProtocol: 1,
        moduleId: 'artifact-test',
        version: '1.0.0',
        contentHash: 'sha256:' + digest,
        entrypoint: './index.js',
        compatibility: {
            api: {contractId: 'artifact.test.port', version: '1.0.0'},
            runtime: {name: 'node', range: '>=18'},
        },
        dependencies: [],
        capabilities: ['artifact-test'],
        permissions: {},
        integrity: {algorithm: 'sha256', digest, size: bytes.byteLength},
        health: {
            checkHook: 'health.check',
            timeoutMs: 100,
            failureThreshold: 1,
        },
        budget: {
            callTimeoutMs: 100,
            warmupTimeoutMs: 100,
        },
        signature: {
            algorithm: 'test',
            keyId: 'artifact-publisher',
            value: 'artifact-valid-signature',
            signedFields: [] as string[],
        },
    }
    return {
        manifest: JSON.stringify({
            ...base,
            signature: {
                ...base.signature,
                signedFields: Object.keys(base).filter(field => field != 'signature').sort(),
            },
        }),
        bytes,
        source: {
            kind: 'git',
            repository: 'wenay-common2',
            commit: 'artifact-test-commit',
            path: 'artifact-test/index.js',
        },
    }
}

async function main() {
    const verifier = createModuleArtifactVerifier({
        verifySignature: input => input.signature == 'artifact-valid-signature',
        policy: {
            publisherKeyIds: ['artifact-publisher'],
            capabilities: ['artifact-test'],
        },
    })
    const registry = createModuleArtifactRegistry({verifier})
    const input = await publication()
    const corrupt = new Uint8Array(input.bytes as Uint8Array)
    corrupt[0] = corrupt[0]! ^ 0xff
    await assert.rejects(
        () => registry.control.publish({...input, bytes: corrupt}),
        /artifact bytes do not match contentHash/,
    )
    assert.equal(registry.view.stats().artifacts, 0, 'unverified code never enters the registry')

    const descriptor = await registry.control.publish(input)
    assert.equal(descriptor.source.commit, 'artifact-test-commit')
    assert.deepEqual(await registry.control.publish(input), descriptor)
    await assert.rejects(
        () => registry.control.publish({
            ...input,
            source: {...input.source, commit: 'different-commit'},
        }),
        /immutable source provenance conflicts/,
    )

    const provider = createModuleArtifactProvider({registry})
    const copies = await Promise.all(Array.from({length: 20}, function fetchConcurrent() {
        return provider.resource.fetch(descriptor.artifactRef)
    }))
    assert.equal(registry.view.stats().fetches, 1, 'concurrent same-hash misses fold into one fetch')
    assert.equal(provider.view.stats().entries, 1)
    assert.equal(provider.view.stats().misses, 20)
    const original = copies[1]!.bytes[0]
    copies[0]!.bytes[0] = copies[0]!.bytes[0]! ^ 0xff
    const cached = await provider.resource.fetch(descriptor.artifactRef)
    assert.equal(cached.bytes[0], original, 'callers receive defensive byte copies')
    assert.equal(provider.view.stats().hits, 1)

    const corruptProvider = createModuleArtifactProvider({
        registry: {
            resource: {
                describe: registry.resource.describe,
                async fetch(artifactRef) {
                    const fetched = await registry.resource.fetch(artifactRef)
                    fetched.bytes[0] = fetched.bytes[0]! ^ 0xff
                    return fetched
                },
            },
        },
    })
    await assert.rejects(
        () => corruptProvider.resource.fetch(descriptor.artifactRef),
        /integrity check failed/,
    )
    const changedManifestProvider = createModuleArtifactProvider({
        registry: {
            resource: {
                describe(artifactRef) {
                    const described = registry.resource.describe(artifactRef)
                    return {...described, manifest: described.manifest + ' '}
                },
                fetch: registry.resource.fetch,
            },
        },
    })
    await assert.rejects(
        () => changedManifestProvider.resource.fetch(descriptor.artifactRef),
        /manifest does not match artifactRef/,
    )
    console.log('[dynamic artifact registry] verified publication, immutability, single-flight, corruption: ok')
}

void main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
