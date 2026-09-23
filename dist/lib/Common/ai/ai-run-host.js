"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAiRunHost = createAiRunHost;
const store_1 = require("../Observe/store");
const command_receipts_1 = require("../command/command-receipts");
const store_replay_1 = require("../Observe/store-replay");
const store_projection_1 = require("../Observe/store-projection");
const Listen_1 = require("../events/Listen");
const replay_wire_1 = require("../events/replay-wire");
const replay_listen_1 = require("../events/replay-listen");
const deep_equal_1 = require("../core/deep-equal");
const ai_run_persistence_1 = require("./ai-run-persistence");
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
function clampProgress(value) {
    return Math.max(0, Math.min(1, value));
}
function copyUsage(usage) {
    return usage ? { ...usage } : undefined;
}
function copyArtifact(artifact) {
    return {
        ...artifact,
        ...(artifact.descriptor !== undefined ? { descriptor: (0, store_projection_1.cloneStoreProjectionValue)(artifact.descriptor) } : {}),
    };
}
function copyRun(run) {
    return {
        ...run,
        resourceIds: [...run.resourceIds],
        artifacts: run.artifacts.map(copyArtifact),
        usage: copyUsage(run.usage),
        ...(run.recovery ? { recovery: { ...run.recovery } } : {}),
        ...(run.result !== undefined ? { result: (0, store_projection_1.cloneStoreProjectionValue)(run.result) } : {}),
    };
}
function copyApproval(approval) {
    return {
        ...approval,
        ...(approval.data !== undefined ? { data: (0, store_projection_1.cloneStoreProjectionValue)(approval.data) } : {}),
    };
}
function copyInput(input) {
    return {
        ...input,
        ...(input.schema !== undefined ? { schema: (0, store_projection_1.cloneStoreProjectionValue)(input.schema) } : {}),
    };
}
function terminal(state) {
    return state == 'completed' || state == 'failed' || state == 'cancelled';
}
function createAiRunHost(deps) {
    const { runner, policy, history, drain, now = Date.now } = deps;
    const capabilities = [...(deps.capabilities ?? [])];
    let nextId = 0;
    const initial = (0, ai_run_persistence_1.restoreAiRunCheckpoint)(deps.initial);
    let committed = (0, store_projection_1.cloneStoreProjectionValue)(initial);
    const store = (0, store_1.createStore)(initial.store, drain !== undefined ? { drain } : {});
    const requests = initial.requests;
    const inputValues = initial.inputValues;
    let revision = initial.revision;
    const usedIds = new Set([...Object.keys(initial.store.runs), ...Object.keys(initial.store.approvals), ...Object.keys(initial.store.inputs),
        ...Object.values(initial.store.runs).flatMap(run => run.artifacts.map(artifact => artifact.id))]);
    function makeId() {
        let id;
        if (deps.id)
            id = deps.id();
        else
            do {
                id = 'ai-' + (++nextId);
            } while (usedIds.has(id));
        if (!id || usedIds.has(id))
            throw new Error('AI run id must be unique');
        usedIds.add(id);
        return id;
    }
    const views = new Set();
    const requestIds = new Map();
    const cancelled = new Set();
    const approvalWaiters = new Map();
    const inputWaiters = new Map();
    const [emitEvent, eventLine] = (0, Listen_1.listen)();
    const [emitPersistenceError, persistenceErrors] = (0, Listen_1.listen)();
    let closed = false;
    let persistenceFailure;
    let persistenceFailed = false;
    let committing = false;
    for (const run of Object.values(store.state.runs)) {
        requestIds.set((0, command_receipts_1.commandReceiptKey)(run.owner, run.requestId), run.id);
        if (!terminal(run.state))
            run.recovery = { from: run.recovery?.from ?? run.state };
    }
    function requireOpen() {
        if (closed)
            throw new Error('AI run host closed');
        if (persistenceFailed)
            throw new Error('AI persistence failed; reopen from durable storage before continuing', { cause: persistenceFailure });
        if (committing)
            throw new Error('AI persistence must not reenter its host');
    }
    function snapshot() {
        return { version: 1, revision, store: store.snapshot(), requests: (0, store_projection_1.cloneStoreProjectionValue)(requests), inputValues: (0, store_projection_1.cloneStoreProjectionValue)(inputValues) };
    }
    function checkpoint() {
        requireOpen();
        if (!deps.persistence)
            return;
        committing = true;
        try {
            const next = snapshot();
            next.revision++;
            const result = deps.persistence.commit((0, store_projection_1.cloneStoreProjectionValue)(next));
            if (result && typeof result.then == 'function') {
                void Promise.resolve(result).catch(function observedInvalidAsyncPort() { });
                throw new Error('AI persistence commit must be synchronous');
            }
            revision = next.revision;
            committed = next;
        }
        catch (error) {
            persistenceFailed = true;
            persistenceFailure = error;
            store.replace((0, store_projection_1.cloneStoreProjectionValue)(committed.store));
            for (const key of Object.keys(requests))
                delete requests[key];
            Object.assign(requests, (0, store_projection_1.cloneStoreProjectionValue)(committed.requests));
            for (const key of Object.keys(inputValues))
                delete inputValues[key];
            Object.assign(inputValues, (0, store_projection_1.cloneStoreProjectionValue)(committed.inputValues));
            for (const run of Object.values(store.state.runs)) {
                if (!terminal(run.state)) {
                    run.recovery = { from: run.state };
                    requestProviderCancel(run, 'AI persistence failed');
                }
            }
            for (const waiter of [...approvalWaiters.values(), ...inputWaiters.values()])
                waiter.reject(new Error('AI persistence failed'));
            approvalWaiters.clear();
            inputWaiters.clear();
            for (const view of views)
                view.refresh();
            emitPersistenceError(error);
            throw error;
        }
        finally {
            committing = false;
        }
        for (const view of views)
            view.refresh();
    }
    function readable(account, run) {
        return policy?.canRead ? policy.canRead(account, run) : run.owner == account;
    }
    function writable(account, run) {
        return policy?.canWrite ? policy.canWrite(account, run) : run.owner == account;
    }
    function requireRun(account, runId, action) {
        requireOpen();
        const run = store.state.runs[runId];
        if (!run || !writable(account, run))
            throw new Error('AI run ' + action + ': forbidden or missing');
        return run;
    }
    function project(account) {
        const runs = {};
        const approvals = {};
        const inputs = {};
        for (const [id, run] of Object.entries(store.state.runs)) {
            if (readable(account, run))
                runs[id] = copyRun(run);
        }
        for (const [id, approval] of Object.entries(store.state.approvals)) {
            if (runs[approval.runId])
                approvals[id] = copyApproval(approval);
        }
        for (const [id, input] of Object.entries(store.state.inputs)) {
            if (runs[input.runId])
                inputs[id] = copyInput(input);
        }
        return { runs, approvals, inputs };
    }
    function syncEvent(account) {
        const state = project(account);
        return {
            type: 'sync',
            runs: Object.values(state.runs),
            approvals: Object.values(state.approvals),
            inputs: Object.values(state.inputs),
        };
    }
    function refreshViews(change) {
        if (closed || deps.persistence)
            return;
        for (const view of views)
            view.refresh(change);
    }
    const offStore = store.listenPaths().on(refreshViews);
    function createView(account) {
        const state = (0, store_1.createStore)(project(account), drain !== undefined ? { drain } : {});
        const stateReplay = (0, store_replay_1.exposeStoreReplay)(state, history == undefined ? {} : { history });
        const [emitViewEvent, events] = (0, replay_listen_1.replayListen)({
            current: () => [syncEvent(account)],
            history: history ?? 1024,
        });
        const offEvents = eventLine.on(function forwardReadableEvent(event) {
            if (event.type == 'sync')
                return;
            const run = store.state.runs[event.runId];
            if (run && readable(account, run))
                emitViewEvent(event);
        });
        function refreshApproval(id) {
            const approval = store.state.approvals[id];
            const visible = !!approval && !!state.state.runs[approval.runId];
            (0, store_projection_1.reconcileStoreProjectionRecord)(state, 'approvals', id, {
                exists: visible,
                ...(visible ? { value: copyApproval(approval) } : {}),
            });
        }
        function refreshInput(id) {
            const input = store.state.inputs[id];
            const visible = !!input && !!state.state.runs[input.runId];
            (0, store_projection_1.reconcileStoreProjectionRecord)(state, 'inputs', id, {
                exists: visible,
                ...(visible ? { value: copyInput(input) } : {}),
            });
        }
        function refreshRun(id) {
            const run = store.state.runs[id];
            const wasVisible = !!state.state.runs[id];
            const visible = !!run && readable(account, run);
            (0, store_projection_1.reconcileStoreProjectionRecord)(state, 'runs', id, {
                exists: visible,
                ...(visible ? { value: copyRun(run) } : {}),
            });
            if (visible == wasVisible)
                return;
            const approvals = visible ? store.state.approvals : state.state.approvals;
            const inputs = visible ? store.state.inputs : state.state.inputs;
            for (const approval of Object.values(approvals))
                if (approval.runId == id)
                    refreshApproval(approval.id);
            for (const input of Object.values(inputs))
                if (input.runId == id)
                    refreshInput(input.id);
        }
        function refreshProjection(change) {
            if (!change || policy?.canRead) {
                (0, store_projection_1.reconcileStoreProjection)(state, project(account));
                return;
            }
            const changed = (0, store_projection_1.collectStoreProjectionChanges)(change, ['runs', 'approvals', 'inputs']);
            if (!changed) {
                (0, store_projection_1.reconcileStoreProjection)(state, project(account));
                return;
            }
            for (const id of changed.get('runs') ?? [])
                refreshRun(String(id));
            for (const id of changed.get('approvals') ?? [])
                refreshApproval(String(id));
            for (const id of changed.get('inputs') ?? [])
                refreshInput(String(id));
        }
        let view;
        view = {
            refresh: refreshProjection,
            close() {
                views.delete(view);
                offEvents();
                stateReplay.close();
                events.close();
            },
        };
        return { view, stateReplay, events };
    }
    function touchRun(run) {
        run.updatedAt = now();
    }
    function touchApproval(approval) {
        approval.updatedAt = now();
    }
    function touchInput(input) {
        input.updatedAt = now();
    }
    function active(run) {
        return !!run && !closed && !persistenceFailed && !run.recovery && !cancelled.has(run.id) && !terminal(run.state);
    }
    function emitRunEvent(event) {
        const run = store.state.runs[event.runId];
        if (!run || closed)
            return;
        if (!['text.delta', 'notice', 'tool.call', 'tool.result'].includes(event.type))
            checkpoint();
        emitEvent((0, store_projection_1.cloneStoreProjectionValue)(event));
    }
    function refreshWaitingState(run) {
        if (terminal(run.state) || run.recovery)
            return;
        const waitingApproval = Object.values(store.state.approvals).some(approval => approval.runId == run.id && approval.state == 'pending');
        const waitingInput = Object.values(store.state.inputs).some(input => input.runId == run.id && input.state == 'waiting');
        const next = waitingApproval ? 'waiting_approval' : waitingInput ? 'waiting_input' : 'running';
        if (run.state != next) {
            run.state = next;
            touchRun(run);
        }
    }
    function cancelPendingWaiters(run, reason) {
        for (const approval of Object.values(store.state.approvals)) {
            if (approval.runId != run.id || approval.state != 'pending')
                continue;
            approval.state = 'cancelled';
            touchApproval(approval);
            approvalWaiters.get(approval.id)?.reject(new Error(reason));
            approvalWaiters.delete(approval.id);
        }
        for (const input of Object.values(store.state.inputs)) {
            if (input.runId != run.id || input.state != 'waiting')
                continue;
            input.state = 'cancelled';
            touchInput(input);
            inputWaiters.get(input.id)?.reject(new Error(reason));
            inputWaiters.delete(input.id);
        }
    }
    function requestProviderCancel(run, reason) {
        if (!runner.cancel)
            return;
        try {
            Promise.resolve(runner.cancel({ run: copyRun(run), reason })).catch(function ignoreProviderCancelFailure() { });
        }
        catch { }
    }
    function reportRun(runId, next) {
        const run = store.state.runs[runId];
        if (!active(run))
            return;
        if (next.progress != null) {
            if (!Number.isFinite(next.progress))
                throw new Error('AI run progress must be finite');
            run.progress = clampProgress(next.progress);
        }
        if (next.message != null)
            run.message = next.message;
        if (next.usage != null)
            run.usage = copyUsage(next.usage);
        touchRun(run);
        emitRunEvent({ runId, type: 'progress', progress: run.progress, ...(run.message != null ? { message: run.message } : {}), ...(run.usage ? { usage: copyUsage(run.usage) } : {}) });
    }
    function emitLiveEvent(runId, event) {
        const run = store.state.runs[runId];
        if (!active(run))
            return;
        emitRunEvent({ runId, ...event });
    }
    function addArtifact(runId, input) {
        const run = store.state.runs[runId];
        if (!active(run))
            return undefined;
        if (!input || typeof input.kind != 'string' || !input.kind.trim())
            throw new Error('AI artifact kind is required');
        const artifact = {
            ...input,
            id: input.id ?? makeId(),
            kind: input.kind,
            ...(input.descriptor !== undefined ? { descriptor: (0, store_projection_1.cloneStoreProjectionValue)(input.descriptor) } : {}),
        };
        run.artifacts.push(artifact);
        touchRun(run);
        emitRunEvent({ runId, type: 'artifact', artifact: copyArtifact(artifact) });
        return copyArtifact(artifact);
    }
    function requestApproval(runId, request) {
        const run = store.state.runs[runId];
        if (!active(run))
            return Promise.reject(new Error('AI run approval: run is not active'));
        if (!request || typeof request.kind != 'string' || !request.kind.trim())
            return Promise.reject(new Error('AI run approval: kind is required'));
        if (typeof request.label != 'string' || !request.label.trim())
            return Promise.reject(new Error('AI run approval: label is required'));
        const previous = request.id ? store.state.approvals[request.id] : undefined;
        if (request.id && (!previous || previous.runId != runId || previous.kind != request.kind || previous.label != request.label
            || !(0, deep_equal_1.compareDeepValues)(previous.data, request.data)))
            return Promise.reject(new Error('AI approval recovery: request mismatch'));
        if (previous?.state == 'approved' || previous?.state == 'rejected')
            return Promise.resolve(previous.state);
        if (previous?.state == 'cancelled')
            return Promise.reject(new Error('AI approval cancelled'));
        if (previous && approvalWaiters.has(previous.id))
            return Promise.reject(new Error('AI approval already has a waiter'));
        const createdAt = now();
        const approval = previous ?? {
            id: makeId(), runId, kind: request.kind, label: request.label, state: 'pending', createdAt, updatedAt: createdAt,
            ...(request.data !== undefined ? { data: (0, store_projection_1.cloneStoreProjectionValue)(request.data) } : {}),
        };
        store.state.approvals[approval.id] = approval;
        refreshWaitingState(run);
        const waiting = new Promise(function waitForApproval(resolve, reject) {
            approvalWaiters.set(approval.id, { resolve, reject });
        });
        void waiting.catch(function observedOwnedWaiter() { });
        emitRunEvent({ runId, type: 'approval.requested', approval: copyApproval(approval) });
        return waiting;
    }
    function waitForInput(runId, request) {
        const run = store.state.runs[runId];
        if (!active(run))
            return Promise.reject(new Error('AI run input: run is not active'));
        if (!request || typeof request.label != 'string' || !request.label.trim())
            return Promise.reject(new Error('AI run input: label is required'));
        const previous = request.id ? store.state.inputs[request.id] : undefined;
        if (request.id && (!previous || previous.runId != runId || previous.label != request.label
            || !(0, deep_equal_1.compareDeepValues)(previous.schema, request.schema)))
            return Promise.reject(new Error('AI input recovery: request mismatch'));
        if (previous?.state == 'provided')
            return Promise.resolve((0, store_projection_1.cloneStoreProjectionValue)(inputValues[previous.id]));
        if (previous?.state == 'cancelled')
            return Promise.reject(new Error('AI input cancelled'));
        if (previous && inputWaiters.has(previous.id))
            return Promise.reject(new Error('AI input already has a waiter'));
        const createdAt = now();
        const input = previous ?? {
            id: makeId(), runId, label: request.label, state: 'waiting', createdAt, updatedAt: createdAt,
            ...(request.schema !== undefined ? { schema: (0, store_projection_1.cloneStoreProjectionValue)(request.schema) } : {}),
        };
        store.state.inputs[input.id] = input;
        refreshWaitingState(run);
        const waiting = new Promise(function waitForProvidedInput(resolve, reject) {
            inputWaiters.set(input.id, { resolve, reject });
        });
        void waiting.catch(function observedOwnedWaiter() { });
        emitRunEvent({ runId, type: 'input.requested', input: copyInput(input) });
        return waiting;
    }
    async function executeRun(runId, request, recovery) {
        const run = store.state.runs[runId];
        if (!active(run))
            return;
        try {
            run.state = 'running';
            touchRun(run);
            emitRunEvent({ runId, type: 'started' });
            if (!active(run))
                return;
            const context = {
                run: copyRun(run),
                input: (0, store_projection_1.cloneStoreProjectionValue)(request.input),
                resourceIds: [...run.resourceIds],
                report: next => reportRun(runId, next),
                emit: event => emitLiveEvent(runId, event),
                artifact: artifact => addArtifact(runId, artifact),
                requestApproval: approval => requestApproval(runId, approval),
                waitForInput: input => waitForInput(runId, input),
                cancelled: () => !active(store.state.runs[runId]),
            };
            const output = await (recovery ? runner.recover({ ...context, checkpoint: recovery }) : runner.run(context));
            const current = store.state.runs[runId];
            if (!active(current))
                return;
            cancelPendingWaiters(current, 'AI run completed before its response arrived');
            current.state = 'completed';
            current.progress = 1;
            if (output?.result !== undefined)
                current.result = (0, store_projection_1.cloneStoreProjectionValue)(output.result);
            if (output?.usage !== undefined)
                current.usage = copyUsage(output.usage);
            touchRun(current);
            emitRunEvent({ runId, type: 'completed', ...(current.result !== undefined ? { result: current.result } : {}), ...(current.usage ? { usage: copyUsage(current.usage) } : {}) });
        }
        catch (error) {
            const current = store.state.runs[runId];
            if (!active(current))
                return;
            cancelPendingWaiters(current, 'AI run failed before its response arrived');
            current.state = 'failed';
            current.error = errorText(error);
            touchRun(current);
            emitRunEvent({ runId, type: 'failed', error: current.error });
        }
    }
    function getCapabilities() {
        return capabilities.map(capability => ({ ...capability }));
    }
    function createRun(account, request) {
        requireOpen();
        if (!request || typeof request.requestId != 'string' || !request.requestId.trim())
            throw new Error('AI run create: requestId is required');
        if (typeof request.kind != 'string' || !request.kind.trim())
            throw new Error('AI run create: kind is required');
        if (policy?.canCreate && !policy.canCreate(account, request))
            throw new Error('AI run create: forbidden');
        const requestKey = (0, command_receipts_1.commandReceiptKey)(account, request.requestId);
        const previous = requestIds.get(requestKey);
        if (previous) {
            const existing = store.state.runs[previous];
            if (existing) {
                if ((deps.persistence || deps.initial) && !(0, deep_equal_1.compareDeepValues)(requests[previous], { ...request, resourceIds: [...(request.resourceIds ?? [])] })) {
                    throw new Error('AI run create: requestId reused with different input');
                }
                if (!readable(account, existing))
                    throw new Error('AI run create: forbidden');
                return copyRun(existing);
            }
        }
        if (capabilities.length && !capabilities.some(capability => capability.kind == request.kind)) {
            throw new Error('AI run create: unsupported kind ' + request.kind);
        }
        const createdAt = now();
        const run = {
            id: makeId(), owner: account, requestId: request.requestId, kind: request.kind,
            resourceIds: [...(request.resourceIds ?? [])], state: 'queued', progress: 0, artifacts: [],
            createdAt, updatedAt: createdAt,
        };
        requestIds.set(requestKey, run.id);
        requests[run.id] = (0, store_projection_1.cloneStoreProjectionValue)({ ...request, resourceIds: [...(request.resourceIds ?? [])] });
        store.state.runs[run.id] = run;
        checkpoint();
        void executeRun(run.id, requests[run.id]).catch(function executionPersistenceFailed() { });
        return copyRun(store.state.runs[run.id]);
    }
    function cancelRun(account, runId, reason) {
        const run = requireRun(account, runId, 'cancel');
        if (terminal(run.state))
            return copyRun(run);
        cancelled.add(run.id);
        cancelPendingWaiters(run, reason ?? 'AI run cancelled');
        run.state = 'cancelled';
        delete run.recovery;
        run.message = reason ?? 'cancelled';
        touchRun(run);
        emitRunEvent({ runId: run.id, type: 'cancelled', ...(reason ? { reason } : {}) });
        requestProviderCancel(run, reason);
        return copyRun(run);
    }
    function resolveApproval(account, approvalId, decision) {
        requireOpen();
        const approval = store.state.approvals[approvalId];
        const run = approval && store.state.runs[approval.runId];
        if (!approval || !run || !writable(account, run))
            throw new Error('AI approval resolve: forbidden or missing');
        if (decision != 'approved' && decision != 'rejected')
            throw new Error('AI approval resolve: invalid decision');
        if (approval.state != 'pending')
            return copyApproval(approval);
        if (terminal(run.state))
            throw new Error('AI approval resolve: run is terminal');
        approval.state = decision;
        touchApproval(approval);
        refreshWaitingState(run);
        emitRunEvent({ runId: run.id, type: 'approval.resolved', approval: copyApproval(approval) });
        approvalWaiters.get(approval.id)?.resolve(decision);
        approvalWaiters.delete(approval.id);
        return copyApproval(approval);
    }
    function provideInput(account, inputId, value) {
        requireOpen();
        const input = store.state.inputs[inputId];
        const run = input && store.state.runs[input.runId];
        if (!input || !run || !writable(account, run))
            throw new Error('AI input provide: forbidden or missing');
        if (input.state != 'waiting') {
            if (input.state == 'provided' && !(0, deep_equal_1.compareDeepValues)(inputValues[input.id], value))
                throw new Error('AI input provide: value mismatch');
            return copyInput(input);
        }
        if (terminal(run.state))
            throw new Error('AI input provide: run is terminal');
        inputValues[input.id] = (0, store_projection_1.cloneStoreProjectionValue)(value);
        input.state = 'provided';
        touchInput(input);
        refreshWaitingState(run);
        emitRunEvent({ runId: run.id, type: 'input.provided', input: copyInput(input) });
        inputWaiters.get(input.id)?.resolve((0, store_projection_1.cloneStoreProjectionValue)(value));
        inputWaiters.delete(input.id);
        return copyInput(input);
    }
    function recoveryRecord(run) {
        return { run: copyRun(run), request: (0, store_projection_1.cloneStoreProjectionValue)(requests[run.id]),
            approvals: Object.values(store.state.approvals).filter(approval => approval.runId == run.id).map(copyApproval),
            inputs: Object.values(store.state.inputs).filter(input => input.runId == run.id).map(function suppliedInput(input) {
                return { ...copyInput(input), ...(input.state == 'provided' ? { value: (0, store_projection_1.cloneStoreProjectionValue)(inputValues[input.id]) } : {}) };
            }),
        };
    }
    function requireRecovery(runId) {
        requireOpen();
        const run = store.state.runs[runId];
        if (!run?.recovery)
            throw new Error('AI recovery: run does not require recovery');
        if (!writable(run.owner, run) || (policy?.canCreate && !policy.canCreate(run.owner, requests[runId]))) {
            throw new Error('AI recovery: current owner or resources are forbidden');
        }
        return run;
    }
    async function resume(runId) {
        const run = requireRecovery(runId);
        if (!runner.recover)
            throw new Error('AI recovery: runner.recover is required; run is never replayed');
        const recovery = recoveryRecord(run);
        delete run.recovery;
        await executeRun(runId, requests[runId], recovery);
        requireOpen();
        return copyRun(store.state.runs[runId]);
    }
    function settle(runId, outcome) {
        const run = requireRecovery(runId);
        cancelPendingWaiters(run, 'AI run reconciled by the server');
        delete run.recovery;
        run.state = outcome.state;
        touchRun(run);
        if (outcome.state == 'completed') {
            run.progress = 1;
            if (outcome.output?.result !== undefined)
                run.result = (0, store_projection_1.cloneStoreProjectionValue)(outcome.output.result);
            if (outcome.output?.usage !== undefined)
                run.usage = copyUsage(outcome.output.usage);
            emitRunEvent({ runId, type: 'completed', result: run.result, usage: run.usage });
        }
        else {
            run.error = outcome.error;
            emitRunEvent({ runId, type: 'failed', error: outcome.error });
        }
        return copyRun(run);
    }
    function connection(account) {
        if (closed)
            throw new Error('AI run host closed');
        const { view, stateReplay, events } = createView(account);
        views.add(view);
        let connectionClosed = false;
        function requireConnection() {
            if (connectionClosed)
                throw new Error('AI run connection closed');
            requireOpen();
        }
        return {
            fragment: {
                capabilities: getCapabilities,
                state: stateReplay.api.replay,
                events: (0, replay_wire_1.exposeReplay)(events),
                createRun(request) { requireConnection(); return createRun(account, request); },
                cancelRun(runId, reason) { requireConnection(); return cancelRun(account, runId, reason); },
                resolveApproval(approvalId, decision) { requireConnection(); return resolveApproval(account, approvalId, decision); },
                provideInput(inputId, value) { requireConnection(); return provideInput(account, inputId, value); },
            },
            close() {
                if (connectionClosed)
                    return;
                connectionClosed = true;
                view.close();
            },
        };
    }
    return {
        connection,
        store,
        persistence: { snapshot, errors: persistenceErrors, error: () => persistenceFailure },
        recovery: {
            pending: () => Object.values(store.state.runs).filter(run => !!run.recovery).map(recoveryRecord),
            resume,
            settle,
        },
        close() {
            if (closed)
                return;
            closed = true;
            offStore();
            for (const run of Object.values(store.state.runs)) {
                if (!terminal(run.state))
                    requestProviderCancel(run, 'AI run host closed');
            }
            for (const waiter of approvalWaiters.values())
                waiter.reject(new Error('AI run host closed'));
            for (const waiter of inputWaiters.values())
                waiter.reject(new Error('AI run host closed'));
            approvalWaiters.clear();
            inputWaiters.clear();
            for (const view of Array.from(views))
                view.close();
            eventLine.close();
            persistenceErrors.close();
            cancelled.clear();
        },
    };
}
