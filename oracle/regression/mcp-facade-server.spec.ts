// =====================================================================
//  MCP tools generated from a facade (wenay-common2/server/mcp).
//
//  Everything is driven through the official SDK client: in-process over InMemoryTransport
//  for the tool/resource surface, over a real HTTP socket for sessions and auth. Each
//  section names the contract it pins; negative controls sit next to the positive ones.
// =====================================================================

import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'

import express from 'express'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {
    ResourceListChangedNotificationSchema,
    ResourceUpdatedNotificationSchema,
    ToolListChangedNotificationSchema,
    type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'

import {listen, listenStore} from '../../src/Common/events/Listen'
import {noStrict} from '../../src/Common/rcp/rpc-dynamic'
import {unpackResult} from '../../src/Common/rcp/rpc-walk'
import {MyError} from '../../src/toError/myThrow'
import {createHttpFacadeOpenApi} from '../../src/server/http-index'
import {
    createMcpFacadeHttp,
    createMcpFacadeServer,
    describeMethod,
    type McpAround,
    type McpCallEvent,
    type McpFacadeSurface,
    type McpToolContext,
} from '../../src/server/mcp-index'
import {methodArgTuple, methodMeta} from '../../src/server/facadeMeta'
import {runOracle} from '../run-oracle'

let checks = 0
function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
    checks++
}
function same(a: unknown, b: unknown) {
    return JSON.stringify(a) == JSON.stringify(b)
}
function textOf(result: CallToolResult) {
    const first = result.content[0]
    return first?.type == 'text' ? first.text : ''
}
function errorOf(result: CallToolResult) {
    assert(result.isError == true, `expected an error result, got ${JSON.stringify(result)}`)
    return JSON.parse(textOf(result)).error as {name: string, message: string, code?: string, stack?: string}
}
function throwsWith(run: () => unknown, fragment: string, label: string) {
    try {
        run()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        assert(message.includes(fragment), `${label}: refusal "${message}" does not mention "${fragment}"`)
        return message
    }
    throw new Error(`${label}: expected a refusal`)
}
async function rejectsWith(run: () => Promise<unknown>, fragment: string, label: string) {
    try {
        await run()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        assert(message.includes(fragment), `${label}: rejection "${message}" does not mention "${fragment}"`)
        return error
    }
    throw new Error(`${label}: expected a rejection`)
}
function gate() {
    let open!: () => void
    const opened = new Promise<void>(resolve => { open = resolve })
    return {open, opened}
}
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const silent = {onFinding() {}}

async function connect(surface: McpFacadeSurface, principal?: unknown) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = surface.control.server({principal})
    await server.connect(serverTransport)
    const client = new Client({name: 'oracle', version: '1.0.0'})
    await client.connect(clientTransport)
    return {client, server, close: () => client.close()}
}

// =====================================================================
// the facade under test
// =====================================================================

