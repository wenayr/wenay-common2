"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.describeService = void 0;
exports.createServiceClient = createServiceClient;
const socket_io_client_1 = require("socket.io-client");
const rpc_clientHub_1 = require("../Common/rcp/rpc-clientHub");
const node_directory_1 = require("../Common/Observe/node-directory");
const store_1 = require("../Common/Observe/store");
const store_replay_1 = require("../Common/Observe/store-replay");
const Listen_1 = require("../Common/events/Listen");
const resource_client_1 = require("./resource-client");
var descriptor_1 = require("./descriptor");
Object.defineProperty(exports, "describeService", { enumerable: true, get: function () { return descriptor_1.describeService; } });
function createServiceClient(deps) {
    const definition = deps.definition;
    const name = definition.name;
    const log = deps.log ?? (() => { });
    const clientId = deps.clientId ?? 'client-' + Math.random().toString(36).slice(2, 10);
    const rng = deps.placement?.rng ?? Math.random;
    const prefer = deps.placement?.prefer ?? 'nodes';
    const viewNames = Object.keys(definition.views ?? {});
    const publicViews = new Set(viewNames.filter(view => definition.views[view].allow == 'public'));
    const health = (0, store_1.createStore)({ connected: false, nodeId: '', url: '' });
    const permissions = (0, store_1.createStore)({
        account: null, roles: [], views: [...publicViews], commands: [],
    });
    const [emitToken, tokenEvents] = (0, Listen_1.listen)();
    const [emitAuth, authEvents] = (0, Listen_1.listen)();
    if (deps.onToken)
        tokenEvents.on(deps.onToken);
    let closed = false;
    function requireOpen() {
        if (closed)
            throw new Error(`client ${clientId} is closed`);
    }
    const leaderHub = (0, rpc_clientHub_1.createRpcClientHub)(() => (0, socket_io_client_1.io)(deps.url, { transports: ['websocket'], forceNew: true, auth: deps.handshake ?? {} }), r => ({ app: r('app') }));
    let leaderRead = null;
    async function leader() {
        requireOpen();
        if (leaderRead)
            return leaderRead;
        const clients = await leaderHub.setToken(null);
        await clients.app.readyStrict();
        requireOpen();
        leaderRead = clients.app.func[name];
        return leaderRead;
    }
    let token = null;
    let account = null;
    function acceptToken(next) {
        requireOpen();
        if (token != next) {
            token = next;
            emitToken(next);
        }
        return next;
    }
    async function mint() {
        requireOpen();
        const auth = deps.auth;
        if (!auth)
            return null;
        if ('token' in auth)
            return acceptToken(auth.token);
        if ('login' in auth) {
            const minted = await auth.login();
            requireOpen();
            return acceptToken(minted);
        }
        const minted = await (await leader()).identity.login(auth.credentials);
        requireOpen();
        account = minted.account;
        return acceptToken(minted.token);
    }
    async function renew() {
        if (!token || !deps.auth || 'login' in deps.auth)
            return mint();
        const renewed = await (await leader()).identity.renew(token);
        return acceptToken(renewed.token);
    }
    const resources = (0, resource_client_1.createServiceResources)({ definition, url: deps.url, options: deps.resourceOptions,
        token: async function resourceToken(refresh) {
            requireOpen();
            return refresh || (deps.auth && 'login' in deps.auth) ? renew() : token ?? mint();
        },
        tokens: tokenEvents.on,
    });
    let directory = null;
    let stopDirectory;
    const endpointWaitMs = 5000;
    const failedEndpoints = new Map();
    function avoidEndpoint(node) {
        if (node.role != 'leader')
            failedEndpoints.set(node.nodeId, { url: node.url, retryAt: Date.now() + 15_000 });
    }
    async function pickEndpoint(attempted) {
        if (!directory) {
            const remote = await leader();
            requireOpen();
            directory = (0, node_directory_1.followNodeDirectory)(remote.roster);
            stopDirectory = directory.onNodes(function routesChanged(rows) {
                function eligible(node) {
                    return rows.some(row => row.nodeId == node.nodeId && row.url == node.url && row.eligible);
                }
                if (pendingNode && !eligible(pendingNode)) {
                    pendingHub?.close('endpoint withdrawn from roster');
                    stopPendingRights?.();
                }
                if (session && !eligible(session.node))
                    detach(session);
            });
            await directory.ready;
        }
        requireOpen();
        const rows = directory.nodes();
        for (const [id, failed] of failedEndpoints) {
            const row = rows.find(row => row.nodeId == id);
            if (!row?.eligible || row.url != failed.url || Date.now() >= failed.retryAt)
                failedEndpoints.delete(id);
        }
        const available = rows.filter(row => row.eligible && !attempted.has(row.nodeId) && !failedEndpoints.has(row.nodeId));
        const nodes = available.filter(row => row.role != 'leader');
        const pool = prefer == 'nodes' && nodes.length ? nodes : available;
        const picked = (0, node_directory_1.pickDirectoryNode)(pool, { rng });
        if (!picked)
            throw new Error(`client ${clientId}: no eligible endpoint in the roster`);
        return picked;
    }
    let session = null;
    let opening = null;
    let pendingHub = null;
    let pendingNode = null;
    let stopPendingRights = null;
    function publishPermissions(opened) {
        const value = opened.rights.snapshot();
        if (permissions.state.account != null && permissions.state.account != value.account)
            forgetPermissions();
        account = value.account;
        permissions.replace(value);
        for (const [name, view] of openViews)
            if (!value.views.includes(name))
                view.suspend();
    }
    function forgetPermissions() {
        permissions.replace({ account: null, roles: [], views: [...publicViews], commands: [] });
        for (const [name, view] of openViews)
            if (!publicViews.has(name))
                view.suspend();
    }
    function detach(opened) {
        if (session != opened)
            return;
        session = null;
        health.replace({ connected: false, nodeId: '', url: '' });
        opened.stopRights();
        opened.hub.close();
        for (const reattach of reattachers)
            reattach();
    }
    function refreshPermissions(opened) {
        if (closed || session != opened || !opened.authorized)
            return;
        publishPermissions(opened);
        if (!opened.refreshing)
            trackRefresh(opened, refresh());
        async function refresh() {
            try {
                await synchronizeFacade(opened);
                if (!closed && session == opened)
                    for (const reattach of reattachers)
                        reattach();
            }
            catch (error) {
                if (!closed && session == opened) {
                    log(`client ${clientId}: permission refresh failed (${error?.message ?? error})`);
                    forgetPermissions();
                    detach(opened);
                }
            }
        }
    }
    async function synchronizeFacade(opened) {
        const timeout = setTimeout(function refreshExpired() { opened.hub.close('permission refresh timed out'); }, endpointWaitMs);
        try {
            while (!closed && session == opened && opened.authorized) {
                const wanted = JSON.stringify(opened.rights.snapshot());
                if (wanted == opened.granted)
                    return;
                const acknowledgements = await opened.hub.reauth(token);
                if (acknowledgements.some(ack => ack?.ok == false))
                    throw new Error('permission refresh refused');
                opened.granted = wanted;
            }
        }
        finally {
            clearTimeout(timeout);
        }
    }
    function trackRefresh(opened, work) {
        const pending = work.finally(function settled() {
            if (opened.refreshing == pending)
                opened.refreshing = null;
        });
        opened.refreshing = pending;
    }
    function refreshIdentity(opened) {
        const previous = opened.refreshing;
        trackRefresh(opened, reload());
        async function reload() {
            try {
                await previous;
                if (closed || session != opened)
                    return;
                opened.authorized = false;
                await opened.resetRights();
                if (closed || session != opened)
                    return;
                opened.granted = '';
                opened.authorized = true;
                publishPermissions(opened);
                await synchronizeFacade(opened);
                if (closed || session != opened)
                    return;
                for (const reattach of reattachers)
                    reattach();
            }
            catch (error) {
                if (closed || session != opened)
                    return;
                log(`client ${clientId}: renewed permissions failed (${error?.message ?? error})`);
                forgetPermissions();
                detach(opened);
            }
        }
    }
    function createSessionHub(node) {
        return (0, rpc_clientHub_1.createRpcClientHub)(() => (0, socket_io_client_1.io)(node.url, { transports: ['websocket'], forceNew: true, auth: deps.handshake ?? {} }), r => ({ app: r('app'), scale: r('scale') }), deps.auth ? { token: async function supplyToken({ reason }) {
                return (reason == 'connect' && token) ? token : renew();
            } } : {});
    }
    async function connectEndpoint(node) {
        requireOpen();
        const hub = createSessionHub(node);
        pendingHub = hub;
        pendingNode = node;
        let expired = false;
        const timeout = setTimeout(function endpointExpired() {
            expired = true;
            hub.close(`endpoint ${node.nodeId} readiness timed out`);
            stopPendingRights?.();
        }, endpointWaitMs);
        let stopRights = function noRightsLine() { };
        try {
            let api;
            if (deps.auth) {
                const clients = await hub.promise;
                await clients.app.readyStrict();
                await clients.scale.readyStrict();
                api = { app: clients.app.func[name], scale: clients.scale.func[name] };
            }
            else {
                const clients = await hub.setToken(null);
                await clients.app.readyStrict();
                api = { app: clients.app.func[name], scale: null };
            }
            requireOpen();
            const rights = (0, store_1.createStore)({ account: '', roles: [], views: [...publicViews], commands: [] });
            const opened = {
                node, hub, api, rights, stopRights, granted: '', refreshing: null, authorized: !!api.scale,
                resetRights: async function noPermissions() { },
            };
            if (api.scale) {
                const line = (0, store_replay_1.syncStoreReplayRoute)(rights, api.scale.permissions, {
                    timeoutMs: endpointWaitMs,
                    onBatch: function permissionsChanged() { refreshPermissions(opened); },
                });
                stopRights = line;
                opened.stopRights = line;
                opened.resetRights = function resetPermissions() {
                    return line.switch(api.scale.permissions, { reset: true, since: -1, timeoutMs: endpointWaitMs });
                };
                stopPendingRights = line;
                await line.ready;
                requireOpen();
                if (expired)
                    throw new Error('endpoint permissions readiness timed out');
            }
            hub.authListen(function authChanged(event) {
                if (event.key != 'scale' || closed || session != opened)
                    return;
                if (event.state == 'revoked' || event.state == 'expired') {
                    opened.authorized = false;
                    forgetPermissions();
                }
                if (event.state == 'renewed') {
                    refreshIdentity(opened);
                }
                emitAuth(event);
            });
            hub.disconnectListen(function endpointGone() {
                if (closed || session != opened)
                    return;
                log(`client ${clientId}: endpoint ${node.nodeId} gone; placing again`);
                avoidEndpoint(node);
                detach(opened);
            });
            log(`client ${clientId}: attached to ${node.nodeId} (${node.url})`);
            return opened;
        }
        catch (error) {
            stopRights();
            hub.close();
            throw error;
        }
        finally {
            clearTimeout(timeout);
            if (pendingHub == hub) {
                pendingHub = null;
                pendingNode = null;
            }
            if (stopPendingRights == stopRights)
                stopPendingRights = null;
        }
    }
    async function openSession() {
        const attempted = new Set();
        while (true) {
            const node = await pickEndpoint(attempted);
            attempted.add(node.nodeId);
            try {
                const opened = await connectEndpoint(node);
                if (!directory?.nodes().some(row => row.nodeId == node.nodeId && row.url == node.url && row.eligible)) {
                    opened.stopRights();
                    opened.hub.close();
                    continue;
                }
                return opened;
            }
            catch (error) {
                requireOpen();
                avoidEndpoint(node);
                log(`client ${clientId}: endpoint ${node.nodeId} failed (${error?.message ?? error}); placing again`);
            }
        }
    }
    async function current() {
        requireOpen();
        if (session) {
            const opened = session;
            await opened.refreshing;
            requireOpen();
            if (session == opened)
                return opened;
            return current();
        }
        opening ??= openSession().then(async function adopt(opened) {
            if (closed) {
                opened.hub.close();
                requireOpen();
            }
            session = opened;
            if (opened.api.scale) {
                publishPermissions(opened);
                trackRefresh(opened, synchronizeFacade(opened));
                try {
                    await opened.refreshing;
                    requireOpen();
                    if (session != opened)
                        throw new Error('endpoint changed during permission refresh');
                }
                catch (error) {
                    if (!closed && session == opened) {
                        forgetPermissions();
                        detach(opened);
                    }
                    throw error;
                }
            }
            health.replace({ connected: true, nodeId: opened.node.nodeId, url: opened.node.url });
            return opened;
        }).finally(function settled() { opening = null; });
        return opening;
    }
    if (!deps.auth && viewNames.length && !publicViews.size)
        log(`client ${clientId}: anonymous, and every view is role-gated`);
    const reattachers = new Set();
    const views = {};
    const openViews = new Map();
    for (const view of viewNames) {
        Object.defineProperty(views, view, {
            enumerable: true,
            get() {
                requireOpen();
                const known = openViews.get(view);
                if (known)
                    return known.handle;
                const mirror = (0, store_1.createStore)({});
                let route = null;
                let viewClosed = false;
                let resolveReady;
                let rejectReady;
                const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
                ready.catch(() => { });
                let attempt = 0;
                let generation = 0;
                let retryTimer;
                async function attach() {
                    if (closed || viewClosed)
                        return;
                    const epoch = ++generation;
                    try {
                        const opened = await current();
                        if (closed || viewClosed || epoch != generation)
                            return;
                        if (!publicViews.has(view) && !permissions.state.views.includes(view)) {
                            suspend();
                            return;
                        }
                        const facade = publicViews.has(view) ? opened.api.app : opened.api.scale;
                        const remote = facade?.views?.[view];
                        if (!remote)
                            throw new Error(`view ${view} is not served to this principal`);
                        if (!route) {
                            route = (0, store_replay_1.syncStoreReplayRoute)(mirror, remote, { label: view });
                            await route.ready;
                        }
                        else {
                            await route.switch(remote, { label: view, reset: true, since: -1 });
                        }
                        if (closed || viewClosed || epoch != generation)
                            return;
                        resolveReady();
                        attempt = 0;
                    }
                    catch (error) {
                        if (closed || viewClosed || epoch != generation)
                            return;
                        attempt++;
                        log(`client ${clientId}: view ${view} attach failed (${error?.message ?? error})`);
                        if (!route && attempt >= 3) {
                            rejectReady(error);
                            return;
                        }
                        clearTimeout(retryTimer);
                        retryTimer = setTimeout(reattach, Math.min(500 * attempt, 5000));
                    }
                }
                function reattach() { clearTimeout(retryTimer); retryTimer = undefined; void attach(); }
                function suspend() {
                    generation++;
                    clearTimeout(retryTimer);
                    route?.();
                    route = null;
                    mirror.replace({});
                }
                reattachers.add(reattach);
                void attach();
                const handle = {
                    store: mirror, ready, seq: () => route?.seq() ?? -1,
                    close() {
                        if (viewClosed)
                            return;
                        viewClosed = true;
                        clearTimeout(retryTimer);
                        rejectReady(new Error(`view ${view} is closed`));
                        reattachers.delete(reattach);
                        openViews.delete(view);
                        route?.();
                    },
                };
                openViews.set(view, { handle, close: handle.close, suspend });
                return handle;
            },
        });
    }
    const commands = {};
    for (const command of Object.keys(definition.commands)) {
        Object.defineProperty(commands, command, {
            enumerable: true,
            value: async function callCommand(requestId, input) {
                const opened = await current();
                if (!permissions.state.commands.includes(command))
                    throw new Error(`forbidden: ${command} is not served to this principal`);
                const fragment = opened.api.scale?.commands;
                if (!fragment)
                    throw new Error(`commands need auth (client ${clientId} is anonymous)`);
                if (!fragment[command])
                    throw new Error(`forbidden: ${command} is not served to this principal`);
                return fragment[command](requestId, input);
            },
        });
    }
    async function me() {
        const opened = await current();
        if (!opened.api.scale)
            throw new Error('anonymous client has no principal');
        return opened.api.scale.me();
    }
    function close() {
        if (closed)
            return;
        closed = true;
        resources.close();
        for (const handle of [...openViews.values()])
            handle.close();
        pendingHub?.close();
        stopPendingRights?.();
        session?.stopRights();
        session?.hub.close();
        session = null;
        stopDirectory?.();
        directory?.close();
        leaderHub.close();
        health.replace({ connected: false, nodeId: '', url: '' });
        forgetPermissions();
        tokenEvents.close();
        authEvents.close();
    }
    return {
        ready: () => current().then(() => undefined),
        identity: { account: () => account, token: () => token, me, permissions, onToken: { on: tokenEvents.on }, onAuth: { on: authEvents.on } },
        health,
        views,
        commands,
        resources: resources.resource,
        view: {
            endpoint: () => session?.node ?? null,
            roster: () => directory?.nodes() ?? [],
        },
        control: {
            repick() {
                if (session)
                    avoidEndpoint(session.node);
                if (session)
                    detach(session);
            },
        },
        close,
    };
}
