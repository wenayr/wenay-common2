// ============================================================
//  src/server/mcpFacadeHttp.ts  (wenay-common2/server/mcp)
//
//  Transports for a facade MCP server: Streamable HTTP mounted on the same Express app as
//  createHttpFacadeServer (stateful sessions or stateless per request), and stdio.
//
//  A stateful session is a registry entry, not a connection. Closing a transport ends its
//  streams and nothing else; a session ends when the client DELETEs it, when it idles past
//  its TTL, or when the host terminates it — each path removes the entry and closes the SDK
//  server. A registry that waited for transports to close filled up and refused everyone.
//
//  Auth mirrors RPC (doc/RPC-AUTH.md): resolveAuth(token) -> {object} gives the principal its
//  own facade; the bearer token comes from the Authorization header on every request, and a
//  session stays bound to the principal that opened it.
// ============================================================

import {createHash, randomUUID} from 'node:crypto'

import type {Request, RequestHandler, Response} from 'express'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js'

import {listen} from '../Common/events/Listen'
import type {McpAttachSession, McpFacadeServer, McpFacadeSurface, McpServerLike} from './mcpFacadeServer'

export type McpAuthGrant = {
    /** The principal's facade; absent = the facade server's own object. */
    object?: object
    /** Reaches tools (context.principal) and middleware (ctx.principal); a `sub` binds sessions. */
    principal?: unknown
    /** Absolute ms deadline; Infinity = none, any other non-finite value fails closed. */
    expiresAt?: number
}

export type McpFacadeHttpOptions = {
    app: {
        post: (path: string, ...handlers: RequestHandler[]) => unknown
        get: (path: string, ...handlers: RequestHandler[]) => unknown
        delete: (path: string, ...handlers: RequestHandler[]) => unknown
    }
    /** Endpoint path, e.g. '/mcp'. */
    path: string
    mcp: McpFacadeServer
    /** 'stateful' (default): sessions with ids; 'stateless': a fresh server per request. */
    mode?: 'stateful' | 'stateless'
    /** Concurrent stateful sessions, pending ones included; default 32. */
    maxSessions?: number
    /** A session idle this long is terminated; default 30 minutes. */
    sessionTtlMs?: number
    /** Body cap when no JSON parser ran before the endpoint; default 1 MB. */
    maxBodyBytes?: number
    middleware?: RequestHandler | readonly RequestHandler[]
    auth?: {
        resolveAuth: (token: string, req: Request) => McpAuthGrant | Promise<McpAuthGrant>
    }
    /** Plain JSON responses instead of SSE streams for request/response calls. */
    enableJsonResponse?: boolean
    now?: () => number
}

type tSession = {
    id: string
    server: McpServerLike
    transport: StreamableHTTPServerTransport
    principal: unknown
    principalKey: string
    createdAt: number
    lastSeenAt: number
    active: number
    closed: boolean
}

function createSessionEvent(id: string, principal: unknown, reason?: string) {
    return {id, principal, ...(reason != null ? {reason} : {})}
}

export type McpSessionEvent = ReturnType<typeof createSessionEvent>

class HttpReplyError extends Error {
    constructor(readonly status: number, message: string) {
        super(message)
        this.name = 'HttpReplyError'
    }
}

// ===================================================================
// request helpers
// ===================================================================

function replyJsonRpcError(res: Response, status: number, message: string, code = -32000) {
    if (res.headersSent) return
    res.status(status).json({jsonrpc: '2.0', error: {code, message}, id: null})
}

function bearerToken(req: Request) {
    const header = req.headers.authorization
    if (typeof header != 'string' || !header.startsWith('Bearer ')) return null
    const token = header.slice('Bearer '.length).trim()
    return token == '' ? null : token
}

function principalKey(grant: McpAuthGrant | undefined, token: string | null) {
    const sub = (grant?.principal as {sub?: unknown} | undefined)?.sub
    if (typeof sub == 'string') return `sub:${sub}`
    if (token == null) return 'anonymous'
    return `token:${createHash('sha256').update(token).digest('hex')}`
}

