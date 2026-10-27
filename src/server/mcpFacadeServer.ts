// ============================================================
//  src/server/mcpFacadeServer.ts  (wenay-common2/server/mcp)
//
//  MCP tools generated from a facade: the walk of the HTTP adapter (facadeWalk.ts), the
//  metadata of the OpenAPI document (facadeMeta.ts), handlers registered on the official
//  SDK's low-level Server. McpServer.registerTool takes zod shapes only, while facade
//  metadata is JSON Schema — so this layer owns tools/list and tools/call (and the
//  resources/* methods when the facade has Listen streams or noStrict nodes) of the server it
//  is attached to. A noStrict node is a resource template resolved per request as RPC resolves
//  it, optionally with a `<path>.call` dispatcher tool. No domain logic lives here: ordering,
//  journaling, receipts, admission and audit are the host's, through policy and the `around` chain.
// ============================================================

import {randomUUID} from 'node:crypto'

import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import type {RequestHandlerExtra} from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js'
import {
    CallToolRequestSchema,
    CompleteRequestSchema,
    ErrorCode,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListToolsRequestSchema,
    McpError,
    ReadResourceRequestSchema,
    SubscribeRequestSchema,
    UnsubscribeRequestSchema,
    type CallToolResult,
    type ServerNotification,
    type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv'

import {createAsyncQueue} from '../Common/async/waitRun'
import {isListenOn, listen} from '../Common/events/Listen'
import {isNoStrict} from '../Common/rcp/rpc-dynamic'
import {isSafeKey, PayloadLimitError, resolveLimits, type RpcLimits} from '../Common/rcp/rpc-limits'
import {errToObj, packResult, unpackResult, walk} from '../Common/rcp/rpc-walk'
import {MyError} from '../toError/myThrow'
import {
    checkMetaMap,
    dynamicMeta,
    facadeMetaKey,
    methodInputSchema,
    methodMeta,
    resolveMethodMeta,
    type FacadeDynamicMeta,
    type FacadeMethodMeta,
    type McpToolAnnotations,
    type tFacadeMetaMap,
} from './facadeMeta'
import {dynamicMember, facadeNodeKind, walkFacade} from './facadeWalk'

// ===================================================================
// names
// ===================================================================

// 'mcp': the specification's tool-name rule; 'claude': the stricter rule of the Claude API.
const NAME_RULES = {
    mcp: {pattern: /^[A-Za-z0-9_.-]+$/, disallowed: /[^A-Za-z0-9_.-]/g, max: 128},
    claude: {pattern: /^[A-Za-z0-9_-]+$/, disallowed: /[^A-Za-z0-9_-]/g, max: 64},
} as const

export type tMcpToolNameCharset = keyof typeof NAME_RULES
export type tMcpConcurrency = 'serial' | 'parallel'
/** A noStrict node over MCP: 'read' = a resource template, 'call' = also the `<path>.call` dispatcher tool, false = hidden. */
export type tMcpDynamic = false | 'read' | 'call'

// ===================================================================
// the SDK as this layer touches it
// ===================================================================
// Structural on purpose. The SDK's CommonJS declarations of Server/McpServer/validators reach
// dist/cjs/validation/types.d.ts, which fails (TS1541) in any project with skipLibCheck: false;
// naming them here would carry that failure into every consumer of this entry. An SDK Server
// satisfies McpServerLike, an McpServer satisfies {server: McpServerLike}.

/** The low-level SDK server surface this adapter registers on and notifies through. */
export type McpServerLike = {
    setRequestHandler(schema: any, handler: (request: any, extra: any) => unknown): void
    removeRequestHandler(method: string): void
    assertCanSetRequestHandler(method: string): void
    registerCapabilities(capabilities: Record<string, unknown>): void
    readonly transport?: unknown
    onclose?: () => void
    sendToolListChanged(): Promise<void>
    sendResourceListChanged(): Promise<void>
    sendResourceUpdated(params: {uri: string}): Promise<void>
    connect(transport: Transport): Promise<void>
    close(): Promise<void>
}

/** JSON Schema validation as the SDK's providers (Ajv, cfworker) implement it. */
export type McpJsonSchemaValidator = {
    getValidator(schema: any): (input: unknown) => {valid: boolean, errorMessage?: string}
}

type tSchemaCheck = ReturnType<McpJsonSchemaValidator['getValidator']>

// ===================================================================
// the two contexts: what `around` sees, what a `context: true` function receives
// ===================================================================

/** Who calls and how to reach back: one per MCP request. */
export type McpCallScope = {
    session: {id: string}
    principal: unknown
    signal: AbortSignal
    progress: (progress: number, total?: number, message?: string) => void
}

function createToolContext(scope: McpCallScope) {
    return {
        signal: scope.signal,
        progress: scope.progress,
        session: scope.session,
        principal: scope.principal,
    }
}

/** The trailing argument of a function described with `context: true`. */
export type McpToolContext = ReturnType<typeof createToolContext>

function createCallContext(tool: string, path: readonly string[], args: readonly unknown[], readOnly: boolean, scope: McpCallScope) {
    return {
        tool,
        path,
        /** Positional arguments as the function receives them (without the context argument). */
        args,
        readOnly,
        session: scope.session,
        principal: scope.principal,
        signal: scope.signal,
    }
}

/** What every `around` middleware sees. */
export type McpCallContext = ReturnType<typeof createCallContext>

/** Middleware around every call: journaling, receipts, timing, audit. `next()` runs the rest. */
export type McpAround = (ctx: McpCallContext, next: () => Promise<unknown>) => unknown

export type McpFacadePolicy = {
    /** Fills readOnlyHint where metadata does not set it, e.g. `path => path[0] == 'view'`. */
    readOnly?: (path: readonly string[]) => boolean | undefined
    /** 'serial' (default): one ordered queue shared by every session; 'parallel': the tool orders itself. */
    concurrency?: (path: readonly string[]) => tMcpConcurrency
    /** A zero-argument function at this path is also an MCP resource (read = call). */
    resource?: (path: readonly string[]) => boolean
    /** A noStrict node at this path: 'read' (default, a resource template), 'call' (also `<path>.call`), false (hidden). */
    dynamic?: (path: readonly string[]) => tMcpDynamic | undefined
}

export type McpFacadeFinding = {path: string, message: string}

export type McpFacadeServerOptions<T extends object> = {
    name: string
    version: string
    /** Server instructions sent at initialize (servers created by control.server). */
    instructions?: string
    object: T
    meta?: tFacadeMetaMap
    /** Every function needs description and input/args; a meta key naming nothing is refused too. */
    strict?: boolean
    /** Read-only server: only readOnlyHint tools are listed, a call to any other is refused. */
    readOnly?: boolean
    policy?: McpFacadePolicy
    around?: McpAround | readonly McpAround[]
    /** Presentation hook: a full tool result, or undefined for the default encoding. */
    formatResult?: (path: readonly string[], value: unknown) => CallToolResult | undefined
    limits?: RpcLimits
    names?: {
        /** Joins path segments; default '.'. */
        separator?: string
        /** Default 'mcp' ([A-Za-z0-9_.-], 128); 'claude' ([A-Za-z0-9_-], 64). */
        charset?: tMcpToolNameCharset
        /** Replace disallowed characters with '_' instead of refusing the name. */
        map?: boolean
    }
    /** Listen streams and view functions as MCP resources, noStrict nodes as resource templates; false = never claim resources/*. */
    resources?: false | {
        /** URI scheme: `<scheme>://<path>`; default 'facade'. */
        scheme?: string
        /** Per session, templated URIs included; default 32. */
        maxSubscriptions?: number
        /** Answer completion/complete with the keys of a template; the method is server-wide, so default false. */
        completions?: boolean
    }
    /** JSON Schema validation of input and output; default the SDK's Ajv provider, false = off. */
    validator?: McpJsonSchemaValidator | false
    /** Non-strict findings (a function without metadata); default console.warn. */
    onFinding?: (finding: McpFacadeFinding) => void
}

export type McpAttachSession = {
    /** Stable id for this attachment; default the transport's session id, else a random UUID. */
    id?: string
    principal?: unknown
}


// ===================================================================
// small pure helpers
// ===================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value == 'object' && !Array.isArray(value)
}

