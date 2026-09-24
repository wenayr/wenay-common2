import assert from 'node:assert/strict'
import {createBinaryValueCodec, type BinaryValueCodecOptions} from '../../src/Common/events/replay-binary-value'

// Short ASCII strings and object keys skip the per-call cost of TextEncoder,
// TextDecoder and a descriptor lookup per key. The fast paths must be invisible:
// the same strings, the same rejections of invalid UTF-8, the same own data
// properties for keys Object.prototype knows about (setters never run).

const OPTIONS: BinaryValueCodecOptions = {
    // replay-channel.ts createReplayBinaryCodec
    magic: [0x52, 0x43, 0x48], version: 1, label: 'fast', callbackRefs: false,
    shapeCache: {maxEntries: 1000}, maxDepth: 36, maxBinaryBytes: 8_000_000, maxWireBytes: 16_000_000,
}
const HEADER = [0x52, 0x43, 0x48, 1]
const STRING_UTF8 = 6

function codec(shape = true) {
    return createBinaryValueCodec({...OPTIONS, shapeCache: shape ? OPTIONS.shapeCache : false})
}

function utf8Frame(bytes: readonly number[]) {
    return Uint8Array.from([...HEADER, STRING_UTF8, bytes.length, ...bytes])
}

function ascii(text: string) {
    return Array.from(text, char => char.charCodeAt(0))
}

/** Counts calls of a prototype or static method while run() executes. */
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
// Short ASCII strings: same strings, same rejections
// ============================================================

// Both fast-path boundaries: 12/13 bytes (decode), 32/33 bytes (encode).
const EDGE_STRINGS = [
    '', 'a', 'SYM12', '\u0000\u0001\u001f', '\u007f'.repeat(12), '\u007f'.repeat(32), 'a'.repeat(12), 'a'.repeat(13),
    'a'.repeat(31), 'a'.repeat(32), 'a'.repeat(33), '\u0080', 'x'.repeat(11) + '\u0080', 'x'.repeat(31) + '\u0080',
    'x'.repeat(10) + 'é', 'x'.repeat(30) + 'é', 'é'.repeat(16), '﻿', '﻿abc', 'abc﻿',
    '😀', 'a😀b', '\uD800', 'k\uDC00', 'Привет',
]

function checkEdgeStringsRoundTrip() {
    for (const shape of [true, false]) {
        const encoder = codec(shape)
        const decoder = codec(shape)
        const trusted = codec(shape)
        for (let round = 0; round < 2; round++) { // shape definitions, then references
            for (const text of EDGE_STRINGS) {
                const value = {[text]: text, list: [text, text], nested: {[text + '#']: text}}
                const wire = encoder.encode(value)
                assert.deepEqual(decoder.decode(wire), value, `untrusted ${JSON.stringify(text)}`)
                assert.deepEqual(trusted.decodeTrusted(wire), value, `trusted ${JSON.stringify(text)}`)
            }
        }
    }
}

const INVALID_UTF8 = {
    'lone continuation byte': [0x80],
    'overlong NUL': [0xc0, 0x80],
    'invalid lead byte': [0xff],
    'encoded surrogate': [0xed, 0xa0, 0x80],
    'ASCII then continuation': [0x61, 0x80],
    'truncated sequence': [0x61, 0xe2, 0x82],
    '12 bytes, the last invalid': [...ascii('a'.repeat(11)), 0x80],
    '12 bytes, the first invalid': [0x80, ...ascii('a'.repeat(11))],
    '32 bytes, the last invalid': [...ascii('a'.repeat(31)), 0x80],
}

function checkInvalidShortUtf8IsRejected() {
    for (const [name, bytes] of Object.entries(INVALID_UTF8)) {
        assert.throws(function decodeInvalid() { codec().decode(utf8Frame(bytes)) }, /^TypeError: fast: invalid UTF-8 string$/, name)
    }
    // The trusted reader never validated: it keeps replacing, as before.
    assert.equal(codec().decodeTrusted(utf8Frame([0x61, 0x80])), 'a�')
    assert.equal(codec().decodeTrusted(utf8Frame([0x80])), '�')
    // Valid bytes at the ASCII edge.
    assert.equal(codec().decode(utf8Frame([0x7f, 0x00, 0x41])), '\u007f\u0000A')
    assert.equal(codec().decode(utf8Frame([0xef, 0xbb, 0xbf, 0x61])), '﻿a', 'a leading BOM is data')
    assert.equal(codec().decode(utf8Frame([])), '')
}

