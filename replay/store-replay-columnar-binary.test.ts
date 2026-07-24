// =====================================================================
// Store Replay v4/v5: exact JSON columns and self-contained binary wire.
// =====================================================================

import {Buffer} from 'node:buffer'
import {isDeepStrictEqual} from 'node:util'
import {ReplayEvent} from '../src/Common/events/replay-listen'
import {
    applyStorePatches,
    createStore,
    StorePatch,
} from '../src/Common/Observe/store'
import {
    decodeStoreReplayBatchV4,
    decodeStoreReplayBatchV5,
    encodeStoreReplayBatchV4,
    encodeStoreReplayBatchV5,
    tStoreReplayWireBatchV4,
} from '../src/Common/Observe/store-replay-codec'
import {
    decodeStoreReplayBinary,
    encodeStoreReplayBinary,
} from '../src/Common/Observe/store-replay-binary'
import {packResult, unpackResult} from '../src/Common/rcp/rpc-walk'

let fails = 0

function ok(condition: unknown, message: string) {
    if (condition) console.log('  OK  ', message)
    else {
        fails++
        console.log('  FAIL', message)
    }
}

function ownRecord(entries: readonly (readonly [string, unknown])[]) {
    const value: Record<string, unknown> = {}
    for (const [key, item] of entries) {
        Object.defineProperty(value, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: item,
        })
    }
    return value
}

function activeBytes(value: ArrayBuffer | ArrayBufferView) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function sameActiveBytes(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) {
    const a = activeBytes(left)
    const b = activeBytes(right)
    if (a.byteLength != b.byteLength) return false
    for (let index = 0; index < a.byteLength; index++) {
        if (a[index] != b[index]) return false
    }
    return true
}

function maxArrayLength(value: unknown): number {
    if (Array.isArray(value)) {
        let maximum = value.length
        for (const item of value) maximum = Math.max(maximum, maxArrayLength(item))
        return maximum
    }
    if (value == null || typeof value != 'object') return 0
    let maximum = 0
    for (const key of Object.keys(value)) {
        maximum = Math.max(maximum, maxArrayLength((value as Record<string, unknown>)[key]))
    }
    return maximum
}

function copyBinaryLeaf(value: ArrayBuffer | ArrayBufferView) {
    const source = activeBytes(value)
    const bytes = new Uint8Array(source.byteLength)
    bytes.set(source)
    if (value instanceof ArrayBuffer) return bytes.buffer
    if (value instanceof DataView) return new DataView(bytes.buffer)
    const Constructor = value.constructor as any
    if (typeof Constructor.from == 'function' && typeof Constructor.isBuffer == 'function'
        && Constructor.isBuffer(value)) {
        return Constructor.from(bytes)
    }
    return new Constructor(bytes.buffer)
}

function defineValue(target: Record<string, unknown>, key: string, value: unknown) {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    })
}

function dehydrateBinary(value: any, attachments: unknown[]): any {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const num = attachments.length
        attachments.push(copyBinaryLeaf(value))
        return {_placeholder: true, num}
    }
    if (value == null || typeof value != 'object') return value
    if (Array.isArray(value)) {
        return value.map(function dehydrateArrayItem(item) {
            return dehydrateBinary(item, attachments)
        })
    }
    const dehydrated: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
        defineValue(dehydrated, key, dehydrateBinary(value[key], attachments))
    }
    return dehydrated
}

function rehydrateBinary(value: any, attachments: readonly unknown[]): any {
    if (value == null || typeof value != 'object') return value
    const keys = Object.keys(value)
    if (keys.length == 2 && value._placeholder == true && Number.isSafeInteger(value.num)
        && value.num >= 0 && value.num < attachments.length) {
        return attachments[value.num]
    }
    if (Array.isArray(value)) {
        return value.map(function rehydrateArrayItem(item) {
            return rehydrateBinary(item, attachments)
        })
    }
    const rehydrated: Record<string, unknown> = {}
    for (const key of keys) {
        defineValue(rehydrated, key, rehydrateBinary(value[key], attachments))
    }
    return rehydrated
}

function rpcJsonTransport(value: unknown) {
    const attachments: unknown[] = []
    const dehydrated = dehydrateBinary(packResult(value), attachments)
    const jsonWire = JSON.parse(JSON.stringify(dehydrated))
    return unpackResult(rehydrateBinary(jsonWire, attachments))
}

type tTypedArrayConstructor = {
    new(values: any): ArrayBufferView & {length: number}
    new(buffer: ArrayBuffer, byteOffset: number, length: number): ArrayBufferView & {length: number}
    BYTES_PER_ELEMENT: number
    name: string
}

