"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createResourceSession = createResourceSession;
const node_crypto_1 = require("node:crypto");
const Listen_1 = require("../Common/events/Listen");
const rpc_dynamic_1 = require("../Common/rcp/rpc-dynamic");
const rpc_scope_1 = require("../Common/rcp/rpc-scope");
const resource_budget_1 = require("./resource-budget");
const rpc_deadline_1 = require("../Common/rcp/rpc-deadline");
function createResourceSession(deps) {
    const budgets = (0, resource_budget_1.resourceBudgets)(deps.options);
    const sessionId = (0, node_crypto_1.randomUUID)();
    const dead = (0, rpc_scope_1.createRpcScope)();
    dead.close();
    const instances = (0, rpc_dynamic_1.noStrict)(Object.create(null));
    const entries = new Map();
    const [emit, events] = (0, Listen_1.listen)();
    let who = null;
    let signature = '';
    let revision = 0;
    let terminal = false;
    let deadline;
    let facts = { revision, account: null, roles: [], allowed: [] };
    let closing;
    const cleanup = new Set();
    function report(name, resourceId, phase, error) {
        try {
            deps.report({ name, resourceId, phase, error });
        }
        catch { }
    }
    function track(task) {
        cleanup.add(task);
        void task.then(function done() { cleanup.delete(task); }, function failed() { cleanup.delete(task); });
        return task;
    }
    function invalidate() {
        for (const entry of [...entries.values()])
            track(entry.close());
    }
    function publish() {
        facts = { ...facts, revision: ++revision };
        emit(facts);
    }
    function refresh() {
        if (terminal)
            return;
        if (who?.expiresAt != undefined && who.expiresAt <= Date.now()) {
            suspend();
            return;
        }
        const principal = who ? deps.principalOf(who) : null;
        const roles = [...new Set(principal?.roles ?? [])].sort();
        const next = JSON.stringify([principal?.account ?? null, roles]);
        if (next == signature)
            return;
        signature = next;
        invalidate();
        facts = { revision, account: principal?.account ?? null, roles,
            allowed: principal ? Object.keys(deps.registry).filter(name => deps.registry[name].allow.some(role => roles.includes(role))) : [] };
        publish();
    }
    function suspend() {
        deadline?.cancel();
        who = null;
        refresh();
    }
    function update(principal) {
        if (terminal)
            throw (0, resource_budget_1.resourceError)('E_RESOURCE_CLOSED');
        who = { ...principal };
        deadline?.cancel();
        if (principal.expiresAt != undefined && principal.expiresAt != Infinity)
            deadline = (0, rpc_deadline_1.createRpcDeadline)({ at: principal.expiresAt, fire: suspend, unref: true });
        refresh();
        return facade;
    }
    function createEntry(name) {
        const id = (0, node_crypto_1.randomUUID)();
        const scope = (0, rpc_scope_1.createRpcScope)();
        const principal = Object.freeze({ account: facts.account, roles: Object.freeze([...facts.roles]) });
        let handle;
        let disposal;
        let completion;
        function dispose() {
            if (!disposal) {
                disposal = (0, resource_budget_1.resourceWithin)(Promise.resolve().then(function release() { return handle.close(); }), budgets.close, 'E_RESOURCE_CLEANUP')
                    .catch(function failed(error) { report(name, id, 'close', error); throw (0, resource_budget_1.resourceError)('E_RESOURCE_CLEANUP'); });
                void disposal.catch(function observed() { });
            }
            return disposal;
        }
        const factory = Promise.resolve().then(function allocate() {
            scope.check();
            return deps.registry[name].open({ principal, sessionId, resourceId: id, signal: scope.signal });
        }).then(function allocated(value) {
            handle = value;
            if (!scope.active())
                void dispose().catch(function lateCleanupObserved() { });
            return value;
        });
        const ready = (0, resource_budget_1.resourceWithin)(factory, budgets.open, 'E_RESOURCE_TIMEOUT', scope.signal).then(function expose(value) {
            refresh();
            scope.check();
            if (!value || typeof value.facade != 'object' || value.facade == null || typeof value.close != 'function')
                throw new Error('Invalid resource factory result');
            instances[id] = value.facade;
        }).catch(function failed(error) {
            const active = scope.active();
            if (active)
                report(name, id, 'open', error);
            void close().catch(function cleanupObserved() { });
            throw (0, resource_budget_1.resourceError)(active ? error?.code == 'E_RESOURCE_TIMEOUT' ? 'E_RESOURCE_TIMEOUT' : 'E_RESOURCE_OPEN' : 'E_RESOURCE_CLOSED');
        });
        void ready.catch(function openingObserved() { });
        function close() {
            if (completion)
                return completion;
            const errors = scope.close();
            for (const error of errors)
                report(name, id, 'close', error);
            delete instances[id];
            entries.delete(id);
            completion = (0, resource_budget_1.resourceWithin)(factory.then(function releaseAllocated() { return dispose(); }, function nothingReturned() { }), budgets.close, 'E_RESOURCE_CLEANUP')
                .catch(function cleanupFailed(error) {
                report(name, id, 'close', error);
                throw (0, resource_budget_1.resourceError)('E_RESOURCE_CLEANUP');
            });
            void completion.catch(function observed() { });
            return track(completion);
        }
        return { id, scope, ready, close };
    }
    function requireEntry(id) {
        refresh();
        const entry = entries.get(id);
        if (!entry)
            throw (0, resource_budget_1.resourceError)('E_RESOURCE_CLOSED');
        entry.scope.check();
        return entry;
    }
    function open(name) {
        refresh();
        if (terminal || !facts.account)
            throw (0, resource_budget_1.resourceError)('E_RESOURCE_DENIED');
        if (!Object.hasOwn(deps.registry, name))
            throw (0, resource_budget_1.resourceError)('E_RESOURCE_UNSUPPORTED');
        if (!facts.allowed.includes(name))
            throw (0, resource_budget_1.resourceError)('E_RESOURCE_DENIED');
        const entry = createEntry(name);
        entries.set(entry.id, entry);
        return { id: entry.id };
    }
    function state() { refresh(); return facts; }
    const facade = {
        control: { open, ready(id) { return requireEntry(id).ready; }, close(id) { return entries.get(id)?.close() ?? Promise.resolve(); }, state },
        events, instances,
    };
    const stop = deps.changes(refresh);
    function close() {
        if (closing)
            return closing;
        terminal = true;
        deadline?.cancel();
        stop();
        invalidate();
        events.close();
        closing = Promise.allSettled([...cleanup]).then(function finished(results) {
            const errors = results.filter(result => result.status == 'rejected').map(result => result.reason);
            if (errors.length)
                throw new AggregateError(errors, 'Resource session cleanup failed');
        });
        void closing.catch(function observed() { });
        return closing;
    }
    const hooks = (0, rpc_scope_1.bindRpcScopes)({}, function resolve(path) {
        refresh();
        return path[0] == 'instances' ? entries.get(path[1])?.scope ?? dead : undefined;
    });
    return { update, suspend, close, hooks, facade, sessionId };
}
