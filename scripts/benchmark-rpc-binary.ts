// Reproducible pre-framing payload and codec-CPU diagnostic for universal binary RPC.

import {performance} from 'node:perf_hooks'
import {isDeepStrictEqual} from 'node:util'
import {Pkt} from '../src/Common/rcp/rpc-protocol'
import {createRpcBinaryPeer} from '../src/Common/rcp/rpc-binary-peer'
import {inspectRpcBinaryEnvelope, RpcBinaryFrame} from '../src/Common/rcp/rpc-binary-envelope'
import {createBinaryValueCodec} from '../src/Common/rcp/rpc-binary-value'
import {rpcResultWireMetrics} from '../src/Common/rcp/rpc-wire-size'

type tWorkload = {
    name: string
    value: unknown
    iterations?: number
}

function quote(index: number, price: unknown = String(60_000 + index / 10)) {
    return {
        s: 'PAIR' + String(index).padStart(4, '0'),
        c: price,
        E: 1_700_000_000_000 + index,
        active: index % 3 != 0,
        source: {
            venue: 'spot',
            region: index % 2 == 0 ? 'eu' : 'us',
        },
    }
}

function quotes(count: number) {
    return Array.from({length: count}, (_, index) => quote(index))
}

function polymorphicQuotes(count: number) {
    const values = ['61000.1', 61_000.2, false, true, null, undefined]
    return Array.from({length: count}, (_, index) => quote(index, values[index % values.length]))
}

function uniqueShapes(count: number) {
    return Array.from({length: count}, (_, index) => ({['field_' + index]: index}))
}

function codecOwnedBinary(byteLength: number) {
    const codec = createBinaryValueCodec({
        magic: [0x42, 0x45, 0x4e],
        version: 1,
        label: 'benchmark nested binary',
        shapeCache: false,
    })
    return codec.encode(new Uint8Array(Math.max(0, byteLength - 8)))
}

function workloads(): tWorkload[] {
    const trusted1KiB = codecOwnedBinary(1024)
    return [
        {name: 'scalar string', value: 'BTCUSDT', iterations: 10_000},
        {name: 'one quote', value: quote(0), iterations: 5_000},
        {name: '10 quotes', value: quotes(10), iterations: 2_000},
        {name: '50 quotes', value: quotes(50), iterations: 500},
        {name: '700 quotes', value: quotes(700), iterations: 50},
        {name: '50 polymorphic quotes', value: polymorphicQuotes(50), iterations: 500},
        {name: '1,000 object layouts', value: uniqueShapes(1_000), iterations: 10},
        {name: '1,001 layouts (saturated)', value: uniqueShapes(1_001), iterations: 10},
        {
            name: 'rich values',
            value: {
                when: new Date('2026-07-23T12:34:56.789Z'),
                matcher: /BTC|ETH/giu,
                levels: new Map([['bid', new Set([1n, 2n, 3n])]]),
                missing: undefined,
                special: [-0, Number.NaN, Number.POSITIVE_INFINITY, '\ud800'],
            },
            iterations: 2_000,
        },
        {name: 'raw nested ~1 KiB', value: new Uint8Array(trusted1KiB), iterations: 2_000},
        {name: 'codec-owned nested ~1 KiB', value: trusted1KiB, iterations: 2_000},
        {name: '64 KiB binary', value: new Uint8Array(64 * 1024), iterations: 200},
        {name: '1 MiB binary', value: new Uint8Array(1024 * 1024), iterations: 20},
    ]
}

function createPeers() {
    return {
        sender: createRpcBinaryPeer({sessionId: 1, maxShapes: 1_000}),
        receiver: createRpcBinaryPeer({sessionId: 1, maxShapes: 1_000}),
    }
}

function transfer(
    peers: ReturnType<typeof createPeers>,
    packet: any[],
) {
    const prepared = peers.sender.prepare(packet)
    const envelope = inspectRpcBinaryEnvelope(prepared.wire)
    if (!envelope || envelope.kind != RpcBinaryFrame.PACKET) {
        prepared.rollback()
        throw new Error('benchmark produced an invalid binary envelope')
    }
    prepared.commit()
    const decoded = peers.receiver.decode(envelope.payload)
    return {wire: prepared.wire, decoded}
}

function percentSaved(legacy: number, binary: number) {
    return legacy == 0 ? 0 : (1 - binary / legacy) * 100
}

function fixed(value: number, digits = 1) {
    return value.toFixed(digits)
}

function benchmarkCodec(workload: tWorkload) {
    const packet = [Pkt.RESP, 1, workload.value]
    const legacy = rpcResultWireMetrics(packet)

    const coldPeers = createPeers()
    const cold = transfer(coldPeers, packet)
    if (!isDeepStrictEqual(cold.decoded, packet)) {
        throw new Error('cold binary round-trip mismatch: ' + workload.name)
    }

    const warmPeers = createPeers()
    transfer(warmPeers, packet)
    const warm = transfer(warmPeers, packet)
    if (!isDeepStrictEqual(warm.decoded, packet)) {
        throw new Error('warm binary round-trip mismatch: ' + workload.name)
    }

    const iterations = workload.iterations ?? 1_000
    const cpuPeers = createPeers()
    transfer(cpuPeers, packet)
    const started = performance.now()
    for (let index = 0; index < iterations; index++) transfer(cpuPeers, packet)
    const elapsed = performance.now() - started

    return {
        name: workload.name,
        legacyBytes: legacy.byteLength,
        attachments: legacy.binaryCount,
        coldBytes: cold.wire.byteLength,
        warmBytes: warm.wire.byteLength,
        coldSaved: percentSaved(legacy.byteLength, cold.wire.byteLength),
        warmSaved: percentSaved(legacy.byteLength, warm.wire.byteLength),
        roundTripUs: elapsed * 1_000 / iterations,
        shapes: warmPeers.sender.stats().encodeShapes,
    }
}

function printTable(rows: ReturnType<typeof benchmarkCodec>[]) {
    const header = [
        'workload'.padEnd(27),
        'legacy'.padStart(10),
        'cold'.padStart(10),
        'warm'.padStart(10),
        'cold Δ'.padStart(9),
        'warm Δ'.padStart(9),
        'µs e+d'.padStart(10),
        'shapes'.padStart(7),
        'att'.padStart(4),
    ].join('  ')
    console.log(header)
    console.log('-'.repeat(header.length))
    for (const row of rows) {
        console.log([
            row.name.padEnd(27),
            String(row.legacyBytes).padStart(10),
            String(row.coldBytes).padStart(10),
            String(row.warmBytes).padStart(10),
            (fixed(row.coldSaved) + '%').padStart(9),
            (fixed(row.warmSaved) + '%').padStart(9),
            fixed(row.roundTripUs, 2).padStart(10),
            String(row.shapes).padStart(7),
            String(row.attachments).padStart(4),
        ].join('  '))
    }
}

function main() {
    console.log('Universal binary RPC — pre-framing payload bytes and local codec CPU')
    console.log('Legacy = JSON payload + native attachment bytes; binary = actual RPB frame bytes.')
    console.log('Numbers exclude Socket.IO/Engine.IO/WebSocket framing and network compression.\n')
    const rows = workloads().map(benchmarkCodec)
    printTable(rows)
}

main()