function typedValues(Constructor: tTypedArrayConstructor) {
    if (Constructor.name == 'BigInt64Array') return [-1n, 0n, (1n << 63n) - 1n]
    if (Constructor.name == 'BigUint64Array') return [0n, 1n, (1n << 64n) - 1n]
    if (Constructor.name == 'Float16Array'
        || Constructor.name == 'Float32Array'
        || Constructor.name == 'Float64Array') {
        return [-0, Number.NaN, Number.POSITIVE_INFINITY]
    }
    if (Constructor.name == 'Uint8ClampedArray') return [-1, 128, 300]
    if (Constructor.name.startsWith('Uint')) return [0, 1, 255]
    return [-1, 0, 1]
}

function offsetTypedArray(Constructor: tTypedArrayConstructor) {
    const compact = new Constructor(typedValues(Constructor))
    const bytes = activeBytes(compact)
    const offset = Constructor.BYTES_PER_ELEMENT
    const backing = new Uint8Array(offset + bytes.byteLength + Constructor.BYTES_PER_ELEMENT)
    backing.fill(0xa5)
    backing.set(bytes, offset)
    return new Constructor(backing.buffer, offset, compact.length)
}

function createTypedCases() {
    const globals = globalThis as any
    const names = [
        'Int8Array',
        'Uint8Array',
        'Uint8ClampedArray',
        'Int16Array',
        'Uint16Array',
        'Int32Array',
        'Uint32Array',
        'Float32Array',
        'Float64Array',
        'BigInt64Array',
        'BigUint64Array',
    ]
    return names.flatMap(function createTypedCase(name) {
        const Constructor = globals[name] as tTypedArrayConstructor | undefined
        return typeof Constructor == 'function'
            ? [{label: 'typed-' + name, value: offsetTypedArray(Constructor)}]
            : []
    })
}

function createValueCases() {
    const sparse = new Array<unknown>(5)
    sparse[1] = undefined
    sparse[3] = null
    sparse[4] = 'tail'
    const nullPrototype = Object.create(null) as Record<string, unknown>
    nullPrototype['enabled'] = false
    defineValue(nullPrototype, '__proto__', undefined)

    const reserved = ownRecord([
        ['__proto__', {polluted: 'local-only'}],
        ['constructor', 'business-constructor'],
        ['prototype', 'business-prototype'],
        ['$_sr', 0],
        ['markers', [
            {'$_f': 7},
            {'$_d': 1_700_000_000_000},
            {'$_m': [['BTC', 1]]},
            {'$_s': ['ETH']},
            {'$_r': {source: 'quote', flags: 'g'}},
            {'$_b': '9007199254740993'},
            {_placeholder: true, num: 0},
        ]],
    ])

    const map = new Map<unknown, unknown>([
        [undefined, Number.NaN],
        [{side: 'bid'}, new Date('2026-07-23T00:00:00.000Z')],
        ['nested', new Set([undefined, -0, 9n])],
    ])
    const set = new Set<unknown>([
        undefined,
        Number.POSITIVE_INFINITY,
        /котировка/giu,
        new Map([['x', false]]),
    ])
    const dataViewBacking = new Uint8Array([0xa5, 7, 8, 9, 0xa5])

    return [
        {label: 'false', value: false},
        {label: 'true', value: true},
        {label: 'null', value: null},
        {label: 'undefined', value: undefined},
        {label: 'zero', value: 0},
        {label: 'negative-zero', value: -0},
        {label: 'fraction', value: -123.75},
        {label: 'max-safe', value: Number.MAX_SAFE_INTEGER},
        {label: 'min-safe', value: Number.MIN_SAFE_INTEGER},
        {label: 'min-value', value: Number.MIN_VALUE},
        {label: 'max-value', value: Number.MAX_VALUE},
        {label: 'nan', value: Number.NaN},
        {label: 'positive-infinity', value: Number.POSITIVE_INFINITY},
        {label: 'negative-infinity', value: Number.NEGATIVE_INFINITY},
        {label: 'bigint-zero', value: 0n},
        {label: 'bigint-negative', value: -9_007_199_254_740_993n},
        {label: 'bigint-large', value: (1n << 255n) - 19n},
        {label: 'string-empty', value: ''},
        {label: 'string-ascii', value: 'quote "BTC"\\line\nnext'},
        {label: 'string-cyrillic', value: 'котировка'},
        {label: 'string-emoji', value: '東京🙂'},
        {label: 'string-nul', value: 'left\u0000right'},
        {label: 'string-lone-high', value: '\ud800'},
        {label: 'string-lone-low', value: '\udc00'},
        {label: 'sparse', value: sparse},
        {label: 'nested', value: {
            rows: [
                {id: 'A', meta: {enabled: false, missing: undefined}},
                {id: 'B', meta: {enabled: true, score: Number.NaN}},
            ],
        }},
        {label: 'null-prototype', value: nullPrototype},
        {label: 'reserved', value: reserved},
        {label: 'date', value: new Date('2026-07-23T12:34:56.789Z')},
        {label: 'invalid-date', value: new Date(Number.NaN)},
        {label: 'regexp', value: /цена\s+"(?<pair>.+)"/giu},
        {label: 'map', value: map},
        {label: 'set', value: set},
        {label: 'array-buffer', value: new Uint8Array([1, 2, 3, 4]).buffer},
        {label: 'data-view', value: new DataView(dataViewBacking.buffer, 1, 3)},
        ...createTypedCases(),
    ]
}

