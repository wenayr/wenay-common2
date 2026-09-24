import assert from 'node:assert/strict'
import {createBinaryValueCodec, type BinaryValueCodecOptions} from '../../src/Common/events/replay-binary-value'

// The encoder captures ordinary objects with Object.keys (exotic ones take the
// precise walk), finds repeated shapes by key identity before building a
// signature, guards cycles with the active path and writes one-byte varuints
// directly. None of it may change a byte, a rejection or a shape id.

const OPTIONS: BinaryValueCodecOptions = {
    // replay-channel.ts createReplayBinaryCodec
    magic: [0x52, 0x43, 0x48], version: 1, label: 'enc', callbackRefs: false,
    shapeCache: {maxEntries: 1000}, maxDepth: 36, maxBinaryBytes: 8_000_000, maxWireBytes: 16_000_000,
}
const HEADER = [0x52, 0x43, 0x48, 1]
const TAG = {INTEGER: 4, ARRAY: 9, OBJECT: 10, OBJECT_SHAPE_DEF: 20, OBJECT_SHAPE_REF: 21} as const

function codec(shape = true) {
    return createBinaryValueCodec({...OPTIONS, shapeCache: shape ? OPTIONS.shapeCache : false})
}

function bytesOf(wire: Uint8Array) {
    return Array.from(wire)
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
    return Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) == 0
}

/** Counts calls of a method while run() executes. */
function countCalls<T extends object>(owner: T, method: keyof T & string, run: () => void, filter?: (args: any[]) => boolean) {
    const original = (owner as any)[method]
    const hadOwn = Object.prototype.hasOwnProperty.call(owner, method)
    let calls = 0
    ;(owner as any)[method] = function countingCall(this: unknown, ...args: any[]) {
        if (!filter || filter(args)) calls++
        return original.apply(this, args)
    }
    try { run() }
    finally {
        if (hadOwn) (owner as any)[method] = original
        else delete (owner as any)[method]
    }
    return calls
}

// ============================================================
// Object capture: exotic objects encode as their visible data, or are refused
// ============================================================

function checkExoticObjectsMatchTheirData() {
    const hidden = {a: 1, b: 2}
    Object.defineProperty(hidden, 'secret', {value: 3, enumerable: false})
    const reordered: Record<string, number> = {b: 1, 2: 2, a: 3, 1: 4}
    const dictionary: Record<string, number> = {}
    for (let index = 0; index < 40; index++) dictionary['k' + index] = index
    for (let index = 0; index < 40; index += 2) delete dictionary['k' + index]
    const frozen = Object.freeze({x: 1, y: [2]})
    const proxied = new Proxy({p: 1, q: 'two'}, {})
    const hiddenSymbol = {s: 1}
    Object.defineProperty(hiddenSymbol, Symbol('meta'), {value: 1, enumerable: false})
    const cases: [string, object, object][] = [
        ['non-enumerable property', hidden, {a: 1, b: 2}],
        ['integer-like keys', reordered, {1: 4, 2: 2, b: 1, a: 3}],
        ['dictionary-mode object', dictionary, Object.fromEntries(Object.entries(dictionary))],
        ['frozen object', frozen, {x: 1, y: [2]}],
        ['proxy of a plain object', proxied, {p: 1, q: 'two'}],
    ]
    for (const [name, exotic, plain] of cases) {
        for (const shape of [true, false]) {
            assert.ok(sameBytes(codec(shape).encode(exotic), codec(shape).encode(plain)), `${name}: the bytes of its visible data`)
        }
    }
    // Symbols are refused even when non-enumerable, exactly as the precise walk refuses them.
    assert.throws(function encodeHiddenSymbol() { codec().encode(hiddenSymbol) }, /^TypeError: enc: symbol object keys are not supported$/)
    assert.throws(function encodeSymbol() { codec().encode({a: 1, [Symbol('s')]: 2}) }, /^TypeError: enc: symbol object keys are not supported$/)
    const accessors = [
        Object.defineProperty({a: 1}, 'b', {get() { return 2 }, enumerable: true}),
        Object.defineProperty({a: 1}, 'b', {get() { return 2 }, enumerable: false}),
        Object.defineProperty({a: 1}, 'b', {set() {}, enumerable: true}),
    ]
    for (const value of accessors) {
        assert.throws(function encodeAccessor() { codec().encode(value) }, /^TypeError: enc: accessor properties are not supported$/)
    }
    let getterCalls = 0
    const watched = Object.defineProperty({a: 1}, 'b', {get() { getterCalls++; return 2 }, enumerable: true})
    assert.throws(function encodeWatched() { codec().encode([watched]) }, /accessor/)
    assert.equal(getterCalls, 0, 'a refused accessor is never invoked')
    assert.throws(function encodeClass() { codec().encode(new (class Point { x = 1 })()) }, /class instances are not supported/)
}

