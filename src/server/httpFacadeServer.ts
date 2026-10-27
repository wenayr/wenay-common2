import type {Express, Request, RequestHandler, Response} from 'express'

import {isSafeKey, PayloadLimitError, resolveLimits, type RpcLimits} from '../Common/rcp/rpc-limits'
import {dynamicMember} from '../Common/rcp/rpc-member'
import {errToObj, packResult, unpackResult} from '../Common/rcp/rpc-walk'
import {facadeNodeKind, walkFacade} from './facadeWalk'

export type tHttpFacadeMethod = 'get' | 'post'

export type HttpFacadeServerOptions<T extends object> = {
    app: Pick<Express, 'get' | 'post'>
    object: T
    method: tHttpFacadeMethod
    basePath: string
    middleware?: RequestHandler | readonly RequestHandler[]
    limits?: RpcLimits
    /** The whole error, stack included, for the operator: callers only get its facts. */
    onError?: (error: unknown, context: {route: string, status: number}) => void
}

// A static route calls one function; a dynamic route (`<P>/*rest`) resolves below the noStrict node
// at P on every request, as RPC resolves that subtree at call time.
type tRoute = {
    method: tHttpFacadeMethod
    path: string[]
    route: string
    fn: (...args: any[]) => any
    context: object
    dynamic: false
} | {
    method: tHttpFacadeMethod
    path: string[]
    route: string
    node: object
    dynamic: true
}

const registrations = new WeakMap<object, Set<string>>()
/** The wildcard a dynamic route ends with; a static route's segments are encoded and never end so. */
const REST = '*rest'
const REQUEST_ERROR = Symbol('httpFacadeRequestError')
const NOT_FOUND = Symbol('httpFacadeNotFound')

// ===================================================================
// route discovery
// ===================================================================

function normalizeBasePath(basePath: string) {
    if (typeof basePath != 'string') throw new Error('HTTP facade basePath must be a string')
    if (basePath.includes('?') || basePath.includes('#')) {
        throw new Error('HTTP facade basePath must not contain a query or fragment')
    }
    const normalized = `/${basePath}`.replace(/\/{2,}/g, '/').replace(/\/$/, '')
    return normalized == '' ? '/' : normalized
}

