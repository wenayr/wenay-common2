import {listen as createListenPair} from '../../src/Common/events/Listen'
import {
    ModuleIsolationCallOptions,
    ModuleIsolationMcpRegistration,
    ModuleIsolationSession,
} from '../../src/server/dynamic/module-isolation'

// =====================================================================
// Contribution source and gateway contracts
// =====================================================================

export type McpContributionSource = {
    sourceId: string
    moduleId: string
    version: string
    contentHash: string
    bindingGeneration: number
    mcp: ModuleIsolationSession['mcp']
}

export type McpContributionGatewayDeps = {
    maxTools?: number
    authorize?: (input: {
        source: Omit<McpContributionSource, 'mcp'>
        registration: ModuleIsolationMcpRegistration
        toolName: string
    }) => boolean
}

type tMcpContributionGatewayErrorCode =
    | 'E_MCP_GATEWAY_CLOSED'
    | 'E_MCP_SOURCE_EXISTS'
    | 'E_MCP_SOURCE_MISSING'
    | 'E_MCP_TOOL_CONFLICT'
    | 'E_MCP_TOOL_UNAVAILABLE'
    | 'E_MCP_TOOL_DENIED'
    | 'E_MCP_TOOL_LIMIT'

export class McpContributionGatewayError extends Error {
    readonly code: tMcpContributionGatewayErrorCode

    constructor(code: tMcpContributionGatewayErrorCode, message: string, opts: {cause?: unknown} = {}) {
        super(message, opts.cause != undefined ? {cause: opts.cause} : undefined)
        this.name = 'McpContributionGatewayError'
        this.code = code
    }
}

export type tMcpContributionGatewayEvent =
    | {
        type: 'catalog'
        catalogGeneration: number
        added: readonly string[]
        removed: readonly string[]
        reason: string
        at: number
    }
    | {
        type: 'registration'
        sourceId: string
        registrationId: number
        state: ModuleIsolationMcpRegistration['state'] | 'gateway-rejected'
        toolName: string
        reason?: string
        at: number
    }
    | {
        type: 'call'
        phase: 'started' | 'settled'
        toolName: string
        sourceId: string
        correlationId: string
        at: number
    }
    | {type: 'error', error: McpContributionGatewayError, at: number}

type SourceRecord = {
    input: McpContributionSource
    tools: Map<number, ToolBinding>
    off: () => void
}

type ToolBinding = {
    name: string
    sourceId: string
    registration: ModuleIsolationMcpRegistration
    mcp: ModuleIsolationSession['mcp']
    inFlight: number
    calls: number
    failures: number
    retired: boolean
}

// =====================================================================
// Host-owned layered catalog
// =====================================================================

