// Reserved-key contract of the RPC codec.
//
// The walker encodes non-JSON types as SINGLE-KEY marker objects, so an application value of
// that exact shape is read back as a library value. This spec pins down three things: which
// values still collide (the residual contract a consumer must respect), which no longer do
// (recognition is now as narrow as the payload each serializer emits), and that the bytes
// going out did not move — the fix is decode-side and encode-side reporting only, so no peer,
// old or new, sees a different wire and no capability bit was needed.

import * as assert from 'node:assert/strict'
import {
    pack, packResult, unpack, unpackResult,
    RESERVED_MARKER_KEYS, reservedMarkerKeyOf, ROW_MARKER,
} from './rpc-walk'
import {createRowDecoder, createRowEncoder, createShapeRegistry} from './rpc-shape'
import {resolveLimits} from './rpc-limits'
import {createIdPool} from '../id-pool'
import {createRpcClient} from './rpc-client'
import {createRpcServer} from './rpc-server'
import {createRpcServerAuto} from './rpc-server-auto'
import {type RpcOpt} from './rpc-caps'
import {type SocketTmpl} from './rpc-protocol'
import {listen as createListenPair} from '../events/Listen'
import type {DeepSocketListen} from './listen-deep'

const lim = resolveLimits()
const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

// The transport does what a real one does: JSON in, JSON out.
const overWire = (v: any) => JSON.parse(JSON.stringify(v))

/** One value through the RESULT walker and back, exactly as a Pkt.RESP would carry it. */
function resultTrip(value: any, rows = false) {
    const encoder = rows ? createRowEncoder(createShapeRegistry()) : undefined
    const decoder = rows ? createRowDecoder(lim) : undefined
    return unpackResult(overWire(packResult(value, encoder)), lim, decoder)
}

/** One value through the ARGUMENT walker and back, exactly as a Pkt.CALL would carry it. */
function argTrip(value: any) {
    const ids: number[] = []
    const packed = overWire(pack([value], createIdPool(), new Map<number, Function>(), ids))
    return unpack(packed, function sendNothing() {}, function endNothing() {}, lim)[0]
}

/** What a value came back as, in one comparable word. */
function tag(v: any) {
    if (v instanceof Date) return Number.isNaN(v.valueOf()) ? 'Date(Invalid)' : `Date(${v.valueOf()})`
    if (v instanceof Map) return `Map(${v.size})`
    if (v instanceof Set) return `Set(${v.size})`
    if (v instanceof RegExp) return `RegExp(/${v.source}/${v.flags})`
    if (typeof v == 'bigint') return `BigInt(${v})`
    if (typeof v == 'function') return 'function'
    if (Array.isArray(v)) return `Array(${JSON.stringify(v)})`
    if (v != null && typeof v == 'object') return `object(${JSON.stringify(v)})`
    return `${typeof v}(${JSON.stringify(v)})`
}

function attempt(run: () => any) {
    try { return tag(run()) }
    catch (error: any) { return `throws ${error?.name}` }
}

function createLoopback(): [SocketTmpl, SocketTmpl] {
    const a: Record<string, ((data: any) => void)[]> = {}
    const b: Record<string, ((data: any) => void)[]> = {}
    function make(mine: typeof a, theirs: typeof a): SocketTmpl {
        return {
            on(event, cb) { (mine[event] ??= []).push(cb) },
            emit(event, data) {
                const wire = data === undefined ? undefined : overWire(data)
                for (const cb of theirs[event] ?? []) queueMicrotask(function deliver() { cb(wire) })
            },
        }
    }
    return [make(a, b), make(b, a)]
}

// Values the SERVER originates. A result or a tick must carry a colliding value that did NOT
// travel as an argument first — otherwise the argument walker would have already turned it
// into a Date and the return leg would prove nothing.
const serverValues: Record<string, any> = {
    date: {$_d: 0},
    map: {$_m: []},
    bigintText: {$_b: 'hello'},
    badRegExp: {$_r: {source: '(', flags: ''}},
    twoKeys: {$_d: 5, name: 'x'},
    nestedDate: {at: {$_d: 3}},
    table: {$_t: [0, [[1], [2], [3], [4]], ['a']]},
}

