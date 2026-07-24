// ===========================================================================
// Universal schema binary codec — pure protocol contract
//
// Socket/RPC routing is deliberately absent here. These tests isolate schema
// discovery, cache transactions and exact value reconstruction from transport.
// ===========================================================================

import * as assert from 'node:assert/strict'
import {createRpcBinarySchemaCodec} from './rpc-binary-schema'
import {
    createBinaryValueCodec,
    createRpcBinaryCallbackRef,
    rpcBinaryCallbackRefId,
} from './rpc-binary-value'
import {Pkt} from './rpc-protocol'

const TEST_MAGIC = [0x53, 0x42, 0x43] as const
const TEST_VERSION = 1

type tCodecOverrides = Omit<
    Parameters<typeof createRpcBinarySchemaCodec>[0],
    'magic' | 'version' | 'label'
>

function createTestCodec(overrides: tCodecOverrides = {}) {
    return createRpcBinarySchemaCodec({
        magic: TEST_MAGIC,
        version: TEST_VERSION,
        label: 'RPC schema binary codec test',
        ...overrides,
    })
}

function copyBytes(value: Uint8Array) {
    const copy = new Uint8Array(value.byteLength)
    copy.set(value)
    return copy
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array) {
    if (needle.byteLength == 0) return true
    outer: for (let start = 0; start <= haystack.byteLength - needle.byteLength; start++) {
        for (let offset = 0; offset < needle.byteLength; offset++) {
            if (haystack[start + offset] != needle[offset]) continue outer
        }
        return true
    }
    return false
}

function activeBytes(value: ArrayBufferView) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function assertExactValue(actual: unknown, expected: unknown, label = 'value') {
    if (typeof expected == 'number') {
        assert.ok(Object.is(actual, expected), label + ' keeps the exact number')
        return
    }
    if (expected == null || typeof expected != 'object') {
        assert.equal(actual, expected, label)
        return
    }
    assert.ok(actual != null && typeof actual == 'object', label + ' remains an object')

    const expectedCallbackId = rpcBinaryCallbackRefId(expected)
    if (expectedCallbackId != null) {
        assert.equal(rpcBinaryCallbackRefId(actual), expectedCallbackId, label + ' keeps callback id')
        return
    }
    if (expected instanceof Date) {
        assert.equal(Object.getPrototypeOf(actual), Date.prototype, label + ' remains Date')
        assert.ok(Object.is((actual as Date).valueOf(), expected.valueOf()), label + ' keeps Date value')
        return
    }
    if (expected instanceof RegExp) {
        assert.equal(Object.getPrototypeOf(actual), RegExp.prototype, label + ' remains RegExp')
        assert.equal((actual as RegExp).source, expected.source, label + ' keeps RegExp source')
        assert.equal((actual as RegExp).flags, expected.flags, label + ' keeps RegExp flags')
        assert.equal((actual as RegExp).lastIndex, expected.lastIndex, label + ' keeps RegExp state')
        return
    }
    if (expected instanceof ArrayBuffer) {
        assert.equal(Object.getPrototypeOf(actual), ArrayBuffer.prototype, label + ' remains ArrayBuffer')
        assert.deepEqual(
            Array.from(new Uint8Array(actual as ArrayBuffer)),
            Array.from(new Uint8Array(expected)),
            label + ' keeps ArrayBuffer bytes',
        )
        return
    }
    if (ArrayBuffer.isView(expected)) {
        assert.ok(ArrayBuffer.isView(actual), label + ' remains an ArrayBuffer view')
        assert.equal(Object.getPrototypeOf(actual), Object.getPrototypeOf(expected), label + ' keeps view type')
        assert.deepEqual(
            Array.from(activeBytes(actual as ArrayBufferView)),
            Array.from(activeBytes(expected)),
            label + ' keeps view bytes',
        )
        return
    }
    if (expected instanceof Map) {
        assert.equal(Object.getPrototypeOf(actual), Map.prototype, label + ' remains Map')
        const expectedEntries = [...expected.entries()]
        const actualEntries = [...(actual as Map<unknown, unknown>).entries()]
        assert.equal(actualEntries.length, expectedEntries.length, label + ' keeps Map size')
        for (let index = 0; index < expectedEntries.length; index++) {
            assertExactValue(actualEntries[index][0], expectedEntries[index][0], label + ' Map key ' + index)
            assertExactValue(actualEntries[index][1], expectedEntries[index][1], label + ' Map value ' + index)
        }
        return
    }
    if (expected instanceof Set) {
        assert.equal(Object.getPrototypeOf(actual), Set.prototype, label + ' remains Set')
        const expectedValues = [...expected.values()]
        const actualValues = [...(actual as Set<unknown>).values()]
        assert.equal(actualValues.length, expectedValues.length, label + ' keeps Set size')
        for (let index = 0; index < expectedValues.length; index++) {
            assertExactValue(actualValues[index], expectedValues[index], label + ' Set value ' + index)
        }
        return
    }
    if (Array.isArray(expected)) {
        assert.ok(Array.isArray(actual), label + ' remains Array')
        assert.equal((actual as unknown[]).length, expected.length, label + ' keeps Array length')
        for (let index = 0; index < expected.length; index++) {
            const actualOwn = Object.prototype.hasOwnProperty.call(actual, index)
            const expectedOwn = Object.prototype.hasOwnProperty.call(expected, index)
            assert.equal(actualOwn, expectedOwn, label + ' keeps hole at ' + index)
            if (expectedOwn) {
                assertExactValue(
                    (actual as unknown[])[index],
                    expected[index],
                    label + ' Array item ' + index,
                )
            }
        }
        return
    }

    assert.equal(
        Object.getPrototypeOf(actual),
        Object.getPrototypeOf(expected),
        label + ' keeps object prototype',
    )
    assert.deepEqual(Reflect.ownKeys(actual as object), Reflect.ownKeys(expected), label + ' keeps keys')
    for (const key of Reflect.ownKeys(expected)) {
        assertExactValue(
            (actual as any)[key],
            (expected as any)[key],
            label + '.' + String(key),
        )
    }
}