const valueCases = createValueCases()

function valueEvent(): ReplayEvent<[readonly StorePatch[]]> {
    return {
        seq: 41,
        ts: 1_721_735_696_789,
        event: [valueCases.map(function valuePatch(entry) {
            return {
                path: ['values', entry.label],
                exists: true,
                value: entry.value,
            }
        })],
    }
}

function valueDetailsHold(decoded: ReplayEvent<[StorePatch[]]>) {
    const byLabel = new Map<string, unknown>()
    for (const patch of decoded.event[0]) byLabel.set(String(patch.path[1]), patch.value)

    const exactNumbers = valueCases
        .filter(function numericCase(entry) { return typeof entry.value == 'number' })
        .every(function exactNumber(entry) {
            return Object.is(byLabel.get(entry.label), entry.value)
        })
    const sparse = byLabel.get('sparse') as unknown[]
    const nullPrototype = byLabel.get('null-prototype') as Record<string, unknown>
    const reserved = byLabel.get('reserved') as Record<string, unknown>
    const invalidDate = byLabel.get('invalid-date') as Date
    const binaryExact = valueCases
        .filter(function binaryCase(entry) {
            return entry.value instanceof ArrayBuffer || ArrayBuffer.isView(entry.value)
        })
        .every(function exactBinary(entry) {
            const value = byLabel.get(entry.label) as ArrayBuffer | ArrayBufferView
            if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) return false
            if (entry.value instanceof ArrayBuffer) {
                if (!(value instanceof ArrayBuffer)) return false
            } else if (entry.value instanceof DataView) {
                if (!(value instanceof DataView)) return false
            } else if ((value as any).constructor.name != (entry.value as any).constructor.name) {
                return false
            }
            return sameActiveBytes(value, entry.value as ArrayBuffer | ArrayBufferView)
        })

    return exactNumbers
        && Array.isArray(sparse) && sparse.length == 5
        && !(0 in sparse) && 1 in sparse && sparse[1] === undefined
        && !(2 in sparse) && 3 in sparse && sparse[3] === null
        && Object.getPrototypeOf(nullPrototype) == null
        && nullPrototype['enabled'] == false
        && Object.prototype.hasOwnProperty.call(nullPrototype, '__proto__')
        && Object.prototype.hasOwnProperty.call(reserved, '__proto__')
        && (reserved['__proto__'] as any).polluted == 'local-only'
        && Object.prototype.hasOwnProperty.call(reserved, 'constructor')
        && ({} as any).polluted == undefined
        && invalidDate instanceof Date && Number.isNaN(invalidDate.valueOf())
        && binaryExact
}

function testValueMatrix() {
    console.log('\n[store-replay-columnar-binary] exact value matrix')
    const event = valueEvent()
    const directV4 = decodeStoreReplayBatchV4(encodeStoreReplayBatchV4(event))
    const jsonV4 = decodeStoreReplayBatchV4(
        rpcJsonTransport(encodeStoreReplayBatchV4(event)),
    )
    const encodedV5 = encodeStoreReplayBatchV5(event)
    const copiedV5 = new Uint8Array(encodedV5.byteLength)
    copiedV5.set(encodedV5)
    const binaryV5 = decodeStoreReplayBatchV5(copiedV5)

    ok(isDeepStrictEqual(directV4, event) && valueDetailsHold(directV4),
        'v4 direct preserves primitive, rich, sparse, reserved and binary values')
    ok(isDeepStrictEqual(jsonV4, event) && valueDetailsHold(jsonV4),
        'v4 survives RPC packing, real JSON semantics and binary attachments')
    ok(isDeepStrictEqual(binaryV5, event) && valueDetailsHold(binaryV5),
        'v5 copied bytes preserve exact values and active typed-array views')
}

function testPollutedPrototypeDecode() {
    console.log('\n[store-replay-columnar-binary] polluted prototype construction')
    const setterKey = '__store_replay_test_setter__'
    const lockedKey = '__store_replay_test_locked__'
    let setterCalls = 0
    const value = ownRecord([
        ['id', 'SAFE'],
        [setterKey, 'own setter value'],
        [lockedKey, 'own locked value'],
        ['__proto__', 'own proto value'],
    ])
    const event = {
        seq: 19,
        ts: 23,
        event: [[{path: ['SAFE'], exists: true, value}]] as [StorePatch[]],
    }
    Object.defineProperty(Object.prototype, setterKey, {
        configurable: true,
        set() { setterCalls++ },
    })
    Object.defineProperty(Object.prototype, lockedKey, {
        configurable: true,
        value: 'inherited locked value',
        writable: false,
    })
    try {
        const v4 = decodeStoreReplayBatchV4(encodeStoreReplayBatchV4(event))
        const v5 = decodeStoreReplayBatchV5(encodeStoreReplayBatchV5(event))
        const decoded = [v4, v5].map(item => item.event[0][0].value as Record<string, unknown>)
        ok(setterCalls == 0
            && decoded.every(item => item[setterKey] == 'own setter value'
                && item[lockedKey] == 'own locked value'
                && item['__proto__'] == 'own proto value'
                && Object.getPrototypeOf(item) == Object.prototype),
        'v4/v5 create own data without invoking inherited setters or non-writable fields')
    } finally {
        Reflect.deleteProperty(Object.prototype, setterKey)
        Reflect.deleteProperty(Object.prototype, lockedKey)
    }
}