function createDocument() {
    const order: string[] = []
    const doc = {
        items: [] as string[],
        add: describeMethod(function add(this: {items: string[]}, name: string, at?: number) {
            order.push(`add:${name}:${arguments.length}`)
            if (at == null) this.items.push(name)
            else this.items.splice(at, 0, name)
            return {items: [...this.items]}
        }, {
            description: 'Adds an item, optionally at a position',
            args: [
                {name: 'name', schema: {type: 'string'}, description: 'Item name'},
                {name: 'at', schema: {type: 'integer', minimum: 0}, optional: true},
            ],
            annotations: {destructiveHint: false, idempotentHint: false},
        }),
        fail: describeMethod(function fail() {
            throw new MyError('document refused', 'E_DOC', {reason: 'locked'})
        }, {description: 'Always fails', args: []}),
        when: describeMethod(function when() {
            return {at: new Date(0), tags: new Set(['a']), big: 10n}
        }, {description: 'Rich values', args: []}),
        bytes: describeMethod(function bytes() { return new Uint8Array([1, 2, 3]) }, {description: 'Bytes', args: []}),
        nestedBytes: describeMethod(function nestedBytes() { return {raw: new Uint8Array(4)} }, {description: 'Nested bytes', args: []}),
        echo: describeMethod(function echo(args: {text: string}) { return args.text }, {
            description: 'Echoes text',
            input: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']},
        }),
        typed: describeMethod(function typed(args: {wrong: boolean}) { return args.wrong ? {count: 'many'} : {count: 2} }, {
            description: 'Structured result with an output schema',
            input: {type: 'object', properties: {wrong: {type: 'boolean'}}},
            output: {type: 'object', properties: {count: {type: 'integer'}}, required: ['count']},
        }),
        slow: describeMethod(async function slow(args: {steps: number}, ctx: McpToolContext) {
            for (let step = 1; step <= args.steps; step++) {
                if (ctx.signal.aborted) throw new MyError('aborted by the caller', 'E_ABORTED')
                ctx.progress(step, args.steps, `step ${step}`)
                await tick(15)
            }
            return {done: args.steps, session: ctx.session.id, principal: ctx.principal}
        }, {
            description: 'Reports progress, honours cancellation',
            input: {type: 'object', properties: {steps: {type: 'integer'}}, required: ['steps']},
            context: true,
        }),
    }
    const view = {
        list: describeMethod(function list(args: {prefix?: string}) {
            return {items: doc.items.filter(item => item.startsWith(args.prefix ?? ''))}
        }, {
            description: 'Lists items by prefix',
            title: 'List items',
            input: {type: 'object', properties: {prefix: {type: 'string'}}},
        }),
        count: describeMethod(function count() { return doc.items.length }, {description: 'Item count', args: []}),
    }
    return {facade: {view, doc}, doc, order}
}

const readOnlyByFacet = (path: readonly string[]) => path[0] == 'view'

// =====================================================================
// tests
// =====================================================================

