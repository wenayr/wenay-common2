import {
    createModuleWorkerSession,
    MODULE_WORKER_VERIFIED_SOURCE,
    ModuleWorkerError,
    VerifiedModuleSource,
} from '../src/server/dynamic/module-worker'
import {
    createMcpContributionGateway,
    McpContributionGatewayError,
} from '../experiments/dynamic-runtime/mcp-contribution-gateway'

let fails = 0
function ok(condition: unknown, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

function fixture(source: string, version: string): VerifiedModuleSource {
    return {
        verification: MODULE_WORKER_VERIFIED_SOURCE,
        moduleId: 'fixture.module',
        version,
        contentHash: `sha256:${version}`,
        source,
    }
}

const moduleSource = String.raw`function createFixture(context) {
    const events = []
    const diagnostics = context.mcp.contribution({id: 'fixture.debug', lifetime: 'generation'})
    diagnostics.events.on(function recordMcpEvent(event) {
        events.push(event.toolId + ':' + event.state)
    })

    const inspect = diagnostics.tool({
        id: 'inspect',
        title: 'Inspect fixture',
        description: 'Returns isolated module identity and the supplied diagnostic input.',
        annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
    }, async function inspectTool(input, call) {
        if (input?.waitMs) {
            await new Promise(function wait(resolve, reject) {
                const timer = setTimeout(resolve, input.waitMs)
                call.signal.addEventListener('abort', function abortWait() {
                    clearTimeout(timer)
                    reject(call.signal.reason)
                }, {once: true})
            })
        }
        return {
            ok: true,
            input,
            moduleId: call.moduleId,
            version: call.version,
            contributionId: call.mcp.contributionId,
            toolId: call.mcp.toolId,
        }
    })

    const rogue = context.mcp.contribution({id: 'fixture.rogue', lifetime: 'generation'})
    rogue.tool({
        id: 'undeclared',
        annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
    }, function rogueTool() { return {ok: false} })

    let dynamic = null
    return {
        stats() {
            return {
                root: context.mcp.view.snapshot(),
                contribution: diagnostics.view.snapshot(),
                inspect: inspect.view.snapshot(),
                dynamic: dynamic?.view.snapshot() ?? null,
                events: [...events],
            }
        },
        registerDynamic() {
            if (!dynamic) {
                dynamic = diagnostics.tool({
                    id: 'dynamic',
                    title: 'Dynamic fixture tool',
                    description: 'Registered after the module is already ready.',
                    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
                }, function dynamicTool(input) { return {ok: true, dynamic: true, input} })
            }
            return dynamic.view.snapshot()
        },
        removeInspect() {
            return inspect.control.remove()
        },
    }
}`

function createSession(version = 'mcp-v1', bindingGeneration = 7) {
    return createModuleWorkerSession({
        verified: fixture(moduleSource, version),
        candidateId: 'candidate-' + version,
        bindingGeneration,
        startupTimeoutMs: 500,
        heartbeatIntervalMs: 20,
        heartbeatTimeoutMs: 200,
        defaultCallTimeoutMs: 500,
        maxCallTimeoutMs: 1_000,
        maxConcurrentCalls: 4,
        maxInputBytes: 4096,
        maxOutputBytes: 4096,
        memoryMb: 96,
        mcpPolicy: {
            maxTools: 2,
            contributions: [{
                contributionId: 'fixture.debug',
                lifetime: 'generation',
                tools: [{
                    toolId: 'inspect',
                    title: 'Inspect fixture',
                    description: 'Returns isolated module identity and the supplied diagnostic input.',
                    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
                }, {
                    toolId: 'dynamic',
                    title: 'Dynamic fixture tool',
                    description: 'Registered after the module is already ready.',
                    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
                }],
            }],
        },
    })
}

async function expectGatewayCode(promise: Promise<unknown>, code: string) {
    try {
        await promise
        return false
    } catch (error) {
        return error instanceof McpContributionGatewayError && error.code == code
    }
}

async function main() {
    console.log('\n[module-mcp] scoped worker registrar and policy receipts')
    const session = createSession()
    await session.control.start()
    const initial = session.mcp.view.snapshot()
    ok(initial.enabled && initial.accepted == 1 && initial.rejected == 1,
        'the host policy accepts the declared tool and rejects an undeclared registration')

    const moduleStats = await session.resource.call<any>('stats', null, {correlationId: 'stats-initial'})
    ok(moduleStats.root.accepted == 1
        && moduleStats.root.rejected == 1
        && moduleStats.inspect.state == 'accepted',
    'context.mcp exposes registration receipts and aggregate statistics inside the module')

    console.log('\n[module-mcp] gateway attach, invoke and runtime registration')
    const gateway = createMcpContributionGateway({maxTools: 4})
    const catalogEvents: string[] = []
    gateway.events.on(function recordGatewayEvent(event) {
        if (event.type == 'catalog') catalogEvents.push(event.reason)
    })
    const attached = gateway.control.attach({
        sourceId: 'fixture.module@g7',
        moduleId: 'fixture.module',
        version: 'mcp-v1',
        contentHash: 'sha256:mcp-v1',
        bindingGeneration: 7,
        mcp: session.mcp,
    })
    ok(attached.attached.includes('fixture.debug.inspect')
        && gateway.view.catalog().tools.length == 1,
    'one host gateway attaches the accepted contribution without a factory return value')

    const attachedStats = await session.resource.call<any>('stats', null, {correlationId: 'stats-attached'})
    ok(attachedStats.inspect.state == 'attached' && attachedStats.root.attached == 1,
        'the module receipt advances from accepted to externally attached')

    const inspected = await gateway.resource.invoke<any>('fixture.debug.inspect', {value: 3}, {
        correlationId: 'inspect-call',
        bindingGeneration: 7,
    })
    ok(inspected.ok
        && inspected.input.value == 3
        && inspected.moduleId == 'fixture.module'
        && inspected.contributionId == 'fixture.debug',
    'gateway invocation reaches the exact isolated registration handler')

    await session.resource.call('registerDynamic', null, {correlationId: 'register-dynamic'})
    ok(gateway.view.catalog().tools.some(tool => tool.name == 'fixture.debug.dynamic')
        && catalogEvents.includes('dynamic registration'),
    'a runtime context.mcp call registers and publishes a new tool with observable catalog facts')
    const dynamicStats = await session.resource.call<any>('stats', null, {correlationId: 'stats-dynamic'})
    ok(dynamicStats.dynamic.state == 'attached' && dynamicStats.root.attached == 2,
        'the runtime-created registration receives an attached receipt')

    console.log('\n[module-mcp] atomic source replacement and lease drain')
    const slow = gateway.resource.invoke<any>('fixture.debug.inspect', {waitMs: 40}, {
        correlationId: 'inspect-slow',
        bindingGeneration: 7,
    })
    const replacement = createSession('mcp-v2', 8)
    await replacement.control.start()
    const replaced = gateway.control.replace('fixture.module@g7', {
        sourceId: 'fixture.module@g8',
        moduleId: 'fixture.module',
        version: 'mcp-v2',
        contentHash: 'sha256:mcp-v2',
        bindingGeneration: 8,
        mcp: replacement.mcp,
    })
    ok(replaced.added.includes('fixture.debug.inspect')
        && replaced.removed.includes('fixture.debug.inspect'),
    'one synchronous gateway swap replaces the visible source alias')
    const current = await gateway.resource.invoke<any>('fixture.debug.inspect', {value: 8}, {
        correlationId: 'inspect-current',
        bindingGeneration: 8,
    })
    ok(current.version == 'mcp-v2', 'new calls resolve only the replacement worker version')
    ok((await slow).version == 'mcp-v1', 'the already leased old MCP call completes on its pinned worker')
    ok(gateway.view.snapshot().retiredWithLeases == 0,
        'the replaced binding disappears after its in-flight lease drains')
    const oldStats = await session.resource.call<any>('stats', null, {correlationId: 'stats-replaced'})
    ok(oldStats.root.detached == 2, 'the replaced module observes detached publication receipts')

    console.log('\n[module-mcp] detach hides all new calls')
    ok(gateway.control.detach('fixture.module@g8', 'test detach'), 'replacement source detaches exactly once')
    ok(await expectGatewayCode(
        gateway.resource.invoke('fixture.debug.inspect', null, {correlationId: 'inspect-stale'}),
        'E_MCP_TOOL_UNAVAILABLE',
    ), 'a new call cannot route through the detached catalog entry')
    ok(gateway.view.snapshot().toolCount == 0 && gateway.view.snapshot().retiredWithLeases == 0,
        'the detached replacement leaves no visible or leased binding')
    const detachedStats = await replacement.resource.call<any>('stats', null, {correlationId: 'stats-detached'})
    ok(detachedStats.root.detached == 1,
        'replacement context.mcp reports that its accepted registration is no longer published')

    await session.control.terminate('MCP registrar test complete')
    ok(session.view.snapshot().state == 'closed', 'worker termination closes the scoped registrar owner')
    await replacement.control.terminate('MCP registrar replacement test complete')
    ok(replacement.view.snapshot().state == 'closed', 'replacement worker terminates after detach')
    gateway.control.close()

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function fatal(error) {
    if (error instanceof ModuleWorkerError) console.error(error.code, error.message)
    else console.error(error)
    process.exit(2)
})
