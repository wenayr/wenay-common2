import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {sha256Hex} from '../../src/Common/artifact/artifact-hash'
import {createModuleArtifactVerifier} from '../../src/Common/dynamic/module-verifier'
import {openFsReplayStorage} from '../../src/server/fsReplayStorage'
import {createDynamicModuleHost} from '../../src/server/dynamic/module-host'
import {createModuleWorkerIsolation} from '../../src/server/dynamic/module-worker-isolation'
import {
    createModuleArtifactProvider,
    createModuleArtifactRegistry,
    ModuleArtifactPublication,
    tModuleArtifactRef,
} from './artifact-registry'
import {
    callModuleNode,
    createModuleFleetRollout,
    createModuleRuntimeNode,
    ModuleRolloutProbeInput,
    ModuleRuntimeNode,
} from './rollout-fleet'
import {
    createModuleRolloutJournal,
    ModuleRolloutCommand,
} from './rollout-journal'

const encoder = new TextEncoder()
const SLOT_ID = 'prefix.primary'

function moduleSource(prefix: string) {
    return `function createPrefix() {
        return {
            'health.warmup'() {
                return {ok: true}
            },
            'health.check'() {
                return {ok: true}
            },
            async format(input, call) {
                if (input.delayMs) {
                    await new Promise(function delay(resolve, reject) {
                        const timer = setTimeout(resolve, input.delayMs)
                        call.signal.addEventListener('abort', function abortDelay() {
                            clearTimeout(timer)
                            reject(call.signal.reason)
                        }, {once: true})
                    })
                }
                return {
                    ok: true,
                    value: '${prefix}' + input.value,
                    version: input.expectedVersion,
                    bindingGeneration: call.bindingGeneration,
                    correlationId: call.correlationId,
                }
            },
        }
    }`
}

async function publication(
    version: string,
    prefix: string,
    commit: string,
): Promise<ModuleArtifactPublication> {
    const bytes = encoder.encode(moduleSource(prefix))
    const digest = await sha256Hex(bytes)
    const base = {
        manifestProtocol: 1,
        moduleId: 'prefix.impl',
        version,
        contentHash: 'sha256:' + digest,
        entrypoint: './index.js',
        compatibility: {
            api: {contractId: 'prefix.port', version: '1.0.0'},
            runtime: {name: 'node', range: '>=18'},
        },
        dependencies: [],
        capabilities: ['prefix'],
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
            concurrency: 8,
        },
        signature: {
            algorithm: 'fleet-self-test',
            keyId: 'fleet-publisher',
            value: 'fleet-self-test-signature',
            signedFields: [] as string[],
        },
    }
    const signature = {
        ...base.signature,
        signedFields: Object.keys(base).filter(field => field != 'signature').sort(),
    }
    return {
        manifest: JSON.stringify({...base, signature}),
        bytes,
        source: {
            kind: 'git',
            repository: 'wenay-common2',
            commit,
            path: 'modules/prefix/index.js',
        },
    }
}

function rolloutCommand(
    commandId: string,
    generation: number,
    artifactRef: tModuleArtifactRef,
): ModuleRolloutCommand {
    return {
        commandId,
        rolloutId: 'prefix-rollout-' + generation,
        slotId: SLOT_ID,
        artifactRef,
        authorityId: 'fleet-controller-primary',
        authorityEpoch: 7,
        generation,
    }
}

async function values(nodes: readonly ModuleRuntimeNode[], expectedVersion: string) {
    return Promise.all(nodes.map(function callNode(node) {
        return callModuleNode<{value: string, bindingGeneration: number}>(
            node,
            SLOT_ID,
            'format',
            {value: 'payload', expectedVersion},
            {correlationId: 'read-' + node.nodeId + '-' + expectedVersion},
        )
    }))
}

