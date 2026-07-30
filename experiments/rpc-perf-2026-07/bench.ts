// =====================================================================
// July 2026 RPC performance experiment
// =====================================================================
// The July 25 transport stand measured transport and codec in ISOLATION: it never went
// through createRpcServer / createRpcClient. This stand closes that gap. Every number
// below is produced by the real RPC facades over a real socket.io WebSocket loopback.
//
// Two instrumentation layers are kept separate on purpose:
//   • LOGICAL  — the {emit,on} adapter handed to the RPC facades: one emit == one RPC packet.
//   • PHYSICAL — the ws socket underneath engine.io: real frames, real serialized bytes,
//                cross-checked against the TCP byte counters of the accepted net.Socket.
// Nothing in src/ is modified or needed for this: both are outside seams.
//
// The file is BOTH orchestrator and worker. Without RPC_BENCH_UNIT it spawns one fresh
// Node process per (family, candidate) unit, in randomized candidate order, repeats the
// whole matrix RPC_BENCH_RUNS times and reports medians with spread. With RPC_BENCH_UNIT
// it runs exactly that one unit and prints one ##UNIT## line.

import {spawn} from 'node:child_process'
import {createServer, type Server as HttpServer} from 'node:http'
import type {Socket as NetSocket} from 'node:net'
import {arch, cpus, platform, release} from 'node:os'
import {resolve as resolvePath} from 'node:path'
import {monitorEventLoopDelay, performance, PerformanceObserver} from 'node:perf_hooks'
import {Server as SocketIoServer} from 'socket.io'
import {io as createSocketIoClient} from 'socket.io-client'
import {createRpcClient} from '../../src/Common/rcp/rpc-client'
import {createRpcServer} from '../../src/Common/rcp/rpc-server'
import {Pkt, type SocketTmpl} from '../../src/Common/rcp/rpc-protocol'
import type {RpcOpt} from '../../src/Common/rcp/rpc-caps'
import {packResult} from '../../src/Common/rcp/rpc-walk'
import {jsonUtf8ByteLength} from '../../src/Common/wire-size'

// =====================================================================
// Options
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

const SOCKET_KEY = 'rpc'
const BASE_PORT = positiveIntegerEnv('RPC_BENCH_PORT', 3173)
const RUNS = positiveIntegerEnv('RPC_BENCH_RUNS', 3)
const SEED = positiveIntegerEnv('RPC_BENCH_SEED', 20260729)
const SMALL_CALLS = positiveIntegerEnv('RPC_BENCH_SMALL_CALLS', 500)
const SMALL_GAP_MS = nonNegativeNumberEnv('RPC_BENCH_GAP_MS', 3)
const LARGE_CALLS = positiveIntegerEnv('RPC_BENCH_LARGE_CALLS', 80)
const LARGE_RECORDS = positiveIntegerEnv('RPC_BENCH_LARGE_RECORDS', 1_000)
const TICK_COUNT = positiveIntegerEnv('RPC_BENCH_TICKS', 400)
const TICK_HZ = positiveIntegerEnv('RPC_BENCH_TICK_HZ', 100)
const FLOOD_ROUNDS = positiveIntegerEnv('RPC_BENCH_FLOOD_ROUNDS', 20)
const FLOOD_SIZE = positiveIntegerEnv('RPC_BENCH_FLOOD_SIZE', 500)
const BURSTS = positiveIntegerEnv('RPC_BENCH_BURSTS', 40)
const BURST_SIZE = positiveIntegerEnv('RPC_BENCH_BURST_SIZE', 50)
const CONNECTS = positiveIntegerEnv('RPC_BENCH_CONNECTS', 150)
const ACCOUNTING_SHARE = 0.2
const UNIT = process.env['RPC_BENCH_UNIT'] ?? ''
const UNIT_PORT = positiveIntegerEnv('RPC_BENCH_UNIT_PORT', BASE_PORT)
const FAMILY_FILTER = (process.env['RPC_BENCH_FAMILY'] ?? '').split(',').map(part => part.trim()).filter(Boolean)
const UNIT_MARKER = '##UNIT##'

// =====================================================================
// Workload payloads — modeled on the repo's own domain records
// =====================================================================
// CBar in src/Exchange/Bars.ts is {time: Date, open, high, low, close, volume, tickVolume};
// CTick is {time: Date, price, volume}. Family 2 keeps the domain Date so the measured
// bytes include what packResult really puts on the wire ($_d wrapper). Ticks carry epoch
// milliseconds, which is what a live quote feed actually pushes.

const BAR_EPOCH = 1_785_000_000_000
const TICK_EPOCH = 1_785_600_000_000

function fixed(value: number, digits: number) {
    return Number(value.toFixed(digits))
}

function createBar(seq: number) {
    const base = 104_000 + (seq % 97) * 0.25
    return {
        time: new Date(BAR_EPOCH + seq * 60_000),
        open: fixed(base, 2),
        high: fixed(base + 12.5 + (seq % 7) * 0.25, 2),
        low: fixed(base - 9.75 - (seq % 5) * 0.25, 2),
        close: fixed(base + 3.25 - (seq % 11) * 0.25, 2),
        volume: fixed(18.421 + (seq % 31) * 0.017, 3),
        tickVolume: 412 + (seq % 53),
    }
}

function createBars(count: number) {
    return Array.from({length: count}, function createBarRecord(_item, index) {
        return createBar(index)
    })
}

function createQuoteRequest(seq: number) {
    return {symbol: 'BTCUSDT', tf: 'M1', seq}
}

function createQuoteResult(seq: number) {
    const base = 104_245.12 + (seq % 41) * 0.01
    return {
        symbol: 'BTCUSDT',
        tf: 'M1',
        seq,
        time: TICK_EPOCH + seq,
        bid: fixed(base, 2),
        ask: fixed(base + 0.06, 2),
        last: fixed(base + 0.02, 2),
        volume: fixed(0.017 + (seq % 13) * 0.001, 3),
    }
}

function createTick(seq: number) {
    const base = 104_245.12 + (seq % 41) * 0.01
    return {
        symbol: 'BTCUSDT',
        seq,
        time: TICK_EPOCH + seq,
        price: fixed(base + 0.02, 2),
        bid: fixed(base, 2),
        ask: fixed(base + 0.06, 2),
        volume: fixed(0.017 + (seq % 13) * 0.001, 3),
        // Stand-only field: emit instant in integer microseconds. Client and server share
        // one process, so this is a real one-way delivery latency and not a clock estimate.
        t: Math.round(performance.now() * 1_000),
    }
}

type tTick = ReturnType<typeof createTick>
type tBar = ReturnType<typeof createBar>

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

function median(values: number[]) {
    return percentile(values, 0.5)
}

