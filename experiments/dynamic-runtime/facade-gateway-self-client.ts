import assert from 'node:assert/strict'

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {ToolListChangedNotificationSchema, type CallToolResult} from '@modelcontextprotocol/sdk/types.js'

import {
    createModuleWorkerSession,
    MODULE_WORKER_VERIFIED_SOURCE,
} from '../../src/server/dynamic/module-worker'
import {createMcpFacadeServer, describeMethod} from '../../src/server/mcp-index'
import {createMcpContributionGateway} from './mcp-contribution-gateway'
import {connectContributionGateway} from './mcp-facade-gateway'

// =====================================================================
// Isolated module tools and facade tools share one MCP registry
// =====================================================================
// The module registers tools through context.mcp inside its worker; the gateway publishes
// them; the facade MCP server mounts the catalog next to its own described methods. One
// official SDK client sees both lists as one, with the module's annotations unchanged, and
// gets tools/list_changed when the module adds a tool or its source detaches.

const ANNOTATIONS = {readOnlyHint: true, destructiveHint: false, idempotentHint: true}

const source = String.raw`function createDiagnosticModule(context) {
    const contribution = context.mcp.contribution({id: 'diagnostic', lifetime: 'generation'})
    contribution.tool({
        id: 'inspect',
        title: 'Inspect diagnostic module',
        description: 'Returns a live isolated diagnostic snapshot.',
        annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
    }, function inspectTool(input, call) {
        return {ok: true, input, moduleId: call.moduleId}
    })
    let runtime = null
    return {
        registerRuntimeTool() {
            runtime = runtime ?? contribution.tool({
                id: 'runtime',
                description: 'Added after worker readiness.',
                annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
            }, function runtimeTool(input) { return {runtime: true, input} })
            return true
        },
    }
}`

async function main() {
    const session = createModuleWorkerSession({
        verified: {
            verification: MODULE_WORKER_VERIFIED_SOURCE,
            moduleId: 'diagnostic.module',
            version: '1.0.0',
            contentHash: 'sha256:facade-gateway-v1',
            source,
        },
        candidateId: 'facade-gateway-v1',
        bindingGeneration: 1,
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
                contributionId: 'diagnostic',
                lifetime: 'generation',
                tools: [
                    {toolId: 'inspect', title: 'Inspect diagnostic module', description: 'Returns a live isolated diagnostic snapshot.', annotations: ANNOTATIONS},
                    {toolId: 'runtime', description: 'Added after worker readiness.', annotations: ANNOTATIONS},
                ],
            }],
        },
    })
    await session.control.start()
    const gateway = createMcpContributionGateway({maxTools: 8})
    gateway.control.attach({
        sourceId: 'diagnostic.module@g1',
        moduleId: 'diagnostic.module',
        version: '1.0.0',
        contentHash: 'sha256:facade-gateway-v1',
        bindingGeneration: 1,
        mcp: session.mcp,
    })

    const mcp = createMcpFacadeServer({
        name: 'dynamic-host',
        version: '1.0.0',
        strict: true,
        object: {
            view: {status: describeMethod(() => ({ok: true}), {description: 'Host status', args: [], annotations: {readOnlyHint: true}})},
        },
        // isolated modules bound their own concurrency; the host's facade stays ordered
        policy: {concurrency: path => path[0] == 'module' ? 'parallel' : 'serial'},
    })
    const offGateway = connectContributionGateway(mcp, gateway)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await mcp.control.server().connect(serverTransport)
    const client = new Client({name: 'facade-gateway-self-client', version: '1.0.0'})
    let listChanged = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged++ })
    await client.connect(clientTransport)

    try {
        const initial = (await client.listTools()).tools
        assert.deepEqual(initial.map(tool => tool.name), ['view.status', 'module.diagnostic.inspect'])
        const inspect = initial[1]
        assert.deepEqual(inspect.annotations, ANNOTATIONS, 'the module annotations pass through as one type')
        assert.equal(inspect.title, 'Inspect diagnostic module')

        const inspected = await client.callTool({
            name: 'module.diagnostic.inspect',
            arguments: {input: {value: 9}, correlationId: 'facade-inspect'},
        }) as CallToolResult
        const value = inspected.structuredContent as {ok: boolean, input: {value: number}, moduleId: string}
        assert.equal(value.ok, true)
        assert.equal(value.input.value, 9)
        assert.equal(value.moduleId, 'diagnostic.module')

        await session.resource.call('registerRuntimeTool', null, {correlationId: 'runtime-register'})
        await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(listChanged, 1, 'a module registration is one tools/list_changed')
        const afterRegister = (await client.listTools()).tools.map(tool => tool.name)
        assert.deepEqual(afterRegister, ['view.status', 'module.diagnostic.inspect', 'module.diagnostic.runtime'])

        assert.equal(gateway.control.detach('diagnostic.module@g1'), true)
        await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(listChanged, 2, 'a source detach is one tools/list_changed')
        assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['view.status'])
        console.log(JSON.stringify({initial: initial.length, afterRegister: afterRegister.length, listChanged}))
    } finally {
        offGateway()
        await client.close()
        mcp.control.dispose()
        gateway.control.close()
        await session.control.terminate('facade gateway self-client complete')
    }
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(1)
})
