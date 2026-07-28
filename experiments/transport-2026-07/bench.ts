// =====================================================================
// July 2026 transport experiment
// =====================================================================
// The stand keeps codec cost and transport cost visible as separate rows.
// It is intentionally outside src: no package API or build artifact depends on it.

import {createServer, type Server as HttpServer} from 'node:http'
import {cpus, arch, platform, release} from 'node:os'
import {performance} from 'node:perf_hooks'
import {Server as SocketIoServer} from 'socket.io'
import {io as createSocketIoClient} from 'socket.io-client'
import * as msgpackParser from 'socket.io-msgpack-parser'
import WebSocket, {WebSocketServer, type RawData} from 'ws'
import {createBinaryValueCodec} from '../../src/Common/events/replay-binary-value'

const BINARY_MAGIC = [0x54, 0x32, 0x36] as const
const WIRE_EVENT = 0
const ISOLATED_MESSAGES = positiveIntegerEnv('TRANSPORT_BENCH_ISOLATED', 500)
const BURSTS = positiveIntegerEnv('TRANSPORT_BENCH_BURSTS', 40)
const BURST_SIZE = positiveIntegerEnv('TRANSPORT_BENCH_BURST_SIZE', 250)
const GAP_MS = nonNegativeNumberEnv('TRANSPORT_BENCH_GAP_MS', 3)
const CODEC_SINGLE_ITERATIONS = positiveIntegerEnv('TRANSPORT_BENCH_CODEC_SINGLE', 50_000)
const CODEC_BATCH_ITERATIONS = positiveIntegerEnv('TRANSPORT_BENCH_CODEC_BATCH', 400)
const OPAQUE_BYTES = positiveIntegerEnv('TRANSPORT_BENCH_OPAQUE_BYTES', 96)
const OPAQUE_ONLY = process.env['TRANSPORT_BENCH_OPAQUE_ONLY'] == '1'

type tPayload = ReturnType<typeof smallPayload> | ReturnType<typeof mediumPayload>
type tPayloadFactory = (seq: number) => tPayload
type tCodecMode = 'json' | 'binary'
type tScenario = 'isolated-3ms' | 'burst-250'

type EchoLink = {
    roundTrip: (value: tPayload) => Promise<tPayload>
    close: () => Promise<void>
}

type OpaqueEchoLink = {
    roundTrip: () => Promise<void>
    close: () => Promise<void>
}

type Measurement = {
    layer: 'codec' | 'transport'
    candidate: string
    payload: string
    scenario: string
    messages: number
    wallMs: number
    cpuUsPerMessage?: number
    latencyP50Ms?: number
    latencyP95Ms?: number
    latencyP99Ms?: number
    messagesPerSecond?: number
    wireBytesPerMessage?: number
}

// =====================================================================
// Options and payloads
// =====================================================================

function positiveIntegerEnv(name: string, fallback: number) {
    const raw = process.env[name]
    if (raw == null || raw == '') return fallback
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(name + ' must be a positive integer')
    return value
}

function nonNegativeNumberEnv(name: string, fallback: number) {
    const raw = process.env[name]
    if (raw == null || raw == '') return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) throw new RangeError(name + ' must be a non-negative number')
    return value
}

function smallPayload(seq: number) {
    return {
        type: 'quote',
        symbol: 'BTCUSDT',
        bid: 104_245.12,
        ask: 104_245.18,
        volume: 0.017,
        seq,
    }
}

function mediumPayload(seq: number) {
    return {
        type: 'market-update',
        exchange: 'example-futures',
        symbol: 'BTCUSDT',
        ts: 1_785_000_000_000 + seq,
        seq,
        quote: {
            bid: 104_245.12,
            ask: 104_245.18,
            bidSize: 2.371,
            askSize: 1.984,
        },
        stats: {
            open: 102_101.04,
            high: 105_002.91,
            low: 101_887.44,
            volume: 18_721.531,
            trades: 493_201,
        },
        flags: ['live', 'derivative', 'usd'],
    }
}