function readJsonBody(req: Request, limit: number) {
    return new Promise<unknown>(function readBody(resolve, reject) {
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', function collectChunk(chunk: Buffer) {
            size += chunk.length
            if (size > limit) {
                reject(new HttpReplyError(413, `MCP request body exceeds ${limit} bytes`))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', function parseBody() {
            const text = Buffer.concat(chunks).toString('utf8')
            if (text == '') return resolve(undefined)
            try { resolve(JSON.parse(text)) }
            catch { reject(new HttpReplyError(400, 'MCP request body is not valid JSON')) }
        })
        req.on('error', reject)
    })
}

// ===================================================================
// Streamable HTTP
// ===================================================================

export function createMcpFacadeHttp(options: McpFacadeHttpOptions) {
    const {app, mcp, auth} = options
    if (typeof options.path != 'string' || !options.path.startsWith('/')) throw new Error('MCP HTTP path must start with /')
    const mode = options.mode ?? 'stateful'
    if (mode != 'stateful' && mode != 'stateless') throw new Error(`MCP HTTP mode must be stateful or stateless, got ${String(mode)}`)
    const maxSessions = options.maxSessions ?? 32
    const ttl = options.sessionTtlMs ?? 30 * 60_000
    const maxBodyBytes = options.maxBodyBytes ?? 1_000_000
    for (const [name, value] of [['maxSessions', maxSessions], ['sessionTtlMs', ttl], ['maxBodyBytes', maxBodyBytes]] as const) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`MCP HTTP ${name} must be a positive integer`)
    }
    const now = options.now ?? Date.now
    const middleware = options.middleware == null
        ? []
        : Array.isArray(options.middleware) ? [...options.middleware] : [options.middleware as RequestHandler]

    const sessions = new Map<string, tSession>()
    const all = new Set<tSession>()
    const [emitOpened, opened] = listen<McpSessionEvent>()
    const [emitClosed, closed] = listen<McpSessionEvent>()
    let disposed = false

    // ============== session lifecycle ==============

    /** closeServer = false when the transport is already closing itself (client DELETE, onclose). */
    async function endSession(session: tSession, reason: string, closeServer: boolean) {
        if (session.closed) return
        session.closed = true
        all.delete(session)
        if (session.id) sessions.delete(session.id)
        // server.close() closes the transport; attach's onclose then releases subscriptions
        if (closeServer) try { await session.server.close() } catch {}
        if (session.id) emitClosed(createSessionEvent(session.id, session.principal, reason))
    }

    async function terminate(id: string) {
        const session = sessions.get(id)
        if (!session) return false
        await endSession(session, 'terminated', true)
        return true
    }

    function evictIdle() {
        const deadline = now() - ttl
        for (const session of [...all]) {
            if (session.active == 0 && session.lastSeenAt < deadline) void endSession(session, 'idle', true)
        }
    }
    const sweep = setInterval(evictIdle, Math.min(ttl, 60_000))
    sweep.unref?.()

    // ============== auth ==============

    async function authorize(req: Request) {
        if (!auth) return {grant: undefined, token: null}
        const token = bearerToken(req)
        if (token == null) throw new HttpReplyError(401, 'Missing bearer token')
        let grant: McpAuthGrant
        try {
            grant = await auth.resolveAuth(token, req)
        } catch {
            throw new HttpReplyError(401, 'Unauthorized')
        }
        // fails closed like RPC: Infinity = no deadline, NaN/undefined arithmetic = expired
        if (grant?.expiresAt !== undefined && !(grant.expiresAt == Infinity || grant.expiresAt > now())) {
            throw new HttpReplyError(401, 'Token expired')
        }
        return {grant, token}
    }

    function surfaceFor(grant: McpAuthGrant | undefined): McpFacadeSurface {
        return grant?.object ? mcp.control.derive(grant.object) : mcp
    }

    // ============== handlers ==============

    async function handleStateful(req: Request, res: Response, body: unknown, grant: McpAuthGrant | undefined, token: string | null) {
        const header = req.headers['mcp-session-id']
        const key = principalKey(grant, token)
        if (typeof header == 'string') {
            const session = sessions.get(header)
            if (!session) return replyJsonRpcError(res, 404, 'Unknown MCP session; initialize a new one', -32001)
            if (session.principalKey != key) return replyJsonRpcError(res, 403, 'This MCP session belongs to another principal')
            session.lastSeenAt = now()
            session.active++
            res.once('close', function releaseRequest() {
                session.active--
                session.lastSeenAt = now()
            })
            await session.transport.handleRequest(req, res, body)
            return
        }
        if (req.method != 'POST' || !isInitializeRequest(body)) {
            return replyJsonRpcError(res, 400, 'No MCP session: send initialize first')
        }
        evictIdle()
        if (all.size >= maxSessions) {
            return replyJsonRpcError(res, 503, `MCP session limit reached (${maxSessions}); terminate sessions or raise maxSessions`)
        }

        const surface = surfaceFor(grant)
        const attach: McpAttachSession = {principal: grant?.principal}
        const server = surface.control.server(attach)
        const session: tSession = {
            id: '',
            server,
            transport: undefined as unknown as StreamableHTTPServerTransport,
            principal: grant?.principal,
            principalKey: key,
            createdAt: now(),
            lastSeenAt: now(),
            active: 1,
            closed: false,
        }
        session.transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableJsonResponse: options.enableJsonResponse,
            onsessioninitialized: function registerSession(id) {
                session.id = id
                sessions.set(id, session)
                emitOpened(createSessionEvent(id, session.principal))
            },
            // a client DELETE terminates the session, not just its transport
            onsessionclosed: function clientEndedSession() { return endSession(session, 'client', false) },
        })
        const detachOnClose = server.onclose
        server.onclose = function forgetClosedSession() {
            detachOnClose?.()
            void endSession(session, 'closed', false)
        }
        all.add(session)
        res.once('close', function releaseInitialize() {
            session.active--
            session.lastSeenAt = now()
        })
        try {
            await server.connect(session.transport)
            await session.transport.handleRequest(req, res, body)
        } finally {
            if (!session.id) await endSession(session, 'initialize failed', true)
        }
    }

    async function handleStateless(req: Request, res: Response, body: unknown, grant: McpAuthGrant | undefined) {
        if (req.method != 'POST') return replyJsonRpcError(res, 405, 'Stateless MCP endpoint accepts POST only')
        const server = surfaceFor(grant).control.server({principal: grant?.principal})
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: options.enableJsonResponse,
        })
        res.once('close', function closeRequestServer() { void server.close() })
        await server.connect(transport)
        await transport.handleRequest(req, res, body)
    }

    async function handleMcpRequest(req: Request, res: Response) {
        try {
            if (disposed) return replyJsonRpcError(res, 503, 'MCP endpoint is closed')
            const {grant, token} = await authorize(req)
            const body = req.method != 'POST' ? undefined
                : req.body !== undefined ? req.body : await readJsonBody(req, maxBodyBytes)
            if (mode == 'stateless') await handleStateless(req, res, body, grant)
            else await handleStateful(req, res, body, grant, token)
        } catch (error) {
            if (error instanceof HttpReplyError) {
                if (error.status == 401) res.setHeader('WWW-Authenticate', 'Bearer')
                return replyJsonRpcError(res, error.status, error.message)
            }
            replyJsonRpcError(res, 500, 'Internal MCP server error', -32603)
        }
    }

    app.post(options.path, ...middleware, handleMcpRequest as RequestHandler)
    app.get(options.path, ...middleware, handleMcpRequest as RequestHandler)
    app.delete(options.path, ...middleware, handleMcpRequest as RequestHandler)

    async function dispose() {
        if (disposed) return
        disposed = true
        clearInterval(sweep)
        await Promise.allSettled([...all].map(session => endSession(session, 'disposed', true)))
        opened.close()
        closed.close()
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
            /** Live and initializing sessions: what maxSessions counts. */
            count: () => all.size,
        },
        control: {
            /** Ends the session: registry entry, SDK server and transport. A later request with its id gets 404. */
            terminate,
            /** Terminates idle sessions now (the sweep also runs on a timer). */
            evictIdle,
            /** Terminates every session and refuses new requests with 503. */
            dispose,
        },
        on: {
            opened: opened.on,
            closed: closed.on,
        },
    }
}

export type McpFacadeHttp = ReturnType<typeof createMcpFacadeHttp>

// ===================================================================
// stdio
// ===================================================================

/** One session over this process's stdin/stdout. */
export async function serveMcpStdio(mcp: McpFacadeSurface, session: McpAttachSession = {}) {
    const server = mcp.control.server(session)
    await server.connect(new StdioServerTransport())
    return {
        server,
        close: () => server.close(),
    }
}