// What the SERVER saw, computed on the server so the answer cannot be produced by the
// client-side decoder: the tag travels back as a plain string.
const inspectorObject = {
    kind(value: any) { return tag(value) },
    kinds(...values: any[]) { return values.map(tag) },
    give(name: string) { return serverValues[name] },
    feed(name: string, times: number, cb: (v: any) => void) {
        for (let i = 0; i < times; i++) cb(serverValues[name])
        return 'fed'
    },
}

function connectInspector(opt?: RpcOpt) {
    const [clientSocket, serverSocket] = createLoopback()
    const client = createRpcClient<typeof inspectorObject>({socket: clientSocket, socketKey: 'rpc', opt})
    createRpcServer({socket: serverSocket, object: inspectorObject, socketKey: 'rpc', opt})
    return client
}

// ===================================================================
// 1. The residual contract: the SMALLEST application value that still collides
// ===================================================================
// One per marker, and each is minimal in the two ways that matter — the payload is the
// smallest one its recognizer accepts, and the object carries exactly one key. These are the
// values a consumer must not produce; nothing smaller or looser is taken any more.

async function testSmallestCollidingValuePerMarker() {
    assert.equal(tag(resultTrip({$_d: 0})), 'Date(0)')
    assert.equal(tag(resultTrip({$_m: []})), 'Map(0)')
    assert.equal(tag(resultTrip({$_s: []})), 'Set(0)')
    assert.equal(tag(resultTrip({$_r: {source: '', flags: ''}})), 'RegExp(/(?:)/)')
    assert.equal(tag(resultTrip({$_b: '0'})), 'BigInt(0)')
    // $_t needs the codec on BOTH ends, i.e. a negotiated Caps.ROWS; the smallest table is
    // an empty one, and an application object of that shape comes back as an empty ARRAY.
    assert.equal(tag(resultTrip({[ROW_MARKER]: [0, [], []]}, true)), 'Array([])')
    // $_f is the argument direction only, and the damage is worse than a wrong value: the
    // application object becomes a live callback handle bound to someone else's id.
    assert.equal(tag(argTrip({$_f: 0})), 'function')
    // A SECOND key defuses every one of them — that is the whole escape hatch a consumer has.
    assert.equal(tag(resultTrip({$_d: 0, safe: 1})), 'object({"$_d":0,"safe":1})')
    assert.equal(tag(argTrip({$_f: 0, safe: 1})), 'object({"$_f":0,"safe":1})')
    assert.equal(tag(resultTrip({[ROW_MARKER]: [0, [], []], safe: 1}, true)),
        'object({"$_t":[0,[],[]],"safe":1})')
    // Nesting does NOT: the reserved object is the inner one and it is still reserved there.
    // The rule is about the OBJECT, not about its position, and that is the trap worth pinning.
    const nested = resultTrip({value: {$_d: 0}})
    assert.equal(nested.value instanceof Date, true)
    // Depth does not matter either — the walker reaches every level.
    const deep = resultTrip([{list: [{$_b: '7'}]}])
    assert.equal(tag(deep[0].list[0]), 'BigInt(7)')
}

// ===================================================================
// 2. Recognition is now as narrow as the payload each serializer emits
// ===================================================================
// Every value below used to be taken. Three of them threw straight out of the decoder and
// rejected a whole response or dropped a whole tick; two were silently wrong. None of them can
// be produced by any version of this encoder, which is why narrowing needs no capability bit.

async function testDeclinedPayloadsStayObjects() {
    const declined: [string, any][] = [
        ['$_d non-number (was Date(NaN))', {$_d: 'x'}],
        ['$_d object (was Date(NaN))', {$_d: {when: 1}}],
        ['$_m non-array (was TypeError)', {$_m: 5}],
        ['$_m non-pair entries (was a bogus Map)', {$_m: [[1]]}],
        ['$_s non-array (was TypeError)', {$_s: 5}],
        ['$_r non-object (was /(?:)/)', {$_r: 5}],
        ['$_r missing flags (was /a/undefined)', {$_r: {source: 'a'}}],
        ['$_r unparseable (was SyntaxError)', {$_r: {source: '(', flags: ''}}],
        ['$_b non-digits (was SyntaxError)', {$_b: 'hello'}],
        ['$_b empty (was SyntaxError)', {$_b: ''}],
        ['$_b non-string (was BigInt coercion)', {$_b: 1}],
    ]
    for (const [label, value] of declined) {
        assert.equal(attempt(() => resultTrip(value)), `object(${JSON.stringify(value)})`, `result: ${label}`)
        assert.equal(attempt(() => argTrip(value)), `object(${JSON.stringify(value)})`, `arg: ${label}`)
    }
    // The row payload is held to the same rule: a structure that is not a table is not one,
    // and the walker recurses into the object instead of rejecting the packet.
    const notTables: any[] = [
        {[ROW_MARKER]: 5},
        {[ROW_MARKER]: [0, []]},
        {[ROW_MARKER]: [0, [], 'x']},
        {[ROW_MARKER]: [-1, [], []]},
        {[ROW_MARKER]: ['0', [], []]},
        {[ROW_MARKER]: [0, {}, []]},
    ]
    for (const value of notTables) {
        assert.equal(attempt(() => resultTrip(value, true)), `object(${JSON.stringify(value)})`)
    }
}