function createExperimentCodec(label: string) {
    return createBinaryValueCodec({
        magic: BINARY_MAGIC,
        version: 1,
        label,
        callbackRefs: false,
        shapeCache: {maxEntries: 1_000},
        maxDepth: 36,
        maxBinaryBytes: 8_000_000,
        maxWireBytes: 16_000_000,
    })
}

// =====================================================================
// Measurement primitives
// =====================================================================

function delay(ms: number) {
    return new Promise<void>(function wait(resolve) {
        setTimeout(resolve, ms)
    })
}

function percentile(values: number[], ratio: number) {
    if (values.length == 0) return 0
    const sorted = values.slice().sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]
}

function cpuMicroseconds(delta: NodeJS.CpuUsage) {
    return delta.user + delta.system
}

function rawDataByteLength(raw: RawData) {
    if (Array.isArray(raw)) return raw.reduce((sum, item) => sum + item.byteLength, 0)
    return raw.byteLength
}

function assertEcho(expected: tPayload, actual: tPayload) {
    if (actual?.seq != expected.seq || actual?.type != expected.type) {
        throw new Error('echo payload mismatch')
    }
}

async function warmTransport(link: EchoLink, payload: tPayloadFactory) {
    for (let index = 0; index < 100; index++) {
        const value = payload(-1 - index)
        assertEcho(value, await link.roundTrip(value))
    }
    const ready: Promise<tPayload>[] = []
    for (let index = 0; index < Math.min(BURST_SIZE, 100); index++) {
        ready.push(link.roundTrip(payload(-1_000 - index)))
    }
    await Promise.all(ready)
}

async function measureIsolated(candidate: string, link: EchoLink, payloadName: string, payload: tPayloadFactory) {
    const latencies: number[] = []
    const wallStart = performance.now()
    for (let index = 0; index < ISOLATED_MESSAGES; index++) {
        const value = payload(index)
        const started = performance.now()
        const response = await link.roundTrip(value)
        latencies.push(performance.now() - started)
        assertEcho(value, response)
        if (GAP_MS > 0) await delay(GAP_MS)
    }
    const wallMs = performance.now() - wallStart
    return {
        layer: 'transport',
        candidate,
        payload: payloadName,
        scenario: 'isolated-' + GAP_MS + 'ms',
        messages: ISOLATED_MESSAGES,
        wallMs,
        latencyP50Ms: percentile(latencies, 0.50),
        latencyP95Ms: percentile(latencies, 0.95),
        latencyP99Ms: percentile(latencies, 0.99),
    } satisfies Measurement
}

async function measureBursts(candidate: string, link: EchoLink, payloadName: string, payload: tPayloadFactory) {
    const latencies: number[] = []
    let nextSeq = 1_000_000
    const cpuStart = process.cpuUsage()
    const wallStart = performance.now()
    for (let burst = 0; burst < BURSTS; burst++) {
        const pending: Promise<void>[] = []
        for (let index = 0; index < BURST_SIZE; index++) {
            const value = payload(nextSeq++)
            const started = performance.now()
            pending.push(link.roundTrip(value).then(function verifyBurstEcho(response) {
                latencies.push(performance.now() - started)
                assertEcho(value, response)
            }))
        }
        await Promise.all(pending)
    }
    const wallMs = performance.now() - wallStart
    const cpu = process.cpuUsage(cpuStart)
    const messages = BURSTS * BURST_SIZE
    return {
        layer: 'transport',
        candidate,
        payload: payloadName,
        scenario: 'burst-' + BURST_SIZE,
        messages,
        wallMs,
        cpuUsPerMessage: cpuMicroseconds(cpu) / messages,
        latencyP50Ms: percentile(latencies, 0.50),
        latencyP95Ms: percentile(latencies, 0.95),
        latencyP99Ms: percentile(latencies, 0.99),
        messagesPerSecond: messages / (wallMs / 1_000),
    } satisfies Measurement
}

async function measureTransport(
    candidate: string,
    createLink: () => Promise<EchoLink>,
    payloadName: string,
    payload: tPayloadFactory,
) {
    const link = await createLink()
    try {
        await warmTransport(link, payload)
        return [
            await measureIsolated(candidate, link, payloadName, payload),
            await measureBursts(candidate, link, payloadName, payload),
        ]
    } finally {
        await link.close()
    }
}

