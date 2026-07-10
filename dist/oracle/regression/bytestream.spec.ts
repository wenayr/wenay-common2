import {ByteStreamR, ByteStreamW, NumericTypes, nullable} from '../../src/Common/data/ByteStream'

type TestCase = {
    name: string
    run: () => void
}

const numericTypes: NumericTypes[] = [
    'int8',
    'uint8',
    'int16',
    'uint16',
    'int24',
    'uint24',
    'int32',
    'uint32',
    'int48',
    'uint48',
    'int64',
    'uint64',
    'float',
    'double',
]

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string) {
    const actualText = JSON.stringify(actual)
    const expectedText = JSON.stringify(expected)
    if (actualText !== expectedText) {
        throw new Error(`${message}: expected ${expectedText}, got ${actualText}`)
    }
}

function assertThrows(fn: () => unknown, message: string) {
    let threw = false
    try {
        fn()
    } catch {
        threw = true
    }
    assert(threw, message)
}

const tests: TestCase[] = [
    {
        name: 'nullable numeric null writes and reads null for every numeric type',
        run() {
            const stream = new ByteStreamW()
            for (const type of numericTypes) {
                assert(stream.pushNumber(null as any, nullable(type)) !== null, `write ${type} null`)
            }

            const reader = new ByteStreamR(stream.data)
            for (const type of numericTypes) {
                assert(reader.readNumber(nullable(type)) === null, `read ${type} nullable null`)
            }
            assert(stream.length === numericTypes.length, 'nullable null values occupy only presence bytes')
        },
    },
    {
        name: 'truncated uint8 array throws and noThrow returns null',
        run() {
            const data = new DataView(new ArrayBuffer(6))
            data.setUint32(0, 3)
            data.setUint8(4, 10)
            data.setUint8(5, 20)

            assertThrows(() => new ByteStreamR(data).readArray('uint8'), 'truncated uint8 array throws')
            assert(new ByteStreamR(data).noThrow().readArray('uint8') === null, 'truncated uint8 noThrow returns null')
        },
    },
    {
        name: 'truncated int8 array throws and noThrow returns null',
        run() {
            const data = new DataView(new ArrayBuffer(5))
            data.setUint32(0, 2)
            data.setInt8(4, -1)

            assertThrows(() => new ByteStreamR(data).readArray('int8'), 'truncated int8 array throws')
            assert(new ByteStreamR(data).noThrow().readArray('int8') === null, 'truncated int8 noThrow returns null')
        },
    },
    {
        name: 'pushArray writes into a DataView byteOffset and data keeps that byteOffset',
        run() {
            const backing = new ArrayBuffer(32)
            const offset = 7
            const stream = new ByteStreamW(new DataView(backing, offset, 20))
            stream.pushArray(new Uint8Array([9, 8, 7]))

            const data = stream.data
            assert(data.byteOffset === offset, `data byteOffset is preserved: ${data.byteOffset}`)
            assert(data.byteLength === 7, `data byteLength is written length: ${data.byteLength}`)
            assertDeepEqual(Array.from(new Uint8Array(backing, 0, offset)), [0, 0, 0, 0, 0, 0, 0], 'bytes before offset remain untouched')
            assertDeepEqual(Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), [0, 0, 0, 3, 9, 8, 7], 'array bytes are written at offset')
            assertDeepEqual(new ByteStreamR(data).readArray('uint8'), [9, 8, 7], 'offset data reads back')
        },
    },
    {
        name: 'numeric arrays round-trip signed, unsigned, floating and nullable values',
        run() {
            const stream = new ByteStreamW()
            stream.pushArrayNumeric([-32768, -1, 0, 32767], 'int16')
            stream.pushArrayNumeric([0, 1, 0x123456, 0xffffff], 'uint24')
            stream.pushArrayNumeric([1.5, null as any, -2.25], nullable('double'))

            const reader = new ByteStreamR(stream.data)
            assertDeepEqual(reader.readArray('int16'), [-32768, -1, 0, 32767], 'int16 array round-trip')
            assertDeepEqual(reader.readArray('uint24'), [0, 1, 0x123456, 0xffffff], 'uint24 array round-trip')
            assertDeepEqual(reader.readArray(nullable('double')), [1.5, null, -2.25], 'nullable double array round-trip')
        },
    },
    {
        name: 'strings round-trip nulls and null-terminated values',
        run() {
            const stream = new ByteStreamW()
            stream.pushAnsi(null)
            stream.pushAnsi('abc')
            stream.pushUnicode(null)
            stream.pushUnicode('AZ')

            const data = stream.data
            const bytes = Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
            assertDeepEqual(bytes.slice(0, 6), [0, 1, 97, 98, 99, 0], 'ansi null marker and terminator are written')
            assertDeepEqual(bytes.slice(6), [0, 1, 0, 65, 0, 90, 0, 0], 'unicode null marker and terminator are written')

            const reader = new ByteStreamR(data)
            assert(reader.readAnsi() === null, 'ansi null reads null')
            assert(reader.readAnsi() === 'abc', 'ansi value reads to terminator')
            assert(reader.readUnicode() === null, 'unicode null reads null')
            assert(reader.readUnicode() === 'AZ', 'unicode value reads to terminator')
        },
    },
]

let failures = 0
for (const test of tests) {
    try {
        test.run()
        console.log('ok', test.name)
    } catch (error) {
        failures++
        console.error('FAIL', test.name)
        console.error(error)
    }
}

console.log(`\n${tests.length - failures}/${tests.length} ByteStream regression tests passed`)
process.exit(failures === 0 ? 0 : 1)
