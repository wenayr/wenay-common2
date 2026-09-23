"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServiceResources = createServiceResources;
const socket_io_client_1 = require("socket.io-client");
const rpc_clientHub_1 = require("../Common/rcp/rpc-clientHub");
const store_1 = require("../Common/Observe/store");
const resource_budget_1 = require("./resource-budget");
function createResourceController(deps) {
    const budgets = (0, resource_budget_1.resourceBudgets)(deps.options);
    const status = (0, store_1.createStore)({ phase: 'opening', generation: 0, error: null });
    const lifetime = new AbortController();
    let current = null;
    let closing;
    let account = null;
    let epoch = 0;
    let revision = -1;
    let id = null;
    let api = null;
    let stopEvents;
    let usable = false;
    let applyingToken = null;
    function set(phase, code) {
        current = phase == 'ready' ? current : null;
        const error = code ? (0, resource_budget_1.resourceError)(code) : null;
        status.replace({ phase, generation: status.state.generation, error: error ? { code: error.code, message: error.message } : null });
    }
    const hub = (0, rpc_clientHub_1.createRpcClientHub)(() => (0, socket_io_client_1.io)(deps.url, { transports: ['websocket'], forceNew: true }), rpc => ({ resources: rpc('resources') }), { token: async function tokenForResource(request) {
            const token = await deps.token(request.reason != 'connect');
            if (lifetime.signal.aborted)
                throw (0, resource_budget_1.resourceError)('E_RESOURCE_CLOSED');
            applyingToken = token;
            return token;
        } });
    const stopToken = deps.tokens(function tokenChanged(token) {
        if (!api || token == applyingToken || lifetime.signal.aborted)
            return;
        applyingToken = token;
        void hub.reauth(token).then(async function refreshed() {
            if (lifetime.signal.aborted)
                return;
            if (!usable) {
                await connected();
                return;
            }
            const facts = await api?.control.state();
            if (facts && !lifetime.signal.aborted)
                accept(facts);
        }).catch(function refused() { if (!lifetime.signal.aborted)
            set('denied', 'E_RESOURCE_DENIED'); });
    });
    function forget() {
        ++epoch;
        usable = false;
        stopEvents?.();
        stopEvents = undefined;
        api = null;
        id = null;
        current = null;
        revision = -1;
    }
    function accept(facts) {
        if (lifetime.signal.aborted || !usable || facts.revision <= revision)
            return;
        revision = facts.revision;
        if (account && facts.account && account != facts.account) {
            void close().catch(function observed() { });
            return;
        }
        if (facts.account)
            account = facts.account;
        const run = ++epoch;
        current = null;
        id = null;
        if (status.state.phase == 'failed')
            return;
        if (!facts.allowed.includes(deps.name)) {
            set('denied', 'E_RESOURCE_DENIED');
            return;
        }
        status.replace({ phase: 'opening', generation: status.state.generation + 1, error: null });
        const remote = api;
        void open(remote, run);
    }
    async function open(remote, run) {
        let allocated = null;
        try {
            const result = await (0, resource_budget_1.resourceWithin)(remote.control.open(deps.name), budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal);
            allocated = result.id;
            if (run != epoch || lifetime.signal.aborted)
                return;
            id = allocated;
            await (0, resource_budget_1.resourceWithin)(remote.control.ready(allocated), budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal);
            if (run != epoch || lifetime.signal.aborted)
                return;
            current = { generation: status.state.generation, remote: remote.instances[allocated] };
            set('ready');
        }
        catch (error) {
            if (run == epoch && !lifetime.signal.aborted) {
                set(error?.code == 'E_RESOURCE_DENIED' ? 'denied' : 'failed', error?.code == 'E_RESOURCE_TIMEOUT' ? 'E_RESOURCE_TIMEOUT' : 'E_RESOURCE_OPEN');
                if (status.state.phase == 'failed')
                    hub.close();
            }
        }
        finally {
            if (allocated && (run != epoch || lifetime.signal.aborted || status.state.phase != 'ready')) {
                void (0, resource_budget_1.resourceWithin)(Promise.resolve(remote.control.close(allocated)), budgets.close, 'E_RESOURCE_CLEANUP').catch(function observed() { });
            }
        }
    }
    async function connected() {
        if (lifetime.signal.aborted)
            return;
        forget();
        const run = epoch;
        if (status.state.phase != 'failed')
            set('opening');
        try {
            const clients = await (0, resource_budget_1.resourceWithin)(hub.promise, budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal);
            await (0, resource_budget_1.resourceWithin)(clients.resources.readyStrict(), budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal);
            const ack = await (0, resource_budget_1.resourceWithin)(clients.resources.auth(), budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal);
            if (run != epoch || lifetime.signal.aborted)
                return;
            api = clients.resources.func;
            if (ack?.ok != true) {
                set('denied', 'E_RESOURCE_DENIED');
                return;
            }
            usable = true;
            stopEvents = api.events.on(accept);
            const facts = await (0, resource_budget_1.resourceWithin)(api.control.state(), budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal);
            if (run == epoch && !lifetime.signal.aborted)
                accept(facts);
        }
        catch {
            if (run == epoch && !lifetime.signal.aborted && status.state.phase != 'failed')
                set('offline', 'E_RESOURCE_TIMEOUT');
        }
    }
    hub.connectListen(function reconnected() { void connected(); });
    hub.disconnectListen(function disconnected() {
        if (lifetime.signal.aborted)
            return;
        const failed = status.state.phase == 'failed';
        forget();
        if (!failed)
            set('offline');
    });
    hub.authListen(function authChanged(event) {
        if (lifetime.signal.aborted)
            return;
        if (event.state == 'revoked' || event.state == 'expired') {
            ++epoch;
            id = null;
            usable = false;
            stopEvents?.();
            stopEvents = undefined;
            set('denied', 'E_RESOURCE_DENIED');
        }
        if (event.state == 'renewed') {
            if (api && usable)
                void api.control.state().then(accept).catch(function observed() { });
            else
                void connected();
        }
    });
    void (0, resource_budget_1.resourceWithin)(hub.promise, budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal).catch(function unavailable() {
        if (!lifetime.signal.aborted && !usable && status.state.phase != 'failed')
            set('offline', 'E_RESOURCE_TIMEOUT');
    });
    function close() {
        if (closing)
            return closing;
        const ownedApi = api, ownedId = id;
        let resolve, reject;
        closing = new Promise(function completion(ok, fail) { resolve = ok; reject = fail; });
        lifetime.abort();
        forget();
        set('closed');
        stopToken();
        deps.released();
        const work = ownedApi && ownedId ? Promise.resolve().then(function release() { return ownedApi.control.close(ownedId); }) : Promise.resolve();
        if (!ownedId)
            hub.close();
        void (0, resource_budget_1.resourceWithin)(work, budgets.close, 'E_RESOURCE_CLEANUP').then(resolve, function failed() {
            set('closed', 'E_RESOURCE_CLEANUP');
            reject((0, resource_budget_1.resourceError)('E_RESOURCE_CLEANUP'));
        }).finally(function disconnected() { hub.close(); });
        void closing.catch(function observed() { });
        return closing;
    }
    if (!deps.supported) {
        set('failed', 'E_RESOURCE_UNSUPPORTED');
        hub.close();
    }
    return { status, current: () => current, close };
}
function createServiceResources(deps) {
    (0, resource_budget_1.resourceBudgets)(deps.options);
    const owned = new Set();
    let closed = false;
    function open(name) {
        if (closed)
            throw (0, resource_budget_1.resourceError)('E_RESOURCE_CLOSED');
        const controller = createResourceController({ ...deps, name,
            supported: Object.hasOwn(deps.definition.resources ?? {}, name),
            released() { owned.delete(controller); },
        });
        owned.add(controller);
        return controller;
    }
    function close() {
        closed = true;
        for (const controller of [...owned])
            void controller.close().catch(function observed() { });
    }
    return { resource: { open }, close };
}