function binaryByteLength(value: unknown) {
    if (ArrayBuffer.isView(value)) return value.byteLength
    if (value instanceof ArrayBuffer) return value.byteLength
    return null
}

/** Undescribed-member findings one dynamic node may report before it reports only that there are more. */
const MAX_DYNAMIC_FINDINGS = 64

/** Path of the first noStrict node below the top of a value read as data, or null. Runs before the limits
 *  walk, which would enumerate such a node and bypass its has trap; it never enters one, and it stops
 *  where that walk stops (a cycle at maxDepth on its first branch, an oversized array or object). */
function findNestedDynamic(value: unknown, limits: Required<RpcLimits>, path: string[] = []): string[] | null {
    if (path.length > limits.maxDepth) throw new PayloadLimitError('max depth exceeded')
    if (value == null || typeof value != 'object' || binaryByteLength(value) != null) return null
    if (path.length > 0 && isNoStrict(value)) return path
    if (value instanceof Date || value instanceof RegExp) return null
    // Map and Set contents are packed too (their serializer walks them), so they are bounded like arrays
    const size = value instanceof Map || value instanceof Set ? value.size : Array.isArray(value) ? value.length : null
    if (size != null) {
        if (size > limits.maxArrayLen) throw new PayloadLimitError('array too long')
        const items: unknown[] = value instanceof Map ? [...value.entries()] : value instanceof Set ? [...value] : value as unknown[]
        for (let i = 0; i < items.length; i++) {
            const found = findNestedDynamic(items[i], limits, [...path, String(i)])
            if (found) return found
        }
        return null
    }
    const keys = Object.keys(value)
    if (keys.length > limits.maxKeys) throw new PayloadLimitError('too many keys in object')
    for (const key of keys) {
        if (!isSafeKey(key)) continue
        const found = findNestedDynamic((value as any)[key], limits, [...path, key])
        if (found) return found
    }
    return null
}

/** Path of the first binary leaf below the top level, or null. Runs after the limits walk. */
function findNestedBinary(value: unknown, path: string[] = []): string[] | null {
    if (value == null || typeof value != 'object') return null
    if (path.length > 0 && binaryByteLength(value) != null) return path
    const keys = Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value)
    for (const key of keys) {
        const found = findNestedBinary((value as any)[key], [...path, key])
        if (found) return found
    }
    return null
}

function linkedAbort(parents: readonly (AbortSignal | undefined)[]) {
    const controller = new AbortController()
    const offs: (() => void)[] = []
    for (const parent of parents) {
        if (!parent) continue
        if (parent.aborted) { controller.abort(parent.reason); break }
        function abortChild() { controller.abort(parent!.reason) }
        parent.addEventListener('abort', abortChild, {once: true})
        offs.push(function releaseParent() { parent.removeEventListener('abort', abortChild) })
    }
    return {
        signal: controller.signal,
        release: function releaseLinkedAbort() { for (const off of offs) off() },
    }
}

function errorResult(error: unknown): CallToolResult {
    // no stack: the caller gets the facts (RPC-AUTH.md "Errors reach peers without stack frames")
    return {isError: true, content: [{type: 'text', text: JSON.stringify({error: errToObj(MyError.wrap(error))})}]}
}

function noProgress() {}

// ===================================================================
// shared core: one per createMcpFacadeServer, shared by every derived surface
// ===================================================================

