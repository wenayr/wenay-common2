"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServiceRest = createServiceRest;
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const httpFacadeServer_1 = require("../server/httpFacadeServer");
const httpFacadeOpenApi_1 = require("../server/httpFacadeOpenApi");
const input_schema_1 = require("./input-schema");
const panel_1 = require("./panel");
const defaultLimits = { maxDepth: 8, maxKeys: 100, maxArgs: 4, maxArrayLen: 100, maxStringLen: 4096 };
function bearerIntoArgs(required) {
    return function bearerMiddleware(req, res, next) {
        const header = req.get('authorization') ?? '';
        const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
        if (!token && required) {
            res.status(401).json({ ok: false, error: { message: 'send Authorization: Bearer <token>' } });
            return;
        }
        if (req.method == 'GET') {
            const raw = typeof req.query['args'] == 'string' ? req.query['args'] : '[]';
            let args = [];
            try {
                args = JSON.parse(raw);
            }
            catch {
                args = null;
            }
            if (Array.isArray(args)) {
                Object.defineProperty(req, 'query', { value: { ...req.query, args: JSON.stringify([token || null, ...args]) }, configurable: true, enumerable: true });
            }
        }
        else {
            const body = req.body;
            const args = Array.isArray(body) ? body
                : body != null && typeof body == 'object' && Array.isArray(body.args)
                    ? body.args
                    : null;
            if (args)
                req.body = { args: [token, ...args] };
        }
        next();
    };
}
function createServiceRest(deps) {
    const { app, leader } = deps;
    const definition = deps.definition;
    const name = definition.name;
    const basePath = '/api';
    const limits = deps.limits ?? defaultLimits;
    const log = deps.log ?? console.error;
    const access = leader.access;
    const viewNames = Object.keys(definition.views ?? {});
    const commandNames = Object.keys(definition.commands);
    const login = definition.access?.login;
    const signup = definition.access?.signup;
    function principalOf(token) {
        return access.principalOf(leader.identity.principal(token));
    }
    const views = {};
    for (const viewName of viewNames) {
        views[viewName] = function readView(token) {
            return access.snapshot(viewName, token ? principalOf(token) : null);
        };
    }
    const publicFacade = { [name]: {
            ...(viewNames.length ? { views } : {}),
            ...(definition.readerFacet ? { view: function legacyView() { return leader.view.reader(); } } : {}),
        } };
    const meFacade = { [name]: {
            me(token) {
                const principal = principalOf(token);
                return { ...principal, ...access.rights(principal) };
            },
        } };
    const commandsFacade = { [name]: { commands: leader.corridor.byToken() } };
    const loginFacade = login || signup ? { [name]: {
            ...(login ? { login: function loginWithCredentials(credentials) { return leader.serve.login(credentials); } } : {}),
            ...(signup ? { signup: function signupWithForm(requestId, input) { return leader.serve.signup(String(requestId ?? ''), input); } } : {}),
        } } : null;
    function logServerError(error, context) {
        if (context.status < 500)
            return;
        log(`${name} REST ${context.route} failed (${context.status}): ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
    const readServer = (0, httpFacadeServer_1.createHttpFacadeServer)({
        app, object: publicFacade, method: 'get', basePath, limits, onError: logServerError,
        middleware: [bearerIntoArgs(false)],
    });
    const meServer = (0, httpFacadeServer_1.createHttpFacadeServer)({
        app, object: meFacade, method: 'get', basePath, limits, onError: logServerError,
        middleware: [bearerIntoArgs(true)],
    });
    const writeServer = (0, httpFacadeServer_1.createHttpFacadeServer)({
        app, object: commandsFacade, method: 'post', basePath, limits, onError: logServerError,
        middleware: [express_1.default.json({ limit: '16kb' }), bearerIntoArgs(true)],
    });
    const loginServer = loginFacade ? (0, httpFacadeServer_1.createHttpFacadeServer)({
        app, object: loginFacade, method: 'post', basePath, limits, onError: logServerError,
        middleware: [express_1.default.json({ limit: '16kb' })],
    }) : null;
    const info = {
        title: deps.info?.title ?? `${name} — service REST surface`,
        version: deps.info?.version ?? '0.0.0',
        description: deps.info?.description ?? 'Generated from the live facade objects; writes and gated views ride the same verified token corridor as the sockets.',
    };
    function commandArgSchemas() {
        const map = {};
        for (const commandName of commandNames) {
            const command = definition.commands[commandName];
            map[`${basePath}/${name}/commands/${commandName}`] = [
                { type: 'string', title: 'requestId', description: 'Client-chosen identity of the attempt; a retry with the same id answers the stored receipt.' },
                command.input ? { ...(0, input_schema_1.inputJsonSchema)(command.input), title: 'input' } : { title: 'input' },
            ];
        }
        return map;
    }
    function commandSummaries() {
        const map = {};
        for (const commandName of commandNames) {
            const allow = definition.commands[commandName].allow;
            map[`${basePath}/${name}/commands/${commandName}`] = allow ? `Roles: ${allow.join(', ')}` : 'Any verified account';
        }
        return map;
    }
    function viewSummaries() {
        const map = {};
        for (const viewName of viewNames) {
            const allow = definition.views[viewName].allow;
            map[`${basePath}/${name}/views/${viewName}`] = allow == 'public' ? 'Public projection' : `Roles: ${allow.join(', ')} (bearer)`;
        }
        return map;
    }
    const specs = [
        (0, httpFacadeOpenApi_1.createHttpFacadeOpenApi)({ object: publicFacade, basePath, methods: ['get'], info, limits, summaries: viewSummaries() }),
        (0, httpFacadeOpenApi_1.createHttpFacadeOpenApi)({ object: meFacade, basePath, methods: ['get'], info, limits, bearerAuth: true,
            summaries: { [`${basePath}/${name}/me`]: 'The principal: account, roles, readable views, callable commands' } }),
        (0, httpFacadeOpenApi_1.createHttpFacadeOpenApi)({ object: commandsFacade, basePath, methods: ['post'], info, limits, bearerAuth: true,
            summaries: commandSummaries(), argSchemas: commandArgSchemas() }),
        ...(loginFacade ? [(0, httpFacadeOpenApi_1.createHttpFacadeOpenApi)({ object: loginFacade, basePath, methods: ['post'], info, limits,
                summaries: {
                    ...(login ? { [`${basePath}/${name}/login`]: 'Credentials → session token (the leader is the identity provider)' } : {}),
                    ...(signup ? { [`${basePath}/${name}/signup`]: `Self-registration: runs the ${signup.command} command as the system principal` } : {}),
                },
                argSchemas: {
                    ...(login ? { [`${basePath}/${name}/login`]: [{ ...(0, input_schema_1.inputJsonSchema)(login.input), title: 'credentials' }] } : {}),
                    ...(signup ? { [`${basePath}/${name}/signup`]: [
                            { type: 'string', title: 'requestId', description: 'Client-chosen identity of the attempt; a retry with the same id answers the stored receipt.' },
                            { ...(0, input_schema_1.inputJsonSchema)(signup.input), title: 'input' },
                        ] } : {}),
                } })] : []),
    ];
    const bearerHalves = new Set([1, 2]);
    function mergeDocuments() {
        const documents = specs.map(spec => spec.document());
        const paths = {};
        documents.forEach(function mergeOne(document, index) {
            for (const [route, item] of Object.entries(document['paths'])) {
                paths[route] = bearerHalves.has(index)
                    ? Object.fromEntries(Object.entries(item).map(([method, operation]) => [method, { ...operation, security: [{ bearerAuth: [] }] }]))
                    : item;
            }
        });
        const withBearer = documents[1];
        return { openapi: withBearer['openapi'], info: withBearer['info'], paths, components: withBearer['components'] };
    }
    const openApiDocument = mergeDocuments();
    app.get('/openapi.json', function serveOpenApiDocument(_req, res) { res.json(openApiDocument); });
    if (deps.pages?.docs != false) {
        const swaggerUiDistDir = path_1.default.dirname(require.resolve('swagger-ui-dist/package.json'));
        app.use('/docs/assets', express_1.default.static(swaggerUiDistDir, { index: false }));
        app.get('/docs', function serveSwaggerUiPage(_req, res) {
            res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — Swagger UI</title>
<link rel="stylesheet" href="/docs/assets/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="/docs/assets/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({url: '/openapi.json', dom_id: '#swagger-ui', presets: [SwaggerUIBundle.presets.apis], layout: 'BaseLayout'})</script>
</body></html>`);
        });
    }
    if (deps.pages?.panel != false) {
        const page = (0, panel_1.servicePanelPage)({
            name,
            basePath,
            views: viewNames.map(viewName => ({ name: viewName, allow: definition.views[viewName].allow })),
            commands: commandNames.map(commandName => ({
                name: commandName,
                allow: definition.commands[commandName].allow,
                example: definition.commands[commandName].input ? exampleOf(definition.commands[commandName].input) : {},
            })),
            login: login ? { fields: Object.keys(login.input) } : null,
        });
        app.get('/panel', function servePanelPage(_req, res) { res.type('html').send(page); });
    }
    return {
        basePath,
        routes: {
            read: [...readServer.routes(), ...meServer.routes()],
            write: [...writeServer.routes(), ...(loginServer?.routes() ?? [])],
        },
        openApi: { document: () => openApiDocument },
    };
}
function exampleOf(schema) {
    const example = {};
    for (const [field, spec] of Object.entries(schema)) {
        const base = typeof spec == 'string' ? spec.replace(/\?$/, '') : spec;
        if (typeof base == 'string') {
            example[field] = base == 'number' ? 0 : base == 'boolean' ? false : base == 'date-string' ? '2026-01-01' : '';
        }
        else if (base && typeof base == 'object') {
            const shape = base;
            example[field] = shape.enum ? shape.enum[0] : shape.array ? [] : shape.object ? exampleOf(shape.object) : '';
        }
    }
    return example;
}
