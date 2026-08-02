import {randomUUID, timingSafeEqual} from 'node:crypto'
import {createServer, type Server as HttpServer} from 'node:http'
import type {AddressInfo} from 'node:net'

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {localhostHostValidation} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, {type NextFunction, type Request, type Response} from 'express'
import * as z from 'zod/v4'

import type {ModuleControlPort} from './module-control'
import type {McpContributionGateway} from './mcp-contribution-gateway'

export const DYNAMIC_RUNTIME_GUIDE_URI = 'wenay://dynamic-runtime/guide'
export const DYNAMIC_RUNTIME_PROMPT_URI = 'wenay://dynamic-runtime/implementation-prompt'

type ServerSession = {
    server: McpServer
    transport: StreamableHTTPServerTransport
    close: () => Promise<void>
}

export type ModuleControlMcpDeps = {
    moduleControl: ModuleControlPort
    bearerToken: string
    host?: '127.0.0.1'
    endpointPath?: `/${string}`
    shutdownTimeoutMs?: number
    contributionGateway?: McpContributionGateway
}

export type ModuleControlMcpClientDeps = {
    endpoint: URL
    bearerToken: string
}

// ===================================================================
// domain-to-MCP adapter
// ===================================================================

function toolContent(value: unknown) {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify(value, null, 2) ?? 'null',
        }],
    }
}

function toolError(error: unknown) {
    const code = typeof (error as any)?.code == 'string'
        ? String((error as any).code)
        : 'E_MODULE_CONTROL'
    return {
        isError: true,
        content: [{
            type: 'text' as const,
            text: JSON.stringify({
                ok: false,
                error: {
                    code,
                    message: code == 'E_MODULE_CONTROL'
                        ? 'Module control command failed'
                        : 'Module control command was rejected',
                    retryable: false,
                },
            }),
        }],
    }
}

async function callTool(call: () => unknown | Promise<unknown>) {
    try {
        return toolContent(await call())
    } catch (error) {
        return toolError(error)
    }
}