function encodePathSegment(segment: string) {
    if (segment == '.' || segment == '..') {
        throw new Error(`HTTP facade contains a URL dot segment: ${segment}`)
    }
    return encodeURIComponent(segment).replace(/[!'()*]/g, function encodeExtra(char) {
        return `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    })
}

function makeRoute(basePath: string, path: readonly string[]) {
    const suffix = path.map(encodePathSegment).join('/')
    return basePath == '/' ? `/${suffix}` : `${basePath}/${suffix}`
}

function discoverRoutes(object: object, method: tHttpFacadeMethod, basePath: string, limits: Required<RpcLimits>): tRoute[] {
    const dynamicRoutes: tRoute[] = []
    // a noStrict object becomes one wildcard route; a noStrict function holds no members, so no route
    function takeDynamic(value: unknown, path: string[]) {
        if (facadeNodeKind(value) != 'dynamic') return false
        if (value != null && typeof value == 'object') {
            // no member fits below it: the route could only ever answer 413 (MCP refuses the same node)
            if (path.length >= limits.maxPathLen) {
                throw new Error(`HTTP facade: noStrict node ${JSON.stringify(path)} is too deep for limits.maxPathLen (${limits.maxPathLen})`)
            }
            dynamicRoutes.push({method, path, route: `${makeRoute(basePath, path)}/${REST}`, node: value, dynamic: true})
        }
        return true
    }
    const staticRoutes = walkFacade(object, {label: 'HTTP facade', take: takeDynamic}).map((entry): tRoute => ({
        method,
        path: entry.path,
        route: makeRoute(basePath, entry.path),
        fn: entry.fn,
        context: entry.context,
        dynamic: false,
    }))
    return [...staticRoutes, ...dynamicRoutes]
}

// A dynamic route answers its whole subtree on the app, so a route below it from another call would
// either never answer or hide part of the node, whichever Express reaches first. Keys are
// `<method>\0<route>`, so only one method's routes overlap.
function claims(dynamicKey: string, key: string) {
    return dynamicKey.endsWith(`/${REST}`) && key.startsWith(dynamicKey.slice(0, -REST.length))
}

function overlapOf(key: string, registered: ReadonlySet<string>) {
    for (const other of registered) if (claims(other, key) || claims(key, other)) return other
    return undefined
}

// ===================================================================
// dynamic resolution (below a noStrict node)
// ===================================================================

/** The function at `segments` below a noStrict node and its owner, or undefined. The RPC rule
 *  (rpc-member.ts); only an object holds members, and a stream's members stay the producer's.
 *  Bytes hold none either, as on MCP: Buffer.prototype (write, fill, swap16) is not a sampled builtin. */
function resolveDynamic(node: object, segments: readonly string[]) {
    let owner: object = node
    let current: unknown = node
    for (const segment of segments) {
        if (current == null || typeof current != 'object' || facadeNodeKind(current) == 'listen') return undefined
        if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) return undefined
        owner = current
        current = dynamicMember(current, segment)
        if (current === undefined) return undefined
    }
    if (typeof current != 'function' || facadeNodeKind(current) == 'on') return undefined
    return {fn: current as (...args: any[]) => any, owner}
}

// ===================================================================
// request / response codec
// ===================================================================

function requestError(message: string) {
    const error = new Error(message) as Error & {[REQUEST_ERROR]: true}
    error[REQUEST_ERROR] = true
    return error
}

function notFoundError(message: string) {
    const error = new Error(message) as Error & {[NOT_FOUND]: true}
    error[NOT_FOUND] = true
    return error
}

function getRawArgs(req: Request, method: tHttpFacadeMethod) {
    if (method == 'get') {
        const encoded = req.query['args']
        if (encoded == null || encoded == '') return []
        if (typeof encoded != 'string') throw requestError('GET query "args" must be one JSON array')
        try {
            return JSON.parse(encoded)
        } catch {
            throw requestError('GET query "args" contains invalid JSON')
        }
    }

    const body = req.body
    if (body == null) return []
    if (Array.isArray(body)) return body
    if (typeof body == 'object' && Object.prototype.hasOwnProperty.call(body, 'args')) {
        return (body as {args?: unknown}).args
    }
    throw requestError('POST body must be a JSON array or an object with an "args" array')
}

function decodeArgs(req: Request, method: tHttpFacadeMethod, limits: Required<RpcLimits>) {
    const raw = getRawArgs(req, method)
    if (!Array.isArray(raw)) throw requestError('HTTP facade args must be an array')
    if (raw.length > limits.maxArgs) throw new PayloadLimitError('too many args')
    return unpackResult(raw, limits)
}

function statusForError(error: unknown) {
    if (error instanceof PayloadLimitError) return 413
    if (error != null && typeof error == 'object' && REQUEST_ERROR in error) return 400
    if (error != null && typeof error == 'object' && NOT_FOUND in error) return 404
    return 500
}

/** The function this request calls: the route's own, or the one resolved below its noStrict node. */
function targetOf(route: tRoute, req: Request, limits: Required<RpcLimits>) {
    if (!route.dynamic) return {fn: route.fn, owner: route.context}
    const rest: unknown = req.params['rest']
    if (!Array.isArray(rest) || rest.length == 0) throw notFoundError('No member below the dynamic node')
    // non-strict routing lets a static route take one trailing slash; the wildcard keeps it as an empty last segment
    const segments = rest.length > 1 && rest[rest.length - 1] == '' ? rest.slice(0, -1) : rest
    if (route.path.length + segments.length > limits.maxPathLen) throw new PayloadLimitError('path too long')
    for (const segment of segments) {
        if (typeof segment != 'string' || segment == '') throw requestError('HTTP facade path contains an empty segment')
        if (!isSafeKey(segment)) throw requestError(`HTTP facade path contains a forbidden segment: ${segment}`)
    }
    const target = resolveDynamic(route.node, segments)
    if (!target) {
        // the caller sent the path: name it, but never echo an arbitrarily long key back
        const requested = [...route.path, ...segments].join('.')
        throw notFoundError(`Not a function: ${requested.length > 200 ? requested.slice(0, 200) + '…' : requested}`)
    }
    return target
}

function createRouteHandler(route: tRoute, limits: Required<RpcLimits>, onError?: HttpFacadeServerOptions<object>['onError']) {
    return async function handleHttpFacadeRequest(req: Request, res: Response) {
        try {
            const target = targetOf(route, req, limits)
            const args = decodeArgs(req, route.method, limits)
            const value = await target.fn.apply(target.owner, args)
            res.json({ok: true, value: packResult(value)})
        } catch (error) {
            const status = statusForError(error)
            // a failing operator hook must not cost the caller its reply
            try { onError?.(error, {route: route.route, status}) } catch {}
            // errToObj carries no stack at any cause depth: HTTP callers get facts, never server frames
            res.status(status).json({ok: false, error: errToObj(error)})
        }
    }
}

// ===================================================================
// public factory
// ===================================================================

export function createHttpFacadeServer<T extends object>(options: HttpFacadeServerOptions<T>) {
    const {app, object, method} = options
    if (method != 'get' && method != 'post') throw new Error(`Unsupported HTTP facade method: ${String(method)}`)
    if (object == null || typeof object != 'object') throw new Error('HTTP facade object must be an object')
    if (app == null || typeof app[method] != 'function') throw new Error('HTTP facade app must register GET and POST routes')
    const basePath = normalizeBasePath(options.basePath)
    const limits = resolveLimits(options.limits)
    const routes = discoverRoutes(object, method, basePath, limits)
    const middleware = options.middleware == null
        ? []
        : Array.isArray(options.middleware) ? [...options.middleware] : [options.middleware]

    let registered = registrations.get(app as object)
    if (!registered) {
        registered = new Set()
        registrations.set(app as object, registered)
    }

    for (const route of routes) {
        const key = `${route.method}\u0000${route.route}`
        if (registered.has(key)) {
            throw new Error(`HTTP facade route is already registered: ${route.method.toUpperCase()} ${route.route}`)
        }
        const other = overlapOf(key, registered)
        if (other != undefined) {
            throw new Error(`HTTP facade route ${route.method.toUpperCase()} ${route.route} overlaps the registered `
                + `${other.split('\u0000')[1]}: a dynamic route answers everything below it`)
        }
    }

    const register = app[method].bind(app) as (path: string, ...handlers: RequestHandler[]) => unknown
    for (const route of routes) {
        register(route.route, ...middleware, createRouteHandler(route, limits, options.onError))
        registered.add(`${route.method}\u0000${route.route}`)
    }

    return {
        routes: () => routes.map(route => ({
            method: route.method,
            path: [...route.path],
            route: route.route,
            /** `<P>/*rest`: resolved below the noStrict node at `path` on every request. */
            dynamic: route.dynamic,
        })),
    }
}

export type HttpFacadeServer = ReturnType<typeof createHttpFacadeServer>