async function main() {
    const directory = await mkdtemp(join(tmpdir(), 'wenay-dynamic-fleet-'))
    const journalFile = join(directory, 'rollout.jsonl')
    const verifier = createModuleArtifactVerifier({
        verifySignature: input => input.signature == 'fleet-self-test-signature',
        policy: {
            publisherKeyIds: ['fleet-publisher'],
            capabilities: ['prefix'],
        },
    })
    const registry = createModuleArtifactRegistry({verifier})
    const provider = createModuleArtifactProvider({registry})
    const prefixes = new Map<tModuleArtifactRef, string>()
    const hosts = Array.from({length: 3}, function createHost(_, index) {
        const host = createDynamicModuleHost({
            verifier,
            isolation: createModuleWorkerIsolation({
                heartbeatIntervalMs: 20,
                heartbeatTimeoutMs: 300,
            }),
            drainTimeoutMs: 1_000,
        })
        return createModuleRuntimeNode({
            nodeId: 'runtime-' + (index + 1),
            host,
            provider,
        })
    })

    try {
        for (const node of hosts) {
            await node.control.require({
                slotId: SLOT_ID,
                contractId: 'prefix.port',
                versionRange: '1.0.0',
                generation: 1,
                authorityId: 'runtime-bootstrap',
                authorityEpoch: 1,
                required: true,
            })
        }

        const v1 = await registry.control.publish(await publication('1.0.0', '[old] ', 'git-v1'))
        const v2Publication = await publication('2.0.0', '[new] ', 'git-v2')
        const v2 = await registry.control.publish(v2Publication)
        const v3 = await registry.control.publish(await publication('3.0.0', '[bad] ', 'git-v3'))
        prefixes.set(v1.artifactRef, '[old] ')
        prefixes.set(v2.artifactRef, '[new] ')
        prefixes.set(v3.artifactRef, '[bad] ')

        const replayedV2 = await registry.control.publish(v2Publication)
        assert.deepEqual(replayedV2, v2, 'publishing the same immutable Git provenance is idempotent')
        await assert.rejects(
            () => registry.control.publish({
                ...v2Publication,
                source: {...v2Publication.source, commit: 'conflicting-git-revision'},
            }),
            /immutable source provenance conflicts/,
        )

        const journalV1 = createModuleRolloutJournal({
            storage: openFsReplayStorage(journalFile),
        })
        const policy = {
            canaryCount: 1,
            batchSize: 1,
            probeSamples: 1,
            maxFailedProbes: 0,
            async probe(input: ModuleRolloutProbeInput) {
                if (input.command.artifactRef == v3.artifactRef && input.node.nodeId == 'runtime-2') {
                    return {ok: false, error: 'injected post-activation failure'}
                }
                const [result] = await values([input.node], input.command.artifactRef)
                return {
                    ok: result.value == prefixes.get(input.command.artifactRef) + 'payload',
                    error: 'prefix observation did not match the candidate',
                }
            },
        }
        const fleetV1 = createModuleFleetRollout({
            nodes: hosts,
            journal: journalV1,
            policy,
        })
        const commandV1 = rolloutCommand('install-v1', 1, v1.artifactRef)
        const [installedV1, replayedInstallV1] = await Promise.all([
            fleetV1.control.rollout(commandV1),
            fleetV1.control.rollout(commandV1),
        ])
        assert.equal(installedV1.state, 'completed')
        assert.deepEqual(replayedInstallV1, installedV1)
        assert.deepEqual((await values(hosts, '1.0.0')).map(value => value.value), [
            '[old] payload',
            '[old] payload',
            '[old] payload',
        ])

        const inFlightV1 = callModuleNode<{value: string}>(
            hosts[0]!,
            SLOT_ID,
            'format',
            {value: 'in-flight', delayMs: 100, expectedVersion: '1.0.0'},
            {correlationId: 'old-in-flight'},
        )
        void inFlightV1.catch(function keepInFlightHandledDuringAssertions() {})
        const commandV2 = rolloutCommand('install-v2-after-restart', 2, v2.artifactRef)
        journalV1.control.accept(commandV2)
        journalV1.close()

        const journalV2 = createModuleRolloutJournal({
            storage: openFsReplayStorage(journalFile),
        })
        assert.equal(journalV2.view.restored().fromArchive, true)
        assert.equal(journalV2.view.pending()[0]?.commandId, commandV2.commandId)
        const fleetV2 = createModuleFleetRollout({
            nodes: hosts,
            journal: journalV2,
            policy,
        })
        const recovered = await fleetV2.control.reconcile()
        assert.equal(recovered[0]?.state, 'completed')
        assert.equal((await inFlightV1).value, '[old] in-flight')
        assert.deepEqual((await values(hosts, '2.0.0')).map(value => value.value), [
            '[new] payload',
            '[new] payload',
            '[new] payload',
        ])
        const activeBeforeReplay = hosts[0]!.view.active(SLOT_ID)
        const replayedNodeActivation = await hosts[0]!.control.activate(commandV2)
        assert.equal(
            replayedNodeActivation.bindingGeneration,
            activeBeforeReplay?.bindingGeneration,
            'node recovery treats an already active command as idempotent',
        )

        const commandV3 = rolloutCommand('install-v3-fails', 3, v3.artifactRef)
        const failedV3 = await fleetV2.control.rollout(commandV3)
        assert.equal(failedV3.state, 'failed')
        assert.equal(failedV3.result?.rolledBack, true)
        assert.match(failedV3.error ?? '', /injected post-activation failure/)
        assert.deepEqual((await values(hosts, '2.0.0')).map(value => value.value), [
            '[new] payload',
            '[new] payload',
            '[new] payload',
        ])
        assert.equal(
            journalV2.view.snapshot().quarantined[v3.artifactRef]?.artifactRef,
            v3.artifactRef,
        )
        assert.throws(
            () => fleetV2.control.rollout(rolloutCommand('retry-quarantined-v3', 4, v3.artifactRef)),
            /artifact is quarantined/,
        )

        const replayedV2Rollout = await fleetV2.control.rollout(commandV2)
        assert.equal(replayedV2Rollout.state, 'completed')
        assert.throws(
            () => fleetV2.control.rollout({
                ...rolloutCommand('stale-controller-command', 2, v1.artifactRef),
                authorityEpoch: 6,
            }),
            /stale authority epoch/,
        )

        const fakeProvider = createModuleArtifactProvider({
            registry: {
                resource: {
                    describe: registry.resource.describe,
                    async fetch(artifactRef) {
                        const artifact = await registry.resource.fetch(artifactRef)
                        artifact.bytes[0] = artifact.bytes[0]! ^ 0xff
                        return artifact
                    },
                },
            },
        })
        await assert.rejects(
            () => fakeProvider.resource.fetch(v1.artifactRef),
            /integrity check failed/,
        )

        assert.equal(registry.view.stats().fetches, 4, 'one verified network fetch per clean hash plus corruption test')
        assert.equal(provider.view.stats().misses, 9)
        assert.equal(provider.view.stats().hits, 0)
        assert.equal(fleetV2.health.snapshot().journal.persistence, 'healthy')
        console.log(JSON.stringify({
            ok: true,
            topology: 'immutable registry -> shared verified provider -> canary controller -> 3 worker hosts',
            activePrefix: '[new] ',
            registry: registry.view.stats(),
            cache: provider.view.stats(),
            restoredJournal: journalV2.view.restored(),
            failedRollout: {
                state: failedV3.state,
                error: failedV3.error,
                rolledBack: failedV3.result?.rolledBack,
            },
            active: fleetV2.view.active(SLOT_ID),
        }, null, 2))
        journalV2.close()
    } finally {
        await Promise.allSettled(hosts.map(node => node.close()))
        await rm(directory, {recursive: true, force: true})
    }
}

void main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
