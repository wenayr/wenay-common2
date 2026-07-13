"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rpc = rpc;
exports.createRpcClientHub = createRpcClientHub;
const rpc_client_1 = require("./rpc-client");
const transport_lifecycle_1 = require("../events/transport-lifecycle");
function rpc(socketKey) {
    return { socketKey };
}
function createRpcClientHub(createSocket, schemaBuilder, hubOpts) {
    const schema = schemaBuilder(rpc);
    const facade = {};
    let socket = null;
    let currentToken = null;
    let connectCount = 0;
    let onConnectCb = null;
    let onDisconnectCb = null;
    const connectCbs = new Set();
    const disconnectCbs = new Set();
    let activeContext = null;
    let resolveFunc = null;
    let promise = new Promise((resolve) => {
        resolveFunc = resolve;
    });
    function callObserver(cb, value, errors) {
        try {
            cb(value);
        }
        catch (error) {
            errors.push(error);
        }
    }
    function rethrowObserverErrors(errors) {
        for (const error of errors) {
            setTimeout(function rethrowLifecycleObserverError() { throw error; }, 0);
        }
    }
    function notifyConnect(count) {
        const errors = [];
        const legacy = onConnectCb;
        if (legacy)
            callObserver(legacy, count, errors);
        for (const cb of [...connectCbs])
            callObserver(cb, count, errors);
        rethrowObserverErrors(errors);
    }
    function notifyDisconnect(context, reason) {
        if (context.disconnectNotified)
            return;
        context.disconnectNotified = true;
        const errors = [];
        const legacy = onDisconnectCb;
        if (legacy)
            callObserver(legacy, reason, errors);
        for (const cb of [...disconnectCbs])
            callObserver(cb, reason, errors);
        rethrowObserverErrors(errors);
    }
    function closeContext(context, reason) {
        if (context.terminal)
            return;
        context.terminal = true;
        context.connected = false;
        context.attempt++;
        for (const client of context.clients)
            client[transport_lifecycle_1.RPC_TRANSPORT_CONTROL]?.close(reason);
        for (const client of context.clients)
            client.dispose?.(reason, { socketAlive: false });
        context.socket.disconnect?.();
        notifyDisconnect(context, reason);
    }
    async function handshakeAndConnect(context, attempt, count) {
        await Promise.all(context.clients.map(function initClient(client) {
            return client.initStrict?.();
        }));
        if (activeContext != context || context.terminal || !context.connected || context.attempt != attempt)
            return;
        for (const client of context.clients)
            client[transport_lifecycle_1.RPC_TRANSPORT_CONTROL]?.connect();
        if (activeContext != context || context.terminal || !context.connected || context.attempt != attempt)
            return;
        notifyConnect(count);
        if (activeContext != context || context.terminal || !context.connected || context.attempt != attempt)
            return;
        if (resolveFunc) {
            const resolve = resolveFunc;
            resolveFunc = null;
            resolve(facade);
        }
    }
    function setToken(token) {
        if (activeContext)
            closeContext(activeContext, 'token rotated');
        if (!resolveFunc)
            promise = new Promise((resolve) => { resolveFunc = resolve; });
        currentToken = token;
        const nextSocket = createSocket(token);
        socket = nextSocket;
        const clients = [];
        for (const key in schema) {
            const targetSocketKey = schema[key].socketKey || key;
            const client = (0, rpc_client_1.createRpcClient)({ socketKey: targetSocketKey, socket: nextSocket, token, opt: hubOpts?.opt });
            const transportClient = client;
            transportClient[transport_lifecycle_1.RPC_TRANSPORT_CONTROL]?.disconnect('RPC hub awaiting handshake');
            facade[key] = client;
            clients.push(transportClient);
        }
        const context = {
            socket: nextSocket,
            clients,
            connected: false,
            terminal: false,
            attempt: 0,
            disconnectNotified: false,
        };
        activeContext = context;
        nextSocket.on('connect', function onSocketConnect() {
            if (activeContext != context || context.terminal)
                return;
            context.connected = true;
            context.disconnectNotified = false;
            const attempt = ++context.attempt;
            const count = ++connectCount;
            handshakeAndConnect(context, attempt, count).catch(function reportHandshakeError(error) {
                if (activeContext != context || context.terminal || context.attempt != attempt)
                    return;
                setTimeout(function rethrowHandshakeError() { throw error; }, 0);
            });
        });
        nextSocket.on('disconnect', function onSocketDisconnect(reason) {
            if (activeContext != context || context.terminal || !context.connected)
                return;
            context.connected = false;
            context.attempt++;
            const disconnectReason = typeof reason == 'string' ? reason : String(reason ?? 'socket disconnected');
            for (const client of context.clients)
                client[transport_lifecycle_1.RPC_TRANSPORT_CONTROL]?.disconnect(disconnectReason);
            notifyDisconnect(context, disconnectReason);
        });
        return promise;
    }
    function reauth(token) {
        currentToken = token;
        const ps = [];
        for (const key in schema) {
            const client = facade[key];
            if (client && typeof client.reauth === "function")
                ps.push(client.reauth(token));
        }
        return Promise.all(ps);
    }
    function connectListen(cb) {
        connectCbs.add(cb);
        return function offConnect() { connectCbs.delete(cb); };
    }
    function disconnectListen(cb) {
        disconnectCbs.add(cb);
        return function offDisconnect() { disconnectCbs.delete(cb); };
    }
    const result = {
        get promise() { return promise; },
        facade,
        setToken,
        connect: setToken,
        reauth,
        get socket() { return socket; },
        onConnect: (func) => { onConnectCb = func ?? null; },
        onDisconnect: (func) => { onDisconnectCb = func ?? null; },
        connectListen,
        disconnectListen,
        connectCount: () => connectCount,
    };
    return result;
}
