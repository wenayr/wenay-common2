import {strict as assert} from 'node:assert'
import {sha256Hex} from '../src/Common/artifact/artifact-hash'
import {validateModuleManifest} from '../src/Common/dynamic/module-manifest'
import {createModuleArtifactVerifier} from '../src/Common/dynamic/module-verifier'

async function manifestFor(bytes: Uint8Array, changes: Record<string, unknown> = {}) {
    const digest = await sha256Hex(bytes)
    const base = {
        manifestProtocol: 1,
        moduleId: 'compression-b',
        version: '2.0.0',
        contentHash: 'sha256:' + digest,
        entrypoint: './dist/index.mjs',
        compatibility: {
            api: {contractId: 'compression.port', version: '1.0.0'},
            schema: {id: 'compression.schema', version: '1.0.0'},
            state: {id: 'compression.state', version: '1.0.0'},
            runtime: {name: 'node', range: '>=18'},
        },
        dependencies: [{
            moduleId: 'compression-c',
            apiRange: '^1.0.0',
            required: true,
            capabilities: ['compress'],
        }, {
            moduleId: 'compression-d',
            apiRange: '^1.0.0',
            required: false,
            degradation: 'unavailable-result',
        }],
        capabilities: ['compress'],
        permissions: {
            network: ['https://modules.example.test'],
            storage: ['compression-cache'],
            secrets: ['compression-key'],
        },
        integrity: {
            algorithm: 'sha256',
            digest,
            size: bytes.byteLength,
        },
        migration: {
            fromStateRanges: ['^1.0.0'],
            prepareHook: 'migration.prepare',
            commitHook: 'migration.commit',
            abortHook: 'migration.abort',
            reversible: true,
        },
        health: {
            warmupHook: 'health.warmup',
            checkHook: 'health.check',
            timeoutMs: 1_000,
            failureThreshold: 3,
        },
        budget: {
            callTimeoutMs: 500,
            warmupTimeoutMs: 2_000,
            memoryMb: 128,
            cpuMs: 500,
            concurrency: 8,
        },
        signature: {
            algorithm: 'test-signature',
            keyId: 'publisher-main',
            value: 'valid-signature',
            signedFields: [] as string[],
        },
        ...changes,
    }
    const signature = {
        ...base.signature,
        signedFields: Object.keys(base).filter(field => field != 'signature').sort(),
    }
    return {...base, signature}
}

function verifier(signatureResult: boolean | {accepted: boolean, reason?: string} = true) {
    let signatureCalls = 0
    const instance = createModuleArtifactVerifier({
        async verifySignature() {
            signatureCalls++
            return signatureResult
        },
        policy: {
            publisherKeyIds: ['publisher-main'],
            capabilities: ['compress'],
            permissions: {
                network: ['https://modules.example.test'],
                storage: ['compression-cache'],
                secrets: ['compression-key'],
            },
        },
        now: () => 1234,
    })
    return {instance, signatureCalls: () => signatureCalls}
}

async function rejects(label: string, work: () => unknown | Promise<unknown>, pattern: RegExp) {
    await assert.rejects(work, pattern, label)
}

