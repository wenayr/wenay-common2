// ============================================================
// Store Replay max wire metrics: exact parity with all codecs.
// ============================================================

import {Buffer} from 'node:buffer'
import {isDeepStrictEqual} from 'node:util'
import {StorePatch} from '../src/Common/Observe/store'
import {
    encodeStoreReplayPatch,
    encodeStoreReplayPatchV2,
    encodeStoreReplayPatchV3,
    encodeStoreReplayBatchV4,
    encodeStoreReplayBatchV5,
    storeReplayBatchMaxWireMetrics,
    storeReplayPatchMaxWireMetrics,
} from '../src/Common/Observe/store-replay-codec'
import {rpcResultWireMetrics} from '../src/Common/rcp/rpc-wire-size'

let fails = 0
function ok(condition: unknown, message: string) {
    if (condition) return
    fails++
    console.log('  FAIL', message)
}

function slowStoreReplayPatchMaxWireMetrics(patch: StorePatch, firstBinaryIndex: number) {
    const v1 = rpcResultWireMetrics(encodeStoreReplayPatch(patch), firstBinaryIndex)
    const v2 = rpcResultWireMetrics(encodeStoreReplayPatchV2(patch), firstBinaryIndex)
    const v3 = rpcResultWireMetrics(encodeStoreReplayPatchV3(patch), firstBinaryIndex)
    return {
        byteLength: Math.max(v1.byteLength, v2.byteLength, v3.byteLength),
        binaryCount: Math.max(v1.binaryCount, v2.binaryCount, v3.binaryCount),
    }
}

