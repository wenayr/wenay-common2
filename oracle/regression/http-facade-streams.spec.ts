// =====================================================================
//  HTTP facade: streams and noStrict subtrees are never routes.
//
//  A Listen api object, a replay line and a branded `on` are the producer's surface (emit, close,
//  run, onClose, off): routed over HTTP they let any caller past the middleware forge events, close
//  the stream or plant a non-function subscriber. A noStrict subtree is resolved by RPC at call time
//  and is not enumerated. Driven through a real Express server; the delivery probe is proven live by
//  a negative control (an explicit `publish` route that does deliver).
// =====================================================================

import express from 'express'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'

import {listen, listenStore, toSlimListen} from '../../src/Common/events/Listen'
import {isReplayListen, replayListen} from '../../src/Common/events/replay-listen'
import {exposeReplay} from '../../src/Common/events/replay-wire'
import {noStrict} from '../../src/Common/rcp/rpc-dynamic'
import {facadeNodeKind} from '../../src/server/facadeWalk'
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
function throwsWith(run: () => unknown, fragment: string, label: string) {
    try {
        run()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        assert(message.includes(fragment), `${label}: refusal "${message}" does not mention "${fragment}"`)
        return
    }
    throw new Error(`${label}: expected a refusal`)
}

// =====================================================================
// the facade under test
// =====================================================================

function createStreams() {
    let price = 10
    const [emitTick, ticks] = listen<number>()
    const [emitPrice, priceStore] = listenStore<number>({current: () => [price]})
    const [emitJournal, journal] = replayListen<number>({history: 16})
    let dynamicCalls = 0

    const facade = {
        status: () => ({ready: true}),
        plain: {
            // callback-shaped but plain: the classifier keys on Listen identity, not on the signature
            withCallback: function withCallback(value: number, callback: (value: number) => void) { callback(value) },
        },
        publish: (n: number) => emitTick(n),
        events: {ticks, price: priceStore.on, journal},
        wire: exposeReplay(journal),
        dynamic: noStrict({hidden: function hidden() { dynamicCalls++; return 'hidden' }}),
        dynamicFn: noStrict(function dynamicFn() { dynamicCalls++; return 'dynamic' }),
    }
    return {
        facade, ticks, priceStore, journal, emitTick, emitJournal,
        setPrice: function setPrice(next: number) {
            price = next
            emitPrice(next)
        },
        dynamicCalls: () => dynamicCalls,
    }
}

const BASE = '/facade'
const EXPECTED_ROUTES = ['status', 'plain/withCallback', 'publish', 'wire/since', 'wire/keyframe', 'wire/frame']
    .map(path => `${BASE}/${path}`)

// =====================================================================
// tests
// =====================================================================

