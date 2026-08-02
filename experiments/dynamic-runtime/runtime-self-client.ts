import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'

import {sha256Hex} from '../../src/Common/artifact/artifact-hash'
import {createModuleArtifactVerifier} from '../../src/Common/dynamic/module-verifier'
import {createDynamicModuleHost} from '../../src/server/dynamic/module-host'
import {createModuleWorkerIsolation} from '../../src/server/dynamic/module-worker-isolation'
import {createDynamicHostModuleControl, DynamicHostArtifact} from './dynamic-host-control'
import {
    createModuleControlMcp,
    createModuleControlMcpClient,
    DYNAMIC_RUNTIME_GUIDE_URI,
} from './mcp-adapter'

const TOKEN = 'dynamic-runtime-real-host-self-client'

function toolJson(value: unknown) {
    assert(value != null && typeof value == 'object' && 'content' in value)
    const content = (value as {content: unknown}).content
    assert(Array.isArray(content))
    const text = content.find(item =>
        item != null && typeof item == 'object' && 'type' in item && item.type == 'text')
    assert(text != null && typeof text == 'object' && 'text' in text && typeof text.text == 'string')
    return JSON.parse(text.text) as any
}

function sourceFor(version: string) {
    return `function createCompression() {
        return {
            'health.warmup'() {
                return {ok: true}
            },
            'health.check'() {
                return {ok: true}
            },
            identify(input, call) {
                return {
                    ok: true,
                    version: '${version}',
                    input,
                    bindingGeneration: call.bindingGeneration,
                    correlationId: call.correlationId,
                }
            },
        }
    }`
}

async function artifactFor(version: string, priority: number): Promise<DynamicHostArtifact> {
    const source = sourceFor(version)
    const bytes = new TextEncoder().encode(source)
    const digest = await sha256Hex(bytes)
    const base = {
        manifestProtocol: 1,
        moduleId: 'compression.impl',
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
            algorithm: 'self-test',
            keyId: 'self-test-publisher',
            value: 'self-test-valid-signature',
            signedFields: [] as string[],
        },
    }
    const signature = {
        ...base.signature,
        signedFields: Object.keys(base).filter(field => field != 'signature').sort(),
    }
    return {
        moduleId: 'compression.impl',
        version,
        contentHash: `sha256:${digest}`,
        slotId: 'compression.primary',
        priority,
        manifest: JSON.stringify({...base, signature}),
        bytes,
    }
}

