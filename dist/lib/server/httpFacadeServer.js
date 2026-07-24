"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHttpFacadeServer = createHttpFacadeServer;
const rpc_limits_1 = require("../Common/rcp/rpc-limits");
const rpc_walk_1 = require("../Common/rcp/rpc-walk");
const registrations = new WeakMap();
const REQUEST_ERROR = Symbol('httpFacadeRequestError');
function normalizeBasePath(basePath) {
    if (typeof basePath != 'string')
        throw new Error('HTTP facade basePath must be a string');
    if (basePath.includes('?') || basePath.includes('#')) {
        throw new Error('HTTP facade basePath must not contain a query or fragment');
    }
    const normalized = `/${basePath}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
    return normalized == '' ? '/' : normalized;
}
function encodePathSegment(segment) {
    if (segment == '.' || segment == '..') {
        throw new Error(`HTTP facade contains a URL dot segment: ${segment}`);
    }
    return encodeURIComponent(segment).replace(/[!'()*]/g, function encodeExtra(char) {
        return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
    });
}
function makeRoute(basePath, path) {
    const suffix = path.map(encodePathSegment).join('/');
    return basePath == '/' ? `/${suffix}` : `${basePath}/${suffix}`;
}
function discoverRoutes(object, method, basePath) {
    const routes = [];
    const ancestors = new Set();
    function visit(node, path) {
        if (ancestors.has(node)) {
            throw new Error(`HTTP facade contains a circular branch at ${JSON.stringify(path)}`);
        }
        ancestors.add(node);
        try {
            for (const key of Object.keys(node)) {
                if (!(0, rpc_limits_1.isSafeKey)(key))
                    throw new Error(`HTTP facade contains a forbidden key: ${key}`);
                if (key.length == 0)
                    throw new Error('HTTP facade contains an empty path segment');
                const value = node[key];
                const nextPath = [...path, key];
                if (typeof value == 'function') {
                    routes.push({
                        method,
                        path: nextPath,
                        route: makeRoute(basePath, nextPath),
                        fn: value,
                        context: node,
                    });
                    continue;
                }
                if (value != null && typeof value == 'object')
                    visit(value, nextPath);
            }
        }
        finally {
            ancestors.delete(node);
        }
    }
    visit(object, []);
    return routes;
}
function requestError(message) {
    const error = new Error(message);
    error[REQUEST_ERROR] = true;
    return error;
}
function getRawArgs(req, method) {
    if (method == 'get') {
        const encoded = req.query['args'];
        if (encoded == null || encoded == '')
            return [];
        if (typeof encoded != 'string')
            throw requestError('GET query "args" must be one JSON array');
        try {
            return JSON.parse(encoded);
        }
        catch {
            throw requestError('GET query "args" contains invalid JSON');
        }
    }
    const body = req.body;
    if (body == null)
        return [];
    if (Array.isArray(body))
        return body;
    if (typeof body == 'object' && Object.prototype.hasOwnProperty.call(body, 'args')) {
        return body.args;
    }
    throw requestError('POST body must be a JSON array or an object with an "args" array');
}
function decodeArgs(req, method, limits) {
    const raw = getRawArgs(req, method);
    if (!Array.isArray(raw))
        throw requestError('HTTP facade args must be an array');
    if (raw.length > limits.maxArgs)
        throw new rpc_limits_1.PayloadLimitError('too many args');
    return (0, rpc_walk_1.unpackResult)(raw, limits);
}
function statusForError(error) {
    if (error instanceof rpc_limits_1.PayloadLimitError)
        return 413;
    if (error != null && typeof error == 'object' && REQUEST_ERROR in error)
        return 400;
    return 500;
}
function createRouteHandler(route, limits) {
    return async function handleHttpFacadeRequest(req, res) {
        try {
            const args = decodeArgs(req, route.method, limits);
            const value = await route.fn.apply(route.context, args);
            res.json({ ok: true, value: (0, rpc_walk_1.packResult)(value) });
        }
        catch (error) {
            res.status(statusForError(error)).json({ ok: false, error: (0, rpc_walk_1.errToObj)(error) });
        }
    };
}
function createHttpFacadeServer(options) {
    const { app, object, method } = options;
    if (method != 'get' && method != 'post')
        throw new Error(`Unsupported HTTP facade method: ${String(method)}`);
    if (object == null || typeof object != 'object')
        throw new Error('HTTP facade object must be an object');
    if (app == null || typeof app[method] != 'function')
        throw new Error('HTTP facade app must register GET and POST routes');
    const basePath = normalizeBasePath(options.basePath);
    const limits = (0, rpc_limits_1.resolveLimits)(options.limits);
    const routes = discoverRoutes(object, method, basePath);
    const middleware = options.middleware == null
        ? []
        : Array.isArray(options.middleware) ? [...options.middleware] : [options.middleware];
    let registered = registrations.get(app);
    if (!registered) {
        registered = new Set();
        registrations.set(app, registered);
    }
    for (const route of routes) {
        const key = `${route.method}\u0000${route.route}`;
        if (registered.has(key)) {
            throw new Error(`HTTP facade route is already registered: ${route.method.toUpperCase()} ${route.route}`);
        }
    }
    const register = app[method].bind(app);
    for (const route of routes) {
        register(route.route, ...middleware, createRouteHandler(route, limits));
        registered.add(`${route.method}\u0000${route.route}`);
    }
    return {
        routes: () => routes.map(route => ({
            method: route.method,
            path: [...route.path],
            route: route.route,
        })),
    };
}
