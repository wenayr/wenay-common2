// =====================================================================
// Dynamic module tools self-client — the registrar answer, over plain HTTP
// =====================================================================
// Three layers, exactly as doc/DYNAMIC-RUNTIME.md prescribes:
//   1. inside the module  — a scoped `context.mcp` registrar (not a global)
//   2. in the host        — one gateway that owns the layered catalog
//   3. outside            — an adapter; here createHttpFacadeServer, so the
//                           agent needs nothing but fetch + JSON
// A module that arrives at runtime brings its own agent tools with it, and
// takes them away when it leaves.

import assert from 'node:assert/strict'
import express from 'express'

import {sha256Hex} from '../../src/Common/artifact/artifact-hash'
import {createModuleArtifactVerifier} from '../../src/Common/dynamic/module-verifier'
import {createDynamicModuleHost} from '../../src/server/dynamic/module-host'
import {
    ModuleIsolationOpenInput,
    ModuleIsolationPort,
    ModuleIsolationSession,
} from '../../src/server/dynamic/module-isolation'
import {createModuleWorkerIsolation} from '../../src/server/dynamic/module-worker-isolation'
import {createHttpFacadeServer} from '../../src/server/httpFacadeServer'
import {createMcpContributionGateway} from './mcp-contribution-gateway'

const TOKEN = 'dynamic-tools-self-client-token'
const SLOT_ID = 'reporting.primary'
const MODULE_ID = 'reporting.impl'
const CONTRACT_ID = 'reporting.port'
const CONTRIBUTION_ID = 'reporting.tools'

// =====================================================================
// Two module versions. Both register their own tools through context.mcp.
// =====================================================================

const sourceV1 = String.raw`function createReporting(context) {
    const tools = context.mcp.contribution({id: 'reporting.tools', lifetime: 'generation'})
    tools.tool({
        id: 'summary',
        title: 'Reporting summary',
        description: 'One bounded summary of the active reporting module.',
        annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
    }, function summaryTool(input, call) {
        return {ok: true, tool: 'summary', version: call.version, moduleId: call.moduleId, input}
    })

    return {
        'health.warmup'() { return {ok: true} },
        'health.check'() { return {ok: true} },
        report(input) { return {ok: true, version: '1.0.0', input} },
    }
}`

const sourceV2 = String.raw`function createReporting(context) {
    const tools = context.mcp.contribution({id: 'reporting.tools', lifetime: 'generation'})
    tools.tool({
        id: 'summary',
        title: 'Reporting summary',
        description: 'One bounded summary of the active reporting module.',
        annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
    }, function summaryTool(input, call) {
        return {ok: true, tool: 'summary', version: call.version, moduleId: call.moduleId, input}
    })
    tools.tool({
        id: 'details',
        title: 'Reporting details',
        description: 'Detail rows that only version 2 can produce.',
        annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
    }, function detailsTool(input, call) {
        return {ok: true, tool: 'details', version: call.version, rows: [1, 2, 3], input}
    })

    let live = null
    return {
        'health.warmup'() { return {ok: true} },
        'health.check'() { return {ok: true} },
        report(input) { return {ok: true, version: '2.0.0', input} },
        addLiveTool() {
            if (!live) {
                live = tools.tool({
                    id: 'live',
                    title: 'Live diagnostic',
                    description: 'Registered after the module was already running.',
                    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
                }, function liveTool(input) { return {ok: true, tool: 'live', input} })
            }
            return live.view.snapshot()
        },
        dropLiveTool() {
            if (!live) return false
            const removed = live.control.remove()
            live = null
            return removed
        },
    }
}`

// The signed manifest extension for contribution declarations is deferred
// (see doc/DYNAMIC-RUNTIME.md). Until it exists, the host declares the exact
// tools each artifact may register. The comparison is exact — title and
// description included — so a module cannot quietly present itself to an agent
// as something the host never approved.
const READ_ONLY = {readOnlyHint: true, destructiveHint: false, idempotentHint: true} as const
const DECLARED_TOOLS = {
    summary: {
        toolId: 'summary',
        title: 'Reporting summary',
        description: 'One bounded summary of the active reporting module.',
        annotations: READ_ONLY,
    },
    details: {
        toolId: 'details',
        title: 'Reporting details',
        description: 'Detail rows that only version 2 can produce.',
        annotations: READ_ONLY,
    },
    live: {
        toolId: 'live',
        title: 'Live diagnostic',
        description: 'Registered after the module was already running.',
        annotations: READ_ONLY,
    },
} as const

const TOOL_DECLARATIONS = {
    '1.0.0': ['summary'],
    '2.0.0': ['summary', 'details', 'live'],
} as const