function createShared<T extends object>(deps: McpFacadeServerOptions<T>) {
    if (typeof deps.name != 'string' || deps.name == '') throw new Error('MCP facade name must be a non-empty string')
    if (typeof deps.version != 'string' || deps.version == '') throw new Error('MCP facade version must be a non-empty string')
    const separator = deps.names?.separator ?? '.'
    if (typeof separator != 'string' || separator == '') throw new Error('MCP facade names.separator must be a non-empty string')
    const charset = deps.names?.charset ?? 'mcp'
    const rule = NAME_RULES[charset]
    if (!rule) throw new Error(`MCP facade names.charset must be 'mcp' or 'claude', got ${String(charset)}`)
    const resourceOptions = deps.resources === false ? null : deps.resources ?? {}
    const scheme = resourceOptions?.scheme ?? 'facade'
    if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) throw new Error(`MCP facade resources.scheme is not a URI scheme: ${scheme}`)
    const maxSubscriptions = resourceOptions?.maxSubscriptions ?? 32
    if (!Number.isSafeInteger(maxSubscriptions) || maxSubscriptions < 0) {
        throw new Error('MCP facade resources.maxSubscriptions must be a non-negative integer')
    }
    const completions = resourceOptions?.completions == true
    const limits = resolveLimits(deps.limits)

    const around = deps.around == null ? [] : Array.isArray(deps.around) ? [...deps.around] : [deps.around as McpAround]
    const validator: McpJsonSchemaValidator | null = deps.validator === false ? null : deps.validator ?? new AjvJsonSchemaValidator()
    const validators = new WeakMap<FacadeMethodMeta, {input?: tSchemaCheck, output?: tSchemaCheck}>()
    const seenFindings = new Set<string>()
    const findings: McpFacadeFinding[] = []
    const queue = createAsyncQueue(1)
    const disposal = new AbortController()
    const attachments = new Set<tAttachment>()
    const [emitCalled, called] = listen<McpCallEvent>()
    const [emitFailed, failed] = listen<McpFailEvent>()

    function toolName(path: readonly string[]) {
        let name = path.join(separator)
        if (deps.names?.map) name = name.replace(rule.disallowed, '_')
        if (name.length > rule.max) {
            throw new Error(`MCP facade: tool name "${name}" for path ${JSON.stringify(path)} is longer than ${rule.max} (${charset} names)`)
        }
        if (!rule.pattern.test(name)) {
            throw new Error(`MCP facade: tool name "${name}" for path ${JSON.stringify(path)} has characters outside ${rule.pattern} (${charset} names); set names.separator, names.map or rename the key`)
        }
        return name
    }

    function resourceUri(path: readonly string[]) {
        return `${scheme}://${path.map(encodeURIComponent).join('/')}`
    }

    /** The decoded segments of `<scheme>://a/b`, or null (another scheme, a query or fragment, an empty or
     *  dot segment, a bad escape, more segments than limits.maxPathLen). resourceUri(resourcePath(uri)) is
     *  the canonical form of a URI. */
    function resourcePath(uri: string) {
        const prefix = `${scheme}://`
        if (typeof uri != 'string' || uri.slice(0, prefix.length).toLowerCase() != prefix.toLowerCase()) return null
        const rest = uri.slice(prefix.length)
        if (rest == '' || rest.includes('?') || rest.includes('#')) return null
        // counted before splitting: no longer path resolves, and every prefix is a template lookup
        let count = 1
        for (let at = rest.indexOf('/'); at != -1; at = rest.indexOf('/', at + 1)) {
            if (++count > limits.maxPathLen) return null
        }
        const segments: string[] = []
        for (const raw of rest.split('/')) {
            let segment: string
            try { segment = decodeURIComponent(raw) } catch { return null }
            // a client may normalise '.' and '..' away: such a key is reachable through a dispatcher only
            if (segment == '' || segment == '.' || segment == '..') return null
            segments.push(segment)
        }
        return segments
    }

    function compiled(meta: FacadeMethodMeta) {
        let entry = validators.get(meta)
        if (!entry) {
            entry = validator == null ? {} : {
                input: meta.input || meta.args ? validator.getValidator(methodInputSchema(meta)) : undefined,
                output: meta.output ? validator.getValidator(meta.output) : undefined,
            }
            validators.set(meta, entry)
        }
        return entry
    }

    // Ajv keeps every schema object it compiles: compile once per metadata, never once per rebuild
    const keyChecks = new WeakMap<FacadeDynamicMeta, tSchemaCheck>()
    const dispatchInputs = new WeakMap<object, Map<number, {schema: Record<string, unknown>, check?: tSchemaCheck}>>()
    const undescribedNode = {}

    function compiledKey(meta: FacadeDynamicMeta) {
        if (validator == null || meta.key == null) return undefined
        let check = keyChecks.get(meta)
        if (!check) {
            check = validator.getValidator(meta.key)
            keyChecks.set(meta, check)
        }
        return check
    }

    /** The `<path>.call` input schema and its check; `depth` = how many member segments fit in maxPathLen. */
    function dispatchInput(meta: FacadeDynamicMeta | undefined, depth: number) {
        const owner = meta ?? undescribedNode
        let byDepth = dispatchInputs.get(owner)
        if (!byDepth) dispatchInputs.set(owner, byDepth = new Map())
        let entry = byDepth.get(depth)
        if (!entry) {
            const schema = {
                type: 'object',
                properties: {
                    key: meta?.key ?? {type: 'string', minLength: 1},
                    method: {
                        type: 'array', items: {type: 'string', minLength: 1}, minItems: 1, maxItems: depth,
                        description: 'Member path below the key, e.g. ["start"]',
                    },
                    args: {
                        type: ['object', 'array'],
                        description: 'The member\'s arguments: the object its metadata describes; an undescribed member also takes a positional array',
                    },
                },
                required: ['key', 'method'],
                additionalProperties: false,
            }
            entry = {schema, check: validator?.getValidator(schema)}
            byDepth.set(depth, entry)
        }
        return entry
    }

    function report(finding: McpFacadeFinding) {
        const key = `${finding.path}\u0000${finding.message}`
        if (seenFindings.has(key)) return
        seenFindings.add(key)
        findings.push(finding)
        if (deps.onFinding) deps.onFinding(finding)
        else console.warn(`[mcp facade] ${finding.path}: ${finding.message}`)
    }

    // the member path below a key is the caller's: a node answering any key (a trap, a list of
    // handlers) would add a finding per call, so each dynamic node reports a bounded number
    const dynamicFindings = new Map<string, Set<string>>()

    function reportDynamic(node: readonly string[], member: readonly string[], message: string) {
        const label = node.join('.')
        let seen = dynamicFindings.get(label)
        if (!seen) dynamicFindings.set(label, seen = new Set())
        const path = [...node, '*', ...member].join('.')
        if (seen.has(path)) return
        if (seen.size >= MAX_DYNAMIC_FINDINGS) {
            report({path: `${label}.*`, message: `more than ${MAX_DYNAMIC_FINDINGS} undescribed members: the rest are not reported`})
            return
        }
        seen.add(path)
        report({path, message})
    }

    return {
        deps,
        rule,
        scheme,
        resourceOptions,
        maxSubscriptions,
        completions,
        limits,
        metaMap: checkMetaMap(deps.meta),
        around,
        queue,
        disposal,
        attachments,
        findings,
        events: {emitCalled, emitFailed, called, failed},
        toolName,
        resourceUri,
        resourcePath,
        compiled,
        compiledKey,
        dispatchInput,
        report,
        reportDynamic,
    }
}

type tShared = ReturnType<typeof createShared>

/** One resource subscription and what it listens through: a static stream, or the dynamic node it resolved under. */
type tSubscription = {off: () => void, source: unknown}

type tAttachment = {
    server: McpServerLike
    resources: boolean
    sessionId: string
    principal: unknown
    subscriptions: Map<string, tSubscription>
    pending: Set<string>
    surface: object
    closed: boolean
    detach: () => void
}

function createCallEvent(tool: string, path: readonly string[], session: {id: string}, principal: unknown, durationMs: number) {
    return {tool, path, session, principal, durationMs}
}

export type McpCallEvent = ReturnType<typeof createCallEvent>
export type McpFailEvent = McpCallEvent & {error: unknown}

// ===================================================================
// one walked object: tools + resources, rebuilt by refresh/mount
// ===================================================================

function makeToolEntry(shared: tShared, path: string[], fn: (...args: any[]) => any, context: object) {
    const {deps, metaMap} = shared
    const meta = resolveMethodMeta(fn, path, metaMap)
    const readOnlyHint = meta?.annotations?.readOnlyHint ?? deps.policy?.readOnly?.(path)
    const annotations: McpToolAnnotations | undefined = meta?.annotations || readOnlyHint != null
        ? {...meta?.annotations, ...(readOnlyHint != null ? {readOnlyHint} : {})}
        : undefined
    const name = shared.toolName(path)
    const descriptor = {
        name,
        ...(meta?.title != null ? {title: meta.title} : {}),
        description: meta?.description ?? `Calls ${path.join('.')} on the facade.`,
        inputSchema: methodInputSchema(meta) as {type: 'object', [key: string]: unknown},
        ...(meta?.output != null ? {outputSchema: meta.output as {type: 'object', [key: string]: unknown}} : {}),
        ...(annotations ? {annotations} : {}),
    }
    return {
        name,
        path,
        fn,
        context,
        meta,
        descriptor,
        readOnly: readOnlyHint == true,
        concurrency: deps.policy?.concurrency?.(path) ?? 'serial' as tMcpConcurrency,
        validate: meta ? shared.compiled(meta) : {},
    }
}

type tToolEntry = ReturnType<typeof makeToolEntry>

/** What the call pipeline needs: a static tool, or the member a dispatcher resolved for one call. */
type tCallTarget = Pick<tToolEntry, 'name' | 'path' | 'fn' | 'context' | 'meta' | 'readOnly' | 'concurrency' | 'validate'>

type tListenOn = (cb: (...args: any[]) => void, opts?: {current?: boolean}) => () => void

// ===================================================================
// a noStrict node: a resource template, and with policy.dynamic 'call' a dispatcher tool
// ===================================================================

function makeTemplate(shared: tShared, path: string[], node: object, exposure: 'read' | 'call') {
    const meta = dynamicMeta(node)
    const base = shared.resourceUri(path)
    const name = path.join('.')
    return {
        path,
        node,
        meta,
        base,
        /** The `<path>.call` tool name when the node is callable. */
        dispatcher: exposure == 'call' ? shared.toolName([...path, 'call']) : undefined,
        checkKey: meta ? shared.compiledKey(meta) : undefined,
        descriptor: {
            uriTemplate: `${base}/{key}`,
            name,
            ...(meta?.title != null ? {title: meta.title} : {}),
            description: meta?.description
                ?? `Dynamic keys under ${name}: read ${base}/<key>[/<member>...]; a store reads its current value, data reads as JSON, a plain listen only notifies (subscribe).`,
            mimeType: 'application/json',
        },
    }
}

type tTemplate = ReturnType<typeof makeTemplate>