async function toolsOverSdk() {
    const {facade, doc, order} = createDocument()
    const called: McpCallEvent[] = []
    const failed: string[] = []
    const mcp = createMcpFacadeServer({
        name: 'oracle-doc', version: '1.0.0', object: facade, strict: true,
        policy: {readOnly: readOnlyByFacet},
        limits: {maxStringLen: 64},
        formatResult: (path, value) => path.join('.') == 'view.count' ? {content: [{type: 'text', text: `count=${value}`}]} : undefined,
    })
    mcp.on.called(event => called.push(event))
    mcp.on.failed(event => failed.push(event.tool))
    const {client, close} = await connect(mcp)

    // ---------- list ----------
    const {tools} = await client.listTools()
    const names = tools.map(tool => tool.name)
    assert(same(names, ['view.list', 'view.count', 'doc.add', 'doc.fail', 'doc.when', 'doc.bytes', 'doc.nestedBytes', 'doc.echo', 'doc.typed', 'doc.slow']),
        `tool names follow the walk: ${names}`)
    const add = tools.find(tool => tool.name == 'doc.add')!
    assert(same(add.inputSchema, {
        type: 'object',
        properties: {name: {type: 'string', description: 'Item name'}, at: {type: 'integer', minimum: 0}},
        required: ['name'],
        additionalProperties: false,
    }), `positional args become one object schema: ${JSON.stringify(add.inputSchema)}`)
    assert(add.annotations?.readOnlyHint === false && add.annotations?.destructiveHint == false,
        'annotations from metadata, policy.readOnly answers false under doc')
    const list = tools.find(tool => tool.name == 'view.list')!
    assert(list.title == 'List items' && list.annotations?.readOnlyHint == true, 'policy.readOnly fills readOnlyHint under view')
    assert(tools.find(tool => tool.name == 'doc.typed')!.outputSchema != null, 'outputSchema from metadata')

    // ---------- object argument, positional arguments, this ----------
    const echoed = await client.callTool({name: 'doc.echo', arguments: {text: 'hi'}}) as CallToolResult
    assert(same(echoed.structuredContent, {value: 'hi'}) && textOf(echoed) == '{"value":"hi"}', 'a primitive is wrapped as {value}')
    const added = await client.callTool({name: 'doc.add', arguments: {name: 'b'}}) as CallToolResult
    assert(same(added.structuredContent, {items: ['b']}), 'positional call with this preserved')
    await client.callTool({name: 'doc.add', arguments: {name: 'a', at: 0}})
    assert(same(doc.items, ['a', 'b']), 'the second positional argument reached the function')
    assert(same(order, ['add:b:1', 'add:a:2']), `an omitted trailing argument is not passed: ${order}`)
    const listed = await client.callTool({name: 'view.list', arguments: {prefix: 'a'}}) as CallToolResult
    assert(same(listed.structuredContent, {items: ['a']}), 'object-argument tool')
    const counted = await client.callTool({name: 'view.count', arguments: {}}) as CallToolResult
    assert(textOf(counted) == 'count=2' && counted.structuredContent == undefined, 'formatResult replaces the encoding for its path')

    // ---------- validation, errors ----------
    const unknownArg = errorOf(await client.callTool({name: 'doc.add', arguments: {name: 'x', extra: 1}}) as CallToolResult)
    assert(unknownArg.code == 'E_MCP_ARGS', `an argument outside the schema is a tool error: ${JSON.stringify(unknownArg)}`)
    const wrongType = errorOf(await client.callTool({name: 'doc.add', arguments: {name: 5}}) as CallToolResult)
    assert(wrongType.code == 'E_MCP_ARGS' && wrongType.message.includes('doc.add'), 'schema validation names the tool')
    const thrown = errorOf(await client.callTool({name: 'doc.fail', arguments: {}}) as CallToolResult)
    assert(thrown.message == 'document refused' && thrown.code == 'E_DOC' && thrown.stack == undefined,
        `a throw is isError with message and MyError code, no stack: ${JSON.stringify(thrown)}`)
    await rejectsWith(() => client.callTool({name: 'doc.missing', arguments: {}}), 'Unknown tool', 'an unknown tool is a protocol error')

    // ---------- codec, binary, output schema, limits ----------
    const rich = await client.callTool({name: 'doc.when', arguments: {}}) as CallToolResult
    const restored = unpackResult(rich.structuredContent)
    assert(restored.at instanceof Date && restored.tags instanceof Set && restored.big == 10n, 'the RPC walk codec packs Date/Set/BigInt')
    const bytes = await client.callTool({name: 'doc.bytes', arguments: {}}) as CallToolResult
    const blob = bytes.content[0]
    assert(blob?.type == 'resource' && 'blob' in blob.resource && blob.resource.blob == 'AQID'
        && blob.resource.mimeType == 'application/octet-stream', 'top-level bytes are an explicit blob resource')
    assert(errorOf(await client.callTool({name: 'doc.nestedBytes', arguments: {}}) as CallToolResult).code == 'E_MCP_BINARY',
        'nested bytes are refused, not inflated into JSON')
    const typed = await client.callTool({name: 'doc.typed', arguments: {wrong: false}}) as CallToolResult
    assert(same(typed.structuredContent, {count: 2}), 'a result matching its output schema passes')
    assert(errorOf(await client.callTool({name: 'doc.typed', arguments: {wrong: true}}) as CallToolResult).code == 'E_MCP_OUTPUT',
        'a result breaking its output schema is an explicit error, not a client-side failure')
    const tooLongIn = errorOf(await client.callTool({name: 'doc.echo', arguments: {text: 'x'.repeat(65)}}) as CallToolResult)
    assert(tooLongIn.name == 'PayloadLimitError', `RpcLimits apply to input: ${JSON.stringify(tooLongIn)}`)
    const shortEnough = await client.callTool({name: 'doc.echo', arguments: {text: 'x'.repeat(64)}}) as CallToolResult
    assert(shortEnough.isError != true, 'negative control: a value at the limit passes')

    // ---------- audit streams ----------
    assert(called.some(event => event.tool == 'doc.add' && event.session.id.length > 0), 'on.called reports successful calls with the session')
    assert(failed.includes('doc.fail') && failed.includes('doc.nestedBytes') == false,
        'on.failed reports calls whose function threw (encoding refusals happen after the call)')

    await close()
    mcp.control.dispose()
    const after = errorOf(await mcp.tools.call('view.count', {}))
    assert(after.code == 'E_MCP_DISPOSED', 'a disposed facade refuses calls')
}

async function outputLimit() {
    const mcp = createMcpFacadeServer({
        name: 'limit', version: '1', limits: {maxStringLen: 8},
        object: {big: describeMethod(() => 'y'.repeat(9), {description: 'Too big', args: []})},
    })
    const refused = errorOf(await mcp.tools.call('big', {}))
    assert(refused.name == 'PayloadLimitError', 'RpcLimits apply to output: an explicit error, not truncation')
}

