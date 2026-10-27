// =====================================================================
//  HTTP facade: a noStrict node is one dynamic route resolved per request.
//
//  RPC resolves a noStrict subtree at call time; HTTP registers `<base>/P/*rest` for the node at P
//  and resolves the segments with the same rule (rpc-member.ts: `in`, so a proxy's has trap decides;
//  builtins inherited from Object/Array/Map/Date never resolve unless own). Keys added after setup
//  work at once; streams below a key stay unreachable. Driven through a real Express server.
// =====================================================================

import express from 'express'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'

import {listen} from '../../src/Common/events/Listen'
import {noStrict} from '../../src/Common/rcp/rpc-dynamic'
import {unpackResult} from '../../src/Common/rcp/rpc-walk'
import {createHttpFacadeOpenApi, createHttpFacadeServer} from '../../src/server/http-index'
import {runOracle} from '../run-oracle'

let checks = 0
function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
    checks++
}
function same(a: unknown, b: unknown) {
    return JSON.stringify(a) == JSON.stringify(b)
}

class Account {
    items: string[] = []
    add(item: string) { this.items.push(item); return this.items.length }
}

const BASE = '/api'

async function main() {
    const alice = new Account()
    const accounts: Record<string, unknown> = {alice, 'a/b c': {who: () => 'slash key'}}
    const queue = [1, 2, 3]
    const [emitTick, ticks] = listen<number>()
    const ticksSeen: number[] = []
    ticks.on(value => { ticksSeen.push(value) })
    let gatedGets = 0
    const gated = new Proxy({}, {
        has: (_target, key) => key == 'bob',
        get: (_target, key) => { gatedGets++; return key == 'bob' ? {ping: () => 'pong'} : undefined },
    })
    const facade = {
        status: () => 'ok',
        accounts: noStrict(accounts),
        queue: noStrict(queue),
        feeds: noStrict({ticks}),
        gated: noStrict(gated),
        clock: noStrict({at: (when: Date) => when.getUTCFullYear(), boom: () => { throw new Error('boom') }}),
        dynamicFn: noStrict(function dynamicFn() { return 'never routed' }),
    }

    const app = express()
    app.use(express.json())
    const post = createHttpFacadeServer({app, object: facade, method: 'post', basePath: BASE, limits: {maxPathLen: 6}})
    const get = createHttpFacadeServer({app, object: facade, method: 'get', basePath: BASE, limits: {maxPathLen: 6}})

    const routes = post.routes().map(route => route.route)
    assert(same(routes, [`${BASE}/status`, `${BASE}/accounts/*rest`, `${BASE}/queue/*rest`, `${BASE}/feeds/*rest`,
        `${BASE}/gated/*rest`, `${BASE}/clock/*rest`]), `one dynamic route per noStrict object node: ${JSON.stringify(routes)}`)
    assert(post.routes().filter(route => route.dynamic).length == 5 && get.routes().length == 6, 'routes() marks dynamic routes')

    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${BASE}`
    async function call(path: string, args: unknown[] = []) {
        const response = await fetch(`${url}${path}`, {
            method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({args}),
        })
        const body = await response.json().catch(() => null) as any
        return {status: response.status, body}
    }

    try {
        // ---------- resolution per request ----------
        const added = await call('/accounts/alice/add', ['milk'])
        assert(added.status == 200 && added.body.value == 1 && same(alice.items, ['milk']), `a method below a key, this = its owner: ${JSON.stringify(added)}`)
        accounts['bob'] = new Account()
        const late = await call('/accounts/bob/add', ['bread'])
        assert(late.status == 200 && late.body.value == 1, `a key added after setup works at once: ${JSON.stringify(late)}`)
        const slash = await call('/accounts/a%2Fb%20c/who')
        assert(slash.status == 200 && slash.body.value == 'slash key', `a percent-encoded key is one segment: ${JSON.stringify(slash)}`)
        const pong = await call('/gated/bob/ping')
        assert(pong.status == 200 && pong.body.value == 'pong', 'a member answered by the has trap works')
        const getsBefore = gatedGets
        const denied = await call('/gated/eve/ping')
        assert(denied.status == 404 && gatedGets == getsBefore, `a key the has trap denies is 404, its get never runs: ${denied.status}`)
        assert((await call('/accounts/carol/add')).status == 404, 'an unknown key is 404')
        const longKey = 'k'.repeat(5000)
        const echoed = await call(`/accounts/${longKey}/add`)
        assert(echoed.status == 404 && String(echoed.body.error.message).length < 400,
            `a 404 does not echo a huge key back: ${String(echoed.body?.error?.message).length} chars`)
        assert((await call('/accounts/alice/items')).status == 404, 'a data member is not callable: 404')

        // ---------- builtins and streams stay unreachable ----------
        assert((await call('/accounts/hasOwnProperty', ['alice'])).status == 404, 'an inherited Object method is 404')
        assert((await call('/accounts/alice/toString')).status == 404, 'toString below a key is 404')
        assert((await call('/queue/push', [4])).status == 404 && same(queue, [1, 2, 3]), "an array's push is 404, the array unchanged")
        assert((await call('/feeds/ticks/emit', [7])).status == 404, 'a stream below a key is never a route')
        assert((await call('/feeds/ticks/close')).status == 404 && ticks.count() == 1, 'close is 404, the subscriber stays')
        emitTick(1)
        assert(same(ticksSeen, [1]), 'nothing forged reached the stream; it still delivers')

        // ---------- request shape ----------
        assert((await call('/accounts/alice//add')).status == 400, 'an empty segment is 400')
        assert((await call('/accounts/constructor/name')).status == 400, 'a forbidden segment is 400')
        assert((await call('/accounts/x/y/z/w/v/u')).status == 413, 'a path past maxPathLen is 413')
        assert((await call('/accounts/x/y/z/w/v')).status == 404, 'a path at maxPathLen is resolved (absent: 404)')
        assert((await call('/accounts')).status == 404, 'the node itself is not a call target')

        // ---------- codec, errors, GET mirror ----------
        const year = await call('/clock/at', [{$_d: Date.UTC(2026, 0, 1)}])
        assert(year.status == 200 && year.body.value == 2026, `the RPC codec decodes a Date argument: ${JSON.stringify(year)}`)
        const boom = await call('/clock/boom')
        assert(boom.status == 500 && boom.body.error.message == 'boom' && boom.body.error.stack == undefined, 'a throw is 500 without a stack')
        const viaGet = await fetch(`${url}/accounts/alice/add?args=${encodeURIComponent(JSON.stringify(['egg']))}`)
        const viaGetBody = await viaGet.json() as any
        assert(viaGet.status == 200 && unpackResult(viaGetBody.value) == 2, 'the GET mirror resolves the same route')
        assert((await call('/dynamicFn')).status == 404, 'a noStrict function is not a container: no route')
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
    }

    // ---------- OpenAPI: one-segment parameters, which Swagger UI sends unescaped ----------
    // a single {path} parameter cannot carry "/": Swagger percent-encodes it into one key
    const document = createHttpFacadeOpenApi({object: facade, basePath: BASE, methods: ['post'], info: {title: 't', version: '1'}})
        .document() as {paths: Record<string, any>}
    const documented = Object.keys(document.paths)
    assert(documented.includes(`${BASE}/accounts/{member}`) && documented.includes(`${BASE}/accounts/{key}/{member}`)
        && !documented.some(path => path.includes('{path}')), `OpenAPI documents P/{member} and P/{key}/{member}: ${documented}`)
    for (const path of [`${BASE}/accounts/{member}`, `${BASE}/accounts/{key}/{member}`]) {
        const parameters = document.paths[path].post.parameters ?? []
        const expected = path.endsWith('{key}/{member}') ? ['key', 'member'] : ['member']
        assert(same(parameters.filter((p: any) => p.in == 'path').map((p: any) => p.name), expected)
            && parameters.every((p: any) => p.in != 'path' || p.required == true), `${path}: required one-segment path parameters`)
    }
    const operationIds = documented.flatMap(path => Object.values(document.paths[path]).map((operation: any) => operation.operationId))
    assert(new Set(operationIds).size == operationIds.length, 'operation ids stay unique')

    // ---------- a node too deep for maxPathLen is refused at setup (its route could only answer 413) ----------
    let tooDeep = ''
    try {
        createHttpFacadeServer({app: express(), object: {a: {b: noStrict({})}}, method: 'post', basePath: '/d', limits: {maxPathLen: 2}})
    } catch (error) { tooDeep = String(error) }
    assert(tooDeep.includes('maxPathLen'), `a dynamic node at maxPathLen is refused at setup: ${tooDeep}`)

    // ---------- the root is still refused ----------
    let refused = ''
    try { createHttpFacadeServer({app: express(), object: noStrict({}), method: 'post', basePath: '/r'}) }
    catch (error) { refused = String(error) }
    assert(refused.includes('not a facade'), 'a noStrict root is still refused')

    await bytesWalkAndSlash()
    overlappingFacades()
    console.log(`PASS ${checks} checks`)
}

// ---------- bytes hold no members; resolution never enumerates; a trailing slash as on a static route ----------
async function bytesWalkAndSlash() {
    const buf = Buffer.from('abcd')
    let enumerated = 0
    // a node passed through on the way: listing its keys would cost O(size) per request (a big array, an index)
    const index = new Proxy({find: () => 'found'}, {
        ownKeys(target) { enumerated++; return Reflect.ownKeys(target) },
    })
    const facade = {data: noStrict({buf, bytes: new Uint8Array(4), index, ping: () => 'pong'})}
    const app = express()
    app.use(express.json())
    createHttpFacadeServer({app, object: facade, method: 'post', basePath: BASE})
    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${BASE}`
    async function status(path: string, args: unknown[] = []) {
        const response = await fetch(`${url}${path}`, {
            method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({args}),
        })
        return response.status
    }
    try {
        // Buffer.prototype is the runtime's, but no sample of rpc-member.ts covers it: write/fill/swap16 mutate
        const writes = [await status('/data/buf/write', ['ZZ']), await status('/data/buf/fill', [120]), await status('/data/buf/swap16')]
        assert(same(writes, [404, 404, 404]) && buf.toString() == 'abcd', `bytes hold no members: ${writes}, ${buf.toString()}`)
        assert(await status('/data/bytes/fill', [1]) == 404, 'a typed array holds no members either')
        assert(await status('/data/index/find') == 200 && enumerated == 0, `resolution never enumerates a node: ${enumerated} ownKeys`)
        assert(await status('/data/ping/') == 200, 'a trailing slash is taken as on a static route')
        assert(await status('/data/ping//') == 400, 'two trailing slashes are still an empty segment')
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
}

// ---------- a dynamic route claims its subtree on the app: a later or earlier route below it is refused ----------
function overlappingFacades() {
    function refusal(register: () => unknown) {
        try { register(); return '' } catch (error) { return String(error) }
    }
    const app = express()
    createHttpFacadeServer({app, object: {x: noStrict({})}, method: 'post', basePath: '/o'})
    assert(refusal(() => createHttpFacadeServer({app, object: {y: () => 1}, method: 'post', basePath: '/o/x'})).includes('overlaps'),
        'a static route below a registered dynamic route is refused (it would never answer)')
    const reverse = express()
    createHttpFacadeServer({app: reverse, object: {z: () => 1}, method: 'post', basePath: '/o/x'})
    assert(refusal(() => createHttpFacadeServer({app: reverse, object: {x: noStrict({})}, method: 'post', basePath: '/o'})).includes('overlaps'),
        'a dynamic route over a registered route is refused (it would shadow part of the node)')
    // negative controls: another method, a sibling prefix
    assert(refusal(() => createHttpFacadeServer({app, object: {y: () => 1}, method: 'get', basePath: '/o/x'})) == ''
        && refusal(() => createHttpFacadeServer({app, object: {y: () => 1}, method: 'post', basePath: '/o/xy'})) == '',
        'another method or a sibling prefix does not overlap')
}

runOracle(main)