function cpuMicroseconds(delta: NodeJS.CpuUsage) {
    return delta.user + delta.system
}

function rounded(value: number | undefined, digits = 3) {
    return value == null || !Number.isFinite(value) ? undefined : Number(value.toFixed(digits))
}

/** Deterministic order shuffling: the recorded seed reproduces the exact candidate order. */
function createRandom(seed: number) {
    let state = (seed >>> 0) || 1
    return function nextRandom() {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        state >>>= 0
        return state / 4_294_967_296
    }
}

function shuffled<T>(items: readonly T[], random: () => number) {
    const out = items.slice()
    for (let index = out.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1))
        const held = out[index]
        out[index] = out[swap]
        out[swap] = held
    }
    return out
}

/** Event-loop delay and GC pressure over one measured window. */
function createRuntimeWatch() {
    const loop = monitorEventLoopDelay({resolution: 1})
    let gcCount = 0
    let gcMs = 0
    const observer = new PerformanceObserver(function collectGc(list) {
        for (const entry of list.getEntries()) {
            gcCount++
            gcMs += entry.duration
        }
    })

    function start() {
        gcCount = 0
        gcMs = 0
        loop.reset()
        loop.enable()
        observer.observe({entryTypes: ['gc']})
    }

    function stop() {
        loop.disable()
        observer.disconnect()
        return {
            loopMeanMs: loop.mean / 1e6,
            loopP95Ms: loop.percentile(95) / 1e6,
            loopMaxMs: loop.max / 1e6,
            gcCount,
            gcMs,
        }
    }

    return {start, stop}
}

// =====================================================================
// Wire meter — logical RPC packets and physical WebSocket frames
// =====================================================================
// LOGICAL: the {emit,on} adapter the RPC facades are constructed with. One emit is one
// packet handed to the transport; a Pkt.CB_BATCH emit carries N logical packets inside.
// PHYSICAL: engine.io's ws socket. `message` gives real inbound frames, a wrapped `send`
// gives real outbound frames, both with already serialized byte lengths. The accepted
// net.Socket byte counters are recorded beside them as an independent cross-check:
// tcpBytes - wsPayloadBytes is the WebSocket framing overhead and must stay near
// 2 bytes per server frame and 6 bytes per masked client frame.

const OPCODE_NAMES: Record<number, string> = Object.fromEntries(
    Object.entries(Pkt).map(function nameOpcode(entry) {
        return [entry[1], entry[0]]
    }),
)

function opcodeName(opcode: unknown) {
    return typeof opcode == 'number' ? OPCODE_NAMES[opcode] ?? ('OP_' + opcode) : 'NON_ARRAY'
}

function createDirectionTally() {
    return {
        emits: 0,
        logicalPackets: 0,
        batchedPackets: 0,
        sizedBytes: 0,
        physicalByOpcode: {} as Record<string, {n: number, bytes: number}>,
        logicalByOpcode: {} as Record<string, {n: number, bytes: number}>,
    }
}

type tDirectionTally = ReturnType<typeof createDirectionTally>

function bump(map: Record<string, {n: number, bytes: number}>, name: string, bytes: number) {
    const slot = map[name] ?? (map[name] = {n: 0, bytes: 0})
    slot.n++
    slot.bytes += bytes
}

function byteLengthOfFrame(data: unknown) {
    if (typeof data == 'string') return Buffer.byteLength(data)
    if (ArrayBuffer.isView(data)) return data.byteLength
    if (data instanceof ArrayBuffer) return data.byteLength
    return 0
}

export function createWireMeter() {
    const logical = {c2s: createDirectionTally(), s2c: createDirectionTally()}
    const physical = {c2sFrames: 0, c2sBytes: 0, s2cFrames: 0, s2cBytes: 0}
    const liveNet = new Set<NetSocket>()
    let closedRead = 0
    let closedWritten = 0
    let sizing = false
    let frameProbe = 'unavailable'

    function countPacket(tally: tDirectionTally, data: unknown) {
        tally.emits++
        if (!Array.isArray(data)) {
            // The schema request goes on the wire as a bare opcode (`socket.emit(key, Pkt.STRICT)`),
            // so a scalar packet is named by its opcode like any other.
            tally.logicalPackets++
            const scalarBytes = sizing ? jsonUtf8ByteLength(data) : 0
            tally.sizedBytes += scalarBytes
            const scalarName = typeof data == 'number' ? opcodeName(data) : 'NON_ARRAY'
            bump(tally.physicalByOpcode, scalarName, scalarBytes)
            bump(tally.logicalByOpcode, scalarName, scalarBytes)
            return
        }
        const bytes = sizing ? jsonUtf8ByteLength(data) : 0
        if (sizing) tally.sizedBytes += bytes
        // Two envelopes now: Pkt.CB_BATCH (Caps.CB_BATCH) and Pkt.BATCH (Caps.REQ_BATCH). Both
        // are unpacked so their N inner packets count as N logical packets in one physical one.
        if ((data[0] == Pkt.CB_BATCH || data[0] == Pkt.BATCH) && Array.isArray(data[1])) {
            bump(tally.physicalByOpcode, opcodeName(data[0]), bytes)
            tally.logicalPackets += data[1].length
            tally.batchedPackets += data[1].length
            for (const inner of data[1]) {
                bump(tally.logicalByOpcode, opcodeName(Array.isArray(inner) ? inner[0] : undefined),
                    sizing ? jsonUtf8ByteLength(inner) : 0)
            }
            return
        }
        tally.logicalPackets++
        const name = opcodeName(data[0])
        bump(tally.physicalByOpcode, name, bytes)
        bump(tally.logicalByOpcode, name, bytes)
    }

    function meteredAdapter(socket: SocketTmpl, tally: tDirectionTally): SocketTmpl {
        return {
            on: function meteredOn(event, cb) {
                socket.on(event, cb)
            },
            emit: function meteredEmit(event, data) {
                countPacket(tally, data)
                socket.emit(event, data)
            },
        }
    }

    function watchHttpServer(httpServer: HttpServer) {
        httpServer.on('connection', function keepNetSocket(socket) {
            liveNet.add(socket)
            socket.on('close', function releaseNetSocket() {
                closedRead += socket.bytesRead
                closedWritten += socket.bytesWritten
                liveNet.delete(socket)
            })
        })
    }

    function watchEngine(ioServer: SocketIoServer) {
        ioServer.engine.on('connection', function hookEngineSocket(engineSocket: any) {
            const raw = engineSocket?.transport?.socket
            if (raw == null || typeof raw.send != 'function' || typeof raw.on != 'function') return
            frameProbe = 'ws-socket'
            raw.on('message', function countInboundFrame(data: any) {
                physical.c2sFrames++
                physical.c2sBytes += byteLengthOfFrame(data)
            })
            const originalSend = raw.send.bind(raw)
            raw.send = function countedSend(data: any, ...rest: any[]) {
                physical.s2cFrames++
                physical.s2cBytes += byteLengthOfFrame(data)
                return originalSend(data, ...rest)
            }
        })
    }

    function tcpTotals() {
        let read = closedRead
        let written = closedWritten
        for (const socket of liveNet) {
            read += socket.bytesRead
            written += socket.bytesWritten
        }
        return {read, written}
    }

    function snapshot() {
        const tcp = tcpTotals()
        return {
            logical: JSON.parse(JSON.stringify(logical)) as typeof logical,
            physical: {...physical},
            tcp,
            frameProbe,
        }
    }

    function diff(before: ReturnType<typeof snapshot>) {
        const after = snapshot()
        function directionDiff(key: 'c2s' | 's2c') {
            return {
                rpcEmits: after.logical[key].emits - before.logical[key].emits,
                rpcPackets: after.logical[key].logicalPackets - before.logical[key].logicalPackets,
                batchedPackets: after.logical[key].batchedPackets - before.logical[key].batchedPackets,
                sizedBytes: after.logical[key].sizedBytes - before.logical[key].sizedBytes,
                physicalByOpcode: after.logical[key].physicalByOpcode,
                logicalByOpcode: after.logical[key].logicalByOpcode,
            }
        }
        return {
            frameProbe: after.frameProbe,
            c2s: {
                ...directionDiff('c2s'),
                frames: after.physical.c2sFrames - before.physical.c2sFrames,
                wsBytes: after.physical.c2sBytes - before.physical.c2sBytes,
                tcpBytes: after.tcp.read - before.tcp.read,
            },
            s2c: {
                ...directionDiff('s2c'),
                frames: after.physical.s2cFrames - before.physical.s2cFrames,
                wsBytes: after.physical.s2cBytes - before.physical.s2cBytes,
                tcpBytes: after.tcp.written - before.tcp.written,
            },
        }
    }

    function resetOpcodeMaps() {
        for (const key of ['c2s', 's2c'] as const) {
            logical[key].physicalByOpcode = {}
            logical[key].logicalByOpcode = {}
        }
    }

    function setSizing(next: boolean) {
        sizing = next
        resetOpcodeMaps()
    }

    return {meteredAdapter, watchHttpServer, watchEngine, snapshot, diff, setSizing, logical}
}