async function testConformingValuesUnchanged() {
    const when = new Date(1_700_000_000_000)
    assert.equal(tag(resultTrip(when)), `Date(${when.valueOf()})`)
    assert.equal(tag(argTrip(when)), `Date(${when.valueOf()})`)
    const map = new Map<any, any>([['a', 1], ['b', new Date(123)]])
    const backMap = resultTrip(map)
    assert.equal(backMap instanceof Map, true)
    assert.equal(backMap.get('b') instanceof Date, true)
    const set = new Set<any>([1, new Date(5), 7n])
    const backSet = resultTrip(set)
    assert.equal(backSet instanceof Set, true)
    assert.equal([...backSet].map(tag).join(','), 'number(1),Date(5),BigInt(7)')
    assert.equal(tag(resultTrip(/ab+c/gi)), 'RegExp(/ab+c/gi)')
    assert.equal(tag(resultTrip(-123456789012345678901234567890n)), 'BigInt(-123456789012345678901234567890)')
    // Nested and mixed, the way a real payload arrives.
    const rich = resultTrip({when, tags: map, n: 7, list: [new Date(1), 2n]})
    assert.equal(
        [rich.when, rich.tags, rich.n, rich.list[0], rich.list[1]].map(tag).join(','),
        `Date(${when.valueOf()}),Map(2),number(7),Date(1),BigInt(2)`)
}

// The one behaviour this narrowing deliberately CHANGES, and it changes it towards the truth:
// JSON.stringify writes null for the NaN of an Invalid Date, so {"$_d": null} is this
// encoder's own output for one. It used to be restored as the epoch — a real, silent, shipped
// data corruption of every Invalid Date that ever crossed the wire.
async function testInvalidDateSurvivesAsInvalid() {
    assert.equal(JSON.stringify(packResult(new Date(NaN))), '{"$_d":null}')
    const back = resultTrip(new Date(NaN))
    assert.equal(back instanceof Date, true)
    assert.equal(Number.isNaN(back.valueOf()), true)
    assert.equal(Number.isNaN(argTrip(new Date(NaN)).valueOf()), true)
}

// ===================================================================
// 3. The wire did not move
// ===================================================================
// The alternative to narrowing was ESCAPING a colliding object on encode, which changes the
// bytes and therefore needs a capability bit — and against a peer without the bit it replaces
// one corruption with another. Nothing here escapes anything, so this is the whole
// backward-compatibility argument, stated as bytes: what the encoder emits is byte-identical,
// for library values and for colliding application values alike.

async function testEncodedBytesAreUnchanged() {
    assert.equal(JSON.stringify(packResult(new Date(5))), '{"$_d":5}')
    assert.equal(JSON.stringify(packResult(new Map([['a', 1]]))), '{"$_m":[["a",1]]}')
    assert.equal(JSON.stringify(packResult(new Set([1, 2]))), '{"$_s":[1,2]}')
    assert.equal(JSON.stringify(packResult(/a/g)), '{"$_r":{"source":"a","flags":"g"}}')
    assert.equal(JSON.stringify(packResult(7n)), '{"$_b":"7"}')
    // A colliding application value is passed through untouched, exactly as before — it is
    // NOT escaped, NOT renamed and NOT dropped. An old peer therefore reads the same bytes it
    // always read, and a new peer reads the same value it always read.
    assert.equal(JSON.stringify(packResult({$_d: 5})), '{"$_d":5}')
    assert.equal(JSON.stringify(packResult({$_m: 5})), '{"$_m":5}')
    assert.equal(JSON.stringify(packResult({$_b: 'hello'})), '{"$_b":"hello"}')
    assert.equal(JSON.stringify(packResult({[ROW_MARKER]: [0, [], []]})), '{"$_t":[0,[],[]]}')
    const ids: number[] = []
    assert.equal(
        JSON.stringify(pack([{$_f: 3}, new Date(1)], createIdPool(), new Map<number, Function>(), ids)),
        '[{"$_f":3},{"$_d":1}]')
    assert.deepEqual(ids, [])
}