function shapeEvent() {
    const orderABC = ownRecord([
        ['id', 'ORDER-A'],
        ['a', 1],
        ['b', 2],
    ])
    const orderCBA = ownRecord([
        ['id', 'ORDER-B'],
        ['b', 3],
        ['a', 4],
    ])
    return {
        seq: 51,
        ts: 52,
        event: [[
            {path: ['A'], exists: true, value: {id: 'A', c: 1, t: false}},
            {path: ['B'], exists: true, value: {id: 'B', c: 2, t: true}},
            {path: ['C'], exists: true, value: {id: 'C', c: 3, t: null}},
            {path: ['ORDER-A'], exists: true, value: orderABC},
            {path: ['ORDER-B'], exists: true, value: orderCBA},
            {path: ['N1'], exists: true, value: {id: 'N1', meta: {x: 1}}},
            {path: ['N2'], exists: true, value: {id: 'N2', meta: {x: 2, y: undefined}}},
        ]] as [StorePatch[]],
    }
}

function testShapes() {
    console.log('\n[store-replay-columnar-binary] ordered local shapes')
    const event = shapeEvent()
    const v4 = encodeStoreReplayBatchV4(event)
    const firstRun = v4[3][0]
    const decodedV4 = decodeStoreReplayBatchV4(rpcJsonTransport(v4))
    const decodedV5 = decodeStoreReplayBatchV5(encodeStoreReplayBatchV5(event))
    const valuesV4 = decodedV4.event[0].map(function patchValue(patch) { return patch.value })

    ok(firstRun?.[0] == 2
        && isDeepStrictEqual(firstRun[1], ['id', 'c', 't'])
        && firstRun[2] == 0
        && isDeepStrictEqual(firstRun[3], ['A', 'B', 'C']),
    'repeated top-key objects use a derived-key column run')
    ok(isDeepStrictEqual(decodedV4, event) && isDeepStrictEqual(decodedV5, event),
        'v4/v5 keep nested heterogeneous values and patch order')
    ok(isDeepStrictEqual(Object.keys(valuesV4[3]), ['id', 'a', 'b'])
        && isDeepStrictEqual(Object.keys(valuesV4[4]), ['id', 'b', 'a']),
    'different observable field orders remain different shapes')
}

function operationEvent() {
    return {
        seq: 61,
        ts: 62,
        event: [[
            {path: [], exists: true, value: {base: {n: 0}, old: true}},
            {path: ['flag'], exists: true, value: false},
            {path: ['base', 'n'], exists: true, value: 1},
            {path: ['base', 'n'], exists: true, value: 2},
            {path: ['base', 'explicit'], exists: true, value: undefined},
            {path: ['base', 'n'], exists: false, value: undefined},
            {path: ['old'], exists: false, value: undefined},
            {path: [], exists: false, value: undefined},
            {path: [], exists: true, value: {final: {value: null}}},
            {path: ['final', 'value'], exists: true, value: true},
        ]] as [StorePatch[]],
    }
}

function operationSnapshot(patches: readonly StorePatch[]) {
    const store = createStore<Record<string, any>>({})
    applyStorePatches(store, patches)
    return store.snapshot()
}

function testOperations() {
    console.log('\n[store-replay-columnar-binary] root/deep/delete ordering')
    const event = operationEvent()
    const v4 = decodeStoreReplayBatchV4(rpcJsonTransport(encodeStoreReplayBatchV4(event)))
    const v5 = decodeStoreReplayBatchV5(encodeStoreReplayBatchV5(event))
    const expected = operationSnapshot(event.event[0])

    ok(isDeepStrictEqual(v4, event) && isDeepStrictEqual(v5, event),
        'both codecs retain root, top, deep, delete and repeated-patch order')
    ok(isDeepStrictEqual(operationSnapshot(v4.event[0]), expected)
        && isDeepStrictEqual(operationSnapshot(v5.event[0]), expected)
        && isDeepStrictEqual(expected, {final: {value: true}}),
    'decoded operation sequences materialize exactly the authoritative state')
}

const goldenEvent = {
    seq: 7,
    ts: 11,
    event: [[
        {path: ['A'], exists: true, value: {id: 'A', c: 1, t: false}},
        {path: ['B'], exists: true, value: {id: 'B', c: 2, t: true}},
        {path: ['gone'], exists: false, value: undefined},
        {path: ['deep', 'x'], exists: true, value: null},
    ]] as [StorePatch[]],
}

