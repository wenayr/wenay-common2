"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModuleWorkerError = exports.MODULE_WORKER_VERIFIED_SOURCE = void 0;
exports.createModuleWorkerSession = createModuleWorkerSession;
const node_worker_threads_1 = require("node:worker_threads");
const node_v8_1 = require("node:v8");
const Listen_1 = require("../../Common/events/Listen");
const module_worker_bootstrap_1 = require("./module-worker-bootstrap");
exports.MODULE_WORKER_VERIFIED_SOURCE = 'wenay-common2/verified-module-source@1';
const MODULE_WORKER_PROTOCOL = 'wenay-common2/module-worker@2';
class ModuleWorkerError extends Error {
    code;
    moduleId;
    version;
    candidateId;
    bindingGeneration;
    correlationId;
    remoteStack;
    constructor(code, message, metadata, opts = {}) {
        super(message, opts.cause != undefined ? { cause: opts.cause } : undefined);
        this.name = 'ModuleWorkerError';
        this.code = code;
        this.moduleId = metadata.moduleId;
        this.version = metadata.version;
        this.candidateId = metadata.candidateId;
        this.bindingGeneration = metadata.bindingGeneration;
        this.correlationId = opts.correlationId;
        this.remoteStack = opts.remoteStack;
    }
}
exports.ModuleWorkerError = ModuleWorkerError;
function createModuleWorkerSession(deps) {
    const startupTimeoutMs = positiveInteger(deps.startupTimeoutMs, 5_000, 'startupTimeoutMs');
    const heartbeatIntervalMs = positiveInteger(deps.heartbeatIntervalMs, 1_000, 'heartbeatIntervalMs');
    const heartbeatTimeoutMs = positiveInteger(deps.heartbeatTimeoutMs, 5_000, 'heartbeatTimeoutMs');
    const defaultCallTimeoutMs = positiveInteger(deps.defaultCallTimeoutMs, 5_000, 'defaultCallTimeoutMs');
    const maxCallTimeoutMs = positiveInteger(deps.maxCallTimeoutMs, 30_000, 'maxCallTimeoutMs');
    const maxConcurrentCalls = positiveInteger(deps.maxConcurrentCalls, 32, 'maxConcurrentCalls');
    const maxSourceBytes = positiveInteger(deps.maxSourceBytes, 1024 * 1024, 'maxSourceBytes');
    const maxInputBytes = positiveInteger(deps.maxInputBytes, 256 * 1024, 'maxInputBytes');
    const maxOutputBytes = positiveInteger(deps.maxOutputBytes, 256 * 1024, 'maxOutputBytes');
    const memoryMb = positiveInteger(deps.memoryMb, 128, 'memoryMb');
    const metadata = verifiedMetadata(deps.verified, deps.candidateId, deps.bindingGeneration, maxSourceBytes);
    const allowedDependencies = dependencyAllowlist(deps.allowedDependencies);
    const mcpPolicy = moduleMcpPolicy(deps.mcpPolicy);
    if (memoryMb < 16 || memoryMb > 4_096) {
        throw new ModuleWorkerError('E_INVALID_VERIFIED_SOURCE', 'memoryMb must be between 16 and 4096', metadata);
    }
    if (heartbeatTimeoutMs < heartbeatIntervalMs) {
        throw new ModuleWorkerError('E_INVALID_VERIFIED_SOURCE', 'heartbeatTimeoutMs must be greater than or equal to heartbeatIntervalMs', metadata);
    }
    if (defaultCallTimeoutMs > maxCallTimeoutMs) {
        throw new ModuleWorkerError('E_INVALID_VERIFIED_SOURCE', 'defaultCallTimeoutMs must not exceed maxCallTimeoutMs', metadata);
    }
    const [emitEvent, eventLine] = (0, Listen_1.listen)();
    const pending = new Map();
    const mcpRegistrations = new Map();
    let state = 'idle';
    let worker = null;
    let startPromise = null;
    let resolveStart = null;
    let rejectStart = null;
    let terminatePromise = null;
    let startupTimer = null;
    let heartbeatTimer = null;
    let startedAt = null;
    let closedAt = null;
    let lastHeartbeatAt = null;
    let lastPingNonce = 0;
    let nextCallId = 0;
    let terminalFailure = null;
    let methods = [];
    function mcpSnapshot() {
        const registrations = [...mcpRegistrations.values()].map(copyMcpRegistration);
        return {
            enabled: mcpPolicy.enabled,
            total: registrations.length,
            accepted: registrations.filter(value => value.state == 'accepted').length,
            attached: registrations.filter(value => value.state == 'attached').length,
            detached: registrations.filter(value => value.state == 'detached').length,
            rejected: registrations.filter(value => value.state == 'rejected').length,
            removed: registrations.filter(value => value.state == 'removed').length,
            registrations,
        };
    }
    function snapshot() {
        return {
            ...metadata,
            state,
            startedAt,
            closedAt,
            lastHeartbeatAt,
            inFlight: pending.size,
            methods: [...methods],
            mcp: mcpSnapshot(),
            memoryMb,
            failure: terminalFailure
                ? { code: terminalFailure.code, message: terminalFailure.message }
                : null,
        };
    }
    function healthSnapshot() {
        let health = 'unknown';
        if (state == 'ready') {
            health = lastHeartbeatAt != null && Date.now() - lastHeartbeatAt <= heartbeatTimeoutMs
                ? 'healthy'
                : 'unhealthy';
        }
        else if (state == 'failed')
            health = 'unhealthy';
        else if (state == 'closed')
            health = 'closed';
        return {
            ...metadata,
            health,
            lastHeartbeatAt,
            inFlight: pending.size,
            maxConcurrentCalls,
            memoryMb,
            mcpAccepted: mcpSnapshot().accepted,
        };
    }
    function setState(next, reason) {
        if (state == next)
            return;
        state = next;
        emitEvent({ type: 'state', state, at: Date.now(), reason });
    }
    function clearSessionTimers() {
        if (startupTimer)
            clearTimeout(startupTimer);
        startupTimer = null;
        if (heartbeatTimer)
            clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    function settleStart(error) {
        const resolve = resolveStart;
        const reject = rejectStart;
        resolveStart = null;
        rejectStart = null;
        if (error != undefined)
            reject?.(error);
        else
            resolve?.();
    }
    function settleCall(callId, error, value) {
        const call = pending.get(callId);
        if (!call)
            return;
        pending.delete(callId);
        clearTimeout(call.timer);
        call.removeAbort();
        emitEvent({
            type: 'call',
            phase: 'settled',
            callId,
            method: call.method,
            correlationId: call.correlationId,
            bindingGeneration: call.bindingGeneration,
            at: Date.now(),
        });
        if (error != undefined)
            call.reject(error);
        else
            call.resolve(value);
    }
    function rejectPending(error) {
        for (const callId of [...pending.keys()])
            settleCall(callId, error);
    }
    function moduleError(code, message, opts = {}) {
        return new ModuleWorkerError(code, message, metadata, opts);
    }
    function remoteError(error, correlationId) {
        const supportedCodes = [
            'E_CONCURRENCY_LIMIT',
            'E_OUTPUT_LIMIT',
            'E_METHOD_NOT_FOUND',
            'E_MCP_TOOL_UNAVAILABLE',
            'E_DEPENDENCY_UNAVAILABLE',
            'E_MODULE_CALL',
        ];
        const code = supportedCodes.includes(error.code)
            ? error.code
            : 'E_MODULE_CALL';
        return moduleError(code, error.message ?? 'module call failed', {
            correlationId,
            remoteStack: error.stack,
        });
    }
    function sendMcpRegistrationState(target, registrationId, state, reason) {
        postWorkerMessage(target, {
            protocol: MODULE_WORKER_PROTOCOL,
            type: 'mcp-registration',
            registrationId,
            state,
            reason,
        }, 'could not return MCP registration state');
    }
    function emitMcpRegistration(registration) {
        emitEvent({
            type: 'mcp',
            phase: registration.state,
            registration: copyMcpRegistration(registration),
            at: Date.now(),
        });
    }
    function handleMcpRegister(message) {
        const target = worker;
        if (!target || (state != 'starting' && state != 'ready'))
            return;
        if (!Number.isSafeInteger(message.registrationId)
            || message.registrationId <= 0
            || mcpRegistrations.has(message.registrationId)) {
            beginFailure(moduleError('E_WORKER_PROTOCOL', 'MCP registration id is invalid or duplicated'));
            return;
        }
        let descriptor;
        try {
            descriptor = normalizeMcpToolDescriptor(message.descriptor);
        }
        catch (error) {
            beginFailure(moduleError('E_WORKER_PROTOCOL', 'MCP registration descriptor is malformed', { cause: error }));
            return;
        }
        const allowed = mcpPolicy.tools.get(mcpToolKey(descriptor));
        let reason;
        if (!mcpPolicy.enabled)
            reason = 'MCP registration is disabled for this worker';
        else if (!allowed || !sameMcpToolDescriptor(allowed, descriptor)) {
            reason = 'MCP registration is not declared by host policy';
        }
        else if ([...mcpRegistrations.values()].filter(value => value.state != 'rejected' && value.state != 'removed').length >= mcpPolicy.maxTools) {
            reason = 'MCP registration exceeds the configured tool budget';
        }
        const registration = {
            registrationId: message.registrationId,
            descriptor: allowed ?? descriptor,
            state: reason ? 'rejected' : 'accepted',
            reason,
        };
        mcpRegistrations.set(registration.registrationId, registration);
        sendMcpRegistrationState(target, registration.registrationId, registration.state, reason);
        emitMcpRegistration(registration);
    }
    function handleMcpUnregister(message) {
        const target = worker;
        if (!target || (state != 'starting' && state != 'ready'))
            return;
        if (!Number.isSafeInteger(message.registrationId) || message.registrationId <= 0) {
            beginFailure(moduleError('E_WORKER_PROTOCOL', 'MCP unregister id is invalid'));
            return;
        }
        const registration = mcpRegistrations.get(message.registrationId);
        if (!registration || registration.state == 'removed') {
            sendMcpRegistrationState(target, message.registrationId, 'removed');
            return;
        }
        registration.state = 'removed';
        registration.reason = undefined;
        sendMcpRegistrationState(target, registration.registrationId, 'removed');
        emitMcpRegistration(registration);
    }
    function setMcpPublished(registrationId, attached, reason) {
        const target = worker;
        const registration = mcpRegistrations.get(registrationId);
        if (!target || !registration || registration.state == 'rejected' || registration.state == 'removed') {
            return false;
        }
        registration.state = attached ? 'attached' : 'detached';
        registration.reason = reason;
        sendMcpRegistrationState(target, registrationId, registration.state, reason);
        emitMcpRegistration(registration);
        return true;
    }
    function beginFailure(error) {
        if (terminalFailure || state == 'closed')
            return;
        terminalFailure = error;
        clearSessionTimers();
        setState('failed', error.message);
        emitEvent({ type: 'error', error, at: Date.now() });
        settleStart(error);
        rejectPending(error);
        void terminateWorker(true, error.message);
    }
    async function terminateWorker(keepFailure = false, reason = 'session terminated') {
        if (terminatePromise)
            return terminatePromise;
        if (state == 'closed')
            return;
        if (!keepFailure && state != 'failed')
            setState('terminating', reason);
        clearSessionTimers();
        const closedError = terminalFailure ?? moduleError('E_SESSION_CLOSED', reason);
        settleStart(closedError);
        rejectPending(closedError);
        const ownedWorker = worker;
        worker = null;
        terminatePromise = (async function finishTermination() {
            if (ownedWorker) {
                try {
                    await ownedWorker.terminate();
                }
                catch (error) {
                    if (!terminalFailure) {
                        terminalFailure = moduleError('E_WORKER_EXIT', 'worker termination failed', { cause: error });
                        emitEvent({ type: 'error', error: terminalFailure, at: Date.now() });
                    }
                }
            }
            closedAt = Date.now();
            if (!keepFailure && state != 'failed')
                setState('closed', reason);
            for (const registration of mcpRegistrations.values()) {
                if (registration.state == 'accepted'
                    || registration.state == 'attached'
                    || registration.state == 'detached') {
                    registration.state = 'removed';
                    registration.reason = reason;
                    emitMcpRegistration(registration);
                }
            }
            eventLine.close();
        })();
        return terminatePromise;
    }
    function verifyHandshake(message) {
        const received = message.metadata;
        return received.moduleId == metadata.moduleId
            && received.version == metadata.version
            && received.contentHash == metadata.contentHash
            && received.candidateId == metadata.candidateId
            && received.bindingGeneration == metadata.bindingGeneration;
    }
    function handleMessage(value) {
        if (!value || typeof value != 'object') {
            beginFailure(moduleError('E_WORKER_PROTOCOL', 'worker sent a non-object message'));
            return;
        }
        const message = value;
        if (message.protocol != MODULE_WORKER_PROTOCOL) {
            beginFailure(moduleError('E_WORKER_PROTOCOL', 'worker protocol mismatch'));
            return;
        }
        if (message.type == 'ready') {
            if (state != 'starting'
                || !verifyHandshake(message)
                || message.mcpRegistrationCount != mcpRegistrations.size) {
                beginFailure(moduleError('E_WORKER_PROTOCOL', 'worker handshake metadata mismatch'));
                return;
            }
            if (startupTimer)
                clearTimeout(startupTimer);
            startupTimer = null;
            startedAt = Date.now();
            lastHeartbeatAt = startedAt;
            methods = [...message.methods];
            setState('ready');
            settleStart();
            startHeartbeat();
            return;
        }
        if (message.type == 'pong') {
            if (state != 'ready' || message.nonce != lastPingNonce)
                return;
            lastHeartbeatAt = Date.now();
            emitEvent({ type: 'heartbeat', at: lastHeartbeatAt });
            return;
        }
        if (message.type == 'fatal') {
            const code = state == 'starting' ? 'E_WORKER_START' : 'E_WORKER_EXIT';
            beginFailure(moduleError(code, message.error.message ?? 'module worker failed', {
                remoteStack: message.error.stack,
            }));
            return;
        }
        if (message.type == 'dependency-call') {
            void handleDependencyCall(message);
            return;
        }
        if (message.type == 'mcp-register') {
            handleMcpRegister(message);
            return;
        }
        if (message.type == 'mcp-unregister') {
            handleMcpUnregister(message);
            return;
        }
        if (message.type != 'result') {
            beginFailure(moduleError('E_WORKER_PROTOCOL', 'worker sent an unknown message'));
            return;
        }
        const call = pending.get(message.callId);
        if (!call)
            return;
        if (!message.ok) {
            settleCall(message.callId, remoteError(message.error, call.correlationId));
            return;
        }
        let outputBytes;
        try {
            outputBytes = (0, node_v8_1.serialize)(message.value).byteLength;
        }
        catch (error) {
            beginFailure(moduleError('E_WORKER_PROTOCOL', 'worker output is not serializable', { cause: error }));
            return;
        }
        if (outputBytes > maxOutputBytes) {
            beginFailure(moduleError('E_OUTPUT_LIMIT', 'worker output exceeds the configured byte budget', {
                correlationId: call.correlationId,
            }));
            return;
        }
        settleCall(message.callId, undefined, message.value);
    }
    function dependencyFailure(message, cause) {
        const value = cause && typeof cause == 'object' ? cause : null;
        return {
            name: typeof value?.name == 'string' ? value.name : 'Error',
            message,
            stack: typeof value?.stack == 'string' ? value.stack : undefined,
            code: 'E_DEPENDENCY_UNAVAILABLE',
        };
    }
    function sendDependencyResult(target, message, correlationId) {
        postWorkerMessage(target, message, 'could not return dependency result', correlationId);
    }
    async function handleDependencyCall(message) {
        const ownedWorker = worker;
        const parent = pending.get(message.parentCallId);
        if (!ownedWorker || state != 'ready' || !parent)
            return;
        const activeWorker = ownedWorker;
        const activeParent = parent;
        if (message.correlationId != activeParent.correlationId
            || message.bindingGeneration != activeParent.bindingGeneration
            || !Number.isSafeInteger(message.dependencyCallId)
            || message.dependencyCallId <= 0
            || !message.moduleId
            || !message.method) {
            beginFailure(moduleError('E_WORKER_PROTOCOL', 'dependency call metadata mismatch', {
                correlationId: activeParent.correlationId,
            }));
            return;
        }
        function sendUnavailable(reason, cause) {
            sendDependencyResult(activeWorker, {
                protocol: MODULE_WORKER_PROTOCOL,
                type: 'dependency-result',
                dependencyCallId: message.dependencyCallId,
                ok: false,
                error: dependencyFailure(reason, cause),
            }, activeParent.correlationId);
        }
        const dependency = allowedDependencies.get(message.moduleId);
        if (!dependency) {
            sendUnavailable('dependency is not declared: ' + message.moduleId);
            return;
        }
        if (!deps.dependencyCall) {
            sendUnavailable('dependency broker is unavailable: ' + message.moduleId);
            return;
        }
        let inputBytes;
        try {
            inputBytes = (0, node_v8_1.serialize)(message.input).byteLength;
        }
        catch (error) {
            sendDependencyResult(activeWorker, {
                protocol: MODULE_WORKER_PROTOCOL,
                type: 'dependency-result',
                dependencyCallId: message.dependencyCallId,
                ok: false,
                error: {
                    name: 'Error',
                    message: 'dependency input is not serializable',
                    code: 'E_INPUT_LIMIT',
                },
            }, activeParent.correlationId);
            return;
        }
        if (inputBytes > maxInputBytes) {
            sendDependencyResult(activeWorker, {
                protocol: MODULE_WORKER_PROTOCOL,
                type: 'dependency-result',
                dependencyCallId: message.dependencyCallId,
                ok: false,
                error: {
                    name: 'Error',
                    message: 'dependency input exceeds the configured byte budget',
                    code: 'E_INPUT_LIMIT',
                },
            }, activeParent.correlationId);
            return;
        }
        let value;
        try {
            value = await deps.dependencyCall({
                moduleId: message.moduleId,
                method: message.method,
                input: message.input,
                correlationId: message.correlationId,
                bindingGeneration: message.bindingGeneration,
                dependency,
                callerModuleId: metadata.moduleId,
                callerVersion: metadata.version,
                callerContentHash: metadata.contentHash,
            });
        }
        catch (error) {
            if (worker != activeWorker || state != 'ready' || !pending.has(message.parentCallId))
                return;
            sendUnavailable('dependency call failed: ' + message.moduleId + '.' + message.method, error);
            return;
        }
        if (worker != activeWorker || state != 'ready' || !pending.has(message.parentCallId))
            return;
        let outputBytes;
        try {
            outputBytes = (0, node_v8_1.serialize)(value).byteLength;
        }
        catch {
            sendDependencyResult(activeWorker, {
                protocol: MODULE_WORKER_PROTOCOL,
                type: 'dependency-result',
                dependencyCallId: message.dependencyCallId,
                ok: false,
                error: {
                    name: 'Error',
                    message: 'dependency output is not serializable',
                    code: 'E_OUTPUT_LIMIT',
                },
            }, activeParent.correlationId);
            return;
        }
        if (outputBytes > maxOutputBytes) {
            sendDependencyResult(activeWorker, {
                protocol: MODULE_WORKER_PROTOCOL,
                type: 'dependency-result',
                dependencyCallId: message.dependencyCallId,
                ok: false,
                error: {
                    name: 'Error',
                    message: 'dependency output exceeds the configured byte budget',
                    code: 'E_OUTPUT_LIMIT',
                },
            }, activeParent.correlationId);
            return;
        }
        sendDependencyResult(activeWorker, {
            protocol: MODULE_WORKER_PROTOCOL,
            type: 'dependency-result',
            dependencyCallId: message.dependencyCallId,
            ok: true,
            value,
        }, activeParent.correlationId);
    }
    function handleWorkerError(error) {
        beginFailure(moduleError('E_WORKER_EXIT', 'module worker emitted an error', { cause: error }));
    }
    function handleWorkerExit(code) {
        if (terminatePromise || state == 'closed' || state == 'failed')
            return;
        beginFailure(moduleError('E_WORKER_EXIT', 'module worker exited unexpectedly with code ' + code));
    }
    function postWorkerMessage(target, message, failureMessage, correlationId) {
        try {
            target.postMessage(message);
            return true;
        }
        catch (error) {
            beginFailure(moduleError('E_WORKER_EXIT', failureMessage, { cause: error, correlationId }));
            return false;
        }
    }
    function postCancellation(target, callId, reason) {
        try {
            target.postMessage({ protocol: MODULE_WORKER_PROTOCOL, type: 'cancel', callId, reason });
        }
        catch {
        }
    }
    function startHeartbeat() {
        heartbeatTimer = setInterval(function heartbeatTick() {
            if (state != 'ready' || !worker)
                return;
            const now = Date.now();
            if (lastHeartbeatAt == null || now - lastHeartbeatAt > heartbeatTimeoutMs) {
                beginFailure(moduleError('E_HEARTBEAT_TIMEOUT', 'module worker heartbeat timed out'));
                return;
            }
            lastPingNonce++;
            postWorkerMessage(worker, { protocol: MODULE_WORKER_PROTOCOL, type: 'ping', nonce: lastPingNonce }, 'could not send worker heartbeat');
        }, heartbeatIntervalMs);
        heartbeatTimer.unref?.();
    }
    function start() {
        if (state == 'ready')
            return Promise.resolve();
        if (state == 'starting' && startPromise)
            return startPromise;
        if (state != 'idle') {
            return Promise.reject(moduleError('E_SESSION_STATE', 'cannot start module worker from state ' + state));
        }
        setState('starting');
        startPromise = new Promise(function captureStart(resolve, reject) {
            resolveStart = resolve;
            rejectStart = reject;
        });
        try {
            worker = new node_worker_threads_1.Worker(module_worker_bootstrap_1.moduleWorkerBootstrapSource, {
                eval: true,
                resourceLimits: {
                    maxOldGenerationSizeMb: memoryMb,
                },
                workerData: {
                    source: deps.verified.source,
                    metadata,
                    limits: { maxConcurrentCalls, maxInputBytes, maxOutputBytes },
                    mcp: { enabled: mcpPolicy.enabled },
                },
            });
            worker.on('message', handleMessage);
            worker.on('error', handleWorkerError);
            worker.on('exit', handleWorkerExit);
            startupTimer = setTimeout(function failStartup() {
                beginFailure(moduleError('E_WORKER_START', 'module worker startup timed out'));
            }, startupTimeoutMs);
            startupTimer.unref?.();
        }
        catch (error) {
            beginFailure(moduleError('E_WORKER_START', 'could not create module worker', { cause: error }));
        }
        return startPromise;
    }
    function callTarget(kind, method, registrationId, input, opts) {
        if (state != 'ready' || !worker) {
            return Promise.reject(moduleError('E_SESSION_STATE', 'module worker is not ready', {
                correlationId: opts.correlationId,
            }));
        }
        if (!method || typeof method != 'string') {
            return Promise.reject(moduleError('E_METHOD_NOT_FOUND', 'module method must be a non-empty string', {
                correlationId: opts.correlationId,
            }));
        }
        if (kind == 'mcp') {
            const registration = registrationId == null ? null : mcpRegistrations.get(registrationId);
            if (!registration || (registration.state != 'accepted' && registration.state != 'attached')) {
                return Promise.reject(moduleError('E_MCP_TOOL_UNAVAILABLE', 'MCP tool registration is unavailable: ' + registrationId, { correlationId: opts.correlationId }));
            }
        }
        if (!opts.correlationId) {
            return Promise.reject(moduleError('E_MODULE_CALL', 'correlationId is required'));
        }
        const bindingGeneration = opts.bindingGeneration ?? metadata.bindingGeneration;
        if (!Number.isSafeInteger(bindingGeneration) || bindingGeneration < 0) {
            return Promise.reject(moduleError('E_MODULE_CALL', 'bindingGeneration must be a non-negative safe integer', {
                correlationId: opts.correlationId,
            }));
        }
        if (opts.signal?.aborted) {
            return Promise.reject(moduleError('E_CALL_ABORTED', 'module call was aborted before dispatch', {
                cause: opts.signal.reason,
                correlationId: opts.correlationId,
            }));
        }
        if (pending.size >= maxConcurrentCalls) {
            return Promise.reject(moduleError('E_CONCURRENCY_LIMIT', 'module worker concurrency budget exceeded', {
                correlationId: opts.correlationId,
            }));
        }
        let inputBytes;
        try {
            inputBytes = (0, node_v8_1.serialize)(input).byteLength;
        }
        catch (error) {
            return Promise.reject(moduleError('E_INPUT_LIMIT', 'module call input is not serializable', {
                cause: error,
                correlationId: opts.correlationId,
            }));
        }
        if (inputBytes > maxInputBytes) {
            return Promise.reject(moduleError('E_INPUT_LIMIT', 'module call input exceeds the configured byte budget', {
                correlationId: opts.correlationId,
            }));
        }
        const requestedTimeoutMs = positiveInteger(opts.timeoutMs, defaultCallTimeoutMs, 'timeoutMs');
        const timeoutMs = Math.min(requestedTimeoutMs, maxCallTimeoutMs);
        const callId = ++nextCallId;
        const ownedWorker = worker;
        return new Promise(function dispatchCall(resolve, reject) {
            function abortCall() {
                const error = moduleError('E_CALL_ABORTED', 'module call was aborted', {
                    cause: opts.signal?.reason,
                    correlationId: opts.correlationId,
                });
                postCancellation(ownedWorker, callId, 'caller aborted');
                beginFailure(error);
            }
            const timer = setTimeout(function timeoutCall() {
                const error = moduleError('E_CALL_TIMEOUT', 'module call timed out after ' + timeoutMs + 'ms', {
                    correlationId: opts.correlationId,
                });
                postCancellation(ownedWorker, callId, error.message);
                beginFailure(error);
            }, timeoutMs);
            timer.unref?.();
            opts.signal?.addEventListener('abort', abortCall, { once: true });
            pending.set(callId, {
                method,
                correlationId: opts.correlationId,
                bindingGeneration,
                resolve: resolve,
                reject,
                timer,
                removeAbort() { opts.signal?.removeEventListener('abort', abortCall); },
            });
            emitEvent({
                type: 'call',
                phase: 'started',
                callId,
                method,
                correlationId: opts.correlationId,
                bindingGeneration,
                at: Date.now(),
            });
            postWorkerMessage(ownedWorker, kind == 'mcp'
                ? {
                    protocol: MODULE_WORKER_PROTOCOL,
                    type: 'mcp-call',
                    callId,
                    registrationId,
                    method,
                    input,
                    correlationId: opts.correlationId,
                    bindingGeneration,
                }
                : {
                    protocol: MODULE_WORKER_PROTOCOL,
                    type: 'call',
                    callId,
                    method,
                    input,
                    correlationId: opts.correlationId,
                    bindingGeneration,
                }, 'could not dispatch module call', opts.correlationId);
        });
    }
    function call(method, input, opts) {
        return callTarget('module', method, null, input, opts);
    }
    function callMcp(registrationId, input, opts) {
        const registration = mcpRegistrations.get(registrationId);
        const descriptor = registration?.descriptor;
        const method = descriptor
            ? descriptor.contributionId + '.' + descriptor.toolId
            : 'mcp.' + registrationId;
        return callTarget('mcp', method, registrationId, input, opts);
    }
    return {
        control: {
            start,
            terminate: (reason) => terminateWorker(false, reason),
        },
        resource: {
            call,
        },
        events: {
            on: eventLine.on,
        },
        view: {
            snapshot,
        },
        health: {
            snapshot: healthSnapshot,
        },
        mcp: {
            control: {
                setPublished: setMcpPublished,
            },
            resource: {
                call: callMcp,
            },
            events: {
                on(cb) {
                    return eventLine.on(function onMcpEvent(event) {
                        if (event.type == 'mcp')
                            cb(event);
                    });
                },
            },
            view: {
                snapshot: mcpSnapshot,
            },
        },
    };
}
function positiveInteger(value, fallback, name) {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result <= 0)
        throw new Error(name + ' must be a positive safe integer');
    return result;
}
function dependencyAllowlist(values) {
    const result = new Map();
    for (const value of values ?? []) {
        if (typeof value?.moduleId != 'string' || !value.moduleId) {
            throw new Error('allowedDependencies must contain dependency descriptors');
        }
        if (result.has(value.moduleId))
            throw new Error('allowedDependencies contains duplicate moduleId ' + value.moduleId);
        result.set(value.moduleId, Object.freeze({
            ...value,
            capabilities: value.capabilities ? Object.freeze([...value.capabilities]) : undefined,
        }));
    }
    return result;
}
function mcpName(value, name) {
    if (typeof value != 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) {
        throw new Error(name + ' must contain only MCP-safe name characters');
    }
    return value;
}
function normalizeMcpAnnotations(value) {
    if (value == undefined)
        return undefined;
    if (!value || typeof value != 'object' || Array.isArray(value)) {
        throw new Error('MCP annotations must be an object');
    }
    const annotations = value;
    const readOnlyHint = annotations.readOnlyHint;
    const destructiveHint = annotations.destructiveHint;
    const idempotentHint = annotations.idempotentHint;
    if (typeof readOnlyHint != 'boolean'
        || typeof destructiveHint != 'boolean'
        || typeof idempotentHint != 'boolean') {
        throw new Error('MCP annotations must contain boolean readOnly/destructive/idempotent hints');
    }
    return Object.freeze({
        readOnlyHint,
        destructiveHint,
        idempotentHint,
    });
}
function normalizeMcpToolDescriptor(value) {
    if (!value || typeof value != 'object' || Array.isArray(value)) {
        throw new Error('MCP tool descriptor must be an object');
    }
    if (value.lifetime != 'host' && value.lifetime != 'generation' && value.lifetime != 'session') {
        throw new Error('MCP contribution lifetime is invalid');
    }
    if (value.title != undefined && typeof value.title != 'string')
        throw new Error('MCP title must be a string');
    if (value.description != undefined && typeof value.description != 'string') {
        throw new Error('MCP description must be a string');
    }
    return Object.freeze({
        contributionId: mcpName(value.contributionId, 'contributionId'),
        lifetime: value.lifetime,
        toolId: mcpName(value.toolId, 'toolId'),
        title: value.title,
        description: value.description,
        annotations: normalizeMcpAnnotations(value.annotations),
    });
}
function mcpToolKey(value) {
    return value.lifetime + ':' + value.contributionId + ':' + value.toolId;
}
function sameMcpToolDescriptor(a, b) {
    return a.contributionId == b.contributionId
        && a.lifetime == b.lifetime
        && a.toolId == b.toolId
        && a.title == b.title
        && a.description == b.description
        && a.annotations?.readOnlyHint == b.annotations?.readOnlyHint
        && a.annotations?.destructiveHint == b.annotations?.destructiveHint
        && a.annotations?.idempotentHint == b.annotations?.idempotentHint;
}
function copyMcpRegistration(value) {
    return {
        registrationId: value.registrationId,
        descriptor: {
            ...value.descriptor,
            annotations: value.descriptor.annotations ? { ...value.descriptor.annotations } : undefined,
        },
        state: value.state,
        reason: value.reason,
    };
}
function moduleMcpPolicy(value) {
    if (!value)
        return { enabled: false, maxTools: 0, tools: new Map() };
    if (!Array.isArray(value.contributions))
        throw new Error('mcpPolicy.contributions must be an array');
    const tools = new Map();
    for (const contribution of value.contributions) {
        if (!contribution || typeof contribution != 'object' || !Array.isArray(contribution.tools)) {
            throw new Error('mcpPolicy contribution must contain a tools array');
        }
        for (const tool of contribution.tools) {
            const descriptor = normalizeMcpToolDescriptor({
                ...tool,
                contributionId: contribution.contributionId,
                lifetime: contribution.lifetime,
            });
            const key = mcpToolKey(descriptor);
            if (tools.has(key))
                throw new Error('mcpPolicy contains duplicate tool ' + key);
            tools.set(key, descriptor);
        }
    }
    const maxTools = value.maxTools ?? tools.size;
    if (!Number.isSafeInteger(maxTools) || maxTools < 0) {
        throw new Error('mcpPolicy.maxTools must be a non-negative safe integer');
    }
    return { enabled: true, maxTools, tools };
}
function verifiedMetadata(verified, candidateId, bindingGeneration, maxSourceBytes) {
    const fallback = {
        moduleId: verified?.moduleId ?? 'unknown',
        version: verified?.version ?? 'unknown',
        contentHash: verified?.contentHash ?? 'sha256:unknown',
        candidateId,
        bindingGeneration,
    };
    if (!verified
        || verified.verification != exports.MODULE_WORKER_VERIFIED_SOURCE
        || !verified.moduleId
        || !verified.version
        || !verified.contentHash.startsWith('sha256:')
        || !verified.source
        || !candidateId
        || !Number.isSafeInteger(bindingGeneration)
        || bindingGeneration < 0) {
        throw new ModuleWorkerError('E_INVALID_VERIFIED_SOURCE', 'module worker requires structurally branded verified source and generation metadata', fallback);
    }
    if (Buffer.byteLength(verified.source, 'utf8') > maxSourceBytes) {
        throw new ModuleWorkerError('E_SOURCE_LIMIT', 'verified module source exceeds the configured byte budget', fallback);
    }
    return fallback;
}