function transfer(
    sender: ReturnType<typeof createTestCodec>,
    receiver: ReturnType<typeof createTestCodec>,
    value: unknown,
) {
    const prepared = sender.prepareEncode(value)
    prepared.commit()
    return {
        value: receiver.decode(prepared.wire),
        wire: prepared.wire,
    }
}

function connectPredeclared(
    predeclared: readonly unknown[],
    overrides: tCodecOverrides = {},
) {
    const sender = createTestCodec({...overrides, predeclared})
    const receiver = createTestCodec(overrides)
    const prelude = sender.encodePrelude()
    receiver.decodePrelude(prelude)
    return {sender, receiver, prelude}
}

function createWideRow(index: number) {
    return {
        s0: 'BTCUSDT-' + index,
        s1: 'spot',
        s2: 'usd',
        s3: 'source-' + (index % 7),
        s4: 'venue-' + (index % 3),
        s5: 'row-' + index,
        i0: index,
        i1: index + 1,
        i2: index + 2,
        i3: index + 3,
        i4: index + 4,
        i5: index + 5,
        i6: index + 6,
        i7: index + 7,
        n0: index + 0.125,
        n1: index + 0.25,
        n2: index + 0.375,
        n3: index + 0.5,
        n4: index + 0.625,
        n5: index + 0.75,
        n6: index + 0.875,
        n7: index + 0.0625,
        b0: true,
        b1: false,
        b2: true,
        b3: false,
        nil: null,
        missing: undefined,
        timestamp: 1_700_000_000_000 + index,
        when: new Date(1_700_000_000_000 + index),
    }
}

function createNestedBook(index: number) {
    return {
        symbol: 'PAIR-' + index,
        revision: index,
        meta: {
            market: 'spot',
            active: true,
            source: {
                name: 'feed',
                partition: index % 4,
            },
        },
        levels: Array.from({length: 24}, function createLevel(_, level) {
            return {
                price: 10_000 + index + level / 100,
                size: index * 100 + level,
                side: level % 2 == 0 ? 'buy' : 'sell',
            }
        }),
    }
}

function createStoreSnapshotValue(index: number) {
    return {
        symbol: 'SYMBOL-' + index,
        price: 10_000 + index / 100,
        quantity: index + 0.25,
        sequence: index,
        active: true,
        venue: 'spot',
    }
}

function createStoreReplayPatch(index: number) {
    return {
        path: ['S' + index],
        exists: true,
        value: {
            c: index + 0.5,
            t: 1_000_000 + index,
        },
    }
}

function createStoreReplayCallbackBatch(size: number, batchSize: number) {
    const patches = Array.from({length: size}, function makePatch(_, index) {
        return createStoreReplayPatch(index)
    })
    const callbacks = []
    for (let start = 0; start < patches.length; start += batchSize) {
        callbacks.push([
            Pkt.CB,
            19,
            [{
                seq: callbacks.length + 1,
                ts: 1,
                event: [patches.slice(start, start + batchSize)],
            }],
        ])
    }
    return callbacks.length == 1
        ? callbacks[0]
        : [Pkt.CB_BATCH, callbacks]
}

function createSegmentRowA(index: number) {
    return {
        kind: 'A',
        value: index + 0.25,
        sequence: index,
        label: 'row-a-' + index,
        active: true,
    }
}

function createSegmentRowB(index: number) {
    return {
        kind: 'B',
        value: 'value-' + index,
        sequence: index,
        label: 'row-b-' + index,
        active: false,
    }
}

function createRichFallbackValue() {
    const sparse = new Array<unknown>(6)
    sparse[1] = undefined
    sparse[4] = 'tail'
    const nullPrototype = Object.create(null) as Record<string, unknown>
    nullPrototype['enabled'] = false
    nullPrototype['missing'] = undefined
    const viewBacking = new Uint8Array([0xa5, 7, 8, 9, 0xa5])

    const value: unknown[] = [
        undefined,
        null,
        false,
        true,
        0,
        -0,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
        1.25,
        NaN,
        Infinity,
        -Infinity,
        0n,
        -123456789012345678901234567890n,
        '',
        '\uFEFFПривет 🌍',
        '\ud800',
        sparse,
        nullPrototype,
        new Date(1_725_000_123_456),
        new Date(NaN),
        /цена\s+"(?<pair>.+)"/giu,
        new Map<unknown, unknown>([
            ['one', 1],
            [{key: 'object'}, new Set([false, 'two'])],
        ]),
        new Set<unknown>([undefined, 3n, {set: 'object'}]),
        Uint8Array.from([0, 1, 127, 128, 255]).buffer,
        new DataView(viewBacking.buffer, 1, 3),
        new Int16Array([-32768, -1, 0, 32767]),
        new Float64Array([-0, NaN, Infinity]),
        createRpcBinaryCallbackRef(37),
        {
            error: {
                name: 'Error',
                message: 'boom',
                code: 'E_TEST',
                data: {retry: false},
            },
        },
    ]
    const BigInt64 = (globalThis as any).BigInt64Array
    if (typeof BigInt64 == 'function') value.push(new BigInt64([-1n, 0n, 1n]))
    return value
}

// ===========================================================================
// Schema negotiation
// ===========================================================================

function testPredeclaredPreludeContainsDescriptionsNotSampleValues() {
    const sentinel = 'SAMPLE_VALUE_MUST_NEVER_REACH_THE_WIRE_72c54920'
    const sample = {
        symbol: sentinel,
        price: 123.75,
        active: true,
        nested: {
            venue: sentinel + '_nested',
            sequence: 9,
        },
    }
    const actual = {
        symbol: 'BTCUSDT',
        price: 61_234.5,
        active: false,
        nested: {
            venue: 'spot',
            sequence: 10,
        },
    }
    const {sender, receiver, prelude} = connectPredeclared([sample])

    assert.ok(prelude.byteLength > 0, 'predeclared layouts produce a prelude')
    assert.equal(
        includesBytes(prelude, new TextEncoder().encode(sentinel)),
        false,
        'prelude sends schema descriptions, not representative values',
    )
    assert.ok(sender.stats().encodeSchemas >= 2, 'root and nested predeclared schemas are installed')
    assert.equal(receiver.stats().decodeSchemas, sender.stats().encodeSchemas)

    const beforeDefinitions = sender.stats().encodeDefinitions
    const beforeReferences = sender.stats().encodeReferences
    const decoded = transfer(sender, receiver, actual).value
    assertExactValue(decoded, actual)
    assert.equal(
        sender.stats().encodeDefinitions,
        beforeDefinitions,
        'first data packet does not repeat predeclared definitions',
    )
    assert.ok(
        sender.stats().encodeReferences > beforeReferences,
        'first matching value uses an already negotiated schema id',
    )
}

