"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamicModuleHostError = void 0;
exports.createDynamicModuleHost = createDynamicModuleHost;
const contract_runtime_1 = require("../../Common/contract/contract-runtime");
const Listen_1 = require("../../Common/events/Listen");
class DynamicModuleHostError extends Error {
    code;
    constructor(code, message, options = {}) {
        super(message, options.cause != undefined ? { cause: options.cause } : undefined);
        this.name = 'DynamicModuleHostError';
        this.code = code;
    }
}
exports.DynamicModuleHostError = DynamicModuleHostError;
function errorText(error) {
    if (typeof error?.message == 'string')
        return error.message;
    return String(error);
}
function copyCandidate(candidate) {
    return { ...candidate };
}
function healthy(value) {
    return typeof value == 'object' && value != null && value.ok == true;
}
function reportDynamicModuleObserverError(error) {
    setTimeout(function rethrowDynamicModuleObserverError() { throw error; }, 0);
}
function createDynamicModuleHost(deps) {
    const now = deps.now ?? Date.now;
    const auditLimit = Math.max(1, deps.auditLimit ?? 500);
    const dependencyCallTimeoutMs = Math.max(1, deps.dependencyCallTimeoutMs ?? 5_000);
    const ownsRuntime = deps.runtime == undefined;
    const runtime = deps.runtime ?? (0, contract_runtime_1.createContractRuntime)({ drainTimeoutMs: deps.drainTimeoutMs });
    const candidates = new Map();
    const sessions = new Set();
    const audit = [];
    const [emitEvent, events] = (0, Listen_1.listen)({
        [Listen_1.LISTEN_DISPATCH_ERROR]: reportDynamicModuleObserverError,
    });
    let nextCandidateId = 0;
    let nextCorrelationId = 0;
    let closed = false;
    let closePromise = null;
    let controlChain = Promise.resolve();
    const makeCandidateId = deps.candidateId
        ?? function defaultCandidateId() { return 'candidate-' + (++nextCandidateId); };
    const makeCorrelationId = deps.correlationId
        ?? function defaultCorrelationId() { return 'module-call-' + (++nextCorrelationId); };
    function serialized(run) {
        const task = controlChain.then(run, run);
        controlChain = task.catch(function swallowDynamicModuleControlError() { });
        return task;
    }
    function requireOpen() {
        if (closed)
            throw new DynamicModuleHostError('E_HOST_CLOSED', 'dynamic module host is closed');
    }
    function appendAudit(event) {
        const saved = { at: now(), ...event };
        audit.push(saved);
        if (audit.length > auditLimit)
            audit.splice(0, audit.length - auditLimit);
        emitEvent({ type: 'audit', audit: { ...saved } });
    }
    function publishCandidate(record) {
        record.snapshot.updatedAt = now();
        emitEvent({ type: 'candidate', candidate: copyCandidate(record.snapshot) });
    }
    function transition(record, state, error = null) {
        record.snapshot.state = state;
        record.snapshot.error = error == null ? null : errorText(error);
        publishCandidate(record);
    }
    function candidateFacts(record) {
        const snapshot = record.snapshot;
        return {
            candidateId: snapshot.candidateId,
            slotId: snapshot.slotId,
            ...(snapshot.offerId ? { offerId: snapshot.offerId } : {}),
            ...(snapshot.moduleId ? { moduleId: snapshot.moduleId } : {}),
            ...(snapshot.version ? { version: snapshot.version } : {}),
            ...(snapshot.contentHash ? { contentHash: snapshot.contentHash } : {}),
        };
    }
    async function terminate(session, reason) {
        if (!session)
            return;
        try {
            await session.control.terminate(reason);
        }
        catch { }
        finally {
            sessions.delete(session);
        }
    }
    function dependencyFailure(dependency, code) {
        return {
            ok: false,
            code,
            moduleId: dependency.moduleId,
            retryable: true,
        };
    }
    function dependencyBinding(dependency, owner) {
        const slotId = deps.dependencySlot?.(dependency, owner) ?? dependency.moduleId;
        const binding = runtime.api.binding(slotId);
        if (!binding)
            return { slotId, binding: null, reason: 'dependency slot is unavailable' };
        if (binding.descriptor.implementationId != dependency.moduleId) {
            return { slotId, binding: null, reason: 'dependency implementationId is incompatible' };
        }
        const compatible = deps.dependencyCompatible
            ? deps.dependencyCompatible(dependency.apiRange, binding.descriptor.contractVersion)
            : dependency.apiRange == binding.descriptor.contractVersion;
        if (!compatible)
            return { slotId, binding: null, reason: 'dependency API version is incompatible' };
        const capabilities = new Set(binding.descriptor.capabilities ?? []);
        const missing = (dependency.capabilities ?? []).find(capability => !capabilities.has(capability));
        if (missing)
            return { slotId, binding: null, reason: 'dependency capability is missing: ' + missing };
        return { slotId, binding, reason: null };
    }
    function assertRequiredDependencies(artifact) {
        for (const dependency of artifact.manifest.dependencies) {
            if (!dependency.required)
                continue;
            const resolved = dependencyBinding(dependency, artifact.manifest);
            if (!resolved.binding) {
                throw new DynamicModuleHostError('E_REQUIRED_DEPENDENCY', dependency.moduleId + ': ' + resolved.reason);
            }
        }
    }
    async function runWarmup(record, session, publishLifecycle) {
        const manifest = record.artifact.manifest;
        const method = manifest.health.warmupHook;
        if (!method)
            return;
        if (publishLifecycle)
            transition(record, 'warming');
        await session.resource.call(method, { phase: 'candidate' }, {
            correlationId: record.snapshot.candidateId + ':warmup',
            bindingGeneration: 0,
            timeoutMs: manifest.budget.warmupTimeoutMs,
        });
    }
    async function runHealth(record, session, phase, publishLifecycle) {
        const manifest = record.artifact.manifest;
        if (publishLifecycle)
            transition(record, 'health-checking');
        const result = await session.resource.call(manifest.health.checkHook, { phase }, {
            correlationId: record.snapshot.candidateId + ':health:' + phase,
            bindingGeneration: 0,
            timeoutMs: manifest.health.timeoutMs,
        });
        if (!healthy(result)) {
            throw new DynamicModuleHostError('E_HEALTH_REJECTED', 'candidate health check did not return {ok: true}');
        }
    }
    async function openIsolated(record, reuseStaged) {
        requireOpen();
        assertRequiredDependencies(record.artifact);
        if (reuseStaged && record.session && !record.claimed) {
            const staged = record.session;
            try {
                await runHealth(record, staged, 'activation', false);
                requireOpen();
                record.claimed = true;
                return staged;
            }
            catch (error) {
                await terminate(staged, 'candidate activation health failed');
                if (record.session == staged)
                    record.session = null;
                throw error;
            }
        }
        const artifact = record.artifact;
        if (!artifact)
            throw new DynamicModuleHostError('E_CANDIDATE_STATE', 'candidate has no verified artifact');
        const isolated = await deps.isolation.resource.open({
            artifact,
            candidateId: record.snapshot.candidateId + ':open:' + (++record.openGeneration),
            candidateGeneration: 0,
        });
        sessions.add(isolated);
        try {
            requireOpen();
            await isolated.control.start();
            requireOpen();
            await runWarmup(record, isolated, false);
            requireOpen();
            await runHealth(record, isolated, 'open', false);
            requireOpen();
            return isolated;
        }
        catch (error) {
            await terminate(isolated, 'candidate open failed');
            throw error;
        }
    }
    function wrapContractSession(record, isolated) {
        const [emitFail, failEvents] = (0, Listen_1.listen)();
        let done = false;
        let hasTerminalFailure = false;
        let terminalFailure;
        function fail(reason) {
            if (hasTerminalFailure)
                return;
            hasTerminalFailure = true;
            terminalFailure = reason;
            emitFail(reason);
        }
        const onFail = {
            on(cb) {
                const off = failEvents.on(cb);
                if (hasTerminalFailure)
                    cb(terminalFailure);
                return off;
            },
        };
        const offEvents = isolated.events.on(function isolatedSessionEvent(event) {
            if (event.type == 'state' && event.state == 'failed') {
                fail(event.reason ?? new Error('isolated module session failed'));
            }
            else if (event.type == 'state' && event.state == 'closed')
                sessions.delete(isolated);
            else if (event.type == 'error')
                fail(event.error);
        });
        const initial = isolated.view.snapshot();
        if (initial.state == 'failed' || initial.failure) {
            fail(initial.failure ?? new Error('isolated module session failed before handoff'));
        }
        async function drain(reason) {
            await terminate(isolated, 'contract session drained: ' + errorText(reason ?? 'retired'));
        }
        function close() {
            if (done)
                return;
            done = true;
            offEvents();
            failEvents.close();
            void terminate(isolated, 'contract session closed');
            if (record.session == isolated)
                record.session = null;
        }
        return {
            isolated,
            api: {
                call(method, input, opts) {
                    return isolated.resource.call(method, input, opts);
                },
            },
            onFail,
            drain,
            close,
        };
    }
    function contractOffer(record) {
        const artifact = record.artifact;
        return {
            id: record.snapshot.offerId,
            priority: record.snapshot.priority,
            descriptor: {
                protocol: 1,
                contractId: artifact.manifest.compatibility.api.contractId,
                contractVersion: artifact.manifest.compatibility.api.version,
                implementationId: artifact.manifest.moduleId,
                implementationVersion: artifact.manifest.version,
                runtimeVersion: artifact.manifest.compatibility.runtime?.range,
                integrity: artifact.manifest.contentHash,
                capabilities: [...artifact.manifest.capabilities],
                proof: {
                    manifestHash: artifact.descriptor.manifestHash,
                    publisherKeyId: artifact.descriptor.publisherKeyId,
                },
            },
            async open(context) {
                if (context.demand.slotId != record.snapshot.slotId) {
                    const error = new DynamicModuleHostError('E_SLOT_MISMATCH', 'candidate is scoped to slot ' + record.snapshot.slotId);
                    Object.assign(error, { contractRejected: true });
                    throw error;
                }
                const isolated = await openIsolated(record, true);
                record.session = isolated;
                return wrapContractSession(record, isolated);
            },
        };
    }
    async function stage(request) {
        requireOpen();
        if (!request.slotId?.trim())
            throw new DynamicModuleHostError('E_STAGE_INPUT', 'slotId is required');
        const candidateId = request.candidateId ?? makeCandidateId();
        if (!candidateId.trim())
            throw new DynamicModuleHostError('E_STAGE_INPUT', 'candidateId is required');
        if (candidates.has(candidateId)) {
            throw new DynamicModuleHostError('E_DUPLICATE_CANDIDATE', 'candidate already exists: ' + candidateId);
        }
        const createdAt = now();
        const record = {
            snapshot: {
                candidateId,
                slotId: request.slotId,
                offerId: null,
                moduleId: null,
                version: null,
                contentHash: null,
                state: 'verifying',
                priority: request.priority ?? 0,
                createdAt,
                updatedAt: createdAt,
                error: null,
            },
            artifact: null,
            session: null,
            claimed: false,
            openGeneration: 0,
            offer: null,
        };
        candidates.set(candidateId, record);
        publishCandidate(record);
        appendAudit({ action: 'candidate requested', candidateId, slotId: request.slotId });
        try {
            const artifact = await deps.verifier.control.verify({
                manifest: request.manifest,
                bytes: request.bytes,
            });
            requireOpen();
            record.artifact = artifact;
            record.snapshot.moduleId = artifact.manifest.moduleId;
            record.snapshot.version = artifact.manifest.version;
            record.snapshot.contentHash = artifact.manifest.contentHash;
            record.snapshot.offerId = artifact.manifest.moduleId + '@' + artifact.manifest.contentHash;
            const duplicate = [...candidates.values()].find(other => other != record
                && other.snapshot.offerId == record.snapshot.offerId
                && other.snapshot.state != 'closed'
                && other.snapshot.state != 'rejected');
            if (duplicate) {
                throw new DynamicModuleHostError('E_DUPLICATE_ARTIFACT', 'artifact is already staged as ' + duplicate.snapshot.candidateId);
            }
            appendAudit({ action: 'candidate verified', ...candidateFacts(record) });
            assertRequiredDependencies(artifact);
            transition(record, 'instantiating');
            const isolated = await deps.isolation.resource.open({
                artifact,
                candidateId,
                candidateGeneration: 0,
            });
            sessions.add(isolated);
            record.session = isolated;
            requireOpen();
            await isolated.control.start();
            requireOpen();
            appendAudit({ action: 'candidate instantiated', ...candidateFacts(record) });
            await runWarmup(record, isolated, true);
            requireOpen();
            await runHealth(record, isolated, 'stage', true);
            requireOpen();
            transition(record, 'ready');
            appendAudit({ action: 'candidate ready', ...candidateFacts(record) });
            return copyCandidate(record.snapshot);
        }
        catch (error) {
            if (!record.claimed)
                await terminate(record.session, 'candidate rejected');
            record.session = null;
            transition(record, closed ? 'closed' : 'rejected', error);
            appendAudit({
                action: closed ? 'candidate closed' : 'candidate rejected',
                ...candidateFacts(record),
                error: errorText(error),
            });
            throw error;
        }
    }
    async function activate(candidateId) {
        requireOpen();
        const record = candidates.get(candidateId);
        if (!record || record.snapshot.state != 'ready' || !record.artifact || !record.session) {
            throw new DynamicModuleHostError('E_CANDIDATE_STATE', 'candidate is not ready: ' + candidateId);
        }
        transition(record, 'activating');
        appendAudit({ action: 'activation requested', ...candidateFacts(record) });
        try {
            assertRequiredDependencies(record.artifact);
            record.offer = contractOffer(record);
            await runtime.control.addOffer(record.offer);
            requireOpen();
            const binding = runtime.api.binding(record.snapshot.slotId);
            if (binding?.offerId != record.offer.id) {
                await runtime.control.removeOffer(record.offer.id);
                record.offer = null;
                throw new DynamicModuleHostError('E_NOT_SELECTED', 'candidate was compatible but was not selected');
            }
            transition(record, 'active');
            appendAudit({
                action: 'activated',
                ...candidateFacts(record),
                bindingGeneration: binding.bindingGeneration,
            });
            return binding;
        }
        catch (error) {
            const retryable = error instanceof DynamicModuleHostError
                && error.code == 'E_NOT_SELECTED'
                && record.session != null
                && !record.claimed;
            if (record.offer && runtime.api.binding(record.snapshot.slotId)?.offerId != record.offer.id) {
                try {
                    await runtime.control.removeOffer(record.offer.id);
                }
                catch { }
                record.offer = null;
            }
            transition(record, closed ? 'closed' : retryable ? 'ready' : 'rejected', error);
            appendAudit({ action: 'activation failed', ...candidateFacts(record), error: errorText(error) });
            throw error;
        }
    }
    async function rollback(slotId) {
        appendAudit({ action: 'rollback requested', slotId });
        try {
            const binding = await runtime.control.rollback(slotId);
            appendAudit({
                action: 'rolled back',
                slotId,
                offerId: binding.offerId,
                moduleId: binding.descriptor.implementationId,
                version: binding.descriptor.implementationVersion,
                contentHash: binding.descriptor.integrity,
                bindingGeneration: binding.bindingGeneration,
            });
            return binding;
        }
        catch (error) {
            appendAudit({ action: 'rollback failed', slotId, error: errorText(error) });
            throw error;
        }
    }
    async function revoke(candidateId, reason = 'revoked') {
        const record = candidates.get(candidateId);
        if (!record?.snapshot.offerId)
            return false;
        await runtime.control.revokeOffer(record.snapshot.offerId, reason);
        appendAudit({ action: 'revoked', ...candidateFacts(record), error: reason });
        return true;
    }
    async function discard(candidateId, reason = 'discarded') {
        const record = candidates.get(candidateId);
        if (!record)
            return false;
        if (runtime.api.binding(record.snapshot.slotId)?.offerId == record.snapshot.offerId) {
            throw new DynamicModuleHostError('E_CANDIDATE_ACTIVE', 'cannot discard the active candidate');
        }
        if (record.offer)
            await runtime.control.removeOffer(record.offer.id);
        if (!record.claimed) {
            await terminate(record.session, reason);
            record.session = null;
        }
        transition(record, 'closed');
        appendAudit({ action: 'candidate discarded', ...candidateFacts(record), error: reason });
        return true;
    }
    function handle(slotId) {
        return {
            call(method, input, opts = {}) {
                if (closed)
                    return Promise.reject(new DynamicModuleHostError('E_HOST_CLOSED', 'dynamic module host is closed'));
                let lease;
                try {
                    lease = runtime.api.acquire(slotId);
                }
                catch (error) {
                    return Promise.reject(new DynamicModuleHostError('E_UNAVAILABLE', 'module slot is unavailable: ' + slotId, {
                        cause: error,
                    }));
                }
                const correlationId = opts.correlationId ?? makeCorrelationId();
                let call;
                try {
                    call = Promise.resolve(lease.api.call(method, input, {
                        correlationId,
                        bindingGeneration: lease.binding.bindingGeneration,
                        timeoutMs: opts.timeoutMs,
                        signal: opts.signal,
                    }));
                }
                catch (error) {
                    lease.release();
                    return Promise.reject(error);
                }
                return call.finally(function releaseModuleLease() { lease.release(); });
            },
            view: {
                binding: () => runtime.api.binding(slotId),
            },
        };
    }
    async function callDependency(request) {
        if (request.bindingGeneration == 0) {
            throw new DynamicModuleHostError('E_CANDIDATE_DEPENDENCY', 'candidate warmup and health checks cannot call live dependencies');
        }
        if (request.moduleId != request.dependency.moduleId) {
            throw new DynamicModuleHostError('E_DEPENDENCY_POLICY', 'dependency request does not match its declaration');
        }
        const owner = [...candidates.values()].find(record => record.snapshot.moduleId == request.callerModuleId
            && record.snapshot.version == request.callerVersion
            && record.snapshot.contentHash == request.callerContentHash
            && record.snapshot.offerId == runtime.api.binding(record.snapshot.slotId)?.offerId);
        if (!owner?.artifact) {
            throw new DynamicModuleHostError('E_DEPENDENCY_OWNER', 'active dependency caller could not be identified');
        }
        const dependency = owner.artifact.manifest.dependencies.find(item => item.moduleId == request.moduleId);
        if (!dependency
            || dependency.apiRange != request.dependency.apiRange
            || dependency.required != request.dependency.required) {
            throw new DynamicModuleHostError('E_DEPENDENCY_POLICY', 'dependency declaration does not match verified manifest');
        }
        const resolved = dependencyBinding(dependency, owner.artifact.manifest);
        if (!resolved.binding) {
            if (!dependency.required && dependency.degradation == 'unavailable-result') {
                return dependencyFailure(dependency, 'E_UNAVAILABLE');
            }
            throw new DynamicModuleHostError('E_UNAVAILABLE', dependency.moduleId + ': ' + resolved.reason);
        }
        try {
            return await handle(resolved.slotId).call(request.method, request.input, {
                correlationId: request.correlationId + ':dependency:' + request.moduleId,
                timeoutMs: dependencyCallTimeoutMs,
            });
        }
        catch (error) {
            if (!dependency.required && dependency.degradation == 'unavailable-result') {
                return dependencyFailure(dependency, 'E_DEGRADED');
            }
            throw error;
        }
    }
    const offBinding = runtime.api.changed.on(function bindingChanged(binding) {
        for (const record of candidates.values()) {
            if (record.snapshot.state == 'closed')
                continue;
            if (binding.from?.offerId == record.snapshot.offerId && binding.to?.offerId != record.snapshot.offerId) {
                transition(record, 'retired');
            }
            if (binding.to?.offerId == record.snapshot.offerId)
                transition(record, 'active');
        }
        emitEvent({ type: 'binding', binding });
    });
    return {
        control: {
            require: (demand) => serialized(() => runtime.control.require(demand)),
            stage: (request) => serialized(() => stage(request)),
            activate: (candidateId) => serialized(() => activate(candidateId)),
            rollback: (slotId) => serialized(() => rollback(slotId)),
            revoke: (candidateId, reason) => serialized(() => revoke(candidateId, reason)),
            discard: (candidateId, reason) => serialized(() => discard(candidateId, reason)),
        },
        resource: {
            handle,
            dependencyCall: callDependency,
        },
        events: {
            on: events.on,
        },
        view: {
            snapshot() {
                return {
                    closed,
                    candidates: Object.fromEntries([...candidates].map(([id, record]) => [id, copyCandidate(record.snapshot)])),
                    contracts: runtime.api.status.snapshot(),
                };
            },
            candidate: (candidateId) => {
                const record = candidates.get(candidateId);
                return record ? copyCandidate(record.snapshot) : null;
            },
            binding: (slotId) => runtime.api.binding(slotId),
            explain: (slotId) => runtime.api.explain(slotId),
            audit: () => audit.map(event => ({ ...event })),
        },
        health: {
            snapshot() {
                return Object.fromEntries([...candidates].map(([id, record]) => [
                    id,
                    record.session?.health.snapshot() ?? { health: record.snapshot.state == 'active' ? 'unknown' : 'closed', inFlight: 0 },
                ]));
            },
        },
        close() {
            if (closePromise)
                return closePromise;
            closed = true;
            closePromise = (async function closeDynamicModuleHost() {
                await controlChain;
                offBinding();
                if (ownsRuntime)
                    runtime.close();
                else {
                    for (const record of candidates.values()) {
                        if (record.offer) {
                            try {
                                await runtime.control.removeOffer(record.offer.id);
                            }
                            catch { }
                        }
                    }
                }
                await Promise.all([...sessions].map(session => terminate(session, 'dynamic module host closed')));
                for (const record of candidates.values()) {
                    record.session = null;
                    transition(record, 'closed');
                }
                events.close();
            })();
            return closePromise;
        },
    };
}