async function warmOpaqueTransport(link: OpaqueEchoLink) {
    for (let index = 0; index < 100; index++) await link.roundTrip()
    await Promise.all(Array.from({length: Math.min(BURST_SIZE, 100)}, function warmOpaqueBurst() {
        return link.roundTrip()
    }))
}

async function measureOpaqueIsolated(candidate: string, link: OpaqueEchoLink) {
    const latencies: number[] = []
    const wallStart = performance.now()
    for (let index = 0; index < ISOLATED_MESSAGES; index++) {
        const started = performance.now()
        await link.roundTrip()
        latencies.push(performance.now() - started)
        if (GAP_MS > 0) await delay(GAP_MS)
    }
    return {
        layer: 'transport',
        candidate,
        payload: 'opaque-' + OPAQUE_BYTES + '-byte',
        scenario: 'isolated-' + GAP_MS + 'ms',
        messages: ISOLATED_MESSAGES,
        wallMs: performance.now() - wallStart,
        latencyP50Ms: percentile(latencies, 0.50),
        latencyP95Ms: percentile(latencies, 0.95),
        latencyP99Ms: percentile(latencies, 0.99),
        wireBytesPerMessage: OPAQUE_BYTES,
    } satisfies Measurement
}

async function measureOpaqueBursts(candidate: string, link: OpaqueEchoLink) {
    const latencies: number[] = []
    const cpuStart = process.cpuUsage()
    const wallStart = performance.now()
    for (let burst = 0; burst < BURSTS; burst++) {
        const pending: Promise<void>[] = []
        for (let index = 0; index < BURST_SIZE; index++) {
            const started = performance.now()
            pending.push(link.roundTrip().then(function measureOpaqueLatency() {
                latencies.push(performance.now() - started)
            }))
        }
        await Promise.all(pending)
    }
    const wallMs = performance.now() - wallStart
    const cpu = process.cpuUsage(cpuStart)
    const messages = BURSTS * BURST_SIZE
    return {
        layer: 'transport',
        candidate,
        payload: 'opaque-' + OPAQUE_BYTES + '-byte',
        scenario: 'burst-' + BURST_SIZE,
        messages,
        wallMs,
        cpuUsPerMessage: cpuMicroseconds(cpu) / messages,
        latencyP50Ms: percentile(latencies, 0.50),
        latencyP95Ms: percentile(latencies, 0.95),
        latencyP99Ms: percentile(latencies, 0.99),
        messagesPerSecond: messages / (wallMs / 1_000),
        wireBytesPerMessage: OPAQUE_BYTES,
    } satisfies Measurement
}

async function measureOpaqueTransport(candidate: string, createLink: () => Promise<OpaqueEchoLink>) {
    const link = await createLink()
    try {
        await warmOpaqueTransport(link)
        return [
            await measureOpaqueIsolated(candidate, link),
            await measureOpaqueBursts(candidate, link),
        ]
    } finally {
        await link.close()
    }
}

function measureCodec(
    candidate: tCodecMode,
    payloadName: string,
    payloadFactory: tPayloadFactory,
    batchSize: number,
    iterations: number,
) {
    const encoder = candidate == 'binary' ? createExperimentCodec('codec benchmark encode') : null
    const decoder = candidate == 'binary' ? createExperimentCodec('codec benchmark decode') : null
    const value = batchSize == 1
        ? payloadFactory(1)
        : Array.from({length: batchSize}, function createBatchPayload(_item, index) {
            return payloadFactory(index + 1)
        })

    function cycle() {
        if (candidate == 'json') return JSON.parse(JSON.stringify(value))
        return decoder!.decode(encoder!.encode(value))
    }

    for (let index = 0; index < Math.min(iterations, 2_000); index++) cycle()
    const cpuStart = process.cpuUsage()
    const wallStart = performance.now()
    let decoded: any
    for (let index = 0; index < iterations; index++) decoded = cycle()
    const wallMs = performance.now() - wallStart
    const cpu = process.cpuUsage(cpuStart)
    const logicalMessages = iterations * batchSize
    const wireBytes = candidate == 'json'
        ? Buffer.byteLength(JSON.stringify(value))
        : encoder!.encode(value).byteLength

    if (batchSize == 1) assertEcho(value as tPayload, decoded as tPayload)
    else if (!Array.isArray(decoded) || decoded.length != batchSize) throw new Error('codec batch mismatch')

    return {
        layer: 'codec',
        candidate,
        payload: payloadName,
        scenario: batchSize == 1 ? 'codec-single' : 'codec-batch-' + batchSize,
        messages: logicalMessages,
        wallMs,
        cpuUsPerMessage: cpuMicroseconds(cpu) / logicalMessages,
        messagesPerSecond: logicalMessages / (wallMs / 1_000),
        wireBytesPerMessage: wireBytes / batchSize,
    } satisfies Measurement
}