const goldenV4: tStoreReplayWireBatchV4 = [
    4,
    7,
    11,
    [
        [2, ['id', 'c', 't'], 0, ['A', 'B'], [[1, 2], [false, true]]],
        [1, ['gone']],
        [0, [[['deep', 'x'], null]]],
    ],
]

const goldenV5Hex = '535242050903040e0416090309050404090306026964060163060174040009020601410601420902090204020404090202030902040209010604676f6e650902040009010902090206046465657006017800'

function testGoldens() {
    console.log('\n[store-replay-columnar-binary] stable wire goldens')
    const encodedV4 = encodeStoreReplayBatchV4(goldenEvent)
    const encodedV5 = encodeStoreReplayBatchV5(goldenEvent)
    const goldenV5 = new Uint8Array(Buffer.from(goldenV5Hex, 'hex'))
    const nullRootPlan = [[4, [[0, [['A', {n: 1}]]]]]]
    const nullRootV4 = decodeStoreReplayBatchV4([4, 13, 17, nullRootPlan] as any)
    const nullRootV5 = decodeStoreReplayBatchV5(encodeStoreReplayBinary([13, 17, nullRootPlan]))

    ok(isDeepStrictEqual(encodedV4, goldenV4),
        'v4 encoder matches the hand-authored column plan')
    ok(Buffer.from(encodedV5).toString('hex') == goldenV5Hex,
        'v5 encoder matches the stable binary hex fixture')
    ok(isDeepStrictEqual(decodeStoreReplayBatchV4(goldenV4), goldenEvent)
        && isDeepStrictEqual(decodeStoreReplayBatchV5(goldenV5), goldenEvent),
    'independent v4 tuple and v5 byte fixtures decode to the logical event')
    ok(nullRootV4.event[0][0].path.length == 0
        && (nullRootV4.event[0][0].value as any).A.n == 1
        && Object.getPrototypeOf(nullRootV4.event[0][0].value) == null
        && isDeepStrictEqual(nullRootV5, nullRootV4),
    'hand-authored null-root opcode decodes independently in v4 and v5')
}

function cycleValues() {
    const object: any = {}
    object.self = object
    const array: any[] = []
    array.push(array)
    const map = new Map<unknown, unknown>()
    map.set('self', map)
    const set = new Set<unknown>()
    set.add(set)
    return [
        {label: 'object', value: object},
        {label: 'array', value: array},
        {label: 'Map', value: map},
        {label: 'Set', value: set},
    ]
}

function encodeCycle(value: unknown, codec: 'v4' | 'v5') {
    const event = {
        seq: 1,
        ts: 1,
        event: [[{path: ['cycle'], exists: true, value}]] as [StorePatch[]],
    }
    if (codec == 'v4') encodeStoreReplayBatchV4(event)
    else encodeStoreReplayBatchV5(event)
}

function testCyclesAndSharing() {
    console.log('\n[store-replay-columnar-binary] cycles and shared acyclic data')
    let rejected = 0
    for (const entry of cycleValues()) {
        for (const codec of ['v4', 'v5'] as const) {
            try { encodeCycle(entry.value, codec) }
            catch (error) {
                if (error instanceof TypeError && String(error).includes('cyclic')) rejected++
            }
        }
    }
    ok(rejected == cycleValues().length * 2,
        'v4/v5 deterministically reject object, array, Map and Set cycles')

    const shared = {leaf: {value: 7}}
    const event = {
        seq: 2,
        ts: 2,
        event: [[{
            path: ['shared'],
            exists: true,
            value: {left: shared, right: shared},
        }]] as [StorePatch[]],
    }
    const v4 = decodeStoreReplayBatchV4(encodeStoreReplayBatchV4(event))
    const v5 = decodeStoreReplayBatchV5(encodeStoreReplayBatchV5(event))
    ok(isDeepStrictEqual(v4, event) && isDeepStrictEqual(v5, event),
        'repeated acyclic references are accepted as ordinary data')
}

function localShapeEvent(prefix: string, seq: number) {
    return {
        seq,
        ts: seq,
        event: [[
            {path: [prefix + '1'], exists: true, value: {id: prefix + '1', value: 1}},
            {path: [prefix + '2'], exists: true, value: {id: prefix + '2', value: 2}},
            {path: [prefix + '3'], exists: true, value: {id: prefix + '3', value: 3}},
        ]] as [StorePatch[]],
    }
}