function testPreludeDecodeIsTransactional() {
    const sample = createNestedBook(0)
    const sender = createTestCodec({predeclared: [sample]})
    const receiver = createTestCodec()
    const prelude = sender.encodePrelude()
    const before = receiver.stats()

    assert.throws(function rejectTruncatedPrelude() {
        receiver.decodePrelude(prelude.subarray(0, prelude.byteLength - 1))
    })
    assert.deepEqual(receiver.stats(), before, 'failed prelude installs no partial schemas')

    receiver.decodePrelude(prelude)
    assert.ok(receiver.stats().decodeSchemas >= 3)
    assertExactValue(transfer(sender, receiver, createNestedBook(1)).value, createNestedBook(1))
}

// ===========================================================================
// Dynamic frequency and bounded caches
// ===========================================================================

function testDynamicSchemaPromotesOnlyAtFrequencyThreshold() {
    const sender = createTestCodec({maxSchemas: 16, promotionThreshold: 3})
    const receiver = createTestCodec({maxSchemas: 16, promotionThreshold: 3})

    for (let index = 0; index < 2; index++) {
        const expected = {symbol: 'BTCUSDT', price: index + 0.5, active: true}
        assertExactValue(transfer(sender, receiver, expected).value, expected)
    }
    assert.equal(sender.stats().encodeSchemas, 0, 'sub-threshold layouts remain generic')
    assert.equal(sender.stats().encodePromotions, 0)
    assert.equal(sender.stats().encodeGeneric, 2)

    const promoted = {symbol: 'ETHUSDT', price: 3.5, active: true}
    assertExactValue(transfer(sender, receiver, promoted).value, promoted)
    assert.equal(sender.stats().encodeSchemas, 1)
    assert.equal(sender.stats().encodePromotions, 1)
    assert.equal(sender.stats().encodeDefinitions, 1)
    assert.equal(receiver.stats().decodeDefinitions, 1)

    const referencesBefore = sender.stats().encodeReferences
    const warm = {symbol: 'SOLUSDT', price: 4.5, active: true}
    assertExactValue(transfer(sender, receiver, warm).value, warm)
    assert.ok(sender.stats().encodeReferences > referencesBefore, 'later value uses warm schema')
}

function testRareLayoutsDoNotConsumePromotedSchemaBudget() {
    const sender = createTestCodec({maxSchemas: 8, promotionThreshold: 3})
    const receiver = createTestCodec({maxSchemas: 8, promotionThreshold: 3})

    for (let index = 0; index < 96; index++) {
        const rare = {[`rare_${index}`]: index}
        assertExactValue(transfer(sender, receiver, rare).value, rare)
    }
    assert.equal(sender.stats().encodeSchemas, 0, 'one-off layouts do not receive schema ids')
    assert.equal(sender.stats().encodePromotions, 0)
    assert.ok(sender.stats().encodeGeneric >= 96)
    assert.ok(sender.stats().encodeCandidates <= 1_000, 'candidate tracking remains bounded')

    for (let index = 0; index < 3; index++) {
        const hot = {symbol: 'HOT', price: index + 0.25}
        assertExactValue(transfer(sender, receiver, hot).value, hot)
    }
    assert.equal(sender.stats().encodeSchemas, 1, 'hot layout promotes after rare traffic')
    assert.equal(sender.stats().encodePromotions, 1)
}

function testSchemaCapFallsBackWithoutBreakingExistingReferences() {
    const maxSchemas = 8
    const sender = createTestCodec({maxSchemas, promotionThreshold: 2})
    const receiver = createTestCodec({maxSchemas, promotionThreshold: 2})

    for (let shape = 0; shape < maxSchemas; shape++) {
        for (let repeat = 0; repeat < 2; repeat++) {
            const expected = {[`shape_${shape}`]: repeat}
            assertExactValue(transfer(sender, receiver, expected).value, expected)
        }
    }
    assert.equal(sender.stats().encodeSchemas, maxSchemas)
    assert.equal(receiver.stats().decodeSchemas, maxSchemas)

    const genericBefore = sender.stats().encodeGeneric
    for (let repeat = 0; repeat < 3; repeat++) {
        const overflow = {overflow_shape: repeat}
        assertExactValue(transfer(sender, receiver, overflow).value, overflow)
    }
    assert.equal(sender.stats().encodeSchemas, maxSchemas, 'schema count never exceeds configured cap')
    assert.ok(sender.stats().encodeGeneric > genericBefore, 'overflow layout stays on generic fallback')

    const referencesBefore = sender.stats().encodeReferences
    const existing = {shape_0: 99}
    assertExactValue(transfer(sender, receiver, existing).value, existing)
    assert.ok(sender.stats().encodeReferences > referencesBefore, 'old id remains usable after saturation')
}

function testHardSchemaCapAndOptionBoundaries() {
    assert.doesNotThrow(function allowProtocolMaximum() {
        createTestCodec({maxSchemas: 1_000})
    })
    for (const invalid of [-1, 1.5, 1_001, NaN, Infinity]) {
        assert.throws(function rejectInvalidSchemaCap() {
            createTestCodec({maxSchemas: invalid})
        }, /maxSchemas/)
    }
    for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
        assert.throws(function rejectInvalidPromotionThreshold() {
            createTestCodec({promotionThreshold: invalid})
        }, /promotionThreshold/)
    }
}

// ===========================================================================
// Typed layouts, rows and exact values
// ===========================================================================

