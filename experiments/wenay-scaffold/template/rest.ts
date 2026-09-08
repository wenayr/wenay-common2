// =====================================================================
// rest — the HTTP face of a service: views, commands, login, OpenAPI, panel
// =====================================================================
// TEMPLATE-OWNED. One mount over the RUNNING leader, derived from the
// definition — nothing here is handwritten per service:
//   GET  /api/<name>/views/<view>   the projection (public, or bearer-gated by the view's allow)
//   GET  /api/<name>/me             the principal's account, roles and rights (bearer)
//   POST /api/<name>/commands/<cmd> the write corridor, verbatim (bearer → leading token argument)
//   POST /api/<name>/login          credentials → token (only when the definition declares access.login)
//   GET  /openapi.json, /docs       the merged 3.1 document + Swagger UI
//   GET  /panel                     the generic role panel (./panel.ts): login, views, commands
// REST is one more relay of the end-to-end corridor: the bearer is copied
// opaquely into the corridor call and the leader verifies it, so an account
// can never be asserted through an HTTP parameter. Views answer from the
// leader's own store through the same shaper the sockets use (./access.ts).

import express from 'express'
import type {Express, NextFunction, Request, Response} from 'express'
import path from 'path'
import {createHttpFacadeServer} from '../../../src/server/httpFacadeServer'
import {createHttpFacadeOpenApi} from '../../../src/server/httpFacadeOpenApi'
import type {RpcLimits} from '../../../src/Common/rcp/rpc-limits'
import {inputJsonSchema} from './input-schema'
import type {ServiceLeader, tServiceCommand, tServiceDefinition} from './leader'
import {servicePanelPage} from './panel'

export type ServiceRestDeps<D extends tServiceDefinition<any, any>> = {
    app: Express
    leader: ServiceLeader<D>
    definition: D
    /** Document info; version defaults to '0.0.0'. */
    info?: {title?: string, version?: string, description?: string}
    /** Mount /panel (default true) and /docs (default true). */
    pages?: {panel?: boolean, docs?: boolean}
    limits?: RpcLimits
}

// One JSON envelope for every route (the demo stand's limits).
const defaultLimits: RpcLimits = {maxDepth: 8, maxKeys: 100, maxArgs: 4, maxArrayLen: 100, maxStringLen: 4096}

/** `Authorization: Bearer <token>` → the leading argument of the call; `required` answers 401 without one. */
function bearerIntoArgs(required: boolean) {
    return function bearerMiddleware(req: Request, res: Response, next: NextFunction) {
        const header = req.get('authorization') ?? ''
        const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
        if (!token && required) {
            res.status(401).json({ok: false, error: {message: 'send Authorization: Bearer <token>'}})
            return
        }
        // GET carries args in the query; POST in the body. Prepend the token (null when optional and absent).
        if (req.method == 'GET') {
            const raw = typeof req.query['args'] == 'string' ? req.query['args'] : '[]'
            let args: unknown = []
            try { args = JSON.parse(raw) } catch { args = null }
            // express 5 re-parses `query` on every read, so the completed args are pinned as an own property
            if (Array.isArray(args)) {
                Object.defineProperty(req, 'query', {value: {...req.query, args: JSON.stringify([token || null, ...args])}, configurable: true, enumerable: true})
            }
        } else {
            const body = req.body
            const args = Array.isArray(body) ? body
                : body != null && typeof body == 'object' && Array.isArray((body as {args?: unknown}).args)
                    ? (body as {args: unknown[]}).args
                    : null
            if (args) req.body = {args: [token, ...args]}
        }
        next()
    }
}

