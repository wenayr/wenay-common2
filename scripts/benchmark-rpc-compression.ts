// Reproducible compression diagnostic for warm binary RPC and Store Replay payloads.

import {existsSync, readFileSync} from 'node:fs'
import {performance} from 'node:perf_hooks'
import {resolve} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import * as zlib from 'node:zlib'
import {encodeStoreReplayBatchV5, decodeStoreReplayBatchV5} from '../src/Common/Observe/store-replay-codec'
import type {StorePatch} from '../src/Common/Observe/store'
import {createRpcBinaryPeer} from '../src/Common/rcp/rpc-binary-peer'
import {inspectRpcBinaryEnvelope, RpcBinaryFrame} from '../src/Common/rcp/rpc-binary-envelope'
import {Pkt} from '../src/Common/rcp/rpc-protocol'

type tWorkload = {
    name: string
    value: Buffer
}

type tCodec = {
    name: string
    encode(value: Buffer): Buffer
    decode(value: Buffer): Buffer
}

function asBuffer(value: Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

function quote(index: number) {
    return {
        s: 'PAIR' + String(index).padStart(4, '0'),
        c: String(60_000 + index / 10),
        E: 1_700_000_000_000 + index,
        active: index % 3 != 0,
        source: {
            venue: 'spot',
            region: index % 2 == 0 ? 'eu' : 'us',
        },
    }
}

function quotes(count: number) {
    return Array.from({length: count}, function makeQuote(_, index) {
        return quote(index)
    })
}

function createRpcPeers() {
    return {
        sender: createRpcBinaryPeer({sessionId: 1, maxShapes: 1_000}),
        receiver: createRpcBinaryPeer({sessionId: 1, maxShapes: 1_000}),
    }
}

function transferRpc(
    peers: ReturnType<typeof createRpcPeers>,
    packet: any[],
) {
    const prepared = peers.sender.prepare(packet)
    const envelope = inspectRpcBinaryEnvelope(prepared.wire)
    if (!envelope || envelope.kind != RpcBinaryFrame.PACKET) {
        prepared.rollback()
        throw new Error('compression benchmark produced an invalid RPC binary envelope')
    }
    prepared.commit()
    const decoded = peers.receiver.decode(envelope.payload)
    return {
        wire: asBuffer(prepared.wire),
        decoded,
    }
}

function createWarmRpcPayload(count: number) {
    const peers = createRpcPeers()
    const packet = [Pkt.RESP, 1, quotes(count)]
    transferRpc(peers, packet)
    const warm = transferRpc(peers, packet)
    if (!isDeepStrictEqual(warm.decoded, packet)) {
        throw new Error('warm RPC binary round-trip mismatch at ' + count + ' quotes')
    }
    return warm.wire
}

function createStoreV5Payload(count: number) {
    const patches: StorePatch[] = Array.from({length: count}, function makePatch(_, index) {
        return {
            path: ['S' + index],
            exists: true,
            value: {
                c: index + 0.5,
                t: 1_000_000 + index,
            },
        }
    })
    const event = {
        seq: 1,
        ts: 1,
        event: [patches] as [StorePatch[]],
    }
    const wire = encodeStoreReplayBatchV5(event)
    const decoded = decodeStoreReplayBatchV5(wire)
    if (!isDeepStrictEqual(decoded.event[0], patches)) {
        throw new Error('Store Replay v5 round-trip mismatch at ' + count + ' patches')
    }
    return asBuffer(wire)
}

function encodeDeflateRaw(value: Buffer) {
    return zlib.deflateRawSync(value)
}

function decodeDeflateRaw(value: Buffer) {
    return zlib.inflateRawSync(value)
}

function encodeGzip(value: Buffer) {
    return zlib.gzipSync(value)
}

function decodeGzip(value: Buffer) {
    return zlib.gunzipSync(value)
}

function encodeBrotliQ5(value: Buffer) {
    return zlib.brotliCompressSync(value, {
        params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        },
    })
}

function decodeBrotli(value: Buffer) {
    return zlib.brotliDecompressSync(value)
}

function createZstdCodec() {
    // Node 16 has no zstd API. Dynamic lookup keeps this benchmark runnable
    // there without referring to newer @types/node declarations.
    const namespace = zlib as any
    const compress = namespace['zstdCompressSync']
    const decompress = namespace['zstdDecompressSync']
    if (typeof compress != 'function' || typeof decompress != 'function') return undefined

    function encodeZstd(value: Buffer) {
        return asBuffer(compress(value))
    }

    function decodeZstd(value: Buffer) {
        return asBuffer(decompress(value))
    }

    return {
        name: 'zstd-default',
        encode: encodeZstd,
        decode: decodeZstd,
    }
}