// ===================================================================
// 4. The hazard is symmetric — arguments, results and callback ticks
// ===================================================================

async function testArgumentDirection() {
    const client = connectInspector()
    await delay(5)
    // Still collides, on purpose and by contract.
    assert.equal(await client.func.kind({$_d: 0}), 'Date(0)')
    assert.equal(await client.func.kind({$_b: '9'}), 'BigInt(9)')
    // A callback handle forged out of application data: the server really receives a function.
    assert.equal(await client.func.kind({$_f: 0}), 'function')
    // No longer collides, and no longer kills the call — this used to reject with a TypeError
    // raised inside the server's own unpack.
    assert.equal(await client.func.kind({$_m: 5}), 'object({"$_m":5})')
    assert.equal(await client.func.kind({$_b: 'hello'}), 'object({"$_b":"hello"})')
    assert.equal(await client.func.kind({$_r: 5}), 'object({"$_r":5})')
    // Several arguments at once, and the connection is still healthy afterwards.
    assert.deepEqual(await client.func.kinds({$_d: 1}, {$_s: 5}, 'plain'),
        ['Date(1)', 'object({"$_s":5})', 'string("plain")'])
}

async function testResultDirection() {
    const client = connectInspector()
    await delay(5)
    assert.equal(tag(await client.func.give('date')), 'Date(0)')
    assert.equal(tag(await client.func.give('map')), 'Map(0)')
    // Used to reject THIS request with a SyntaxError raised inside the client's own decoder.
    assert.equal(tag(await client.func.give('bigintText')), 'object({"$_b":"hello"})')
    assert.equal(tag(await client.func.give('badRegExp')), 'object({"$_r":{"source":"(","flags":""}})')
    assert.equal(tag(await client.func.give('twoKeys')), 'object({"$_d":5,"name":"x"})')
}

async function testCallbackDirection() {
    const client = connectInspector()
    await delay(5)
    const seen: any[] = []
    // Six ticks: the first goes as a plain Pkt.CB, and from the fifth repetition of the shape
    // the compact Pkt.SHAPE/Pkt.CBV path takes over. That path rebuilds the tick object from
    // the DECLARED KEYS and only decodes its values, so the top-level object is never offered
    // to the marker recognizer at all — a colliding tick arrives as a Date on the plain path
    // and as the raw object on the compact one. Pinned, not fixed: making the compact path
    // agree would mean making it collide too.
    assert.equal(await client.func.feed('date', 6, function collect(v: any) { seen.push(v) }), 'fed')
    await delay(10)
    assert.equal(seen.length, 6)
    assert.equal(tag(seen[0]), 'Date(0)')
    assert.equal(tag(seen[5]), 'object({"$_d":0})')
    // A declined payload reaches the callback intact instead of dropping the packet, which is
    // what used to happen: a stream has no error channel, so the tick simply vanished.
    const dropped: any[] = []
    assert.equal(await client.func.feed('bigintText', 1, function collect(v: any) { dropped.push(v) }), 'fed')
    await delay(10)
    assert.deepEqual(dropped.map(tag), ['object({"$_b":"hello"})'])
    // And a nested one, where both paths decode the VALUE and agree.
    const nested: any[] = []
    assert.equal(await client.func.feed('nestedDate', 6, function collect(v: any) { nested.push(v) }), 'fed')
    await delay(10)
    assert.equal(nested.length, 6)
    assert.equal(nested.every((v: any) => v.at instanceof Date), true)
}

