import {strict as assert} from 'node:assert'
import {sha256Hex} from '../src/Common/artifact/artifact-hash'
import {createModuleArtifactVerifier} from '../src/Common/dynamic/module-verifier'
import {createDynamicModuleHost, DynamicModuleHost} from '../src/server/dynamic/module-host'
import {createModuleWorkerIsolation} from '../src/server/dynamic/module-worker-isolation'

async function manifestFor(
    source: string,
    version: string,
    changes: Record<string, unknown> = {},
) {
    const bytes = new TextEncoder().encode(source)
    const digest = await sha256Hex(bytes)
    const base = {
        manifestProtocol: 1,
        moduleId: 'compression-b',
        version,
        contentHash: 'sha256:' + digest,
        entrypoint: './index.js',
        compatibility: {
            api: {contractId: 'compression.port', version: '1.0.0'},
            runtime: {name: 'node', range: '>=18'},
        },
        dependencies: [],
        capabilities: ['compression'],
        permissions: {},
        integrity: {
            algorithm: 'sha256',
            digest,
            size: bytes.byteLength,
        },
        health: {
            warmupHook: 'health.warmup',
            checkHook: 'health.check',
            timeoutMs: 500,
            failureThreshold: 2,
        },
        budget: {
            callTimeoutMs: 1_000,
            warmupTimeoutMs: 1_000,
            memoryMb: 64,
            concurrency: 4,
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
    return {
        manifest: JSON.stringify({...base, signature}),
        bytes,
    }
}

function moduleSource(version: string, healthy = true, optionalD = false) {
    return `function createCompression(context) {
        return {
            'health.warmup'() {
                return {ok: true}
            },
            'health.check'() {
                return {ok: ${healthy}}
            },
            async identify(input, call) {
                const c = await context.dependencies.call('compression-c', 'transform', input)
                let d = null
                if (${optionalD}) {
                    try {
                        d = await context.dependencies.call('compression-d', 'enrich', c)
                    } catch (error) {
                        d = {
                            ok: false,
                            code: error.code == 'E_DEPENDENCY_UNAVAILABLE' ? 'E_UNAVAILABLE' : 'E_DEGRADED',
                            moduleId: 'compression-d',
                            retryable: true,
                        }
                    }
                }
                return {
                    ok: true,
                    input,
                    c,
                    d,
                    version: '${version}',
                    bindingGeneration: call.bindingGeneration,
                    correlationId: call.correlationId,
                }
            },
            delayed(input, call) {
                return new Promise(function waitForCompression(resolve, reject) {
                    const timer = setTimeout(function completeCompression() {
                        resolve({
                            ok: true,
                            version: '${version}',
                            bindingGeneration: call.bindingGeneration,
                        })
                    }, input.ms)
                    call.signal.addEventListener('abort', function abortCompression() {
                        clearTimeout(timer)
                        reject(call.signal.reason)
                    }, {once: true})
                })
            },
        }
    }`
}

function dependencySource(kind: 'c' | 'd') {
    const method = kind == 'c' ? 'transform' : 'enrich'
    return `function createDependency() {
        return {
            'health.warmup'() {
                return {ok: true}
            },
            'health.check'() {
                return {ok: true}
            },
            ${method}(input, call) {
                return {
                    ok: true,
                    dependency: '${kind.toUpperCase()}',
                    value: input.value ?? input,
                    bindingGeneration: call.bindingGeneration,
                }
            },
        }
    }`
}

async function expectReject(work: () => unknown | Promise<unknown>, pattern: RegExp) {
    await assert.rejects(work, pattern)
}

async function main() {
    const verifier = createModuleArtifactVerifier({
        verifySignature: input => input.signature == 'valid-signature',
        policy: {
            publisherKeyIds: ['publisher-main'],
            capabilities: ['compression'],
        },
    })
    let host: DynamicModuleHost
    const baseIsolation = createModuleWorkerIsolation({
        heartbeatIntervalMs: 20,
        heartbeatTimeoutMs: 300,
        maxInputBytes: 16 * 1024,
        maxOutputBytes: 16 * 1024,
        dependencyCall(request) {
            return host.resource.dependencyCall(request)
        },
    })
    let isolationOpens = 0
    host = createDynamicModuleHost({
        verifier,
        isolation: {
            resource: {
                open(input) {
                    const session = baseIsolation.resource.open(input)
                    isolationOpens++
                    return session
                },
            },
        },
        drainTimeoutMs: 2_000,
    })
    const bindingEvents: Array<{from: string | null, to: string | null}> = []
    host.events.on(function recordBinding(event) {
        if (event.type != 'binding' || event.binding.slotId != 'compression') return
        bindingEvents.push({
            from: event.binding.from?.descriptor.implementationVersion ?? null,
            to: event.binding.to?.descriptor.implementationVersion ?? null,
        })
    })

    await host.control.require({
        slotId: 'compression',
        contractId: 'compression.port',
        versionRange: '1.0.0',
        generation: 1,
        authorityId: 'runtime-test',
        authorityEpoch: 1,
        required: true,
    })
    assert.equal(host.view.explain('compression').state, 'failed')
    await host.control.require({
        slotId: 'compression-shadow',
        contractId: 'compression.port',
        versionRange: '1.0.0',
        generation: 1,
        authorityId: 'runtime-test',
        authorityEpoch: 1,
        required: false,
    })

    const missingDependency = await manifestFor(moduleSource('missing-c'), '0.9.0', {
        dependencies: [{
            moduleId: 'compression-c',
            apiRange: '1.0.0',
            required: true,
        }],
    })
    const opensBeforeRequiredDependency = isolationOpens
    await expectReject(() => host.control.stage({
        candidateId: 'compression-missing-c',
        slotId: 'compression',
        priority: 1,
        ...missingDependency,
    }), /compression-c: dependency slot is unavailable/)
    assert.equal(
        isolationOpens,
        opensBeforeRequiredDependency,
        'a missing required dependency rejects before isolation creation',
    )

    await host.control.require({
        slotId: 'compression-c',
        contractId: 'compression.c.port',
        versionRange: '1.0.0',
        generation: 1,
        authorityId: 'runtime-test',
        authorityEpoch: 1,
        required: true,
    })
    const c = await manifestFor(dependencySource('c'), '1.0.0', {
        moduleId: 'compression-c',
        compatibility: {
            api: {contractId: 'compression.c.port', version: '1.0.0'},
            runtime: {name: 'node', range: '>=18'},
        },
    })
    const candidateC = await host.control.stage({
        candidateId: 'compression-c-v1',
        slotId: 'compression-c',
        priority: 1,
        ...c,
    })
    await host.control.activate(candidateC.candidateId)

    const dependencyC = {
        moduleId: 'compression-c',
        apiRange: '1.0.0',
        required: true,
    }
    const dependencyD = {
        moduleId: 'compression-d',
        apiRange: '1.0.0',
        required: false,
        degradation: 'unavailable-result',
    }
    const v1 = await manifestFor(moduleSource('v1'), '1.0.0', {
        dependencies: [dependencyC],
    })
    const candidateV1 = await host.control.stage({
        candidateId: 'compression-v1',
        slotId: 'compression',
        priority: 1,
        ...v1,
    })
    assert.equal(candidateV1.state, 'ready')
    const bindingV1 = await host.control.activate(candidateV1.candidateId)
    assert.equal(bindingV1.bindingGeneration, 1)
    assert.equal(
        host.view.binding('compression-shadow'),
        null,
        'a slot-scoped offer cannot bind another slot with the same contract',
    )

    const compression = host.resource.handle('compression')
    const first = await compression.call<{
        version: string
        bindingGeneration: number
        correlationId: string
        c: {dependency: string}
    }>('identify', {value: 'first'}, {correlationId: 'call-v1'})
    assert.deepEqual({
        version: first.version,
        bindingGeneration: first.bindingGeneration,
        correlationId: first.correlationId,
    }, {
        version: 'v1',
        bindingGeneration: 1,
        correlationId: 'call-v1',
    })
    assert.equal(first.c.dependency, 'C', 'B v1 resolves C through the stable host dependency broker')

    const oldInFlight = compression.call<{version: string, bindingGeneration: number}>(
        'delayed',
        {ms: 120},
        {correlationId: 'long-v1'},
    )
    const v2 = await manifestFor(moduleSource('v2', true, true), '2.0.0', {
        dependencies: [dependencyC, dependencyD],
    })
    const candidateV2 = await host.control.stage({
        candidateId: 'compression-v2',
        slotId: 'compression',
        priority: 2,
        ...v2,
    })
    const bindingV2 = await host.control.activate(candidateV2.candidateId)
    assert.equal(bindingV2.bindingGeneration, 2)
    const current = await compression.call<{
        version: string
        bindingGeneration: number
        c: {dependency: string}
        d: {ok: false, code: string, moduleId: string}
    }>(
        'identify',
        {value: 'second'},
        {correlationId: 'call-v2'},
    )
    assert.equal(current.version, 'v2')
    assert.equal(current.bindingGeneration, 2)
    assert.equal(current.c.dependency, 'C')
    assert.deepEqual(current.d, {
        ok: false,
        code: 'E_UNAVAILABLE',
        moduleId: 'compression-d',
        retryable: true,
    }, 'optional D degrades to a typed unavailable result')
    assert.deepEqual(await oldInFlight, {ok: true, version: 'v1', bindingGeneration: 1})
    assert.equal(host.view.candidate('compression-v1')?.state, 'retired')

    await host.control.require({
        slotId: 'compression-d',
        contractId: 'compression.d.port',
        versionRange: '1.0.0',
        generation: 1,
        authorityId: 'runtime-test',
        authorityEpoch: 1,
        required: false,
    })
    const d = await manifestFor(dependencySource('d'), '1.0.0', {
        moduleId: 'compression-d',
        compatibility: {
            api: {contractId: 'compression.d.port', version: '1.0.0'},
            runtime: {name: 'node', range: '>=18'},
        },
    })
    const candidateD = await host.control.stage({
        candidateId: 'compression-d-v1',
        slotId: 'compression-d',
        priority: 1,
        ...d,
    })
    await host.control.activate(candidateD.candidateId)
    const recoveredD = await compression.call<{d: {ok: true, dependency: string}}>(
        'identify',
        {value: 'third'},
        {correlationId: 'call-v2-with-d'},
    )
    assert.equal(recoveredD.d.dependency, 'D', 'B v2 discovers newly active optional D without replacing A or B')

    const broken = await manifestFor(moduleSource('broken', false), '3.0.0', {
        dependencies: [dependencyC],
    })
    await expectReject(() => host.control.stage({
        candidateId: 'compression-broken',
        slotId: 'compression',
        priority: 3,
        ...broken,
    }), /health check/)
    assert.equal(host.view.binding('compression')?.descriptor.implementationVersion, '2.0.0')
    assert.equal(host.view.candidate('compression-broken')?.state, 'rejected')

    const opensBeforeCorruption = isolationOpens
    const corrupt = await manifestFor(moduleSource('corrupt'), '4.0.0', {
        dependencies: [dependencyC],
    })
    const corruptBytes = new TextEncoder().encode('function differentBytes() {}')
    await expectReject(() => host.control.stage({
        candidateId: 'compression-corrupt',
        slotId: 'compression',
        priority: 4,
        manifest: corrupt.manifest,
        bytes: corruptBytes,
    }), /artifact (size does not match|bytes do not match)/)
    assert.equal(isolationOpens, opensBeforeCorruption, 'integrity failure must happen before worker creation')
    assert.equal(host.view.binding('compression')?.descriptor.implementationVersion, '2.0.0')

    const opensBeforeTrustFailures = isolationOpens
    await expectReject(() => host.control.stage({
        candidateId: 'compression-malformed-manifest',
        slotId: 'compression',
        priority: 4,
        manifest: '{"manifestProtocol":1}',
        bytes: corrupt.bytes,
    }), /manifest/)
    const badSignature = JSON.parse(corrupt.manifest)
    badSignature.signature.value = 'rejected-signature'
    await expectReject(() => host.control.stage({
        candidateId: 'compression-bad-signature',
        slotId: 'compression',
        priority: 4,
        manifest: JSON.stringify(badSignature),
        bytes: corrupt.bytes,
    }), /signature/)
    assert.equal(
        isolationOpens,
        opensBeforeTrustFailures,
        'malformed manifests and rejected signatures cannot reach isolation',
    )

    const browser = await manifestFor(moduleSource('browser'), '5.0.0', {
        compatibility: {
            api: {contractId: 'compression.port', version: '1.0.0'},
            runtime: {name: 'browser', range: '*'},
        },
        dependencies: [dependencyC],
    })
    await expectReject(() => host.control.stage({
        candidateId: 'compression-browser',
        slotId: 'compression',
        priority: 5,
        ...browser,
    }), /runtime is not compatible/)
    const cpuBudget = await manifestFor(moduleSource('cpu-budget'), '6.0.0', {
        dependencies: [dependencyC],
        budget: {
            callTimeoutMs: 1_000,
            warmupTimeoutMs: 1_000,
            memoryMb: 64,
            cpuMs: 500,
            concurrency: 4,
        },
    })
    await expectReject(() => host.control.stage({
        candidateId: 'compression-cpu-budget',
        slotId: 'compression',
        priority: 6,
        ...cpuBudget,
    }), /cpuMs requires process or container isolation/)
    assert.equal(
        isolationOpens,
        opensBeforeTrustFailures,
        'unsupported runtime and CPU promises are rejected before a worker session exists',
    )

    const rolledBack = await host.control.rollback('compression')
    assert.equal(rolledBack.descriptor.implementationVersion, '1.0.0')
    assert.equal(rolledBack.bindingGeneration, 3)
    assert.equal(host.view.binding('compression-c')?.descriptor.implementationVersion, '1.0.0')
    const cAfterRollback = await host.resource.handle('compression-c').call<{dependency: string}>(
        'transform',
        {value: 'after-rollback'},
        {correlationId: 'direct-c-after-rollback'},
    )
    assert.equal(cAfterRollback.dependency, 'C')
    const afterRollback = await compression.call<{version: string, bindingGeneration: number}>(
        'identify',
        {value: 'after-rollback'},
        {correlationId: 'call-rollback'},
    )
    assert.equal(afterRollback.version, 'v1')
    assert.equal(afterRollback.bindingGeneration, 3)
    assert.deepEqual(bindingEvents, [
        {from: null, to: '1.0.0'},
        {from: '1.0.0', to: '2.0.0'},
        {from: '2.0.0', to: '1.0.0'},
    ])
    assert.ok(host.view.audit().some(event => event.action == 'candidate rejected'))
    assert.ok(host.view.audit().some(event => event.action == 'rolled back' && event.bindingGeneration == 3))

    await host.close()
    assert.equal(host.view.snapshot().closed, true)
    console.log('dynamic module runtime: all passed')
}

void main().catch(function fatal(error) {
    console.error(error)
    process.exit(1)
})
