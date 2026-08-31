// =====================================================================
// rental REST surface — example-local glue over the scaffold leader
// =====================================================================
// The step-7b pieces (createHttpFacadeServer + createHttpFacadeOpenApi)
// mounted over the RUNNING service. board is the readerFacet projection;
// book/cancel are the leader's verifyCommands fragment served verbatim —
// REST is just one more relay of the end-to-end corridor: it copies the
// client's token opaquely and the leader verifies EVERY call, so an account
// can never be asserted through a REST parameter.
//
// Two facade objects on one base path, split by audience:
//   GET  {rental: {board}}       — ungated public read
//   POST {rental: corridor}      — bearer-gated writes; the middleware turns
//                                  Authorization: Bearer <token> into the
//                                  corridor's leading token argument
//
// TODO(graduation): the '../../../../src' / demo imports become package
// entrypoints when the template graduates out of the incubator.

import express from 'express'
import type {Express, NextFunction, Request, Response} from 'express'
import path from 'path'
import {createHttpFacadeOpenApi} from '../../../../demo/http-openapi'
import {createHttpFacadeServer} from '../../../../src/server/httpFacadeServer'
import {inputJsonSchema} from '../../template/input-schema'
import type {createServiceLeader} from '../../template/leader'
import {serviceDefinition, type RentalState} from './service'

// Derived from the running implementation, never handwritten: the corridor
// facet's byToken() IS the verified (token, requestId, input) fragment — the
// same one the node link forwards into.
type RentalLeader = ReturnType<typeof createServiceLeader<RentalState, (typeof serviceDefinition)['commands']>>
export type RentalCorridor = ReturnType<RentalLeader['corridor']['byToken']>

export type RentalRestDeps = {
    app: Express
    /** The readerFacet projection the leader serves anonymously. */
    board: RentalLeader['view']['reader']
    /** The leader's verifyCommands fragment: the same corridor the nodes forward into. */
    corridor: RentalCorridor
}

// One JSON envelope for every rental route (mirrors demo/server.ts limits).
const restLimits = {maxDepth: 8, maxKeys: 100, maxArgs: 4, maxArrayLen: 100, maxStringLen: 4096}