// =====================================================================
// Socket.IO resource
// =====================================================================

async function listenEphemeral(server: HttpServer) {
    await new Promise<void>(function listen(resolve, reject) {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', function listening() {
            server.off('error', reject)
            resolve()
        })
    })
    const address = server.address()
    if (address == null || typeof address == 'string') throw new Error('missing TCP server address')
    return address.port
}

async function closeHttpServer(server: HttpServer) {
    if (!server.listening) return
    await new Promise<void>(function close(resolve, reject) {
        server.close(function closed(error) {
            if (error) reject(error)
            else resolve()
        })
    })
}

async function createSocketIoLink(mode: tCodecMode): Promise<EchoLink> {
    const httpServer = createServer()
    const ioServer = new SocketIoServer(httpServer, {
        transports: ['websocket'],
        perMessageDeflate: false,
        serveClient: false,
    })
    const serverDecoder = mode == 'binary' ? createExperimentCodec('socket.io server decode') : null
    const serverEncoder = mode == 'binary' ? createExperimentCodec('socket.io server encode') : null

    ioServer.on('connection', function serveEcho(socket) {
        socket.on('echo', function echo(value) {
            if (mode == 'json') {
                socket.emit('echo', value)
                return
            }
            const decoded = serverDecoder!.decode(value)
            socket.emit('echo', serverEncoder!.encode(decoded))
        })
    })

    const port = await listenEphemeral(httpServer)
    const socket = createSocketIoClient('http://127.0.0.1:' + port, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
    })
    await new Promise<void>(function waitForConnect(resolve, reject) {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
    })

    const clientEncoder = mode == 'binary' ? createExperimentCodec('socket.io client encode') : null
    const clientDecoder = mode == 'binary' ? createExperimentCodec('socket.io client decode') : null
    const pending = new Map<number, {resolve: (value: tPayload) => void, reject: (error: Error) => void}>()

    socket.on('echo', function receiveEcho(raw) {
        let value: tPayload
        try {
            value = (mode == 'json' ? raw : clientDecoder!.decode(raw)) as tPayload
        } catch (error) {
            for (const item of pending.values()) item.reject(error as Error)
            pending.clear()
            return
        }
        const item = pending.get(value.seq)
        if (!item) return
        pending.delete(value.seq)
        item.resolve(value)
    })

    function roundTrip(value: tPayload) {
        return new Promise<tPayload>(function send(resolve, reject) {
            pending.set(value.seq, {resolve, reject})
            try {
                socket.emit('echo', mode == 'json' ? value : clientEncoder!.encode(value))
            } catch (error) {
                pending.delete(value.seq)
                reject(error as Error)
            }
        })
    }

    async function close() {
        socket.disconnect()
        await new Promise<void>(function closeIo(resolve) {
            ioServer.close(function closed() {
                resolve()
            })
        })
        await closeHttpServer(httpServer)
    }

    return {roundTrip, close}
}

