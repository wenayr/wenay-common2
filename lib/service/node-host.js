"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServiceNodeHost = createServiceNodeHost;
exports.runNodeProcess = runNodeProcess;
const socket_io_client_1 = require("socket.io-client");
const rpc_clientHub_1 = require("../Common/rcp/rpc-clientHub");
const auth_token_1 = require("../server/auth-token");
const definition_1 = require("./definition");
const config_1 = require("./config");
const http_resource_1 = require("./http-resource");
const host_lifecycle_1 = require("./host-lifecycle");
const node_1 = require("./node");
async function createServiceNodeHost(deps) {
    const serviceDefinition = deps.definition;
    const processEnv = deps.env ?? process.env;
    const env = (0, config_1.nodeEnv)(processEnv);
    const advertised = (0, config_1.servicePublicUrl)(deps.publicUrl ?? env.publicUrl);
    const lifecycle = (0, host_lifecycle_1.createHostLifecycle)(deps);
    return lifecycle.start(async function startNodeHost() {
        const host = (0, http_resource_1.createHostResource)({ host: deps.host ?? env.host, port: env.port ?? 0, closeTimeoutMs: deps.closeTimeoutMs,
            origins: () => deps.origins ?? (0, config_1.corsOrigins)(processEnv, [env.upstream]),
        });
        lifecycle.own(host.close);
        const { app, io: ioServer, server: httpServer } = host.resource;
        const hub = (0, rpc_clientHub_1.createRpcClientHub)(() => (0, socket_io_client_1.io)(env.upstream, {
            transports: ['websocket'],
            auth: { role: 'service-node', node: env.nodeId, token: env.nodeToken },
        }), r => ({ link: r('node-link') }));
        lifecycle.own(function closeHub() { hub.close(); });
        const codec = (0, auth_token_1.createTokenCodec)({ secret: env.tokenSecret });
        let url = '';
        const node = (0, node_1.createServiceNode)({
            definition: serviceDefinition,
            nodeId: env.nodeId,
            graceMs: deps.graceMs,
            verifyToken: function verifyPresentedToken(presented) {
                const verdict = codec.verify(presented);
                if (!verdict.ok)
                    throw new Error('token rejected: ' + verdict.reason);
                if (verdict.claims.sub == definition_1.SYSTEM_ACCOUNT)
                    throw new Error('token rejected: reserved account');
                return { account: verdict.claims.sub, expiresAt: verdict.claims.exp };
            },
            upstream: async function resolveLeaderLink() {
                const clients = await hub.setToken(null);
                await clients.link.readyStrict();
                const leader = clients.link.func[serviceDefinition.name];
                return {
                    replica: leader.replica,
                    control: leader.control,
                    commandsByToken: leader.commandsByToken,
                    register: leader.register,
                    heartbeat: leader.heartbeat,
                    goodbye: leader.goodbye,
                    onFail: { on: (cb) => hub.disconnectListen(cb) },
                };
            },
            serve: { onConnection(handler) { ioServer.on('connection', handler); } },
            selfUrl: () => advertised ?? url,
            onLeave: function shutdownAfterLeave() {
                void lifecycle.close().catch(function failed(error) { console.error(error); });
            },
        });
        lifecycle.own(node.close);
        const unmount = await deps.mount?.({ app, node, url: () => url, signal: lifecycle.signal });
        if (unmount)
            lifecycle.own(unmount);
        if (lifecycle.signal.aborted)
            throw lifecycle.signal.reason;
        await host.control.listen();
        url = host.view.url();
        const publicUrl = advertised ?? url;
        await node.start();
        if (lifecycle.signal.aborted)
            throw lifecycle.signal.reason;
        let stopping;
        function close() {
            if (stopping)
                return stopping;
            node.leave('host closed');
            stopping = new Promise(function waitForLeave(resolve, reject) {
                if (lifecycle.signal.aborted) {
                    lifecycle.close().then(resolve, reject);
                    return;
                }
                lifecycle.signal.addEventListener('abort', function left() { lifecycle.close().then(resolve, reject); }, { once: true });
            });
            return stopping;
        }
        return { node, url, publicUrl, app, httpServer, close, shutdown: close };
    });
}
async function runNodeProcess(deps) {
    const host = await createServiceNodeHost(deps);
    const signals = (0, host_lifecycle_1.installServiceSignals)({ close: host.close });
    host.httpServer.once('close', function hostClosed() { void signals.close().catch(function failed() { }); });
    return { ...host, close: signals.close, shutdown: signals.close };
}