function testSelfContainedEnvelopes() {
    console.log('\n[store-replay-columnar-binary] envelope-local dictionaries')
    const first = localShapeEvent('A', 71)
    const second = localShapeEvent('B', 72)
    const firstV4 = encodeStoreReplayBatchV4(first)
    const secondV4 = encodeStoreReplayBatchV4(second)
    const firstV5 = encodeStoreReplayBatchV5(first)
    const secondV5 = encodeStoreReplayBatchV5(second)

    const decodedSecondV4 = decodeStoreReplayBatchV4(secondV4)
    const decodedSecondV5 = decodeStoreReplayBatchV5(secondV5)
    const decodedFirstV4 = decodeStoreReplayBatchV4(firstV4)
    const decodedFirstV5 = decodeStoreReplayBatchV5(firstV5)
    ok(isDeepStrictEqual(decodedSecondV4, second)
        && isDeepStrictEqual(decodedSecondV5, second)
        && isDeepStrictEqual(decodedFirstV4, first)
        && isDeepStrictEqual(decodedFirstV5, first),
    'a later same-shape envelope decodes first without cross-envelope state')
}

function rejectsV4(wire: unknown) {
    try {
        decodeStoreReplayBatchV4(wire)
        return false
    } catch (error) {
        return error instanceof TypeError || error instanceof RangeError
    }
}

function rejectsV5(wire: unknown) {
    try {
        decodeStoreReplayBatchV5(wire)
        return false
    } catch (error) {
        return error instanceof TypeError || error instanceof RangeError
    }
}

function rejectsBinary(wire: unknown) {
    try {
        decodeStoreReplayBinary(wire)
        return false
    } catch (error) {
        return error instanceof TypeError || error instanceof RangeError
    }
}

function testBinaryCanonicalLimits() {
    console.log('\n[store-replay-columnar-binary] canonical binary values and limits')
    const maxBigInt = (1n << 8_192n) - 1n
    const maxBigIntWire = encodeStoreReplayBinary(maxBigInt)
    const overBigInt = 1n << 8_192n
    let overBigIntRejected = false
    try {
        encodeStoreReplayBinary(overBigInt)
    } catch (error) {
        overBigIntRejected = error instanceof RangeError
    }

    const unterminatedBigInt = new Uint8Array(4 + 2 + Math.ceil(8_192 / 7))
    unterminatedBigInt.set([0x53, 0x52, 0x42, 0x05, 8, 0])
    unterminatedBigInt.fill(0x80, 6)

    const utf16WithoutLoneSurrogate = new Uint8Array([
        0x53, 0x52, 0x42, 0x05,
        7, 1, 0x41, 0,
    ])
    const duplicateMapKey = new Uint8Array([
        0x53, 0x52, 0x42, 0x05,
        13, 2,
        4, 2, 2,
        4, 2, 3,
    ])
    const duplicateSetValue = new Uint8Array([
        0x53, 0x52, 0x42, 0x05,
        14, 2, 3, 3,
    ])

    const typed = new Uint16Array([0x1234, 0xabcd])
    const typedWire = encodeStoreReplayBinary(typed)
    const typedDecoded = decodeStoreReplayBinary(typedWire) as Uint16Array
    const maxBinary = new Uint8Array(8_000_000)
    maxBinary[0] = 1
    maxBinary[maxBinary.length - 1] = 2
    const maxBinaryWire = encodeStoreReplayBinary(maxBinary)
    const maxBinaryDecoded = decodeStoreReplayBinary(maxBinaryWire) as Uint8Array
    let overBinaryRejected = false
    try {
        encodeStoreReplayBinary(new Uint8Array(8_000_001))
    } catch (error) {
        overBinaryRejected = error instanceof RangeError
    }
    const Float16ArrayConstructor = (globalThis as any).Float16Array
    let float16Rejected = typeof Float16ArrayConstructor != 'function'
    if (!float16Rejected) {
        try {
            encodeStoreReplayBinary(new Float16ArrayConstructor([1]))
        } catch (error) {
            float16Rejected = error instanceof TypeError || error instanceof RangeError
        }
    }

    ok(decodeStoreReplayBinary(maxBigIntWire) == maxBigInt
        && overBigIntRejected
        && rejectsBinary(unterminatedBigInt),
    'BigInt accepts 8192 bits and rejects larger or overlong varuint work')
    const trustedUtf16 = decodeStoreReplayBinary(utf16WithoutLoneSurrogate)
    const trustedMap = decodeStoreReplayBinary(duplicateMapKey) as Map<unknown, unknown>
    const trustedSet = decodeStoreReplayBinary(duplicateSetValue) as Set<unknown>
    ok(trustedUtf16 == 'A',
        'trusted Store decode reads UTF-16 data without a redundant canonical-form check')
    ok(trustedMap.size == 1 && trustedMap.get(1) == true
        && trustedSet.size == 1 && trustedSet.has(true),
    'trusted Store decode applies native Map/Set duplicate semantics without validation sets')
    ok(Buffer.from(typedWire).toString('hex') == '535242051105043412cdab'
        && typedDecoded instanceof Uint16Array
        && isDeepStrictEqual(Array.from(typedDecoded), [0x1234, 0xabcd]),
    'multi-byte typed arrays use stable little-endian wire bytes')
    ok(float16Rejected,
        'v5 rejects Float16Array because supported Node 16 peers cannot decode it')
    ok(maxBinaryWire.byteLength > maxBinary.byteLength
        && maxBinaryDecoded.byteLength == maxBinary.byteLength
        && maxBinaryDecoded[0] == 1
        && maxBinaryDecoded[maxBinaryDecoded.length - 1] == 2
        && overBinaryRejected,
    'an 8 MB binary leaf fits inside the larger hard frame while a larger leaf is rejected')
}