type tWireMeter = ReturnType<typeof createWireMeter>
type tWireDiff = ReturnType<tWireMeter['diff']>

// =====================================================================
// Served object — one method per workload family
// =====================================================================

const LARGE_RESULT = createBars(LARGE_RECORDS)

function createBenchApi() {
    return {
        /** Family 1: compact quote in, compact quote out. */
        quote(request: {symbol: string, tf: string, seq: number}) {
            return createQuoteResult(request.seq)
        },
        /** Family 2: one call returning many records of identical shape. */
        bars(request: {symbol: string, tf: string, count: number}) {
            return request.count == LARGE_RECORDS ? LARGE_RESULT : createBars(request.count)
        },
        /** Family 3: paced subscription ticks; the call resolves after the last tick.
         *  Drift-correcting on purpose: the Windows timer granularity on this host is about
         *  15.6 ms, so a naive setInterval(10) would silently deliver ~64/s instead of the
         *  configured rate. Catching up on each wake keeps the AVERAGE rate honest and is
         *  what a real feed does when its source outruns the timer. */
        ticks(count: number, intervalMs: number, cb: (tick: tTick) => void) {
            return new Promise<string>(function pumpTicks(resolve) {
                const startedAt = performance.now()
                let sent = 0
                function emitDueTicks() {
                    const due = Math.min(count, Math.floor((performance.now() - startedAt) / intervalMs) + 1)
                    while (sent < due) cb(createTick(sent++))
                    if (sent >= count) {
                        resolve('done')
                        return
                    }
                    setTimeout(emitDueTicks, Math.max(0, startedAt + sent * intervalMs - performance.now()))
                }
                emitDueTicks()
            })
        },
        /** Family 3b: the same ticks with no pacing — the batcher's best case. */
        floodTicks(count: number, cb: (tick: tTick) => void) {
            for (let index = 0; index < count; index++) cb(createTick(index))
            return 'flood'
        },
    }
}

type tBenchApi = ReturnType<typeof createBenchApi>

// =====================================================================
// Stand resources — socket.io server / client forced to WebSocket, deflate off
// =====================================================================