async function main() {
    const guide = await readFile(resolve(process.cwd(), 'doc', 'DYNAMIC-RUNTIME.md'), 'utf8')
    const implementationPrompt = await readFile(
        resolve(process.cwd(), 'doc', 'prompts', 'IMPLEMENT-DYNAMIC-RUNTIME.md'),
        'utf8',
    )
    const verifier = createModuleArtifactVerifier({
        verifySignature: input => input.signature == 'self-test-valid-signature',
        policy: {
            publisherKeyIds: ['self-test-publisher'],
            capabilities: ['compression'],
        },
    })
    const isolation = createModuleWorkerIsolation({
        heartbeatIntervalMs: 20,
        heartbeatTimeoutMs: 300,
    })
    const host = createDynamicModuleHost({verifier, isolation, drainTimeoutMs: 1_000})
    await host.control.require({
        slotId: 'compression.primary',
        contractId: 'compression.port',
        versionRange: '1.0.0',
        generation: 1,
        authorityId: 'mcp-self-test',
        authorityEpoch: 1,
        required: true,
    })

    const v1 = await artifactFor('1.0.0', 1)
    const v2 = await artifactFor('2.0.0', 2)
    const artifacts = new Map<string, DynamicHostArtifact>([
        ['sha256:compression-v1', v1],
        ['sha256:compression-v2', v2],
    ])
    const candidateV1 = await host.control.stage({
        candidateId: 'compression-primary-v1',
        slotId: v1.slotId,
        priority: v1.priority,
        manifest: v1.manifest,
        bytes: v1.bytes,
    })
    await host.control.activate(candidateV1.candidateId)

    const moduleControl = createDynamicHostModuleControl({
        host,
        artifacts,
        guide,
        implementationPrompt,
    })
    const mcp = createModuleControlMcp({
        moduleControl,
        bearerToken: TOKEN,
    })
    const endpoint = await mcp.control.start()
    const client = createModuleControlMcpClient({
        endpoint,
        bearerToken: TOKEN,
    })

    try {
        await client.control.connect()
        const listed = await client.view.listTools()
        assert.equal(listed.tools.length, 5)
        const resource = await client.resource.read({uri: DYNAMIC_RUNTIME_GUIDE_URI})
        assert.match(resource.contents[0] && 'text' in resource.contents[0] ? resource.contents[0].text : '',
            /^# Dynamic runtime architecture/m)

        const stageRequest = {
            name: 'module.stage',
            arguments: {
                slotId: 'compression.primary',
                moduleId: 'compression.impl',
                version: '2.0.0',
                artifactRef: 'sha256:compression-v2',
                commandId: 'real-stage-v2',
                correlationId: 'real-mcp-run',
            },
        }
        const [stagedResult, replayedStageResult] = await Promise.all([
            client.control.callTool(stageRequest),
            client.control.callTool(stageRequest),
        ])
        const staged = toolJson(stagedResult)
        const replayedStage = toolJson(replayedStageResult)
        assert.deepEqual(replayedStage, staged, 'command receipt makes an MCP retry idempotent')
        assert.equal(staged.candidate.state, 'ready')
        const conflictingCommand = await client.control.callTool({
            name: 'module.stage',
            arguments: {
                slotId: 'compression.primary',
                moduleId: 'compression.impl',
                version: '1.0.0',
                artifactRef: 'sha256:compression-v1',
                commandId: 'real-stage-v2',
                correlationId: 'conflicting-retry',
            },
        })
        assert.equal(conflictingCommand.isError, true, 'one commandId cannot be reused for a different intent')

        const activated = toolJson(await client.control.callTool({
            name: 'module.activate',
            arguments: {
                slotId: 'compression.primary',
                moduleId: 'compression.impl',
                candidateId: staged.candidate.candidateId,
                commandId: 'real-activate-v2',
                correlationId: 'real-mcp-run',
            },
        }))
        assert.equal(activated.active.descriptor.implementationVersion, '2.0.0')
        assert.equal(activated.active.bindingGeneration, 2)

        const compression = host.resource.handle('compression.primary')
        const afterActivation = await compression.call<{
            version: string
            bindingGeneration: number
        }>('identify', 'through-real-host', {correlationId: 'after-mcp-activation'})
        assert.equal(afterActivation.version, '2.0.0')
        assert.equal(afterActivation.bindingGeneration, 2)

        const explained = toolJson(await client.control.callTool({
            name: 'module.explain',
            arguments: {slotId: 'compression.primary', moduleId: 'compression.impl'},
        }))
        assert.equal(explained.binding.descriptor.implementationVersion, '2.0.0')
        const health = toolJson(await client.control.callTool({
            name: 'module.health',
            arguments: {slotId: 'compression.primary', moduleId: 'compression.impl'},
        }))
        assert.equal(health[staged.candidate.candidateId].health, 'healthy')

        const rolledBack = toolJson(await client.control.callTool({
            name: 'module.rollback',
            arguments: {
                slotId: 'compression.primary',
                moduleId: 'compression.impl',
                targetVersion: '1.0.0',
                commandId: 'real-rollback-v1',
                correlationId: 'real-mcp-run',
            },
        }))
        assert.equal(rolledBack.active.descriptor.implementationVersion, '1.0.0')
        assert.equal(rolledBack.active.bindingGeneration, 3)
        const afterRollback = await compression.call<{version: string, bindingGeneration: number}>(
            'identify',
            'after-real-rollback',
            {correlationId: 'after-mcp-rollback'},
        )
        assert.equal(afterRollback.version, '1.0.0')
        assert.equal(afterRollback.bindingGeneration, 3)

        console.log(JSON.stringify({
            ok: true,
            endpoint: endpoint.href,
            adapter: 'official MCP client -> real DynamicModuleHost -> ContractRuntime -> worker_threads',
            activeAfterRollback: host.view.binding('compression.primary'),
        }, null, 2))
    } finally {
        await client.control.close()
        await mcp.control.close()
        await host.close()
    }
}

void main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