function testDecodeBudgetsAndRpcLimits() {
    console.log('\n[store-replay-columnar-binary] decode budgets and client limits')
    const boundaryEvent = {
        seq: 81,
        ts: 82,
        event: [[
            {path: ['A'], exists: true, value: '€'.repeat(4)},
            {path: ['B'], exists: true, value: '\ud800'.repeat(4)},
            {
                path: ['C'],
                exists: true,
                value: new Map([['key', {x: '1234'}]]),
            },
        ]] as [StorePatch[]],
    }
    const boundaryWire = encodeStoreReplayBatchV5(boundaryEvent)
    const boundaryDecoded = decodeStoreReplayBatchV5(boundaryWire, {maxStringLen: 4})
    let overStringRejected = false
    try {
        decodeStoreReplayBatchV5(encodeStoreReplayBatchV5({
            seq: 83,
            ts: 84,
            event: [[{path: ['A'], exists: true, value: '€'.repeat(5)}]] as [StorePatch[]],
        }), {maxStringLen: 4})
    } catch (error) {
        overStringRejected = error instanceof TypeError || error instanceof RangeError
    }
    ok(isDeepStrictEqual(boundaryDecoded, boundaryEvent) && overStringRejected,
        'v5 applies maxStringLen to UTF-8/UTF-16 code units and nested rich values')

    const wideRoot: Record<string, unknown> = Object.create(null)
    for (let index = 0; index < 15_000; index++) {
        wideRoot['K' + index] = {id: 'K' + index, value: index}
    }
    const wideEvent = {
        seq: 85,
        ts: 86,
        event: [[{path: [], exists: true, value: wideRoot}]] as [StorePatch[]],
    }
    const wideWireV4 = encodeStoreReplayBatchV4(wideEvent)
    const wideV4 = decodeStoreReplayBatchV4(wideWireV4)
    const wideV5 = decodeStoreReplayBatchV5(encodeStoreReplayBatchV5(wideEvent))
    ok(wideWireV4[3][0]?.[0] == 4
        && maxArrayLength(wideWireV4[3]) <= 10_000
        && isDeepStrictEqual(wideV4, wideEvent)
        && isDeepStrictEqual(wideV5, wideEvent)
        && Object.getPrototypeOf(wideV4.event[0][0].value) == null
        && Object.getPrototypeOf(wideV5.event[0][0].value) == null,
    '15,000-entry roots retain their prototype and keep every physical plan array within 10,000 items')

    const scalarRoot: Record<string, unknown> = {}
    for (let index = 0; index < 15_000; index++) {
        scalarRoot['S' + index] = index % 4 == 0
            ? false
            : index % 4 == 1
                ? 'value-' + index
                : index % 4 == 2
                    ? null
                    : index
    }
    const scalarEvent = {
        seq: 86,
        ts: 87,
        event: [[{path: [], exists: true, value: scalarRoot}]] as [StorePatch[]],
    }
    const scalarWireV4 = encodeStoreReplayBatchV4(scalarEvent)
    const scalarRootRun = scalarWireV4[3][0]
    const scalarChunks = scalarRootRun?.[0] == 3
        ? scalarRootRun[1].filter(run => run[0] == 0).map(run => run[1].length)
        : []
    ok(isDeepStrictEqual(scalarChunks, [10_000, 5_000])
        && maxArrayLength(scalarWireV4[3]) <= 10_000
        && isDeepStrictEqual(decodeStoreReplayBatchV4(scalarWireV4), scalarEvent)
        && isDeepStrictEqual(decodeStoreReplayBatchV5(encodeStoreReplayBatchV5(scalarEvent)), scalarEvent),
    '15,000 heterogeneous scalar entries use exact 10,000 + 5,000 raw chunks in v4/v5')

    for (let index = 15_000; index <= 20_000; index++) {
        wideRoot['K' + index] = {id: 'K' + index, value: index}
    }
    let tooWideRejected = 0
    for (const encode of [encodeStoreReplayBatchV4, encodeStoreReplayBatchV5]) {
        try { encode(wideEvent) }
        catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) tooWideRejected++
        }
    }
    ok(tooWideRejected == 2, 'both codecs reject a root collection beyond the 20,000-entry budget')

    const halfRoot: Record<string, unknown> = {}
    for (let index = 0; index < 10_001; index++) halfRoot['H' + index] = index
    const aggregateRootEvent = {
        seq: 87,
        ts: 88,
        event: [[
            {path: [], exists: true, value: halfRoot},
            {path: [], exists: true, value: halfRoot},
        ]] as [StorePatch[]],
    }
    let aggregateRejected = 0
    for (const encode of [encodeStoreReplayBatchV4, encodeStoreReplayBatchV5]) {
        try { encode(aggregateRootEvent) }
        catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) aggregateRejected++
        }
    }
    ok(aggregateRejected == 2,
        'two individually valid roots cannot bypass the envelope-wide 20,000-entry budget')

    const ordinaryPatches = Array.from({length: 10_001}, function ordinaryPatch(_, index): StorePatch {
        return {path: ['P' + index], exists: true, value: index}
    })
    const ordinaryEvent = {seq: 89, ts: 90, event: [ordinaryPatches] as [StorePatch[]]}
    let ordinaryRejected = 0
    for (const encode of [encodeStoreReplayBatchV4, encodeStoreReplayBatchV5]) {
        try { encode(ordinaryEvent) }
        catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) ordinaryRejected++
        }
    }
    ok(ordinaryRejected == 2,
        'the wider root budget does not raise the ordinary 10,000-patch ceiling')

    const duplicateRootPlan = [[3, [
        [0, [['DUP', 1]]],
        [0, [['DUP', 2]]],
    ]]]
    ok(rejectsV4([4, 91, 92, duplicateRootPlan])
        && rejectsV5(encodeStoreReplayBinary([91, 92, duplicateRootPlan])),
    'duplicate root keys are rejected even when they cross physical raw chunks')

    const leftTargets = Array.from({length: 6_000}, function leftTarget(_, index) {
        return 'L' + index
    })
    const rightTargets = Array.from({length: 6_000}, function rightTarget(_, index) {
        return 'R' + index
    })
    const expandedPlan = [[1, leftTargets], [1, rightTargets]]
    const expandedV4 = [4, 93, 94, expandedPlan]
    const expandedV5 = encodeStoreReplayBinary([93, 94, expandedPlan])
    ok(rejectsV4(expandedV4) && rejectsV5(expandedV5),
        'v4/v5 share one 10,000 plan-row decode budget across every run')
}

