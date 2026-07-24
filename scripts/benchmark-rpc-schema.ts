// Phase-separated CPU and wire benchmark for generic-v1 versus typed-schema-v2.

import {cpus, platform, release} from 'node:os'
import {performance} from 'node:perf_hooks'
import {isDeepStrictEqual} from 'node:util'
import {Pkt} from '../src/Common/rcp/rpc-protocol'
import {createBinaryValueCodec} from '../src/Common/rcp/rpc-binary-value'
import {createRpcBinarySchemaCodec} from '../src/Common/rcp/rpc-binary-schema'

type tScenario = {
    name: string
    packet: any[]
    json: boolean
}

type tSample = {
    medianUs: number
    p95Us: number
    minUs: number
    maxUs: number
    operations: number
}

type tModeResult = {
    scenario: string
    mode: string
    coldBytes: number
    warmBytes: number
    setupBytes: number
    encode: tSample
    decode: tSample
    schemas: number
    runs: number
    rows: number
    generic: number
}

const WINDOW_MS = boundedEnvInteger('RPC_SCHEMA_BENCH_WINDOW_MS', 250, 25, 2_000)
const SAMPLE_WINDOWS = boundedEnvInteger('RPC_SCHEMA_BENCH_WINDOWS', 7, 7, 21)
const WARMUP_WINDOWS = 2
const CODEC_MAGIC = [0x42, 0x53, 0x32] as const
const CODEC_VERSION = 2

function boundedEnvInteger(name: string, fallback: number, minimum: number, maximum: number) {
    const source = process.env[name]
    if (source == undefined) return fallback
    const value = Number(source)
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(name + ' must be an integer from ' + minimum + ' through ' + maximum)
    }
    return value
}

function quote(index: number, price: unknown = 60_000 + index / 10) {
    return {
        symbol: 'PAIR' + String(index).padStart(5, '0'),
        price,
        eventTime: 1_700_000_000_000 + index,
        active: index % 3 != 0,
        venue: 'spot',
        region: index % 2 == 0 ? 'eu' : 'us',
        bid: 59_999 + index / 10,
        ask: 60_001 + index / 10,
    }
}

function wideRow(index: number) {
    const value: Record<string, unknown> = {}
    for (let field = 0; field < 10; field++) value['i' + field] = index + field
    for (let field = 0; field < 10; field++) value['n' + field] = index + field / 16
    for (let field = 0; field < 6; field++) value['s' + field] = 'v' + field + '-' + index
    value['enabled'] = index % 2 == 0
    value['visible'] = index % 3 == 0
    value['missing'] = null
    value['timestamp'] = 1_700_000_000_000 + index
    return value
}