async function main() {
    const source = new TextEncoder().encode(
        'globalThis.__dynamicModuleWasEvaluated = true; export const compress = () => 1',
    )
    const manifest = await manifestFor(source)
    const accepted = verifier()
    const verified = await accepted.instance.control.verify({manifest: JSON.stringify(manifest), bytes: source})

    assert.equal((globalThis as any).__dynamicModuleWasEvaluated, undefined,
        'verification must not evaluate artifact bytes')
    assert.equal(accepted.signatureCalls(), 1)
    assert.equal(verified.descriptor.contentHash, manifest.contentHash)
    assert.equal(verified.descriptor.verifiedAt, 1234)
    assert.ok(Object.isFrozen(verified))
    assert.ok(Object.isFrozen(verified.manifest))
    assert.ok(Object.isFrozen(verified.manifest.compatibility))
    assert.ok(Object.isFrozen(verified.descriptor))

    source.fill(0)
    const firstRead = verified.resource.bytes()
    assert.notEqual(firstRead[0], 0, 'verified artifact must own the provider bytes')
    firstRead.fill(0)
    assert.notEqual(verified.resource.bytes()[0], 0, 'each resource read must be a defensive copy')

    const cleanBytes = new TextEncoder().encode('export const value = 1')
    const cleanManifest = await manifestFor(cleanBytes)

    const corrupt = verifier()
    await rejects(
        'corrupt bytes are rejected',
        () => corrupt.instance.control.verify({
            manifest: JSON.stringify(cleanManifest),
            bytes: new TextEncoder().encode('export const value = 2'),
        }),
        /artifact (size does not match|bytes do not match)/,
    )
    assert.equal(corrupt.signatureCalls(), 0, 'signature verification must not run before integrity succeeds')

    const badSignature = verifier({accepted: false, reason: 'publisher proof is invalid'})
    await rejects(
        'bad signatures are rejected',
        () => badSignature.instance.control.verify({manifest: JSON.stringify(cleanManifest), bytes: cleanBytes}),
        /publisher proof is invalid/,
    )
    assert.equal(badSignature.signatureCalls(), 1)

    const traversal = await manifestFor(cleanBytes, {entrypoint: './../outside.mjs'})
    await rejects(
        'entrypoint traversal is rejected before signature work',
        () => verifier().instance.control.verify({manifest: JSON.stringify(traversal), bytes: cleanBytes}),
        /entrypoint/,
    )

    const invalidBudget = await manifestFor(cleanBytes, {
        budget: {callTimeoutMs: 0, warmupTimeoutMs: 2_000},
    })
    await rejects(
        'invalid budgets are rejected',
        () => verifier().instance.control.verify({manifest: JSON.stringify(invalidBudget), bytes: cleanBytes}),
        /budget\.callTimeoutMs/,
    )

    const deniedCapability = await manifestFor(cleanBytes, {capabilities: ['shell']})
    await rejects(
        'undeclared host capabilities fail closed',
        () => verifier().instance.control.verify({manifest: JSON.stringify(deniedCapability), bytes: cleanBytes}),
        /capability is not allowed: shell/,
    )

    const unknownProtocol = await manifestFor(cleanBytes, {manifestProtocol: 2})
    await rejects(
        'unknown protocols fail closed',
        () => verifier().instance.control.verify({manifest: JSON.stringify(unknownProtocol), bytes: cleanBytes}),
        /manifestProtocol is unsupported/,
    )

    const unknownField = await manifestFor(cleanBytes, {ambientLoader: 'node:module'})
    await rejects(
        'unknown executable metadata is rejected',
        () => verifier().instance.control.verify({manifest: JSON.stringify(unknownField), bytes: cleanBytes}),
        /unknown field ambientLoader/,
    )

    const incompleteSignature = {
        ...cleanManifest,
        signature: {
            ...cleanManifest.signature,
            signedFields: cleanManifest.signature.signedFields.filter(field => field != 'budget'),
        },
    }
    await rejects(
        'the signature must cover every manifest field',
        () => verifier().instance.control.verify({
            manifest: JSON.stringify(incompleteSignature),
            bytes: cleanBytes,
        }),
        /signedFields must cover every present manifest field/,
    )

    const objectWithAccessor = {...cleanManifest} as Record<string, unknown>
    Object.defineProperty(objectWithAccessor, 'moduleId', {get() { throw new Error('accessor executed') }})
    assert.throws(
        () => validateModuleManifest(objectWithAccessor),
        /must be inert data/,
        'accessor-backed fields are rejected as non-inert data',
    )

    assert.throws(
        () => validateModuleManifest(' '.repeat(1025), {maxManifestBytes: 1024}),
        /exceeds maxManifestBytes/,
        'oversized documents are bounded before JSON parsing',
    )

    console.log('dynamic module manifest/verifier: all passed')
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(1)
})