async function streamsOverExpress() {
    const streams = createStreams()
    const {facade, ticks, priceStore, journal} = streams
    const ticksSeen: number[] = []
    const priceSeen: number[] = []
    const journalSeen: number[] = []
    ticks.on(value => { ticksSeen.push(value) })
    priceStore.on(value => { priceSeen.push(value) })
    journal.on(value => { journalSeen.push(value) })
    streams.emitJournal(1)

    const app = express()
    app.use(express.json())
    const getServer = createHttpFacadeServer({app, object: facade, method: 'get', basePath: BASE})
    const postServer = createHttpFacadeServer({app, object: facade, method: 'post', basePath: BASE})

    assert(same(getServer.routes().map(route => route.route), EXPECTED_ROUTES),
        `GET routes are the plain functions only: ${JSON.stringify(getServer.routes().map(route => route.route))}`)
    assert(same(postServer.routes().map(route => route.route), EXPECTED_ROUTES),
        `POST routes are the plain functions only: ${JSON.stringify(postServer.routes().map(route => route.route))}`)

    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const {port} = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}`

    async function post(path: string, args: unknown[] = []) {
        const response = await fetch(`${url}${BASE}${path}`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(args),
        })
        await response.text()
        return response.status
    }
    async function get(path: string, args: unknown[]) {
        const response = await fetch(`${url}${BASE}${path}?args=${encodeURIComponent(JSON.stringify(args))}`)
        await response.text()
        return response.status
    }

    try {
        // ---------- forged producer calls: no route answers them ----------
        const forged = [
            ['POST events/ticks/emit', await post('/events/ticks/emit', [99])],
            ['POST events/ticks/close', await post('/events/ticks/close')],
            ['POST events/journal/emit', await post('/events/journal/emit', [99])],
            ['POST events/journal/close', await post('/events/journal/close')],
            ['POST wire/line/emit', await post('/wire/line/emit', [{seq: 99, ts: 0, event: [99]}])],
            ['GET events/price?args=[1]', await get('/events/price', [1])],
            ['POST dynamic/hidden', await post('/dynamic/hidden')],
            ['POST dynamicFn', await post('/dynamicFn')],
        ] as const
        for (const [request, status] of forged) assert(status == 404, `${request} is not a route: got ${status}`)

        // ---------- the streams are intact ----------
        assert(ticks.count() == 1 && same(ticksSeen, []), `ticks kept its one subscriber and saw nothing: ${ticks.count()} ${ticksSeen}`)
        assert(journal.head() == 1 && same(journalSeen, [1]), `the journal took no forged event: head ${journal.head()}, seen ${journalSeen}`)
        assert(priceStore.count() == 1, `no subscriber was planted on price: ${priceStore.count()}`)
        assert(streams.dynamicCalls() == 0, 'noStrict members were never called')

        streams.emitTick(5)
        streams.setPrice(11)
        streams.emitJournal(2)
        assert(same(ticksSeen, [5]), `ticks still delivers: ${ticksSeen}`)
        assert(same(priceSeen, [11]), `price still delivers without throwing: ${priceSeen}`)
        assert(journal.head() == 2 && same(journalSeen, [1, 2]), `the journal is still open: head ${journal.head()}, seen ${journalSeen}`)

        // ---------- negative control: an explicit function does deliver over HTTP ----------
        assert(await post('/publish', [7]) == 200, 'the explicit publish route answers')
        assert(same(ticksSeen, [5, 7]), `the delivery probe sees what a real route publishes: ${ticksSeen}`)

        // ---------- the replay wire keeps its catch-up calls ----------
        const sinceResponse = await fetch(`${url}${BASE}/wire/since`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify([0]),
        })
        const since = await sinceResponse.json() as {ok: boolean, value: {seq: number, event: number[]}[]}
        assert(sinceResponse.status == 200 && same(since.value.map(item => item.event), [[1], [2]]),
            `wire/since stays a route: ${JSON.stringify(since)}`)
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }

    // ---------- the OpenAPI document repeats the same walk ----------
    const openApi = createHttpFacadeOpenApi({object: facade, basePath: BASE, methods: ['get', 'post'], info: {title: 'streams', version: '1'}})
    const paths = openApi.document()['paths'] as Record<string, Record<string, unknown>>
    assert(same(Object.keys(paths), EXPECTED_ROUTES), `OpenAPI paths are the routes: ${JSON.stringify(Object.keys(paths))}`)
    assert(Object.values(paths).every(item => same(Object.keys(item), ['get', 'post'])), 'each path documents both mirrors')

    console.log('PASS HTTP facade does not route Listen, replay, branded on or noStrict members (404 over Express)')
    console.log('PASS forged emit/close/on leave every stream intact; an explicit publish route delivers')
    console.log('PASS OpenAPI paths equal the routes')
}

function rootRefusal() {
    const {ticks, priceStore, journal} = createStreams()
    const roots = [
        ['a Listen api', ticks],
        ['a listenStore api', priceStore],
        ['a replay line', journal],
        ['a noStrict object', noStrict({ping: () => 'pong'})],
    ] as const
    for (const [label, object] of roots) {
        throwsWith(() => createHttpFacadeServer({app: express(), object, method: 'post', basePath: '/root'}),
            'not a facade', `HTTP refuses ${label} as the root`)
        throwsWith(() => createHttpFacadeOpenApi({object, basePath: '/root', methods: ['post'], info: {title: 'root', version: '1'}}),
            'not a facade', `OpenAPI refuses ${label} as the root`)
    }

    // negative control: a replay wire facade is a facade, not a stream
    const wire = createHttpFacadeServer({app: express(), object: exposeReplay(journal), method: 'post', basePath: '/wire'})
    assert(same(wire.routes().map(route => route.route), ['/wire/since', '/wire/keyframe', '/wire/frame']),
        `a replay wire root keeps since/keyframe/frame: ${JSON.stringify(wire.routes())}`)

    console.log('PASS a Listen, store, replay or noStrict root is refused; a replay wire root is served')
}

function nodeKinds() {
    const {ticks, priceStore, journal} = createStreams()

    // noStrict is checked first: a dynamic Proxy is never enumerated
    let trapRan = false
    function trap(): never {
        trapRan = true
        throw new Error('the dynamic Proxy was enumerated')
    }
    const trapped = noStrict(new Proxy({}, {ownKeys: trap, getOwnPropertyDescriptor: trap, get: trap, has: trap}))
    assert(facadeNodeKind(trapped) == 'dynamic' && !trapRan, 'a noStrict Proxy is dynamic without running a trap')
    const walked = createHttpFacadeServer({app: express(), object: {ok: () => 1, dyn: trapped}, method: 'post', basePath: '/trap'})
    assert(same(walked.routes().map(route => route.route), ['/trap/ok']) && !trapRan,
        'the walk skips a noStrict Proxy without enumerating it')

    // a spread copy loses the replay brand but keeps the Listen shape
    const copy = {...journal}
    assert(!isReplayListen(copy) && facadeNodeKind(copy) == 'listen', 'a spread replay api is still a listen node')

    assert(facadeNodeKind(ticks) == 'listen', 'a Listen api is a listen node')
    assert(facadeNodeKind(priceStore) == 'listen', 'a listenStore api is a listen node')
    assert(facadeNodeKind(journal) == 'listen', 'a replay line is a listen node')
    assert(facadeNodeKind(ticks.on) == 'on' && facadeNodeKind(priceStore.on) == 'on' && facadeNodeKind(journal.on) == 'on',
        'a branded on is an on node')

    // the structural rule: all 8 Listen-core keys as functions, as RPC resolveTransform
    const shaped = {emit() {}, on() {}, off() {}, onClose() {}, run() {}, isRunning() {}, close() {}, count() {}}
    assert(facadeNodeKind(shaped) == 'listen', 'an object with every Listen-core function is a listen node')
    const withoutOnClose = {emit() {}, on() {}, off() {}, run() {}, isRunning() {}, close() {}, count() {}}
    assert(facadeNodeKind(withoutOnClose) == undefined, 'one Listen-core key missing: not a listen node')

    // documented limitation: a slim listen has no registered on and no Listen core
    assert(facadeNodeKind(toSlimListen(ticks)) == undefined, 'toSlimListen is not recognised')
    assert(facadeNodeKind(function plain() {}) == undefined, 'a plain function is not a stream')
    assert(facadeNodeKind(exposeReplay(journal)) == undefined, 'a replay wire facade is not a stream')
    for (const primitive of [null, undefined, 0, 'on', true]) {
        assert(facadeNodeKind(primitive) == undefined, `a primitive is no node: ${String(primitive)}`)
    }

    console.log('PASS facadeNodeKind: noStrict first, Listen by brand or shape, branded on; slim and plain are not streams')
}

async function main() {
    nodeKinds()
    await streamsOverExpress()
    rootRefusal()
    console.log(`PASS ${checks} checks`)
}

runOracle(main)