function makeDispatchEntry(shared: tShared, template: tTemplate) {
    const {deps, limits} = shared
    const label = template.path.join('.')
    // the key is one segment of the resolved path, the member at least one more
    const depth = limits.maxPathLen - template.path.length - 1
    if (depth < 1) throw new Error(`MCP facade: dynamic node ${label} is too deep for limits.maxPathLen (${limits.maxPathLen})`)
    const meta = template.meta
    const readOnlyHint = meta?.annotations?.readOnlyHint ?? deps.policy?.readOnly?.(template.path)
    const annotations: McpToolAnnotations | undefined = meta?.annotations || readOnlyHint != null
        ? {...meta?.annotations, ...(readOnlyHint != null ? {readOnlyHint} : {})}
        : undefined
    const members = Object.entries(meta?.members ?? {}).map(([member, entry]) => `${member}: ${entry.description}`)
    const input = shared.dispatchInput(meta, depth)
    const name = template.dispatcher ?? shared.toolName([...template.path, 'call'])
    // the same descriptor type as a static tool: tools/list stays one shape
    const descriptor: tToolEntry['descriptor'] = {
        name,
        ...(meta?.title != null ? {title: meta.title} : {}),
        description: (meta?.description ?? `Calls a member below a dynamic key of ${label}.`)
            + ' Input: key, method (the member path below the key), args.'
            + (members.length ? ` Members: ${members.join('; ')}.` : ''),
        inputSchema: input.schema as {type: 'object', [key: string]: unknown},
        ...(annotations ? {annotations} : {}),
    }
    return {
        name,
        path: [...template.path, 'call'],
        template,
        descriptor,
        readOnly: readOnlyHint == true,
        check: input.check,
    }
}

type tDispatchEntry = ReturnType<typeof makeDispatchEntry>

function createSurfaceState(shared: tShared, root: object, checkStaleMeta: boolean) {
    const {deps, metaMap} = shared
    const mounts = new Map<string, object>()

    // one shape for both kinds: a Listen stream (on) or a zero-argument view (tool)
    function makeResource(path: string[], source: {on?: tListenOn, tool?: tToolEntry}) {
        const meta = source.tool ? source.tool.meta : resolveMethodMeta(source.on, path, metaMap)
        const uri = shared.resourceUri(path)
        return {
            uri,
            path,
            on: source.on,
            tool: source.tool,
            descriptor: {
                uri,
                name: path.join('.'),
                ...(meta?.title != null ? {title: meta.title} : {}),
                description: meta?.description ?? (source.tool
                    ? source.tool.descriptor.description
                    : `Listen stream ${path.join('.')}: subscribe for change notifications; a store also reads its current value.`),
                mimeType: 'application/json',
            },
        }
    }

    function build() {
        const tools = new Map<string, tToolEntry | tDispatchEntry>()
        const resources = new Map<string, ReturnType<typeof makeResource>>()
        const templates = new Map<string, tTemplate>()
        const missing: string[] = []
        const undescribed: string[] = []
        const walked = new Set<string>()

        function take(value: unknown, path: string[]) {
            const kind = facadeNodeKind(value)
            if (kind == 'dynamic') {
                addDynamic(path, value as object)
                return true
            }
            if (kind != 'on' && kind != 'listen') return false
            walked.add(facadeMetaKey(path))
            addResource(makeResource(path, {on: (kind == 'on' ? value : (value as {on: unknown}).on) as tListenOn}))
            return true
        }

        function addResource(resource: ReturnType<typeof makeResource>) {
            if (shared.resourceOptions == null) return
            if (resources.has(resource.uri)) throw new Error(`MCP facade: resource ${resource.uri} is registered twice`)
            resources.set(resource.uri, resource)
        }

        function addTool(tool: tToolEntry | tDispatchEntry) {
            const previous = tools.get(tool.name)
            if (previous) {
                throw new Error(`MCP facade: tool name "${tool.name}" is registered twice (${JSON.stringify(previous.path)} and ${JSON.stringify(tool.path)})`)
            }
            tools.set(tool.name, tool)
        }

        // a noStrict node is never enumerated here: its keys are resolved per request
        function addDynamic(path: string[], node: object) {
            const exposure = deps.policy?.dynamic?.(path) ?? 'read'
            // strict comparison: 0 or '' must not pass for false
            if (exposure !== false && exposure != 'read' && exposure != 'call') {
                throw new Error(`MCP facade: policy.dynamic for ${JSON.stringify(path)} must be false, 'read' or 'call', got ${String(exposure)}`)
            }
            if (exposure === false) return
            const template = makeTemplate(shared, path, node, exposure)
            if (shared.resourceOptions != null) {
                if (templates.has(template.base)) throw new Error(`MCP facade: resource template ${template.descriptor.uriTemplate} is registered twice`)
                templates.set(template.base, template)
            }
            if (exposure != 'call') return
            addTool(makeDispatchEntry(shared, template))
            if (deps.strict && !template.meta) undescribed.push(path.join('.'))
        }

        function addAll(object: object, prefix: string[]) {
            // a mounted noStrict fragment is one dynamic node; the facade root never is (the walk refuses it)
            if (prefix.length > 0 && facadeNodeKind(object) == 'dynamic') {
                addDynamic(prefix, object)
                return
            }
            for (const entry of walkFacade(object, {label: 'MCP facade', take: (value, path) => take(value, [...prefix, ...path])})) {
                const path = [...prefix, ...entry.path]
                const tool = makeToolEntry(shared, path, entry.fn, entry.context)
                walked.add(facadeMetaKey(path))
                addTool(tool)
                if (!tool.meta || (!tool.meta.input && !tool.meta.args)) {
                    if (deps.strict) missing.push(path.join('.'))
                    else shared.report({
                        path: path.join('.'),
                        message: tool.meta
                            ? 'no input schema: {type: \'object\'}, the arguments object is passed when non-empty'
                            : 'no metadata: {type: \'object\'} and a generated description',
                    })
                }
                if (deps.policy?.resource?.(path)) {
                    const takesArgs = tool.meta?.input != null || (tool.meta?.args?.length ?? 0) > 0
                        || (!tool.meta && entry.fn.length > 0)
                    if (takesArgs) throw new Error(`MCP facade: ${path.join('.')} takes arguments and cannot be a resource`)
                    addResource(makeResource(path, {tool}))
                }
            }
        }

        addAll(root, [])
        for (const [key, object] of mounts) addAll(object, [key])

        const problems = [
            ...(missing.length ? [`functions without description and input/args: ${missing.join(', ')}`] : []),
            ...(undescribed.length ? [`'call' nodes without describeDynamic: ${undescribed.join(', ')}`] : []),
        ]
        if (problems.length) throw new Error(`MCP facade (strict): ${problems.join('; ')}`)
        if (checkStaleMeta && metaMap) {
            const stale = Object.keys(metaMap).filter(key => !walked.has(key))
            if (stale.length && deps.strict) throw new Error(`MCP facade (strict): meta keys name no facade function: ${stale.join(', ')}`)
            for (const key of stale) shared.report({path: key, message: 'meta entry names no facade function'})
        }
        return {tools, resources, templates}
    }

    let current = build()

    return {
        mounts,
        current: () => current,
        /** Builds the next composition; a refused one leaves the served one in place. */
        rebuild() {
            current = build()
            return current
        },
    }
}

// ===================================================================
// surface: the facade a session sees
// ===================================================================