function testSameKeysWithDifferentTypesUseExactVariants() {
    const sender = createTestCodec({maxSchemas: 32, promotionThreshold: 2})
    const receiver = createTestCodec({maxSchemas: 32, promotionThreshold: 2})
    const variants = [
        {value: 'text'},
        {value: 42},
        {value: false},
        {value: true},
        {value: null},
        {value: undefined},
        {value: -0},
        {value: NaN},
        {value: Infinity},
        {value: 9_007_199_254_740_993n},
    ]

    for (const expected of variants) {
        assertExactValue(transfer(sender, receiver, expected).value, expected)
        assertExactValue(transfer(sender, receiver, expected).value, expected)
    }
    assert.ok(sender.stats().encodeSchemas >= 5, 'physical type changes create typed variants')

    const referencesBefore = sender.stats().encodeReferences
    for (const expected of variants) {
        assertExactValue(transfer(sender, receiver, expected).value, expected)
    }
    assert.ok(
        sender.stats().encodeReferences >= referencesBefore + variants.length,
        'all frequent variants are reusable without semantic validation',
    )
}

function testPredeclaredMismatchFallsBackAndOriginalSchemaSurvives() {
    const sample = {value: 1, label: 'number'}
    const {sender, receiver} = connectPredeclared([sample], {
        maxSchemas: 8,
        promotionThreshold: 2,
    })
    const genericBefore = sender.stats().encodeGeneric
    const mismatches = [
        {value: 'one', label: 'number'},
        {value: false, label: 'number'},
        {value: {nested: true}, label: 'number'},
        {value: 2, label: 'number', extra: 'field'},
    ]

    for (const expected of mismatches) {
        assert.doesNotThrow(function encodeDifferentRuntimeLayout() {
            assertExactValue(transfer(sender, receiver, expected).value, expected)
        })
    }
    assert.ok(
        sender.stats().encodeGeneric > genericBefore,
        'a different actual type/layout uses dynamic or generic encoding',
    )

    const referencesBefore = sender.stats().encodeReferences
    const original = {value: 7, label: 'number'}
    assertExactValue(transfer(sender, receiver, original).value, original)
    assert.ok(
        sender.stats().encodeReferences > referencesBefore,
        'mismatch does not poison the predeclared schema',
    )
}

function testThirtyFieldRowsUseTypedRunAndStayCompact() {
    const rows = Array.from({length: 700}, function createRow(_, index) {
        return createWideRow(index)
    })
    const sampleRows = [createWideRow(0)]
    const {sender, receiver, prelude} = connectPredeclared([sampleRows])

    const before = sender.stats()
    const encoded = transfer(sender, receiver, rows)
    assertExactValue(encoded.value, rows)
    assert.ok(sender.stats().encodeRuns > before.encodeRuns, 'homogeneous rows use a typed run')
    assert.ok(
        sender.stats().encodeRows >= before.encodeRows + rows.length,
        'all 700 rows are encoded inside typed runs',
    )
    assert.ok(receiver.stats().decodeRuns > 0)
    assert.ok(receiver.stats().decodeRows >= rows.length)
    assert.ok(sender.stats().encodeTypedFields > before.encodeTypedFields)

    const generic = createBinaryValueCodec({
        magic: [0x47, 0x45, 0x4e],
        version: 1,
        label: 'schema test generic baseline',
        shapeCache: {maxEntries: 1_000},
    })
    const genericWire = generic.encode(rows)
    assert.ok(
        prelude.byteLength + encoded.wire.byteLength < genericWire.byteLength * 0.9,
        'schema prelude plus first 30-field batch is materially smaller than generic binary',
    )
}

function testNestedRepeatedLayoutsUseRecursiveSchemas() {
    const sample = [createNestedBook(0)]
    const books = Array.from({length: 250}, function createBook(_, index) {
        return createNestedBook(index)
    })
    const {sender, receiver} = connectPredeclared([sample])
    const before = sender.stats()
    const decoded = transfer(sender, receiver, books).value

    assertExactValue(decoded, books)
    assert.ok(sender.stats().encodeSchemas >= 4, 'array, book, meta/source and level layouts exist')
    assert.ok(sender.stats().encodeRuns > before.encodeRuns, 'outer or nested rows use typed runs')
    assert.ok(sender.stats().encodeRows >= before.encodeRows + books.length)
}

function testRpcStyleTuplesKeepPositionTypesAndCallbackRefs() {
    const samples = [
        [0, 1, ['quotes', 'subscribe'], [
            {symbol: 'SAMPLE', depth: 10},
            createRpcBinaryCallbackRef(0),
        ]],
        [1, 1, {ok: true, revision: 1}],
        [2, 1, [
            {symbol: 'SAMPLE-A', price: 1.25},
            {symbol: 'SAMPLE-B', price: 2.25},
        ]],
    ]
    const pair = connectPredeclared(samples, {callbackRefs: true})
    const packets = [
        [0, 71, ['quotes', 'subscribe'], [
            {symbol: 'BTCUSDT', depth: 50},
            createRpcBinaryCallbackRef(19),
        ]],
        [1, 71, {ok: true, revision: 9}],
        [2, 19, [
            {symbol: 'BTCUSDT', price: 61_234.5},
            {symbol: 'ETHUSDT', price: 3_456.75},
        ]],
    ]
    const referencesBefore = pair.sender.stats().encodeReferences

    for (const packet of packets) {
        assertExactValue(transfer(pair.sender, pair.receiver, packet).value, packet)
    }
    assert.ok(
        pair.sender.stats().encodeReferences >= referencesBefore + packets.length,
        'CALL/RESP/callback-style tuples use pre-agreed positional layouts',
    )
}

