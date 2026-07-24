import type {Express, Request, RequestHandler, Response} from 'express'

import {isSafeKey, PayloadLimitError, resolveLimits, type RpcLimits} from '../Common/rcp/rpc-limits'
import {errToObj, packResult, unpackResult} from '../Common/rcp/rpc-walk'

export type tHttpFacadeMethod = 'get' | 'post'

export type HttpFacadeServerOptions<T extends object> = {
    app: Pick<Express, 'get' | 'post'>
    object: T
    method: tHttpFacadeMethod
    basePath: string
    middleware?: RequestHandler | readonly RequestHandler[]
    limits?: RpcLimits
}

type tRoute = {
    method: tHttpFacadeMethod
    path: string[]
    route: string
    fn: (...args: any[]) => any
    context: object
}

const registrations = new WeakMap<object, Set<string>>()
const REQUEST_ERROR = Symbol('httpFacadeRequestError')

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

function discoverRoutes(object: object, method: tHttpFacadeMethod, basePath: string) {
    const routes: tRoute[] = []
    const ancestors = new Set<object>()

    function visit(node: object, path: string[]) {
        if (ancestors.has(node)) {
            throw new Error(`HTTP facade contains a circular branch at ${JSON.stringify(path)}`)
        }
        ancestors.add(node)
        try {
            for (const key of Object.keys(node)) {
                if (!isSafeKey(key)) throw new Error(`HTTP facade contains a forbidden key: ${key}`)
                if (key.length == 0) throw new Error('HTTP facade contains an empty path segment')

                const value = (node as any)[key]
                const nextPath = [...path, key]
                if (typeof value == 'function') {
                    routes.push({
                        method,
                        path: nextPath,
                        route: makeRoute(basePath, nextPath),
                        fn: value,
                        context: node,
                    })
                    continue
                }
                if (value != null && typeof value == 'object') visit(value, nextPath)
            }
        } finally {
            ancestors.delete(node)
        }
    }

    visit(object, [])
    return routes
}

// ===================================================================
// request / response codec
// ===================================================================

function requestError(message: string) {
    const error = new Error(message) as Error & {[REQUEST_ERROR]: true}
    error[REQUEST_ERROR] = true
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
    return 500
}

function createRouteHandler(route: tRoute, limits: Required<RpcLimits>) {
    return async function handleHttpFacadeRequest(req: Request, res: Response) {
        try {
            const args = decodeArgs(req, route.method, limits)
            const value = await route.fn.apply(route.context, args)
            res.json({ok: true, value: packResult(value)})
        } catch (error) {
            res.status(statusForError(error)).json({ok: false, error: errToObj(error)})
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
    const routes = discoverRoutes(object, method, basePath)
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
    }

    const register = app[method].bind(app) as (path: string, ...handlers: RequestHandler[]) => unknown
    for (const route of routes) {
        register(route.route, ...middleware, createRouteHandler(route, limits))
        registered.add(`${route.method}\u0000${route.route}`)
    }

    return {
        routes: () => routes.map(route => ({
            method: route.method,
            path: [...route.path],
            route: route.route,
        })),
    }
}

export type HttpFacadeServer = ReturnType<typeof createHttpFacadeServer>