async function readOnlyMode() {
    const {facade} = createDocument()
    const mcp = createMcpFacadeServer({
        name: 'oracle-read', version: '1.0.0', object: facade, readOnly: true, policy: {readOnly: readOnlyByFacet},
    })
    const {client, close} = await connect(mcp)
    const names = (await client.listTools()).tools.map(tool => tool.name)
    assert(same(names, ['view.list', 'view.count']), `read-only mode lists read-only tools only: ${names}`)
    await rejectsWith(() => client.callTool({name: 'doc.add', arguments: {name: 'x'}}), 'serves reads only',
        'a mutating tool is refused by name too')
    await close()
}

async function ordering() {
    function createRace(parallel: boolean) {
        const log: string[] = []
        const slowGate = gate()
        const facade = {
            slow: describeMethod(async function slow() {
                log.push('slow:start')
                await slowGate.opened
                log.push('slow:end')
            }, {description: 'slow', args: []}),
            fast: describeMethod(function fast() { log.push('fast') }, {description: 'fast', args: []}),
        }
        const mcp = createMcpFacadeServer({
            name: 'race', version: '1', object: facade,
            policy: parallel ? {concurrency: () => 'parallel'} : undefined,
        })
        return {mcp, log, slowGate}
    }

    const serial = createRace(false)
    const serialSlow = serial.mcp.tools.call('slow', {})
    const serialFast = serial.mcp.tools.call('fast', {})
    await tick(20)
    assert(same(serial.log, ['slow:start']), `serial (default): the second call waits for the first: ${serial.log}`)
    serial.slowGate.open()
    await Promise.all([serialSlow, serialFast])
    assert(same(serial.log, ['slow:start', 'slow:end', 'fast']), 'serial order is call order')

    const parallel = createRace(true)
    const parallelSlow = parallel.mcp.tools.call('slow', {})
    await parallel.mcp.tools.call('fast', {})
    assert(same(parallel.log, ['slow:start', 'fast']), `parallel: the tool orders itself: ${parallel.log}`)
    parallel.slowGate.open()
    await parallelSlow
}

async function middleware() {
    const log: string[] = []
    const outer: McpAround = async function outer(ctx, next) {
        log.push(`outer:before:${ctx.tool}:${ctx.readOnly}:${JSON.stringify(ctx.principal)}`)
        try {
            const value = await next()
            log.push('outer:after')
            return {receipt: true, value}
        } catch (error) {
            log.push(`outer:caught:${(error as Error).message}`)
            throw error
        }
    }
    const inner: McpAround = async function inner(ctx, next) {
        log.push(`inner:before:${JSON.stringify(ctx.args)}`)
        const value = await next()
        log.push('inner:after')
        return value
    }
    const facade = {
        doc: {
            set: describeMethod(function set(value: number) { log.push(`fn:${value}`); return value * 2 }, {
                description: 'Sets', args: [{name: 'value', schema: {type: 'number'}}],
            }),
            fail: describeMethod(function fail() { log.push('fn:fail'); throw new Error('boom') }, {description: 'Fails', args: []}),
        },
    }
    const mcp = createMcpFacadeServer({name: 'around', version: '1', object: facade, around: [outer, inner]})
    const {client, close} = await connect(mcp, {sub: 'alice'})
    const result = await client.callTool({name: 'doc.set', arguments: {value: 2}}) as CallToolResult
    assert(same(log, ['outer:before:doc.set:false:{"sub":"alice"}', 'inner:before:[2]', 'fn:2', 'inner:after', 'outer:after']),
        `around runs outermost first and unwinds in reverse: ${log}`)
    assert(same(result.structuredContent, {receipt: true, value: 4}), 'middleware may decorate the result (receipts)')
    log.length = 0
    const failed = errorOf(await client.callTool({name: 'doc.fail', arguments: {}}) as CallToolResult)
    assert(failed.message == 'boom' && same(log, ['outer:before:doc.fail:false:{"sub":"alice"}', 'inner:before:[]', 'fn:fail', 'outer:caught:boom']),
        `an error propagates through the chain and ends as isError: ${log}`)
    await close()
}

