import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'

import {
    createModuleWorkerSession,
    MODULE_WORKER_VERIFIED_SOURCE,
} from '../../src/server/dynamic/module-worker'
import {createInMemoryModuleControl} from './module-control'
import {createMcpContributionGateway} from './mcp-contribution-gateway'
import {createModuleControlMcp, createModuleControlMcpClient} from './mcp-adapter'

const TOKEN = 'dynamic-contribution-self-client'

function toolJson(value: unknown) {
    assert(value != null && typeof value == 'object' && 'content' in value)
    const content = (value as {content: unknown}).content
    assert(Array.isArray(content))
    const text = content.find(item =>
        item != null && typeof item == 'object' && 'type' in item && item.type == 'text')
    assert(text != null && typeof text == 'object' && 'text' in text && typeof text.text == 'string')
    return JSON.parse(text.text) as any
}

const source = String.raw`function createDiagnosticModule(context) {
    const contribution = context.mcp.contribution({id: 'diagnostic.runtime', lifetime: 'generation'})
    const inspect = contribution.tool({
        id: 'inspect',
        title: 'Inspect diagnostic module',
        description: 'Returns a live isolated diagnostic snapshot.',
        annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
    }, function inspectTool(input, call) {
        return {
            ok: true,
            input,
            moduleId: call.moduleId,
            version: call.version,
            contributionId: call.mcp.contributionId,
        }
    })

    let runtime = null
    return {
        registerRuntimeTool() {
            if (!runtime) {
                runtime = contribution.tool({
                    id: 'runtime',
                    title: 'Runtime-added diagnostic',
                    description: 'Proves live context.mcp registration after worker readiness.',
                    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
                }, function runtimeTool(input) { return {ok: true, runtime: true, input} })
            }
            return runtime.view.snapshot()
        },
        removeInspect() {
            return inspect.control.remove()
        },
        registrationStats() {
            return context.mcp.view.snapshot()
        },
    }
}`

function createDiagnosticSession() {
    return createModuleWorkerSession({
        verified: {
            verification: MODULE_WORKER_VERIFIED_SOURCE,
            moduleId: 'diagnostic.module',
            version: '1.0.0',
            contentHash: 'sha256:diagnostic-v1',
            source,
        },
        candidateId: 'diagnostic-v1',
        bindingGeneration: 3,
        startupTimeoutMs: 500,
        heartbeatIntervalMs: 20,
        heartbeatTimeoutMs: 300,
        defaultCallTimeoutMs: 500,
        maxCallTimeoutMs: 1_000,
        maxConcurrentCalls: 4,
        maxInputBytes: 4096,
        maxOutputBytes: 4096,
        memoryMb: 64,
        mcpPolicy: {
            contributions: [{
                contributionId: 'diagnostic.runtime',
                lifetime: 'generation',
                tools: [{
                    toolId: 'inspect',
                    title: 'Inspect diagnostic module',
                    description: 'Returns a live isolated diagnostic snapshot.',
                    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
                }, {
                    toolId: 'runtime',
                    title: 'Runtime-added diagnostic',
                    description: 'Proves live context.mcp registration after worker readiness.',
                    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
                }],
            }],
        },
    })
}

async function main() {
    const guide = await readFile(resolve(process.cwd(), 'doc', 'DYNAMIC-RUNTIME.md'), 'utf8')
    const implementationPrompt = await readFile(
        resolve(process.cwd(), 'doc', 'prompts', 'IMPLEMENT-MCP-CONTRIBUTION-GATEWAY.md'),
        'utf8',
    )
    const moduleControl = createInMemoryModuleControl({
        guide,
        implementationPrompt,
        initial: {
            slotId: 'diagnostic.primary',
            moduleId: 'diagnostic.module',
            version: '1.0.0',
            artifactRef: 'sha256:diagnostic-v1',
        },
    })
    const session = createDiagnosticSession()
    await session.control.start()

    const gateway = createMcpContributionGateway({maxTools: 8})
    gateway.control.attach({
        sourceId: 'diagnostic.module@g3',
        moduleId: 'diagnostic.module',
        version: '1.0.0',
        contentHash: 'sha256:diagnostic-v1',
        bindingGeneration: 3,
        mcp: session.mcp,
    })

    const mcp = createModuleControlMcp({
        moduleControl,
        bearerToken: TOKEN,
        contributionGateway: gateway,
    })
    const endpoint = await mcp.control.start()
    const client = createModuleControlMcpClient({endpoint, bearerToken: TOKEN})

    try {
        await client.control.connect()
        const initial = await client.view.listTools()
        assert.equal(initial.tools.length, 6)
        assert(initial.tools.some(tool => tool.name == 'diagnostic.runtime.inspect'))

        const inspected = toolJson(await client.control.callTool({
            name: 'diagnostic.runtime.inspect',
            arguments: {
                input: {value: 9},
                correlationId: 'official-inspect',
            },
        }))
        assert.equal(inspected.ok, true)
        assert.equal(inspected.input.value, 9)
        assert.equal(inspected.moduleId, 'diagnostic.module')

        await session.resource.call('registerRuntimeTool', null, {correlationId: 'runtime-register'})
        const afterRegister = await client.view.listTools()
        assert.equal(afterRegister.tools.length, 7)
        assert(afterRegister.tools.some(tool => tool.name == 'diagnostic.runtime.runtime'))
        const runtime = toolJson(await client.control.callTool({
            name: 'diagnostic.runtime.runtime',
            arguments: {input: {live: true}, correlationId: 'official-runtime'},
        }))
        assert.equal(runtime.runtime, true)
        assert.equal(runtime.input.live, true)

        await session.resource.call('removeInspect', null, {correlationId: 'runtime-remove'})
        const afterRemove = await client.view.listTools()
        assert.equal(afterRemove.tools.length, 6)
        assert(!afterRemove.tools.some(tool => tool.name == 'diagnostic.runtime.inspect'))

        const stats = await session.resource.call<any>('registrationStats', null, {
            correlationId: 'runtime-stats',
        })
        assert.equal(stats.attached, 1)
        assert.equal(stats.removed, 1)

        assert.equal(gateway.control.detach('diagnostic.module@g3'), true)
        const afterDetach = await client.view.listTools()
        assert.equal(afterDetach.tools.length, 5)

        console.log(JSON.stringify({
            initialTools: initial.tools.length,
            afterRuntimeRegistration: afterRegister.tools.length,
            afterRuntimeRemoval: afterRemove.tools.length,
            afterSourceDetach: afterDetach.tools.length,
            registrationStats: stats,
            gateway: gateway.view.snapshot(),
        }, null, 2))
    } finally {
        await client.control.close()
        await mcp.control.close()
        gateway.control.close()
        await session.control.terminate('contribution self-client complete')
    }
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(1)
})
