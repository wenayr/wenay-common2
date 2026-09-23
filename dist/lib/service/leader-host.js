"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServiceLeaderHost = createServiceLeaderHost;
exports.runLeaderProcess = runLeaderProcess;
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = require("node:fs");
const Listen_1 = require("../Common/events/Listen");
const rpc_server_auto_1 = require("../Common/rcp/rpc-server-auto");
const fsReplayStorage_1 = require("../server/fsReplayStorage");
const leader_1 = require("./leader");
const config_1 = require("./config");
const rest_1 = require("./rest");
const http_resource_1 = require("./http-resource");
const host_lifecycle_1 = require("./host-lifecycle");
async function createServiceLeaderHost(deps) {
    const serviceDefinition = deps.definition;
    const processEnv = deps.env ?? process.env;
    const env = (0, config_1.leaderEnv)(processEnv);
    const advertised = (0, config_1.servicePublicUrl)(deps.publicUrl ?? env.publicUrl);
    const name = serviceDefinition.name;
    const lifecycle = (0, host_lifecycle_1.createHostLifecycle)(deps);
    return lifecycle.start(async function startLeaderHost() {
        let url = '';
        const host = (0, http_resource_1.createHostResource)({ host: deps.host ?? env.host, port: env.port ?? 0, closeTimeoutMs: deps.closeTimeoutMs,
            origins: () => deps.origins ?? (0, config_1.corsOrigins)(processEnv, url ? [url] : []),
        });
        lifecycle.own(host.close);
        const { app, io: ioServer, server: httpServer } = host.resource;
        let durable = deps.durable;
        let durableControl = deps.durableControl;
        if (env.dataDir) {
            (0, node_fs_1.mkdirSync)(env.dataDir, { recursive: true });
            durable ??= { storage: (0, fsReplayStorage_1.openFsReplayStorage)(node_path_1.default.join(env.dataDir, name + '.jsonl')) };
            durableControl ??= { storage: (0, fsReplayStorage_1.openFsReplayStorage)(node_path_1.default.join(env.dataDir, name + '.control.jsonl')) };
        }
        const leader = (0, leader_1.createServiceLeader)({
            definition: serviceDefinition, selfUrl: () => advertised ?? url, secrets: env.secrets,
            resourceOptions: deps.resourceOptions,
            ...(durable ? { durable } : {}), ...(durableControl ? { durableControl } : {}),
        });
        lifecycle.own(leader.control.close);
        const rest = deps.rest != false && processEnv['SERVICE_REST'] != '0'
            ? (0, rest_1.createServiceRest)({ app, leader, definition: serviceDefinition })
            : null;
        const unmount = await deps.mount?.({ app, leader, url: () => url, signal: lifecycle.signal });
        if (unmount)
            lifecycle.own(unmount);
        if (lifecycle.signal.aborted)
            throw lifecycle.signal.reason;
        ioServer.on('connection', function onLeaderConnection(socket) {
            const auth = socket.handshake.auth;
            const [gone, goneListen] = (0, Listen_1.listen)();
            if (auth?.['role'] == 'service-node') {
                const nodeId = String(auth?.['node'] ?? '');
                if (!nodeId || auth?.['token'] != leader.secrets.nodeToken) {
                    socket.disconnect(true);
                    return;
                }
                socket.on('disconnect', function nodeLinkGone() { gone(); });
                (0, rpc_server_auto_1.createRpcServerAuto)({
                    socket,
                    socketKey: 'node-link',
                    object: { [name]: leader.serve.nodeLinkFragment(nodeId) },
                    disconnectListen: goneListen,
                });
                console.log(`[${name}] node ${nodeId} linked`);
                return;
            }
            const link = leader.serve.scaleConnection();
            socket.on('disconnect', function leaderClientGone() {
                gone();
                link.close();
            });
            const { control } = (0, rpc_server_auto_1.createRpcServerAuto)({
                socket,
                socketKey: 'scale',
                object: link.object,
                auth: {
                    gate: true,
                    resolveAuth: function wrapResolvedPrincipal(presented) {
                        const resolved = link.auth.resolveAuth(presented);
                        return { ...resolved, object: { [name]: resolved.object } };
                    },
                },
                disconnectListen: goneListen,
            });
            link.attach(control);
            if (serviceDefinition.resources) {
                const resources = leader.serve.resourceConnection();
                socket.on('disconnect', function resourcesGone() { void resources.close().catch(function observed() { }); });
                const resourceServer = (0, rpc_server_auto_1.createRpcServerAuto)({ socket, socketKey: 'resources', object: resources.object,
                    auth: resources.auth, hooks: resources.hooks, disconnectListen: goneListen });
                resources.attach(resourceServer.control);
            }
            (0, rpc_server_auto_1.createRpcServerAuto)({
                socket,
                socketKey: 'app',
                object: { [name]: leader.serve.browserFragment(String(auth?.['account'] ?? 'anonymous')) },
                disconnectListen: goneListen,
            });
        });
        await host.control.listen();
        url = host.view.url();
        const publicUrl = advertised ?? url;
        leader.control.start();
        const restored = leader.view.restored();
        if (restored)
            console.log(`[${name}] durable line at seq ${restored.seq}${restored.fromArchive ? ', restored from the archive' : ', fresh archive'}`);
        if (restored?.control)
            console.log(`[${name}] control line (receipts, deny list) at seq ${restored.control.seq}${restored.control.fromArchive ? ', restored from the archive' : ', fresh archive'}`);
        console.log(`[${name}] leader listening on ${url}`);
        if (publicUrl != url)
            console.log(`[${name}] advertised at ${publicUrl}`);
        if (rest)
            console.log(`[${name}]   panel: ${url}/panel   docs: ${url}/docs   openapi: ${url}/openapi.json`);
        console.log(`[${name}] a node joins with: SERVICE_UPSTREAM=${url} SERVICE_NODE_ID=<id> and the two corridor secrets of this run`);
        if (processEnv['SERVICE_PRINT_JOIN_ENV'] == '1') {
            console.log(`SERVICE_NODE_TOKEN=${leader.secrets.nodeToken}`);
            console.log(`SERVICE_TOKEN_SECRET=${leader.secrets.tokenSecret}`);
        }
        return { leader, url, publicUrl, rest, app, httpServer, close: lifecycle.close, shutdown: lifecycle.close };
    });
}
async function runLeaderProcess(deps) {
    const host = await createServiceLeaderHost(deps);
    const signals = (0, host_lifecycle_1.installServiceSignals)({ close: host.close });
    host.httpServer.once('close', function hostClosed() { void signals.close().catch(function failed() { }); });
    function shutdown(_reason) { return signals.close(); }
    return { ...host, close: signals.close, shutdown };
}
