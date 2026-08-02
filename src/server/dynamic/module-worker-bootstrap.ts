// =====================================================================
// Private worker bootstrap
// =====================================================================

/**
 * Runs as an eval worker so each candidate receives a fresh JS realm without relying on Node's
 * process-level module cache. The caller has already verified the supplied source.
 */
export const moduleWorkerBootstrapSource = String.raw`
'use strict'

const {parentPort, workerData} = require('node:worker_threads')
const {serialize} = require('node:v8')
const {AsyncLocalStorage} = require('node:async_hooks')

const protocol = 'wenay-common2/module-worker@2'
const calls = new Map()
const dependencyCalls = new Map()
const mcpRegistrations = new Map()
const mcpListeners = new Set()
const callScope = new AsyncLocalStorage()
let api = null
let closing = false
let nextDependencyCallId = 0
let nextMcpRegistrationId = 0

function serializedSize(value) {
    return serialize(value).byteLength
}

function structuredError(error, fallbackCode) {
    const value = error && typeof error == 'object' ? error : null
    return {
        name: typeof value?.name == 'string' ? value.name : 'Error',
        message: typeof value?.message == 'string' ? value.message : String(error),
        stack: typeof value?.stack == 'string' ? value.stack : undefined,
        code: typeof value?.code == 'string' ? value.code : fallbackCode,
    }
}

function send(message) {
    if (!closing) parentPort.postMessage(message)
}

function sendFailure(error) {
    send({protocol, type: 'fatal', error: structuredError(error, 'E_WORKER_START')})
}

function mcpError(message, code = 'E_MCP_REGISTRATION') {
    const error = new Error(message)
    error.code = code
    return error
}

function mcpRegistrationSnapshot(registration) {
    return {
        registrationId: registration.registrationId,
        contributionId: registration.contributionId,
        lifetime: registration.lifetime,
        toolId: registration.toolId,
        state: registration.state,
        reason: registration.reason,
    }
}

function mcpSnapshot() {
    const registrations = [...mcpRegistrations.values()].map(mcpRegistrationSnapshot)
    return {
        enabled: Boolean(workerData.mcp?.enabled),
        total: registrations.length,
        pending: registrations.filter(value => value.state == 'pending').length,
        accepted: registrations.filter(value => value.state == 'accepted').length,
        attached: registrations.filter(value => value.state == 'attached').length,
        detached: registrations.filter(value => value.state == 'detached').length,
        rejected: registrations.filter(value => value.state == 'rejected').length,
        removed: registrations.filter(value => value.state == 'removed').length,
        registrations,
    }
}

function emitMcp(event) {
    for (const listener of [...mcpListeners]) {
        try {
            listener(event)
        } catch {
            // A diagnostic listener cannot break the module or registration corridor.
        }
    }
}

function validateMcpId(value, name) {
    if (typeof value != 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) {
        throw mcpError(name + ' must contain only MCP-safe name characters')
    }
    return value
}

function createMcpContribution(input) {
    const contributionId = validateMcpId(input?.id, 'contribution id')
    const lifetime = input?.lifetime
    if (lifetime != 'host' && lifetime != 'generation' && lifetime != 'session') {
        throw mcpError('MCP contribution lifetime must be host, generation, or session')
    }
    const owned = new Set()
    let contributionClosed = false

    function registerTool(descriptor, handler) {
        if (contributionClosed) throw mcpError('MCP contribution is closed', 'E_MCP_CLOSED')
        if (typeof handler != 'function') throw mcpError('MCP tool handler must be a function')
        const toolId = validateMcpId(descriptor?.id, 'tool id')
        for (const registration of mcpRegistrations.values()) {
            if (registration.contributionId == contributionId
                && registration.toolId == toolId
                && registration.state != 'removed'
                && registration.state != 'rejected') {
                throw mcpError('MCP tool is already registered: ' + contributionId + '.' + toolId)
            }
        }
        const registrationId = ++nextMcpRegistrationId
        const annotations = descriptor?.annotations && typeof descriptor.annotations == 'object'
            ? {
                readOnlyHint: descriptor.annotations.readOnlyHint == true,
                destructiveHint: descriptor.annotations.destructiveHint == true,
                idempotentHint: descriptor.annotations.idempotentHint == true,
            }
            : undefined
        const registration = {
            registrationId,
            contributionId,
            lifetime,
            toolId,
            title: typeof descriptor?.title == 'string' ? descriptor.title : undefined,
            description: typeof descriptor?.description == 'string' ? descriptor.description : undefined,
            annotations,
            handler,
            state: 'pending',
            reason: undefined,
        }
        mcpRegistrations.set(registrationId, registration)
        owned.add(registrationId)
        send({
            protocol,
            type: 'mcp-register',
            registrationId,
            descriptor: {
                contributionId,
                lifetime,
                toolId,
                title: registration.title,
                description: registration.description,
                annotations,
            },
        })
        emitMcp({type: 'registration', phase: 'pending', ...mcpRegistrationSnapshot(registration)})

        function remove() {
            if (registration.state == 'removed' || registration.state == 'rejected') return false
            registration.state = 'removing'
            send({protocol, type: 'mcp-unregister', registrationId})
            emitMcp({type: 'registration', phase: 'removing', ...mcpRegistrationSnapshot(registration)})
            return true
        }

        return {
            registrationId,
            control: {remove},
            view: {snapshot: () => mcpRegistrationSnapshot(registration)},
        }
    }

    function closeContribution() {
        if (contributionClosed) return false
        contributionClosed = true
        for (const registrationId of owned) {
            const registration = mcpRegistrations.get(registrationId)
            if (registration?.state == 'pending'
                || registration?.state == 'accepted'
                || registration?.state == 'attached'
                || registration?.state == 'detached') {
                registration.state = 'removing'
                send({protocol, type: 'mcp-unregister', registrationId})
            }
        }
        return true
    }

    return {
        tool: registerTool,
        control: {close: closeContribution},
        events: {
            on(listener) {
                if (typeof listener != 'function') throw mcpError('MCP listener must be a function')
                function scopedListener(event) {
                    if (event.contributionId == contributionId) listener(event)
                }
                mcpListeners.add(scopedListener)
                return function offMcpContribution() { mcpListeners.delete(scopedListener) }
            },
        },
        view: {
            snapshot() {
                const all = mcpSnapshot()
                const registrations = all.registrations.filter(value => value.contributionId == contributionId)
                return {
                    enabled: all.enabled,
                    contributionId,
                    lifetime,
                    total: registrations.length,
                    pending: registrations.filter(value => value.state == 'pending').length,
                    accepted: registrations.filter(value => value.state == 'accepted').length,
                    attached: registrations.filter(value => value.state == 'attached').length,
                    detached: registrations.filter(value => value.state == 'detached').length,
                    rejected: registrations.filter(value => value.state == 'rejected').length,
                    removed: registrations.filter(value => value.state == 'removed').length,
                    registrations,
                }
            },
        },
    }
}

const mcpApi = {
    contribution: createMcpContribution,
    events: {
        on(listener) {
            if (typeof listener != 'function') throw mcpError('MCP listener must be a function')
            mcpListeners.add(listener)
            return function offMcp() { mcpListeners.delete(listener) }
        },
    },
    view: {snapshot: mcpSnapshot},
}

function dependencyError(message, code = 'E_DEPENDENCY_UNAVAILABLE') {
    const error = new Error(message)
    error.code = code
    return error
}

function callDependency(moduleId, method, input) {
    const scope = callScope.getStore()
    if (!scope) return Promise.reject(dependencyError('dependencies are available only during a module call'))
    if (typeof moduleId != 'string' || !moduleId || typeof method != 'string' || !method) {
        return Promise.reject(dependencyError('dependency moduleId and method must be non-empty strings'))
    }
    let inputBytes
    try {
        inputBytes = serializedSize(input)
    } catch (error) {
        return Promise.reject(dependencyError('dependency input is not serializable', 'E_INPUT_LIMIT'))
    }
    if (inputBytes > workerData.limits.maxInputBytes) {
        return Promise.reject(dependencyError('dependency input exceeds the configured byte budget', 'E_INPUT_LIMIT'))
    }
    if (dependencyCalls.size >= workerData.limits.maxConcurrentCalls) {
        return Promise.reject(dependencyError('dependency concurrency budget exceeded', 'E_CONCURRENCY_LIMIT'))
    }

    const dependencyCallId = ++nextDependencyCallId
    return new Promise(function dispatchDependency(resolve, reject) {
        dependencyCalls.set(dependencyCallId, {resolve, reject, parentCallId: scope.callId})
        try {
            send({
                protocol,
                type: 'dependency-call',
                dependencyCallId,
                parentCallId: scope.callId,
                moduleId,
                method,
                input,
                correlationId: scope.correlationId,
                bindingGeneration: scope.bindingGeneration,
            })
        } catch (error) {
            dependencyCalls.delete(dependencyCallId)
            reject(dependencyError('could not dispatch dependency call'))
        }
    })
}

function settleDependency(message) {
    const dependency = dependencyCalls.get(message.dependencyCallId)
    if (!dependency) return
    dependencyCalls.delete(message.dependencyCallId)
    if (message.ok) {
        let outputBytes
        try {
            outputBytes = serializedSize(message.value)
        } catch (error) {
            dependency.reject(dependencyError('dependency output is not serializable', 'E_OUTPUT_LIMIT'))
            return
        }
        if (outputBytes > workerData.limits.maxOutputBytes) {
            dependency.reject(dependencyError('dependency output exceeds the configured byte budget', 'E_OUTPUT_LIMIT'))
            return
        }
        dependency.resolve(message.value)
        return
    }
    const remote = message.error || {}
    const error = dependencyError(
        typeof remote.message == 'string' ? remote.message : 'dependency call failed',
        typeof remote.code == 'string' ? remote.code : 'E_DEPENDENCY_UNAVAILABLE',
    )
    error.name = typeof remote.name == 'string' ? remote.name : 'Error'
    error.remoteStack = typeof remote.stack == 'string' ? remote.stack : undefined
    dependency.reject(error)
}

function cancelDependencies(parentCallId, reason) {
    for (const [dependencyCallId, dependency] of dependencyCalls) {
        if (dependency.parentCallId != parentCallId) continue
        dependencyCalls.delete(dependencyCallId)
        dependency.reject(dependencyError(reason))
    }
}

async function invoke(message) {
    if (closing) return
    if (calls.size >= workerData.limits.maxConcurrentCalls) {
        send({
            protocol,
            type: 'result',
            callId: message.callId,
            ok: false,
            error: {
                name: 'Error',
                message: 'worker concurrency budget exceeded',
                code: 'E_CONCURRENCY_LIMIT',
            },
        })
        return
    }

    const registration = message.type == 'mcp-call'
        ? mcpRegistrations.get(message.registrationId)
        : null
    const method = message.type == 'mcp-call'
        ? registration?.state == 'accepted' || registration?.state == 'attached'
            ? registration.handler
            : null
        : api?.[message.method]
    if (typeof method != 'function') {
        send({
            protocol,
            type: 'result',
            callId: message.callId,
            ok: false,
            error: {
                name: 'Error',
                message: message.type == 'mcp-call'
                    ? 'MCP tool is unavailable: ' + message.registrationId
                    : 'unknown module method: ' + message.method,
                code: message.type == 'mcp-call' ? 'E_MCP_TOOL_UNAVAILABLE' : 'E_METHOD_NOT_FOUND',
            },
        })
        return
    }

    const abort = new AbortController()
    calls.set(message.callId, abort)
    try {
        const value = await callScope.run({
            callId: message.callId,
            bindingGeneration: message.bindingGeneration,
            correlationId: message.correlationId,
        }, function runModuleCall() {
            return method(message.input, {
                signal: abort.signal,
                moduleId: workerData.metadata.moduleId,
                version: workerData.metadata.version,
                contentHash: workerData.metadata.contentHash,
                candidateId: workerData.metadata.candidateId,
                bindingGeneration: message.bindingGeneration,
                correlationId: message.correlationId,
                mcp: registration ? {
                    registrationId: registration.registrationId,
                    contributionId: registration.contributionId,
                    lifetime: registration.lifetime,
                    toolId: registration.toolId,
                } : undefined,
            })
        })
        if (!calls.has(message.callId)) return
        const outputBytes = serializedSize(value)
        if (outputBytes > workerData.limits.maxOutputBytes) {
            send({
                protocol,
                type: 'result',
                callId: message.callId,
                ok: false,
                error: {
                    name: 'Error',
                    message: 'module output exceeds the configured byte budget',
                    code: 'E_OUTPUT_LIMIT',
                },
            })
            return
        }
        send({protocol, type: 'result', callId: message.callId, ok: true, value})
    } catch (error) {
        if (!calls.has(message.callId)) return
        send({
            protocol,
            type: 'result',
            callId: message.callId,
            ok: false,
            error: structuredError(error, 'E_MODULE_CALL'),
        })
    } finally {
        calls.delete(message.callId)
        cancelDependencies(message.callId, 'parent module call settled')
    }
}

function settleMcpRegistration(message) {
    const registration = mcpRegistrations.get(message.registrationId)
    if (!registration) return
    registration.state = message.state
    registration.reason = typeof message.reason == 'string' ? message.reason : undefined
    if (message.state == 'rejected' || message.state == 'removed') registration.handler = null
    emitMcp({
        type: 'registration',
        phase: message.state,
        ...mcpRegistrationSnapshot(registration),
    })
}

function onMessage(message) {
    if (!message || message.protocol != protocol || closing) return
    if (message.type == 'ping') {
        send({protocol, type: 'pong', nonce: message.nonce})
        return
    }
    if (message.type == 'cancel') {
        calls.get(message.callId)?.abort(message.reason)
        calls.delete(message.callId)
        cancelDependencies(message.callId, 'parent module call was cancelled')
        return
    }
    if (message.type == 'dependency-result') {
        settleDependency(message)
        return
    }
    if (message.type == 'mcp-registration') {
        settleMcpRegistration(message)
        return
    }
    if (message.type == 'call' || message.type == 'mcp-call') void invoke(message)
}

async function start() {
    if (!parentPort) throw new Error('module worker requires a parent port')
    parentPort.on('message', onMessage)

    const createModule = Function('"use strict"; return (' + workerData.source + '\n)')()
    if (typeof createModule != 'function') throw new Error('verified module source must evaluate to a factory function')
    api = await createModule({
        moduleId: workerData.metadata.moduleId,
        version: workerData.metadata.version,
        contentHash: workerData.metadata.contentHash,
        candidateId: workerData.metadata.candidateId,
        bindingGeneration: workerData.metadata.bindingGeneration,
        dependencies: {
            call: callDependency,
        },
        mcp: mcpApi,
    })
    if (!api || typeof api != 'object') throw new Error('module factory must return an object')

    send({
        protocol,
        type: 'ready',
        metadata: workerData.metadata,
        methods: Object.keys(api).filter(key => typeof api[key] == 'function'),
        mcpRegistrationCount: mcpRegistrations.size,
    })
}

process.on('uncaughtException', function onUncaughtException(error) {
    sendFailure(error)
    closing = true
    setImmediate(function exitAfterUncaughtException() { process.exit(1) })
})

process.on('unhandledRejection', function onUnhandledRejection(error) {
    sendFailure(error)
    closing = true
    setImmediate(function exitAfterUnhandledRejection() { process.exit(1) })
})

start().catch(function failStart(error) {
    sendFailure(error)
    closing = true
    setImmediate(function exitAfterStartFailure() { process.exit(1) })
})
`