function slowStoreReplayBatchMaxWireMetrics(patches: readonly StorePatch[]) {
    const event = {
        seq: Number.MAX_SAFE_INTEGER,
        ts: Number.MAX_SAFE_INTEGER,
        event: [patches] as [readonly StorePatch[]],
    }
    const v1 = rpcResultWireMetrics([1, event.seq, event.ts, patches.map(encodeStoreReplayPatch)])
    const v2 = rpcResultWireMetrics([2, event.seq, event.ts, patches.map(encodeStoreReplayPatchV2)])
    const v3 = rpcResultWireMetrics([3, event.seq, event.ts, patches.map(encodeStoreReplayPatchV3)])
    const v4 = rpcResultWireMetrics(encodeStoreReplayBatchV4(event))
    const v5 = rpcResultWireMetrics(encodeStoreReplayBatchV5(event))
    return {
        byteLength: Math.max(v1.byteLength, v2.byteLength, v3.byteLength, v4.byteLength, v5.byteLength),
        binaryCount: Math.max(v1.binaryCount, v2.binaryCount, v3.binaryCount, v4.binaryCount, v5.binaryCount),
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

function createValues() {
    const arrayBuffer = new Uint8Array([5, 6, 7, 8]).buffer
    const nonPlain = Object.create({inherited: true}) as Record<string, unknown>
    nonPlain['direct'] = 'value'
    const nullPrototype = Object.create(null) as Record<string, unknown>
    nullPrototype['direct'] = {explicit: undefined}
    const sparse: unknown[] = []
    sparse.length = 4
    sparse[1] = undefined
    sparse[3] = 'край'

    return [
        null,
        false,
        true,
        0,
        -0,
        1.25,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        '',
        'ASCII',
        'кириллица',
        '東京🙂',
        '"quotes"\\slashes\ncontrols',
        '\ud800 lone surrogate',
        9n,
        Symbol.for('wire-symbol'),
        function wireFunction() {},
        {c: 1.25, t: 1_000_001},
        {nested: {list: [1, undefined, 'значение']}},
        sparse,
        {'$_sr': 0},
        {'$_f': 7},
        {'$_d': 1_700_000_000_000},
        {'$_m': [['BTC', 1]]},
        {'$_s': ['BTC']},
        {'$_r': {source: 'цена', flags: 'giu'}},
        {'$_b': '9007199254740993'},
        {'$_d': 5, business: true},
        {_placeholder: true, num: 9, business: 'keep'},
        ownRecord([
            ['__proto__', {explicit: undefined}],
            ['constructor', 'business-constructor'],
            ['prototype', new Uint8Array([9, 8, 7])],
        ]),
        new Date('2026-07-23T00:00:00.000Z'),
        /котировка/giu,
        new Map<unknown, unknown>([
            ['BTC', {c: 2}],
            [undefined, new Uint8Array([1, 2])],
        ]),
        new Set<unknown>([undefined, 'ETH', new Uint8Array([3, 4, 5])]),
        new Uint8Array([0, 1, 2, 3]),
        new Uint16Array([256, 1024]),
        new DataView(arrayBuffer, 1, 2),
        arrayBuffer,
        Buffer.from([11, 12, 13]),
        nonPlain,
        nullPrototype,
        Array.from({length: 112}, function createIndexedBinary(_, index) {
            return new Uint8Array([index & 255])
        }),
    ]
}

function captureMetrics(measure: () => {byteLength: number, binaryCount: number}) {
    try {
        return {metrics: measure(), error: null}
    } catch (error) {
        return {
            metrics: null,
            error: {
                name: error instanceof Error ? error.name : typeof error,
                message: String(error),
            },
        }
    }
}

function main() {
    const paths: PropertyKey[][] = [
        [],
        ['BTCUSDT'],
        ['ключ🙂'],
        [0],
        [Symbol.for('path-symbol')],
        ['book', 'bid'],
        [1, 'уровень', Symbol.for('nested-symbol')],
    ]
    const firstBinaryIndices = [0, 1, 8, 9, 10, 98, 99, 100, 998, 999, 1_000, 9_998, 9_999, 10_000]
    const values = createValues()
    const patches: StorePatch[] = []

    for (const path of paths) {
        patches.push({path, exists: false, value: undefined})
        patches.push({path, exists: false, value: {ignored: new Uint8Array([1])}})
        patches.push({path, exists: true, value: undefined})
        for (const value of values) patches.push({path, exists: true, value})
    }

    let checks = 0
    for (const patch of patches) {
        for (const firstBinaryIndex of firstBinaryIndices) {
            const expected = captureMetrics(function measureSlowPatch() {
                return slowStoreReplayPatchMaxWireMetrics(patch, firstBinaryIndex)
            })
            const actual = captureMetrics(function measureOptimizedPatch() {
                return storeReplayPatchMaxWireMetrics(patch, firstBinaryIndex)
            })
            ok(isDeepStrictEqual(actual, expected),
                `metrics differ at path length ${patch.path.length}, binary index ${firstBinaryIndex}`)
            checks++
        }
    }

    const modernPatches = patches.filter(function supportedByEveryGeneration(patch) {
        return captureMetrics(function measureSingleBatch() {
            return slowStoreReplayBatchMaxWireMetrics([patch])
        }).error == null
    })
    let batchChecks = 0
    for (const size of [0, 1, 2, 10, 50, 256]) {
        const batch = modernPatches.slice(0, size)
        const expected = slowStoreReplayBatchMaxWireMetrics(batch)
        const actual = storeReplayBatchMaxWireMetrics(batch)
        ok(isDeepStrictEqual(actual, expected), `full-envelope metrics differ at ${size} patches`)
        batchChecks++
    }

    const directCycle: Record<string, unknown> = {}
    directCycle['self'] = directCycle
    const reservedCycle: Record<string, unknown> = {}
    Object.defineProperty(reservedCycle, '__proto__', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: reservedCycle,
    })
    const mapCycle = new Map<unknown, unknown>()
    mapCycle.set('self', mapCycle)

    for (const [label, value] of [
        ['direct object', directCycle],
        ['reserved-key object', reservedCycle],
        ['Map', mapCycle],
    ] as const) {
        const patch: StorePatch = {path: ['cycle'], exists: true, value}
        const expected = captureMetrics(function measureSlowCycle() {
            return slowStoreReplayPatchMaxWireMetrics(patch, 99)
        })
        const actual = captureMetrics(function measureOptimizedCycle() {
            return storeReplayPatchMaxWireMetrics(patch, 99)
        })
        ok(expected.error != null && isDeepStrictEqual(actual.error, expected.error),
            `${label} keeps the slow reference rejection`)
    }

    console.log(`[store-replay-wire-metrics] ${checks} patch and ${batchChecks} envelope parity checks passed`)
    if (fails) {
        console.error(`[store-replay-wire-metrics] ${fails} failures`)
        process.exit(1)
    }
}

main()