function checkShortStringsKeepTheCodeUnitLimit() {
    const frame = utf8Frame(ascii('abcdef'))
    assert.equal(codec().decode(frame, {maxStringLen: 6}), 'abcdef')
    assert.throws(function decodeOverLimit() { codec().decode(frame, {maxStringLen: 5}) }, /string exceeds code-unit limit/)
    assert.throws(function decodeTrustedOverLimit() { codec().decodeTrusted(frame, {maxStringLen: 5}) }, /exceeds/)
    // A short string cut off by the end of the frame is truncated, not read past the end.
    const truncated = Uint8Array.from([...HEADER, STRING_UTF8, 5, ...ascii('abc')])
    assert.throws(function decodeTruncated() { codec().decode(truncated) }, /truncated frame/)
    assert.throws(function decodeTrustedTruncated() { codec().decodeTrusted(truncated) }, /truncated frame/)
}

// ============================================================
// Keys Object.prototype knows about stay own data properties
// ============================================================

function checkPrototypeKeysStayOwnData() {
    let setterCalls = 0
    Object.defineProperty(Object.prototype, 'runtimeAccessor', {
        configurable: true,
        get() { return 'inherited' },
        set() { setterCalls++ },
    })
    Object.defineProperty(Object.prototype, 'runtimeReadonly', {configurable: true, writable: false, value: 'inherited'})
    try {
        const keys = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'runtimeAccessor', 'runtimeReadonly', 'plain']
        for (const nullPrototype of [false, true]) {
            const source: Record<string, unknown> = nullPrototype ? Object.create(null) : {}
            for (const key of keys) {
                Object.defineProperty(source, key, {value: {marker: key}, enumerable: true, writable: true, configurable: true})
            }
            for (const shape of [true, false]) {
                const encoder = codec(shape)
                const decoder = codec(shape)
                const trusted = codec(shape)
                for (let round = 0; round < 2; round++) {
                    const wire = encoder.encode(source)
                    for (const decoded of [decoder.decode(wire), trusted.decodeTrusted(wire)] as Record<string, unknown>[]) {
                        assert.equal(Object.getPrototypeOf(decoded), nullPrototype ? null : Object.prototype, 'no key changes the prototype')
                        assert.deepEqual(Reflect.ownKeys(decoded), keys, 'every key is own, in order')
                        for (const key of keys) {
                            assert.deepEqual(Object.getOwnPropertyDescriptor(decoded, key),
                                {value: {marker: key}, enumerable: true, writable: true, configurable: true}, key)
                        }
                    }
                }
            }
        }
        assert.equal(setterCalls, 0, 'an inherited setter is never invoked')
        assert.equal(({} as any).marker, undefined, 'Object.prototype is not polluted')
    } finally {
        delete (Object.prototype as any).runtimeAccessor
        delete (Object.prototype as any).runtimeReadonly
    }
}

// ============================================================
// Cost: no TextEncoder/TextDecoder/subarray/descriptor call per short value
// ============================================================

function ticks(count: number) {
    return Array.from({length: count}, (_, index) => ({
        symbol: 'SYM' + (index % 50), price: 100 + index * 0.25, qty: index % 17, side: index % 2 ? 'buy' : 'sell', ts: 1727000000000 + index,
    }))
}

function checkShortAsciiSkipsTextCodecs() {
    const packet = [5, ticks(64)]
    const encoder = codec()
    const encodeInto = countCalls(TextEncoder.prototype, 'encodeInto', function encodeTicks() { encoder.encode(packet) })
    const wire = codec().encode(packet)
    let decodes = 0
    let subarrays = 0
    for (const trusted of [false, true]) {
        subarrays += countCalls(Uint8Array.prototype, 'subarray', function decodeTicksCountingSubarray() {
            decodes += countCalls(TextDecoder.prototype, 'decode', function decodeTicks() {
                const decoder = codec()
                if (trusted) decoder.decodeTrusted(wire)
                else decoder.decode(wire)
            })
        })
    }
    assert.deepEqual({encodeInto, decodes, subarrays}, {encodeInto: 0, decodes: 0, subarrays: 0},
        '64 ticks: 5 short ASCII keys and 128 short ASCII values')
}

function checkKeysNeedNoDescriptorLookup() {
    const wire = codec().encode([5, ticks(64)])
    const lookups = countCalls(Object, 'getOwnPropertyDescriptor', function decodeTicks() { codec().decode(wire) },
        args => args[0] === Object.prototype)
    assert.equal(lookups, 0, `Object.prototype descriptor lookups while decoding 64 objects x 5 keys: ${lookups}`)
}

let failures = 0
const checks = [
    checkEdgeStringsRoundTrip,
    checkInvalidShortUtf8IsRejected,
    checkShortStringsKeepTheCodeUnitLimit,
    checkPrototypeKeysStayOwnData,
    checkShortAsciiSkipsTextCodecs,
    checkKeysNeedNoDescriptorLookup,
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
    console.error(`${failures} replay binary decode fast-path checks failed`)
    process.exit(1)
}
console.log('PASS replay binary fast paths: short ASCII strings and prototype keys decode exactly as before, without per-value codec calls')