// $_t is the one marker that is NOT symmetric, and the asymmetry is worth pinning because it
// is easy to lose: the argument walker is never handed a row codec, so a table-shaped object
// travelling client→server is always an ordinary object, while the same object in a result or
// a tick is a table for a peer that negotiated Caps.ROWS and an ordinary object for one that
// did not. Three different answers for one value, decided entirely by direction and bit.
async function testRowMarkerDirectionsAndCap() {
    const negotiated = connectInspector()
    await delay(5)
    assert.equal(tag(await negotiated.func.give('table')), 'Array([{"a":1},{"a":2},{"a":3},{"a":4}])')
    assert.equal(await negotiated.func.kind(serverValues['table']), 'object({"$_t":[0,[[1],[2],[3],[4]],["a"]]})')

    const withoutRows = connectInspector({compactRows: false})
    await delay(5)
    assert.equal(tag(await withoutRows.func.give('table')), 'object({"$_t":[0,[[1],[2],[3],[4]],["a"]]})')
    assert.equal(await withoutRows.func.kind(serverValues['table']), 'object({"$_t":[0,[[1],[2],[3],[4]],["a"]]})')

    // A real table still works, on both directions of the same connection.
    const bars = [{a: 1}, {a: 2}, {a: 3}, {a: 4}]
    assert.deepEqual(await negotiated.func.kind(bars), 'Array([{"a":1},{"a":2},{"a":3},{"a":4}])')
}

// ===================================================================
// 5. Encode-side detection — the half of the problem that IS decidable
// ===================================================================
// A decoder cannot tell a marker from an application value that looks like one; an encoder
// always can, because a real Date/Map/Set/RegExp is taken by identity before the key test.
// So the report lives on the way OUT, costs one register test when nobody listens, and turns
// silent corruption into something a developer can find.

async function testEncodeSideDetection() {
    function collect(value: any, rows?: any) {
        const found: string[] = []
        packResult(value, rows, function report(key: string) { found.push(key) })
        return found
    }
    assert.deepEqual(collect({$_d: 0}), ['$_d'])
    assert.deepEqual(collect({$_b: 'hello'}), ['$_b'])
    // Reported wherever it sits — nested, inside an array, inside a row of a real table.
    assert.deepEqual(collect({a: {$_d: 0}, b: [{$_m: []}, 1]}), ['$_d', '$_m'])
    assert.deepEqual(collect([{$_s: []}, {$_r: {source: 'a', flags: ''}}]), ['$_s', '$_r'])
    const encoder = createRowEncoder(createShapeRegistry())
    assert.deepEqual(collect([{v: {$_d: 1}}, {v: {$_d: 2}}, {v: {$_d: 3}}, {v: {$_d: 4}}], encoder),
        ['$_d', '$_d', '$_d', '$_d'])
    // Map/Set values are walked by a SEPARATE recursion (deepSerialize), and a collision there
    // corrupts on the far side exactly like one at the top level — so the reporter goes with it.
    assert.deepEqual(collect(new Map<any, any>([['k', {$_d: 1}]])), ['$_d'])
    assert.deepEqual(collect(new Map<any, any>([[{$_b: '1'}, 'v']])), ['$_b'])
    assert.deepEqual(collect(new Set<any>([{$_s: []}, new Map<any, any>([['k', {$_m: []}]])])), ['$_s', '$_m'])
    // and the value really does collide, which is what makes the report worth having
    const mapBack = resultTrip(new Map<any, any>([['k', {$_d: 1}]]))
    assert.equal(mapBack.get('k') instanceof Date, true)
    // $_t is not in the walker's marker set, so it needs its own sighting — and gets one.
    assert.deepEqual(collect({[ROW_MARKER]: [0, [], []]}), [ROW_MARKER])
    assert.deepEqual(collect({wrap: {[ROW_MARKER]: 5}}), [ROW_MARKER])
    // No false positives: real library values, multi-key objects and arrays are silent.
    assert.deepEqual(collect({when: new Date(1), tags: new Map(), r: /a/, b: 7n, s: new Set()}), [])
    assert.deepEqual(collect({$_d: 0, name: 'x'}), [])
    assert.deepEqual(collect([1, 'two', null, {a: 1}]), [])
    // The argument packer reports too, and keeps handing out real callback ids beside it.
    const ids: number[] = []
    const found: string[] = []
    pack([{$_f: 3}, function realCallback() {}], createIdPool(), new Map<number, Function>(), ids,
        function report(key: string) { found.push(key) })
    assert.deepEqual(found, ['$_f'])
    assert.equal(ids.length, 1)
}