async function createOpaqueSocketIoLink(parser?: typeof msgpackParser): Promise<OpaqueEchoLink> {
    const httpServer = createServer()
    const parserOptions = parser == null ? {} : {parser: parser as any}
    const ioServer = new SocketIoServer(httpServer, {
        transports: ['websocket'],
        perMessageDeflate: false,
        serveClient: false,
        ...parserOptions,
    })

    ioServer.on('connection', function serveOpaqueEcho(socket) {
        socket.on('opaque', function echoOpaque(value) {
            socket.emit('opaque', value)
        })
    })

    const port = await listenEphemeral(httpServer)
    const socket = createSocketIoClient('http://127.0.0.1:' + port, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        ...parserOptions,
    })
    await new Promise<void>(function waitForConnect(resolve, reject) {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
    })

    const payload = new Uint8Array(OPAQUE_BYTES)
    for (let index = 0; index < payload.length; index++) payload[index] = index & 255
    let pending: Array<{resolve: () => void, reject: (error: Error) => void}> = []
    let pendingHead = 0

    socket.on('opaque', function receiveOpaque(value) {
        const byteLength = value?.byteLength
        const item = pending[pendingHead++]
        if (!item) return
        if (byteLength != OPAQUE_BYTES) item.reject(new Error('opaque Socket.IO payload mismatch'))
        else item.resolve()
        if (pendingHead == pending.length) {
            pending = []
            pendingHead = 0
        }
    })

    function roundTrip() {
        return new Promise<void>(function send(resolve, reject) {
            pending.push({resolve, reject})
            try {
                socket.emit('opaque', payload)
            } catch (error) {
                reject(error as Error)
            }
        })
    }

    async function close() {
        socket.disconnect()
        await new Promise<void>(function closeIo(resolve) {
            ioServer.close(function closed() {
                resolve()
            })
        })
        await closeHttpServer(httpServer)
    }

    return {roundTrip, close}
}

// =====================================================================
// Raw WebSocket resource
// =====================================================================

async function createRawWebSocketLink(mode: tCodecMode): Promise<EchoLink> {
    const httpServer = createServer()
    const webSocketServer = new WebSocketServer({
        server: httpServer,
        perMessageDeflate: false,
    })
    const serverDecoder = mode == 'binary' ? createExperimentCodec('raw ws server decode') : null
    const serverEncoder = mode == 'binary' ? createExperimentCodec('raw ws server encode') : null

    webSocketServer.on('connection', function serveEcho(socket) {
        socket.on('message', function echo(raw, isBinary) {
            if (mode == 'json') {
                if (isBinary) throw new Error('unexpected raw WebSocket binary frame')
                const packet = JSON.parse(raw.toString())
                socket.send(JSON.stringify(packet), {binary: false, compress: false})
                return
            }
            const packet = serverDecoder!.decode(raw)
            socket.send(serverEncoder!.encode(packet), {binary: true, compress: false})
        })
    })

    const port = await listenEphemeral(httpServer)
    const socket = new WebSocket('ws://127.0.0.1:' + port, {
        perMessageDeflate: false,
    })
    await new Promise<void>(function waitForOpen(resolve, reject) {
        socket.once('open', resolve)
        socket.once('error', reject)
    })

    const clientEncoder = mode == 'binary' ? createExperimentCodec('raw ws client encode') : null
    const clientDecoder = mode == 'binary' ? createExperimentCodec('raw ws client decode') : null
    const pending = new Map<number, {resolve: (value: tPayload) => void, reject: (error: Error) => void}>()

    socket.on('message', function receiveEcho(raw, isBinary) {
        let packet: any
        try {
            if (mode == 'json') {
                if (isBinary) throw new Error('unexpected raw WebSocket binary response')
                packet = JSON.parse(raw.toString())
            } else {
                packet = clientDecoder!.decode(raw)
            }
        } catch (error) {
            for (const item of pending.values()) item.reject(error as Error)
            pending.clear()
            return
        }
        if (!Array.isArray(packet) || packet[0] != WIRE_EVENT) return
        const value = packet[1] as tPayload
        const item = pending.get(value.seq)
        if (!item) return
        pending.delete(value.seq)
        item.resolve(value)
    })

    function roundTrip(value: tPayload) {
        return new Promise<tPayload>(function send(resolve, reject) {
            pending.set(value.seq, {resolve, reject})
            try {
                const packet = [WIRE_EVENT, value]
                if (mode == 'json') {
                    socket.send(JSON.stringify(packet), {binary: false, compress: false})
                } else {
                    socket.send(clientEncoder!.encode(packet), {binary: true, compress: false})
                }
            } catch (error) {
                pending.delete(value.seq)
                reject(error as Error)
            }
        })
    }

    async function close() {
        if (socket.readyState == WebSocket.OPEN || socket.readyState == WebSocket.CONNECTING) {
            await new Promise<void>(function closeClient(resolve) {
                socket.once('close', resolve)
                socket.close()
            })
        }
        await new Promise<void>(function closeWebSocketServer(resolve, reject) {
            webSocketServer.close(function closed(error) {
                if (error) reject(error)
                else resolve()
            })
        })
        await closeHttpServer(httpServer)
    }

    return {roundTrip, close}
}

