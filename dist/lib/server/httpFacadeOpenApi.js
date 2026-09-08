"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHttpFacadeOpenApi = createHttpFacadeOpenApi;
const httpFacadeServer_1 = require("./httpFacadeServer");
const rpc_limits_1 = require("../Common/rcp/rpc-limits");
function normalizeBasePath(basePath) {
    const normalized = `/${basePath}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
    return normalized == '' ? '/' : normalized;
}
function routeSegments(route, basePath) {
    const suffix = basePath == '/' ? route.slice(1) : route.slice(basePath.length + 1);
    return suffix.split('/').map(decodeURIComponent);
}
function createHttpFacadeOpenApi(deps) {
    const basePath = normalizeBasePath(deps.basePath);
    const limits = (0, rpc_limits_1.resolveLimits)(deps.limits);
    const captured = [];
    function recorder(method) {
        return function captureRoute(route) { captured.push({ method, route }); };
    }
    const recordingApp = {
        get: recorder('get'),
        post: recorder('post'),
    };
    for (const method of deps.methods) {
        (0, httpFacadeServer_1.createHttpFacadeServer)({
            app: recordingApp,
            object: deps.object,
            method,
            basePath: deps.basePath,
            limits: deps.limits,
        });
    }
    const packedValueSchema = {
        description: 'The return value packed by the RPC result codec: plain JSON passes '
            + 'through unchanged; Date/Map/Set/RegExp/BigInt leaves become single-key '
            + 'marker objects ("$_d"/"$_m"/"$_s"/"$_r"/"$_b").',
    };
    const argsArraySchema = {
        type: 'array',
        maxItems: limits.maxArgs,
        items: {},
        description: `Positional arguments for the facade function (at most ${limits.maxArgs}); `
            + 'rich values use the same RPC leaf markers as results.',
    };
    const schemas = {
        Result: {
            type: 'object',
            required: ['ok', 'value'],
            properties: {
                ok: { type: 'boolean', enum: [true] },
                value: packedValueSchema,
            },
        },
        Failure: {
            type: 'object',
            required: ['ok', 'error'],
            properties: {
                ok: { type: 'boolean', enum: [false] },
                error: { $ref: '#/components/schemas/ErrorObject' },
            },
        },
        ErrorObject: {
            type: 'object',
            description: 'Thrown Error serialized as {name, message, stack} plus optional '
                + 'code/data/cause; a non-Error throw is passed through as-is.',
            properties: {
                name: { type: 'string' },
                message: { type: 'string' },
                stack: { type: 'string' },
                code: {},
                data: packedValueSchema,
                cause: { $ref: '#/components/schemas/ErrorObject' },
            },
        },
    };
    function failureResponse(description) {
        return {
            description,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Failure' } } },
        };
    }
    function buildOperation(method, route) {
        const segments = routeSegments(route, basePath);
        const operation = {
            operationId: `${method}_${segments.join('.')}`,
            tags: [segments.length > 1 ? segments[0] : 'facade'],
            description: `Invokes ${segments.join('.')}(...args) on the facade object.`,
            responses: {
                '200': {
                    description: 'The facade function returned; its value arrives codec-packed.',
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/Result' } } },
                },
                '400': failureResponse('Malformed request: args is not valid JSON, not an array, '
                    + 'or the POST body is neither an array nor an object with "args".'),
                '413': failureResponse('Payload limit exceeded (PayloadLimitError): '
                    + `more than ${limits.maxArgs} args, or a value over the depth/size limits.`),
                '500': failureResponse('The facade function threw.'),
            },
        };
        const summary = deps.summaries?.[route];
        if (summary != null)
            operation['summary'] = summary;
        if (deps.bearerAuth) {
            operation['responses']['401']
                = failureResponse('Missing or wrong bearer token; the error carries only a message.');
        }
        if (method == 'get') {
            operation['parameters'] = [{
                    name: 'args',
                    in: 'query',
                    required: false,
                    description: `One JSON-encoded array of positional arguments (at most ${limits.maxArgs}); `
                        + 'omitted or empty means no arguments. Repeating the parameter is rejected.',
                    schema: { type: 'string' },
                    example: '["hello"]',
                }];
        }
        else {
            const tuple = deps.argSchemas?.[route];
            const bodyArgsSchema = tuple ? {
                type: 'array',
                prefixItems: [...tuple],
                minItems: tuple.length,
                maxItems: tuple.length,
                items: false,
                description: 'Positional arguments as a fixed tuple; rich values use '
                    + 'the same RPC leaf markers as results.',
            } : argsArraySchema;
            operation['requestBody'] = {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            oneOf: [
                                {
                                    type: 'object',
                                    required: ['args'],
                                    properties: { args: bodyArgsSchema },
                                },
                                bodyArgsSchema,
                            ],
                        },
                        ...(tuple ? {} : { example: { args: ['hello'] } }),
                    },
                },
            };
        }
        return operation;
    }
    const paths = {};
    for (const { method, route } of captured) {
        const item = paths[route] ?? (paths[route] = {});
        item[method] = buildOperation(method, route);
    }
    const document = {
        openapi: '3.1.0',
        info: deps.info,
        paths,
        components: deps.bearerAuth
            ? { schemas, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }
            : { schemas },
    };
    if (deps.bearerAuth)
        document['security'] = [{ bearerAuth: [] }];
    return {
        document: () => document,
        routes: () => captured.map(pair => ({ ...pair })),
    };
}