function mcpPolicyFor(version: string) {
    const allowed = TOOL_DECLARATIONS[version as keyof typeof TOOL_DECLARATIONS] ?? []
    return {
        contributions: [{
            contributionId: CONTRIBUTION_ID,
            lifetime: 'generation' as const,
            tools: allowed.map(toolId => DECLARED_TOOLS[toolId]),
        }],
    }
}

async function artifactFor(version: string, source: string, priority: number) {
    const bytes = new TextEncoder().encode(source)
    const digest = await sha256Hex(bytes)
    const base = {
        manifestProtocol: 1,
        moduleId: MODULE_ID,
        version,
        contentHash: 'sha256:' + digest,
        entrypoint: './index.js',
        compatibility: {
            api: {contractId: CONTRACT_ID, version: '1.0.0'},
            runtime: {name: 'node', range: '>=18'},
        },
        dependencies: [],
        capabilities: ['reporting'],
        permissions: {},
        integrity: {algorithm: 'sha256', digest, size: bytes.byteLength},
        health: {
            warmupHook: 'health.warmup',
            checkHook: 'health.check',
            timeoutMs: 500,
            failureThreshold: 2,
        },
        budget: {callTimeoutMs: 1_000, warmupTimeoutMs: 1_000, memoryMb: 64, concurrency: 4},
        signature: {
            algorithm: 'dev-key',
            keyId: 'dev-publisher',
            value: 'dev-valid-signature',
            signedFields: [] as string[],
        },
    }
    const signature = {
        ...base.signature,
        signedFields: Object.keys(base).filter(field => field != 'signature').sort(),
    }
    return {
        version,
        priority,
        contentHash: 'sha256:' + digest,
        manifest: JSON.stringify({...base, signature}),
        bytes,
    }
}

// =====================================================================
// Isolation decorator — the session owner feeds the gateway
// =====================================================================
// The gateway must never reach inside the host to find a session. The layer
// that OPENS sessions is the layer that knows about them, so it publishes
// them; the host stays untouched.

function createObservedIsolation(): ModuleIsolationPort & {
    view: {session: (contentHash: string) => ModuleIsolationSession | null}
} {
    const base = createModuleWorkerIsolation({
        heartbeatIntervalMs: 20,
        heartbeatTimeoutMs: 300,
        resolveMcpPolicy: artifact => mcpPolicyFor(artifact.manifest.version),
    })
    const opened = new Map<string, ModuleIsolationSession>()

    return {
        resource: {
            open: async function openObserved(input: ModuleIsolationOpenInput) {
                const session = await base.resource.open(input)
                // Latest session for this content wins: a rollback opens a
                // fresh worker for the same bytes.
                opened.set(input.artifact.manifest.contentHash, session)
                return session
            },
        },
        view: {
            session: (contentHash: string) => opened.get(contentHash) ?? null,
        },
    }
}

// =====================================================================
// Host: dynamic module host + gateway + HTTP adapter
// =====================================================================

