// =====================================================================
// August 2026 slow-network experiment
// =====================================================================
// Measures what perMessageDeflate and ping settings do to Socket.IO traffic
// shaped like this project's RPC/replay payloads when the link is slow.
// A metered in-process TCP relay models the slow network and counts real wire
// bytes (WS framing and deflate included). Intentionally outside src: no
// package API or build artifact depends on it.

import {createServer, type Server as HttpServer} from 'node:http'
import {createServer as createTcpServer, connect as connectTcp, type Socket as TcpSocket} from 'node:net'
import {cpus, arch, platform, release} from 'node:os'
import {performance} from 'node:perf_hooks'
import {Server as SocketIoServer} from 'socket.io'
import {io as createSocketIoClient, type Socket as ClientSocket} from 'socket.io-client'

const ISOLATED_MESSAGES = positiveIntegerEnv('SLOW_BENCH_ISOLATED', 200)
const ROWS_MESSAGES = positiveIntegerEnv('SLOW_BENCH_ROWS_MESSAGES', 30)
const ROWS_COUNT = positiveIntegerEnv('SLOW_BENCH_ROWS', 1_000)
const KEYFRAME_SLOW_KEYS = positiveIntegerEnv('SLOW_BENCH_KEYFRAME_SLOW', 5_000)
const KEYFRAME_PING_KEYS = positiveIntegerEnv('SLOW_BENCH_KEYFRAME_PING', 2_000)
const SLOW_LINK_BYTES_PER_SECOND = positiveIntegerEnv('SLOW_BENCH_LINK_BPS', 131_072)
const SLOW_LINK_LATENCY_MS = nonNegativeNumberEnv('SLOW_BENCH_LINK_LATENCY_MS', 80)
const PING_LINK_BYTES_PER_SECOND = positiveIntegerEnv('SLOW_BENCH_PING_LINK_BPS', 32_768)
const PING_LINK_LATENCY_MS = nonNegativeNumberEnv('SLOW_BENCH_PING_LINK_LATENCY_MS', 40)
const SCALED_PING_INTERVAL_MS = positiveIntegerEnv('SLOW_BENCH_PING_INTERVAL_MS', 300)
const SCALED_PING_TIMEOUT_MS = positiveIntegerEnv('SLOW_BENCH_PING_TIMEOUT_MS', 1_000)
const RAISED_PING_TIMEOUT_MS = positiveIntegerEnv('SLOW_BENCH_RAISED_PING_TIMEOUT_MS', 30_000)
const DEFLATE_THRESHOLD_BYTES = 1_024
const RELAY_MAX_BACKLOG_BYTES = 4 * 1_024 * 1_024
const STARVATION_GUARD_MS = 60_000

type tPullName = 'rows' | 'keyframe-slow' | 'keyframe-ping'