async function contextAbortProgress() {
    const {facade} = createDocument()
    const mcp = createMcpFacadeServer({name: 'ctx', version: '1', object: facade})
    const {client, close} = await connect(mcp, {sub: 'carol'})
    const progress: number[] = []
    const result = await client.callTool({name: 'doc.slow', arguments: {steps: 3}}, undefined, {
        onprogress: update => { progress.push(update.progress) },
    }) as CallToolResult
    const value = result.structuredContent as {done: number, session: string, principal: {sub: string}}
    assert(value.done == 3 && value.principal.sub == 'carol' && value.session.length > 0, 'the context argument carries session and principal')
    assert(same(progress, [1, 2, 3]), `progress tokens reach ctx.progress: ${progress}`)

    const aborts: unknown[] = []
    mcp.on.failed(event => aborts.push(event.error))
    const controller = new AbortController()
    const pending = client.callTool({name: 'doc.slow', arguments: {steps: 20}}, undefined, {signal: controller.signal})
    await tick(20)
    controller.abort()
    await rejectsWith(() => pending, 'abort', 'the client sees its own cancellation')
    await tick(40)
    assert(aborts.length == 1 && (aborts[0] as MyError).code == 'E_ABORTED', 'MCP cancellation aborts ctx.signal inside the function')
    await close()
}

async function refusals() {
    const cyclic: Record<string, unknown> = {ping: () => 1}
    cyclic['self'] = cyclic
    throwsWith(() => createMcpFacadeServer({name: 'x', version: '1', object: cyclic, ...silent}), 'circular branch', 'cycles')
    throwsWith(() => createMcpFacadeServer({name: 'x', version: '1', object: {constructor: () => 1}, ...silent}), 'forbidden key', 'forbidden keys')
    throwsWith(() => createMcpFacadeServer({
        name: 'x', version: '1', object: {a: {b: () => 1}, a_b: () => 2}, names: {separator: '_'}, ...silent,
    }), 'registered twice', 'duplicate tool names')
    const charset = throwsWith(() => createMcpFacadeServer({
        name: 'x', version: '1', object: {view: {list: () => 1}}, names: {charset: 'claude'}, ...silent,
    }), '["view","list"]', 'a claude-charset name with a dot')
    assert(charset.includes('claude'), 'the refusal names the charset')
    throwsWith(() => createMcpFacadeServer({
        name: 'x', version: '1', object: {[`k${'x'.repeat(130)}`]: () => 1}, ...silent,
    }), 'longer than 128', 'the length check')
    const mapped = createMcpFacadeServer({
        name: 'x', version: '1', object: {view: {'list all': () => 1}}, names: {charset: 'claude', map: true}, ...silent,
    })
    assert(same(mapped.tools.list().map(tool => tool.name), ['view_list_all']), 'names.map replaces disallowed characters with _')
    const strict = throwsWith(() => createMcpFacadeServer({
        name: 'x', version: '1', strict: true,
        object: {a: () => 1, b: {c: describeMethod(() => 2, {description: 'no schema'})}, d: describeMethod(() => 3, {description: 'ok', args: []})},
    }), 'a, b.c', 'strict mode lists every path without description and input')
    assert(strict.endsWith(': a, b.c'), `a fully described function is not listed: ${strict}`)
    throwsWith(() => createMcpFacadeServer({
        name: 'x', version: '1', strict: true, object: {d: () => 3}, meta: {d: {description: 'ok', args: []}, gone: {description: 'stale', args: []}},
    }), 'gone', 'strict mode refuses a meta key that names nothing')
    throwsWith(() => describeMethod(() => 1, {description: 'x', input: {type: 'string'}}), "type 'object'", 'input must be one object schema')
    throwsWith(() => describeMethod(() => 1, {description: 'x', input: {type: 'object'}, args: []}), 'exclusive', 'input and args are exclusive')

    const findings: string[] = []
    const loose = createMcpFacadeServer({name: 'x', version: '1', object: {a: (args: {n: number}) => args.n}, onFinding: f => findings.push(`${f.path}: ${f.message}`)})
    const descriptor = loose.tools.list()[0]
    assert(same(descriptor.inputSchema, {type: 'object'}) && descriptor.description.includes('a'), 'non-strict defaults')
    assert(findings.length == 1 && findings[0].startsWith('a: no metadata'), `a missing description is reported as a finding: ${findings}`)
    const looseCall = await loose.tools.call('a', {n: 7})
    assert(same(looseCall.structuredContent, {value: 7}), 'without metadata the arguments object is the one argument')

    const host = new McpServer({name: 'host', version: '1'})
    host.registerTool('own', {description: 'own tool'}, () => ({content: []}))
    throwsWith(() => loose.control.attach(host), 'already handled', 'attach refuses a server whose tools/list is taken')
}

