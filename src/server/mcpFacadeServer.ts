// ============================================================
//  src/server/mcpFacadeServer.ts  (wenay-common2/server/mcp)
//
//  MCP tools generated from a facade: the walk of the HTTP adapter (facadeWalk.ts), the
//  metadata of the OpenAPI document (facadeMeta.ts), handlers registered on the official
//  SDK's low-level Server. McpServer.registerTool takes zod shapes only, while facade
//  metadata is JSON Schema — so this layer owns tools/list and tools/call (and the
//  resources/* methods when the facade has Listen streams) of the server it is attached to.
//  No domain logic lives here: ordering, journaling, receipts and audit are the host's,
//  through policy and the `around` chain.
// ============================================================

import {randomUUID} from 'node:crypto'

import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import type {RequestHandlerExtra} from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js'
import {
    CallToolRequestSchema,
    ErrorCode,
    ListResourcesRequestSchema,
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
import {isListenCallback, isListenOn, listen} from '../Common/events/Listen'
import {isNoStrict} from '../Common/rcp/rpc-dynamic'
import {PayloadLimitError, resolveLimits, type RpcLimits} from '../Common/rcp/rpc-limits'
import {errToObj, packResult, unpackResult, walk} from '../Common/rcp/rpc-walk'
import {MyError} from '../toError/myThrow'
import {
    checkMetaMap,
    facadeMetaKey,
    methodInputSchema,
    resolveMethodMeta,
    type FacadeMethodMeta,
    type McpToolAnnotations,
    type tFacadeMetaMap,
} from './facadeMeta'
import {walkFacade} from './facadeWalk'

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
    /** Listen streams and view functions as MCP resources; false = never claim resources/*. */
    resources?: false | {
        /** URI scheme: `<scheme>://<path>`; default 'facade'. */
        scheme?: string
        /** Per session; default 32. */
        maxSubscriptions?: number
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

    function report(finding: McpFacadeFinding) {
        const key = `${finding.path}\u0000${finding.message}`
        if (seenFindings.has(key)) return
        seenFindings.add(key)
        findings.push(finding)
        if (deps.onFinding) deps.onFinding(finding)
        else console.warn(`[mcp facade] ${finding.path}: ${finding.message}`)
    }

    return {
        deps,
        rule,
        scheme,
        resourceOptions,
        maxSubscriptions,
        limits: resolveLimits(deps.limits),
        metaMap: checkMetaMap(deps.meta),
        around,
        queue,
        disposal,
        attachments,
        findings,
        events: {emitCalled, emitFailed, called, failed},
        toolName,
        resourceUri,
        compiled,
        report,
    }
}

type tShared = ReturnType<typeof createShared>

type tAttachment = {
    server: McpServerLike
    resources: boolean
    sessionId: string
    principal: unknown
    subscriptions: Map<string, () => void>
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

type tListenOn = (cb: (...args: any[]) => void, opts?: {current?: boolean}) => () => void

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
        const tools = new Map<string, tToolEntry>()
        const resources = new Map<string, ReturnType<typeof makeResource>>()
        const missing: string[] = []
        const walked = new Set<string>()

        function take(value: unknown, path: string[]) {
            if (value != null && (typeof value == 'object' || typeof value == 'function') && isNoStrict(value)) return true
            if (isListenOn(value)) {
                walked.add(facadeMetaKey(path))
                addResource(makeResource(path, {on: value as tListenOn}))
                return true
            }
            if (isListenCallback(value)) {
                walked.add(facadeMetaKey(path))
                addResource(makeResource(path, {on: value.on as tListenOn}))
                return true
            }
            return false
        }

        function addResource(resource: ReturnType<typeof makeResource>) {
            if (shared.resourceOptions == null) return
            if (resources.has(resource.uri)) throw new Error(`MCP facade: resource ${resource.uri} is registered twice`)
            resources.set(resource.uri, resource)
        }

        function addAll(object: object, prefix: string[]) {
            for (const entry of walkFacade(object, {label: 'MCP facade', take: (value, path) => take(value, [...prefix, ...path])})) {
                const path = [...prefix, ...entry.path]
                const tool = makeToolEntry(shared, path, entry.fn, entry.context)
                walked.add(facadeMetaKey(path))
                const previous = tools.get(tool.name)
                if (previous) {
                    throw new Error(`MCP facade: tool name "${tool.name}" is registered twice (${JSON.stringify(previous.path)} and ${JSON.stringify(path)})`)
                }
                tools.set(tool.name, tool)
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

        if (missing.length) {
            throw new Error(`MCP facade (strict): functions without description and input/args: ${missing.join(', ')}`)
        }
        if (checkStaleMeta && metaMap) {
            const stale = Object.keys(metaMap).filter(key => !walked.has(key))
            if (stale.length && deps.strict) throw new Error(`MCP facade (strict): meta keys name no facade function: ${stale.join(', ')}`)
            for (const key of stale) shared.report({path: key, message: 'meta entry names no facade function'})
        }
        return {tools, resources}
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

    function toCallArgs(tool: tToolEntry, input: Record<string, unknown>) {
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

    async function execute(tool: tToolEntry, args: unknown[], scope: McpCallScope) {
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

    function encodeResult(tool: tToolEntry, value: unknown): CallToolResult {
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

    // ============== resources ==============

    function findResource(uri: string) {
        const resources = state.current().resources
        const exact = resources.get(uri)
        if (exact) return exact
        for (const resource of resources.values()) {
            try { if (new URL(resource.uri).href == new URL(uri).href) return resource } catch {}
        }
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`)
    }

    async function readResource(uri: string, scope: McpCallScope) {
        const resource = findResource(uri)
        let value: unknown
        if (resource.tool) {
            value = await execute(resource.tool!, [], scope)
        } else {
            // a store answers its current value synchronously; a plain listen never calls back
            let current: unknown[] | undefined
            const off = resource.on!(function captureCurrent(...args: unknown[]) { current ??= args }, {current: true})
            off()
            if (current == undefined) {
                throw new McpError(ErrorCode.InvalidParams,
                    `Resource ${uri} has no current value: a plain listen only notifies, a store has none yet`)
            }
            value = current.length == 1 ? current[0] : current
        }
        const packed = packResult(value)
        walk(packed, function keepLeaf(leaf: unknown) { return leaf }, limits)
        return {contents: [{uri: resource.uri, mimeType: 'application/json', text: JSON.stringify(packed ?? null)}]}
    }

    function subscribe(attachment: tAttachment, uri: string) {
        const resource = findResource(uri)
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
        attachment.subscriptions.set(target, resource.on(notifyUpdated))
    }

    function unsubscribe(attachment: tAttachment, uri: string) {
        const resource = state.current().resources.get(uri)
        const key = resource?.uri ?? uri
        attachment.subscriptions.get(key)?.()
        attachment.subscriptions.delete(key)
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
        return shared.resourceOptions != null && (deps.resources != null || state.current().resources.size > 0)
    }

    function attach(target: McpServerLike | {server: McpServerLike}, session: McpAttachSession = {}) {
        if (shared.disposal.signal.aborted) throw new Error('MCP facade is disposed')
        // McpServer wraps the low-level Server; duck-typed so a host's own SDK copy works too
        const inner = (target as {server?: McpServerLike}).server
        const server = inner != null && typeof inner.setRequestHandler == 'function' ? inner : target as McpServerLike
        if (server.transport) throw new Error('MCP facade: attach before connecting the server (capabilities are fixed at connect)')
        const withResources = claimsResources()
        const methods = ['tools/list', 'tools/call',
            ...(withResources ? ['resources/list', 'resources/read', 'resources/subscribe', 'resources/unsubscribe'] : [])]
        for (const method of methods) {
            try {
                server.assertCanSetRequestHandler(method)
            } catch {
                throw new Error(`MCP facade: ${method} is already handled on this server; one server has one tool registry, mount other tools with control.mount`)
            }
        }
        server.registerCapabilities({
            tools: {listChanged: true},
            ...(withResources ? {resources: {subscribe: true, listChanged: true}} : {}),
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

        // the transport closing ends the attachment: its subscriptions must not outlive it
        const previousOnClose = server.onclose
        server.onclose = function detachOnClose() {
            detachAttachment()
            previousOnClose?.()
        }

        function detachAttachment() {
            if (attachment.closed) return
            attachment.closed = true
            for (const off of attachment.subscriptions.values()) off()
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
        for (const attachment of shared.attachments) {
            if (attachment.surface != surfaceId) continue
            for (const [uri, off] of [...attachment.subscriptions]) {
                if (after.resources.get(uri)?.on == before.resources.get(uri)?.on) continue
                off()
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