type tMeasurement = {
    pass: 'wire' | 'slow-link' | 'ping'
    candidate: string
    payload: string
    jsonBytes: number
    messages?: number
    wallMs?: number
    cpuUsPerMessage?: number
    latencyP50Ms?: number
    latencyP95Ms?: number
    wireBytesPerMessage?: number
    deliveryMs?: number
    delivered?: boolean
    disconnectReason?: string
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

// Same shapes as experiments/transport-2026-07 so byte columns stay comparable.
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

// Record shape representative of a Store keyframe / compactRows result set.
function recordPayload(index: number) {
    return {
        id: 'row-' + index,
        title: 'Order pipeline step ' + index,
        state: index % 3 == 0 ? 'done' : 'active',
        priority: (index % 5) + 1,
        updatedAt: 1_785_000_000_000 + index * 17,
        owner: 'operator-' + (index % 23),
        tags: ['ops', 'zone-' + (index % 7)],
    }
}

function rowsPayload(count: number) {
    return Array.from({length: count}, function createRow(_item, index) {
        return recordPayload(index)
    })
}

function keyframePayload(count: number) {
    const state: Record<string, ReturnType<typeof recordPayload>> = {}
    for (let index = 0; index < count; index++) state['row-' + index] = recordPayload(index)
    return state
}

const PULL_PAYLOADS: Record<tPullName, () => unknown> = {
    'rows': () => rowsPayload(ROWS_COUNT),
    'keyframe-slow': () => keyframePayload(KEYFRAME_SLOW_KEYS),
    'keyframe-ping': () => keyframePayload(KEYFRAME_PING_KEYS),
}

function jsonBytes(value: unknown) {
    return Buffer.byteLength(JSON.stringify(value))
}

// =====================================================================
// Metered / throttled TCP relay — the slow-network model
// =====================================================================

type tRelay = {
    port: number
    toServerBytes: () => number
    toClientBytes: () => number
    reset: () => void
    close: () => Promise<void>
}

async function createMeteredRelay(deps: {targetPort: number, bytesPerSecond?: number, latencyMs?: number}): Promise<tRelay> {
    const bytesPerSecond = deps.bytesPerSecond ?? Number.POSITIVE_INFINITY
    const latencyMs = deps.latencyMs ?? 0
    let toServer = 0
    let toClient = 0
    const openSockets = new Set<TcpSocket>()

    function pipeThrottled(source: TcpSocket, sink: TcpSocket, count: (bytes: number) => void) {
        if (bytesPerSecond == Number.POSITIVE_INFINITY && latencyMs == 0) {
            source.on('data', function forward(chunk: Buffer) {
                count(chunk.length)
                if (!sink.destroyed) sink.write(chunk)
            })
            source.on('end', function endSink() {
                if (!sink.destroyed) sink.end()
            })
            return
        }
        // Token bucket: each chunk occupies the modeled line for length/rate,
        // then arrives after the fixed one-way delay.
        let lineFreeAtMs = 0
        let backlogBytes = 0
        source.on('data', function forwardThrottled(chunk: Buffer) {
            count(chunk.length)
            const now = performance.now()
            const startMs = Math.max(now, lineFreeAtMs)
            lineFreeAtMs = startMs + chunk.length * 1_000 / bytesPerSecond
            backlogBytes += chunk.length
            if (backlogBytes > RELAY_MAX_BACKLOG_BYTES) source.pause()
            setTimeout(function deliver() {
                backlogBytes -= chunk.length
                if (!sink.destroyed) sink.write(chunk)
                if (source.isPaused() && backlogBytes <= RELAY_MAX_BACKLOG_BYTES / 2) source.resume()
            }, lineFreeAtMs + latencyMs - now)
        })
        source.on('end', function endSinkThrottled() {
            const now = performance.now()
            setTimeout(function deliverEnd() {
                if (!sink.destroyed) sink.end()
            }, Math.max(0, lineFreeAtMs + latencyMs - now))
        })
    }

    const relayServer = createTcpServer(function relayConnection(clientSide) {
        const serverSide = connectTcp(deps.targetPort, '127.0.0.1')
        openSockets.add(clientSide)
        openSockets.add(serverSide)
        clientSide.on('error', teardown)
        serverSide.on('error', teardown)
        clientSide.on('close', teardown)
        serverSide.on('close', teardown)
        pipeThrottled(clientSide, serverSide, bytes => { toServer += bytes })
        pipeThrottled(serverSide, clientSide, bytes => { toClient += bytes })

        function teardown() {
            clientSide.destroy()
            serverSide.destroy()
            openSockets.delete(clientSide)
            openSockets.delete(serverSide)
        }
    })

    await new Promise<void>(function listenRelay(resolve, reject) {
        relayServer.once('error', reject)
        relayServer.listen(0, '127.0.0.1', function listening() {
            relayServer.off('error', reject)
            resolve()
        })
    })
    const address = relayServer.address()
    if (address == null || typeof address == 'string') throw new Error('missing relay address')

    async function close() {
        for (const socket of openSockets) socket.destroy()
        openSockets.clear()
        await new Promise<void>(function closeRelay(resolve) {
            relayServer.close(function closed() {
                resolve()
            })
        })
    }

    return {
        port: address.port,
        toServerBytes: () => toServer,
        toClientBytes: () => toClient,
        reset: function resetCounters() {
            toServer = 0
            toClient = 0
        },
        close,
    }
}

// =====================================================================
// Socket.IO link through the relay
// =====================================================================

type tLinkOptions = {
    deflate: boolean
    bytesPerSecond?: number
    latencyMs?: number
    pingIntervalMs?: number
    pingTimeoutMs?: number
}

type tBenchLink = {
    socket: ClientSocket
    relay: tRelay
    roundTrip: (value: unknown) => Promise<unknown>
    close: () => Promise<void>
}

async function createBenchLink(options: tLinkOptions): Promise<tBenchLink> {
    const httpServer = createServer()
    const serverOptions: Record<string, unknown> = {
        transports: ['websocket'],
        serveClient: false,
        maxHttpBufferSize: 32 * 1_024 * 1_024,
        perMessageDeflate: options.deflate ? {threshold: DEFLATE_THRESHOLD_BYTES} : false,
    }
    if (options.pingIntervalMs != null) serverOptions['pingInterval'] = options.pingIntervalMs
    if (options.pingTimeoutMs != null) serverOptions['pingTimeout'] = options.pingTimeoutMs
    const ioServer = new SocketIoServer(httpServer, serverOptions)

    ioServer.on('connection', function serveBench(socket) {
        socket.on('echo', function echo(value) {
            socket.emit('echo', value)
        })
        socket.on('pull', function pull(name: tPullName) {
            socket.emit('payload', name, PULL_PAYLOADS[name]())
        })
    })

    const serverPort = await listenEphemeral(httpServer)
    const relay = await createMeteredRelay({
        targetPort: serverPort,
        bytesPerSecond: options.bytesPerSecond,
        latencyMs: options.latencyMs,
    })

    const clientOptions: Record<string, unknown> = {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        // Node-only engine.io-client option, forwarded to ws. Browsers always
        // offer the extension; the server side is the deciding switch.
        perMessageDeflate: options.deflate ? true : false,
    }
    const socket = createSocketIoClient('http://127.0.0.1:' + relay.port, clientOptions)
    await new Promise<void>(function waitForConnect(resolve, reject) {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
    })

    // Isolated sequential traffic: FIFO correlation is sufficient.
    const pendingEcho: Array<(value: unknown) => void> = []
    socket.on('echo', function receiveEcho(value) {
        const settle = pendingEcho.shift()
        if (settle) settle(value)
    })

    function roundTrip(value: unknown) {
        return new Promise<unknown>(function send(resolve) {
            pendingEcho.push(resolve)
            socket.emit('echo', value)
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
        await relay.close()
    }

    return {socket, relay, roundTrip, close}
}

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

// =====================================================================
// Measurement primitives
// =====================================================================

function percentile(values: number[], ratio: number) {
    if (values.length == 0) return 0
    const sorted = values.slice().sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]
}

function cpuMicroseconds(delta: NodeJS.CpuUsage) {
    return delta.user + delta.system
}

// =====================================================================
// Pass 1 — wire bytes and CPU on a fast link
// =====================================================================

async function measureWirePass(candidate: string, deflate: boolean) {
    const link = await createBenchLink({deflate})
    const results: tMeasurement[] = []
    const workloads = [
        {name: 'small', create: smallPayload, messages: ISOLATED_MESSAGES},
        {name: 'medium', create: mediumPayload, messages: ISOLATED_MESSAGES},
        {name: 'rows-' + ROWS_COUNT, create: () => rowsPayload(ROWS_COUNT), messages: ROWS_MESSAGES},
    ] as const
    try {
        for (const workload of workloads) {
            for (let index = 0; index < 20; index++) await link.roundTrip(workload.create(-1 - index))
            const latencies: number[] = []
            link.relay.reset()
            const cpuStart = process.cpuUsage()
            const wallStart = performance.now()
            for (let index = 0; index < workload.messages; index++) {
                const value = workload.create(index)
                const started = performance.now()
                await link.roundTrip(value)
                latencies.push(performance.now() - started)
            }
            const wallMs = performance.now() - wallStart
            const cpu = process.cpuUsage(cpuStart)
            results.push({
                pass: 'wire',
                candidate,
                payload: workload.name,
                jsonBytes: jsonBytes(workload.create(1)),
                messages: workload.messages,
                wallMs,
                cpuUsPerMessage: cpuMicroseconds(cpu) / workload.messages,
                latencyP50Ms: percentile(latencies, 0.50),
                latencyP95Ms: percentile(latencies, 0.95),
                wireBytesPerMessage: link.relay.toClientBytes() / workload.messages,
            })
        }
    } finally {
        await link.close()
    }
    return results
}

// =====================================================================
// Pass 2 — one-way delivery time over the throttled link
// =====================================================================

async function measureSlowLinkDelivery(candidate: string, deflate: boolean, name: tPullName) {
    const link = await createBenchLink({
        deflate,
        bytesPerSecond: SLOW_LINK_BYTES_PER_SECOND,
        latencyMs: SLOW_LINK_LATENCY_MS,
    })
    try {
        link.relay.reset()
        const started = performance.now()
        await new Promise<void>(function waitForPayload(resolve, reject) {
            link.socket.once('payload', function receivePayload() {
                resolve()
            })
            link.socket.once('disconnect', function onDisconnect(reason) {
                reject(new Error('unexpected disconnect during slow-link delivery: ' + reason))
            })
            link.socket.emit('pull', name)
        })
        const deliveryMs = performance.now() - started
        return {
            pass: 'slow-link',
            candidate,
            payload: name,
            jsonBytes: jsonBytes(PULL_PAYLOADS[name]()),
            deliveryMs,
            delivered: true,
            wireBytesPerMessage: link.relay.toClientBytes(),
        } satisfies tMeasurement
    } finally {
        await link.close()
    }
}

// =====================================================================
// Pass 3 — scaled ping starvation
// =====================================================================

async function measureStarvation(candidate: string, options: {deflate: boolean, pingTimeoutMs: number}) {
    const link = await createBenchLink({
        deflate: options.deflate,
        bytesPerSecond: PING_LINK_BYTES_PER_SECOND,
        latencyMs: PING_LINK_LATENCY_MS,
        pingIntervalMs: SCALED_PING_INTERVAL_MS,
        pingTimeoutMs: options.pingTimeoutMs,
    })
    try {
        link.relay.reset()
        const started = performance.now()
        const outcome = await new Promise<{delivered: boolean, reason?: string}>(function race(resolve) {
            const guard = setTimeout(function guardTimeout() {
                resolve({delivered: false, reason: 'bench guard timeout'})
            }, STARVATION_GUARD_MS)
            link.socket.once('payload', function receivePayload() {
                clearTimeout(guard)
                resolve({delivered: true})
            })
            link.socket.once('disconnect', function onDisconnect(reason) {
                clearTimeout(guard)
                resolve({delivered: false, reason})
            })
            link.socket.emit('pull', 'keyframe-ping')
        })
        const elapsedMs = performance.now() - started
        return {
            pass: 'ping',
            candidate,
            payload: 'keyframe-ping',
            jsonBytes: jsonBytes(PULL_PAYLOADS['keyframe-ping']()),
            deliveryMs: elapsedMs,
            delivered: outcome.delivered,
            disconnectReason: outcome.reason,
            wireBytesPerMessage: link.relay.toClientBytes(),
        } satisfies tMeasurement
    } finally {
        await link.close()
    }
}

// =====================================================================
// Report
// =====================================================================

function rounded(value: number | undefined) {
    return value == null ? undefined : Number(value.toFixed(3))
}

function tableRows(results: tMeasurement[]) {
    return results.map(function createTableRow(result) {
        return {
            pass: result.pass,
            candidate: result.candidate,
            payload: result.payload,
            jsonBytes: result.jsonBytes,
            messages: result.messages,
            wallMs: rounded(result.wallMs),
            cpuUsPerMsg: rounded(result.cpuUsPerMessage),
            p50Ms: rounded(result.latencyP50Ms),
            p95Ms: rounded(result.latencyP95Ms),
            wireBytes: rounded(result.wireBytesPerMessage),
            deliveryMs: rounded(result.deliveryMs),
            delivered: result.delivered,
            reason: result.disconnectReason,
        }
    })
}

async function main() {
    const results: tMeasurement[] = []
    const environment = {
        node: process.version,
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
    }
    const options = {
        isolatedMessages: ISOLATED_MESSAGES,
        rowsMessages: ROWS_MESSAGES,
        rowsCount: ROWS_COUNT,
        keyframeSlowKeys: KEYFRAME_SLOW_KEYS,
        keyframePingKeys: KEYFRAME_PING_KEYS,
        slowLinkBytesPerSecond: SLOW_LINK_BYTES_PER_SECOND,
        slowLinkLatencyMs: SLOW_LINK_LATENCY_MS,
        pingLinkBytesPerSecond: PING_LINK_BYTES_PER_SECOND,
        pingLinkLatencyMs: PING_LINK_LATENCY_MS,
        scaledPingIntervalMs: SCALED_PING_INTERVAL_MS,
        scaledPingTimeoutMs: SCALED_PING_TIMEOUT_MS,
        raisedPingTimeoutMs: RAISED_PING_TIMEOUT_MS,
        deflateThresholdBytes: DEFLATE_THRESHOLD_BYTES,
    }

    console.log('Slow-network experiment — August 2026')
    console.log(JSON.stringify({runtime: environment, options}, null, 2))

    console.log('\nPass 1 — wire bytes and CPU on a fast link')
    results.push(...await measureWirePass('deflate-off', false))
    results.push(...await measureWirePass('deflate-on', true))
    console.table(tableRows(results.filter(result => result.pass == 'wire')))

    console.log('\nPass 2 — delivery over throttled link ('
        + SLOW_LINK_BYTES_PER_SECOND + ' B/s, ' + SLOW_LINK_LATENCY_MS + ' ms one-way)')
    for (const name of ['rows', 'keyframe-slow'] as const) {
        results.push(await measureSlowLinkDelivery('deflate-off', false, name))
        results.push(await measureSlowLinkDelivery('deflate-on', true, name))
    }
    console.table(tableRows(results.filter(result => result.pass == 'slow-link')))

    console.log('\nPass 3 — scaled ping starvation ('
        + PING_LINK_BYTES_PER_SECOND + ' B/s, pingInterval ' + SCALED_PING_INTERVAL_MS
        + ' ms, keyframe of ' + KEYFRAME_PING_KEYS + ' keys)')
    results.push(await measureStarvation('short-pingTimeout', {deflate: false, pingTimeoutMs: SCALED_PING_TIMEOUT_MS}))
    results.push(await measureStarvation('raised-pingTimeout', {deflate: false, pingTimeoutMs: RAISED_PING_TIMEOUT_MS}))
    results.push(await measureStarvation('short-pingTimeout+deflate', {deflate: true, pingTimeoutMs: SCALED_PING_TIMEOUT_MS}))
    console.table(tableRows(results.filter(result => result.pass == 'ping')))

    console.log('\n##RESULT##')
    console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        runtime: environment,
        options,
        results,
    }))
}

main().then(function done() {
    process.exit(0)
}, function reportFailure(error) {
    console.error(error)
    process.exit(1)
})