function testMalformedV4() {
    console.log('\n[store-replay-columnar-binary] malformed v4')
    const malformed: unknown[] = [
        null,
        {},
        [5, 1, 1, []],
        ['4', 1, 1, []],
        [4, Number.NaN, 1, []],
        [4, 1, Number.POSITIVE_INFINITY, []],
        [4, 1, 1, [[9, []]]],
        [4, 1, 1, [['0', []]]],
        [4, 1, 1, [[2, ['x', 'x'], -1, ['A'], [[1], [2]]]]],
        [4, 1, 1, [[2, ['x'], -1, ['A'], []]]],
        [4, 1, 1, [[2, ['x'], 2, ['A'], []]]],
        [4, 1, 1, [[0, [['A', {'$_sr': 99}]]]]],
        [4, 1, 1, [[0, [['A', {'$_sr': '0'}]]]]],
        [4, 1, 1, [[3, [[0, [['A', 1], ['A', 2]]]]]]],
        [4, 1, 1, [[3, [[3, []]]]]],
        [4, 1, 1, [[4, [[0, [['A', 1], ['A', 2]]]]]]],
        [4, 1, 1, [[4, [[4, []]]]]],
    ]
    ok(malformed.every(rejectsV4),
        'v4 rejects invalid envelopes, plans, shapes, value tags and nested roots')
}

function testMalformedV5() {
    console.log('\n[store-replay-columnar-binary] malformed v5')
    const valid = new Uint8Array(Buffer.from(goldenV5Hex, 'hex'))
    let everyTruncationRejected = true
    for (let length = 0; length < valid.byteLength; length++) {
        if (!rejectsV5(valid.slice(0, length))) {
            everyTruncationRejected = false
            break
        }
    }

    const wrongMagic = valid.slice()
    wrongMagic[0] ^= 0xff
    const wrongVersion = valid.slice()
    wrongVersion[3] ^= 0xff
    const unknownTag = valid.slice()
    unknownTag[4] = 0xff
    const wrongEnvelopeLength = valid.slice()
    wrongEnvelopeLength[5] = 2
    const trailing = new Uint8Array(valid.byteLength + 1)
    trailing.set(valid)

    ok(everyTruncationRejected,
        'v5 rejects truncation at every byte boundary')
    ok([
        [],
        wrongMagic,
        wrongVersion,
        unknownTag,
        wrongEnvelopeLength,
        trailing,
    ].every(rejectsV5),
    'v5 rejects non-binary wire, bad magic/version/tag, invalid envelope and trailing bytes')
}

function main() {
    testValueMatrix()
    testPollutedPrototypeDecode()
    testShapes()
    testOperations()
    testGoldens()
    testCyclesAndSharing()
    testSelfContainedEnvelopes()
    testBinaryCanonicalLimits()
    testDecodeBudgetsAndRpcLimits()
    testMalformedV4()
    testMalformedV5()

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

try {
    main()
} catch (error) {
    console.error(error)
    process.exit(1)
}