async function createOpaqueRawWebSocketLink(): Promise<OpaqueEchoLink> {
    const httpServer = createServer()
    const webSocketServer = new WebSocketServer({
        server: httpServer,
        perMessageDeflate: false,
    })

    webSocketServer.on('connection', function serveOpaqueEcho(socket) {
        socket.on('message', function echoOpaque(raw, isBinary) {
            if (!isBinary || rawDataByteLength(raw) != OPAQUE_BYTES) {
                throw new Error('opaque raw WebSocket payload mismatch')
            }
            socket.send(raw, {binary: true, compress: false})
        })
    })

    const port = await listenEphemeral(httpServer)
    const socket = new WebSocket('ws://127.0.0.1:' + port, {
        perMessageDeflate: false,
    })
    await new Promise<void>(function waitForOpen(resolve, reject) {
        socket.once('open', resolve)
        socket.once('error', reject)
    })

    const payload = new Uint8Array(OPAQUE_BYTES)
    for (let index = 0; index < payload.length; index++) payload[index] = index & 255
    let pending: Array<{resolve: () => void, reject: (error: Error) => void}> = []
    let pendingHead = 0

    socket.on('message', function receiveOpaque(raw, isBinary) {
        const item = pending[pendingHead++]
        if (!item) return
        if (!isBinary || rawDataByteLength(raw) != OPAQUE_BYTES) item.reject(new Error('opaque raw WebSocket response mismatch'))
        else item.resolve()
        if (pendingHead == pending.length) {
            pending = []
            pendingHead = 0
        }
    })

    function roundTrip() {
        return new Promise<void>(function send(resolve, reject) {
            pending.push({resolve, reject})
            try {
                socket.send(payload, {binary: true, compress: false})
            } catch (error) {
                reject(error as Error)
            }
        })
    }

    async function close() {
        if (socket.readyState == WebSocket.OPEN || socket.readyState == WebSocket.CONNECTING) {
            await new Promise<void>(function closeClient(resolve) {
                socket.once('close', resolve)
                socket.close()
            })
        }
        await new Promise<void>(function closeWebSocketServer(resolve, reject) {
            webSocketServer.close(function closed(error) {
                if (error) reject(error)
                else resolve()
            })
        })
        await closeHttpServer(httpServer)
    }

    return {roundTrip, close}
}

// =====================================================================
// Report
// =====================================================================

function rounded(value: number | undefined) {
    return value == null ? undefined : Number(value.toFixed(3))
}

function tableRows(results: Measurement[]) {
    return results.map(function createTableRow(result) {
        return {
            layer: result.layer,
            candidate: result.candidate,
            payload: result.payload,
            scenario: result.scenario,
            messages: result.messages,
            wallMs: rounded(result.wallMs),
            cpuUsPerMsg: rounded(result.cpuUsPerMessage),
            p50Ms: rounded(result.latencyP50Ms),
            p95Ms: rounded(result.latencyP95Ms),
            p99Ms: rounded(result.latencyP99Ms),
            msgPerSec: rounded(result.messagesPerSecond),
            bytesPerMsg: rounded(result.wireBytesPerMessage),
        }
    })
}