export function createModuleControlMcpServer(deps: {
    moduleControl: ModuleControlPort
    contributionGateway?: McpContributionGateway
}) {
    const {moduleControl} = deps
    const server = new McpServer({
        name: 'wenay-dynamic-runtime-control',
        version: '0.1.0-experiment',
    })

    server.registerTool('module.stage', {
        description: 'Stage an immutable module candidate. This does not activate it.',
        inputSchema: {
            slotId: z.string().min(1),
            moduleId: z.string().min(1),
            version: z.string().min(1),
            artifactRef: z.string().min(1),
            commandId: z.string().min(1),
            correlationId: z.string().min(1),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
        },
    }, async function stageTool(request) {
        return await callTool(() => moduleControl.control.stage(request))
    })

    server.registerTool('module.activate', {
        description: 'Atomically activate one previously staged candidate.',
        inputSchema: {
            slotId: z.string().min(1),
            moduleId: z.string().min(1),
            candidateId: z.string().min(1),
            commandId: z.string().min(1),
            correlationId: z.string().min(1),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
        },
    }, async function activateTool(request) {
        return await callTool(() => moduleControl.control.activate(request))
    })

    server.registerTool('module.rollback', {
        description: 'Activate a previously verified version as a new binding generation.',
        inputSchema: {
            slotId: z.string().min(1),
            moduleId: z.string().min(1),
            targetVersion: z.string().min(1).optional(),
            commandId: z.string().min(1),
            correlationId: z.string().min(1),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
        },
    }, async function rollbackTool(request) {
        return await callTool(() => moduleControl.control.rollback(request))
    })

    server.registerTool('module.explain', {
        description: 'Explain candidates, active generation, and activation facts for a module.',
        inputSchema: {
            slotId: z.string().min(1),
            moduleId: z.string().min(1),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
    }, async function explainTool(request) {
        return await callTool(() => moduleControl.view.explain(request.slotId, request.moduleId))
    })

    server.registerTool('module.health', {
        description: 'Read a synchronous health snapshot for one module or the active runtime.',
        inputSchema: {
            slotId: z.string().min(1).optional(),
            moduleId: z.string().min(1).optional(),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
    }, async function healthTool(request) {
        return await callTool(() => moduleControl.health.snapshot(request.slotId, request.moduleId))
    })

    server.registerResource('dynamic-runtime-guide', DYNAMIC_RUNTIME_GUIDE_URI, {
        title: 'Dynamic runtime architecture',
        description: 'Versioned architecture guide for safe dynamic module replacement.',
        mimeType: 'text/markdown',
    }, async function readGuide(uri) {
        return {
            contents: [{
                uri: uri.href,
                mimeType: 'text/markdown',
                text: await moduleControl.resource.guide(),
            }],
        }
    })

    server.registerResource('dynamic-runtime-implementation-prompt', DYNAMIC_RUNTIME_PROMPT_URI, {
        title: 'Dynamic runtime implementation prompt',
        description: 'Versioned implementation instructions for a separately authorized task.',
        mimeType: 'text/markdown',
    }, async function readImplementationPrompt(uri) {
        return {
            contents: [{
                uri: uri.href,
                mimeType: 'text/markdown',
                text: await moduleControl.resource.implementationPrompt(),
            }],
        }
    })

    for (const tool of deps.contributionGateway?.view.catalog().tools ?? []) {
        server.registerTool(tool.name, {
            title: tool.descriptor.title,
            description: tool.descriptor.description,
            inputSchema: {
                input: z.unknown().optional(),
                correlationId: z.string().min(1).optional(),
            },
            annotations: tool.descriptor.annotations,
            _meta: {
                'wenay/sourceId': tool.sourceId,
                'wenay/registrationId': tool.registrationId,
                'wenay/lifetime': tool.descriptor.lifetime,
            },
        }, async function contributionTool(request, context) {
            return await callTool(() => deps.contributionGateway!.resource.invoke(
                tool.name,
                request.input,
                {
                    correlationId: request.correlationId ?? 'mcp-' + randomUUID(),
                    signal: context.signal,
                },
            ))
        })
    }

    return server
}

export type ModuleControlMcpServer = ReturnType<typeof createModuleControlMcpServer>

// ===================================================================
// loopback Streamable HTTP host
// ===================================================================

function tokenMatches(actualHeader: unknown, expectedToken: string) {
    if (typeof actualHeader != 'string' || !actualHeader.startsWith('Bearer ')) return false
    const actual = Buffer.from(actualHeader.slice('Bearer '.length))
    const expected = Buffer.from(expectedToken)
    return actual.length == expected.length && timingSafeEqual(actual, expected)
}

function originAllowed(req: Request) {
    const origin = req.header('origin')
    if (origin == null) return true
    const port = req.socket.localPort
    return origin == `http://127.0.0.1:${port}` || origin == `http://localhost:${port}`
}

function writeUnauthorized(res: Response) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="wenay-dynamic-runtime-experiment"')
    res.status(401).json({
        error: 'unauthorized',
    })
}

function writeMethodNotAllowed(res: Response) {
    res.status(405).json({
        jsonrpc: '2.0',
        error: {
            code: -32000,
            message: 'Method not allowed',
        },
        id: null,
    })
}

function closeHttpServer(server: HttpServer) {
    return new Promise<void>(function waitForClose(resolve, reject) {
        server.close(function onClosed(error) {
            if (error) reject(error)
            else resolve()
        })
    })
}

export function createModuleControlMcp(deps: ModuleControlMcpDeps) {
    if (deps.bearerToken.length < 16) {
        throw new Error('MCP experiment bearer token must contain at least 16 characters')
    }

    const host = deps.host ?? '127.0.0.1'
    const endpointPath = deps.endpointPath ?? '/mcp'
    const shutdownTimeoutMs = Math.max(1, deps.shutdownTimeoutMs ?? 2_000)
    const app = express()
    const sessions = new Set<ServerSession>()

    let httpServer: HttpServer | null = null
    let endpoint: URL | null = null
    let closing = false

    app.use(localhostHostValidation())
    app.all(endpointPath, function authorizeRequest(req: Request, res: Response, next: NextFunction) {
        if (closing) {
            res.status(503).json({error: 'server_closing'})
            return
        }
        if (!originAllowed(req)) {
            res.status(403).json({error: 'origin_forbidden'})
            return
        }
        if (!tokenMatches(req.header('authorization'), deps.bearerToken)) {
            writeUnauthorized(res)
            return
        }
        next()
    })
    app.post(endpointPath, express.json({limit: '256kb'}), async function handleMcpRequest(req, res) {
        const server = createModuleControlMcpServer({
            moduleControl: deps.moduleControl,
            contributionGateway: deps.contributionGateway,
        })
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        })
        let closePromise: Promise<void> | null = null
        const session: ServerSession = {
            server,
            transport,
            close: function closeSession() {
                if (closePromise) return closePromise
                closePromise = releaseSession()
                return closePromise
            },
        }

        async function releaseSession() {
            sessions.delete(session)
            await transport.close()
            await server.close()
        }

        sessions.add(session)
        res.on('close', function releaseClosedResponse() {
            void session.close()
        })

        try {
            await server.connect(transport)
            await transport.handleRequest(req, res, req.body)
        } catch {
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: 'Internal MCP server error',
                    },
                    id: null,
                })
            }
        } finally {
            await session.close()
        }
    })
    app.get(endpointPath, function rejectGet(_req, res) {
        writeMethodNotAllowed(res)
    })
    app.delete(endpointPath, function rejectDelete(_req, res) {
        writeMethodNotAllowed(res)
    })
    app.all(endpointPath, function rejectOtherMethods(_req, res) {
        writeMethodNotAllowed(res)
    })

    async function start(port = 0) {
        if (httpServer) throw new Error('MCP experiment server is already started')
        closing = false
        const nextServer = createServer(app)
        httpServer = nextServer

        await new Promise<void>(function waitForListen(resolve, reject) {
            nextServer.once('error', reject)
            nextServer.listen(port, host, function onListening() {
                nextServer.off('error', reject)
                resolve()
            })
        })

        const address = nextServer.address() as AddressInfo
        endpoint = new URL(`http://${host}:${address.port}${endpointPath}`)
        return new URL(endpoint)
    }

    async function close() {
        closing = true
        const currentServer = httpServer
        httpServer = null
        endpoint = null
        const active = [...sessions]
        sessions.clear()
        const sessionClose = Promise.allSettled(active.map(session => session.close()))
        const serverClose = currentServer ? closeHttpServer(currentServer) : Promise.resolve()
        let timeout: ReturnType<typeof setTimeout> | null = null
        const deadline = new Promise<void>(function forceClose(resolve) {
            timeout = setTimeout(function forceMcpConnectionsClosed() {
                currentServer?.closeAllConnections()
                resolve()
            }, shutdownTimeoutMs)
            timeout.unref?.()
        })
        await Promise.race([
            Promise.allSettled([sessionClose, serverClose]).then(function shutdownSettled() {}),
            deadline,
        ])
        if (timeout) clearTimeout(timeout)
    }

    return {
        control: {
            start,
            close,
        },
        view: {
            endpoint: () => endpoint == null ? null : new URL(endpoint),
            sessionCount: () => sessions.size,
        },
    }
}

export type ModuleControlMcp = ReturnType<typeof createModuleControlMcp>

// ===================================================================
// official SDK self-client
// ===================================================================

export function createModuleControlMcpClient(deps: ModuleControlMcpClientDeps) {
    const client = new Client({
        name: 'wenay-dynamic-runtime-self-client',
        version: '0.1.0-experiment',
    })
    const transport = new StreamableHTTPClientTransport(deps.endpoint, {
        requestInit: {
            headers: {
                Authorization: `Bearer ${deps.bearerToken}`,
            },
        },
    })

    async function connect() {
        await client.connect(transport)
    }

    async function close() {
        await client.close()
    }

    return {
        control: {
            connect,
            close,
            callTool: client.callTool.bind(client),
        },
        resource: {
            list: client.listResources.bind(client),
            read: client.readResource.bind(client),
        },
        view: {
            listTools: client.listTools.bind(client),
        },
    }
}

export type ModuleControlMcpClient = ReturnType<typeof createModuleControlMcpClient>
