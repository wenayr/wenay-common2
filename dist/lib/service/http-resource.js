"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHostResource = createHostResource;
const express_1 = __importDefault(require("express"));
const node_http_1 = require("node:http");
const socket_io_1 = require("socket.io");
function createHostResource(deps) {
    const closeTimeoutMs = deps.closeTimeoutMs ?? 1000;
    if (!Number.isInteger(deps.port) || deps.port < 0 || deps.port > 65535)
        throw new Error('invalid HTTP port');
    if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs < 0)
        throw new Error('invalid HTTP close timeout');
    const app = (0, express_1.default)();
    const server = (0, node_http_1.createServer)(app);
    function allowOrigin(origin) {
        const allowed = deps.origins?.() ?? (address ? [address] : []);
        return origin == undefined || allowed == true || allowed.includes(origin);
    }
    const io = new socket_io_1.Server(server, {
        ...deps.socket,
        cors: { origin: (origin, decide) => decide(null, allowOrigin(origin)), methods: ['GET', 'POST'] },
        allowRequest: (req, decide) => decide(null, allowOrigin(req.headers.origin)),
    });
    app.use(function cors(req, res, next) {
        const origin = req.get('origin');
        res.vary('Origin');
        if (origin && allowOrigin(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Id');
        }
        if (req.method == 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    });
    const sockets = new Set();
    let binding;
    let bindingPending = false;
    let closing;
    let closed = false;
    let address;
    server.on('connection', function connected(socket) {
        sockets.add(socket);
        socket.once('close', function disconnected() { sockets.delete(socket); });
    });
    function listen() {
        if (closed)
            return Promise.reject(new Error('HTTP host is closed'));
        if (binding)
            return binding;
        bindingPending = true;
        binding = new Promise(function bind(resolve, reject) {
            function failed(error) {
                bindingPending = false;
                server.off('listening', ready);
                reject(error);
            }
            function ready() {
                bindingPending = false;
                server.off('error', failed);
                const bound = server.address();
                if (closed)
                    reject(new Error('HTTP host closed while binding'));
                else if (!bound || typeof bound == 'string')
                    reject(new Error('HTTP host has no address'));
                else {
                    const hostname = deps.host ?? 'localhost';
                    address = 'http://' + (hostname.includes(':') ? '[' + hostname + ']' : hostname) + ':' + bound.port;
                    resolve();
                }
            }
            server.once('error', failed);
            server.once('listening', ready);
            try {
                server.listen(deps.port, deps.host);
            }
            catch (error) {
                server.off('error', failed);
                failed(error);
            }
        });
        void binding.catch(function cleanupFailedBind() { void close(); });
        return binding;
    }
    function close() {
        if (closing)
            return closing;
        closed = true;
        address = undefined;
        let resolveClose;
        let rejectClose;
        closing = new Promise(function completion(resolve, reject) {
            resolveClose = resolve;
            rejectClose = reject;
        });
        void shutdown().then(resolveClose, rejectClose);
        return closing;
    }
    async function shutdown() {
        if (bindingPending)
            await binding?.catch(function ignoreBindFailure() { });
        const deadline = setTimeout(function destroyRemainingConnections() {
            for (const socket of sockets)
                socket.destroy();
        }, closeTimeoutMs);
        try {
            await io.close();
        }
        finally {
            clearTimeout(deadline);
            for (const socket of sockets)
                socket.destroy();
        }
    }
    function url() {
        if (!address)
            throw new Error('HTTP host is not listening');
        return address;
    }
    return { resource: { app, io, server }, control: { listen }, view: { url }, close };
}
