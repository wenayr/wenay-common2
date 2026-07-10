"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rpc = rpc;
exports.createRpcClientHub = createRpcClientHub;
const rpc_client_1 = require("./rpc-client");
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
    let resolveFunc = null;
    let promise = new Promise((resolve) => {
        resolveFunc = resolve;
    });
    function setToken(token) {
        const hadSocket = socket != null;
        socket?.disconnect?.();
        for (const key in schema)
            facade[key]?.dispose?.("token rotated", { socketAlive: false });
        if (hadSocket)
            onDisconnectCb?.("token rotated");
        if (!resolveFunc)
            promise = new Promise((resolve) => { resolveFunc = resolve; });
        currentToken = token;
        socket = createSocket(token);
        for (const key in schema) {
            const targetSocketKey = schema[key].socketKey || key;
            const client = (0, rpc_client_1.createRpcClient)({ socketKey: targetSocketKey, socket, token, opt: hubOpts?.opt });
            facade[key] = client;
        }
        function hi() {
            for (const key in schema) {
                const client = facade[key];
                if (client && typeof client.initStrict === "function") {
                    client.initStrict();
                }
            }
        }
        socket?.on("connect", () => {
            connectCount++;
            hi();
            onConnectCb?.(connectCount);
            if (resolveFunc) {
                const a = resolveFunc;
                resolveFunc = null;
                a(facade);
            }
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
    const result = {
        get promise() { return promise; },
        facade,
        setToken,
        connect: setToken,
        reauth,
        get socket() { return socket; },
        onConnect: (func) => { onConnectCb = func ?? null; },
        onDisconnect: (func) => { onDisconnectCb = func ?? null; },
        connectCount: () => connectCount,
    };
    return result;
}