async function startHost() {
    const verifier = createModuleArtifactVerifier({
        verifySignature: input => input.signature == 'dev-valid-signature',
        policy: {publisherKeyIds: ['dev-publisher'], capabilities: ['reporting']},
    })
    const isolation = createObservedIsolation()
    const host = createDynamicModuleHost({verifier, isolation, drainTimeoutMs: 1_000})
    const gateway = createMcpContributionGateway({maxTools: 16})
    await host.control.require({
        slotId: SLOT_ID,
        contractId: CONTRACT_ID,
        versionRange: '1.0.0',
        generation: 1,
        authorityId: 'dynamic-tools-self-client',
        authorityEpoch: 1,
        required: true,
    })

    const artifacts = new Map<string, Awaited<ReturnType<typeof artifactFor>>>([
        ['1.0.0', await artifactFor('1.0.0', sourceV1, 1)],
        ['2.0.0', await artifactFor('2.0.0', sourceV2, 2)],
    ])
    const stagedCandidates = new Map<string, string>()
    const handle = host.resource.handle(SLOT_ID)
    let currentSourceId: string | null = null
    let sourceCounter = 0

    // === Activation drives the catalog ===
    // One place decides which generation owns the tool names. New calls see the
    // new backing version only after the binding itself is ready.
    function syncCatalog(binding: NonNullable<ReturnType<typeof handle.view.binding>>) {
        const contentHash = binding.descriptor.integrity
        if (contentHash == undefined) throw new Error('active module binding has no content hash')
        const session = isolation.view.session(contentHash)
        if (!session) throw new Error('no isolated session for ' + contentHash)
        const source = {
            sourceId: contentHash + '#' + (++sourceCounter),
            moduleId: binding.descriptor.implementationId,
            version: binding.descriptor.implementationVersion,
            contentHash,
            bindingGeneration: binding.bindingGeneration,
            mcp: session.mcp,
        }
        if (currentSourceId == null) gateway.control.attach(source)
        else gateway.control.replace(currentSourceId, source)
        currentSourceId = source.sourceId
        return gateway.view.catalog()
    }

    async function stage(version: string) {
        const artifact = artifacts.get(version)
        if (!artifact) throw new Error('unknown dev version: ' + version)
        const candidate = await host.control.stage({
            slotId: SLOT_ID,
            priority: artifact.priority,
            manifest: artifact.manifest,
            bytes: artifact.bytes,
        })
        stagedCandidates.set(version, candidate.candidateId)
        return {version, candidateId: candidate.candidateId, state: candidate.state}
    }

    async function activate(version: string) {
        const candidateId = stagedCandidates.get(version)
        if (!candidateId) throw new Error('version is not staged: ' + version)
        const binding = await host.control.activate(candidateId)
        const catalog = syncCatalog(binding)
        return {
            version: binding.descriptor.implementationVersion,
            bindingGeneration: binding.bindingGeneration,
            tools: catalog.tools.map(tool => tool.name),
        }
    }

    async function rollback() {
        const binding = await host.control.rollback(SLOT_ID)
        const catalog = syncCatalog(binding)
        return {
            version: binding.descriptor.implementationVersion,
            bindingGeneration: binding.bindingGeneration,
            tools: catalog.tools.map(tool => tool.name),
        }
    }

    const agentSurface = {
        control: {stage, activate, rollback},
        module: {
            call: function callModule(method: string, input: unknown = null) {
                return handle.call(method, input)
            },
        },
        tools: {
            invoke: function invokeTool(name: string, input: unknown = null) {
                return gateway.resource.invoke(name, input, {correlationId: 'agent:' + name})
            },
        },
        view: {
            catalog: function catalog() {
                const current = gateway.view.catalog()
                return {
                    catalogGeneration: current.catalogGeneration,
                    tools: current.tools.map(tool => ({
                        name: tool.name,
                        title: tool.descriptor.title,
                        description: tool.descriptor.description,
                        lifetime: tool.descriptor.lifetime,
                    })),
                }
            },
            snapshot: function snapshot() {
                const binding = handle.view.binding()
                return {
                    active: binding == null ? null : {
                        version: binding.descriptor.implementationVersion,
                        bindingGeneration: binding.bindingGeneration,
                    },
                    gateway: gateway.view.snapshot(),
                }
            },
        },
        health: {
            snapshot: () => ({module: host.health.snapshot(), gateway: gateway.health.snapshot()}),
        },
    }

    function authorizeAgent(req: express.Request, res: express.Response, next: express.NextFunction) {
        if (req.headers.authorization == 'Bearer ' + TOKEN) {
            next()
            return
        }
        res.status(401).json({ok: false, error: {message: 'Unauthorized'}})
    }

    const limits = {maxDepth: 8, maxKeys: 200, maxArgs: 4, maxArrayLen: 100, maxStringLen: 100_000}
    const app = express()
    createHttpFacadeServer({
        app,
        object: {view: agentSurface.view, health: agentSurface.health},
        method: 'get',
        basePath: '/agent',
        middleware: authorizeAgent,
        limits,
    })
    createHttpFacadeServer({
        app,
        object: {control: agentSurface.control, module: agentSurface.module, tools: agentSurface.tools},
        method: 'post',
        basePath: '/agent',
        middleware: [authorizeAgent, express.json({limit: '64kb'})],
        limits,
    })

    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(function waitListening(resolveListening, rejectListening) {
        server.once('listening', resolveListening)
        server.once('error', rejectListening)
    })
    const address = server.address()
    if (address == null || typeof address == 'string') throw new Error('missing HTTP server address')

    async function close() {
        await new Promise<void>(function closeServer(resolveClose) {
            server.close(function closed() { resolveClose() })
        })
        gateway.control.close()
        await host.close()
    }

    return {port: address.port, close}
}

// =====================================================================
// Agent side: fetch and JSON only
// =====================================================================