async function openApiParity() {
    const {facade} = createDocument()
    const basePath = '/api'
    const mcp = createMcpFacadeServer({name: 'parity', version: '1', object: facade, strict: true})
    const openApi = createHttpFacadeOpenApi({object: facade, basePath, methods: ['post'], info: {title: 'parity', version: '1'}})
    const paths = openApi.document()['paths'] as Record<string, {post: {summary?: string, requestBody: any}}>
    const tools = mcp.tools.list()
    for (const tool of tools) {
        const route = `${basePath}/${tool.name.split('.').join('/')}`
        const operation = paths[route]?.post
        assert(operation, `MCP tool ${tool.name} has an OpenAPI route`)
        const bodyArgs = operation.requestBody.content['application/json'].schema.oneOf[1]
        const fn = tool.name.split('.').reduce((node: any, key) => node[key], facade)
        assert(same(bodyArgs.prefixItems, methodArgTuple(methodMeta(fn))), `${tool.name}: the OpenAPI tuple is the metadata tuple`)
        const properties = (tool.inputSchema as {properties?: Record<string, unknown>}).properties
        const tuple = bodyArgs.prefixItems as unknown[]
        const fromMcp = methodMeta(fn)?.input ? [tool.inputSchema] : Object.values(properties ?? {})
        assert(same(fromMcp, tuple), `${tool.name}: MCP input schema and OpenAPI tuple carry the same schemas`)
        assert(operation.summary == (methodMeta(fn)?.title ?? tool.description), `${tool.name}: summary from the same metadata`)
    }
    const toolNames = new Set(tools.map(tool => tool.name))
    for (const route of Object.keys(paths)) {
        const name = route.slice(basePath.length + 1).split('/').join('.')
        assert(toolNames.has(name), `OpenAPI route ${route} has an MCP tool`)
    }
    assert(Object.keys(paths).length == tools.length, 'the two lists have the same size')
}

async function listenResources() {
    let price = 10
    const [emitPrice, priceStore] = listenStore<number>({current: () => [price]})
    const [emitTick, ticks] = listen<number>()
    const {facade} = createDocument()
    const object = {
        ...facade,
        events: {price: priceStore.on, ticks},
        dynamic: noStrict({hidden: () => 1}),
    }
    const mcp = createMcpFacadeServer({
        name: 'resources', version: '1', object,
        policy: {readOnly: readOnlyByFacet, resource: path => path.join('.') == 'view.count'},
        resources: {maxSubscriptions: 2},
    })
    const names = mcp.tools.list().map(tool => tool.name)
    assert(!names.some(name => name.startsWith('events') || name.startsWith('dynamic')), `Listen and noStrict are not tools: ${names}`)
    const {client, close} = await connect(mcp)
    const uris = (await client.listResources()).resources.map(resource => resource.uri)
    assert(same([...uris].sort(), ['facade://events/price', 'facade://events/ticks', 'facade://view/count']), `resources: ${uris}`)

    const read = await client.readResource({uri: 'facade://events/price'})
    assert(read.contents[0] && 'text' in read.contents[0] && read.contents[0].text == '10', 'a listenStore reads its current value')
    await rejectsWith(() => client.readResource({uri: 'facade://events/ticks'}), 'no current value', 'a plain listen only notifies')
    const view = await client.readResource({uri: 'facade://view/count'})
    assert(view.contents[0] && 'text' in view.contents[0] && view.contents[0].text == '0', 'a zero-argument view is a readable resource')
    await rejectsWith(() => client.subscribeResource({uri: 'facade://view/count'}), 'no change stream', 'a view has nothing to subscribe to')

    const updates: string[] = []
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => { updates.push(notification.params.uri) })
    await client.subscribeResource({uri: 'facade://events/price'})
    await client.subscribeResource({uri: 'facade://events/ticks'})
    price = 11
    emitPrice(11)
    emitPrice(12)
    emitTick(1)
    await tick(20)
    assert(same(updates, ['facade://events/price', 'facade://events/ticks']), `emits in one tick coalesce per resource: ${updates}`)
    assert(priceStore.count() == 1, 'one Listen subscription per subscribed session')

    const [, extra] = listen<number>()
    mcp.control.mount('more', {stream: extra})
    await rejectsWith(() => client.subscribeResource({uri: 'facade://more/stream'}), 'Subscription limit', 'the per-session subscription limit')
    await client.unsubscribeResource({uri: 'facade://events/ticks'})
    assert(ticks.count() == 0, 'unsubscribe releases the Listen subscription')
    await close()
    await tick(5)
    assert(priceStore.count() == 0, 'closing the session releases its subscriptions')
}

