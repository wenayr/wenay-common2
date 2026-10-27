"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHttpFacadeServer = createHttpFacadeServer;
const rpc_limits_1 = require("../Common/rcp/rpc-limits");
const rpc_member_1 = require("../Common/rcp/rpc-member");
const rpc_walk_1 = require("../Common/rcp/rpc-walk");
const facadeWalk_1 = require("./facadeWalk");
const registrations = new WeakMap();
const REST = '*rest';
const REQUEST_ERROR = Symbol('httpFacadeRequestError');
const NOT_FOUND = Symbol('httpFacadeNotFound');
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
function discoverRoutes(object, method, basePath, limits) {
    const dynamicRoutes = [];
    function takeDynamic(value, path) {
        if ((0, facadeWalk_1.facadeNodeKind)(value) != 'dynamic')
            return false;
        if (value != null && typeof value == 'object') {
            if (path.length >= limits.maxPathLen) {
                throw new Error(`HTTP facade: noStrict node ${JSON.stringify(path)} is too deep for limits.maxPathLen (${limits.maxPathLen})`);
            }
            dynamicRoutes.push({ method, path, route: `${makeRoute(basePath, path)}/${REST}`, node: value, dynamic: true });
        }
        return true;
    }
    const staticRoutes = (0, facadeWalk_1.walkFacade)(object, { label: 'HTTP facade', take: takeDynamic }).map((entry) => ({
        method,
        path: entry.path,
        route: makeRoute(basePath, entry.path),
        fn: entry.fn,
        context: entry.context,
        dynamic: false,
    }));
    return [...staticRoutes, ...dynamicRoutes];
}
function claims(dynamicKey, key) {
    return dynamicKey.endsWith(`/${REST}`) && key.startsWith(dynamicKey.slice(0, -REST.length));
}
function overlapOf(key, registered) {
    for (const other of registered)
        if (claims(other, key) || claims(key, other))
            return other;
    return undefined;
}
function resolveDynamic(node, segments) {
    let owner = node;
    let current = node;
    for (const segment of segments) {
        if (current == null || typeof current != 'object' || (0, facadeWalk_1.facadeNodeKind)(current) == 'listen')
            return undefined;
        if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer)
            return undefined;
        owner = current;
        current = (0, rpc_member_1.dynamicMember)(current, segment);
        if (current === undefined)
            return undefined;
    }
    if (typeof current != 'function' || (0, facadeWalk_1.facadeNodeKind)(current) == 'on')
        return undefined;
    return { fn: current, owner };
}
function requestError(message) {
    const error = new Error(message);
    error[REQUEST_ERROR] = true;
    return error;
}
function notFoundError(message) {
    const error = new Error(message);
    error[NOT_FOUND] = true;
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
    if (error != null && typeof error == 'object' && NOT_FOUND in error)
        return 404;
    return 500;
}
function targetOf(route, req, limits) {
    if (!route.dynamic)
        return { fn: route.fn, owner: route.context };
    const rest = req.params['rest'];
    if (!Array.isArray(rest) || rest.length == 0)
        throw notFoundError('No member below the dynamic node');
    const segments = rest.length > 1 && rest[rest.length - 1] == '' ? rest.slice(0, -1) : rest;
    if (route.path.length + segments.length > limits.maxPathLen)
        throw new rpc_limits_1.PayloadLimitError('path too long');
    for (const segment of segments) {
        if (typeof segment != 'string' || segment == '')
            throw requestError('HTTP facade path contains an empty segment');
        if (!(0, rpc_limits_1.isSafeKey)(segment))
            throw requestError(`HTTP facade path contains a forbidden segment: ${segment}`);
    }
    const target = resolveDynamic(route.node, segments);
    if (!target) {
        const requested = [...route.path, ...segments].join('.');
        throw notFoundError(`Not a function: ${requested.length > 200 ? requested.slice(0, 200) + '…' : requested}`);
    }
    return target;
}
function createRouteHandler(route, limits, onError) {
    return async function handleHttpFacadeRequest(req, res) {
        try {
            const target = targetOf(route, req, limits);
            const args = decodeArgs(req, route.method, limits);
            const value = await target.fn.apply(target.owner, args);
            res.json({ ok: true, value: (0, rpc_walk_1.packResult)(value) });
        }
        catch (error) {
            const status = statusForError(error);
            try {
                onError?.(error, { route: route.route, status });
            }
            catch { }
            res.status(status).json({ ok: false, error: (0, rpc_walk_1.errToObj)(error) });
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
    const routes = discoverRoutes(object, method, basePath, limits);
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
        const other = overlapOf(key, registered);
        if (other != undefined) {
            throw new Error(`HTTP facade route ${route.method.toUpperCase()} ${route.route} overlaps the registered `
                + `${other.split('\u0000')[1]}: a dynamic route answers everything below it`);
        }
    }
    const register = app[method].bind(app);
    for (const route of routes) {
        register(route.route, ...middleware, createRouteHandler(route, limits, options.onError));
        registered.add(`${route.method}\u0000${route.route}`);
    }
    return {
        routes: () => routes.map(route => ({
            method: route.method,
            path: [...route.path],
            route: route.route,
            dynamic: route.dynamic,
        })),
    };
}
