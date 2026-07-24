// ===========================================================================
// Universal binary RPC — pure codec, envelope and peer contracts
//
// These tests deliberately avoid sockets. A failure here identifies byte-format
// or cache-state corruption separately from RPC negotiation and routing.
// ===========================================================================

import * as assert from 'node:assert/strict'
import {
    createBinaryValueCodec,
    createRpcBinaryCallbackRef,
    rpcBinaryCallbackRefId,
    type BinaryValueCodecOptions,
} from './rpc-binary-value'
import {
    encodeRpcBinaryControl,
    inspectRpcBinaryEnvelope,
    isRpcBinaryEnvelope,
    RpcBinaryFrame,
    wrapRpcBinaryPacket,
} from './rpc-binary-envelope'
import {createRpcBinaryPeer, type RpcBinaryPeer} from './rpc-binary-peer'
import {
    snapshotRpcBinaryResult,
    validateRpcBinaryResult,
} from './rpc-binary-walk'

const TEST_MAGIC = [0x54, 0x42, 0x43] as const
const TEST_VERSION = 7

const ValueTag = {
    FALSE: 2,
    INTEGER: 4,
    ARRAY: 9,
    OBJECT: 10,
    CALLBACK_REF: 19,
    OBJECT_SHAPE_DEF: 20,
    OBJECT_SHAPE_REF: 21,
} as const

const MAX_CALLBACK_REFS_PER_VALUE = 1_024

function createTestCodec(
    shapeCache: BinaryValueCodecOptions['shapeCache'] = {maxEntries: 1_000},
    callbackRefs = false,
) {
    return createBinaryValueCodec({
        magic: TEST_MAGIC,
        version: TEST_VERSION,
        label: 'RPC binary codec test',
        callbackRefs,
        shapeCache,
    })
}

function varUintReference(value: bigint) {
    const bytes: number[] = []
    let remaining = value
    do {
        const payload = Number(remaining & 0x7fn)
        remaining >>= 7n
        bytes.push(remaining == 0n ? payload : payload | 0x80)
    } while (remaining != 0n)
    return bytes
}

function integerValueWire(zigzag: bigint) {
    return Uint8Array.from([
        ...TEST_MAGIC,
        TEST_VERSION,
        ValueTag.INTEGER,
        ...varUintReference(zigzag),
    ])
}

function integerValueReference(value: number) {
    const integer = BigInt(value)
    const zigzag = integer < 0n ? (-integer * 2n) - 1n : integer * 2n
    return integerValueWire(zigzag)
}

function copyWithTrailingByte(wire: Uint8Array, byte = 0xff) {
    const copy = new Uint8Array(wire.byteLength + 1)
    copy.set(wire)
    copy[wire.byteLength] = byte
    return copy
}