export function createMcpContributionGateway(deps: McpContributionGatewayDeps = {}) {
    const maxTools = positiveInteger(deps.maxTools, 256, 'maxTools')
    const [emitEvent, eventLine] = createListenPair<[tMcpContributionGatewayEvent]>()
    const sources = new Map<string, SourceRecord>()
    const tools = new Map<string, ToolBinding>()
    const retired = new Set<ToolBinding>()

    let catalogGeneration = 0
    let closing = false
    let rejectedRegistrations = 0
    let lastError: {code: string, message: string} | null = null

    function sourceIdentity(source: McpContributionSource) {
        return {
            sourceId: source.sourceId,
            moduleId: source.moduleId,
            version: source.version,
            contentHash: source.contentHash,
            bindingGeneration: source.bindingGeneration,
        }
    }

    function toolName(registration: ModuleIsolationMcpRegistration) {
        const name = registration.descriptor.contributionId + '.' + registration.descriptor.toolId
        if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
            throw gatewayError('E_MCP_TOOL_DENIED', 'MCP tool name is not protocol-safe: ' + name)
        }
        return name
    }

    function gatewayError(
        code: tMcpContributionGatewayErrorCode,
        message: string,
        cause?: unknown,
    ) {
        const error = new McpContributionGatewayError(code, message, {cause})
        lastError = {code, message}
        emitEvent({type: 'error', error, at: Date.now()})
        return error
    }

    function authorize(source: McpContributionSource, registration: ModuleIsolationMcpRegistration, name: string) {
        if (!deps.authorize) return true
        try {
            return deps.authorize({source: sourceIdentity(source), registration, toolName: name})
        } catch (error) {
            throw gatewayError('E_MCP_TOOL_DENIED', 'MCP gateway authorization failed for ' + name, error)
        }
    }

    function createBinding(source: McpContributionSource, registration: ModuleIsolationMcpRegistration) {
        const name = toolName(registration)
        if (!authorize(source, registration, name)) {
            throw gatewayError('E_MCP_TOOL_DENIED', 'MCP gateway denied tool ' + name)
        }
        return {
            name,
            sourceId: source.sourceId,
            registration: copyRegistration(registration),
            mcp: source.mcp,
            inFlight: 0,
            calls: 0,
            failures: 0,
            retired: false,
        } satisfies ToolBinding
    }

    function visibleRegistrations(source: McpContributionSource) {
        return source.mcp.view.snapshot().registrations.filter(registration =>
            registration.state == 'accepted' || registration.state == 'detached')
    }

    function prepareSource(source: McpContributionSource, ignoredSourceId?: string) {
        if (!source.sourceId || !source.moduleId || !source.version || !source.contentHash) {
            throw gatewayError('E_MCP_TOOL_DENIED', 'MCP contribution source identity is incomplete')
        }
        const prepared = new Map<number, ToolBinding>()
        const names = new Set<string>()
        for (const registration of visibleRegistrations(source)) {
            const binding = createBinding(source, registration)
            const existing = tools.get(binding.name)
            if ((existing && existing.sourceId != ignoredSourceId) || names.has(binding.name)) {
                throw gatewayError('E_MCP_TOOL_CONFLICT', 'MCP tool name conflicts: ' + binding.name)
            }
            names.add(binding.name)
            prepared.set(registration.registrationId, binding)
        }
        const retained = [...tools.values()].filter(binding => binding.sourceId != ignoredSourceId).length
        if (retained + prepared.size > maxTools) {
            throw gatewayError('E_MCP_TOOL_LIMIT', 'MCP catalog exceeds the configured tool budget')
        }
        return prepared
    }

    function emitCatalog(added: readonly string[], removed: readonly string[], reason: string) {
        if (!added.length && !removed.length) return
        catalogGeneration++
        emitEvent({
            type: 'catalog',
            catalogGeneration,
            added: [...added],
            removed: [...removed],
            reason,
            at: Date.now(),
        })
    }

    function markRetired(binding: ToolBinding) {
        binding.retired = true
        if (binding.inFlight) retired.add(binding)
    }

    function publishRegistration(source: SourceRecord, registration: ModuleIsolationMcpRegistration) {
        if (closing || sources.get(source.input.sourceId) != source || registration.state != 'accepted') return
        let binding: ToolBinding
        try {
            binding = createBinding(source.input, registration)
            if (tools.has(binding.name)) {
                throw gatewayError('E_MCP_TOOL_CONFLICT', 'MCP tool name conflicts: ' + binding.name)
            }
            if (tools.size >= maxTools) throw gatewayError('E_MCP_TOOL_LIMIT', 'MCP catalog tool budget is full')
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            rejectedRegistrations++
            source.input.mcp.control.setPublished(registration.registrationId, false, reason)
            emitEvent({
                type: 'registration',
                sourceId: source.input.sourceId,
                registrationId: registration.registrationId,
                state: 'gateway-rejected',
                toolName: safeToolName(registration),
                reason,
                at: Date.now(),
            })
            return
        }
        source.tools.set(registration.registrationId, binding)
        tools.set(binding.name, binding)
        source.input.mcp.control.setPublished(registration.registrationId, true)
        emitEvent({
            type: 'registration',
            sourceId: source.input.sourceId,
            registrationId: registration.registrationId,
            state: 'attached',
            toolName: binding.name,
            at: Date.now(),
        })
        emitCatalog([binding.name], [], 'dynamic registration')
    }

    function unpublishRegistration(source: SourceRecord, registration: ModuleIsolationMcpRegistration) {
        const binding = source.tools.get(registration.registrationId)
        if (!binding) return
        source.tools.delete(registration.registrationId)
        if (tools.get(binding.name) == binding) tools.delete(binding.name)
        markRetired(binding)
        emitEvent({
            type: 'registration',
            sourceId: source.input.sourceId,
            registrationId: registration.registrationId,
            state: registration.state,
            toolName: binding.name,
            reason: registration.reason,
            at: Date.now(),
        })
        emitCatalog([], [binding.name], 'dynamic unregistration')
    }

    function onSourceEvent(source: SourceRecord, event: Parameters<ModuleIsolationSession['mcp']['events']['on']>[0] extends
        (value: infer T) => void ? T : never) {
        if (sources.get(source.input.sourceId) != source) return
        if (event.phase == 'accepted') publishRegistration(source, event.registration)
        else if (event.phase == 'removed') unpublishRegistration(source, event.registration)
        else if (event.phase == 'rejected') {
            rejectedRegistrations++
            emitEvent({
                type: 'registration',
                sourceId: source.input.sourceId,
                registrationId: event.registration.registrationId,
                state: 'rejected',
                toolName: safeToolName(event.registration),
                reason: event.registration.reason,
                at: Date.now(),
            })
        }
    }

    function attach(source: McpContributionSource) {
        if (closing) throw gatewayError('E_MCP_GATEWAY_CLOSED', 'MCP contribution gateway is closed')
        if (sources.has(source.sourceId)) {
            throw gatewayError('E_MCP_SOURCE_EXISTS', 'MCP contribution source already exists: ' + source.sourceId)
        }
        const prepared = prepareSource(source)
        const record: SourceRecord = {
            input: source,
            tools: prepared,
            off: function noop() {},
        }
        record.off = source.mcp.events.on(function onMcpSourceEvent(event) {
            onSourceEvent(record, event)
        })
        sources.set(source.sourceId, record)
        for (const binding of prepared.values()) {
            tools.set(binding.name, binding)
            source.mcp.control.setPublished(binding.registration.registrationId, true)
        }
        const added = [...prepared.values()].map(binding => binding.name)
        emitCatalog(added, [], 'source attached')
        return {
            ok: true as const,
            sourceId: source.sourceId,
            catalogGeneration,
            attached: added,
        }
    }

    function replace(previousSourceId: string, source: McpContributionSource) {
        if (closing) throw gatewayError('E_MCP_GATEWAY_CLOSED', 'MCP contribution gateway is closed')
        const previous = sources.get(previousSourceId)
        if (!previous) throw gatewayError('E_MCP_SOURCE_MISSING', 'MCP source is missing: ' + previousSourceId)
        if (source.sourceId != previousSourceId && sources.has(source.sourceId)) {
            throw gatewayError('E_MCP_SOURCE_EXISTS', 'MCP contribution source already exists: ' + source.sourceId)
        }
        const prepared = prepareSource(source, previousSourceId)
        const next: SourceRecord = {
            input: source,
            tools: prepared,
            off: function noop() {},
        }
        next.off = source.mcp.events.on(function onMcpSourceEvent(event) {
            onSourceEvent(next, event)
        })

        const removed = [...previous.tools.values()].map(binding => binding.name)
        previous.off()
        sources.delete(previousSourceId)
        for (const binding of previous.tools.values()) {
            if (tools.get(binding.name) == binding) tools.delete(binding.name)
            previous.input.mcp.control.setPublished(binding.registration.registrationId, false, 'source replaced')
            markRetired(binding)
        }

        sources.set(source.sourceId, next)
        for (const binding of prepared.values()) {
            tools.set(binding.name, binding)
            source.mcp.control.setPublished(binding.registration.registrationId, true)
        }
        const added = [...prepared.values()].map(binding => binding.name)
        emitCatalog(added, removed, 'source replaced')
        return {
            ok: true as const,
            previousSourceId,
            sourceId: source.sourceId,
            catalogGeneration,
            added,
            removed,
        }
    }

    function detach(sourceId: string, reason = 'source detached') {
        const source = sources.get(sourceId)
        if (!source) return false
        sources.delete(sourceId)
        source.off()
        const removed: string[] = []
        for (const binding of source.tools.values()) {
            if (tools.get(binding.name) == binding) tools.delete(binding.name)
            source.input.mcp.control.setPublished(binding.registration.registrationId, false, reason)
            markRetired(binding)
            removed.push(binding.name)
        }
        source.tools.clear()
        emitCatalog([], removed, reason)
        return true
    }

    async function invoke<T>(
        name: string,
        input: unknown,
        opts: ModuleIsolationCallOptions,
    ): Promise<T> {
        const binding = tools.get(name)
        if (!binding || binding.retired) {
            throw gatewayError('E_MCP_TOOL_UNAVAILABLE', 'MCP tool is unavailable: ' + name)
        }
        binding.inFlight++
        binding.calls++
        emitEvent({
            type: 'call',
            phase: 'started',
            toolName: name,
            sourceId: binding.sourceId,
            correlationId: opts.correlationId,
            at: Date.now(),
        })
        try {
            return await binding.mcp.resource.call<T>(binding.registration.registrationId, input, opts)
        } catch (error) {
            binding.failures++
            throw error
        } finally {
            binding.inFlight--
            if (binding.retired && !binding.inFlight) retired.delete(binding)
            emitEvent({
                type: 'call',
                phase: 'settled',
                toolName: name,
                sourceId: binding.sourceId,
                correlationId: opts.correlationId,
                at: Date.now(),
            })
        }
    }

    function catalog() {
        return {
            catalogGeneration,
            tools: [...tools.values()].map(binding => ({
                name: binding.name,
                sourceId: binding.sourceId,
                registrationId: binding.registration.registrationId,
                descriptor: copyRegistration(binding.registration).descriptor,
                inFlight: binding.inFlight,
            })),
        }
    }

    function snapshot() {
        return {
            catalogGeneration,
            sourceCount: sources.size,
            toolCount: tools.size,
            inFlight: [...tools.values(), ...retired].reduce((sum, binding) => sum + binding.inFlight, 0),
            retiredWithLeases: retired.size,
            rejectedRegistrations,
            closing,
            lastError: lastError ? {...lastError} : null,
        }
    }

    function healthSnapshot() {
        const state = closing ? 'closed' : lastError ? 'degraded' : 'healthy'
        return {state, ...snapshot()}
    }

    function close() {
        if (closing) return false
        closing = true
        for (const sourceId of [...sources.keys()]) detach(sourceId, 'gateway closed')
        eventLine.close()
        return true
    }

    return {
        control: {
            attach,
            replace,
            detach,
            close,
        },
        resource: {
            invoke,
        },
        events: {
            on: eventLine.on,
        },
        view: {
            catalog,
            snapshot,
        },
        health: {
            snapshot: healthSnapshot,
        },
    }
}

export type McpContributionGateway = ReturnType<typeof createMcpContributionGateway>

// =====================================================================
// Local helpers
// =====================================================================

function positiveInteger(value: number | undefined, fallback: number, name: string) {
    const result = value ?? fallback
    if (!Number.isSafeInteger(result) || result <= 0) throw new Error(name + ' must be a positive safe integer')
    return result
}

function copyRegistration(value: ModuleIsolationMcpRegistration): ModuleIsolationMcpRegistration {
    return {
        registrationId: value.registrationId,
        descriptor: {
            ...value.descriptor,
            annotations: value.descriptor.annotations ? {...value.descriptor.annotations} : undefined,
        },
        state: value.state,
        reason: value.reason,
    }
}

function safeToolName(registration: ModuleIsolationMcpRegistration) {
    return registration.descriptor.contributionId + '.' + registration.descriptor.toolId
}