async function main() {
    const payloads = [
        {name: 'small', create: smallPayload},
        {name: 'medium', create: mediumPayload},
    ] as const
    const results: Measurement[] = []

    console.log('Transport experiment — July 2026')
    console.log(JSON.stringify({
        runtime: {
            node: process.version,
            platform: platform(),
            release: release(),
            arch: arch(),
            cpu: cpus()[0]?.model,
            logicalCpus: cpus().length,
        },
        options: {
            isolatedMessages: ISOLATED_MESSAGES,
            bursts: BURSTS,
            burstSize: BURST_SIZE,
            gapMs: GAP_MS,
            codecSingleIterations: CODEC_SINGLE_ITERATIONS,
            codecBatchIterations: CODEC_BATCH_ITERATIONS,
            opaqueBytes: OPAQUE_BYTES,
            opaqueOnly: OPAQUE_ONLY,
        },
        payloadJsonBytes: Object.fromEntries(payloads.map(function payloadSize(payload) {
            return [payload.name, Buffer.byteLength(JSON.stringify(payload.create(1)))]
        })),
    }, null, 2))

    if (!OPAQUE_ONLY) {
        console.log('\nCodec-only pass')
        for (const payload of payloads) {
            results.push(measureCodec('json', payload.name, payload.create, 1, CODEC_SINGLE_ITERATIONS))
            results.push(measureCodec('binary', payload.name, payload.create, 1, CODEC_SINGLE_ITERATIONS))
            results.push(measureCodec('json', payload.name, payload.create, BURST_SIZE, CODEC_BATCH_ITERATIONS))
            results.push(measureCodec('binary', payload.name, payload.create, BURST_SIZE, CODEC_BATCH_ITERATIONS))
        }
        console.table(tableRows(results.filter(result => result.layer == 'codec')))
    }

    const candidates = [
        {
            name: 'socket.io-json',
            create: function createSocketIoJson() {
                return createSocketIoLink('json')
            },
        },
        {
            name: 'socket.io-project-binary',
            create: function createSocketIoBinary() {
                return createSocketIoLink('binary')
            },
        },
        {
            name: 'raw-ws-json',
            create: function createRawWebSocketJson() {
                return createRawWebSocketLink('json')
            },
        },
        {
            name: 'raw-ws-project-binary',
            create: function createRawWebSocketBinary() {
                return createRawWebSocketLink('binary')
            },
        },
    ] as const

    if (!OPAQUE_ONLY) {
        console.log('\nObject transport pass')
        for (const payload of payloads) {
            for (const candidate of candidates) {
                console.log('  running ' + candidate.name + ' / ' + payload.name)
                results.push(...await measureTransport(candidate.name, candidate.create, payload.name, payload.create))
            }
        }
        console.table(tableRows(results.filter(result => result.layer == 'transport')))
    }

    const opaqueCandidates = [
        {
            name: 'socket.io-default-binary',
            create: function createSocketIoDefaultBinary() {
                return createOpaqueSocketIoLink()
            },
        },
        {
            name: 'socket.io-msgpack-binary',
            create: function createSocketIoMsgpackBinary() {
                return createOpaqueSocketIoLink(msgpackParser)
            },
        },
        {
            name: 'raw-ws-opaque-binary',
            create: createOpaqueRawWebSocketLink,
        },
    ] as const

    console.log('\nOpaque transport-only pass')
    const opaqueResults: Measurement[] = []
    for (const candidate of opaqueCandidates) {
        console.log('  running ' + candidate.name)
        opaqueResults.push(...await measureOpaqueTransport(candidate.name, candidate.create))
    }
    results.push(...opaqueResults)
    console.table(tableRows(opaqueResults))

    console.log('\n##RESULT##')
    console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        runtime: {
            node: process.version,
            platform: platform(),
            release: release(),
            arch: arch(),
            cpu: cpus()[0]?.model,
            logicalCpus: cpus().length,
        },
        options: {
            isolatedMessages: ISOLATED_MESSAGES,
            bursts: BURSTS,
            burstSize: BURST_SIZE,
            gapMs: GAP_MS,
            codecSingleIterations: CODEC_SINGLE_ITERATIONS,
            codecBatchIterations: CODEC_BATCH_ITERATIONS,
            opaqueBytes: OPAQUE_BYTES,
            opaqueOnly: OPAQUE_ONLY,
        },
        results,
    }))
}

main().catch(function reportFailure(error) {
    console.error(error)
    process.exit(1)
})
