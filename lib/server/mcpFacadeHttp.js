"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMcpFacadeHttp = createMcpFacadeHttp;
exports.serveMcpStdio = serveMcpStdio;
const node_crypto_1 = require("node:crypto");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const Listen_1 = require("../Common/events/Listen");
function createSessionEvent(id, principal, reason) {
    return { id, principal, ...(reason != null ? { reason } : {}) };
}
class HttpReplyError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'HttpReplyError';
    }
}
function replyJsonRpcError(res, status, message, code = -32000) {
    if (res.headersSent)
        return;
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}
function bearerToken(req) {
    const header = req.headers.authorization;
    if (typeof header != 'string' || !header.startsWith('Bearer '))
        return null;
    const token = header.slice('Bearer '.length).trim();
    return token == '' ? null : token;
}
function principalKey(grant, token) {
    const sub = grant?.principal?.sub;
    if (typeof sub == 'string')
        return `sub:${sub}`;
    if (token == null)
        return 'anonymous';
    return `token:${(0, node_crypto_1.createHash)('sha256').update(token).digest('hex')}`;
}
function readJsonBody(req, limit) {
    return new Promise(function readBody(resolve, reject) {
        const chunks = [];
        let size = 0;
        req.on('data', function collectChunk(chunk) {
            size += chunk.length;
            if (size > limit) {
                reject(new HttpReplyError(413, `MCP request body exceeds ${limit} bytes`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', function parseBody() {
            const text = Buffer.concat(chunks).toString('utf8');
            if (text == '')
                return resolve(undefined);
            try {
                resolve(JSON.parse(text));
            }
            catch {
                reject(new HttpReplyError(400, 'MCP request body is not valid JSON'));
            }
        });
        req.on('error', reject);
    });
}
function createMcpFacadeHttp(options) {
    const { app, mcp, auth } = options;
    if (typeof options.path != 'string' || !options.path.startsWith('/'))
        throw new Error('MCP HTTP path must start with /');
    const mode = options.mode ?? 'stateful';
    if (mode != 'stateful' && mode != 'stateless')
        throw new Error(`MCP HTTP mode must be stateful or stateless, got ${String(mode)}`);
    const maxSessions = options.maxSessions ?? 32;
    const ttl = options.sessionTtlMs ?? 30 * 60_000;
    const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
    for (const [name, value] of [['maxSessions', maxSessions], ['sessionTtlMs', ttl], ['maxBodyBytes', maxBodyBytes]]) {
        if (!Number.isSafeInteger(value) || value <= 0)
            throw new Error(`MCP HTTP ${name} must be a positive integer`);
    }
    const now = options.now ?? Date.now;
    const middleware = options.middleware == null
        ? []
        : Array.isArray(options.middleware) ? [...options.middleware] : [options.middleware];
    const sessions = new Map();
    const all = new Set();
    const [emitOpened, opened] = (0, Listen_1.listen)();
    const [emitClosed, closed] = (0, Listen_1.listen)();
    let disposed = false;
    async function endSession(session, reason, closeServer) {
        if (session.closed)
            return;
        session.closed = true;
        all.delete(session);
        if (session.id)
            sessions.delete(session.id);
        if (closeServer)
            try {
                await session.server.close();
            }
            catch { }
        if (session.id)
            emitClosed(createSessionEvent(session.id, session.principal, reason));
    }
    async function terminate(id) {
        const session = sessions.get(id);
        if (!session)
            return false;
        await endSession(session, 'terminated', true);
        return true;
    }
    function evictIdle() {
        const deadline = now() - ttl;
        for (const session of [...all]) {
            if (session.active == 0 && session.lastSeenAt < deadline)
                void endSession(session, 'idle', true);
        }
    }
    const sweep = setInterval(evictIdle, Math.min(ttl, 60_000));
    sweep.unref?.();
    async function authorize(req) {
        if (!auth)
            return { grant: undefined, token: null };
        const token = bearerToken(req);
        if (token == null)
            throw new HttpReplyError(401, 'Missing bearer token');
        let grant;
        try {
            grant = await auth.resolveAuth(token, req);
        }
        catch {
            throw new HttpReplyError(401, 'Unauthorized');
        }
        if (grant?.expiresAt !== undefined && !(grant.expiresAt == Infinity || grant.expiresAt > now())) {
            throw new HttpReplyError(401, 'Token expired');
        }
        return { grant, token };
    }
    function surfaceFor(grant) {
        return grant?.object ? mcp.control.derive(grant.object) : mcp;
    }
    async function handleStateful(req, res, body, grant, token) {
        const header = req.headers['mcp-session-id'];
        const key = principalKey(grant, token);
        if (typeof header == 'string') {
            const session = sessions.get(header);
            if (!session)
                return replyJsonRpcError(res, 404, 'Unknown MCP session; initialize a new one', -32001);
            if (session.principalKey != key)
                return replyJsonRpcError(res, 403, 'This MCP session belongs to another principal');
            session.lastSeenAt = now();
            session.active++;
            res.once('close', function releaseRequest() {
                session.active--;
                session.lastSeenAt = now();
            });
            await session.transport.handleRequest(req, res, body);
            return;
        }
        if (req.method != 'POST' || !(0, types_js_1.isInitializeRequest)(body)) {
            return replyJsonRpcError(res, 400, 'No MCP session: send initialize first');
        }
        evictIdle();
        if (all.size >= maxSessions) {
            return replyJsonRpcError(res, 503, `MCP session limit reached (${maxSessions}); terminate sessions or raise maxSessions`);
        }
        const surface = surfaceFor(grant);
        const attach = { principal: grant?.principal };
        const server = surface.control.server(attach);
        const session = {
            id: '',
            server,
            transport: undefined,
            principal: grant?.principal,
            principalKey: key,
            createdAt: now(),
            lastSeenAt: now(),
            active: 1,
            closed: false,
        };
        session.transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
            sessionIdGenerator: node_crypto_1.randomUUID,
            enableJsonResponse: options.enableJsonResponse,
            onsessioninitialized: function registerSession(id) {
                session.id = id;
                sessions.set(id, session);
                emitOpened(createSessionEvent(id, session.principal));
            },
            onsessionclosed: function clientEndedSession() { return endSession(session, 'client', false); },
        });
        const detachOnClose = server.onclose;
        server.onclose = function forgetClosedSession() {
            detachOnClose?.();
            void endSession(session, 'closed', false);
        };
        all.add(session);
        res.once('close', function releaseInitialize() {
            session.active--;
            session.lastSeenAt = now();
        });
        try {
            await server.connect(session.transport);
            await session.transport.handleRequest(req, res, body);
        }
        finally {
            if (!session.id)
                await endSession(session, 'initialize failed', true);
        }
    }
    async function handleStateless(req, res, body, grant) {
        if (req.method != 'POST')
            return replyJsonRpcError(res, 405, 'Stateless MCP endpoint accepts POST only');
        const server = surfaceFor(grant).control.server({ principal: grant?.principal });
        const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: options.enableJsonResponse,
        });
        res.once('close', function closeRequestServer() { void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
    }
    async function handleMcpRequest(req, res) {
        try {
            if (disposed)
                return replyJsonRpcError(res, 503, 'MCP endpoint is closed');
            const { grant, token } = await authorize(req);
            const body = req.method != 'POST' ? undefined
                : req.body !== undefined ? req.body : await readJsonBody(req, maxBodyBytes);
            if (mode == 'stateless')
                await handleStateless(req, res, body, grant);
            else
                await handleStateful(req, res, body, grant, token);
        }
        catch (error) {
            if (error instanceof HttpReplyError) {
                if (error.status == 401)
                    res.setHeader('WWW-Authenticate', 'Bearer');
                return replyJsonRpcError(res, error.status, error.message);
            }
            replyJsonRpcError(res, 500, 'Internal MCP server error', -32603);
        }
    }
    app.post(options.path, ...middleware, handleMcpRequest);
    app.get(options.path, ...middleware, handleMcpRequest);
    app.delete(options.path, ...middleware, handleMcpRequest);
    async function dispose() {
        if (disposed)
            return;
        disposed = true;
        clearInterval(sweep);
        await Promise.allSettled([...all].map(session => endSession(session, 'disposed', true)));
        opened.close();
        closed.close();
    }
    return {
        sessions: {
            list: () => [...sessions.values()].map(session => ({
                id: session.id,
                principal: session.principal,
                createdAt: session.createdAt,
                lastSeenAt: session.lastSeenAt,
                active: session.active,
            })),
            count: () => all.size,
        },
        control: {
            terminate,
            evictIdle,
            dispose,
        },
        on: {
            opened: opened.on,
            closed: closed.on,
        },
    };
}
async function serveMcpStdio(mcp, session = {}) {
    const server = mcp.control.server(session);
    await server.connect(new stdio_js_1.StdioServerTransport());
    return {
        server,
        close: () => server.close(),
    };
}