function testNestedRpcResponseRowsUseTypedRun() {
    const rows = Array.from({length: 700}, function createResponseRow(_, index) {
        return createWideRow(index)
    })
    const sender = createTestCodec({maxSchemas: 64, promotionThreshold: 1})
    const receiver = createTestCodec({maxSchemas: 64, promotionThreshold: 1})
    const packet = [Pkt.RESP, 71, rows]
    const before = sender.stats()
    const encoded = transfer(sender, receiver, packet)

    assertExactValue(encoded.value, packet)
    assert.ok(
        sender.stats().encodeRuns > before.encodeRuns,
        'rows nested inside RESP use the same typed-run engine as a root array',
    )
    assert.ok(
        sender.stats().encodeRows >= before.encodeRows + rows.length,
        'all 700 nested response rows are counted in typed runs',
    )
    assert.ok(receiver.stats().decodeRuns > 0)
    assert.ok(receiver.stats().decodeRows >= rows.length)
}

function testNestedCallbackArgumentRowsUseTypedRun() {
    const rows = Array.from({length: 700}, function createCallbackRow(_, index) {
        return createWideRow(index)
    })
    const sender = createTestCodec({maxSchemas: 64, promotionThreshold: 1})
    const receiver = createTestCodec({maxSchemas: 64, promotionThreshold: 1})
    const packet = [Pkt.CB, 19, [rows]]
    const before = sender.stats()
    const encoded = transfer(sender, receiver, packet)

    assertExactValue(encoded.value, packet)
    assert.ok(
        sender.stats().encodeRuns > before.encodeRuns,
        'rows nested inside the callback argument tuple use a typed run',
    )
    assert.ok(
        sender.stats().encodeRows >= before.encodeRows + rows.length,
        'all 700 callback rows are counted below both tuple wrappers',
    )
    assert.ok(receiver.stats().decodeRuns > 0)
    assert.ok(receiver.stats().decodeRows >= rows.length)
}

function testBulkNestedCollectionPaysAdmissionInFirstFrame() {
    const packet = createStoreReplayCallbackBatch(700, 256)
    const sender = createTestCodec({
        maxSchemas: 64,
        promotionThreshold: 3,
    })
    const receiver = createTestCodec({
        maxSchemas: 64,
        promotionThreshold: 3,
    })
    const generic = createBinaryValueCodec({
        magic: [0x47, 0x45, 0x4e],
        version: 1,
        label: 'Store callback generic baseline',
        shapeCache: {maxEntries: 1_000},
    })
    const genericWire = generic.encode(packet)
    const encoded = transfer(sender, receiver, packet)

    assertExactValue(encoded.value, packet)
    assert.ok(
        encoded.wire.byteLength < genericWire.byteLength,
        'first universal frame is smaller than the cached generic baseline',
    )
    assert.ok(sender.stats().encodeDefinitions > 0, 'bulk frame admits its wrapper schemas')
    assert.ok(sender.stats().encodeRuns >= 4, 'callback packets and Store patches use typed runs')
    assert.ok(sender.stats().encodeRows >= 703, 'three callbacks plus 700 patches use runs')
    assert.equal(sender.stats().encodeGeneric, 4, 'only length-variable collection fields are nested DATA')
}

function testNestedCollectionsPreserveMixedEmptyAndVariableValues() {
    const values = [
        {channel: 'empty', rows: []},
        {channel: 'short', rows: [{id: 1}, {id: 2}]},
        {channel: 'mixed', rows: [{id: 3}, {label: 'four'}, false, null]},
        {channel: 'long', rows: Array.from({length: 9}, function makeRow(_, id) {
            return {id, active: id % 2 == 0}
        })},
    ]
    const sender = createTestCodec({maxSchemas: 32, promotionThreshold: 1})
    const receiver = createTestCodec({maxSchemas: 32, promotionThreshold: 1})

    for (const value of values) {
        assertExactValue(transfer(sender, receiver, value).value, value)
    }
}

function testBulkAdmissionRollbackAndSmallOneOffStayTransactional() {
    const bulk = createStoreReplayCallbackBatch(700, 256)
    const sender = createTestCodec({maxSchemas: 64, promotionThreshold: 3})
    const before = sender.stats()
    const prepared = sender.prepareEncode(bulk)

    assert.ok(prepared.wire.byteLength < 18_000, 'prepared bulk frame uses compact nested runs')
    prepared.rollback()
    assert.deepEqual(sender.stats(), before, 'bulk admission rollback leaves no schemas or counters')

    const small = {
        channel: 'one-off',
        rows: [{id: 1}, {id: 2}],
    }
    sender.encode(small)
    assert.equal(sender.stats().encodeSchemas, 0, 'small one-off wrapper stays below admission threshold')
    assert.equal(sender.stats().encodeCandidates, 1, 'small wrapper remains only a bounded candidate')
}

function testStoreReplaySnapshotDictionaryUsesValueRun() {
    const snapshot: Record<string, ReturnType<typeof createStoreSnapshotValue>> = {}
    for (let index = 0; index < 15_000; index++) {
        snapshot['KEY-' + index.toString().padStart(5, '0')] = createStoreSnapshotValue(index)
    }
    const replayEvent = {
        seq: 51,
        ts: 1_725_000_123_456,
        event: [[{
            path: [],
            value: snapshot,
            exists: true,
        }]],
    }
    const sender = createTestCodec({
        maxSchemas: 64,
        promotionThreshold: 1,
        maxWireBytes: 32_000_000,
    })
    const receiver = createTestCodec({
        maxSchemas: 64,
        promotionThreshold: 1,
        maxWireBytes: 32_000_000,
    })
    const before = sender.stats()
    const encoded = transfer(sender, receiver, replayEvent)

    assertExactValue(encoded.value, replayEvent)
    assert.ok(
        sender.stats().encodeRuns > before.encodeRuns,
        'Store root-replace dictionary uses a run for repeated values',
    )
    assert.ok(
        sender.stats().encodeRows >= before.encodeRows + 15_000,
        'all 15,000 dynamic-key values are encoded through the shared row layout',
    )
    assert.ok(receiver.stats().decodeRuns > 0)
    assert.ok(receiver.stats().decodeRows >= 15_000)
    assert.ok(sender.stats().encodeSchemas > 0, 'nested Store value layout receives a schema id')
}