function createSurface(shared: tShared, root: object, checkStaleMeta: boolean) {
    const {deps, limits, events} = shared
    const state = createSurfaceState(shared, root, checkStaleMeta)
    const surfaceId = {}

    function visibleTools() {
        const tools = [...state.current().tools.values()]
        return deps.readOnly ? tools.filter(tool => tool.readOnly) : tools
    }

    // ============== the call pipeline ==============

    function toCallArgs(tool: tCallTarget, input: Record<string, unknown>) {
        const meta = tool.meta
        let args: unknown[]
        if (meta?.input) args = [input]
        else if (meta?.args) {
            const known = new Set(meta.args.map(arg => arg.name))
            const unknown = Object.keys(input).filter(key => !known.has(key))
            if (unknown.length) throw new MyError(`Unknown argument(s) for ${tool.name}: ${unknown.join(', ')}`, 'E_MCP_ARGS')
            args = meta.args.map(arg => input[arg.name])
            // the context argument keeps its position; without one, omitted trailing args are not passed
            if (!meta.context) while (args.length && args[args.length - 1] === undefined) args.pop()
        } else args = Object.keys(input).length ? [input] : []
        if (args.length > limits.maxArgs) throw new PayloadLimitError('too many args')
        return args
    }

    async function execute(tool: tCallTarget, args: unknown[], scope: McpCallScope) {
        const started = Date.now()
        const ctx = createCallContext(tool.name, tool.path, args, tool.readOnly, scope)
        const callArgs = tool.meta?.context ? [...args, createToolContext(scope)] : args

        function callFunction() {
            return Promise.resolve(tool.fn.apply(tool.context, callArgs))
        }
        function runAround(index: number): Promise<unknown> {
            if (index == shared.around.length) return callFunction()
            return Promise.resolve(shared.around[index](ctx, function next() { return runAround(index + 1) }))
        }
        async function runSlot() {
            // a call cancelled while it waited for its turn never runs
            if (scope.signal.aborted) throw new MyError('MCP call was cancelled before it started', 'E_MCP_CANCELLED')
            return await runAround(0)
        }

        try {
            const value = tool.concurrency == 'parallel' ? await runSlot() : await shared.queue.add(runSlot)
            events.emitCalled(createCallEvent(tool.name, tool.path, scope.session, scope.principal, Date.now() - started))
            return value
        } catch (error) {
            events.emitFailed({...createCallEvent(tool.name, tool.path, scope.session, scope.principal, Date.now() - started), error})
            throw error
        }
    }

    function encodeResult(tool: tCallTarget, value: unknown): CallToolResult {
        const formatted = deps.formatResult?.(tool.path, value)
        if (formatted != null) return formatted
        const bytes = binaryByteLength(value)
        if (bytes != null) {
            if (bytes > limits.maxBinaryLen) throw new PayloadLimitError('binary too long')
            const view = ArrayBuffer.isView(value)
                ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
                : Buffer.from(value as ArrayBuffer)
            return {content: [{type: 'resource', resource: {
                uri: shared.resourceUri([...tool.path, 'result']),
                mimeType: 'application/octet-stream',
                blob: view.toString('base64'),
            }}]}
        }
        const packed = packResult(value)
        walk(packed, function keepLeaf(leaf: unknown) { return leaf }, limits)
        const nested = findNestedBinary(packed)
        if (nested) {
            throw new MyError(`Binary value at ${nested.join('.')} of ${tool.name}: return the bytes as the whole result, or a reference`, 'E_MCP_BINARY')
        }
        const structured = isPlainObject(packed) ? packed : {value: packed ?? null}
        const check = tool.validate.output?.(structured)
        if (check && !check.valid) {
            throw new MyError(`Result of ${tool.name} does not match its output schema: ${check.errorMessage}`, 'E_MCP_OUTPUT')
        }
        return {content: [{type: 'text', text: JSON.stringify(structured)}], structuredContent: structured}
    }

    async function call(name: string, input: unknown, scope: McpCallScope): Promise<CallToolResult> {
        const tool = state.current().tools.get(name)
        if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`)
        // defence in depth: an unlisted tool stays uncallable even by name
        if (deps.readOnly && !tool.readOnly) {
            throw new McpError(ErrorCode.InvalidParams, `Tool ${name} is not read-only and this MCP facade serves reads only`)
        }
        if ('template' in tool) return callDynamic(tool, input, scope)
        if (shared.disposal.signal.aborted) return errorResult(new MyError('MCP facade is disposed', 'E_MCP_DISPOSED'))
        try {
            const raw = input ?? {}
            if (!isPlainObject(raw)) throw new MyError(`Arguments of ${name} must be an object`, 'E_MCP_ARGS')
            const decoded = unpackResult(raw, limits) as Record<string, unknown>
            const check = tool.validate.input?.(raw)
            if (check && !check.valid) throw new MyError(`Invalid arguments for ${name}: ${check.errorMessage}`, 'E_MCP_ARGS')
            const value = await execute(tool, toCallArgs(tool, decoded), scope)
            return encodeResult(tool, value)
        } catch (error) {
            return errorResult(error)
        }
    }

    // ============== dynamic nodes: resolved per request ==============

    /** The node `segments` below a template, as RPC resolves under noStrict; undefined = absent. */
    function resolveBelow(template: tTemplate, segments: readonly string[]) {
        if (template.path.length + segments.length > limits.maxPathLen) throw new PayloadLimitError('path too long')
        for (const segment of segments) {
            if (segment == '' || !isSafeKey(segment)) throw new MyError(`Forbidden path segment: ${segment}`, 'E_MCP_ARGS')
        }
        // the key schema runs before any trap of the node does
        const check = template.checkKey?.(segments[0])
        if (check && !check.valid) {
            throw new MyError(`Invalid key under ${template.path.join('.')}: ${check.errorMessage}`, 'E_MCP_ARGS')
        }
        let parent: object = template.node
        let node: unknown = template.node
        for (const segment of segments) {
            // only an object holds members, as on RPC: a function's statics and name are not reached
            if (node == null || typeof node != 'object') return undefined
            // bytes have no members; a stream is a resource, never a container: emit/close/run stay unreachable
            const kind = nodeKind(node)
            if (kind == 'binary' || kind == 'on' || kind == 'listen') return undefined
            parent = node
            node = dynamicMember(node, segment)
            // strict: a member holding null is present (it reads as null)
            if (node === undefined) return undefined
        }
        return {node, parent}
    }

    /** facadeNodeKind, but bytes are never enumerated: its Listen-shape test lists one key per byte. */
    function nodeKind(node: unknown) {
        return binaryByteLength(node) != null ? 'binary' as const : facadeNodeKind(node)
    }

    function makeDynamicTarget(entry: tDispatchEntry, segments: readonly string[], fn: (...args: any[]) => any, context: object): tCallTarget {
        const path = [...entry.template.path, ...segments]
        const members = entry.template.meta?.members
        const method = segments.slice(1)
        // members is keyed by the dotted path: a segment holding a dot would borrow another member's entry
        const member = method.some(segment => segment.includes('.')) ? undefined : facadeMetaKey(method)
        // a members entry wins over what the function carries, as a meta map entry does
        const meta = member != null && members != null && Object.prototype.hasOwnProperty.call(members, member) ? members[member] : methodMeta(fn)
        return {
            name: entry.name,
            path,
            fn,
            context,
            meta,
            readOnly: (meta?.annotations?.readOnlyHint ?? deps.policy?.readOnly?.(path)) == true,
            concurrency: deps.policy?.concurrency?.(path) ?? 'serial',
            validate: meta ? shared.compiled(meta) : {},
        }
    }

    function dynamicArgs(entry: tDispatchEntry, target: tCallTarget, rawArgs: unknown) {
        const label = target.path.join('.')
        if (target.meta) {
            const raw = rawArgs ?? {}
            if (!isPlainObject(raw)) throw new MyError(`Arguments of ${label} must be the object its metadata describes`, 'E_MCP_ARGS')
            const check = target.validate.input?.(raw)
            if (check && !check.valid) throw new MyError(`Invalid arguments for ${label}: ${check.errorMessage}`, 'E_MCP_ARGS')
            return toCallArgs(target, unpackResult(raw, limits) as Record<string, unknown>)
        }
        if (deps.strict) throw new MyError(`MCP facade (strict): ${label} has no metadata (describeDynamic members or describeMethod)`, 'E_MCP_ARGS')
        // one finding per member path, not per key, and a bounded number per node
        shared.reportDynamic(entry.template.path, target.path.slice(entry.template.path.length + 1),
            'no metadata: args pass unvalidated (an array is positional, an object is the one argument)')
        if (rawArgs == null) return []
        if (!Array.isArray(rawArgs) && !isPlainObject(rawArgs)) throw new MyError(`Arguments of ${label} must be an array or an object`, 'E_MCP_ARGS')
        if (Array.isArray(rawArgs) && rawArgs.length > limits.maxArgs) throw new PayloadLimitError('too many args')
        const decoded = unpackResult(rawArgs, limits)
        if (Array.isArray(decoded)) return decoded as unknown[]
        return Object.keys(decoded).length ? [decoded] : []
    }

    async function callDynamic(entry: tDispatchEntry, input: unknown, scope: McpCallScope): Promise<CallToolResult> {
        if (shared.disposal.signal.aborted) return errorResult(new MyError('MCP facade is disposed', 'E_MCP_DISPOSED'))
        try {
            const raw = input ?? {}
            if (!isPlainObject(raw)) throw new MyError(`Arguments of ${entry.name} must be an object`, 'E_MCP_ARGS')
            // explicit, so they hold with validator: false too
            const {key, method} = raw
            if (typeof key != 'string' || key == '') throw new MyError(`${entry.name}: key must be a non-empty string`, 'E_MCP_ARGS')
            if (!Array.isArray(method) || method.length == 0 || method.some(segment => typeof segment != 'string')) {
                throw new MyError(`${entry.name}: method must be a non-empty array of member names`, 'E_MCP_ARGS')
            }
            if (entry.template.path.length + 1 + method.length > limits.maxPathLen) throw new PayloadLimitError('path too long')
            const check = entry.check?.(raw)
            if (check && !check.valid) throw new MyError(`Invalid arguments for ${entry.name}: ${check.errorMessage}`, 'E_MCP_ARGS')

            const segments = [key, ...method as string[]]
            const label = [...entry.template.path, ...segments].join('.')
            const found = resolveBelow(entry.template, segments)
            if (!found) throw new MyError(`${entry.name}: nothing at ${label}`, 'E_MCP_NOT_FOUND')
            // a Listen's on is a stream, never a call target
            if (typeof found.node != 'function' || isListenOn(found.node)) {
                throw new MyError(`${entry.name}: ${label} is not a function`, 'E_MCP_NOT_FOUND')
            }
            const target = makeDynamicTarget(entry, segments, found.node as (...args: any[]) => any, found.parent)
            // the dispatcher may be listed as read-only; each member still answers for itself
            if (deps.readOnly && !target.readOnly) {
                throw new McpError(ErrorCode.InvalidParams, `${label} is not read-only and this MCP facade serves reads only`)
            }
            const value = await execute(target, dynamicArgs(entry, target, raw['args']), scope)
            return encodeResult(target, value)
        } catch (error) {
            // a protocol refusal stays a protocol error, as for an unlisted tool
            if (error instanceof McpError) throw error
            return errorResult(error)
        }
    }

    // ============== resources ==============

    type tComposition = ReturnType<typeof state.current>

    function findStatic(composition: tComposition, uri: string) {
        const exact = composition.resources.get(uri)
        if (exact) return exact
        // the request URI is parsed once, not once per resource: it may be megabytes long
        let href: string
        try { href = new URL(uri).href } catch { return undefined }
        for (const resource of composition.resources.values()) {
            try { if (new URL(resource.uri).href == href) return resource } catch {}
        }
        return undefined
    }

    /** The template whose base is a proper prefix of `path`; templates never nest, so at most one. */
    function templateAt(composition: tComposition, path: readonly string[]) {
        for (let i = 1; i < path.length; i++) {
            const template = composition.templates.get(shared.resourceUri(path.slice(0, i)))
            if (template) return {template, segments: path.slice(i)}
        }
        return undefined
    }

    /** What a subscription to `uri` listens through in this composition: a static stream, or the dynamic node it resolves under. */
    function sourceIn(composition: tComposition, uri: string) {
        const resource = composition.resources.get(uri)
        if (resource) return resource.on
        const path = shared.resourcePath(uri)
        return path ? templateAt(composition, path)?.template.node : undefined
    }

    /** A static resource, or the value a template resolves for this URI; refusals are protocol errors. */
    function resolveResource(uri: string) {
        const composition = state.current()
        const resource = findStatic(composition, uri)
        if (resource) {
            return {
                uri: resource.uri, on: resource.on, tool: resource.tool,
                template: undefined, value: undefined, kind: undefined, source: resource.on ?? resource.tool as unknown,
            }
        }
        const path = shared.resourcePath(uri)
        const match = path ? templateAt(composition, path) : undefined
        if (path && match) {
            let found
            try {
                found = resolveBelow(match.template, match.segments)
            } catch (error) {
                throw new McpError(ErrorCode.InvalidParams, `Resource ${uri}: ${error instanceof Error ? error.message : String(error)}`)
            }
            if (found) {
                const kind = nodeKind(found.node)
                const on = kind == 'on' ? found.node as tListenOn : kind == 'listen' ? (found.node as {on: tListenOn}).on : undefined
                return {
                    uri: shared.resourceUri(path), on, tool: undefined,
                    template: match.template, value: found.node, kind, source: match.template.node as unknown,
                }
            }
        }
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`)
    }

    function currentValue(uri: string, on: tListenOn) {
        // a store answers its current value synchronously; a plain listen never calls back
        let current: unknown[] | undefined
        const off = on(function captureCurrent(...args: unknown[]) { current ??= args }, {current: true})
        off()
        if (current == undefined) {
            throw new McpError(ErrorCode.InvalidParams,
                `Resource ${uri} has no current value: a plain listen only notifies, a store has none yet`)
        }
        return current.length == 1 ? current[0] : current
    }

    /** A templated value read as data: a function or a dynamic map is refused by name, never stringified. */
    function dataValue(uri: string, resource: ReturnType<typeof resolveResource>) {
        if (typeof resource.value == 'function') {
            throw new McpError(ErrorCode.InvalidParams, resource.template?.dispatcher
                ? `Resource ${uri} is a function: call it with the ${resource.template.dispatcher} tool`
                : `Resource ${uri} is a function: policy.dynamic 'call' exposes the members of ${resource.template?.path.join('.')} as a tool`)
        }
        if (resource.kind == 'dynamic') throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} is a dynamic map: read one of its keys`)
        // the same refusal one level down: reading the parent must not list the map's keys past its has trap
        const nested = findNestedDynamic(resource.value, limits)
        if (nested) {
            throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} holds a dynamic map at ${nested.join('.')}: read its keys one by one`)
        }
        return resource.value
    }

    /** JSON text of a resource value: bounded before packing (packResult has no depth limit), bytes refused. */
    function encodeResourceValue(uri: string, value: unknown, onLeaf: (leaf: unknown) => unknown) {
        walk(value, onLeaf, limits)
        if (binaryByteLength(value) != null) {
            throw new MyError(`Resource ${uri} is binary: resources here carry JSON, return the bytes from a tool`, 'E_MCP_BINARY')
        }
        const packed = packResult(value)
        const nested = findNestedBinary(packed)
        if (nested) throw new MyError(`Binary value at ${nested.join('.')} of resource ${uri}: resources here carry JSON`, 'E_MCP_BINARY')
        return JSON.stringify(packed ?? null)
    }

    async function readResource(uri: string, scope: McpCallScope) {
        const resource = resolveResource(uri)
        let value: unknown
        let onLeaf = function keepLeaf(leaf: unknown) { return leaf }
        if (resource.tool) value = await execute(resource.tool, [], scope)
        else if (resource.on) value = currentValue(uri, resource.on)
        else {
            value = dataValue(uri, resource)
            onLeaf = function refuseFunctionLeaf(leaf: unknown) {
                if (typeof leaf == 'function') {
                    throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} is a subtree with functions: read a data member below it`)
                }
                return leaf
            }
        }
        return {contents: [{uri: resource.uri, mimeType: 'application/json', text: encodeResourceValue(uri, value, onLeaf)}]}
    }

    function subscribe(attachment: tAttachment, uri: string) {
        const resource = resolveResource(uri)
        if (!resource.on) throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} has no change stream to subscribe to`)
        if (attachment.subscriptions.has(resource.uri)) return
        if (attachment.subscriptions.size >= shared.maxSubscriptions) {
            throw new McpError(ErrorCode.InvalidParams, `Subscription limit reached (${shared.maxSubscriptions} per session)`)
        }
        const target = resource.uri
        // emits within one tick coalesce into one notification: MCP says "changed, reread", not replay
        function notifyUpdated() {
            if (attachment.closed || attachment.pending.has(target)) return
            attachment.pending.add(target)
            queueMicrotask(function sendResourceUpdated() {
                attachment.pending.delete(target)
                if (attachment.closed || !attachment.subscriptions.has(target)) return
                attachment.server.sendResourceUpdated({uri: target}).catch(function ignoreClosedTransport() {})
            })
        }
        attachment.subscriptions.set(target, {off: resource.on(notifyUpdated), source: resource.source})
    }

    function unsubscribe(attachment: tAttachment, uri: string) {
        // canonical form without resolving: unsubscribing runs no trap of a dynamic node; a static
        // URI is matched as subscribe matched it, so every spelling that subscribed also unsubscribes
        const resource = findStatic(state.current(), uri)
        const path = resource ? null : shared.resourcePath(uri)
        const key = resource?.uri ?? (path ? shared.resourceUri(path) : uri)
        attachment.subscriptions.get(key)?.off()
        attachment.subscriptions.delete(key)
    }

    function templateDescriptors() {
        return [...state.current().templates.values()].map(template => template.descriptor)
    }

    // ============== completion of template keys ==============

    function completeKeys(template: tTemplate, prefix: string) {
        let keys: string[]
        try { keys = Object.keys(template.node) } catch { keys = [] }
        const values = keys.filter(function offeredKey(key) {
            if (key == '' || !isSafeKey(key) || !key.startsWith(prefix)) return false
            if (template.checkKey && !template.checkKey(key).valid) return false
            // the has trap is the access point: a key it denies is never offered, and no get trap runs
            try { return Reflect.has(template.node, key) } catch { return false }
        })
        return {values: values.slice(0, 100), total: values.length, hasMore: values.length > 100}
    }

    function complete(ref: {type: string, uri?: string}, argument: {name: string, value: string}) {
        if (ref.type != 'ref/resource' || typeof ref.uri != 'string') {
            throw new McpError(ErrorCode.InvalidParams, 'This MCP facade completes the keys of its resource templates only')
        }
        const composition = state.current()
        if (findStatic(composition, ref.uri)) return {values: [], total: 0, hasMore: false}
        const template = [...composition.templates.values()].find(template => template.descriptor.uriTemplate == ref.uri)
        if (!template) throw new McpError(ErrorCode.InvalidParams, `Unknown resource template: ${ref.uri}`)
        if (argument.name != 'key') throw new McpError(ErrorCode.InvalidParams, `Resource template ${ref.uri} has no argument ${argument.name}`)
        return completeKeys(template, argument.value)
    }

    // ============== SDK attachment ==============

    function scopeOf(attachment: tAttachment, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) {
        const linked = linkedAbort([extra.signal, shared.disposal.signal])
        const progressToken = extra._meta?.progressToken
        const scope: McpCallScope = {
            session: {id: extra.sessionId ?? attachment.sessionId},
            principal: attachment.principal,
            signal: linked.signal,
            progress: progressToken == null ? noProgress : function reportProgress(progress, total, message) {
                extra.sendNotification({
                    method: 'notifications/progress',
                    params: {progressToken, progress, ...(total != null ? {total} : {}), ...(message != null ? {message} : {})},
                }).catch(function ignoreClosedTransport() {})
            },
        }
        return {scope, release: linked.release}
    }

    function claimsResources() {
        const current = state.current()
        return shared.resourceOptions != null
            && (deps.resources != null || current.resources.size > 0 || current.templates.size > 0)
    }

    function attach(target: McpServerLike | {server: McpServerLike}, session: McpAttachSession = {}) {
        if (shared.disposal.signal.aborted) throw new Error('MCP facade is disposed')
        // McpServer wraps the low-level Server; duck-typed so a host's own SDK copy works too
        const inner = (target as {server?: McpServerLike}).server
        const server = inner != null && typeof inner.setRequestHandler == 'function' ? inner : target as McpServerLike
        if (server.transport) throw new Error('MCP facade: attach before connecting the server (capabilities are fixed at connect)')
        const withResources = claimsResources()
        const withCompletions = withResources && shared.completions
        // each claim names what caused it, so a conflict says which option to change
        const toolsClaim = 'one server has one tool registry, mount other tools with control.mount'
        const resourcesClaim = 'the facade claims resources/* for its Listen streams, noStrict nodes or the resources option; resources: false leaves them to the host'
        const claims: [method: string, reason: string][] = [
            ['tools/list', toolsClaim], ['tools/call', toolsClaim],
            ...(withResources
                ? ['resources/list', 'resources/templates/list', 'resources/read', 'resources/subscribe', 'resources/unsubscribe']
                    .map(method => [method, resourcesClaim] as [string, string])
                : []),
            ...(withCompletions ? [['completion/complete', 'resources.completions: true claims it for template keys'] as [string, string]] : []),
        ]
        const methods = claims.map(([method]) => method)
        for (const [method, reason] of claims) {
            try {
                server.assertCanSetRequestHandler(method)
            } catch {
                throw new Error(`MCP facade: ${method} is already handled on this server; ${reason}`)
            }
        }
        server.registerCapabilities({
            tools: {listChanged: true},
            ...(withResources ? {resources: {subscribe: true, listChanged: true}} : {}),
            ...(withCompletions ? {completions: {}} : {}),
        })

        const attachment: tAttachment = {
            server,
            resources: withResources,
            sessionId: session.id ?? randomUUID(),
            principal: session.principal,
            subscriptions: new Map(),
            pending: new Set(),
            surface: surfaceId,
            closed: false,
            detach: detachAttachment,
        }

        async function handleWithScope<R>(extra: RequestHandlerExtra<ServerRequest, ServerNotification>, run: (scope: McpCallScope) => Promise<R>) {
            const {scope, release} = scopeOf(attachment, extra)
            try { return await run(scope) }
            finally { release() }
        }

        server.setRequestHandler(ListToolsRequestSchema, function listTools() {
            return {tools: visibleTools().map(tool => tool.descriptor)}
        })
        server.setRequestHandler(CallToolRequestSchema, function callTool(request, extra) {
            return handleWithScope(extra, scope => call(request.params.name, request.params.arguments, scope))
        })
        if (withResources) {
            server.setRequestHandler(ListResourcesRequestSchema, function listResources() {
                return {resources: [...state.current().resources.values()].map(resource => resource.descriptor)}
            })
            server.setRequestHandler(ListResourceTemplatesRequestSchema, function listResourceTemplates() {
                return {resourceTemplates: templateDescriptors()}
            })
            server.setRequestHandler(ReadResourceRequestSchema, function readResourceRequest(request, extra) {
                return handleWithScope(extra, scope => readResource(request.params.uri, scope))
            })
            server.setRequestHandler(SubscribeRequestSchema, function subscribeResource(request) {
                subscribe(attachment, request.params.uri)
                return {}
            })
            server.setRequestHandler(UnsubscribeRequestSchema, function unsubscribeResource(request) {
                unsubscribe(attachment, request.params.uri)
                return {}
            })
        }
        if (withCompletions) {
            server.setRequestHandler(CompleteRequestSchema, function completeRequest(request) {
                return {completion: complete(request.params.ref, request.params.argument)}
            })
        }

        // the transport closing ends the attachment: its subscriptions must not outlive it
        const previousOnClose = server.onclose
        server.onclose = function detachOnClose() {
            detachAttachment()
            previousOnClose?.()
        }

        function detachAttachment() {
            if (attachment.closed) return
            attachment.closed = true
            for (const subscription of attachment.subscriptions.values()) subscription.off()
            attachment.subscriptions.clear()
            shared.attachments.delete(attachment)
            for (const method of methods) server.removeRequestHandler(method)
        }

        shared.attachments.add(attachment)
        return detachAttachment
    }

    function createServer(session: McpAttachSession = {}) {
        const server: McpServerLike = new Server(
            {name: deps.name, version: deps.version},
            deps.instructions != null ? {instructions: deps.instructions} : {},
        )
        attach(server, session)
        return server
    }

    // ============== composition changes ==============

    function signature(entries: Iterable<{descriptor: object}>) {
        return JSON.stringify([...entries].map(entry => entry.descriptor))
    }

    function recompose(apply: () => void, revert: () => void) {
        const before = state.current()
        apply()
        let after
        try {
            after = state.rebuild()
        } catch (error) {
            revert()
            throw error
        }
        const toolsChanged = signature(before.tools.values()) != signature(after.tools.values())
        const resourcesChanged = signature(before.resources.values()) != signature(after.resources.values())
            || signature(before.templates.values()) != signature(after.templates.values())
        for (const attachment of shared.attachments) {
            if (attachment.surface != surfaceId) continue
            // kept only while the new composition serves the same source: a templated URI is in no static map
            for (const [uri, subscription] of [...attachment.subscriptions]) {
                if (sourceIn(after, uri) == subscription.source) continue
                subscription.off()
                attachment.subscriptions.delete(uri)
            }
            if (toolsChanged) attachment.server.sendToolListChanged().catch(function ignoreClosedTransport() {})
            if (resourcesChanged && attachment.resources) {
                attachment.server.sendResourceListChanged().catch(function ignoreClosedTransport() {})
            }
        }
        return {tools: toolsChanged, resources: resourcesChanged}
    }

    function setMount(key: string, object: object) {
        if (typeof key != 'string' || key == '') throw new Error('MCP facade mount key must be a non-empty string')
        if (object == null || typeof object != 'object') throw new Error('MCP facade mount needs an object')
        if (Object.prototype.hasOwnProperty.call(root, key)) throw new Error(`MCP facade: mount key ${key} is a key of the facade itself`)
        const previous = state.mounts.get(key)
        function applyMount() { state.mounts.set(key, object) }
        function restoreMount() {
            if (previous) state.mounts.set(key, previous)
            else state.mounts.delete(key)
        }
        return recompose(applyMount, restoreMount)
    }

    function mount(key: string, object: object) {
        if (state.mounts.has(key)) throw new Error(`MCP facade: ${key} is already mounted`)
        return setMount(key, object)
    }

    /** Mounts or swaps the fragment under key as one composition change (one list_changed). */
    function replace(key: string, object: object) {
        return setMount(key, object)
    }

    function unmount(key: string) {
        if (!state.mounts.has(key)) throw new Error(`MCP facade: ${key} is not mounted`)
        const object = state.mounts.get(key)!
        function removeMount() { state.mounts.delete(key) }
        function restoreMount() { state.mounts.set(key, object) }
        return recompose(removeMount, restoreMount)
    }

    function refresh() {
        function keepComposition() {}
        return recompose(keepComposition, keepComposition)
    }

    function inProcessScope(scope: Partial<McpCallScope> & {session?: {id: string}} = {}) {
        return {
            session: scope.session ?? {id: 'in-process'},
            principal: scope.principal,
            signal: scope.signal ?? shared.disposal.signal,
            progress: scope.progress ?? noProgress,
        }
    }

    return {
        tools: {
            /** Descriptors as tools/list returns them (read-only mode: reads only). */
            list: () => visibleTools().map(tool => tool.descriptor),
            /** The same pipeline as tools/call, without a transport. */
            call: (name: string, input?: Record<string, unknown>, scope?: Partial<McpCallScope>) => call(name, input, inProcessScope(scope)),
        },
        resources: {
            list: () => [...state.current().resources.values()].map(resource => resource.descriptor),
            /** Resource templates as resources/templates/list returns them: one per exposed noStrict node. */
            templates: templateDescriptors,
            /** Static URIs and templated ones (`<base>/<key>[/<member>...]`). */
            read: (uri: string, scope?: Partial<McpCallScope>) => readResource(uri, inProcessScope(scope)),
        },
        control: {
            /** Registers tools (and resources) on an SDK Server/McpServer before it connects; returns detach. */
            attach,
            /** A new SDK Server named by this facade, already attached. */
            server: createServer,
            /** Adds a facade fragment under a top-level key; attached sessions get list_changed. */
            mount,
            replace,
            unmount,
            /** Walks the composition again (keys added since setup); list_changed when it differs. */
            refresh,
        },
        view: {
            findings: () => [...shared.findings],
            attached: () => [...shared.attachments].filter(attachment => attachment.surface == surfaceId).length,
        },
    }
}