async function listenOn(server: HttpServer, port: number) {
    await new Promise<void>(function listen(resolve, reject) {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', function listening() {
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

const AUTH_TOKEN = {user: 'bench', scope: 'market-data'}

async function createStandServer({port, opt, withAuth}: {port: number, opt?: RpcOpt, withAuth?: boolean}) {
    const meter = createWireMeter()
    const httpServer = createServer()
    meter.watchHttpServer(httpServer)
    const ioServer = new SocketIoServer(httpServer, {
        transports: ['websocket'],
        perMessageDeflate: false,
        serveClient: false,
    })
    meter.watchEngine(ioServer)
    const api = createBenchApi()
    const auth = withAuth
        ? {resolveAuth: function resolveBenchAuth() { return {object: api, ack: {ok: true}} }, gate: true}
        : undefined

    ioServer.on('connection', function serveRpc(socket) {
        createRpcServer<tBenchApi>({
            socket: meter.meteredAdapter(socket as unknown as SocketTmpl, meter.logical.s2c),
            object: withAuth ? ({} as tBenchApi) : api,
            socketKey: SOCKET_KEY,
            auth,
            opt,
        })
    })

    const boundPort = await listenOn(httpServer, port)

    async function close() {
        await new Promise<void>(function closeIo(resolve) {
            ioServer.close(function closed() {
                resolve()
            })
        })
        await closeHttpServer(httpServer)
    }

    return {meter, port: boundPort, close}
}

async function connectStandClient({port, opt, meter, token}: {
    port: number, opt?: RpcOpt, meter: tWireMeter, token?: unknown,
}) {
    const socket = createSocketIoClient('http://127.0.0.1:' + port, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
    })
    await new Promise<void>(function waitForConnect(resolve, reject) {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
    })
    const client = createRpcClient<tBenchApi>({
        socket: meter.meteredAdapter(socket as unknown as SocketTmpl, meter.logical.c2s),
        socketKey: SOCKET_KEY,
        token,
        opt,
    })
    await client.init()

    async function close() {
        client.close('bench done')
        await new Promise<void>(function waitForDisconnect(resolve) {
            if (!socket.connected) return resolve()
            socket.once('disconnect', function disconnected() { resolve() })
            socket.disconnect()
        })
    }

    return {client, socket, close}
}

// =====================================================================
// Window measurement
// =====================================================================

type tWindow = {
    messages: number
    wallMs: number
    cpuUs: number
    latenciesMs: number[]
    runtime: ReturnType<ReturnType<typeof createRuntimeWatch>['stop']>
    wire: tWireDiff
}

async function measureWindow(meter: tWireMeter, run: (latencies: number[]) => Promise<number>) {
    const latenciesMs: number[] = []
    const watch = createRuntimeWatch()
    const before = meter.snapshot()
    watch.start()
    const cpuStart = process.cpuUsage()
    const wallStart = performance.now()
    const messages = await run(latenciesMs)
    const wallMs = performance.now() - wallStart
    const cpuUs = cpuMicroseconds(process.cpuUsage(cpuStart))
    const runtime = watch.stop()
    const wire = meter.diff(before)
    return {messages, wallMs, cpuUs, latenciesMs, runtime, wire} satisfies tWindow
}

function accountingBlock(window: tWindow) {
    return {
        messages: window.messages,
        c2sFrames: window.wire.c2s.frames,
        s2cFrames: window.wire.s2c.frames,
        c2sRpcPackets: window.wire.c2s.rpcPackets,
        s2cRpcPackets: window.wire.s2c.rpcPackets,
        c2sWsBytes: window.wire.c2s.wsBytes,
        s2cWsBytes: window.wire.s2c.wsBytes,
        c2sByOpcode: window.wire.c2s.logicalByOpcode,
        s2cByOpcode: window.wire.s2c.logicalByOpcode,
        s2cPhysicalByOpcode: window.wire.s2c.physicalByOpcode,
    }
}

function summarize({family, candidate, timing, accounting, cold, reportCpu, reportThroughput = true, cpuNote, extra}: {
    family: string
    candidate: string
    timing: tWindow
    accounting: tWindow
    cold?: tWindow
    reportCpu: boolean
    reportThroughput?: boolean
    cpuNote?: string
    extra?: Record<string, number>
}) {
    const perMessage = timing.messages > 0 ? timing.messages : 1
    return {
        family,
        candidate,
        messages: timing.messages,
        wallMs: rounded(timing.wallMs),
        p50Ms: rounded(percentile(timing.latenciesMs, 0.50)),
        p95Ms: rounded(percentile(timing.latenciesMs, 0.95)),
        p99Ms: timing.latenciesMs.length >= 100 ? rounded(percentile(timing.latenciesMs, 0.99)) : undefined,
        messagesPerSecond: reportThroughput ? rounded(timing.messages / (timing.wallMs / 1_000), 1) : undefined,
        cpuUsPerMessage: reportCpu ? rounded(timing.cpuUs / perMessage) : undefined,
        cpuUsTotal: rounded(timing.cpuUs, 0),
        cpuNote,
        loopMeanMs: rounded(timing.runtime.loopMeanMs),
        loopP95Ms: rounded(timing.runtime.loopP95Ms),
        loopMaxMs: rounded(timing.runtime.loopMaxMs),
        gcCount: timing.runtime.gcCount,
        gcMs: rounded(timing.runtime.gcMs),
        wire: {
            messages: timing.messages,
            c2sFrames: timing.wire.c2s.frames,
            s2cFrames: timing.wire.s2c.frames,
            c2sRpcPackets: timing.wire.c2s.rpcPackets,
            s2cRpcPackets: timing.wire.s2c.rpcPackets,
            c2sRpcEmits: timing.wire.c2s.rpcEmits,
            s2cRpcEmits: timing.wire.s2c.rpcEmits,
            s2cBatchedPackets: timing.wire.s2c.batchedPackets,
            c2sWsBytes: timing.wire.c2s.wsBytes,
            s2cWsBytes: timing.wire.s2c.wsBytes,
            c2sTcpBytes: timing.wire.c2s.tcpBytes,
            s2cTcpBytes: timing.wire.s2c.tcpBytes,
            frameProbe: timing.wire.frameProbe,
        },
        accounting: accountingBlock(accounting),
        coldAccounting: cold == undefined ? undefined : accountingBlock(cold),
        extra,
    }
}

type tMeasurement = ReturnType<typeof summarize>

// =====================================================================
// Family 1 — small request/response, isolated with a quiet gap
// =====================================================================
// Mirrors `isolated-3ms` of the July transport stand so the two sets of latencies can be
// read together. CPU is deliberately NOT reported here, for the same reason the July
// experiment gave: Windows CPU accounting across short sleeps is too coarse.

async function runSmallFamily(candidate: string, opt: RpcOpt | undefined, port: number) {
    const stand = await createStandServer({port, opt})
    const link = await connectStandClient({port: stand.port, opt, meter: stand.meter})
    try {
        for (let index = 0; index < 100; index++) {
            const echo = await link.client.func.quote(createQuoteRequest(-1 - index))
            if (echo.seq != -1 - index) throw new Error('small warmup mismatch')
        }

        stand.meter.setSizing(false)
        const timing = await measureWindow(stand.meter, async function callSmall(latencies) {
            for (let index = 0; index < SMALL_CALLS; index++) {
                const started = performance.now()
                const result = await link.client.func.quote(createQuoteRequest(index))
                latencies.push(performance.now() - started)
                if (result.seq != index) throw new Error('small echo mismatch')
                if (SMALL_GAP_MS > 0) await delay(SMALL_GAP_MS)
            }
            return SMALL_CALLS
        })

        const accountingCalls = Math.max(20, Math.round(SMALL_CALLS * ACCOUNTING_SHARE))
        stand.meter.setSizing(true)
        const accounting = await measureWindow(stand.meter, async function accountSmall() {
            for (let index = 0; index < accountingCalls; index++) {
                await link.client.func.quote(createQuoteRequest(1_000_000 + index))
            }
            return accountingCalls
        })
        stand.meter.setSizing(false)

        return summarize({
            family: 'small',
            candidate,
            timing,
            accounting,
            reportCpu: false,
            reportThroughput: false,
            cpuNote: 'omitted: window dominated by ' + SMALL_GAP_MS + ' ms quiet gaps',
        })
    } finally {
        await link.close()
        await stand.close()
    }
}

// =====================================================================
// Family 2 — one call returning many records of identical shape
// =====================================================================

async function runLargeFamily(candidate: string, opt: RpcOpt | undefined, port: number) {
    const stand = await createStandServer({port, opt})
    const link = await connectStandClient({port: stand.port, opt, meter: stand.meter})
    const request = {symbol: 'BTCUSDT', tf: 'M1', count: LARGE_RECORDS}
    try {
        for (let index = 0; index < 5; index++) {
            const warm = await link.client.func.bars(request)
            if (warm.length != LARGE_RECORDS) throw new Error('large warmup mismatch')
        }

        stand.meter.setSizing(false)
        const timing = await measureWindow(stand.meter, async function callLarge(latencies) {
            for (let index = 0; index < LARGE_CALLS; index++) {
                const started = performance.now()
                const result = await link.client.func.bars(request)
                latencies.push(performance.now() - started)
                if (result.length != LARGE_RECORDS) throw new Error('large result mismatch')
            }
            return LARGE_CALLS
        })

        const accountingCalls = Math.max(5, Math.round(LARGE_CALLS * ACCOUNTING_SHARE))
        stand.meter.setSizing(true)
        const accounting = await measureWindow(stand.meter, async function accountLarge() {
            for (let index = 0; index < accountingCalls; index++) await link.client.func.bars(request)
            return accountingCalls
        })
        stand.meter.setSizing(false)

        return summarize({
            family: 'large',
            candidate,
            timing,
            accounting,
            reportCpu: true,
            extra: {recordsPerCall: LARGE_RECORDS},
        })
    } finally {
        await link.close()
        await stand.close()
    }
}

// =====================================================================
// Family 3 — subscription ticks
// =====================================================================
// Shape state is keyed by cbId and survives a call: the client releases the cbId on RESP
// but keeps its shape table, and the server only drops shapes on Pkt.CB_END. A reused cbId
// therefore inherits a registered shape. So the FIRST subscription of a connection pays a
// different wire than every later one, and both are measured: `coldAccounting` is the very
// first subscription on a fresh connection, `accounting` is a later one.
// Latency is one-way delivery: server and client share this process, so the emit instant
// carried in the tick is a real clock, not an estimate.

function tickLatencyMs(tick: tTick) {
    return (Math.round(performance.now() * 1_000) - tick.t) / 1_000
}

async function runTickFamily(candidate: string, opt: RpcOpt | undefined, port: number) {
    const stand = await createStandServer({port, opt})
    const link = await connectStandClient({port: stand.port, opt, meter: stand.meter})
    const intervalMs = Math.max(1, Math.round(1_000 / TICK_HZ))
    try {
        const coldTicks = Math.max(20, Math.round(TICK_COUNT * ACCOUNTING_SHARE))
        stand.meter.setSizing(true)
        const cold = await measureWindow(stand.meter, async function firstSubscription() {
            await link.client.func.ticks(coldTicks, intervalMs, function onColdTick() {})
            return coldTicks
        })

        stand.meter.setSizing(false)
        let warmed = 0
        await link.client.func.ticks(50, intervalMs, function warmTick() { warmed++ })
        if (warmed != 50) throw new Error('tick warmup mismatch')

        stand.meter.setSizing(false)
        const timing = await measureWindow(stand.meter, async function streamTicks(latencies) {
            let received = 0
            await link.client.func.ticks(TICK_COUNT, intervalMs, function onTick(tick) {
                received++
                latencies.push(tickLatencyMs(tick))
            })
            if (received != TICK_COUNT) throw new Error('tick count mismatch')
            return TICK_COUNT
        })

        const accountingTicks = Math.max(50, Math.round(TICK_COUNT * ACCOUNTING_SHARE))
        stand.meter.setSizing(true)
        const accounting = await measureWindow(stand.meter, async function accountTicks() {
            await link.client.func.ticks(accountingTicks, intervalMs, function countTick() {})
            return accountingTicks
        })
        stand.meter.setSizing(false)

        return summarize({
            family: 'ticks',
            candidate,
            timing,
            accounting,
            cold,
            reportCpu: true,
            cpuNote: 'multi-second paced window: total CPU is meaningful, per-tick value still includes timer overhead',
            extra: {targetHz: TICK_HZ, intervalMs},
        })
    } finally {
        await link.close()
        await stand.close()
    }
}

// =====================================================================
// Family 3b — unpaced tick flood
// =====================================================================
// Same subscription path with the pacing removed. This is the only place where the
// callback batcher can actually fill a batch, so it isolates what Caps.CB_BATCH buys.

async function runFloodFamily(candidate: string, opt: RpcOpt | undefined, port: number) {
    const stand = await createStandServer({port, opt})
    const link = await connectStandClient({port: stand.port, opt, meter: stand.meter})
    try {
        await link.client.func.floodTicks(200, function warmFlood() {})

        stand.meter.setSizing(false)
        const timing = await measureWindow(stand.meter, async function floodTicks(latencies) {
            for (let round = 0; round < FLOOD_ROUNDS; round++) {
                let received = 0
                await link.client.func.floodTicks(FLOOD_SIZE, function onFloodTick(tick) {
                    received++
                    latencies.push(tickLatencyMs(tick))
                })
                if (received != FLOOD_SIZE) throw new Error('flood tick count mismatch')
            }
            return FLOOD_ROUNDS * FLOOD_SIZE
        })

        stand.meter.setSizing(true)
        const accountingRounds = Math.max(2, Math.round(FLOOD_ROUNDS * ACCOUNTING_SHARE))
        const accounting = await measureWindow(stand.meter, async function accountFlood() {
            for (let round = 0; round < accountingRounds; round++) {
                await link.client.func.floodTicks(FLOOD_SIZE, function countFloodTick() {})
            }
            return accountingRounds * FLOOD_SIZE
        })
        stand.meter.setSizing(false)

        return summarize({
            family: 'flood',
            candidate,
            timing,
            accounting,
            reportCpu: true,
            extra: {rounds: FLOOD_ROUNDS, ticksPerRound: FLOOD_SIZE},
        })
    } finally {
        await link.close()
        await stand.close()
    }
}

// =====================================================================
// Family 4 — parallel call burst
// =====================================================================
// N independent calls issued in one synchronous burst. Neither direction of the CALL/RESP
// pair is batched today, so this is where per-frame overhead should show.

async function runBurstFamily(candidate: string, opt: RpcOpt | undefined, port: number) {
    const stand = await createStandServer({port, opt})
    const link = await connectStandClient({port: stand.port, opt, meter: stand.meter})
    try {
        await Promise.all(Array.from({length: BURST_SIZE}, function warmBurst(_item, index) {
            return link.client.func.quote(createQuoteRequest(-1 - index))
        }))

        stand.meter.setSizing(false)
        let nextSeq = 2_000_000
        const timing = await measureWindow(stand.meter, async function issueBursts(latencies) {
            for (let burst = 0; burst < BURSTS; burst++) {
                const pending: Promise<void>[] = []
                for (let index = 0; index < BURST_SIZE; index++) {
                    const seq = nextSeq++
                    const started = performance.now()
                    pending.push(link.client.func.quote(createQuoteRequest(seq))
                        .then(function verifyBurstResult(result) {
                            latencies.push(performance.now() - started)
                            if (result.seq != seq) throw new Error('burst result mismatch')
                        }))
                }
                await Promise.all(pending)
            }
            return BURSTS * BURST_SIZE
        })

        const accountingBursts = Math.max(2, Math.round(BURSTS * ACCOUNTING_SHARE))
        stand.meter.setSizing(true)
        const accounting = await measureWindow(stand.meter, async function accountBursts() {
            for (let burst = 0; burst < accountingBursts; burst++) {
                await Promise.all(Array.from({length: BURST_SIZE}, function issueAccountingCall() {
                    return link.client.func.quote(createQuoteRequest(nextSeq++))
                }))
            }
            return accountingBursts * BURST_SIZE
        })
        stand.meter.setSizing(false)

        return summarize({
            family: 'burst',
            candidate,
            timing,
            accounting,
            reportCpu: true,
            extra: {bursts: BURSTS, burstSize: BURST_SIZE},
        })
    } finally {
        await link.close()
        await stand.close()
    }
}

// =====================================================================
// Family 0 — connect handshake
// =====================================================================
// Connect cost is what a "fold the handshake" optimization would attack, so it is measured
// directly rather than inferred. `anonymous` is CAPS/MAP only; `auth` adds the in-band
// Pkt.HELLO round trip that a gated server requires before the first call.

async function runConnectFamily(candidate: string, opt: RpcOpt | undefined, port: number, withAuth: boolean) {
    const family = withAuth ? 'connect-auth' : 'connect'
    const stand = await createStandServer({port, opt, withAuth})
    const token = withAuth ? AUTH_TOKEN : undefined
    try {
        for (let index = 0; index < 20; index++) {
            const warm = await connectStandClient({port: stand.port, opt, meter: stand.meter, token})
            await warm.close()
        }

        stand.meter.setSizing(false)
        const timing = await measureWindow(stand.meter, async function connectMany(latencies) {
            for (let index = 0; index < CONNECTS; index++) {
                const started = performance.now()
                const link = await connectStandClient({port: stand.port, opt, meter: stand.meter, token})
                latencies.push(performance.now() - started)
                await link.close()
            }
            return CONNECTS
        })

        const accountingConnects = Math.max(10, Math.round(CONNECTS * ACCOUNTING_SHARE))
        stand.meter.setSizing(true)
        const accounting = await measureWindow(stand.meter, async function accountConnects() {
            for (let index = 0; index < accountingConnects; index++) {
                const link = await connectStandClient({port: stand.port, opt, meter: stand.meter, token})
                await link.close()
            }
            return accountingConnects
        })
        stand.meter.setSizing(false)

        return summarize({
            family,
            candidate,
            timing,
            accounting,
            reportCpu: false,
            reportThroughput: false,
            cpuNote: 'omitted: TCP/WebSocket setup dominates and is not RPC CPU',
        })
    } finally {
        await stand.close()
    }
}

// =====================================================================
// Candidates and families
// =====================================================================
// Every negotiable bit in rpc-caps.ts is represented. COMPACT and CB_BATCH are the two
// that touch the data path, so they get the full family matrix. AUTH_STATE and HELLO_ID
// only touch the handshake, so they are exercised in the connect families through
// `caps-all-off` instead of doubling every data row for a wire that cannot differ.
// REQ_BATCH joined them in 2.2.0 and is OFF by default, so `defaults` is its own control:
// `request-batch` vs `defaults` is exactly the bit ON vs OFF, everything else equal.
// ROWS is the row/table encoding of uniform record arrays plus the connection-scoped shape
// registry — aimed squarely at family `large`, where 49.26 % of the result was measured to be
// repeated key names, and expected to do nothing to `burst`. It shipped ON, so unlike
// REQ_BATCH its control has to be an explicit opt-out: `no-row-compact` vs `defaults` is that
// bit OFF vs ON and nothing else. `plain-json` and `caps-all-off` keep ROWS on, which is
// deliberate — they answer a question about COMPACT and CB_BATCH, not about this bit.

const CANDIDATES = {
    'defaults': undefined,
    'no-compact': {compact: false},
    'no-callback-batch': {callbackBatch: false},
    'request-batch': {requestBatch: true},
    'no-row-compact': {compactRows: false},
    'plain-json': {compact: false, callbackBatch: false},
    'caps-all-off': {compact: false, callbackBatch: false, authState: false, helloId: false},
} as const satisfies Record<string, RpcOpt | undefined>

type tCandidateName = keyof typeof CANDIDATES

const DATA_CANDIDATES: tCandidateName[] = ['defaults', 'no-compact', 'no-callback-batch', 'request-batch', 'no-row-compact', 'plain-json']
const CONNECT_CANDIDATES: tCandidateName[] = ['defaults', 'plain-json', 'caps-all-off']

const FAMILIES = [
    {
        name: 'connect',
        candidates: CONNECT_CANDIDATES,
        run: function runConnect(candidate: string, opt: RpcOpt | undefined, port: number) {
            return runConnectFamily(candidate, opt, port, false)
        },
    },
    {
        name: 'connect-auth',
        candidates: CONNECT_CANDIDATES,
        run: function runConnectAuth(candidate: string, opt: RpcOpt | undefined, port: number) {
            return runConnectFamily(candidate, opt, port, true)
        },
    },
    {name: 'small', candidates: DATA_CANDIDATES, run: runSmallFamily},
    {name: 'large', candidates: DATA_CANDIDATES, run: runLargeFamily},
    {name: 'ticks', candidates: DATA_CANDIDATES, run: runTickFamily},
    {name: 'flood', candidates: DATA_CANDIDATES, run: runFloodFamily},
    {name: 'burst', candidates: DATA_CANDIDATES, run: runBurstFamily},
] as const

function selectedFamilies() {
    if (FAMILY_FILTER.length == 0) return FAMILIES.slice()
    return FAMILIES.filter(family => FAMILY_FILTER.includes(family.name))
}

// =====================================================================
// Repeated-key accounting — measured, not assumed
// =====================================================================
// Deterministic and network-free: it compares the representation RPC really produces
// (packResult -> JSON) with the row/table representation a shape registry would produce
// for the SAME records. Both sides are encoded and weighed; nothing here is estimated.

function keyByteCost(value: unknown): {keyBytes: number, objects: number, keys: number} {
    let keyBytes = 0
    let objects = 0
    let keys = 0
    function walkValue(next: any) {
        if (next == null || typeof next != 'object') return
        if (Array.isArray(next)) {
            for (const item of next) walkValue(item)
            return
        }
        objects++
        for (const key of Object.keys(next)) {
            keys++
            // `"key":` — the quoted name plus its colon, exactly as JSON.stringify writes it.
            keyBytes += jsonUtf8ByteLength(key) + 1
            walkValue(next[key])
        }
    }
    walkValue(value)
    return {keyBytes, objects, keys}
}

function rowEncode(records: readonly Record<string, unknown>[]) {
    const keys = Object.keys(records[0] ?? {})
    return {
        k: keys,
        r: records.map(function encodeRow(record) {
            return keys.map(key => record[key])
        }),
    }
}

function barsWithEpochTime(records: readonly tBar[]) {
    return records.map(function flattenBarTime(record) {
        return {...record, time: record.time.valueOf()}
    })
}

function analyzeRepeatedKeys() {
    const packed = packResult(LARGE_RESULT)
    const packedBytes = jsonUtf8ByteLength(packed)
    const keyCost = keyByteCost(packed)
    const rowBytes = jsonUtf8ByteLength(packResult(rowEncode(LARGE_RESULT as any)))
    const epochRecords = barsWithEpochTime(LARGE_RESULT)
    const epochBytes = jsonUtf8ByteLength(packResult(epochRecords))
    const epochRowBytes = jsonUtf8ByteLength(packResult(rowEncode(epochRecords as any)))
    const tick = createTick(1)
    const tickPacked = packResult(tick)
    const tickBytes = jsonUtf8ByteLength(tickPacked)
    const tickKeyCost = keyByteCost(tickPacked)
    const tickValuesBytes = jsonUtf8ByteLength(Object.keys(tick).map(key => (tick as any)[key]))
    return {
        records: LARGE_RECORDS,
        packedResultBytes: packedBytes,
        keyBytes: keyCost.keyBytes,
        keyBytesShare: rounded(keyCost.keyBytes / packedBytes, 4),
        objectsInResult: keyCost.objects,
        keysInResult: keyCost.keys,
        rowEncodedBytes: rowBytes,
        rowEncodingSavedBytes: packedBytes - rowBytes,
        rowEncodingSavedShare: rounded((packedBytes - rowBytes) / packedBytes, 4),
        dateWrapperCostBytes: packedBytes - epochBytes,
        epochTimeBytes: epochBytes,
        epochRowEncodedBytes: epochRowBytes,
        tickPackedBytes: tickBytes,
        tickKeyBytes: tickKeyCost.keyBytes,
        tickValuesOnlyBytes: tickValuesBytes,
        tickCompactSavedBytes: tickBytes - tickValuesBytes,
    }
}

// =====================================================================
// Environment block
// =====================================================================

function environmentBlock() {
    return {
        node: process.version,
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        transport: 'socket.io websocket over 127.0.0.1, perMessageDeflate disabled',
        options: {
            runs: RUNS,
            seed: SEED,
            basePort: BASE_PORT,
            smallCalls: SMALL_CALLS,
            smallGapMs: SMALL_GAP_MS,
            largeCalls: LARGE_CALLS,
            largeRecords: LARGE_RECORDS,
            tickCount: TICK_COUNT,
            tickHz: TICK_HZ,
            floodRounds: FLOOD_ROUNDS,
            floodSize: FLOOD_SIZE,
            bursts: BURSTS,
            burstSize: BURST_SIZE,
            connects: CONNECTS,
        },
    }
}

// =====================================================================
// Worker mode — one unit, one fresh process
// =====================================================================

async function runUnitInProcess() {
    const [familyName, candidateName] = UNIT.split(':')
    const family = FAMILIES.find(item => item.name == familyName)
    if (!family) throw new Error('unknown family ' + familyName)
    if (!(candidateName in CANDIDATES)) throw new Error('unknown candidate ' + candidateName)
    const opt = CANDIDATES[candidateName as tCandidateName] as RpcOpt | undefined
    const measurement = await family.run(candidateName, opt, UNIT_PORT)
    if (measurement.wire.frameProbe != 'ws-socket') {
        throw new Error('frame probe unavailable: physical frame counts would be untrustworthy')
    }
    if (measurement.wire.c2sFrames <= 0 || measurement.wire.s2cFrames <= 0) {
        throw new Error('frame probe produced no frames: instrumentation is broken')
    }
    console.log(UNIT_MARKER + ' ' + JSON.stringify(measurement))
}

// =====================================================================
// Orchestrator — fresh process per unit, randomized candidate order
// =====================================================================

function benchFilePath() {
    const argvPath = process.argv[1] ?? ''
    if (argvPath.endsWith('bench.ts')) return resolvePath(argvPath)
    return resolvePath(process.cwd(), 'experiments/rpc-perf-2026-07/bench.ts')
}

function spawnUnit(familyName: string, candidateName: string, port: number) {
    return new Promise<tMeasurement>(function runChild(resolve, reject) {
        const child = spawn(process.execPath, ['--import', 'tsx', benchFilePath()], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                RPC_BENCH_UNIT: familyName + ':' + candidateName,
                RPC_BENCH_UNIT_PORT: String(port),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        let err = ''
        child.stdout.on('data', function collectOut(chunk) { out += chunk })
        child.stderr.on('data', function collectErr(chunk) { err += chunk })
        child.once('error', reject)
        child.once('close', function childClosed(code) {
            const line = out.split(/\r?\n/).find(item => item.startsWith(UNIT_MARKER))
            if (code != 0 || !line) {
                reject(new Error('unit ' + familyName + ':' + candidateName + ' failed (code ' + code + ')\n'
                    + err.slice(-4_000) + '\n' + out.slice(-2_000)))
                return
            }
            try {
                resolve(JSON.parse(line.slice(UNIT_MARKER.length)) as tMeasurement)
            } catch (error) {
                reject(error as Error)
            }
        })
    })
}

// =====================================================================
// Aggregation and report
// =====================================================================

type tSample = {run: number, order: number, measurement: tMeasurement}

function metricValues(samples: tSample[], read: (m: tMeasurement) => number | undefined) {
    return samples.map(sample => read(sample.measurement)).filter(function isNumber(value): value is number {
        return typeof value == 'number' && Number.isFinite(value)
    })
}

function spread(values: number[]) {
    if (values.length == 0) return {median: undefined, min: undefined, max: undefined, spreadPct: undefined}
    const mid = median(values)
    const min = Math.min(...values)
    const max = Math.max(...values)
    return {
        median: rounded(mid),
        min: rounded(min),
        max: rounded(max),
        spreadPct: mid > 0 ? rounded(((max - min) / mid) * 100, 1) : 0,
    }
}

function fmtSpread(values: number[]) {
    const stat = spread(values)
    if (stat.median == undefined) return '—'
    if (stat.min == stat.max) return String(stat.median)
    return stat.median + ' [' + stat.min + '…' + stat.max + ']'
}

function aggregateFamily(familyName: string, samples: tSample[]) {
    const byCandidate = new Map<string, tSample[]>()
    for (const sample of samples) {
        if (sample.measurement.family != familyName) continue
        const list = byCandidate.get(sample.measurement.candidate) ?? []
        list.push(sample)
        byCandidate.set(sample.measurement.candidate, list)
    }
    return [...byCandidate.entries()].map(function summarizeCandidate(entry) {
        const [candidate, list] = entry
        const messages = median(metricValues(list, m => m.messages)) || 1
        return {
            family: familyName,
            candidate,
            p50Ms: fmtSpread(metricValues(list, m => m.p50Ms)),
            p95Ms: fmtSpread(metricValues(list, m => m.p95Ms)),
            p99Ms: fmtSpread(metricValues(list, m => m.p99Ms)),
            msgPerSec: fmtSpread(metricValues(list, m => m.messagesPerSecond)),
            cpuUsPerMsg: fmtSpread(metricValues(list, m => m.cpuUsPerMessage)),
            loopP95Ms: fmtSpread(metricValues(list, m => m.loopP95Ms)),
            gcMs: fmtSpread(metricValues(list, m => m.gcMs)),
            cpuUsTotal: fmtSpread(metricValues(list, m => m.cpuUsTotal)),
            c2sFrames: fmtSpread(metricValues(list, m => m.wire.c2sFrames)),
            s2cFrames: fmtSpread(metricValues(list, m => m.wire.s2cFrames)),
            s2cRpcPackets: fmtSpread(metricValues(list, m => m.wire.s2cRpcPackets)),
            c2sBytesPerMsg: fmtSpread(metricValues(list, m => m.wire.c2sWsBytes / (m.messages || 1))),
            s2cBytesPerMsg: fmtSpread(metricValues(list, m => m.wire.s2cWsBytes / (m.messages || 1))),
            tcpBytesPerMsg: fmtSpread(metricValues(list, m =>
                (m.wire.c2sTcpBytes + m.wire.s2cTcpBytes) / (m.messages || 1))),
            framesPerMsg: fmtSpread(metricValues(list, m =>
                (m.wire.c2sFrames + m.wire.s2cFrames) / (m.messages || 1))),
            messages,
        }
    })
}

function wireDetailRows(samples: tSample[]) {
    const seen = new Set<string>()
    const rows: Record<string, unknown>[] = []
    for (const sample of samples) {
        const measurement = sample.measurement
        const id = measurement.family + '/' + measurement.candidate
        if (seen.has(id)) continue
        seen.add(id)
        const accounting = measurement.accounting
        const perMessage = accounting.messages || 1
        rows.push({
            family: measurement.family,
            candidate: measurement.candidate,
            msgs: accounting.messages,
            c2sFrames: accounting.c2sFrames,
            c2sPackets: accounting.c2sRpcPackets,
            s2cFrames: accounting.s2cFrames,
            s2cPackets: accounting.s2cRpcPackets,
            packetsPerFrame: rounded(accounting.s2cRpcPackets / Math.max(1, accounting.s2cFrames), 2),
            c2sBytesPerMsg: rounded(accounting.c2sWsBytes / perMessage, 1),
            s2cBytesPerMsg: rounded(accounting.s2cWsBytes / perMessage, 1),
            s2cOpcodes: Object.entries(accounting.s2cByOpcode)
                .map(entry => entry[0] + '×' + entry[1].n + '/' + entry[1].bytes + 'B').join(' '),
        })
    }
    return rows
}

function coldDetailRows(samples: tSample[]) {
    const seen = new Set<string>()
    const rows: Record<string, unknown>[] = []
    for (const sample of samples) {
        const cold = sample.measurement.coldAccounting
        if (cold == undefined) continue
        const id = sample.measurement.family + '/' + sample.measurement.candidate
        if (seen.has(id)) continue
        seen.add(id)
        rows.push({
            family: sample.measurement.family,
            candidate: sample.measurement.candidate,
            ticks: cold.messages,
            s2cFrames: cold.s2cFrames,
            s2cPackets: cold.s2cRpcPackets,
            s2cBytesPerTick: rounded(cold.s2cWsBytes / (cold.messages || 1), 1),
            s2cOpcodes: Object.entries(cold.s2cByOpcode)
                .map(entry => entry[0] + '×' + entry[1].n + '/' + entry[1].bytes + 'B').join(' '),
        })
    }
    return rows
}

// =====================================================================
// Entry point
// =====================================================================

async function main() {
    if (UNIT != '') {
        await runUnitInProcess()
        return
    }

    const families = selectedFamilies()
    if (families.length == 0) throw new Error('no family matched RPC_BENCH_FAMILY')

    console.log('RPC performance experiment — July 2026')
    console.log(JSON.stringify(environmentBlock(), null, 2))

    const samples: tSample[] = []
    const orders: {run: number, family: string, order: string[]}[] = []
    let portCursor = 0
    let unitIndex = 0

    for (let run = 1; run <= RUNS; run++) {
        for (const [familyIndex, family] of families.entries()) {
            const random = createRandom(SEED + run * 7_919 + familyIndex * 104_729 + 1)
            const order = shuffled(family.candidates, random)
            orders.push({run, family: family.name, order: order.slice()})
            for (const candidate of order) {
                const port = BASE_PORT + (portCursor++ % 240)
                process.stdout.write('  run ' + run + '  ' + family.name + ' / ' + candidate + ' … ')
                const started = performance.now()
                const measurement = await spawnUnit(family.name, candidate, port)
                samples.push({run, order: unitIndex++, measurement})
                console.log(Math.round(performance.now() - started) + ' ms')
            }
        }
    }

    console.log('\nCandidate order per run')
    console.table(orders.map(entry => ({run: entry.run, family: entry.family, order: entry.order.join(' → ')})))

    for (const family of families) {
        console.log('\n' + family.name + ' — median [min…max] over ' + RUNS + ' runs')
        console.table(aggregateFamily(family.name, samples))
    }

    console.log('\nWire structure (accounting pass, first run of each unit)')
    console.table(wireDetailRows(samples))

    const coldRows = coldDetailRows(samples)
    if (coldRows.length > 0) {
        console.log('\nFirst subscription on a fresh connection (cold shape registry)')
        console.table(coldRows)
    }

    console.log('\nRepeated-key accounting for the large uniform result')
    console.table([analyzeRepeatedKeys()])

    console.log('\n' + UNIT_MARKER.replace('UNIT', 'RESULT'))
    console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        environment: environmentBlock(),
        candidateOrders: orders,
        keyAccounting: analyzeRepeatedKeys(),
        samples: samples.map(sample => ({run: sample.run, order: sample.order, ...sample.measurement})),
    }))
}

main().catch(function reportFailure(error) {
    console.error(error)
    process.exit(1)
})