function nestedRow(index: number) {
    return {
        symbol: 'PAIR-' + index,
        revision: index,
        meta: {
            market: 'spot',
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

function mixedRows(count: number) {
    const variants = ['text', 42, false, true, null, undefined]
    return Array.from({length: count}, function createMixed(_, index) {
        return {
            id: index,
            value: variants[index % variants.length],
            timestamp: 1_700_000_000_000 + index,
        }
    })
}

function frequencyRows(count: number) {
    return Array.from({length: count}, function createFrequencyRow(_, index) {
        const slot = index % 100
        if (slot < 90) return {kind: 'A', id: index, value: index + 0.25}
        if (slot < 95) return {kind: 'B', id: String(index), active: true}
        if (slot < 99) return {kind: 'C', id: index, value: null}
        return {['rare_' + index]: index}
    })
}

function response(value: unknown) {
    return [Pkt.RESP, 1, value]
}

function scenarios(): tScenario[] {
    return [
        {
            name: 'primitive mix',
            packet: response([0, 1, -1, 1.25, false, true, null, 'BTCUSDT']),
            json: true,
        },
        {name: 'quote x1', packet: response([quote(0)]), json: true},
        {
            name: 'quote x30',
            packet: response(Array.from({length: 30}, (_, index) => quote(index))),
            json: true,
        },
        {
            name: 'quote x250',
            packet: response(Array.from({length: 250}, (_, index) => quote(index))),
            json: true,
        },
        {
            name: 'quote x700',
            packet: response(Array.from({length: 700}, (_, index) => quote(index))),
            json: true,
        },
        {
            name: '30 fields x250',
            packet: response(Array.from({length: 250}, (_, index) => wideRow(index))),
            json: true,
        },
        {
            name: 'nested x250',
            packet: response(Array.from({length: 250}, (_, index) => nestedRow(index))),
            json: true,
        },
        {name: 'six types x700', packet: response(mixedRows(700)), json: false},
        {name: '90/5/4/1 x1000', packet: response(frequencyRows(1_000)), json: true},
        {name: 'bytes 1 KiB', packet: response(new Uint8Array(1_024)), json: false},
        {name: 'bytes 64 KiB', packet: response(new Uint8Array(64 * 1_024)), json: false},
        {name: 'bytes 1 MiB', packet: response(new Uint8Array(1_024 * 1_024)), json: false},
    ]
}

function percentile(values: number[], ratio: number) {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

function benchmarkOperation(run: () => void): tSample {
    let batch = 1
    while (true) {
        const started = performance.now()
        for (let index = 0; index < batch; index++) run()
        if (performance.now() - started >= Math.min(25, WINDOW_MS / 4)) break
        batch *= 2
    }

    function runWindow() {
        const started = performance.now()
        let operations = 0
        do {
            for (let index = 0; index < batch; index++) run()
            operations += batch
        } while (performance.now() - started < WINDOW_MS)
        const elapsed = performance.now() - started
        return {us: elapsed * 1_000 / operations, operations}
    }

    for (let index = 0; index < WARMUP_WINDOWS; index++) runWindow()
    const windows = Array.from({length: SAMPLE_WINDOWS}, runWindow)
    const values = windows.map(window => window.us)
    return {
        medianUs: percentile(values, 0.5),
        p95Us: percentile(values, 0.95),
        minUs: Math.min(...values),
        maxUs: Math.max(...values),
        operations: windows.reduce((sum, window) => sum + window.operations, 0),
    }
}

function genericMode(scenario: tScenario): tModeResult {
    function createCodec() {
        return createBinaryValueCodec({
            magic: [0x42, 0x56, 0x31],
            version: 1,
            label: 'schema benchmark generic v1',
            callbackRefs: true,
            shapeCache: {maxEntries: 1_000},
            maxDepth: 64,
            maxBinaryBytes: 8_000_000,
            maxWireBytes: 16_000_000,
        })
    }
    const coldWire = createCodec().encode(scenario.packet)
    const encoder = createCodec()
    const decoder = createCodec()
    decoder.decodeTrusted(encoder.encode(scenario.packet))
    const before = encoder.stats()
    const wire = encoder.encode(scenario.packet)
    const representative = encoder.stats()
    const decoded = decoder.decodeTrusted(wire)
    if (!isDeepStrictEqual(decoded, scenario.packet)) {
        throw new Error('generic round-trip mismatch: ' + scenario.name)
    }
    let encoded: Uint8Array | undefined
    const encode = benchmarkOperation(function encodeGenericFrame() {
        encoded = encoder.encode(scenario.packet)
    })
    const decode = benchmarkOperation(function decodeGenericFrame() {
        decoder.decodeTrusted(wire)
    })
    if (!encoded) throw new Error('generic benchmark produced no bytes')
    return {
        scenario: scenario.name,
        mode: 'binary-v1',
        coldBytes: coldWire.byteLength,
        warmBytes: wire.byteLength,
        setupBytes: 0,
        encode,
        decode,
        schemas: representative.encodeShapes,
        runs: 0,
        rows: 0,
        generic: representative.encodeRawShapes - before.encodeRawShapes,
    }
}

function schemaMode(
    scenario: tScenario,
    mode: 'schema-off' | 'schema-dynamic' | 'schema-predeclared',
): tModeResult {
    const options = {
        magic: CODEC_MAGIC,
        version: CODEC_VERSION,
        label: 'schema benchmark ' + mode,
        callbackRefs: true,
        maxSchemas: mode == 'schema-off' ? 0 : 1_000,
        promotionThreshold: 3,
        predeclared: mode == 'schema-predeclared' ? [scenario.packet] : [],
        maxDepth: 64,
        maxBinaryBytes: 8_000_000,
        maxWireBytes: 16_000_000,
    }
    const encoder = createRpcBinarySchemaCodec(options)
    const decoder = createRpcBinarySchemaCodec({...options, predeclared: []})
    function encodeTrusted(value: unknown) {
        const prepared = encoder.prepareEncodeTrusted(value)
        prepared.commit()
        return prepared.wire
    }
    const prelude = encoder.encodePrelude()
    decoder.decodePrelude(prelude)
    const coldWire = encodeTrusted(scenario.packet)
    decoder.decodeTrusted(coldWire)
    for (let index = 0; index < 4; index++) {
        decoder.decodeTrusted(encodeTrusted(scenario.packet))
    }
    const before = encoder.stats()
    const wire = encodeTrusted(scenario.packet)
    const representative = encoder.stats()
    const decoded = decoder.decodeTrusted(wire)
    if (!isDeepStrictEqual(decoded, scenario.packet)) {
        throw new Error(mode + ' round-trip mismatch: ' + scenario.name)
    }
    let encoded: Uint8Array | undefined
    const encode = benchmarkOperation(function encodeSchemaFrame() {
        encoded = encodeTrusted(scenario.packet)
    })
    const decode = benchmarkOperation(function decodeSchemaFrame() {
        decoder.decodeTrusted(wire)
    })
    if (!encoded) throw new Error('schema benchmark produced no bytes')
    return {
        scenario: scenario.name,
        mode,
        coldBytes: coldWire.byteLength,
        warmBytes: wire.byteLength,
        setupBytes: prelude.byteLength,
        encode,
        decode,
        schemas: representative.encodeSchemas,
        runs: representative.encodeRuns - before.encodeRuns,
        rows: representative.encodeRows - before.encodeRows,
        generic: representative.encodeGeneric - before.encodeGeneric,
    }
}

function jsonMode(scenario: tScenario): tModeResult | undefined {
    if (!scenario.json) return undefined
    const wire = JSON.stringify(scenario.packet)
    const decoded = JSON.parse(wire)
    if (!isDeepStrictEqual(decoded, scenario.packet)) {
        throw new Error('JSON fixture is not exact: ' + scenario.name)
    }
    let encoded = ''
    const encode = benchmarkOperation(function encodeJsonFrame() {
        encoded = JSON.stringify(scenario.packet)
    })
    const decode = benchmarkOperation(function decodeJsonFrame() {
        JSON.parse(wire)
    })
    if (encoded.length == 0) throw new Error('JSON benchmark produced no text')
    return {
        scenario: scenario.name,
        mode: 'JSON',
        coldBytes: Buffer.byteLength(wire),
        warmBytes: Buffer.byteLength(wire),
        setupBytes: 0,
        encode,
        decode,
        schemas: 0,
        runs: 0,
        rows: 0,
        generic: 0,
    }
}

function fixed(value: number, digits = 2) {
    return value.toFixed(digits)
}

function printRows(rows: tModeResult[]) {
    const header = [
        'scenario'.padEnd(20),
        'mode'.padEnd(19),
        'cold B'.padStart(10),
        'warm B'.padStart(10),
        'setup B'.padStart(9),
        'enc med'.padStart(10),
        'enc p95'.padStart(10),
        'dec med'.padStart(10),
        'dec p95'.padStart(10),
        'schemas'.padStart(8),
        'runs'.padStart(8),
        'rows'.padStart(10),
        'generic'.padStart(9),
    ].join('  ')
    console.log(header)
    console.log('-'.repeat(header.length))
    for (const row of rows) {
        console.log([
            row.scenario.padEnd(20),
            row.mode.padEnd(19),
            String(row.coldBytes).padStart(10),
            String(row.warmBytes).padStart(10),
            String(row.setupBytes).padStart(9),
            fixed(row.encode.medianUs).padStart(10),
            fixed(row.encode.p95Us).padStart(10),
            fixed(row.decode.medianUs).padStart(10),
            fixed(row.decode.p95Us).padStart(10),
            String(row.schemas).padStart(8),
            String(row.runs).padStart(8),
            String(row.rows).padStart(10),
            String(row.generic).padStart(9),
        ].join('  '))
    }
}

function percentChange(value: number, baseline: number) {
    return ((value / baseline - 1) * 100).toFixed(1) + '%'
}

function printV2Comparison(rows: tModeResult[]) {
    const comparisons = []
    for (const scenario of scenarios()) {
        const v1 = rows.find(row => row.scenario == scenario.name && row.mode == 'binary-v1')
        const dynamic = rows.find(
            row => row.scenario == scenario.name && row.mode == 'schema-dynamic',
        )
        const predeclared = rows.find(
            row => row.scenario == scenario.name && row.mode == 'schema-predeclared',
        )
        if (!v1 || !dynamic || !predeclared) {
            throw new Error('benchmark comparison row is missing for ' + scenario.name)
        }
        comparisons.push({
            scenario: scenario.name,
            'v1 warm B': v1.warmBytes,
            'v2 warm B': dynamic.warmBytes,
            wire: percentChange(dynamic.warmBytes, v1.warmBytes),
            'v1 enc us': fixed(v1.encode.medianUs),
            'v2 dyn enc': fixed(dynamic.encode.medianUs),
            'v2 pre enc': fixed(predeclared.encode.medianUs),
            'dyn enc': percentChange(dynamic.encode.medianUs, v1.encode.medianUs),
            'pre enc': percentChange(predeclared.encode.medianUs, v1.encode.medianUs),
            'v1 dec us': fixed(v1.decode.medianUs),
            'v2 dec us': fixed(dynamic.decode.medianUs),
            decode: percentChange(dynamic.decode.medianUs, v1.decode.medianUs),
        })
    }
    console.log('\nWarm RPB/2 relative to RPB/1; negative percentages are improvements.')
    console.table(comparisons)
}

function main() {
    const runtime = process.versions.bun
        ? 'Bun ' + process.versions.bun
        : 'Node ' + process.version
    console.log('Universal schema binary phase benchmark')
    console.log(runtime + ' | ' + platform() + ' ' + release() + ' | ' + (cpus()[0]?.model || 'unknown CPU'))
    console.log(
        `${SAMPLE_WINDOWS} measured windows x ${WINDOW_MS} ms after ${WARMUP_WINDOWS} warm-up windows`,
    )
    console.log('Times are microseconds per operation; fixture generation and equality checks are outside timed loops.\n')

    const rows: tModeResult[] = []
    for (const scenario of scenarios()) {
        const json = jsonMode(scenario)
        if (json) rows.push(json)
        rows.push(genericMode(scenario))
        rows.push(schemaMode(scenario, 'schema-off'))
        rows.push(schemaMode(scenario, 'schema-dynamic'))
        rows.push(schemaMode(scenario, 'schema-predeclared'))
    }
    printRows(rows)
    printV2Comparison(rows)
}

main()