/** One derived facade: what control.derive returns for a principal's object. */
export type McpFacadeSurface = ReturnType<typeof createSurface>

// ===================================================================
// public factory
// ===================================================================

export function createMcpFacadeServer<T extends object>(deps: McpFacadeServerOptions<T>) {
    if (deps.object == null || typeof deps.object != 'object') throw new Error('MCP facade object must be an object')
    const shared = createShared(deps)
    const surface = createSurface(shared, deps.object, true)
    const derived = new WeakMap<object, McpFacadeSurface>()

    /** The same metadata, policy, middleware, queue and audit over another object (a principal's facade). */
    function derive(object: object) {
        if (object == deps.object) return surface
        if (object == null || typeof object != 'object') throw new Error('MCP facade derive needs an object')
        let next = derived.get(object)
        if (!next) {
            next = createSurface(shared, object, false)
            derived.set(object, next)
        }
        return next
    }

    /** Aborts in-flight calls, refuses new ones, releases every subscription and handler. */
    function dispose() {
        if (shared.disposal.signal.aborted) return
        shared.disposal.abort(new MyError('MCP facade is disposed', 'E_MCP_DISPOSED'))
        for (const attachment of [...shared.attachments]) attachment.detach()
        shared.events.called.close()
        shared.events.failed.close()
    }

    return {
        ...surface,
        control: {...surface.control, derive, dispose},
        on: {
            called: shared.events.called.on,
            failed: shared.events.failed.on,
        },
    }
}

export type McpFacadeServer = ReturnType<typeof createMcpFacadeServer>