// The seam an application actually reaches: `debug` on the server factory, `api.log(true)` on
// the client. Both directions report, and neither says anything while debug is off.
async function testDebugFlagReportsOnBothFactories() {
    const lines: string[] = []
    const realLog = console.log
    console.log = function captureLog(...parts: any[]) { lines.push(parts.map(String).join(' ')) }
    try {
        const [clientSocket, serverSocket] = createLoopback()
        const client = createRpcClient<typeof inspectorObject>({socket: clientSocket, socketKey: 'rpc'})
        createRpcServer({socket: serverSocket, object: inspectorObject, socketKey: 'rpc', debug: true})
        await delay(5)
        const quietBefore = lines.filter(line => line.startsWith('[RPC OUT] reserved key')).length
        await client.func.kind({$_d: 0})
        const clientQuiet = lines.filter(line => line.startsWith('[RPC OUT] reserved key')).length
        assert.equal(clientQuiet, quietBefore, 'client says nothing while its own debug is off')
        await client.func.give('date')
        const afterServer = lines.filter(line => line.startsWith('[RPC OUT] reserved key $_d'))
        assert.equal(afterServer.length, 1, 'the server reported its own outgoing collision')
        client.api.log(true)
        await client.func.kind({$_b: '9'})
        const afterClient = lines.filter(line => line.startsWith('[RPC OUT] reserved key $_b'))
        assert.equal(afterClient.length, 1, 'the client reported its own outgoing collision')
        client.api.log(false)
        await client.func.kind({$_s: []})
        assert.equal(lines.filter(line => line.startsWith('[RPC OUT] reserved key $_s')).length, 0)
    } finally {
        console.log = realLog
    }
}

async function testReservedKeyContractHelpers() {
    assert.deepEqual([...RESERVED_MARKER_KEYS].sort(), ['$_b', '$_d', '$_f', '$_m', '$_r', '$_s', '$_t'])
    assert.equal(reservedMarkerKeyOf({$_d: 0}), '$_d')
    assert.equal(reservedMarkerKeyOf({[ROW_MARKER]: 'anything'}), ROW_MARKER)
    assert.equal(reservedMarkerKeyOf({$_d: 0, name: 'x'}), undefined)
    assert.equal(reservedMarkerKeyOf({}), undefined)
    assert.equal(reservedMarkerKeyOf({plain: 1}), undefined)
    assert.equal(reservedMarkerKeyOf(null), undefined)
    assert.equal(reservedMarkerKeyOf(7), undefined)
    assert.equal(reservedMarkerKeyOf([1]), undefined)
    assert.equal(reservedMarkerKeyOf(new Date()), undefined)
}

// A Listen node is the third producer of callback packets, and it reaches the wire through the
// same sendCb — so a colliding value emitted by a subscription must behave like one emitted by
// a plain callback, and the stream must survive it.
async function testListenStreamCarriesCollidingValue() {
    const [clientSocket, serverSocket] = createLoopback()
    const [emit, stream] = createListenPair<any>()
    const object = {stream}
    const client = createRpcClient<typeof object>({socket: clientSocket, socketKey: 'rpc'})
    createRpcServerAuto({socket: serverSocket, object, socketKey: 'rpc'})
    await delay(5)
    const seen: any[] = []
    ;(client.func as unknown as DeepSocketListen<typeof object>).stream.on(value => seen.push(value))
    await delay(5)
    emit({$_d: 0})
    emit({$_b: 'hello'})
    emit({ok: 1})
    await delay(10)
    assert.deepEqual(seen.map(tag), ['Date(0)', 'object({"$_b":"hello"})', 'object({"ok":1})'])
}

export async function runRpcMarkerContractTests() {
    await testSmallestCollidingValuePerMarker()
    await testDeclinedPayloadsStayObjects()
    await testConformingValuesUnchanged()
    await testInvalidDateSurvivesAsInvalid()
    await testEncodedBytesAreUnchanged()
    await testArgumentDirection()
    await testResultDirection()
    await testCallbackDirection()
    await testRowMarkerDirectionsAndCap()
    await testEncodeSideDetection()
    await testDebugFlagReportsOnBothFactories()
    await testReservedKeyContractHelpers()
    await testListenStreamCarriesCollidingValue()
    console.log('RPC marker contract tests: OK')
}

if (require.main === module) {
    runRpcMarkerContractTests().catch(function fail(error) {
        console.error(error)
        process.exit(1)
    })
}
