"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInProcSocketPair = createInProcSocketPair;
exports.createRpcInProc = createRpcInProc;
const rpc_server_1 = require("./rpc-server");
const rpc_server_auto_1 = require("./rpc-server-auto");
const rpc_client_1 = require("./rpc-client");
function createInProcSocketPair() {
    const A = {};
    const B = {};
    const make = (mine, theirs) => ({
        on: (e, cb) => { (mine[e] ??= []).push(cb); },
        emit: (e, d) => {
            const wire = d === undefined ? undefined : JSON.parse(JSON.stringify(d));
            for (const cb of (theirs[e] ?? []))
                queueMicrotask(() => cb(wire));
        },
    });
    return [make(A, B), make(B, A)];
}
function createRpcInProc({ object: target, socketKey = 'rpc', listen = true, debug, hooks, limits, auth, token, throttle, maxPerListen, opt, }) {
    const [clientSocket, serverSocket] = createInProcSocketPair();
    if (listen) {
        (0, rpc_server_auto_1.createRpcServerAuto)({ socket: serverSocket, object: target, socketKey, debug, hooks, limits, auth, throttle, maxPerListen, opt });
    }
    else {
        (0, rpc_server_1.createRpcServer)({ socket: serverSocket, object: target, socketKey, debug, hooks: hooks, limits, auth, opt });
    }
    return (0, rpc_client_1.createRpcClient)({ socket: clientSocket, socketKey, limits, token, opt });
}