function viewBytes(value: ArrayBufferView) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function assertExactValue(actual: unknown, expected: unknown, label = 'value'): void {
    if (typeof expected == 'number') {
        assert.ok(Object.is(actual, expected), label + ' keeps the exact number')
        return
    }
    if (expected == null || typeof expected != 'object') {
        assert.equal(actual, expected, label)
        return
    }
    assert.ok(actual != null && typeof actual == 'object', label + ' remains an object')

    if (expected instanceof Date) {
        assert.equal(Object.getPrototypeOf(actual), Date.prototype, label + ' remains Date')
        assert.ok(Object.is((actual as Date).valueOf(), expected.valueOf()), label + ' keeps Date value')
        return
    }
    if (expected instanceof RegExp) {
        assert.equal(Object.getPrototypeOf(actual), RegExp.prototype, label + ' remains RegExp')
        assert.equal((actual as RegExp).source, expected.source, label + ' keeps RegExp source')
        assert.equal((actual as RegExp).flags, expected.flags, label + ' keeps RegExp flags')
        assert.ok(
            Object.is((actual as RegExp).lastIndex, expected.lastIndex),
            label + ' keeps RegExp lastIndex',
        )
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
            Array.from(viewBytes(actual as ArrayBufferView)),
            Array.from(viewBytes(expected)),
            label + ' keeps view bytes',
        )
        return
    }
    if (expected instanceof Map) {
        assert.equal(Object.getPrototypeOf(actual), Map.prototype, label + ' remains Map')
        const actualEntries = Array.from((actual as Map<unknown, unknown>).entries())
        const expectedEntries = Array.from(expected.entries())
        assert.equal(actualEntries.length, expectedEntries.length, label + ' keeps Map size')
        for (let index = 0; index < expectedEntries.length; index++) {
            assertExactValue(actualEntries[index][0], expectedEntries[index][0], label + ' Map key ' + index)
            assertExactValue(actualEntries[index][1], expectedEntries[index][1], label + ' Map value ' + index)
        }
        return
    }
    if (expected instanceof Set) {
        assert.equal(Object.getPrototypeOf(actual), Set.prototype, label + ' remains Set')
        const actualItems = Array.from((actual as Set<unknown>).values())
        const expectedItems = Array.from(expected.values())
        assert.equal(actualItems.length, expectedItems.length, label + ' keeps Set size')
        for (let index = 0; index < expectedItems.length; index++) {
            assertExactValue(actualItems[index], expectedItems[index], label + ' Set value ' + index)
        }
        return
    }
    if (Array.isArray(expected)) {
        assert.ok(Array.isArray(actual), label + ' remains Array')
        assert.equal((actual as unknown[]).length, expected.length, label + ' keeps Array length')
        for (let index = 0; index < expected.length; index++) {
            const actualOwn: boolean = Object.prototype.hasOwnProperty.call(actual, index)
            const expectedOwn: boolean = Object.prototype.hasOwnProperty.call(expected, index)
            assert.equal(actualOwn, expectedOwn, label + ' keeps hole at ' + index)
            if (expectedOwn) {
                assertExactValue(
                    (actual as unknown[])[index],
                    expected[index],
                    label + ' Array value ' + index,
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
    const actualKeys = Object.keys(actual as object)
    const expectedKeys = Object.keys(expected)
    assert.deepEqual(actualKeys, expectedKeys, label + ' keeps object keys and order')
    for (const key of expectedKeys) {
        assertExactValue(
            (actual as Record<string, unknown>)[key],
            (expected as Record<string, unknown>)[key],
            label + '.' + key,
        )
    }
}

function packetPayload(wire: Uint8Array, expectedSessionId: number) {
    const envelope = inspectRpcBinaryEnvelope(wire)
    assert.ok(envelope, 'peer output is an RPC binary envelope')
    assert.equal(envelope.kind, RpcBinaryFrame.PACKET)
    assert.equal(envelope.sessionId, expectedSessionId)
    return envelope.payload
}

function transfer(
    source: RpcBinaryPeer,
    target: RpcBinaryPeer,
    sessionId: number,
    packet: any[],
) {
    const prepared = source.prepare(packet)
    prepared.commit()
    return target.decode(packetPayload(prepared.wire, sessionId))
}

function testExactPrimitiveRichSparseAndNullPrototypeValues() {
    const sparse: unknown[] = []
    sparse.length = 5
    sparse[1] = undefined
    sparse[3] = 'present'

    const nullPrototype = Object.create(null) as Record<string, unknown>
    nullPrototype.name = 'null-prototype'
    nullPrototype.enabled = false

    const arrayBuffer = Uint8Array.from([0, 1, 127, 128, 255]).buffer
    const dataViewSource = Uint8Array.from([9, 8, 7, 6, 5])
    const dataView = new DataView(dataViewSource.buffer, 1, 3)
    const value = [
        undefined,
        null,
        false,
        true,
        0,
        -0,
        1,
        -1,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
        1.25,
        NaN,
        Infinity,
        -Infinity,
        '',
        'Привет 🌍',
        '\uFEFFleading-bom',
        '\ud800',
        0n,
        -123456789012345678901234567890n,
        sparse,
        {plain: true, nested: {value: undefined}},
        nullPrototype,
        new Date(1_725_000_123_456),
        new Date(NaN),
        /a+b?/giu,
        new Map<unknown, unknown>([
            ['one', 1],
            [{key: 'object'}, new Set([false, 'two'])],
        ]),
        new Set<unknown>([undefined, 3n, {set: 'object'}]),
        arrayBuffer,
        dataView,
        new Int16Array([-32768, -1, 0, 32767]),
        new Float64Array([-0, NaN, Infinity]),
    ]

    const sender = createTestCodec()
    const receiver = createTestCodec()
    const decoded = receiver.decode(sender.encode(value))
    assertExactValue(decoded, value)
}

function testSafeIntegerFastPathMatchesBigIntReference() {
    const values = new Set<number>([
        0,
        1,
        -1,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
    ])
    for (let exponent = 0; exponent <= 52; exponent++) {
        const base = 2 ** exponent
        for (const delta of [-2, -1, 0, 1, 2]) {
            const value = base + delta
            if (!Number.isSafeInteger(value) || value < 0) continue
            values.add(value)
            values.add(-value)
        }
    }

    let randomState = 0x5a17c9e3
    function randomUint32() {
        randomState ^= randomState << 13
        randomState ^= randomState >>> 17
        randomState ^= randomState << 5
        return randomState >>> 0
    }
    for (let index = 0; index < 5_000; index++) {
        const high = randomUint32() & 0x1fffff
        const low = randomUint32()
        const magnitude = high * 0x100000000 + low
        values.add((randomUint32() & 1) == 0 ? magnitude : -magnitude)
    }

    const codec = createTestCodec(false)
    for (const value of values) {
        const wire = codec.encode(value)
        assert.deepEqual(wire, integerValueReference(value), 'integer wire remains byte-compatible')
        assert.ok(Object.is(codec.decode(wire), value), 'integer round-trip remains exact')
    }

    const overflowZigzag = BigInt(Number.MAX_SAFE_INTEGER) * 2n + 1n
    assert.throws(function rejectIntegerOverflow() {
        codec.decode(integerValueWire(overflowZigzag))
    }, /integer overflows/)
    assert.throws(function rejectNonCanonicalInteger() {
        codec.decode(Uint8Array.from([
            ...TEST_MAGIC,
            TEST_VERSION,
            ValueTag.INTEGER,
            0x81,
            0,
        ]))
    }, /integer has non-canonical varuint/)
    assert.throws(function rejectIntegerVarUintBeyondEightBytes() {
        codec.decode(Uint8Array.from([
            ...TEST_MAGIC,
            TEST_VERSION,
            ValueTag.INTEGER,
            0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0,
        ]))
    }, /integer varuint exceeds limit/)
}

function testMeasuredLengthMatchesColdAndWarmEncoding() {
    const codec = createTestCodec()
    const values = [
        {symbol: 'BTCUSDT', price: 61_234.5, active: true},
        {symbol: 'ETHUSDT', price: 3_456.75, active: false},
        {
            nested: [{value: undefined}, new Map([['count', 7]])],
            text: '\uFEFF' + 'котировка'.repeat(40),
            bytes: new Uint8Array(64 * 1024),
        },
    ]

    for (const value of values) {
        const before = codec.stats()
        const measured = codec.measureEncode(value)
        const afterMeasure = codec.stats()
        assert.deepEqual(afterMeasure, before, 'measurement does not commit shape state')
        assert.equal(codec.encode(value).byteLength, measured, 'measurement matches emitted bytes')
    }

    const prepared = codec.prepareEncode({pending: true})
    assert.throws(function rejectMeasureDuringPreparedEncode() {
        codec.measureEncode({later: true})
    }, /prepared encode must be committed or rolled back/)
    prepared.rollback()
    assert.equal(codec.measureEncode({later: true}), codec.encode({later: true}).byteLength)
}

function testShapeSignaturesStayDistinctForArbitraryKeys() {
    const sender = createTestCodec()
    const receiver = createTestCodec()
    const first = {'1:a': 1, '2': 2, '\0': 3}
    const second = {'1': 4, 'a2:': 5, '\ud800': 6}

    assertExactValue(receiver.decode(sender.encode(first)), first)
    assertExactValue(receiver.decode(sender.encode(second)), second)
    assertExactValue(receiver.decode(sender.encode({'1:a': 7, '2': 8, '\0': 9})), {'1:a': 7, '2': 8, '\0': 9})
    assertExactValue(receiver.decode(sender.encode({'1': 10, 'a2:': 11, '\ud800': 12})), {'1': 10, 'a2:': 11, '\ud800': 12})
    assert.equal(sender.stats().encodeShapes, 2)
    assert.equal(sender.stats().encodeReferences, 2)
}

function testDecodedObjectsAvoidInheritedSetters() {
    const setterKey = '__rpc_binary_test_setter__'
    const lockedKey = '__rpc_binary_test_locked__'
    let setterCalls = 0
    Object.defineProperty(Object.prototype, setterKey, {
        configurable: true,
        get() { return 'inherited getter' },
        set() { setterCalls++ },
    })
    Object.defineProperty(Object.prototype, lockedKey, {
        configurable: true,
        value: 'inherited locked value',
        writable: false,
    })
    try {
        const expected: Record<string, unknown> = {
            [setterKey]: 'own setter value',
            [lockedKey]: 'own locked value',
            normal: 1,
        }
        Object.defineProperty(expected, '__proto__', {
            configurable: true,
            enumerable: true,
            value: 'own proto value',
            writable: true,
        })
        const decoded = createTestCodec().decode(createTestCodec().encode(expected))
        const walkExpected = {
            [setterKey]: 'walk setter value',
            [lockedKey]: 'walk locked value',
            normal: 2,
        }
        const validated = validateRpcBinaryResult(walkExpected)
        const snapshotted = snapshotRpcBinaryResult(walkExpected)

        assertExactValue(decoded, expected)
        assertExactValue(validated, walkExpected)
        assertExactValue(snapshotted, walkExpected)
        assert.equal(setterCalls, 0)
        for (const key of [setterKey, lockedKey, '__proto__']) {
            const descriptor = Object.getOwnPropertyDescriptor(decoded as object, key)
            assert.ok(descriptor)
            assert.equal(descriptor.enumerable, true)
            assert.equal(descriptor.configurable, true)
            assert.equal(descriptor.writable, true)
        }
        assert.equal(Object.getPrototypeOf(decoded), Object.prototype)
        assert.equal(({} as any)[setterKey], 'inherited getter')
    } finally {
        Reflect.deleteProperty(Object.prototype, setterKey)
        Reflect.deleteProperty(Object.prototype, lockedKey)
    }
}

function testLeadingBomKeepsValuesAndShapeCacheDistinct() {
    const sender = createTestCodec()
    const receiver = createTestCodec()
    const bomKey = '\uFEFFx'
    const first = {[bomKey]: 1}
    const second = {x: 2}

    assertExactValue(receiver.decode(sender.encode('\uFEFFvalue')), '\uFEFFvalue')
    assertExactValue(receiver.decode(sender.encode(first)), first)
    assertExactValue(receiver.decode(sender.encode(second)), second)
    assert.equal(sender.stats().encodeShapes, 2)
    assert.equal(receiver.stats().decodeShapes, 2)

    assertExactValue(receiver.decode(sender.encode({[bomKey]: 3})), {[bomKey]: 3})
    assertExactValue(receiver.decode(sender.encode({x: 4})), {x: 4})
    assert.equal(sender.stats().encodeReferences, 2)
    assert.equal(receiver.stats().decodeReferences, 2)
}

function defineNativeShadow<T extends object>(value: T, key: string, shadow: unknown) {
    Object.defineProperty(value, key, {
        configurable: true,
        value: shadow,
    })
    return value
}

function assertNativeValueRejected(value: object, pattern: RegExp) {
    assert.throws(function encodeUnsupportedNativeState() {
        createTestCodec(false).encode(value)
    }, pattern)
    assert.throws(function validateUnsupportedNativeState() {
        validateRpcBinaryResult(value)
    }, pattern)
    assert.throws(function snapshotUnsupportedNativeState() {
        snapshotRpcBinaryResult(value)
    }, pattern)
}

function testNativeOwnStateFailsClosedAndEncodeRecovers() {
    const customSymbol = Symbol('custom-native-state')
    const date = Object.assign(new Date(0), {custom: 1})
    const regexp = /a/g
    Object.defineProperty(regexp, customSymbol, {value: 2})
    const map = new Map<unknown, unknown>([['key', 'value']])
    Object.defineProperty(map, 'custom', {get: () => 3})
    const set = Object.assign(new Set<unknown>([1]), {custom: 4})
    const arrayBuffer = new ArrayBuffer(4)
    Object.defineProperty(arrayBuffer, customSymbol, {value: 5})
    const dataView = new DataView(new ArrayBuffer(4))
    Object.defineProperty(dataView, 'custom', {get: () => 6})
    const typedArray = Object.assign(new Uint16Array([1, 2]), {custom: 7})

    for (const value of [
        date,
        regexp,
        map,
        set,
        arrayBuffer,
        dataView,
        typedArray,
    ]) {
        assertNativeValueRejected(value, /custom own properties|custom accessors/)
    }

    const advanced = /a/g
    advanced.lastIndex = 3
    assertNativeValueRejected(
        advanced,
        /RegExp lastIndex must be zero with its standard descriptor/,
    )

    const nonStandardDescriptor = /a/g
    Object.defineProperty(nonStandardDescriptor, 'lastIndex', {writable: false})
    assertNativeValueRejected(
        nonStandardDescriptor,
        /RegExp lastIndex must be zero with its standard descriptor/,
    )

    const sender = createTestCodec()
    const stagedBeforeFailure = Object.assign(new Date(0), {custom: 'reject'})
    assert.throws(function rejectAfterStagingShape() {
        sender.encode([{staged: true}, stagedBeforeFailure])
    }, /Date custom own properties are not supported/)
    assert.equal(sender.stats().encodeShapes, 0)
    assert.equal(sender.stats().encodeDefinitions, 0)
    assert.equal(sender.stats().pendingEncode, false)

    const receiver = createTestCodec()
    const valid = {staged: 'recovered'}
    const wire = sender.encode(valid)
    assert.equal(wire[TEST_MAGIC.length + 1], ValueTag.OBJECT_SHAPE_DEF)
    assertExactValue(receiver.decode(wire), valid)
    assert.equal(sender.stats().encodeShapes, 1)
}

function testNativeShadowsAndRuntimeNewRegExpFlagsFailClosed() {
    const shadowed = [
        defineNativeShadow(new Date(0), 'valueOf', () => 123),
        defineNativeShadow(/a/g, 'source', 'b'),
        defineNativeShadow(new ArrayBuffer(4), 'byteLength', 0),
        defineNativeShadow(new DataView(new ArrayBuffer(4)), 'byteOffset', 1),
        defineNativeShadow(new Uint16Array([1, 2]), 'byteLength', 0),
        defineNativeShadow(new Uint8Array([1, 2]), 'constructor', Uint16Array),
    ]

    for (const value of shadowed) {
        assert.throws(function encodeNativeShadow() {
            createTestCodec(false).encode(value)
        }, /shadow is not supported/)
        assert.throws(function validateNativeShadow() {
            validateRpcBinaryResult(value)
        }, /shadow is not supported/)
        assert.throws(function snapshotNativeShadow() {
            snapshotRpcBinaryResult(value)
        }, /shadow is not supported/)
    }

    function assertDynamicBufferRejected(value: object) {
        assert.throws(function encodeDynamicBuffer() {
            createTestCodec(false).encode(value)
        }, /resizable and growable binary buffers are not supported in protocol v1/)
        assert.throws(function validateDynamicBuffer() {
            validateRpcBinaryResult(value)
        }, /resizable and growable binary buffers are not supported in protocol v1/)
        assert.throws(function snapshotDynamicBuffer() {
            snapshotRpcBinaryResult(value)
        }, /resizable and growable binary buffers are not supported in protocol v1/)
    }

    let resizable: ArrayBuffer | undefined
    try {
        resizable = new (ArrayBuffer as any)(4, {maxByteLength: 8})
    } catch {
        // Node 16 has no resizable ArrayBuffer constructor option.
    }
    if ((resizable as any)?.resizable == true) {
        assertDynamicBufferRejected(resizable!)
        assertDynamicBufferRejected(new DataView(resizable!))
    }

    const SharedArrayBufferConstructor = (globalThis as any).SharedArrayBuffer
    if (typeof SharedArrayBufferConstructor == 'function') {
        const fixedView = new Uint8Array(new SharedArrayBufferConstructor(4))
        fixedView.set([1, 2, 3, 4])
        assertExactValue(
            createTestCodec(false).decode(createTestCodec(false).encode(fixedView)),
            fixedView,
        )

        let growable: object | undefined
        try {
            growable = new SharedArrayBufferConstructor(4, {maxByteLength: 8})
        } catch {
            // This runtime supports fixed SharedArrayBuffer only.
        }
        if ((growable as any)?.growable == true) {
            assertDynamicBufferRejected(growable!)
            assertDynamicBufferRejected(new Uint8Array(growable as any))
        }
    }

    const baseline = new RegExp('a', 'dgimsuy')
    assertExactValue(
        createTestCodec(false).decode(createTestCodec(false).encode(baseline)),
        baseline,
    )

    const sender = createTestCodec(false)
    const futureFlagWire = sender.encode(/a/u).slice()
    assert.equal(futureFlagWire[futureFlagWire.length - 1], 'u'.charCodeAt(0))
    futureFlagWire[futureFlagWire.length - 1] = 'v'.charCodeAt(0)
    assert.throws(function decodeFutureRegExpFlag() {
        createTestCodec(false).decode(futureFlagWire)
    }, /RegExp flags are unsupported or non-canonical in protocol v1/)

    let futureRegExp: RegExp | undefined
    try {
        futureRegExp = new RegExp('a', 'v')
    } catch {
        // Node 16 cannot construct this flag; the mutated-wire assertion above
        // still verifies that its v1 decoder rejects a newer peer's bytes.
    }
    if (futureRegExp) {
        assert.throws(function encodeFutureRegExpFlag() {
            createTestCodec(false).encode(futureRegExp)
        }, /RegExp flags are unsupported or non-canonical in protocol v1/)
        assert.throws(function walkFutureRegExpFlag() {
            validateRpcBinaryResult(futureRegExp)
        }, /RegExp flags are unsupported or non-canonical in protocol v1/)
    }

    function wireWithRegExpSource(source: string) {
        const baselineSource = 'a'.repeat(source.length)
        const wire = createTestCodec(false).encode(new RegExp(baselineSource)).slice()
        const baselineBytes = Array.from(baselineSource, char => char.charCodeAt(0))
        const offset = wire.findIndex(function findBaseline(byte, index) {
            return byte == baselineBytes[0]
                && baselineBytes.every((expected, inner) => wire[index + inner] == expected)
        })
        assert.ok(offset >= 0)
        wire.set(Array.from(source, char => char.charCodeAt(0)), offset)
        return wire
    }

    const inlineSource = '(?i:a)'
    assert.throws(function decodeInlineModifierGroup() {
        createTestCodec(false).decode(wireWithRegExpSource(inlineSource))
    }, /RegExp source syntax is unsupported in protocol v1/)

    let inlineRegExp: RegExp | undefined
    try {
        inlineRegExp = new RegExp(inlineSource)
    } catch {
        // Baseline Node 16 rejects inline modifiers at construction time.
    }
    if (inlineRegExp) {
        assert.throws(function encodeInlineModifierGroup() {
            createTestCodec(false).encode(inlineRegExp)
        }, /RegExp source syntax is unsupported in protocol v1/)
        assert.throws(function walkInlineModifierGroup() {
            validateRpcBinaryResult(inlineRegExp)
        }, /RegExp source syntax is unsupported in protocol v1/)
    }

    const duplicateGroups = '(?<x>a)|(?<x>b)'
    assert.throws(function decodeDuplicateNamedGroups() {
        createTestCodec(false).decode(wireWithRegExpSource(duplicateGroups))
    }, /RegExp source syntax is unsupported in protocol v1/)
}

function testColdDefinitionThenWarmReference() {
    const sender = createTestCodec()
    const receiver = createTestCodec()
    const coldValue = {symbol: 'BTCUSDT', price: 67_001}
    const warmValue = {symbol: 'ETHUSDT', price: 3_501}

    const cold = sender.encode(coldValue)
    assert.equal(cold[TEST_MAGIC.length + 1], ValueTag.OBJECT_SHAPE_DEF)
    assertExactValue(receiver.decode(cold), coldValue)
    assert.deepEqual(sender.stats(), {
        generation: 0,
        pendingEncode: false,
        encodeShapes: 1,
        decodeShapes: 0,
        encodeFieldRefs: 2,
        decodeFieldRefs: 0,
        encodeKeyTextBytes: 11,
        decodeKeyTextBytes: 0,
        encodeDefinitions: 1,
        encodeReferences: 0,
        encodeRawShapes: 0,
        decodeDefinitions: 0,
        decodeReferences: 0,
    })

    const warm = sender.encode(warmValue)
    assert.equal(warm[TEST_MAGIC.length + 1], ValueTag.OBJECT_SHAPE_REF)
    assert.ok(warm.byteLength < cold.byteLength, 'warm REF omits the repeated field names')
    assertExactValue(receiver.decode(warm), warmValue)
    assert.equal(sender.stats().encodeShapes, 1)
    assert.equal(sender.stats().encodeDefinitions, 1)
    assert.equal(sender.stats().encodeReferences, 1)
    assert.equal(receiver.stats().decodeShapes, 1)
    assert.equal(receiver.stats().decodeDefinitions, 1)
    assert.equal(receiver.stats().decodeReferences, 1)
}

function testOneShapeKeepsPolymorphicValueTagsExact() {
    const sender = createTestCodec()
    const receiver = createTestCodec()
    const values = [
        {value: 'seven'},
        {value: 7},
        {value: false},
    ]
    const wires = values.map(function encodePolymorphic(value) {
        return sender.encode(value)
    })

    assert.equal(wires[0][TEST_MAGIC.length + 1], ValueTag.OBJECT_SHAPE_DEF)
    assert.equal(wires[1][TEST_MAGIC.length + 1], ValueTag.OBJECT_SHAPE_REF)
    assert.equal(wires[2][TEST_MAGIC.length + 1], ValueTag.OBJECT_SHAPE_REF)
    assert.equal(wires[1][TEST_MAGIC.length + 3], ValueTag.INTEGER)
    assert.equal(wires[2][TEST_MAGIC.length + 3], ValueTag.FALSE)

    const decoded = wires.map(function decodePolymorphic(wire) {
        return receiver.decode(wire) as {value: unknown}
    })
    assert.equal(typeof decoded[0].value, 'string')
    assert.equal(decoded[0].value, 'seven')
    assert.equal(typeof decoded[1].value, 'number')
    assert.ok(Object.is(decoded[1].value, 7))
    assert.equal(typeof decoded[2].value, 'boolean')
    assert.equal(decoded[2].value, false)
    assert.equal(sender.stats().encodeShapes, 1)
    assert.equal(sender.stats().encodeDefinitions, 1)
    assert.equal(sender.stats().encodeReferences, 2)
}

function testThousandShapeBudgetFallsBackToRaw() {
    const sender = createTestCodec({maxEntries: 1_000})
    const receiver = createTestCodec({maxEntries: 1_000})

    for (let index = 0; index < 1_000; index++) {
        const value = {[String.fromCharCode(97 + (index % 26)) + index]: index}
        assertExactValue(receiver.decode(sender.encode(value)), value)
    }
    assert.equal(sender.stats().encodeShapes, 1_000)
    assert.equal(receiver.stats().decodeShapes, 1_000)

    const overflow = {shape_1000: 'raw'}
    const rawWire = sender.encode(overflow)
    assert.equal(rawWire[TEST_MAGIC.length + 1], ValueTag.OBJECT)
    assertExactValue(receiver.decode(rawWire), overflow)
    assert.equal(sender.stats().encodeShapes, 1_000)
    assert.equal(receiver.stats().decodeShapes, 1_000)
    assert.equal(sender.stats().encodeRawShapes, 1)

    const first = {a0: 'still-cached'}
    const firstWire = sender.encode(first)
    assert.equal(firstWire[TEST_MAGIC.length + 1], ValueTag.OBJECT_SHAPE_REF)
    assertExactValue(receiver.decode(firstWire), first)
    assert.equal(sender.stats().encodeShapes, 1_000)
    assert.equal(sender.stats().encodeReferences, 1)
    assert.equal(receiver.stats().decodeReferences, 1)
}

function testPeerDirectionsHaveIndependentShapeCaches() {
    const sessionId = 128
    const left = createRpcBinaryPeer({sessionId, maxShapes: 1_000})
    const right = createRpcBinaryPeer({sessionId, maxShapes: 1_000})

    assertExactValue(
        transfer(left, right, sessionId, [1, {leftValue: 'one'}]),
        [1, {leftValue: 'one'}],
    )
    assertExactValue(
        transfer(right, left, sessionId, [2, {rightValue: 2}]),
        [2, {rightValue: 2}],
    )
    assert.equal(left.stats().encodeShapes, 1)
    assert.equal(left.stats().decodeShapes, 1)
    assert.equal(right.stats().encodeShapes, 1)
    assert.equal(right.stats().decodeShapes, 1)

    transfer(left, right, sessionId, [3, {leftValue: false}])
    transfer(right, left, sessionId, [4, {rightValue: 'four'}])
    assert.equal(left.stats().encodeReferences, 1)
    assert.equal(left.stats().decodeReferences, 1)
    assert.equal(right.stats().encodeReferences, 1)
    assert.equal(right.stats().decodeReferences, 1)
}

function testPrepareRollbackAndEncodeFailureDoNotPoisonCache() {
    const codec = createTestCodec()
    const prepared = codec.prepareEncode({rolledBack: 1})
    assert.equal(codec.stats().pendingEncode, true)
    assert.equal(codec.stats().encodeShapes, 0)
    prepared.rollback()
    assert.equal(codec.stats().pendingEncode, false)
    assert.equal(codec.stats().encodeShapes, 0)
    assert.equal(codec.stats().encodeDefinitions, 0)

    const cyclic: unknown[] = []
    cyclic.push({stagedBeforeFailure: true}, cyclic)
    assert.throws(
        function encodeCyclicAfterStagedShape() {
            codec.encode(cyclic)
        },
        /cyclic values are not supported/,
    )
    assert.equal(codec.stats().pendingEncode, false)
    assert.equal(codec.stats().encodeShapes, 0)
    assert.equal(codec.stats().encodeDefinitions, 0)

    const receiver = createTestCodec()
    const valid = {stagedBeforeFailure: 'valid'}
    const wire = codec.encode(valid)
    assert.equal(wire[TEST_MAGIC.length + 1], ValueTag.OBJECT_SHAPE_DEF)
    assertExactValue(receiver.decode(wire), valid)
    assert.equal(codec.stats().encodeShapes, 1)
}

function testDecodeFailuresAreTransactional() {
    const sender = createTestCodec()
    const definition = sender.encode({alpha: 1})
    const receiver = createTestCodec()

    for (let length = 0; length < definition.byteLength; length++) {
        assert.throws(function decodeTruncatedAtEveryByte() {
            receiver.decode(definition.subarray(0, length))
        })
        assert.equal(receiver.stats().decodeShapes, 0, 'truncation cannot install a shape')
        assert.equal(receiver.stats().decodeDefinitions, 0, 'truncation cannot update stats')
    }

    assert.throws(function decodeDefinitionWithTrailingByte() {
        receiver.decode(copyWithTrailingByte(definition))
    }, /trailing bytes/)
    assert.equal(receiver.stats().decodeShapes, 0)
    assertExactValue(receiver.decode(definition), {alpha: 1})
    assert.equal(receiver.stats().decodeShapes, 1)

    const duplicate = definition.slice()
    const definitionIdOffset = TEST_MAGIC.length + 2
    assert.equal(duplicate[definitionIdOffset], 0)
    duplicate[definitionIdOffset] = 1
    assert.throws(function decodeDuplicateDefinition() {
        receiver.decode(duplicate)
    }, /duplicate object shape declaration/)
    assert.equal(receiver.stats().decodeShapes, 1)
    assert.equal(receiver.stats().decodeDefinitions, 1)

    const secondDefinition = sender.encode({beta: 2})
    assert.throws(function decodeStagedDefinitionWithTrailingByte() {
        receiver.decode(copyWithTrailingByte(secondDefinition))
    }, /trailing bytes/)
    assert.equal(receiver.stats().decodeShapes, 1, 'failed staged DEF is rolled back')
    assert.equal(receiver.stats().decodeDefinitions, 1)
    assertExactValue(receiver.decode(secondDefinition), {beta: 2})
    assert.equal(receiver.stats().decodeShapes, 2)

    const reference = sender.encode({alpha: 3})
    const emptyReceiver = createTestCodec()
    assert.equal(reference[TEST_MAGIC.length + 1], ValueTag.OBJECT_SHAPE_REF)
    assert.throws(function decodeUnknownReference() {
        emptyReceiver.decode(reference)
    }, /unknown object shape reference/)
    assert.equal(emptyReceiver.stats().decodeShapes, 0)
    assert.equal(emptyReceiver.stats().decodeReferences, 0)
}

function testCallbackReferenceGate() {
    const enabledSender = createTestCodec(false, true)
    const enabledReceiver = createTestCodec(false, true)
    const disabled = createTestCodec(false, false)
    const reference = createRpcBinaryCallbackRef(91)
    const wire = enabledSender.encode(reference)

    assert.equal(rpcBinaryCallbackRefId(enabledReceiver.decode(wire)), 91)
    assert.throws(function encodeCallbackRefWhenDisabled() {
        disabled.encode(reference)
    }, /callback references are disabled/)
    assert.throws(function decodeCallbackRefWhenDisabled() {
        disabled.decode(wire)
    }, /callback references are disabled/)
}

function createCallbackReferences(count: number) {
    return Array.from({length: count}, function createCallbackReference(_, index) {
        return createRpcBinaryCallbackRef(index)
    })
}

function addOneCallbackReferenceToBoundaryWire(wire: Uint8Array) {
    const pattern = [
        ValueTag.ARRAY,
        0x80,
        0x08,
        ValueTag.CALLBACK_REF,
        0,
    ]
    let arrayOffset = -1
    for (let offset = TEST_MAGIC.length + 1; offset <= wire.byteLength - pattern.length; offset++) {
        if (pattern.every((byte, index) => wire[offset + index] == byte)) {
            arrayOffset = offset
            break
        }
    }
    assert.notEqual(arrayOffset, -1, 'boundary callback array is present in encoded wire')

    const overflow = new Uint8Array(wire.byteLength + 2)
    overflow.set(wire)
    // 1024 and 1025 share a two-byte canonical varuint.
    overflow[arrayOffset + 1] = 0x81
    overflow[wire.byteLength] = ValueTag.CALLBACK_REF
    overflow[wire.byteLength + 1] = 0
    return overflow
}

function testCallbackReferenceHardLimitAndTransactionalShapes() {
    const boundary = {
        callbacks: createCallbackReferences(MAX_CALLBACK_REFS_PER_VALUE),
    }
    const boundarySender = createTestCodec(true, true)
    const boundaryWire = boundarySender.encode(boundary)
    assert.equal(boundarySender.stats().encodeShapes, 1)

    const boundaryReceiver = createTestCodec(true, true)
    const decodedBoundary = boundaryReceiver.decode(boundaryWire) as {
        callbacks: unknown[]
    }
    assert.equal(decodedBoundary.callbacks.length, MAX_CALLBACK_REFS_PER_VALUE)
    assert.equal(rpcBinaryCallbackRefId(decodedBoundary.callbacks[0]), 0)
    assert.equal(
        rpcBinaryCallbackRefId(decodedBoundary.callbacks[MAX_CALLBACK_REFS_PER_VALUE - 1]),
        MAX_CALLBACK_REFS_PER_VALUE - 1,
    )
    assert.equal(boundaryReceiver.stats().decodeShapes, 1)

    const encodeReceiver = createTestCodec(true, true)
    const overflowSender = createTestCodec(true, true)
    assert.throws(function encodeTooManyCallbackReferences() {
        overflowSender.encode({
            overflow: createCallbackReferences(MAX_CALLBACK_REFS_PER_VALUE + 1),
        })
    }, /callback reference count exceeds protocol limit/)
    assert.equal(overflowSender.stats().encodeShapes, 0, 'failed encode rolls back staged shape')
    assert.equal(overflowSender.stats().encodeDefinitions, 0)

    const validAfterEncodeFailure = overflowSender.encode({
        valid: createRpcBinaryCallbackRef(7),
    })
    assert.equal(overflowSender.stats().encodeShapes, 1)
    assert.equal(
        rpcBinaryCallbackRefId(
            (encodeReceiver.decode(validAfterEncodeFailure) as {valid: unknown}).valid,
        ),
        7,
    )

    const overflowWire = addOneCallbackReferenceToBoundaryWire(boundaryWire)
    const overflowReceiver = createTestCodec(true, true)
    assert.throws(function decodeTooManyCallbackReferences() {
        overflowReceiver.decode(overflowWire)
    }, /callback reference count exceeds protocol limit/)
    assert.equal(overflowReceiver.stats().decodeShapes, 0, 'failed decode rolls back staged shape')
    assert.equal(overflowReceiver.stats().decodeDefinitions, 0)

    const decodedAfterFailure = overflowReceiver.decode(boundaryWire) as {
        callbacks: unknown[]
    }
    assert.equal(decodedAfterFailure.callbacks.length, MAX_CALLBACK_REFS_PER_VALUE)
    assert.equal(overflowReceiver.stats().decodeShapes, 1)
}

function testEnvelopeCanonicalFormatAndValidation() {
    const probe = encodeRpcBinaryControl(RpcBinaryFrame.PROBE, 128)
    assert.deepEqual(Array.from(probe), [0x52, 0x50, 0x42, 1, 0, 0x80, 0x01])
    assert.equal(isRpcBinaryEnvelope(probe), true)
    assert.deepEqual(inspectRpcBinaryEnvelope(probe), {
        kind: RpcBinaryFrame.PROBE,
        sessionId: 128,
        version: 1,
        payload: probe.subarray(probe.byteLength),
    })

    const maximum = encodeRpcBinaryControl(RpcBinaryFrame.PROBE_ACK, Number.MAX_SAFE_INTEGER)
    const inspectedMaximum = inspectRpcBinaryEnvelope(maximum)
    assert.ok(inspectedMaximum)
    assert.equal(inspectedMaximum.sessionId, Number.MAX_SAFE_INTEGER)
    assert.equal(inspectedMaximum.kind, RpcBinaryFrame.PROBE_ACK)

    const payload = Uint8Array.from([0, 1, 2, 255])
    const packet = wrapRpcBinaryPacket(5, payload)
    const inspectedPacket = inspectRpcBinaryEnvelope(packet)
    assert.ok(inspectedPacket)
    assert.equal(inspectedPacket.kind, RpcBinaryFrame.PACKET)
    assert.equal(inspectedPacket.sessionId, 5)
    assert.deepEqual(Array.from(inspectedPacket.payload), Array.from(payload))

    const padded = new Uint8Array(packet.byteLength + 4)
    padded.set(packet, 2)
    const inspectedView = inspectRpcBinaryEnvelope(new DataView(padded.buffer, 2, packet.byteLength))
    assert.ok(inspectedView)
    assert.deepEqual(Array.from(inspectedView.payload), Array.from(payload))

    assert.equal(inspectRpcBinaryEnvelope(Uint8Array.from([0, 1, 2])), undefined)
    assert.equal(isRpcBinaryEnvelope(Uint8Array.from([0x52, 0x50, 0x41, 1, 0, 1])), false)

    for (let length = 0; length < probe.byteLength; length++) {
        const prefix = probe.subarray(0, length)
        if (length < TEST_MAGIC.length) {
            assert.equal(inspectRpcBinaryEnvelope(prefix), undefined)
        } else {
            assert.throws(function inspectTruncatedEnvelope() {
                inspectRpcBinaryEnvelope(prefix)
            })
        }
    }

    const badVersion = probe.slice()
    badVersion[3] = 4
    assert.throws(() => inspectRpcBinaryEnvelope(badVersion), /unsupported version/)

    const badKind = probe.slice()
    badKind[4] = 99
    assert.throws(() => inspectRpcBinaryEnvelope(badKind), /unknown frame kind/)

    assert.throws(
        () => inspectRpcBinaryEnvelope(Uint8Array.from([0x52, 0x50, 0x42, 1, 0, 0])),
        /invalid session id/,
    )
    assert.throws(
        () => inspectRpcBinaryEnvelope(Uint8Array.from([0x52, 0x50, 0x42, 1, 0, 0x81, 0])),
        /non-canonical session id/,
    )
    assert.throws(
        () => inspectRpcBinaryEnvelope(Uint8Array.from([
            0x52, 0x50, 0x42, 1, 0,
            0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81,
        ])),
        /session id exceeds limit/,
    )
    assert.throws(
        () => inspectRpcBinaryEnvelope(copyWithTrailingByte(probe)),
        /control frame has trailing bytes/,
    )
    assert.throws(
        () => inspectRpcBinaryEnvelope(Uint8Array.from([0x52, 0x50, 0x42, 1, 2, 1])),
        /packet frame has no payload/,
    )
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(function encodeInvalidSessionId() {
            encodeRpcBinaryControl(RpcBinaryFrame.PROBE, invalid)
        }, /invalid session id/)
    }
}

function testZeroAndInvalidShapeBudgets() {
    const sessionId = 17
    const sender = createRpcBinaryPeer({sessionId, maxShapes: 0})
    const receiver = createRpcBinaryPeer({sessionId, maxShapes: 0})
    const first = sender.prepare([1, {value: 'one'}])
    first.commit()
    const second = sender.prepare([2, {value: 'two'}])
    second.commit()

    assert.equal(sender.stats().encodeShapes, 0)
    assert.equal(sender.stats().encodeDefinitions, 0)
    assert.equal(sender.stats().encodeReferences, 0)
    assertExactValue(receiver.decode(packetPayload(first.wire, sessionId)), [1, {value: 'one'}])
    assertExactValue(receiver.decode(packetPayload(second.wire, sessionId)), [2, {value: 'two'}])
    assert.equal(receiver.stats().decodeShapes, 0)

    for (const invalid of [-1, 1.5, 1_001, NaN, Infinity]) {
        assert.throws(function createPeerWithInvalidShapeBudget() {
            createRpcBinaryPeer({sessionId, maxShapes: invalid})
        }, /maxEntries/)
    }
}

function testCodecOwnedBinaryLeavesSkipIndexEnumeration() {
    const inner = createTestCodec(false).encode({value: 1})
    assert.equal(Object.isExtensible(inner), false)
    let scans = 0
    const originalOwnKeys = Reflect.ownKeys
    const mutableReflect = Reflect as any
    mutableReflect.ownKeys = function countTrustedLeafScans(value: object) {
        if (value === inner) scans++
        return originalOwnKeys(value)
    }
    try {
        const outer = createTestCodec(false)
        const wire = outer.encode(inner)
        const decoded = outer.decode(wire)
        assertExactValue(decoded, inner)
        validateRpcBinaryResult(inner)
        const snapshot = snapshotRpcBinaryResult(inner) as Uint8Array
        assert.equal(Object.isExtensible(snapshot), false)
    } finally {
        mutableReflect.ownKeys = originalOwnKeys
    }
    assert.equal(scans, 0)
    assert.throws(function cannotAttachStateToCodecLeaf() {
        Object.defineProperty(inner, 'custom', {value: true})
    })
}

export async function runRpcBinaryCodecTests() {
    let failures = 0
    const tests = [
        ['exact primitive/rich/sparse/null-prototype values', testExactPrimitiveRichSparseAndNullPrototypeValues],
        ['safe-integer fast path matches BigInt wire across boundaries',
            testSafeIntegerFastPathMatchesBigIntReference],
        ['measured length matches cold/warm encoding without cache mutation',
            testMeasuredLengthMatchesColdAndWarmEncoding],
        ['shape signatures remain distinct for arbitrary keys', testShapeSignaturesStayDistinctForArbitraryKeys],
        ['decoded objects bypass inherited setters safely', testDecodedObjectsAvoidInheritedSetters],
        ['leading BOM survives values and distinct shape keys', testLeadingBomKeepsValuesAndShapeCacheDistinct],
        ['native own state fails closed and encode cache recovers',
            testNativeOwnStateFailsClosedAndEncodeRecovers],
        ['native shadows and runtime-new RegExp flags fail closed',
            testNativeShadowsAndRuntimeNewRegExpFlagsFailClosed],
        ['cold DEF then shorter warm REF with stats', testColdDefinitionThenWarmReference],
        ['one shape preserves string/number/false tags', testOneShapeKeepsPolymorphicValueTagsExact],
        ['1000 shapes then RAW fallback while old REF survives', testThousandShapeBudgetFallsBackToRaw],
        ['encode/decode directions keep independent caches', testPeerDirectionsHaveIndependentShapeCaches],
        ['prepare rollback and cyclic failure do not poison cache', testPrepareRollbackAndEncodeFailureDoNotPoisonCache],
        ['all decode failures leave cache transactional', testDecodeFailuresAreTransactional],
        ['callback references require explicit codec gate', testCallbackReferenceGate],
        ['callback-reference hard cap is symmetric and transactional',
            testCallbackReferenceHardLimitAndTransactionalShapes],
        ['envelope format/session/kind/truncation are canonical', testEnvelopeCanonicalFormatAndValidation],
        ['zero shape budget works and invalid budgets fail', testZeroAndInvalidShapeBudgets],
        ['codec-owned binary leaves skip integer-index enumeration',
            testCodecOwnedBinaryLeavesSkipIndexEnumeration],
    ] as const

    console.log('\n--- universal binary RPC pure codecs ---')
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
        ? 'RPC binary pure codec tests: OK'
        : 'RPC binary pure codec tests: ' + failures + ' FAILED')
    return failures
}

if (require.main === module) {
    runRpcBinaryCodecTests().then(function finish(failures) {
        process.exit(failures == 0 ? 0 : 1)
    })
}