// ============================================================
// Recent shapes: a rewound or refused add takes its shapes out of the cache
// ============================================================

function checkRecentShapesFollowRewinds() {
    const batchCodec = codec()
    const twinCodec = codec()
    const decoder = codec()
    const batch = batchCodec.openBatch([5], 64)
    const accepted: unknown[] = []
    function add(value: unknown) {
        batch.add(value)
        accepted.push(value)
    }
    add({a: 1, b: 2})
    batch.add({gone: 1, with: 2}) // stages shape id 1 ...
    batch.rewindLast() // ... and gives the id back
    add({other: 1, keys: 2}) // takes id 1
    add({gone: 3, with: 4}) // must define a new shape (id 2), not reuse the dropped one
    assert.throws(function refusedAfterStaging() { batch.add({fresh: 1, bad() {}}) }, /function values/)
    add({fresh: 5, bad: 6}) // the refused add's staged shape is gone too
    add({a: 7, b: 8}) // committed-in-frame shape, found again
    const finished = batch.finish()
    const reference = twinCodec.prepareEncode([5, accepted])
    assert.ok(sameBytes(finished.wire, reference.wire), 'shape ids equal those of prepareEncode')
    finished.commit()
    reference.commit()
    assert.deepEqual(decoder.decode(finished.wire), [5, accepted])
    assert.deepEqual(batchCodec.stats(), {...twinCodec.stats()}, 'same shapes, definitions and references')
}

function checkShapeFoundAcrossPrototypesAndOrder() {
    // Same keys, other prototype or order: different shapes, as with signatures.
    const nullProto = Object.assign(Object.create(null), {a: 1, b: 2})
    const values = [{a: 1, b: 2}, nullProto, {b: 2, a: 1}, {a: 3, b: 4}, Object.assign(Object.create(null), {a: 5, b: 6})]
    const encoder = codec()
    const decoder = codec()
    const wire = encoder.encode(values)
    assert.deepEqual(decoder.decode(wire), values)
    assert.equal(encoder.stats().encodeDefinitions, 3, 'three shapes: {a,b}, null-prototype {a,b}, {b,a}')
    assert.equal(encoder.stats().encodeReferences, 2)
}

// ============================================================
// Active path: cycles refused, shared values accepted
// ============================================================

function checkCyclesAndSharedValues() {
    const shared = {s: 1}
    const sharedArray = [1, 2]
    const accepted = [shared, shared, sharedArray, {x: sharedArray, y: sharedArray}, new Map([[1, shared], [2, shared]]), new Set([sharedArray])]
    assert.deepEqual(codec().decode(codec().encode(accepted)), accepted, 'a value reached twice is not a cycle')
    const objectCycle: any = {a: {}}
    objectCycle.a.back = objectCycle
    const arrayCycle: any[] = [[]]
    arrayCycle[0].push(arrayCycle)
    const mapCycle = new Map<string, unknown>()
    mapCycle.set('self', [mapCycle])
    const setCycle = new Set<unknown>()
    setCycle.add({inner: setCycle})
    for (const [name, value] of Object.entries({objectCycle, arrayCycle, mapCycle, setCycle})) {
        for (const shape of [true, false]) {
            assert.throws(function encodeCycle() { codec(shape).encode(value) }, /^TypeError: enc: cyclic values are not supported$/, name)
        }
    }
    // A refused cycle leaves nothing on the active path: the codec encodes the next value normally.
    const encoder = codec()
    assert.throws(function first() { encoder.encode(objectCycle) }, /cyclic/)
    assert.deepEqual(codec().decode(encoder.encode([shared, [shared]])), [shared, [shared]])
}

// ============================================================
// Varuints and shape key limits keep their exact bytes and checks
// ============================================================

