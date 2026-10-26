"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMcpFacadeServer = createMcpFacadeServer;
const node_crypto_1 = require("node:crypto");
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const ajv_1 = require("@modelcontextprotocol/sdk/validation/ajv");
const waitRun_1 = require("../Common/async/waitRun");
const Listen_1 = require("../Common/events/Listen");
const rpc_dynamic_1 = require("../Common/rcp/rpc-dynamic");
const rpc_limits_1 = require("../Common/rcp/rpc-limits");
const rpc_walk_1 = require("../Common/rcp/rpc-walk");
const myThrow_1 = require("../toError/myThrow");
const facadeMeta_1 = require("./facadeMeta");
const facadeWalk_1 = require("./facadeWalk");
const NAME_RULES = {
    mcp: { pattern: /^[A-Za-z0-9_.-]+$/, disallowed: /[^A-Za-z0-9_.-]/g, max: 128 },
    claude: { pattern: /^[A-Za-z0-9_-]+$/, disallowed: /[^A-Za-z0-9_-]/g, max: 64 },
};
function createToolContext(scope) {
    return {
        signal: scope.signal,
        progress: scope.progress,
        session: scope.session,
        principal: scope.principal,
    };
}
function createCallContext(tool, path, args, readOnly, scope) {
    return {
        tool,
        path,
        args,
        readOnly,
        session: scope.session,
        principal: scope.principal,
        signal: scope.signal,
    };
}
function isPlainObject(value) {
    return value != null && typeof value == 'object' && !Array.isArray(value);
}
function binaryByteLength(value) {
    if (ArrayBuffer.isView(value))
        return value.byteLength;
    if (value instanceof ArrayBuffer)
        return value.byteLength;
    return null;
}
function findNestedBinary(value, path = []) {
    if (value == null || typeof value != 'object')
        return null;
    if (path.length > 0 && binaryByteLength(value) != null)
        return path;
    const keys = Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value);
    for (const key of keys) {
        const found = findNestedBinary(value[key], [...path, key]);
        if (found)
            return found;
    }
    return null;
}
function linkedAbort(parents) {
    const controller = new AbortController();
    const offs = [];
    for (const parent of parents) {
        if (!parent)
            continue;
        if (parent.aborted) {
            controller.abort(parent.reason);
            break;
        }
        function abortChild() { controller.abort(parent.reason); }
        parent.addEventListener('abort', abortChild, { once: true });
        offs.push(function releaseParent() { parent.removeEventListener('abort', abortChild); });
    }
    return {
        signal: controller.signal,
        release: function releaseLinkedAbort() { for (const off of offs)
            off(); },
    };
}
function errorResult(error) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: (0, rpc_walk_1.errToObj)(myThrow_1.MyError.wrap(error)) }) }] };
}
function noProgress() { }
function createShared(deps) {
    if (typeof deps.name != 'string' || deps.name == '')
        throw new Error('MCP facade name must be a non-empty string');
    if (typeof deps.version != 'string' || deps.version == '')
        throw new Error('MCP facade version must be a non-empty string');
    const separator = deps.names?.separator ?? '.';
    if (typeof separator != 'string' || separator == '')
        throw new Error('MCP facade names.separator must be a non-empty string');
    const charset = deps.names?.charset ?? 'mcp';
    const rule = NAME_RULES[charset];
    if (!rule)
        throw new Error(`MCP facade names.charset must be 'mcp' or 'claude', got ${String(charset)}`);
    const resourceOptions = deps.resources === false ? null : deps.resources ?? {};
    const scheme = resourceOptions?.scheme ?? 'facade';
    if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme))
        throw new Error(`MCP facade resources.scheme is not a URI scheme: ${scheme}`);
    const maxSubscriptions = resourceOptions?.maxSubscriptions ?? 32;
    if (!Number.isSafeInteger(maxSubscriptions) || maxSubscriptions < 0) {
        throw new Error('MCP facade resources.maxSubscriptions must be a non-negative integer');
    }
    const around = deps.around == null ? [] : Array.isArray(deps.around) ? [...deps.around] : [deps.around];
    const validator = deps.validator === false ? null : deps.validator ?? new ajv_1.AjvJsonSchemaValidator();
    const validators = new WeakMap();
    const seenFindings = new Set();
    const findings = [];
    const queue = (0, waitRun_1.createAsyncQueue)(1);
    const disposal = new AbortController();
    const attachments = new Set();
    const [emitCalled, called] = (0, Listen_1.listen)();
    const [emitFailed, failed] = (0, Listen_1.listen)();
    function toolName(path) {
        let name = path.join(separator);
        if (deps.names?.map)
            name = name.replace(rule.disallowed, '_');
        if (name.length > rule.max) {
            throw new Error(`MCP facade: tool name "${name}" for path ${JSON.stringify(path)} is longer than ${rule.max} (${charset} names)`);
        }
        if (!rule.pattern.test(name)) {
            throw new Error(`MCP facade: tool name "${name}" for path ${JSON.stringify(path)} has characters outside ${rule.pattern} (${charset} names); set names.separator, names.map or rename the key`);
        }
        return name;
    }
    function resourceUri(path) {
        return `${scheme}://${path.map(encodeURIComponent).join('/')}`;
    }
    function compiled(meta) {
        let entry = validators.get(meta);
        if (!entry) {
            entry = validator == null ? {} : {
                input: meta.input || meta.args ? validator.getValidator((0, facadeMeta_1.methodInputSchema)(meta)) : undefined,
                output: meta.output ? validator.getValidator(meta.output) : undefined,
            };
            validators.set(meta, entry);
        }
        return entry;
    }
    function report(finding) {
        const key = `${finding.path}\u0000${finding.message}`;
        if (seenFindings.has(key))
            return;
        seenFindings.add(key);
        findings.push(finding);
        if (deps.onFinding)
            deps.onFinding(finding);
        else
            console.warn(`[mcp facade] ${finding.path}: ${finding.message}`);
    }
    return {
        deps,
        rule,
        scheme,
        resourceOptions,
        maxSubscriptions,
        limits: (0, rpc_limits_1.resolveLimits)(deps.limits),
        metaMap: (0, facadeMeta_1.checkMetaMap)(deps.meta),
        around,
        queue,
        disposal,
        attachments,
        findings,
        events: { emitCalled, emitFailed, called, failed },
        toolName,
        resourceUri,
        compiled,
        report,
    };
}
function createCallEvent(tool, path, session, principal, durationMs) {
    return { tool, path, session, principal, durationMs };
}
function makeToolEntry(shared, path, fn, context) {
    const { deps, metaMap } = shared;
    const meta = (0, facadeMeta_1.resolveMethodMeta)(fn, path, metaMap);
    const readOnlyHint = meta?.annotations?.readOnlyHint ?? deps.policy?.readOnly?.(path);
    const annotations = meta?.annotations || readOnlyHint != null
        ? { ...meta?.annotations, ...(readOnlyHint != null ? { readOnlyHint } : {}) }
        : undefined;
    const name = shared.toolName(path);
    const descriptor = {
        name,
        ...(meta?.title != null ? { title: meta.title } : {}),
        description: meta?.description ?? `Calls ${path.join('.')} on the facade.`,
        inputSchema: (0, facadeMeta_1.methodInputSchema)(meta),
        ...(meta?.output != null ? { outputSchema: meta.output } : {}),
        ...(annotations ? { annotations } : {}),
    };
    return {
        name,
        path,
        fn,
        context,
        meta,
        descriptor,
        readOnly: readOnlyHint == true,
        concurrency: deps.policy?.concurrency?.(path) ?? 'serial',
        validate: meta ? shared.compiled(meta) : {},
    };
}
function createSurfaceState(shared, root, checkStaleMeta) {
    const { deps, metaMap } = shared;
    const mounts = new Map();
    function makeResource(path, source) {
        const meta = source.tool ? source.tool.meta : (0, facadeMeta_1.resolveMethodMeta)(source.on, path, metaMap);
        const uri = shared.resourceUri(path);
        return {
            uri,
            path,
            on: source.on,
            tool: source.tool,
            descriptor: {
                uri,
                name: path.join('.'),
                ...(meta?.title != null ? { title: meta.title } : {}),
                description: meta?.description ?? (source.tool
                    ? source.tool.descriptor.description
                    : `Listen stream ${path.join('.')}: subscribe for change notifications; a store also reads its current value.`),
                mimeType: 'application/json',
            },
        };
    }
    function build() {
        const tools = new Map();
        const resources = new Map();
        const missing = [];
        const walked = new Set();
        function take(value, path) {
            if (value != null && (typeof value == 'object' || typeof value == 'function') && (0, rpc_dynamic_1.isNoStrict)(value))
                return true;
            if ((0, Listen_1.isListenOn)(value)) {
                walked.add((0, facadeMeta_1.facadeMetaKey)(path));
                addResource(makeResource(path, { on: value }));
                return true;
            }
            if ((0, Listen_1.isListenCallback)(value)) {
                walked.add((0, facadeMeta_1.facadeMetaKey)(path));
                addResource(makeResource(path, { on: value.on }));
                return true;
            }
            return false;
        }
        function addResource(resource) {
            if (shared.resourceOptions == null)
                return;
            if (resources.has(resource.uri))
                throw new Error(`MCP facade: resource ${resource.uri} is registered twice`);
            resources.set(resource.uri, resource);
        }
        function addAll(object, prefix) {
            for (const entry of (0, facadeWalk_1.walkFacade)(object, { label: 'MCP facade', take: (value, path) => take(value, [...prefix, ...path]) })) {
                const path = [...prefix, ...entry.path];
                const tool = makeToolEntry(shared, path, entry.fn, entry.context);
                walked.add((0, facadeMeta_1.facadeMetaKey)(path));
                const previous = tools.get(tool.name);
                if (previous) {
                    throw new Error(`MCP facade: tool name "${tool.name}" is registered twice (${JSON.stringify(previous.path)} and ${JSON.stringify(path)})`);
                }
                tools.set(tool.name, tool);
                if (!tool.meta || (!tool.meta.input && !tool.meta.args)) {
                    if (deps.strict)
                        missing.push(path.join('.'));
                    else
                        shared.report({
                            path: path.join('.'),
                            message: tool.meta
                                ? 'no input schema: {type: \'object\'}, the arguments object is passed when non-empty'
                                : 'no metadata: {type: \'object\'} and a generated description',
                        });
                }
                if (deps.policy?.resource?.(path)) {
                    const takesArgs = tool.meta?.input != null || (tool.meta?.args?.length ?? 0) > 0
                        || (!tool.meta && entry.fn.length > 0);
                    if (takesArgs)
                        throw new Error(`MCP facade: ${path.join('.')} takes arguments and cannot be a resource`);
                    addResource(makeResource(path, { tool }));
                }
            }
        }
        addAll(root, []);
        for (const [key, object] of mounts)
            addAll(object, [key]);
        if (missing.length) {
            throw new Error(`MCP facade (strict): functions without description and input/args: ${missing.join(', ')}`);
        }
        if (checkStaleMeta && metaMap) {
            const stale = Object.keys(metaMap).filter(key => !walked.has(key));
            if (stale.length && deps.strict)
                throw new Error(`MCP facade (strict): meta keys name no facade function: ${stale.join(', ')}`);
            for (const key of stale)
                shared.report({ path: key, message: 'meta entry names no facade function' });
        }
        return { tools, resources };
    }
    let current = build();
    return {
        mounts,
        current: () => current,
        rebuild() {
            current = build();
            return current;
        },
    };
}
function createSurface(shared, root, checkStaleMeta) {
    const { deps, limits, events } = shared;
    const state = createSurfaceState(shared, root, checkStaleMeta);
    const surfaceId = {};
    function visibleTools() {
        const tools = [...state.current().tools.values()];
        return deps.readOnly ? tools.filter(tool => tool.readOnly) : tools;
    }
    function toCallArgs(tool, input) {
        const meta = tool.meta;
        let args;
        if (meta?.input)
            args = [input];
        else if (meta?.args) {
            const known = new Set(meta.args.map(arg => arg.name));
            const unknown = Object.keys(input).filter(key => !known.has(key));
            if (unknown.length)
                throw new myThrow_1.MyError(`Unknown argument(s) for ${tool.name}: ${unknown.join(', ')}`, 'E_MCP_ARGS');
            args = meta.args.map(arg => input[arg.name]);
            if (!meta.context)
                while (args.length && args[args.length - 1] === undefined)
                    args.pop();
        }
        else
            args = Object.keys(input).length ? [input] : [];
        if (args.length > limits.maxArgs)
            throw new rpc_limits_1.PayloadLimitError('too many args');
        return args;
    }
    async function execute(tool, args, scope) {
        const started = Date.now();
        const ctx = createCallContext(tool.name, tool.path, args, tool.readOnly, scope);
        const callArgs = tool.meta?.context ? [...args, createToolContext(scope)] : args;
        function callFunction() {
            return Promise.resolve(tool.fn.apply(tool.context, callArgs));
        }
        function runAround(index) {
            if (index == shared.around.length)
                return callFunction();
            return Promise.resolve(shared.around[index](ctx, function next() { return runAround(index + 1); }));
        }
        async function runSlot() {
            if (scope.signal.aborted)
                throw new myThrow_1.MyError('MCP call was cancelled before it started', 'E_MCP_CANCELLED');
            return await runAround(0);
        }
        try {
            const value = tool.concurrency == 'parallel' ? await runSlot() : await shared.queue.add(runSlot);
            events.emitCalled(createCallEvent(tool.name, tool.path, scope.session, scope.principal, Date.now() - started));
            return value;
        }
        catch (error) {
            events.emitFailed({ ...createCallEvent(tool.name, tool.path, scope.session, scope.principal, Date.now() - started), error });
            throw error;
        }
    }
    function encodeResult(tool, value) {
        const formatted = deps.formatResult?.(tool.path, value);
        if (formatted != null)
            return formatted;
        const bytes = binaryByteLength(value);
        if (bytes != null) {
            if (bytes > limits.maxBinaryLen)
                throw new rpc_limits_1.PayloadLimitError('binary too long');
            const view = ArrayBuffer.isView(value)
                ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
                : Buffer.from(value);
            return { content: [{ type: 'resource', resource: {
                            uri: shared.resourceUri([...tool.path, 'result']),
                            mimeType: 'application/octet-stream',
                            blob: view.toString('base64'),
                        } }] };
        }
        const packed = (0, rpc_walk_1.packResult)(value);
        (0, rpc_walk_1.walk)(packed, function keepLeaf(leaf) { return leaf; }, limits);
        const nested = findNestedBinary(packed);
        if (nested) {
            throw new myThrow_1.MyError(`Binary value at ${nested.join('.')} of ${tool.name}: return the bytes as the whole result, or a reference`, 'E_MCP_BINARY');
        }
        const structured = isPlainObject(packed) ? packed : { value: packed ?? null };
        const check = tool.validate.output?.(structured);
        if (check && !check.valid) {
            throw new myThrow_1.MyError(`Result of ${tool.name} does not match its output schema: ${check.errorMessage}`, 'E_MCP_OUTPUT');
        }
        return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
    }
    async function call(name, input, scope) {
        const tool = state.current().tools.get(name);
        if (!tool)
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Unknown tool: ${name}`);
        if (deps.readOnly && !tool.readOnly) {
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Tool ${name} is not read-only and this MCP facade serves reads only`);
        }
        if (shared.disposal.signal.aborted)
            return errorResult(new myThrow_1.MyError('MCP facade is disposed', 'E_MCP_DISPOSED'));
        try {
            const raw = input ?? {};
            if (!isPlainObject(raw))
                throw new myThrow_1.MyError(`Arguments of ${name} must be an object`, 'E_MCP_ARGS');
            const decoded = (0, rpc_walk_1.unpackResult)(raw, limits);
            const check = tool.validate.input?.(raw);
            if (check && !check.valid)
                throw new myThrow_1.MyError(`Invalid arguments for ${name}: ${check.errorMessage}`, 'E_MCP_ARGS');
            const value = await execute(tool, toCallArgs(tool, decoded), scope);
            return encodeResult(tool, value);
        }
        catch (error) {
            return errorResult(error);
        }
    }
    function findResource(uri) {
        const resources = state.current().resources;
        const exact = resources.get(uri);
        if (exact)
            return exact;
        for (const resource of resources.values()) {
            try {
                if (new URL(resource.uri).href == new URL(uri).href)
                    return resource;
            }
            catch { }
        }
        throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    }
    async function readResource(uri, scope) {
        const resource = findResource(uri);
        let value;
        if (resource.tool) {
            value = await execute(resource.tool, [], scope);
        }
        else {
            let current;
            const off = resource.on(function captureCurrent(...args) { current ??= args; }, { current: true });
            off();
            if (current == undefined) {
                throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Resource ${uri} has no current value: a plain listen only notifies, a store has none yet`);
            }
            value = current.length == 1 ? current[0] : current;
        }
        const packed = (0, rpc_walk_1.packResult)(value);
        (0, rpc_walk_1.walk)(packed, function keepLeaf(leaf) { return leaf; }, limits);
        return { contents: [{ uri: resource.uri, mimeType: 'application/json', text: JSON.stringify(packed ?? null) }] };
    }
    function subscribe(attachment, uri) {
        const resource = findResource(uri);
        if (!resource.on)
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Resource ${uri} has no change stream to subscribe to`);
        if (attachment.subscriptions.has(resource.uri))
            return;
        if (attachment.subscriptions.size >= shared.maxSubscriptions) {
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Subscription limit reached (${shared.maxSubscriptions} per session)`);
        }
        const target = resource.uri;
        function notifyUpdated() {
            if (attachment.closed || attachment.pending.has(target))
                return;
            attachment.pending.add(target);
            queueMicrotask(function sendResourceUpdated() {
                attachment.pending.delete(target);
                if (attachment.closed || !attachment.subscriptions.has(target))
                    return;
                attachment.server.sendResourceUpdated({ uri: target }).catch(function ignoreClosedTransport() { });
            });
        }
        attachment.subscriptions.set(target, resource.on(notifyUpdated));
    }
    function unsubscribe(attachment, uri) {
        const resource = state.current().resources.get(uri);
        const key = resource?.uri ?? uri;
        attachment.subscriptions.get(key)?.();
        attachment.subscriptions.delete(key);
    }
    function scopeOf(attachment, extra) {
        const linked = linkedAbort([extra.signal, shared.disposal.signal]);
        const progressToken = extra._meta?.progressToken;
        const scope = {
            session: { id: extra.sessionId ?? attachment.sessionId },
            principal: attachment.principal,
            signal: linked.signal,
            progress: progressToken == null ? noProgress : function reportProgress(progress, total, message) {
                extra.sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken, progress, ...(total != null ? { total } : {}), ...(message != null ? { message } : {}) },
                }).catch(function ignoreClosedTransport() { });
            },
        };
        return { scope, release: linked.release };
    }
    function claimsResources() {
        return shared.resourceOptions != null && (deps.resources != null || state.current().resources.size > 0);
    }
    function attach(target, session = {}) {
        if (shared.disposal.signal.aborted)
            throw new Error('MCP facade is disposed');
        const inner = target.server;
        const server = inner != null && typeof inner.setRequestHandler == 'function' ? inner : target;
        if (server.transport)
            throw new Error('MCP facade: attach before connecting the server (capabilities are fixed at connect)');
        const withResources = claimsResources();
        const methods = ['tools/list', 'tools/call',
            ...(withResources ? ['resources/list', 'resources/read', 'resources/subscribe', 'resources/unsubscribe'] : [])];
        for (const method of methods) {
            try {
                server.assertCanSetRequestHandler(method);
            }
            catch {
                throw new Error(`MCP facade: ${method} is already handled on this server; one server has one tool registry, mount other tools with control.mount`);
            }
        }
        server.registerCapabilities({
            tools: { listChanged: true },
            ...(withResources ? { resources: { subscribe: true, listChanged: true } } : {}),
        });
        const attachment = {
            server,
            resources: withResources,
            sessionId: session.id ?? (0, node_crypto_1.randomUUID)(),
            principal: session.principal,
            subscriptions: new Map(),
            pending: new Set(),
            surface: surfaceId,
            closed: false,
            detach: detachAttachment,
        };
        async function handleWithScope(extra, run) {
            const { scope, release } = scopeOf(attachment, extra);
            try {
                return await run(scope);
            }
            finally {
                release();
            }
        }
        server.setRequestHandler(types_js_1.ListToolsRequestSchema, function listTools() {
            return { tools: visibleTools().map(tool => tool.descriptor) };
        });
        server.setRequestHandler(types_js_1.CallToolRequestSchema, function callTool(request, extra) {
            return handleWithScope(extra, scope => call(request.params.name, request.params.arguments, scope));
        });
        if (withResources) {
            server.setRequestHandler(types_js_1.ListResourcesRequestSchema, function listResources() {
                return { resources: [...state.current().resources.values()].map(resource => resource.descriptor) };
            });
            server.setRequestHandler(types_js_1.ReadResourceRequestSchema, function readResourceRequest(request, extra) {
                return handleWithScope(extra, scope => readResource(request.params.uri, scope));
            });
            server.setRequestHandler(types_js_1.SubscribeRequestSchema, function subscribeResource(request) {
                subscribe(attachment, request.params.uri);
                return {};
            });
            server.setRequestHandler(types_js_1.UnsubscribeRequestSchema, function unsubscribeResource(request) {
                unsubscribe(attachment, request.params.uri);
                return {};
            });
        }
        const previousOnClose = server.onclose;
        server.onclose = function detachOnClose() {
            detachAttachment();
            previousOnClose?.();
        };
        function detachAttachment() {
            if (attachment.closed)
                return;
            attachment.closed = true;
            for (const off of attachment.subscriptions.values())
                off();
            attachment.subscriptions.clear();
            shared.attachments.delete(attachment);
            for (const method of methods)
                server.removeRequestHandler(method);
        }
        shared.attachments.add(attachment);
        return detachAttachment;
    }
    function createServer(session = {}) {
        const server = new index_js_1.Server({ name: deps.name, version: deps.version }, deps.instructions != null ? { instructions: deps.instructions } : {});
        attach(server, session);
        return server;
    }
    function signature(entries) {
        return JSON.stringify([...entries].map(entry => entry.descriptor));
    }
    function recompose(apply, revert) {
        const before = state.current();
        apply();
        let after;
        try {
            after = state.rebuild();
        }
        catch (error) {
            revert();
            throw error;
        }
        const toolsChanged = signature(before.tools.values()) != signature(after.tools.values());
        const resourcesChanged = signature(before.resources.values()) != signature(after.resources.values());
        for (const attachment of shared.attachments) {
            if (attachment.surface != surfaceId)
                continue;
            for (const [uri, off] of [...attachment.subscriptions]) {
                if (after.resources.get(uri)?.on == before.resources.get(uri)?.on)
                    continue;
                off();
                attachment.subscriptions.delete(uri);
            }
            if (toolsChanged)
                attachment.server.sendToolListChanged().catch(function ignoreClosedTransport() { });
            if (resourcesChanged && attachment.resources) {
                attachment.server.sendResourceListChanged().catch(function ignoreClosedTransport() { });
            }
        }
        return { tools: toolsChanged, resources: resourcesChanged };
    }
    function setMount(key, object) {
        if (typeof key != 'string' || key == '')
            throw new Error('MCP facade mount key must be a non-empty string');
        if (object == null || typeof object != 'object')
            throw new Error('MCP facade mount needs an object');
        if (Object.prototype.hasOwnProperty.call(root, key))
            throw new Error(`MCP facade: mount key ${key} is a key of the facade itself`);
        const previous = state.mounts.get(key);
        function applyMount() { state.mounts.set(key, object); }
        function restoreMount() {
            if (previous)
                state.mounts.set(key, previous);
            else
                state.mounts.delete(key);
        }
        return recompose(applyMount, restoreMount);
    }
    function mount(key, object) {
        if (state.mounts.has(key))
            throw new Error(`MCP facade: ${key} is already mounted`);
        return setMount(key, object);
    }
    function replace(key, object) {
        return setMount(key, object);
    }
    function unmount(key) {
        if (!state.mounts.has(key))
            throw new Error(`MCP facade: ${key} is not mounted`);
        const object = state.mounts.get(key);
        function removeMount() { state.mounts.delete(key); }
        function restoreMount() { state.mounts.set(key, object); }
        return recompose(removeMount, restoreMount);
    }
    function refresh() {
        function keepComposition() { }
        return recompose(keepComposition, keepComposition);
    }
    function inProcessScope(scope = {}) {
        return {
            session: scope.session ?? { id: 'in-process' },
            principal: scope.principal,
            signal: scope.signal ?? shared.disposal.signal,
            progress: scope.progress ?? noProgress,
        };
    }
    return {
        tools: {
            list: () => visibleTools().map(tool => tool.descriptor),
            call: (name, input, scope) => call(name, input, inProcessScope(scope)),
        },
        resources: {
            list: () => [...state.current().resources.values()].map(resource => resource.descriptor),
            read: (uri, scope) => readResource(uri, inProcessScope(scope)),
        },
        control: {
            attach,
            server: createServer,
            mount,
            replace,
            unmount,
            refresh,
        },
        view: {
            findings: () => [...shared.findings],
            attached: () => [...shared.attachments].filter(attachment => attachment.surface == surfaceId).length,
        },
    };
}
function createMcpFacadeServer(deps) {
    if (deps.object == null || typeof deps.object != 'object')
        throw new Error('MCP facade object must be an object');
    const shared = createShared(deps);
    const surface = createSurface(shared, deps.object, true);
    const derived = new WeakMap();
    function derive(object) {
        if (object == deps.object)
            return surface;
        if (object == null || typeof object != 'object')
            throw new Error('MCP facade derive needs an object');
        let next = derived.get(object);
        if (!next) {
            next = createSurface(shared, object, false);
            derived.set(object, next);
        }
        return next;
    }
    function dispose() {
        if (shared.disposal.signal.aborted)
            return;
        shared.disposal.abort(new myThrow_1.MyError('MCP facade is disposed', 'E_MCP_DISPOSED'));
        for (const attachment of [...shared.attachments])
            attachment.detach();
        shared.events.called.close();
        shared.events.failed.close();
    }
    return {
        ...surface,
        control: { ...surface.control, derive, dispose },
        on: {
            called: shared.events.called.on,
            failed: shared.events.failed.on,
        },
    };
}
