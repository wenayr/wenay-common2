// ============================================================
//  demo/http-openapi.ts
//
//  OpenAPI 3.0.3 descriptor for a createHttpFacadeServer facade. Demo-only
//  incubator (may graduate to the library later): no src/ changes and no new
//  library exports. The route list is NOT re-derived here — the real facade
//  walk runs against a recording fake `app` whose get/post only capture
//  (method, route) pairs, so the spec cannot drift from what the real server
//  registers for the same object and basePath.
// ============================================================

import type {HttpFacadeServerOptions, tHttpFacadeMethod} from '../src/server/httpFacadeServer'
import {createHttpFacadeServer} from '../src/server/httpFacadeServer'
import {resolveLimits, type RpcLimits} from '../src/Common/rcp/rpc-limits'

export type HttpFacadeOpenApiDeps = {
    /** The same object the demo hands to createHttpFacadeServer. */
    object: object
    /** The same basePath the demo mounts the facade at, e.g. '/http-facade'. */
    basePath: string
    /** Which mirrors the demo mounts; the demo walks the same object as GET and POST. */
    methods: readonly tHttpFacadeMethod[]
    info: {title: string, version: string, description?: string}
    /** True when every route sits behind Authorization: Bearer <token> middleware. */
    bearerAuth?: boolean
    /** The same limits the demo hands to createHttpFacadeServer. */
    limits?: RpcLimits
    /** Operation summaries keyed by captured route, e.g. '/http-facade/demo/status'. */
    summaries?: Record<string, string>
}

// Mirrors the private normalizeBasePath of httpFacadeServer.ts only to strip the
// prefix off captured routes; the oracle pins captured routes so drift is caught.
function normalizeBasePath(basePath: string) {
    const normalized = `/${basePath}`.replace(/\/{2,}/g, '/').replace(/\/$/, '')
    return normalized == '' ? '/' : normalized
}

function routeSegments(route: string, basePath: string) {
    const suffix = basePath == '/' ? route.slice(1) : route.slice(basePath.length + 1)
    return suffix.split('/').map(decodeURIComponent)
}

// ===================================================================
// public factory
// ===================================================================

export function createHttpFacadeOpenApi(deps: HttpFacadeOpenApiDeps) {
    const basePath = normalizeBasePath(deps.basePath)
    const limits = resolveLimits(deps.limits)

    // ============== record the real walk ==============
    // createHttpFacadeServer registers routes through app[method]; capturing that
    // call IS the route discovery — handlers and middleware are ignored.
    const captured: {method: tHttpFacadeMethod, route: string}[] = []
    function recorder(method: tHttpFacadeMethod) {
        return function captureRoute(route: string) { captured.push({method, route}) }
    }
    const recordingApp = {
        get: recorder('get'),
        post: recorder('post'),
    } as unknown as HttpFacadeServerOptions<object>['app']
    for (const method of deps.methods) {
        createHttpFacadeServer({
            app: recordingApp,
            object: deps.object,
            method,
            basePath: deps.basePath,
            limits: deps.limits,
        })
    }

    // ============== shared schemas ==============
    // Envelope and error shapes follow httpFacadeServer.ts exactly:
    // 200 {ok:true, value: packResult(v)}; failures {ok:false, error: errToObj(e)}
    // with 400 request-shape errors, 413 payload limits, 500 handler throws.
    const packedValueSchema = {
        description: 'The return value packed by the RPC result codec: plain JSON passes '
            + 'through unchanged; Date/Map/Set/RegExp/BigInt leaves become single-key '
            + 'marker objects ("$_d"/"$_m"/"$_s"/"$_r"/"$_b").',
    }
    const argsArraySchema = {
        type: 'array',
        maxItems: limits.maxArgs,
        items: {},
        description: `Positional arguments for the facade function (at most ${limits.maxArgs}); `
            + 'rich values use the same RPC leaf markers as results.',
    }
    const schemas: Record<string, object> = {
        Result: {
            type: 'object',
            required: ['ok', 'value'],
            properties: {
                ok: {type: 'boolean', enum: [true]},
                value: packedValueSchema,
            },
        },
        Failure: {
            type: 'object',
            required: ['ok', 'error'],
            properties: {
                ok: {type: 'boolean', enum: [false]},
                error: {$ref: '#/components/schemas/ErrorObject'},
            },
        },
        ErrorObject: {
            type: 'object',
            description: 'Thrown Error serialized as {name, message, stack} plus optional '
                + 'code/data/cause; a non-Error throw is passed through as-is.',
            properties: {
                name: {type: 'string'},
                message: {type: 'string'},
                stack: {type: 'string'},
                code: {},
                data: packedValueSchema,
                cause: {$ref: '#/components/schemas/ErrorObject'},
            },
        },
    }

    function failureResponse(description: string) {
        return {
            description,
            content: {'application/json': {schema: {$ref: '#/components/schemas/Failure'}}},
        }
    }

    // ============== one operation per captured route ==============
    function buildOperation(method: tHttpFacadeMethod, route: string) {
        const segments = routeSegments(route, basePath)
        const operation: Record<string, unknown> = {
            operationId: `${method}_${segments.join('.')}`,
            tags: [segments.length > 1 ? segments[0] : 'facade'],
            description: `Invokes ${segments.join('.')}(...args) on the facade object.`,
            responses: {
                '200': {
                    description: 'The facade function returned; its value arrives codec-packed.',
                    content: {'application/json': {schema: {$ref: '#/components/schemas/Result'}}},
                },
                '400': failureResponse('Malformed request: args is not valid JSON, not an array, '
                    + 'or the POST body is neither an array nor an object with "args".'),
                '413': failureResponse('Payload limit exceeded (PayloadLimitError): '
                    + `more than ${limits.maxArgs} args, or a value over the depth/size limits.`),
                '500': failureResponse('The facade function threw.'),
            },
        }
        const summary = deps.summaries?.[route]
        if (summary != null) operation['summary'] = summary
        if (deps.bearerAuth) {
            (operation['responses'] as Record<string, unknown>)['401']
                = failureResponse('Missing or wrong bearer token; the error carries only a message.')
        }
        if (method == 'get') {
            operation['parameters'] = [{
                name: 'args',
                in: 'query',
                required: false,
                description: `One JSON-encoded array of positional arguments (at most ${limits.maxArgs}); `
                    + 'omitted or empty means no arguments. Repeating the parameter is rejected.',
                schema: {type: 'string'},
                example: '["hello"]',
            }]
        } else {
            operation['requestBody'] = {
                // express.json turns an absent body into {}, which the facade rejects
                // for lacking "args" — so in practice the body is required.
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            oneOf: [
                                {
                                    type: 'object',
                                    required: ['args'],
                                    properties: {args: argsArraySchema},
                                },
                                argsArraySchema,
                            ],
                        },
                        example: {args: ['hello']},
                    },
                },
            }
        }
        return operation
    }

    const paths: Record<string, Record<string, unknown>> = {}
    for (const {method, route} of captured) {
        const item = paths[route] ?? (paths[route] = {})
        item[method] = buildOperation(method, route)
    }

    const document: Record<string, unknown> = {
        openapi: '3.0.3',
        info: deps.info,
        paths,
        components: deps.bearerAuth
            ? {schemas, securitySchemes: {bearerAuth: {type: 'http', scheme: 'bearer'}}}
            : {schemas},
    }
    if (deps.bearerAuth) document['security'] = [{bearerAuth: []}]

    return {
        document: () => document,
        routes: () => captured.map(pair => ({...pair})),
    }
}

export type HttpFacadeOpenApi = ReturnType<typeof createHttpFacadeOpenApi>