function checkVaruintBytes() {
    const plain = codec(false)
    assert.deepEqual(bytesOf(plain.encode(63)), [...HEADER, TAG.INTEGER, 0x7e])
    assert.deepEqual(bytesOf(plain.encode(-64)), [...HEADER, TAG.INTEGER, 0x7f])
    assert.deepEqual(bytesOf(plain.encode(64)), [...HEADER, TAG.INTEGER, 0x80, 0x01])
    assert.deepEqual(bytesOf(plain.encode(-65)), [...HEADER, TAG.INTEGER, 0x81, 0x01])
    assert.deepEqual(bytesOf(plain.encode(0)), [...HEADER, TAG.INTEGER, 0x00])
    assert.deepEqual(bytesOf(plain.encode(new Array(127).fill(0))).slice(0, 6), [...HEADER, TAG.ARRAY, 0x7f])
    assert.deepEqual(bytesOf(plain.encode(new Array(128).fill(0))).slice(0, 7), [...HEADER, TAG.ARRAY, 0x80, 0x01])
    assert.deepEqual(bytesOf(plain.encode(Number.MAX_SAFE_INTEGER)).slice(4),
        [TAG.INTEGER, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f], 'the widest safe integer keeps its eight bytes')
}

function checkShapeKeyLimitOnReference() {
    const encoder = codec()
    const decoder = codec()
    const long = 'k'.repeat(40)
    const value = {[long]: 1, short: 2}
    assert.deepEqual(decoder.decode(encoder.encode(value)), value, 'the definition decodes without limits')
    const reference = encoder.encode(value)
    assert.equal(reference[4], TAG.OBJECT_SHAPE_REF)
    assert.throws(function decodeOverLimit() { decoder.decode(reference, {maxStringLen: 39}) }, /object shape key exceeds string limit/,
        'a referenced shape still checks its longest key against the caller limit')
    assert.deepEqual(decoder.decode(reference, {maxStringLen: 40}), value)
}

// ============================================================
// Cost: per-object signatures, key walks and WeakSet work
// ============================================================

function ticks(count: number) {
    return Array.from({length: count}, (_, index) => ({
        symbol: 'SYM' + (index % 50), price: 100 + index * 0.25, qty: index % 17, side: index % 2 ? 'buy' : 'sell', ts: 1727000000000 + index,
    }))
}

function checkRepeatedShapesCostNoSignature() {
    const packet = [5, ticks(64)]
    const encoder = codec()
    const signatures = countCalls(JSON, 'stringify', function encodeTicks() { encoder.encode(packet) })
    assert.ok(signatures <= 2, `JSON.stringify calls to encode 64 same-shape objects: ${signatures} (at most 2: one lookup, one definition)`)
    const steady = countCalls(JSON, 'stringify', function encodeTicksAgain() { encoder.encode(packet) })
    assert.ok(steady <= 1, `and once the shape is committed: ${steady}`)
}

function checkPlainObjectsCostNoOwnKeysWalk() {
    const packet = [5, ticks(64)]
    const walks = countCalls(Reflect, 'ownKeys', function encodeTicks() { codec().encode(packet) }, args => !Array.isArray(args[0]))
    assert.equal(walks, 0, `Reflect.ownKeys walks of 64 ordinary objects: ${walks}`)
    // The finished wire itself is marked as a trusted leaf: one addition per frame, not per container.
    const weakSetAdds = countCalls(WeakSet.prototype, 'add', function encodeTicks() { codec().encode(packet) },
        args => !ArrayBuffer.isView(args[0]))
    assert.equal(weakSetAdds, 0, `WeakSet additions for a 66-container active path: ${weakSetAdds}`)
}

let failures = 0
const checks = [
    checkExoticObjectsMatchTheirData,
    checkRecentShapesFollowRewinds,
    checkShapeFoundAcrossPrototypesAndOrder,
    checkCyclesAndSharedValues,
    checkVaruintBytes,
    checkShapeKeyLimitOnReference,
    checkRepeatedShapesCostNoSignature,
    checkPlainObjectsCostNoOwnKeysWalk,
]
for (const check of checks) {
    try {
        check()
        console.log(`PASS ${check.name}`)
    } catch (error) {
        failures++
        console.error(`FAIL ${check.name}: ${(error as Error)?.message ?? error}`)
    }
}
if (failures) {
    console.error(`${failures} replay binary encode fast-path checks failed`)
    process.exit(1)
}
console.log('PASS replay binary encode fast paths: same bytes, rejections and shape ids, without per-object signatures, key walks or WeakSet work')