async function compositionChanges() {
    const {facade} = createDocument()
    const root: Record<string, unknown> = {...facade}
    const mcp = createMcpFacadeServer({name: 'compose', version: '1', object: root, resources: {}, ...silent})
    const {client, close} = await connect(mcp)
    const changes = {tools: 0, resources: 0}
    // read through functions: an assert narrows a plain counter to the literal it just checked
    const toolChanges = () => changes.tools
    const resourceChanges = () => changes.resources
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changes.tools++ })
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { changes.resources++ })

    const unchanged = mcp.control.refresh()
    await tick(5)
    assert(!unchanged.tools && toolChanges() == 0, 'negative control: a refresh without change sends nothing')

    const [, moduleEvents] = listen<string>()
    mcp.control.mount('module', {
        ping: describeMethod(() => 'pong', {description: 'Module ping', args: []}),
        events: moduleEvents,
    })
    await tick(5)
    assert(toolChanges() == 1 && resourceChanges() == 1, 'mount -> tools/list_changed and resources/list_changed')
    const names = (await client.listTools()).tools.map(tool => tool.name)
    assert(names.includes('module.ping'), 'the mounted tool is listed')
    const pong = await client.callTool({name: 'module.ping', arguments: {}}) as CallToolResult
    assert(same(pong.structuredContent, {value: 'pong'}), 'the mounted tool is callable')

    throwsWith(() => mcp.control.mount('view', {}), 'key of the facade itself', 'a mount cannot shadow a facade key')
    throwsWith(() => mcp.control.mount('bad', {constructor: () => 1}), 'forbidden key', 'a refused mount')
    assert(!mcp.tools.list().some(tool => tool.name.startsWith('bad')), 'a refused mount leaves the served composition')

    root['late'] = describeMethod(() => 'late', {description: 'Added after setup', args: []})
    assert(!mcp.tools.list().some(tool => tool.name == 'late'), 'keys added later are not tools until refresh')
    mcp.control.refresh()
    await tick(5)
    assert(toolChanges() == 2 && mcp.tools.list().some(tool => tool.name == 'late'), 'refresh walks again and notifies')

    mcp.control.unmount('module')
    await tick(5)
    assert(toolChanges() == 3 && !(await client.listTools()).tools.some(tool => tool.name == 'module.ping'), 'unmount removes and notifies')
    await close()
}

