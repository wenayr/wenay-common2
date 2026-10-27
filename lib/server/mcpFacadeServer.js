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
const MAX_DYNAMIC_FINDINGS = 64;
function findNestedDynamic(value, limits, path = []) {
    if (path.length > limits.maxDepth)
        throw new rpc_limits_1.PayloadLimitError('max depth exceeded');
    if (value == null || typeof value != 'object' || binaryByteLength(value) != null)
        return null;
    if (path.length > 0 && (0, rpc_dynamic_1.isNoStrict)(value))
        return path;
    if (value instanceof Date || value instanceof RegExp)
        return null;
    const size = value instanceof Map || value instanceof Set ? value.size : Array.isArray(value) ? value.length : null;
    if (size != null) {
        if (size > limits.maxArrayLen)
            throw new rpc_limits_1.PayloadLimitError('array too long');
        const items = value instanceof Map ? [...value.entries()] : value instanceof Set ? [...value] : value;
        for (let i = 0; i < items.length; i++) {
            const found = findNestedDynamic(items[i], limits, [...path, String(i)]);
            if (found)
                return found;
        }
        return null;
    }
    const keys = Object.keys(value);
    if (keys.length > limits.maxKeys)
        throw new rpc_limits_1.PayloadLimitError('too many keys in object');
    for (const key of keys) {
        if (!(0, rpc_limits_1.isSafeKey)(key))
            continue;
        const found = findNestedDynamic(value[key], limits, [...path, key]);
        if (found)
            return found;
    }
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
    const completions = resourceOptions?.completions == true;
    const limits = (0, rpc_limits_1.resolveLimits)(deps.limits);
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
    function resourcePath(uri) {
        const prefix = `${scheme}://`;
        if (typeof uri != 'string' || uri.slice(0, prefix.length).toLowerCase() != prefix.toLowerCase())
            return null;
        const rest = uri.slice(prefix.length);
        if (rest == '' || rest.includes('?') || rest.includes('#'))
            return null;
        let count = 1;
        for (let at = rest.indexOf('/'); at != -1; at = rest.indexOf('/', at + 1)) {
            if (++count > limits.maxPathLen)
                return null;
        }
        const segments = [];
        for (const raw of rest.split('/')) {
            let segment;
            try {
                segment = decodeURIComponent(raw);
            }
            catch {
                return null;
            }
            if (segment == '' || segment == '.' || segment == '..')
                return null;
            segments.push(segment);
        }
        return segments;
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
    const keyChecks = new WeakMap();
    const dispatchInputs = new WeakMap();
    const undescribedNode = {};
    function compiledKey(meta) {
        if (validator == null || meta.key == null)
            return undefined;
        let check = keyChecks.get(meta);
        if (!check) {
            check = validator.getValidator(meta.key);
            keyChecks.set(meta, check);
        }
        return check;
    }
    function dispatchInput(meta, depth) {
        const owner = meta ?? undescribedNode;
        let byDepth = dispatchInputs.get(owner);
        if (!byDepth)
            dispatchInputs.set(owner, byDepth = new Map());
        let entry = byDepth.get(depth);
        if (!entry) {
            const schema = {
                type: 'object',
                properties: {
                    key: meta?.key ?? { type: 'string', minLength: 1 },
                    method: {
                        type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: depth,
                        description: 'Member path below the key, e.g. ["start"]',
                    },
                    args: {
                        type: ['object', 'array'],
                        description: 'The member\'s arguments: the object its metadata describes; an undescribed member also takes a positional array',
                    },
                },
                required: ['key', 'method'],
                additionalProperties: false,
            };
            entry = { schema, check: validator?.getValidator(schema) };
            byDepth.set(depth, entry);
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
    const dynamicFindings = new Map();
    function reportDynamic(node, member, message) {
        const label = node.join('.');
        let seen = dynamicFindings.get(label);
        if (!seen)
            dynamicFindings.set(label, seen = new Set());
        const path = [...node, '*', ...member].join('.');
        if (seen.has(path))
            return;
        if (seen.size >= MAX_DYNAMIC_FINDINGS) {
            report({ path: `${label}.*`, message: `more than ${MAX_DYNAMIC_FINDINGS} undescribed members: the rest are not reported` });
            return;
        }
        seen.add(path);
        report({ path, message });
    }
    return {
        deps,
        rule,
        scheme,
        resourceOptions,
        maxSubscriptions,
        completions,
        limits,
        metaMap: (0, facadeMeta_1.checkMetaMap)(deps.meta),
        around,
        queue,
        disposal,
        attachments,
        findings,
        events: { emitCalled, emitFailed, called, failed },
        toolName,
        resourceUri,
        resourcePath,
        compiled,
        compiledKey,
        dispatchInput,
        report,
        reportDynamic,
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
function makeTemplate(shared, path, node, exposure) {
    const meta = (0, facadeMeta_1.dynamicMeta)(node);
    const base = shared.resourceUri(path);
    const name = path.join('.');
    return {
        path,
        node,
        meta,
        base,
        dispatcher: exposure == 'call' ? shared.toolName([...path, 'call']) : undefined,
        checkKey: meta ? shared.compiledKey(meta) : undefined,
        descriptor: {
            uriTemplate: `${base}/{key}`,
            name,
            ...(meta?.title != null ? { title: meta.title } : {}),
            description: meta?.description
                ?? `Dynamic keys under ${name}: read ${base}/<key>[/<member>...]; a store reads its current value, data reads as JSON, a plain listen only notifies (subscribe).`,
            mimeType: 'application/json',
        },
    };
}
function makeDispatchEntry(shared, template) {
    const { deps, limits } = shared;
    const label = template.path.join('.');
    const depth = limits.maxPathLen - template.path.length - 1;
    if (depth < 1)
        throw new Error(`MCP facade: dynamic node ${label} is too deep for limits.maxPathLen (${limits.maxPathLen})`);
    const meta = template.meta;
    const readOnlyHint = meta?.annotations?.readOnlyHint ?? deps.policy?.readOnly?.(template.path);
    const annotations = meta?.annotations || readOnlyHint != null
        ? { ...meta?.annotations, ...(readOnlyHint != null ? { readOnlyHint } : {}) }
        : undefined;
    const members = Object.entries(meta?.members ?? {}).map(([member, entry]) => `${member}: ${entry.description}`);
    const input = shared.dispatchInput(meta, depth);
    const name = template.dispatcher ?? shared.toolName([...template.path, 'call']);
    const descriptor = {
        name,
        ...(meta?.title != null ? { title: meta.title } : {}),
        description: (meta?.description ?? `Calls a member below a dynamic key of ${label}.`)
            + ' Input: key, method (the member path below the key), args.'
            + (members.length ? ` Members: ${members.join('; ')}.` : ''),
        inputSchema: input.schema,
        ...(annotations ? { annotations } : {}),
    };
    return {
        name,
        path: [...template.path, 'call'],
        template,
        descriptor,
        readOnly: readOnlyHint == true,
        check: input.check,
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
        const templates = new Map();
        const missing = [];
        const undescribed = [];
        const walked = new Set();
        function take(value, path) {
            const kind = (0, facadeWalk_1.facadeNodeKind)(value);
            if (kind == 'dynamic') {
                addDynamic(path, value);
                return true;
            }
            if (kind != 'on' && kind != 'listen')
                return false;
            walked.add((0, facadeMeta_1.facadeMetaKey)(path));
            addResource(makeResource(path, { on: (kind == 'on' ? value : value.on) }));
            return true;
        }
        function addResource(resource) {
            if (shared.resourceOptions == null)
                return;
            if (resources.has(resource.uri))
                throw new Error(`MCP facade: resource ${resource.uri} is registered twice`);
            resources.set(resource.uri, resource);
        }
        function addTool(tool) {
            const previous = tools.get(tool.name);
            if (previous) {
                throw new Error(`MCP facade: tool name "${tool.name}" is registered twice (${JSON.stringify(previous.path)} and ${JSON.stringify(tool.path)})`);
            }
            tools.set(tool.name, tool);
        }
        function addDynamic(path, node) {
            const exposure = deps.policy?.dynamic?.(path) ?? 'read';
            if (exposure !== false && exposure != 'read' && exposure != 'call') {
                throw new Error(`MCP facade: policy.dynamic for ${JSON.stringify(path)} must be false, 'read' or 'call', got ${String(exposure)}`);
            }
            if (exposure === false)
                return;
            const template = makeTemplate(shared, path, node, exposure);
            if (shared.resourceOptions != null) {
                if (templates.has(template.base))
                    throw new Error(`MCP facade: resource template ${template.descriptor.uriTemplate} is registered twice`);
                templates.set(template.base, template);
            }
            if (exposure != 'call')
                return;
            addTool(makeDispatchEntry(shared, template));
            if (deps.strict && !template.meta)
                undescribed.push(path.join('.'));
        }
        function addAll(object, prefix) {
            if (prefix.length > 0 && (0, facadeWalk_1.facadeNodeKind)(object) == 'dynamic') {
                addDynamic(prefix, object);
                return;
            }
            for (const entry of (0, facadeWalk_1.walkFacade)(object, { label: 'MCP facade', take: (value, path) => take(value, [...prefix, ...path]) })) {
                const path = [...prefix, ...entry.path];
                const tool = makeToolEntry(shared, path, entry.fn, entry.context);
                walked.add((0, facadeMeta_1.facadeMetaKey)(path));
                addTool(tool);
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
        const problems = [
            ...(missing.length ? [`functions without description and input/args: ${missing.join(', ')}`] : []),
            ...(undescribed.length ? [`'call' nodes without describeDynamic: ${undescribed.join(', ')}`] : []),
        ];
        if (problems.length)
            throw new Error(`MCP facade (strict): ${problems.join('; ')}`);
        if (checkStaleMeta && metaMap) {
            const stale = Object.keys(metaMap).filter(key => !walked.has(key));
            if (stale.length && deps.strict)
                throw new Error(`MCP facade (strict): meta keys name no facade function: ${stale.join(', ')}`);
            for (const key of stale)
                shared.report({ path: key, message: 'meta entry names no facade function' });
        }
        return { tools, resources, templates };
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
        if ('template' in tool)
            return callDynamic(tool, input, scope);
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
    function resolveBelow(template, segments) {
        if (template.path.length + segments.length > limits.maxPathLen)
            throw new rpc_limits_1.PayloadLimitError('path too long');
        for (const segment of segments) {
            if (segment == '' || !(0, rpc_limits_1.isSafeKey)(segment))
                throw new myThrow_1.MyError(`Forbidden path segment: ${segment}`, 'E_MCP_ARGS');
        }
        const check = template.checkKey?.(segments[0]);
        if (check && !check.valid) {
            throw new myThrow_1.MyError(`Invalid key under ${template.path.join('.')}: ${check.errorMessage}`, 'E_MCP_ARGS');
        }
        let parent = template.node;
        let node = template.node;
        for (const segment of segments) {
            if (node == null || typeof node != 'object')
                return undefined;
            const kind = nodeKind(node);
            if (kind == 'binary' || kind == 'on' || kind == 'listen')
                return undefined;
            parent = node;
            node = (0, facadeWalk_1.dynamicMember)(node, segment);
            if (node === undefined)
                return undefined;
        }
        return { node, parent };
    }
    function nodeKind(node) {
        return binaryByteLength(node) != null ? 'binary' : (0, facadeWalk_1.facadeNodeKind)(node);
    }
    function makeDynamicTarget(entry, segments, fn, context) {
        const path = [...entry.template.path, ...segments];
        const members = entry.template.meta?.members;
        const method = segments.slice(1);
        const member = method.some(segment => segment.includes('.')) ? undefined : (0, facadeMeta_1.facadeMetaKey)(method);
        const meta = member != null && members != null && Object.prototype.hasOwnProperty.call(members, member) ? members[member] : (0, facadeMeta_1.methodMeta)(fn);
        return {
            name: entry.name,
            path,
            fn,
            context,
            meta,
            readOnly: (meta?.annotations?.readOnlyHint ?? deps.policy?.readOnly?.(path)) == true,
            concurrency: deps.policy?.concurrency?.(path) ?? 'serial',
            validate: meta ? shared.compiled(meta) : {},
        };
    }
    function dynamicArgs(entry, target, rawArgs) {
        const label = target.path.join('.');
        if (target.meta) {
            const raw = rawArgs ?? {};
            if (!isPlainObject(raw))
                throw new myThrow_1.MyError(`Arguments of ${label} must be the object its metadata describes`, 'E_MCP_ARGS');
            const check = target.validate.input?.(raw);
            if (check && !check.valid)
                throw new myThrow_1.MyError(`Invalid arguments for ${label}: ${check.errorMessage}`, 'E_MCP_ARGS');
            return toCallArgs(target, (0, rpc_walk_1.unpackResult)(raw, limits));
        }
        if (deps.strict)
            throw new myThrow_1.MyError(`MCP facade (strict): ${label} has no metadata (describeDynamic members or describeMethod)`, 'E_MCP_ARGS');
        shared.reportDynamic(entry.template.path, target.path.slice(entry.template.path.length + 1), 'no metadata: args pass unvalidated (an array is positional, an object is the one argument)');
        if (rawArgs == null)
            return [];
        if (!Array.isArray(rawArgs) && !isPlainObject(rawArgs))
            throw new myThrow_1.MyError(`Arguments of ${label} must be an array or an object`, 'E_MCP_ARGS');
        if (Array.isArray(rawArgs) && rawArgs.length > limits.maxArgs)
            throw new rpc_limits_1.PayloadLimitError('too many args');
        const decoded = (0, rpc_walk_1.unpackResult)(rawArgs, limits);
        if (Array.isArray(decoded))
            return decoded;
        return Object.keys(decoded).length ? [decoded] : [];
    }
    async function callDynamic(entry, input, scope) {
        if (shared.disposal.signal.aborted)
            return errorResult(new myThrow_1.MyError('MCP facade is disposed', 'E_MCP_DISPOSED'));
        try {
            const raw = input ?? {};
            if (!isPlainObject(raw))
                throw new myThrow_1.MyError(`Arguments of ${entry.name} must be an object`, 'E_MCP_ARGS');
            const { key, method } = raw;
            if (typeof key != 'string' || key == '')
                throw new myThrow_1.MyError(`${entry.name}: key must be a non-empty string`, 'E_MCP_ARGS');
            if (!Array.isArray(method) || method.length == 0 || method.some(segment => typeof segment != 'string')) {
                throw new myThrow_1.MyError(`${entry.name}: method must be a non-empty array of member names`, 'E_MCP_ARGS');
            }
            if (entry.template.path.length + 1 + method.length > limits.maxPathLen)
                throw new rpc_limits_1.PayloadLimitError('path too long');
            const check = entry.check?.(raw);
            if (check && !check.valid)
                throw new myThrow_1.MyError(`Invalid arguments for ${entry.name}: ${check.errorMessage}`, 'E_MCP_ARGS');
            const segments = [key, ...method];
            const label = [...entry.template.path, ...segments].join('.');
            const found = resolveBelow(entry.template, segments);
            if (!found)
                throw new myThrow_1.MyError(`${entry.name}: nothing at ${label}`, 'E_MCP_NOT_FOUND');
            if (typeof found.node != 'function' || (0, Listen_1.isListenOn)(found.node)) {
                throw new myThrow_1.MyError(`${entry.name}: ${label} is not a function`, 'E_MCP_NOT_FOUND');
            }
            const target = makeDynamicTarget(entry, segments, found.node, found.parent);
            if (deps.readOnly && !target.readOnly) {
                throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `${label} is not read-only and this MCP facade serves reads only`);
            }
            const value = await execute(target, dynamicArgs(entry, target, raw['args']), scope);
            return encodeResult(target, value);
        }
        catch (error) {
            if (error instanceof types_js_1.McpError)
                throw error;
            return errorResult(error);
        }
    }
    function findStatic(composition, uri) {
        const exact = composition.resources.get(uri);
        if (exact)
            return exact;
        let href;
        try {
            href = new URL(uri).href;
        }
        catch {
            return undefined;
        }
        for (const resource of composition.resources.values()) {
            try {
                if (new URL(resource.uri).href == href)
                    return resource;
            }
            catch { }
        }
        return undefined;
    }
    function templateAt(composition, path) {
        for (let i = 1; i < path.length; i++) {
            const template = composition.templates.get(shared.resourceUri(path.slice(0, i)));
            if (template)
                return { template, segments: path.slice(i) };
        }
        return undefined;
    }
    function sourceIn(composition, uri) {
        const resource = composition.resources.get(uri);
        if (resource)
            return resource.on;
        const path = shared.resourcePath(uri);
        return path ? templateAt(composition, path)?.template.node : undefined;
    }
    function resolveResource(uri) {
        const composition = state.current();
        const resource = findStatic(composition, uri);
        if (resource) {
            return {
                uri: resource.uri, on: resource.on, tool: resource.tool,
                template: undefined, value: undefined, kind: undefined, source: resource.on ?? resource.tool,
            };
        }
        const path = shared.resourcePath(uri);
        const match = path ? templateAt(composition, path) : undefined;
        if (path && match) {
            let found;
            try {
                found = resolveBelow(match.template, match.segments);
            }
            catch (error) {
                throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Resource ${uri}: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (found) {
                const kind = nodeKind(found.node);
                const on = kind == 'on' ? found.node : kind == 'listen' ? found.node.on : undefined;
                return {
                    uri: shared.resourceUri(path), on, tool: undefined,
                    template: match.template, value: found.node, kind, source: match.template.node,
                };
            }
        }
        throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    }
    function currentValue(uri, on) {
        let current;
        const off = on(function captureCurrent(...args) { current ??= args; }, { current: true });
        off();
        if (current == undefined) {
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Resource ${uri} has no current value: a plain listen only notifies, a store has none yet`);
        }
        return current.length == 1 ? current[0] : current;
    }
    function dataValue(uri, resource) {
        if (typeof resource.value == 'function') {
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, resource.template?.dispatcher
                ? `Resource ${uri} is a function: call it with the ${resource.template.dispatcher} tool`
                : `Resource ${uri} is a function: policy.dynamic 'call' exposes the members of ${resource.template?.path.join('.')} as a tool`);
        }
        if (resource.kind == 'dynamic')
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Resource ${uri} is a dynamic map: read one of its keys`);
        const nested = findNestedDynamic(resource.value, limits);
        if (nested) {
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Resource ${uri} holds a dynamic map at ${nested.join('.')}: read its keys one by one`);
        }
        return resource.value;
    }
    function encodeResourceValue(uri, value, onLeaf) {
        (0, rpc_walk_1.walk)(value, onLeaf, limits);
        if (binaryByteLength(value) != null) {
            throw new myThrow_1.MyError(`Resource ${uri} is binary: resources here carry JSON, return the bytes from a tool`, 'E_MCP_BINARY');
        }
        const packed = (0, rpc_walk_1.packResult)(value);
        const nested = findNestedBinary(packed);
        if (nested)
            throw new myThrow_1.MyError(`Binary value at ${nested.join('.')} of resource ${uri}: resources here carry JSON`, 'E_MCP_BINARY');
        return JSON.stringify(packed ?? null);
    }
    async function readResource(uri, scope) {
        const resource = resolveResource(uri);
        let value;
        let onLeaf = function keepLeaf(leaf) { return leaf; };
        if (resource.tool)
            value = await execute(resource.tool, [], scope);
        else if (resource.on)
            value = currentValue(uri, resource.on);
        else {
            value = dataValue(uri, resource);
            onLeaf = function refuseFunctionLeaf(leaf) {
                if (typeof leaf == 'function') {
                    throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Resource ${uri} is a subtree with functions: read a data member below it`);
                }
                return leaf;
            };
        }
        return { contents: [{ uri: resource.uri, mimeType: 'application/json', text: encodeResourceValue(uri, value, onLeaf) }] };
    }
    function subscribe(attachment, uri) {
        const resource = resolveResource(uri);
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
        attachment.subscriptions.set(target, { off: resource.on(notifyUpdated), source: resource.source });
    }
    function unsubscribe(attachment, uri) {
        const resource = findStatic(state.current(), uri);
        const path = resource ? null : shared.resourcePath(uri);
        const key = resource?.uri ?? (path ? shared.resourceUri(path) : uri);
        attachment.subscriptions.get(key)?.off();
        attachment.subscriptions.delete(key);
    }
    function templateDescriptors() {
        return [...state.current().templates.values()].map(template => template.descriptor);
    }
    function completeKeys(template, prefix) {
        let keys;
        try {
            keys = Object.keys(template.node);
        }
        catch {
            keys = [];
        }
        const values = keys.filter(function offeredKey(key) {
            if (key == '' || !(0, rpc_limits_1.isSafeKey)(key) || !key.startsWith(prefix))
                return false;
            if (template.checkKey && !template.checkKey(key).valid)
                return false;
            try {
                return Reflect.has(template.node, key);
            }
            catch {
                return false;
            }
        });
        return { values: values.slice(0, 100), total: values.length, hasMore: values.length > 100 };
    }
    function complete(ref, argument) {
        if (ref.type != 'ref/resource' || typeof ref.uri != 'string') {
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, 'This MCP facade completes the keys of its resource templates only');
        }
        const composition = state.current();
        if (findStatic(composition, ref.uri))
            return { values: [], total: 0, hasMore: false };
        const template = [...composition.templates.values()].find(template => template.descriptor.uriTemplate == ref.uri);
        if (!template)
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Unknown resource template: ${ref.uri}`);
        if (argument.name != 'key')
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Resource template ${ref.uri} has no argument ${argument.name}`);
        return completeKeys(template, argument.value);
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
        const current = state.current();
        return shared.resourceOptions != null
            && (deps.resources != null || current.resources.size > 0 || current.templates.size > 0);
    }
    function attach(target, session = {}) {
        if (shared.disposal.signal.aborted)
            throw new Error('MCP facade is disposed');
        const inner = target.server;
        const server = inner != null && typeof inner.setRequestHandler == 'function' ? inner : target;
        if (server.transport)
            throw new Error('MCP facade: attach before connecting the server (capabilities are fixed at connect)');
        const withResources = claimsResources();
        const withCompletions = withResources && shared.completions;
        const toolsClaim = 'one server has one tool registry, mount other tools with control.mount';
        const resourcesClaim = 'the facade claims resources/* for its Listen streams, noStrict nodes or the resources option; resources: false leaves them to the host';
        const claims = [
            ['tools/list', toolsClaim], ['tools/call', toolsClaim],
            ...(withResources
                ? ['resources/list', 'resources/templates/list', 'resources/read', 'resources/subscribe', 'resources/unsubscribe']
                    .map(method => [method, resourcesClaim])
                : []),
            ...(withCompletions ? [['completion/complete', 'resources.completions: true claims it for template keys']] : []),
        ];
        const methods = claims.map(([method]) => method);
        for (const [method, reason] of claims) {
            try {
                server.assertCanSetRequestHandler(method);
            }
            catch {
                throw new Error(`MCP facade: ${method} is already handled on this server; ${reason}`);
            }
        }
        server.registerCapabilities({
            tools: { listChanged: true },
            ...(withResources ? { resources: { subscribe: true, listChanged: true } } : {}),
            ...(withCompletions ? { completions: {} } : {}),
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
            server.setRequestHandler(types_js_1.ListResourceTemplatesRequestSchema, function listResourceTemplates() {
                return { resourceTemplates: templateDescriptors() };
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
        if (withCompletions) {
            server.setRequestHandler(types_js_1.CompleteRequestSchema, function completeRequest(request) {
                return { completion: complete(request.params.ref, request.params.argument) };
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
            for (const subscription of attachment.subscriptions.values())
                subscription.off();
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
        const resourcesChanged = signature(before.resources.values()) != signature(after.resources.values())
            || signature(before.templates.values()) != signature(after.templates.values());
        for (const attachment of shared.attachments) {
            if (attachment.surface != surfaceId)
                continue;
            for (const [uri, subscription] of [...attachment.subscriptions]) {
                if (sourceIn(after, uri) == subscription.source)
                    continue;
                subscription.off();
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
            templates: templateDescriptors,
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