function createAgentHttpClient(port: number) {
    const base = 'http://127.0.0.1:' + port

    async function settle(response: Response) {
        const body = await response.json() as {ok: boolean, value?: unknown, error?: {message?: string}}
        if (!body.ok) throw new Error('agent call failed (' + response.status + '): ' + body.error?.message)
        return body.value
    }

    return {
        base,
        get: async function get(path: string) {
            return settle(await fetch(base + path, {headers: {authorization: 'Bearer ' + TOKEN}}))
        },
        post: async function post(path: string, args: unknown[]) {
            return settle(await fetch(base + path, {
                method: 'POST',
                headers: {authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json'},
                body: JSON.stringify(args),
            }))
        },
    }
}

function toolNames(catalog: any) {
    return catalog.tools.map((tool: any) => tool.name).sort()
}

// =====================================================================
// The scripted agent session
// =====================================================================

async function main() {
    const hosted = await startHost()
    const agent = createAgentHttpClient(hosted.port)

    try {
        // 1. Nothing is active yet, so the agent sees an empty catalog.
        assert.deepEqual(toolNames(await agent.get('/agent/view/catalog')), [])

        // 2. Activating v1 publishes the tools that v1 registered for itself.
        await agent.post('/agent/control/stage', ['1.0.0'])
        const activatedV1 = await agent.post('/agent/control/activate', ['1.0.0']) as any
        assert.deepEqual(activatedV1.tools, ['reporting.tools.summary'])
        assert.deepEqual(toolNames(await agent.get('/agent/view/catalog')), ['reporting.tools.summary'])

        // 3. The tool runs inside the isolated worker, not in the host.
        const summaryV1 = await agent.post('/agent/tools/invoke',
            ['reporting.tools.summary', {scope: 'day'}]) as any
        assert.equal(summaryV1.tool, 'summary')
        assert.equal(summaryV1.version, '1.0.0')
        assert.equal(summaryV1.input.scope, 'day')

        // 4. A STAGED candidate keeps its tools private: staging v2 registers
        //    'details' inside the candidate worker, but the catalog is unchanged.
        await agent.post('/agent/control/stage', ['2.0.0'])
        assert.deepEqual(toolNames(await agent.get('/agent/view/catalog')), ['reporting.tools.summary'])
        await assert.rejects(
            agent.post('/agent/tools/invoke', ['reporting.tools.details', null]),
            /unavailable/i,
            'a staged candidate must not publish tools',
        )

        // 5. Activation swaps the whole catalog to the new generation at once.
        const activatedV2 = await agent.post('/agent/control/activate', ['2.0.0']) as any
        assert.equal(activatedV2.version, '2.0.0')
        assert.deepEqual(toolNames({tools: activatedV2.tools.map((name: string) => ({name}))}),
            ['reporting.tools.details', 'reporting.tools.summary'])
        const summaryV2 = await agent.post('/agent/tools/invoke',
            ['reporting.tools.summary', {scope: 'day'}]) as any
        assert.equal(summaryV2.version, '2.0.0', 'the same tool name now resolves to the new version')
        const details = await agent.post('/agent/tools/invoke', ['reporting.tools.details', null]) as any
        assert.deepEqual(details.rows, [1, 2, 3])

        // 6. A running module can add a tool without any activation.
        await agent.post('/agent/module/call', ['addLiveTool'])
        assert.deepEqual(toolNames(await agent.get('/agent/view/catalog')),
            ['reporting.tools.details', 'reporting.tools.live', 'reporting.tools.summary'])
        const live = await agent.post('/agent/tools/invoke', ['reporting.tools.live', {probe: 1}]) as any
        assert.equal(live.tool, 'live')

        // 7. And take it away again.
        await agent.post('/agent/module/call', ['dropLiveTool'])
        assert.deepEqual(toolNames(await agent.get('/agent/view/catalog')),
            ['reporting.tools.details', 'reporting.tools.summary'])

        // 8. Rollback returns the old catalog with the old binding. The tool that
        //    only v2 had is gone, and calling it fails typed instead of reaching
        //    a stale handler.
        const rolledBack = await agent.post('/agent/control/rollback', []) as any
        assert.equal(rolledBack.version, '1.0.0')
        assert.deepEqual(rolledBack.tools, ['reporting.tools.summary'])
        await assert.rejects(
            agent.post('/agent/tools/invoke', ['reporting.tools.details', null]),
            /unavailable/i,
            'a retired generation must not keep serving its tools',
        )
        const summaryAfterRollback = await agent.post('/agent/tools/invoke',
            ['reporting.tools.summary', {scope: 'day'}]) as any
        assert.equal(summaryAfterRollback.version, '1.0.0')

        const snapshot = await agent.get('/agent/view/snapshot') as any
        assert.equal(snapshot.active.version, '1.0.0')
        assert.equal(snapshot.gateway.toolCount, 1)

        console.log(JSON.stringify({
            ok: true,
            endpoint: agent.base + '/agent',
            layers: 'context.mcp registrar -> host gateway -> HTTP facade',
            finalCatalog: await agent.get('/agent/view/catalog'),
        }, null, 2))
    } finally {
        await hosted.close()
    }
}

void main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