export function createRentalRest(deps: RentalRestDeps) {
    const {app, corridor} = deps
    const basePath = '/api'

    // ============== the facade objects, one per audience ==============
    const readFacade = {
        rental: {
            /** The public board: the readerFacet projection, no identity involved. */
            board: function board() { return deps.board() },
        },
    }
    // The write facade IS the corridor fragment — no reshaping, one boundary.
    const writeFacade = {rental: corridor}

    // ============== bearer → corridor token ==============
    // The write functions take (token, requestId, input); REST clients send only
    // [requestId, input] and this middleware completes the call from the
    // Authorization header. Runs after express.json: the prepend needs the body.
    function bearerIntoArgs(req: Request, res: Response, next: NextFunction) {
        const header = req.get('authorization') ?? ''
        const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
        if (!token) {
            res.status(401).json({ok: false, error: {message: 'send Authorization: Bearer <token>'}})
            return
        }
        const body = req.body
        const args = Array.isArray(body) ? body
            : body != null && typeof body == 'object' && Array.isArray((body as {args?: unknown}).args)
                ? (body as {args: unknown[]}).args
                : null
        // an unrecognizable body passes through untouched: the facade answers 400
        if (args) req.body = {args: [token, ...args]}
        next()
    }

    const readServer = createHttpFacadeServer({
        app, object: readFacade, method: 'get', basePath, limits: restLimits,
    })
    const writeServer = createHttpFacadeServer({
        app, object: writeFacade, method: 'post', basePath,
        middleware: [express.json({limit: '16kb'}), bearerIntoArgs],
        limits: restLimits,
    })

    // ============== OpenAPI: two generator runs, ONE merged document ==============
    // The split is real (audiences differ), so each half re-runs the facade walk
    // it documents; the merge only adds per-operation bearer security to the
    // write half so the board stays public in the spec too.
    const info = {
        title: 'rental — scaffold example REST surface',
        version: (require('../../../../package.json') as {version: string}).version,
        description: 'Generated from the live facade objects; writes ride the same '
            + 'verified token corridor as the socket nodes.',
    }
    // ============== argSchemas: the definition's input schemas, retold as tuples ==============
    // Every corridor write is (token, requestId, input); REST clients send
    // [requestId, input] and the bearer middleware prepends the token. The
    // input half of each tuple is the SAME runtime schema the leader validates
    // with — the document cannot drift from the corridor.
    function commandArgSchemas() {
        const map: Record<string, object[]> = {}
        for (const [commandName, command] of Object.entries(serviceDefinition.commands)) {
            if (!command.input) continue
            map[`${basePath}/${serviceDefinition.name}/${commandName}`] = [
                {
                    type: 'string',
                    title: 'requestId',
                    description: 'Client-chosen identity of the attempt; a retry with the '
                        + 'same id answers the stored receipt instead of re-running.',
                },
                {...inputJsonSchema(command.input), title: 'input'},
            ]
        }
        return map
    }

    const readSpec = createHttpFacadeOpenApi({
        object: readFacade, basePath, methods: ['get'], info, limits: restLimits,
        summaries: {'/api/rental/board': 'Public board: items + active bookings, no account details'},
    })
    const writeSpec = createHttpFacadeOpenApi({
        object: writeFacade, basePath, methods: ['post'], info, bearerAuth: true, limits: restLimits,
        // field shapes live in the body tuple now; summaries carry only intent
        summaries: {
            '/api/rental/book': 'Book an item for the half-open span [from, to) — the bearer token becomes the corridor argument',
            '/api/rental/cancel': 'Cancel a booking — only the booking owner may cancel',
        },
        argSchemas: commandArgSchemas(),
    })
    function mergeDocuments() {
        const read = readSpec.document() as Record<string, any>
        const write = writeSpec.document() as Record<string, any>
        const writePaths: Record<string, unknown> = {}
        for (const [route, item] of Object.entries(write['paths'] as Record<string, Record<string, object>>)) {
            writePaths[route] = Object.fromEntries(Object.entries(item)
                .map(([method, operation]) => [method, {...operation, security: [{bearerAuth: []}]}]))
        }
        return {
            openapi: write['openapi'],
            info: write['info'],
            paths: {...read['paths'], ...writePaths},
            // superset of the read half: shared schemas + the bearer scheme
            components: write['components'],
        }
    }
    const openApiDocument = mergeDocuments()

    app.get('/openapi.json', function serveOpenApiDocument(_req, res) {
        res.json(openApiDocument)
    })

    // Hand-written page instead of the package's own index.html, which
    // hardcodes the petstore URL (same approach as demo/server.ts).
    const swaggerUiDistDir = path.dirname(require.resolve('swagger-ui-dist/package.json'))
    app.use('/docs/assets', express.static(swaggerUiDistDir, {index: false}))
    app.get('/docs', function serveSwaggerUiPage(_req, res) {
        res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rental — Swagger UI</title>
<link rel="stylesheet" href="/docs/assets/swagger-ui.css">
<link rel="icon" type="image/png" href="/docs/assets/favicon-32x32.png">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/docs/assets/swagger-ui-bundle.js"></script>
<script>
window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
})
</script>
</body>
</html>`)
    })

    // ============== the board stand: ZERO new wire ==============
    // A static page that polls the SAME documented REST route every second —
    // string concatenation in the page script keeps this template literal flat.
    app.get('/board', function serveBoardPage(_req, res) {
        res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rental board</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
table { border-collapse: collapse; margin: 0.5rem 0 1.5rem; }
th, td { border: 1px solid #bbb; padding: 0.3rem 0.8rem; text-align: left; }
th { background: #f0f0f0; }
.hint { color: #666; font-size: 0.9rem; }
</style>
</head>
<body>
<h1>rental board</h1>
<p class="hint">polls GET /api/rental/board every second — the same documented REST route
(<a href="/docs">docs</a>, <a href="/openapi.json">openapi.json</a>) — updated <span id="stamp">never</span></p>
<h2>Items</h2>
<table id="items"></table>
<h2>Active bookings</h2>
<table id="bookings"></table>
<script>
function esc(value) {
    return String(value).replace(/[&<>"]/g, function escapeChar(ch) {
        return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[ch]
    })
}
function row(cells, tag) {
    var open = '<' + (tag || 'td') + '>', close = '</' + (tag || 'td') + '>'
    return '<tr>' + cells.map(function cell(value) { return open + esc(value) + close }).join('') + '</tr>'
}
async function refresh() {
    try {
        var answer = await (await fetch('/api/rental/board')).json()
        if (!answer.ok) return
        var board = answer.value
        document.getElementById('items').innerHTML = row(['item', 'title', 'price/day'], 'th')
            + board.items.map(function itemRow(item) { return row([item.id, item.title, item.pricePerDay]) }).join('')
        document.getElementById('bookings').innerHTML = row(['booking', 'item', 'from', 'to'], 'th')
            + (board.bookings.length
                ? board.bookings.map(function bookingRow(b) { return row([b.id, b.itemId, b.from, b.to]) }).join('')
                : '<tr><td colspan="4">none</td></tr>')
        document.getElementById('stamp').textContent = new Date().toLocaleTimeString()
    } catch (error) {}
}
setInterval(refresh, 1000)
refresh()
</script>
</body>
</html>`)
    })

    return {
        basePath,
        routes: {read: readServer.routes(), write: writeServer.routes()},
        openApi: {document: () => openApiDocument},
    }
}

export type RentalRest = ReturnType<typeof createRentalRest>