function testHomogeneousRunSizeMatrix() {
    const pair = connectPredeclared([[createSegmentRowA(0)]], {
        maxSchemas: 16,
        promotionThreshold: 3,
    })

    for (const size of [1, 10, 50, 700]) {
        const rows = Array.from({length: size}, function createSizedRow(_, index) {
            return createSegmentRowA(index)
        })
        const before = pair.sender.stats()
        const encoded = transfer(pair.sender, pair.receiver, rows)
        assertExactValue(encoded.value, rows, 'homogeneous run size ' + size)

        if (size == 1) {
            assert.ok(
                pair.sender.stats().encodeTypedFields > before.encodeTypedFields,
                'single row uses its pre-agreed typed layout',
            )
        } else {
            assert.ok(
                pair.sender.stats().encodeRuns > before.encodeRuns,
                'size ' + size + ' uses a physical run',
            )
            assert.ok(
                pair.sender.stats().encodeRows >= before.encodeRows + size,
                'size ' + size + ' accounts for every row',
            )
        }
    }
}

function testGroupedMixedLayoutsUseSegmentedRuns() {
    const rows = [
        ...Array.from({length: 350}, function createFirstSegment(_, index) {
            return createSegmentRowA(index)
        }),
        ...Array.from({length: 350}, function createSecondSegment(_, index) {
            return createSegmentRowB(index + 350)
        }),
    ]
    const sender = createTestCodec({maxSchemas: 16, promotionThreshold: 1})
    const receiver = createTestCodec({maxSchemas: 16, promotionThreshold: 1})
    const before = sender.stats()
    const encoded = transfer(sender, receiver, rows)

    assertExactValue(encoded.value, rows)
    assert.ok(
        sender.stats().encodeRuns >= before.encodeRuns + 2,
        'two grouped physical layouts produce at least two ordered runs',
    )
    assert.ok(
        sender.stats().encodeRows >= before.encodeRows + rows.length,
        'both grouped segments account for all 700 rows',
    )
    assert.ok(receiver.stats().decodeRuns >= 2)
    assert.ok(receiver.stats().decodeRows >= rows.length)
}

function testAlternatingMixedLayoutsKeepOrderedSegments() {
    const rows = Array.from({length: 700}, function createAlternatingRow(_, index) {
        return index % 2 == 0
            ? createSegmentRowA(index)
            : createSegmentRowB(index)
    })
    const sender = createTestCodec({maxSchemas: 16, promotionThreshold: 1})
    const receiver = createTestCodec({maxSchemas: 16, promotionThreshold: 1})
    const before = sender.stats()
    const encoded = transfer(sender, receiver, rows)

    assertExactValue(encoded.value, rows)
    assert.ok(
        sender.stats().encodeRuns > before.encodeRuns,
        'alternating layouts retain order through physical run segments',
    )
    assert.ok(
        sender.stats().encodeRows >= before.encodeRows + rows.length,
        'alternating segments account for all 700 rows',
    )
    assert.ok(receiver.stats().decodeRuns > 0)
    assert.ok(receiver.stats().decodeRows >= rows.length)
}

function testGenericFallbackPreservesRichAndExactValues() {
    const sender = createTestCodec({
        callbackRefs: true,
        maxSchemas: 16,
        promotionThreshold: 99,
    })
    const receiver = createTestCodec({
        callbackRefs: true,
        maxSchemas: 16,
        promotionThreshold: 99,
    })
    const expected = createRichFallbackValue()
    const decoded = transfer(sender, receiver, expected).value

    assertExactValue(decoded, expected)
    assert.equal(sender.stats().encodeSchemas, 0)
    assert.ok(sender.stats().encodeGeneric > 0, 'rare rich tree uses universal generic escape')
    assert.ok(receiver.stats().decodeGeneric > 0)
}

function testDirectBinaryLeavesAvoidGenericWrappers() {
    const backing = Uint8Array.from([0xa5, 1, 2, 3, 4, 5, 6, 0xa5])
    const values: unknown[] = [
        backing.slice(1, 7).buffer,
        new DataView(backing.buffer, 1, 6),
        new Uint8Array(backing.buffer, 1, 6),
        new Int16Array(Int16Array.from([-32768, -1, 0, 32767]).buffer),
        new Float64Array([-0, NaN, Infinity]),
    ]
    const BigInt64 = (globalThis as any).BigInt64Array
    if (typeof BigInt64 == 'function') values.push(new BigInt64([-1n, 0n, 1n]))

    for (const expected of values) {
        const packet = [1, 7, expected]
        const pair = connectPredeclared([packet], {
            maxSchemas: 32,
            promotionThreshold: 1,
        })
        const beforeGeneric = pair.sender.stats().encodeGeneric
        const encoded = transfer(pair.sender, pair.receiver, packet)
        assertExactValue(encoded.value, packet)
        assert.equal(
            pair.sender.stats().encodeGeneric,
            beforeGeneric,
            'binary schema field bypasses generic nested wrappers',
        )

        const rootSender = createTestCodec({promotionThreshold: 1})
        const rootReceiver = createTestCodec({promotionThreshold: 1})
        assertExactValue(transfer(rootSender, rootReceiver, expected).value, expected)
        assert.equal(rootSender.stats().encodeGeneric, 0, 'root binary leaf is direct')
    }

    const large = new Uint8Array(1024 * 1024)
    large[0] = 1
    large[large.length - 1] = 2
    const packet = [1, 9, large]
    const pair = connectPredeclared([packet], {
        maxWireBytes: 2_000_000,
    })
    const prepared = pair.sender.prepareEncode(packet)
    const beforeDecode = pair.receiver.stats()
    assert.ok(
        prepared.wire.byteLength < large.byteLength + 32,
        'direct binary field adds only bounded framing bytes',
    )
    assert.throws(function rejectTruncatedDirectBinary() {
        pair.receiver.decode(prepared.wire.subarray(0, prepared.wire.byteLength - 1))
    })
    assert.deepEqual(
        pair.receiver.stats(),
        beforeDecode,
        'truncated direct binary does not commit decoder state',
    )
    prepared.commit()
    assertExactValue(pair.receiver.decode(prepared.wire), packet)

    const dynamicLarge = new Uint8Array(1024 * 1024)
    dynamicLarge[0] = 0x5a
    dynamicLarge[dynamicLarge.length - 1] = 0xa5
    const dynamicPacket = [Pkt.RESP, 10, dynamicLarge]
    const dynamicSender = createTestCodec({
        promotionThreshold: 3,
        maxWireBytes: 2_000_000,
    })
    const dynamicReceiver = createTestCodec({
        promotionThreshold: 3,
        maxWireBytes: 2_000_000,
    })
    const originalOwnKeys = Reflect.ownKeys
    let binaryOwnKeyScans = 0
    Object.defineProperty(Reflect, 'ownKeys', {
        configurable: true,
        writable: true,
        value: function countBinaryOwnKeys(value: object) {
            if (value == dynamicLarge) binaryOwnKeyScans++
            return originalOwnKeys(value)
        },
    })
    let dynamicDecoded: any
    try {
        dynamicDecoded = transfer(dynamicSender, dynamicReceiver, dynamicPacket).value
    } finally {
        Object.defineProperty(Reflect, 'ownKeys', {
            configurable: true,
            writable: true,
            value: originalOwnKeys,
        })
    }
    assert.equal(binaryOwnKeyScans, 0, 'bulk admission never enumerates TypedArray indices')
    assert.equal(dynamicDecoded[2].byteLength, dynamicLarge.byteLength)
    assert.deepEqual(dynamicDecoded[2], dynamicLarge, 'dynamic 1 MiB callback leaf stays exact')
}

