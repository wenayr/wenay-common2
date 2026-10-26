// ============================================================
//  src/server/facadeMeta.ts  (wenay-common2/server/http, wenay-common2/server/mcp)
//
//  What a facade function cannot say about itself: its description and the schema of its
//  arguments. One metadata set feeds every adapter that needs more than the function — the
//  OpenAPI document and the MCP tool list — so the two cannot drift. It lives next to the
//  implementation (describeMethod stores it on the function under a registered symbol) or,
//  for a facade you do not own, in a `meta` map keyed by the dotted path.
// ============================================================

const FACADE_METHOD_META = Symbol.for('wenay-common2.facade.methodMeta')

/** MCP tool hints. The dynamic runtime's module tool annotations are the same type. */
export type McpToolAnnotations = {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
}

/** One positional argument: exposed by name, passed by position. */
export type FacadeMethodArg = {
    name: string
    schema: object
    description?: string
    optional?: boolean
}

export type FacadeMethodMeta = {
    description: string
    title?: string
    /** JSON Schema (type 'object') of the ONE object argument: `(args: T) => R`. */
    input?: object
    /** Named positional arguments in call order; exclusive with `input`. */
    args?: readonly FacadeMethodArg[]
    /** JSON Schema (type 'object') of the structured result. */
    output?: object
    annotations?: McpToolAnnotations
    /** The function takes a trailing call context (MCP: signal, progress, session, principal). */
    context?: boolean
}

/** Metadata by dotted facade path ('journal.history') for functions you cannot describe in place. */
export type tFacadeMetaMap = Readonly<Record<string, FacadeMethodMeta>>

// ===================================================================
// validation — a wrong descriptor is refused where it is written
// ===================================================================

const ANNOTATION_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value == 'object' && !Array.isArray(value)
}

function objectSchema(value: unknown, field: string, where: string) {
    if (!isPlainObject(value) || value['type'] != 'object') {
        throw new Error(`Facade metadata ${where}: ${field} must be a JSON Schema of type 'object'`)
    }
    return value
}

function checkArgs(value: unknown, where: string) {
    if (!Array.isArray(value)) throw new Error(`Facade metadata ${where}: args must be an array`)
    const names = new Set<string>()
    return Object.freeze(value.map(function checkArg(arg: unknown, index: number) {
        if (!isPlainObject(arg) || typeof arg['name'] != 'string' || arg['name'].length == 0) {
            throw new Error(`Facade metadata ${where}: args[${index}] needs a non-empty name`)
        }
        const name = arg['name']
        if (names.has(name)) throw new Error(`Facade metadata ${where}: duplicate argument name ${name}`)
        names.add(name)
        if (!isPlainObject(arg['schema'])) {
            throw new Error(`Facade metadata ${where}: argument ${name} needs a JSON Schema object`)
        }
        if (arg['description'] != null && typeof arg['description'] != 'string') {
            throw new Error(`Facade metadata ${where}: argument ${name} description must be a string`)
        }
        return Object.freeze({...arg}) as FacadeMethodArg
    }))
}

/** A frozen, checked copy; throws naming `where` on the first defect. */
export function checkMethodMeta(meta: unknown, where: string): FacadeMethodMeta {
    if (!isPlainObject(meta)) throw new Error(`Facade metadata ${where}: must be an object`)
    if (typeof meta['description'] != 'string' || meta['description'].trim() == '') {
        throw new Error(`Facade metadata ${where}: description must be a non-empty string`)
    }
    if (meta['title'] != null && typeof meta['title'] != 'string') {
        throw new Error(`Facade metadata ${where}: title must be a string`)
    }
    if (meta['input'] != null && meta['args'] != null) {
        throw new Error(`Facade metadata ${where}: input and args are exclusive (one object argument or positional ones)`)
    }
    const out: Record<string, unknown> = {...meta}
    if (meta['input'] != null) out['input'] = objectSchema(meta['input'], 'input', where)
    if (meta['args'] != null) out['args'] = checkArgs(meta['args'], where)
    if (meta['output'] != null) out['output'] = objectSchema(meta['output'], 'output', where)
    if (meta['annotations'] != null) {
        const annotations = meta['annotations']
        if (!isPlainObject(annotations)) throw new Error(`Facade metadata ${where}: annotations must be an object`)
        for (const key of ANNOTATION_KEYS) {
            if (annotations[key] != null && typeof annotations[key] != 'boolean') {
                throw new Error(`Facade metadata ${where}: annotations.${key} must be a boolean`)
            }
        }
        out['annotations'] = Object.freeze({...annotations})
    }
    if (meta['context'] != null && typeof meta['context'] != 'boolean') {
        throw new Error(`Facade metadata ${where}: context must be a boolean`)
    }
    return Object.freeze(out) as FacadeMethodMeta
}

// ===================================================================
// public helpers
// ===================================================================

/** Attaches metadata to the function itself and returns the same function, type unchanged. */
export function describeMethod<F extends (...args: any[]) => any>(fn: F, meta: FacadeMethodMeta): F {
    if (typeof fn != 'function') throw new Error('describeMethod needs a function')
    const checked = checkMethodMeta(meta, fn.name ? `of ${fn.name}` : 'of an anonymous function')
    // non-enumerable: no adapter walks into a function, and none should see this as data
    Object.defineProperty(fn, FACADE_METHOD_META, {value: checked, configurable: true})
    return fn
}

/** The metadata describeMethod attached, or undefined. */
export function methodMeta(fn: unknown): FacadeMethodMeta | undefined {
    return typeof fn == 'function' ? (fn as any)[FACADE_METHOD_META] : undefined
}

export function facadeMetaKey(path: readonly string[]) {
    return path.join('.')
}

/** Checks every entry of a `meta` map once. */
export function checkMetaMap(map: tFacadeMetaMap | undefined) {
    if (map == null) return undefined
    if (!isPlainObject(map)) throw new Error('Facade metadata map must be an object keyed by dotted path')
    const out: Record<string, FacadeMethodMeta> = {}
    for (const key of Object.keys(map)) out[key] = checkMethodMeta(map[key], `for ${key}`)
    return out as tFacadeMetaMap
}

/** The map entry for this path, else what the function carries. */
export function resolveMethodMeta(fn: unknown, path: readonly string[], map?: tFacadeMetaMap) {
    const key = facadeMetaKey(path)
    return map != null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : methodMeta(fn)
}

// ===================================================================
// the two projections of one argument description
// ===================================================================

function withDescription(arg: FacadeMethodArg) {
    return arg.description == null ? arg.schema : {...arg.schema, description: arg.description}
}

/** MCP: the arguments object. Positional args become named properties in call order. */
export function methodInputSchema(meta: FacadeMethodMeta | undefined): Record<string, unknown> {
    if (meta?.input) return meta.input as Record<string, unknown>
    if (meta?.args) {
        const properties: Record<string, object> = {}
        const required: string[] = []
        for (const arg of meta.args) {
            properties[arg.name] = withDescription(arg)
            if (!arg.optional) required.push(arg.name)
        }
        return {
            type: 'object',
            properties,
            ...(required.length ? {required} : {}),
            additionalProperties: false,
        }
    }
    return {type: 'object'}
}

/** HTTP: the positional tuple of a POST body; undefined = undocumented, the generic array stands. */
export function methodArgTuple(meta: FacadeMethodMeta | undefined): object[] | undefined {
    if (meta?.input) return [meta.input]
    if (meta?.args) return meta.args.map(withDescription)
    return undefined
}