async function httpSessionsAndAuth() {
    const alice = {
        whoami: describeMethod(function whoami(_args: Record<string, never>, ctx: McpToolContext) { return {principal: ctx.principal} }, {
            description: 'Who am I', input: {type: 'object'}, context: true,
        }),
        admin: {wipe: describeMethod(() => 'wiped', {description: 'Admin only', args: []})},
    }
    const bob = {whoami: alice.whoami}
    const mcp = createMcpFacadeServer({name: 'http', version: '1', object: {}})
    const app = express()
    app.use(express.json())
    let clock = 1_000
    const http = createMcpFacadeHttp({
        app, path: '/mcp', mcp, maxSessions: 2, sessionTtlMs: 60_000, now: () => clock,
        auth: {
            resolveAuth(token) {
                if (token == 'alice-token') return {object: alice, principal: {sub: 'alice'}}
                if (token == 'bob-token') return {object: bob, principal: {sub: 'bob'}}
                throw new Error('unknown token')
            },
        },
    })
    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)

    async function open(token: string) {
        const transport = new StreamableHTTPClientTransport(endpoint, {requestInit: {headers: {authorization: `Bearer ${token}`}}})
        const client = new Client({name: 'http-oracle', version: '1'})
        await client.connect(transport)
        return {client, transport}
    }

    try {
        const unauthorized = await fetch(endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})
        assert(unauthorized.status == 401 && unauthorized.headers.get('www-authenticate') == 'Bearer', 'no token -> 401 Bearer')
        await rejectsWith(() => open('mallory'), 'Unauthorized', 'an unknown token is refused')

        const a = await open('alice-token')
        const b = await open('bob-token')
        const aliceTools = (await a.client.listTools()).tools.map(tool => tool.name)
        const bobTools = (await b.client.listTools()).tools.map(tool => tool.name)
        assert(same(aliceTools, ['whoami', 'admin.wipe']) && same(bobTools, ['whoami']), 'each principal gets its own facade')
        const who = await b.client.callTool({name: 'whoami', arguments: {}}) as CallToolResult
        assert(same(who.structuredContent, {principal: {sub: 'bob'}}), 'the grant principal reaches the tool context')
        assert(http.sessions.count() == 2, 'two sessions')

        await rejectsWith(() => open('alice-token'), 'session limit reached', 'the session limit is an explicit refusal')

        const stolen = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/json', accept: 'application/json, text/event-stream',
                authorization: 'Bearer bob-token', 'mcp-session-id': a.transport.sessionId!, 'mcp-protocol-version': '2025-11-25',
            },
            body: JSON.stringify({jsonrpc: '2.0', id: 9, method: 'tools/list', params: {}}),
        })
        assert(stolen.status == 403, `a session stays bound to its principal: ${stolen.status}`)

        // closing a client transport ends its streams; the session is still registered
        await a.client.close()
        await tick(50)
        assert(http.sessions.count() == 2, 'transport close does not terminate a session')
        // b still holds its standalone SSE stream open, so only a is idle
        clock += 61_000
        http.control.evictIdle()
        await tick(20)
        assert(http.sessions.count() == 1, 'an idle session past its TTL is terminated')

        // a client DELETE terminates; a host terminate() does too
        await b.transport.terminateSession()
        await tick(20)
        assert(http.sessions.count() == 0, 'DELETE terminates the session')
        const c = await open('alice-token')
        const cId = c.transport.sessionId!
        assert(await http.control.terminate(cId), 'terminate() reports the session it ended')
        assert(http.sessions.count() == 0, 'terminate() frees the slot')
        await rejectsWith(() => c.client.listTools(), 'Unknown MCP session', 'a terminated session answers 404')
        await c.client.close().catch(() => {})

        await http.control.dispose()
        const closed = await fetch(endpoint, {method: 'POST', headers: {authorization: 'Bearer alice-token', 'content-type': 'application/json'}, body: '{}'})
        assert(closed.status == 503, 'a disposed endpoint refuses with 503')
    } finally {
        await http.control.dispose()
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
}

async function statelessHttp() {
    const {facade} = createDocument()
    const mcp = createMcpFacadeServer({name: 'stateless', version: '1', object: facade})
    const app = express()
    const http = createMcpFacadeHttp({app, path: '/mcp', mcp, mode: 'stateless', enableJsonResponse: true})
    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
    try {
        const client = new Client({name: 'stateless-oracle', version: '1'})
        await client.connect(new StreamableHTTPClientTransport(endpoint))
        const result = await client.callTool({name: 'doc.add', arguments: {name: 'z'}}) as CallToolResult
        assert(same(result.structuredContent, {items: ['z']}), 'stateless: a server per request, no JSON parser needed before it')
        assert(http.sessions.count() == 0, 'stateless keeps no sessions')
        await client.close()
    } finally {
        await http.control.dispose()
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
}

async function main() {
    await toolsOverSdk()
    await outputLimit()
    await readOnlyMode()
    await ordering()
    await middleware()
    await contextAbortProgress()
    await refusals()
    await openApiParity()
    await listenResources()
    await compositionChanges()
    await httpSessionsAndAuth()
    await statelessHttp()
    console.log(`PASS mcp-facade-server: ${checks} checks`)
}

runOracle(main)