// ===========================================================================
// Transactions, measurement and generations
// ===========================================================================

function testPreparedPromotionRollbackDoesNotConsumeSchemaId() {
    const sender = createTestCodec({maxSchemas: 8, promotionThreshold: 2})
    const receiver = createTestCodec({maxSchemas: 8, promotionThreshold: 2})
    const first = {symbol: 'BTCUSDT', price: 1.25}
    assertExactValue(transfer(sender, receiver, first).value, first)

    const before = sender.stats()
    const rolledBack = sender.prepareEncode({symbol: 'ETHUSDT', price: 2.25})
    const rolledBackWire = copyBytes(rolledBack.wire)
    assert.equal(sender.stats().pendingEncode, true)
    assert.throws(function rejectParallelPreparedEncode() {
        sender.prepareEncode({symbol: 'blocked', price: 0.25})
    }, /prepared encode/)
    rolledBack.rollback()
    assert.deepEqual(sender.stats(), before, 'rollback restores candidates, ids, counters and byte stats')

    const retried = sender.prepareEncode({symbol: 'ETHUSDT', price: 2.25})
    assert.deepEqual(retried.wire, rolledBackWire, 'retry reuses the unconsumed deterministic schema id')
    retried.commit()
    assertExactValue(receiver.decode(retried.wire), {symbol: 'ETHUSDT', price: 2.25})
    assert.equal(sender.stats().encodeSchemas, 1)
    assert.equal(receiver.stats().decodeSchemas, 1)
}

function testEncodeAndDecodeFailuresAreTransactional() {
    const sender = createTestCodec({maxSchemas: 8, promotionThreshold: 1})
    const cyclic: Record<string, unknown> = {name: 'cycle'}
    cyclic.self = cyclic
    const beforeEncode = sender.stats()
    assert.throws(function rejectCyclicValue() {
        sender.encode(cyclic)
    }, /cyclic|cycle/i)
    assert.deepEqual(sender.stats(), beforeEncode, 'failed encode installs no schema')

    const wire = sender.encode({valid: 1})
    const receiver = createTestCodec({maxSchemas: 8, promotionThreshold: 1})
    const beforeDecode = receiver.stats()
    assert.throws(function rejectTruncatedDefinition() {
        receiver.decode(wire.subarray(0, wire.byteLength - 1))
    })
    assert.deepEqual(receiver.stats(), beforeDecode, 'failed decode installs no partial definition')
    assertExactValue(receiver.decode(wire), {valid: 1})
    assert.equal(receiver.stats().decodeSchemas, 1)
}

function testMeasurementMatchesColdWarmAndDoesNotMutateState() {
    const codec = createTestCodec({maxSchemas: 8, promotionThreshold: 2})
    const values = [
        {symbol: 'BTCUSDT', price: 1.25},
        {symbol: 'ETHUSDT', price: 2.25},
        Array.from({length: 64}, function makeRow(_, index) {
            return {id: index, text: 'row-' + index, active: true}
        }),
    ]

    for (const value of values) {
        const before = codec.stats()
        const measured = codec.measureEncode(value)
        assert.deepEqual(codec.stats(), before, 'measure does not mutate schema frequency or ids')
        assert.equal(codec.encode(value).byteLength, measured)
    }
}

function testResetStartsFreshGenerationAndReplaysPredeclaredSchemas() {
    const sample = {symbol: 'BTCUSDT', price: 1.25}
    const pair = connectPredeclared([sample])
    const first = {symbol: 'ETHUSDT', price: 2.25}
    assertExactValue(transfer(pair.sender, pair.receiver, first).value, first)
    const senderGeneration = pair.sender.stats().generation
    const receiverGeneration = pair.receiver.stats().generation

    pair.sender.reset()
    pair.receiver.reset()
    assert.equal(pair.sender.stats().generation, senderGeneration + 1)
    assert.equal(pair.receiver.stats().generation, receiverGeneration + 1)
    pair.receiver.decodePrelude(pair.sender.encodePrelude())

    const second = {symbol: 'SOLUSDT', price: 3.25}
    assertExactValue(transfer(pair.sender, pair.receiver, second).value, second)
    assert.ok(pair.sender.stats().encodeReferences > 0)
    assert.ok(pair.receiver.stats().decodeReferences > 0)
}

function testDirectionsCanLearnDifferentSchemaSequences() {
    const left = createTestCodec({maxSchemas: 8, promotionThreshold: 2})
    const right = createTestCodec({maxSchemas: 8, promotionThreshold: 2})

    for (let repeat = 0; repeat < 3; repeat++) {
        assertExactValue(transfer(left, right, {left: repeat}).value, {left: repeat})
        assertExactValue(transfer(right, left, {right: String(repeat)}).value, {right: String(repeat)})
    }
    assert.equal(left.stats().encodeSchemas, 1)
    assert.equal(left.stats().decodeSchemas, 1)
    assert.equal(right.stats().encodeSchemas, 1)
    assert.equal(right.stats().decodeSchemas, 1)
}