function codecs() {
    const values: tCodec[] = [
        {
            name: 'deflateRaw',
            encode: encodeDeflateRaw,
            decode: decodeDeflateRaw,
        },
        {
            name: 'gzip',
            encode: encodeGzip,
            decode: decodeGzip,
        },
        {
            name: 'brotli-q5',
            encode: encodeBrotliQ5,
            decode: decodeBrotli,
        },
    ]
    const zstd = createZstdCodec()
    if (zstd) values.push(zstd)
    return values
}

function createWorkloads() {
    const values: tWorkload[] = [
        {name: 'warm RPB 50 quotes', value: createWarmRpcPayload(50)},
        {name: 'warm RPB 700 quotes', value: createWarmRpcPayload(700)},
        {name: 'Store v5 50 patches', value: createStoreV5Payload(50)},
        {name: 'Store v5 700 patches', value: createStoreV5Payload(700)},
    ]
    const demoClientPath = resolve(__dirname, '..', 'demo', 'public', 'client.js')
    if (existsSync(demoClientPath)) {
        values.push({
            name: 'demo/public/client.js',
            value: readFileSync(demoClientPath),
        })
    }
    return {
        values,
        demoClientFound: existsSync(demoClientPath),
    }
}

function iterationsFor(byteLength: number) {
    if (byteLength > 500_000) return 10
    if (byteLength > 50_000) return 50
    if (byteLength > 10_000) return 100
    return 300
}

function measureUs(iterations: number, run: () => unknown) {
    const started = performance.now()
    for (let index = 0; index < iterations; index++) run()
    return (performance.now() - started) * 1_000 / iterations
}

function percentSaved(rawBytes: number, compressedBytes: number) {
    return rawBytes == 0 ? 0 : (1 - compressedBytes / rawBytes) * 100
}

function benchmarkCodec(workload: tWorkload, codec: tCodec) {
    const compressed = codec.encode(workload.value)
    const restored = codec.decode(compressed)
    if (!restored.equals(workload.value)) {
        throw new Error(codec.name + ' round-trip mismatch for ' + workload.name)
    }
    const iterations = iterationsFor(workload.value.byteLength)
    const encodeUs = measureUs(iterations, function encodeCompressionRound() {
        return codec.encode(workload.value)
    })
    const decodeUs = measureUs(iterations, function decodeCompressionRound() {
        return codec.decode(compressed)
    })
    return {
        workload: workload.name,
        codec: codec.name,
        rawBytes: workload.value.byteLength,
        compressedBytes: compressed.byteLength,
        saved: percentSaved(workload.value.byteLength, compressed.byteLength),
        encodeUs,
        decodeUs,
        iterations,
    }
}

function printRows(rows: ReturnType<typeof benchmarkCodec>[]) {
    const header = [
        'workload'.padEnd(27),
        'codec'.padEnd(14),
        'raw'.padStart(10),
        'compressed'.padStart(11),
        'saved'.padStart(9),
        'encode us'.padStart(11),
        'decode us'.padStart(11),
        'rounds'.padStart(7),
    ].join('  ')
    console.log(header)
    console.log('-'.repeat(header.length))
    for (const row of rows) {
        console.log([
            row.workload.padEnd(27),
            row.codec.padEnd(14),
            String(row.rawBytes).padStart(10),
            String(row.compressedBytes).padStart(11),
            (row.saved.toFixed(1) + '%').padStart(9),
            row.encodeUs.toFixed(2).padStart(11),
            row.decodeUs.toFixed(2).padStart(11),
            String(row.iterations).padStart(7),
        ].join('  '))
    }
}

function main() {
    const selectedCodecs = codecs()
    const workloads = createWorkloads()
    const rows: ReturnType<typeof benchmarkCodec>[] = []
    for (const workload of workloads.values) {
        for (const codec of selectedCodecs) rows.push(benchmarkCodec(workload, codec))
    }

    const versions = process.versions as any
    console.log('RPC compression benchmark — independent complete payloads')
    console.log(
        'Node ' + process.version
        + ' · zlib ' + process.versions.zlib
        + ' · brotli ' + (versions['brotli'] ?? 'unknown')
        + ' · zstd ' + (versions['zstd'] ?? 'unavailable'),
    )
    console.log('Sizes exclude Socket.IO, Engine.IO and WebSocket framing/context takeover.\n')
    printRows(rows)
    if (!workloads.demoClientFound) {
        console.log('\ndemo/public/client.js is absent; static bundle workload skipped.')
    }
    if (!selectedCodecs.some(codec => codec.name == 'zstd-default')) {
        console.log('zstd is unavailable in this Node runtime; zstd rows skipped.')
    }
}

main()