export function createServiceRest<D extends tServiceDefinition<any, any>>(deps: ServiceRestDeps<D>) {
    const {app, leader} = deps
    const definition = deps.definition as tServiceDefinition<any, Record<string, tServiceCommand<any>>>
    const name = definition.name
    const basePath = '/api'
    const limits = deps.limits ?? defaultLimits
    const access = leader.access
    const viewNames = Object.keys(definition.views ?? {})
    const commandNames = Object.keys(definition.commands)
    const login = definition.access?.login
    const signup = definition.access?.signup

    /** A bearer → the principal (account + roles) or a throw: the authority's verifier + deny list. */
    function principalOf(token: unknown) {
        return access.principalOf(leader.identity.principal(token))
    }

    // ============== facade objects, one per audience ==============
    const views: Record<string, (token: unknown) => object> = {}
    for (const viewName of viewNames) {
        views[viewName] = function readView(token: unknown) {
            return access.snapshot(viewName, token ? principalOf(token) : null)
        }
    }
    const publicFacade = {[name]: {
        ...(viewNames.length ? {views} : {}),
        ...(definition.readerFacet ? {view: function legacyView() { return leader.view.reader() }} : {}),
    }}
    const meFacade = {[name]: {
        me(token: unknown) {
            const principal = principalOf(token)
            return {...principal, ...access.rights(principal)}
        },
    }}
    const commandsFacade = {[name]: {commands: leader.corridor.byToken()}}
    const loginFacade = login || signup ? {[name]: {
        ...(login ? {login: function loginWithCredentials(credentials: unknown) { return leader.serve.login(credentials) }} : {}),
        ...(signup ? {signup: function signupWithForm(requestId: unknown, input: unknown) { return leader.serve.signup(String(requestId ?? ''), input) }} : {}),
    }} : null

    const readServer = createHttpFacadeServer({
        app, object: publicFacade, method: 'get', basePath, limits,
        middleware: [bearerIntoArgs(false)],
    })
    const meServer = createHttpFacadeServer({
        app, object: meFacade, method: 'get', basePath, limits,
        middleware: [bearerIntoArgs(true)],
    })
    const writeServer = createHttpFacadeServer({
        app, object: commandsFacade, method: 'post', basePath, limits,
        middleware: [express.json({limit: '16kb'}), bearerIntoArgs(true)],
    })
    const loginServer = loginFacade ? createHttpFacadeServer({
        app, object: loginFacade, method: 'post', basePath, limits,
        middleware: [express.json({limit: '16kb'})],
    }) : null

    // ============== OpenAPI: one document from the same facade objects ==============
    const info = {
        title: deps.info?.title ?? `${name} — service REST surface`,
        version: deps.info?.version ?? '0.0.0',
        description: deps.info?.description ?? 'Generated from the live facade objects; writes and gated views ride the same verified token corridor as the sockets.',
    }
    function commandArgSchemas() {
        const map: Record<string, object[]> = {}
        for (const commandName of commandNames) {
            const command = definition.commands[commandName]
            map[`${basePath}/${name}/commands/${commandName}`] = [
                {type: 'string', title: 'requestId', description: 'Client-chosen identity of the attempt; a retry with the same id answers the stored receipt.'},
                command.input ? {...inputJsonSchema(command.input), title: 'input'} : {title: 'input'},
            ]
        }
        return map
    }
    function commandSummaries() {
        const map: Record<string, string> = {}
        for (const commandName of commandNames) {
            const allow = definition.commands[commandName].allow
            map[`${basePath}/${name}/commands/${commandName}`] = allow ? `Roles: ${allow.join(', ')}` : 'Any verified account'
        }
        return map
    }
    function viewSummaries() {
        const map: Record<string, string> = {}
        for (const viewName of viewNames) {
            const allow = definition.views![viewName].allow
            map[`${basePath}/${name}/views/${viewName}`] = allow == 'public' ? 'Public projection' : `Roles: ${allow.join(', ')} (bearer)`
        }
        return map
    }
    const specs = [
        createHttpFacadeOpenApi({object: publicFacade, basePath, methods: ['get'], info, limits, summaries: viewSummaries()}),
        createHttpFacadeOpenApi({object: meFacade, basePath, methods: ['get'], info, limits, bearerAuth: true,
            summaries: {[`${basePath}/${name}/me`]: 'The principal: account, roles, readable views, callable commands'}}),
        createHttpFacadeOpenApi({object: commandsFacade, basePath, methods: ['post'], info, limits, bearerAuth: true,
            summaries: commandSummaries(), argSchemas: commandArgSchemas()}),
        ...(loginFacade ? [createHttpFacadeOpenApi({object: loginFacade, basePath, methods: ['post'], info, limits,
            summaries: {
                ...(login ? {[`${basePath}/${name}/login`]: 'Credentials → session token (the leader is the identity provider)'} : {}),
                ...(signup ? {[`${basePath}/${name}/signup`]: `Self-registration: runs the ${signup.command} command as the system principal`} : {}),
            },
            argSchemas: {
                ...(login ? {[`${basePath}/${name}/login`]: [{...inputJsonSchema(login.input), title: 'credentials'}]} : {}),
                ...(signup ? {[`${basePath}/${name}/signup`]: [
                    {type: 'string', title: 'requestId', description: 'Client-chosen identity of the attempt; a retry with the same id answers the stored receipt.'},
                    {...inputJsonSchema(signup.input), title: 'input'},
                ]} : {}),
            }})] : []),
    ]
    const bearerHalves = new Set([1, 2])
    function mergeDocuments() {
        const documents = specs.map(spec => spec.document() as Record<string, any>)
        const paths: Record<string, unknown> = {}
        documents.forEach(function mergeOne(document, index) {
            for (const [route, item] of Object.entries(document['paths'] as Record<string, Record<string, object>>)) {
                paths[route] = bearerHalves.has(index)
                    ? Object.fromEntries(Object.entries(item).map(([method, operation]) => [method, {...operation, security: [{bearerAuth: []}]}]))
                    : item
            }
        })
        const withBearer = documents[1]
        return {openapi: withBearer['openapi'], info: withBearer['info'], paths, components: withBearer['components']}
    }
    const openApiDocument = mergeDocuments()
    app.get('/openapi.json', function serveOpenApiDocument(_req, res) { res.json(openApiDocument) })

    // ============== pages: Swagger UI and the generic panel ==============
    if (deps.pages?.docs != false) {
        const swaggerUiDistDir = path.dirname(require.resolve('swagger-ui-dist/package.json'))
        app.use('/docs/assets', express.static(swaggerUiDistDir, {index: false}))
        app.get('/docs', function serveSwaggerUiPage(_req, res) {
            res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — Swagger UI</title>
<link rel="stylesheet" href="/docs/assets/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="/docs/assets/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({url: '/openapi.json', dom_id: '#swagger-ui', presets: [SwaggerUIBundle.presets.apis], layout: 'BaseLayout'})</script>
</body></html>`)
        })
    }
    if (deps.pages?.panel != false) {
        const page = servicePanelPage({
            name,
            basePath,
            views: viewNames.map(viewName => ({name: viewName, allow: definition.views![viewName].allow})),
            commands: commandNames.map(commandName => ({
                name: commandName,
                allow: definition.commands[commandName].allow,
                example: definition.commands[commandName].input ? exampleOf(definition.commands[commandName].input!) : {},
            })),
            login: login ? {fields: Object.keys(login.input)} : null,
        })
        app.get('/panel', function servePanelPage(_req, res) { res.type('html').send(page) })
    }

    return {
        basePath,
        routes: {
            read: [...readServer.routes(), ...meServer.routes()],
            write: [...writeServer.routes(), ...(loginServer?.routes() ?? [])],
        },
        openApi: {document: () => openApiDocument},
    }
}
export type ServiceRest = ReturnType<typeof createServiceRest>

/** A placeholder input for the panel's command form, from the schema's field kinds. */
function exampleOf(schema: Record<string, unknown>): Record<string, unknown> {
    const example: Record<string, unknown> = {}
    for (const [field, spec] of Object.entries(schema)) {
        const base = typeof spec == 'string' ? spec.replace(/\?$/, '') : spec
        if (typeof base == 'string') {
            example[field] = base == 'number' ? 0 : base == 'boolean' ? false : base == 'date-string' ? '2026-01-01' : ''
        } else if (base && typeof base == 'object') {
            const shape = base as {enum?: readonly string[], array?: string, object?: Record<string, unknown>}
            example[field] = shape.enum ? shape.enum[0] : shape.array ? [] : shape.object ? exampleOf(shape.object) : ''
        }
    }
    return example
}