function testTrustedEncodeMatchesStrictWireAndKeepsKindChangesExact() {
    const rows = Array.from({length: 64}, function makePatch(_, index) {
        return {
            path: ['S' + index],
            exists: true,
            value: {c: index + 0.5, t: 1_000_000 + index},
        }
    })
    const value = [Pkt.CB, 1, [{seq: 1, ts: 1, event: [rows]}]]
    const strict = createTestCodec({maxSchemas: 32, promotionThreshold: 1})
    const trusted = createTestCodec({maxSchemas: 32, promotionThreshold: 1})
    const receiver = createTestCodec({maxSchemas: 32, promotionThreshold: 1})
    const strictWire = strict.encode(value)
    const prepared = trusted.prepareEncodeTrusted(value)
    prepared.commit()

    assert.deepEqual(prepared.wire, strictWire, 'trusted RPC path keeps the strict wire format')
    assertExactValue(receiver.decode(prepared.wire), value)

    const variants = [
        {path: ['A'], exists: true, value: {c: 1, t: 2}},
        {path: ['B'], exists: false, value: {c: '2', t: null}},
        {path: ['C'], exists: true, value: {c: 3.5, t: 4}},
        {path: ['D'], exists: false, value: {c: '4', t: null}},
    ]
    const measured = trusted.measureEncodeTrusted(variants)
    const variantPrepared = trusted.prepareEncodeTrusted(variants)
    assert.equal(variantPrepared.wire.byteLength, measured)
    variantPrepared.commit()
    assertExactValue(receiver.decode(variantPrepared.wire), variants)
}

export async function runRpcBinarySchemaTests() {
    let failures = 0
    const tests = [
        ['predeclared prelude sends descriptions, not sample values',
            testPredeclaredPreludeContainsDescriptionsNotSampleValues],
        ['prelude decode is transactional', testPreludeDecodeIsTransactional],
        ['dynamic schema promotes only at its frequency threshold',
            testDynamicSchemaPromotesOnlyAtFrequencyThreshold],
        ['rare layouts do not consume promoted-schema budget',
            testRareLayoutsDoNotConsumePromotedSchemaBudget],
        ['schema cap falls back while existing references survive',
            testSchemaCapFallsBackWithoutBreakingExistingReferences],
        ['hard schema cap and option boundaries', testHardSchemaCapAndOptionBoundaries],
        ['same keys with string/number/boolean/null variants stay exact',
            testSameKeysWithDifferentTypesUseExactVariants],
        ['predeclared mismatch falls back without poisoning original schema',
            testPredeclaredMismatchFallsBackAndOriginalSchemaSurvives],
        ['700 rows × 30 fields use compact typed runs', testThirtyFieldRowsUseTypedRunAndStayCompact],
        ['nested repeated layouts use recursive schemas', testNestedRepeatedLayoutsUseRecursiveSchemas],
        ['RPC-style tuples preserve positional types and callback refs',
            testRpcStyleTuplesKeepPositionTypesAndCallbackRefs],
        ['RESP tuple preserves a nested 700 × 30 typed run', testNestedRpcResponseRowsUseTypedRun],
        ['CB args preserve a doubly nested 700 × 30 typed run',
            testNestedCallbackArgumentRowsUseTypedRun],
        ['bulk nested collection pays schema admission in its first frame',
            testBulkNestedCollectionPaysAdmissionInFirstFrame],
        ['nested collections preserve mixed, empty and variable-length values',
            testNestedCollectionsPreserveMixedEmptyAndVariableValues],
        ['bulk admission rollback and small one-off remain transactional',
            testBulkAdmissionRollbackAndSmallOneOffStayTransactional],
        ['Store ReplayEvent preserves a 15,000-key value run',
            testStoreReplaySnapshotDictionaryUsesValueRun],
        ['homogeneous runs preserve sizes 1, 10, 50 and 700', testHomogeneousRunSizeMatrix],
        ['grouped mixed layouts use ordered segmented runs', testGroupedMixedLayoutsUseSegmentedRuns],
        ['alternating mixed layouts keep exact ordered segments',
            testAlternatingMixedLayoutsKeepOrderedSegments],
        ['binary leaves use direct root and schema-field paths',
            testDirectBinaryLeavesAvoidGenericWrappers],
        ['rich and exact values survive generic fallback', testGenericFallbackPreservesRichAndExactValues],
        ['prepared promotion rollback preserves schema ids',
            testPreparedPromotionRollbackDoesNotConsumeSchemaId],
        ['encode/decode failures leave schema caches transactional',
            testEncodeAndDecodeFailuresAreTransactional],
        ['measure matches cold/warm encode without mutating state',
            testMeasurementMatchesColdWarmAndDoesNotMutateState],
        ['reset starts a fresh generation and replays predeclared schemas',
            testResetStartsFreshGenerationAndReplaysPredeclaredSchemas],
        ['encode/decode directions learn independent schemas',
            testDirectionsCanLearnDifferentSchemaSequences],
        ['trusted RPC encode matches strict wire and preserves kind changes',
            testTrustedEncodeMatchesStrictWireAndKeepsKindChangesExact],
    ] as const

    console.log('\n--- universal typed-schema binary codec ---')
    for (const [name, run] of tests) {
        try {
            await run()
            console.log('PASS  ' + name)
        } catch (error: any) {
            failures++
            console.log('FAIL  ' + name + ': ' + String(error?.message ?? error))
        }
    }
    console.log(failures == 0
        ? 'RPC schema binary codec tests: OK'
        : 'RPC schema binary codec tests: ' + failures + ' FAILED')
    return failures
}

if (require.main === module) {
    runRpcBinarySchemaTests().then(function finish(failures) {
        process.exit(failures == 0 ? 0 : 1)
    })
}
