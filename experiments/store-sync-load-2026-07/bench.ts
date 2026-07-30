// =====================================================================
// Store synchronization load experiment
// =====================================================================
// The stand keeps four costs separate:
//   1. ordinary object allocation + array assignment
//   2. reactive Store assignment + settled patch production
//   3. Store Replay production + in-process mirror application
//   4. the same Store Replay path over real RPC and Socket.IO/WebSocket
//
// Requested load keeps the operation count of the original full-array baseline.
// Changed-row, represented patch and RPC/WebSocket/TCP bytes stay separate.

import {spawn} from 'node:child_process'
import {createServer, type Server as HttpServer} from 'node:http'
import type {Socket as NetSocket} from 'node:net'
import {arch, cpus, platform, release} from 'node:os'
import {resolve as resolvePath} from 'node:path'
import {monitorEventLoopDelay, performance, PerformanceObserver} from 'node:perf_hooks'
import {Server as SocketIoServer} from 'socket.io'
import {io as createSocketIoClient} from 'socket.io-client'
import {listen} from '../../src/Common/events/Listen'
import {flushReactive} from '../../src/Common/Observe/reactive'
import {
    createStore,
    listenStorePatches,
    type StorePatch,
} from '../../src/Common/Observe/store'
import {
    exposeStoreReplay,
    syncStoreReplay,
    type StoreReplayRemote,
} from '../../src/Common/Observe/store-replay'
import {createRpcClient} from '../../src/Common/rcp/rpc-client'
import {createRpcServerAuto} from '../../src/Common/rcp/rpc-server-auto'
import type {SocketTmpl} from '../../src/Common/rcp/rpc-protocol'

// =====================================================================
// Options
// =====================================================================

const MIB = 1024 * 1024
const UNIT_MARKER = '##STORE_LOAD_UNIT##'
const RESULT_MARKER = '##STORE_LOAD_RESULT##'
const SOCKET_KEY = 'store-load'

function positiveIntegerEnv(name: string, fallback: number) {
    const raw = process.env[name]
    if (raw == null || raw == '') return fallback
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(name + ' must be a positive integer')
    return value
}

function positiveNumberEnv(name: string, fallback: number) {
    const raw = process.env[name]
    if (raw == null || raw == '') return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(name + ' must be a positive number')
    return value
}

function targetListEnv() {
    const raw = process.env['STORE_LOAD_TARGETS_MIB'] ?? '15,50'
    const targets = raw.split(',').map(function parseTarget(part) {
        const value = Number(part.trim())
        if (!Number.isFinite(value) || value <= 0) {
            throw new RangeError('STORE_LOAD_TARGETS_MIB must contain positive numbers')
        }
        return value
    })
    if (targets.length == 0) throw new RangeError('STORE_LOAD_TARGETS_MIB must not be empty')
    return targets
}

const RUNS = positiveIntegerEnv('STORE_LOAD_RUNS', 3)
const SEED = positiveIntegerEnv('STORE_LOAD_SEED', 20260730)
const ARRAY_LENGTH = positiveIntegerEnv('STORE_LOAD_ARRAY_LENGTH', 4_096)
const PAYLOAD_BYTES = positiveIntegerEnv('STORE_LOAD_PAYLOAD_BYTES', 128)
const SOURCE_BATCH_SIZE = positiveIntegerEnv('STORE_LOAD_BATCH_SIZE', 128)
const WARMUP_MIB = positiveNumberEnv(
    'STORE_LOAD_WARMUP_MIB',
    ARRAY_LENGTH * PAYLOAD_BYTES / MIB,
)
const TARGETS_MIB = targetListEnv()
const UNIT = process.env['STORE_LOAD_UNIT'] ?? ''
const UNIT_TARGET_MIB = positiveNumberEnv('STORE_LOAD_TARGET_MIB', TARGETS_MIB[0])
const CANDIDATE_FILTER = (process.env['STORE_LOAD_CANDIDATE'] ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)

type tCandidateName =
    | 'plain-array'
    | 'store-patches'
    | 'store-replay-inproc'
    | 'store-replay-socket'

const CANDIDATE_NAMES: readonly tCandidateName[] = [
    'plain-array',
    'store-patches',
    'store-replay-inproc',
    'store-replay-socket',
]

// =====================================================================
// Stable high-frequency array workload
// =====================================================================

type tRow = {
    seq: number
    price: number
    flags: number
    payload: string
}

type tState = {
    rows: tRow[]
}

const PAYLOAD_POOL = Array.from({length: 256}, function createFixedPayload(_value, index) {
    const prefix = index.toString(16).padStart(2, '0')
    return prefix + 'x'.repeat(Math.max(0, PAYLOAD_BYTES - prefix.length))
})

function createRow(seq: number): tRow {
    return {
        seq,
        price: 100_000 + (seq % 10_000) / 100,
        flags: seq % 8,
        payload: PAYLOAD_POOL[seq & 255],
    }
}

function createInitialState(): tState {
    return {
        rows: Array.from({length: ARRAY_LENGTH}, function createEmptyRow() {
            return {seq: -1, price: 0, flags: 0, payload: ''}
        }),
    }
}

function expectedSeq(index: number, totalOperations: number) {
    if (index >= totalOperations) return -1
    return index + Math.floor((totalOperations - 1 - index) / ARRAY_LENGTH) * ARRAY_LENGTH
}

function sourceBatchCount(operations: number) {
    return Math.ceil(operations / SOURCE_BATCH_SIZE)
}

function representedPayloadBytes(operations: number) {
    return sourceBatchCount(operations) * ARRAY_LENGTH * PAYLOAD_BYTES
}

function verifyRows(rows: readonly tRow[], totalOperations: number, label: string) {
    if (rows.length != ARRAY_LENGTH) {
        throw new Error(label + ': array length changed from ' + ARRAY_LENGTH + ' to ' + rows.length)
    }
    for (let index = 0; index < rows.length; index++) {
        const expected = expectedSeq(index, totalOperations)
        if (rows[index]?.seq != expected) {
            throw new Error(label + ': row ' + index + ' has seq ' + rows[index]?.seq + ', expected ' + expected)
        }
    }
}

async function driveUpdates({
    start,
    count,
    write,
    flush,
    sample,
}: {
    start: number
    count: number
    write: (seq: number) => void
    flush?: () => Promise<void>
    sample: () => void
}) {
    const end = start + count
    for (let base = start; base < end; base += SOURCE_BATCH_SIZE) {
        const batchEnd = Math.min(end, base + SOURCE_BATCH_SIZE)
        for (let seq = base; seq < batchEnd; seq++) write(seq)
        if (flush) await flush()
        sample()
    }
}

// =====================================================================
// Measurement primitives
// =====================================================================

function delay(ms: number) {
    return new Promise<void>(function wait(resolve) {
        setTimeout(resolve, ms)
    })
}

function rounded(value: number | undefined, digits = 3) {
    return value == null || !Number.isFinite(value) ? undefined : Number(value.toFixed(digits))
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

function collectGarbage() {
    const gc = (globalThis as typeof globalThis & {gc?: () => void}).gc
    gc?.()
}

function finiteDelay(value: number) {
    return Number.isFinite(value) ? value / 1e6 : undefined
}

function createRuntimeWatch() {
    const loop = monitorEventLoopDelay({resolution: 1})
    let gcCount = 0
    let gcMs = 0
    let peakHeap = 0
    let peakRss = 0
    let timer: NodeJS.Timeout | undefined
    const observer = new PerformanceObserver(function collectGc(list) {
        for (const entry of list.getEntries()) {
            gcCount++
            gcMs += entry.duration
        }
    })

    function sample() {
        const memory = process.memoryUsage()
        peakHeap = Math.max(peakHeap, memory.heapUsed)
        peakRss = Math.max(peakRss, memory.rss)
    }

    function start() {
        gcCount = 0
        gcMs = 0
        sample()
        loop.reset()
        loop.enable()
        observer.observe({entryTypes: ['gc']})
        timer = setInterval(sample, 10)
        timer.unref()
    }

    function stop() {
        sample()
        if (timer) clearInterval(timer)
        timer = undefined
        loop.disable()
        observer.disconnect()
        const loopMeanMs = finiteDelay(loop.mean)
        return {
            loopMeanMs,
            loopP95Ms: loopMeanMs == undefined ? undefined : finiteDelay(loop.percentile(95)),
            loopMaxMs: loopMeanMs == undefined ? undefined : finiteDelay(loop.max),
            gcCount,
            gcMs,
            peakHeap,
            peakRss,
        }
    }

    return {start, sample, stop}
}

// =====================================================================
// Exact wire meter
// =====================================================================
// This is the same outside-seam probe used by the RPC performance stand:
// logical emits are counted at the RPC adapter, physical frames at engine.io's
// underlying ws socket, and bytes are cross-checked at the accepted net.Socket.

function frameByteLength(data: unknown) {
    if (typeof data == 'string') return Buffer.byteLength(data)
    if (ArrayBuffer.isView(data)) return data.byteLength
    if (data instanceof ArrayBuffer) return data.byteLength
    return 0
}

function createWireMeter() {
    const logical = {c2sEmits: 0, s2cEmits: 0}
    const physical = {c2sFrames: 0, c2sBytes: 0, s2cFrames: 0, s2cBytes: 0}
    const liveNet = new Set<NetSocket>()
    let closedRead = 0
    let closedWritten = 0
    let frameProbe = 'unavailable'

    function meteredAdapter(socket: SocketTmpl, direction: 'c2s' | 's2c'): SocketTmpl {
        return {
            on: function onMeteredEvent(event, cb) {
                socket.on(event, cb)
            },
            emit: function emitMeteredEvent(event, data) {
                if (direction == 'c2s') logical.c2sEmits++
                else logical.s2cEmits++
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
            raw.on('message', function countInboundFrame(data: unknown) {
                physical.c2sFrames++
                physical.c2sBytes += frameByteLength(data)
            })
            const originalSend = raw.send.bind(raw)
            raw.send = function countedSend(data: unknown, ...rest: any[]) {
                physical.s2cFrames++
                physical.s2cBytes += frameByteLength(data)
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
        return {
            logical: {...logical},
            physical: {...physical},
            tcp: tcpTotals(),
            frameProbe,
        }
    }

    function diff(before: ReturnType<typeof snapshot>) {
        const after = snapshot()
        return {
            frameProbe: after.frameProbe,
            c2s: {
                rpcEmits: after.logical.c2sEmits - before.logical.c2sEmits,
                frames: after.physical.c2sFrames - before.physical.c2sFrames,
                wsBytes: after.physical.c2sBytes - before.physical.c2sBytes,
                tcpBytes: after.tcp.read - before.tcp.read,
            },
            s2c: {
                rpcEmits: after.logical.s2cEmits - before.logical.s2cEmits,
                frames: after.physical.s2cFrames - before.physical.s2cFrames,
                wsBytes: after.physical.s2cBytes - before.physical.s2cBytes,
                tcpBytes: after.tcp.written - before.tcp.written,
            },
        }
    }

    return {meteredAdapter, watchHttpServer, watchEngine, snapshot, diff}
}

type tWireMeter = ReturnType<typeof createWireMeter>
type tWireDiff = ReturnType<tWireMeter['diff']>

// =====================================================================
// Resource facade
// =====================================================================

type tPipelineMetrics = {
    sourceBatches: number
    sourcePatches: number
    emittedBatches: number
    emittedPatches: number
    estimatedBytes: number
    appliedBatches: number
    appliedPatches: number
}

type tLoadResource = {
    run: (start: number, count: number, sample: () => void) => Promise<void>
    verify: (totalOperations: number) => void
    resetMetrics: () => void
    metrics: () => tPipelineMetrics
    close: () => Promise<void>
    wire?: tWireMeter
}

function emptyPipelineMetrics(): tPipelineMetrics {
    return {
        sourceBatches: 0,
        sourcePatches: 0,
        emittedBatches: 0,
        emittedPatches: 0,
        estimatedBytes: 0,
        appliedBatches: 0,
        appliedPatches: 0,
    }
}

function subtractBatchStats(
    after: ReturnType<ReturnType<typeof exposeStoreReplay<tState>>['batchStats']>,
    before: ReturnType<ReturnType<typeof exposeStoreReplay<tState>>['batchStats']>,
) {
    return {
        sourceBatches: after.sourceBatches - before.sourceBatches,
        sourcePatches: after.sourcePatches - before.sourcePatches,
        emittedBatches: after.emittedBatches - before.emittedBatches,
        emittedPatches: after.emittedPatches - before.emittedPatches,
        estimatedBytes: after.estimatedBytes - before.estimatedBytes,
    }
}

function createPatchApplyTracker(label: string) {
    let appliedBatches = 0
    let appliedPatches = 0
    let waiter: {target: number, resolve: () => void, reject: (error: Error) => void, timer: NodeJS.Timeout} | undefined

    function record(patches: readonly StorePatch[]) {
        appliedBatches++
        appliedPatches += patches.length
        if (waiter && appliedPatches >= waiter.target) {
            clearTimeout(waiter.timer)
            const resolve = waiter.resolve
            waiter = undefined
            resolve()
        }
    }

    function expect(additionalPatches: number) {
        if (waiter) throw new Error(label + ': concurrent completion wait')
        const target = appliedPatches + additionalPatches
        return new Promise<void>(function waitForPatches(resolve, reject) {
            const timer = setTimeout(function patchTimeout() {
                waiter = undefined
                reject(new Error(label + ': timed out at ' + appliedPatches + ' of ' + target + ' patches'))
            }, 120_000)
            timer.unref()
            waiter = {target, resolve, reject, timer}
        })
    }

    function reset() {
        if (waiter) throw new Error(label + ': cannot reset while waiting')
        appliedBatches = 0
        appliedPatches = 0
    }

    function metrics() {
        return {appliedBatches, appliedPatches}
    }

    function close() {
        if (!waiter) return
        clearTimeout(waiter.timer)
        const reject = waiter.reject
        waiter = undefined
        reject(new Error(label + ': closed'))
    }

    return {record, expect, reset, metrics, close}
}

// =====================================================================
// Candidate 1 — ordinary array baseline
// =====================================================================

async function createPlainArrayResource(): Promise<tLoadResource> {
    const state = createInitialState()

    return {
        async run(start, count, sample) {
            await driveUpdates({
                start,
                count,
                write: function writePlainRow(seq) {
                    state.rows[seq % ARRAY_LENGTH] = createRow(seq)
                },
                sample,
            })
        },
        verify(totalOperations) {
            verifyRows(state.rows, totalOperations, 'plain-array')
        },
        resetMetrics() {},
        metrics: emptyPipelineMetrics,
        async close() {},
    }
}

// =====================================================================
// Candidate 2 — Store patch production without a mirror
// =====================================================================

async function createStorePatchesResource(): Promise<tLoadResource> {
    const store = createStore<tState>(createInitialState(), {drain: 'micro'})
    const patches = listenStorePatches(store)
    let sourceBatches = 0
    let sourcePatches = 0
    const off = patches.on(function observePatches(next) {
        sourceBatches++
        sourcePatches += next.length
    })

    return {
        async run(start, count, sample) {
            await driveUpdates({
                start,
                count,
                write: function writeStoreRow(seq) {
                    store.state.rows[seq % ARRAY_LENGTH] = createRow(seq)
                },
                flush: function flushStore() {
                    return flushReactive(store.state)
                },
                sample,
            })
        },
        verify(totalOperations) {
            verifyRows(store.state.rows, totalOperations, 'store-patches')
        },
        resetMetrics() {
            sourceBatches = 0
            sourcePatches = 0
        },
        metrics() {
            return {
                ...emptyPipelineMetrics(),
                sourceBatches,
                sourcePatches,
            }
        },
        async close() {
            off()
        },
    }
}

// =====================================================================
// Candidate 3 — Store Replay mirror in process
// =====================================================================

async function createInProcReplayResource(): Promise<tLoadResource> {
    const source = createStore<tState>(createInitialState(), {drain: 'micro'})
    const exposed = exposeStoreReplay(source, {
        history: 16,
        maxItems: 256,
        maxBytes: 64 * 1024,
    })
    const mirror = createStore<tState>(createInitialState(), {drain: 'micro'})
    const tracker = createPatchApplyTracker('store-replay-inproc')
    const sub = syncStoreReplay(mirror, exposed.api.replay as StoreReplayRemote, {
        onBatch: tracker.record,
    })
    await sub.ready
    tracker.reset()
    let batchBaseline = exposed.batchStats()

    return {
        async run(start, count, sample) {
            const complete = tracker.expect(count)
            await driveUpdates({
                start,
                count,
                write: function writeReplayRow(seq) {
                    source.state.rows[seq % ARRAY_LENGTH] = createRow(seq)
                },
                flush: function flushReplaySource() {
                    return flushReactive(source.state)
                },
                sample,
            })
            await complete
        },
        verify(totalOperations) {
            verifyRows(source.state.rows, totalOperations, 'store-replay-inproc source')
            verifyRows(mirror.state.rows, totalOperations, 'store-replay-inproc mirror')
        },
        resetMetrics() {
            tracker.reset()
            batchBaseline = exposed.batchStats()
        },
        metrics() {
            return {
                ...subtractBatchStats(exposed.batchStats(), batchBaseline),
                ...tracker.metrics(),
            }
        },
        async close() {
            tracker.close()
            sub()
            exposed.close()
        },
    }
}

// =====================================================================
// Candidate 4 — Store Replay over real Socket.IO/WebSocket RPC
// =====================================================================

async function listenOnEphemeralPort(server: HttpServer) {
    await new Promise<void>(function listenServer(resolve, reject) {
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
    await new Promise<void>(function closeServer(resolve, reject) {
        server.close(function closed(error) {
            if (error) reject(error)
            else resolve()
        })
    })
}

async function createSocketReplayResource(): Promise<tLoadResource> {
    const source = createStore<tState>(createInitialState(), {drain: 'micro'})
    const exposed = exposeStoreReplay(source, {
        history: 16,
        maxItems: 256,
        maxBytes: 64 * 1024,
    })
    const serverApi = {store: exposed.api}
    const meter = createWireMeter()
    const httpServer = createServer()
    meter.watchHttpServer(httpServer)
    const ioServer = new SocketIoServer(httpServer, {
        transports: ['websocket'],
        perMessageDeflate: false,
        serveClient: false,
        maxHttpBufferSize: 100 * MIB,
    })
    meter.watchEngine(ioServer)

    ioServer.on('connection', function serveStore(socket) {
        const [disconnect, disconnectListen] = listen<[]>()
        socket.on('disconnect', function closeConnection() {
            disconnect()
        })
        createRpcServerAuto({
            socket: meter.meteredAdapter(socket as unknown as SocketTmpl, 's2c'),
            object: serverApi,
            socketKey: SOCKET_KEY,
            disconnectListen,
        })
    })

    const port = await listenOnEphemeralPort(httpServer)
    const socket = createSocketIoClient('http://127.0.0.1:' + port, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
    })
    await new Promise<void>(function connectClient(resolve, reject) {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
    })
    const client = createRpcClient<typeof serverApi>({
        socket: meter.meteredAdapter(socket as unknown as SocketTmpl, 'c2s'),
        socketKey: SOCKET_KEY,
    })
    await client.init()

    const mirror = createStore<tState>(createInitialState(), {drain: 'micro'})
    const tracker = createPatchApplyTracker('store-replay-socket')
    const remote = client.func.store!.replay as unknown as StoreReplayRemote
    const sub = syncStoreReplay(mirror, remote, {onBatch: tracker.record})
    await sub.ready
    tracker.reset()
    let batchBaseline = exposed.batchStats()

    return {
        wire: meter,
        async run(start, count, sample) {
            const complete = tracker.expect(count)
            await driveUpdates({
                start,
                count,
                write: function writeSocketReplayRow(seq) {
                    source.state.rows[seq % ARRAY_LENGTH] = createRow(seq)
                },
                flush: function flushSocketReplaySource() {
                    return flushReactive(source.state)
                },
                sample,
            })
            await complete
        },
        verify(totalOperations) {
            verifyRows(source.state.rows, totalOperations, 'store-replay-socket source')
            verifyRows(mirror.state.rows, totalOperations, 'store-replay-socket mirror')
        },
        resetMetrics() {
            tracker.reset()
            batchBaseline = exposed.batchStats()
        },
        metrics() {
            return {
                ...subtractBatchStats(exposed.batchStats(), batchBaseline),
                ...tracker.metrics(),
            }
        },
        async close() {
            tracker.close()
            sub()
            client.close('store load bench done')
            await new Promise<void>(function disconnectClient(resolve) {
                if (!socket.connected) return resolve()
                socket.once('disconnect', function disconnected() {
                    resolve()
                })
                socket.disconnect()
            })
            exposed.close()
            await new Promise<void>(function closeIo(resolve) {
                ioServer.close(function closed() {
                    resolve()
                })
            })
            await closeHttpServer(httpServer)
        },
    }
}

const CANDIDATES: Record<tCandidateName, () => Promise<tLoadResource>> = {
    'plain-array': createPlainArrayResource,
    'store-patches': createStorePatchesResource,
    'store-replay-inproc': createInProcReplayResource,
    'store-replay-socket': createSocketReplayResource,
}

// =====================================================================
// Worker — one candidate and one target in a fresh process
// =====================================================================

type tMeasurement = {
    candidate: tCandidateName
    targetMiB: number
    operations: number
    payloadBytes: number
    changedPayloadMiB: number
    representedPayloadMiB: number
    patchAmplification: number
    wallMs: number
    operationsPerSecond: number
    changedMiBPerSecond: number
    representedMiBPerSecond: number
    cpuUsPerOperation: number
    cpuUtilizationPct: number
    loopMeanMs?: number
    loopP95Ms?: number
    loopMaxMs?: number
    gcCount: number
    gcMs: number
    heapDeltaMiB: number
    peakHeapDeltaMiB: number
    rssDeltaMiB: number
    peakRssDeltaMiB: number
    retainedHeapDeltaMiB: number
    retainedRssDeltaMiB: number
    pipeline: tPipelineMetrics
    wire?: tWireDiff & {
        wsBytesPerOperation: number
        tcpBytesPerOperation: number
        wsProtocolAmplification: number
        tcpProtocolAmplification: number
        wsEndToEndAmplification: number
        tcpEndToEndAmplification: number
        framingBytes: number
    }
}

async function runUnitInProcess() {
    if (!(UNIT in CANDIDATES)) throw new Error('unknown STORE_LOAD_UNIT ' + UNIT)
    const candidate = UNIT as tCandidateName
    const snapshotPayloadBytes = ARRAY_LENGTH * PAYLOAD_BYTES
    const targetBatches = Math.ceil(UNIT_TARGET_MIB * MIB / snapshotPayloadBytes)
    const operations = targetBatches * SOURCE_BATCH_SIZE
    const warmupOperations = warmupOperationCount()
    const resource = await CANDIDATES[candidate]()

    try {
        await resource.run(0, warmupOperations, function noWarmupSample() {})
        resource.verify(warmupOperations)
        resource.resetMetrics()
        collectGarbage()
        await delay(20)

        const startMemory = process.memoryUsage()
        const runtimeWatch = createRuntimeWatch()
        const wireBefore = resource.wire?.snapshot()
        runtimeWatch.start()
        const cpuStart = process.cpuUsage()
        const wallStart = performance.now()

        await resource.run(warmupOperations, operations, runtimeWatch.sample)

        const wallMs = performance.now() - wallStart
        const cpuUs = cpuMicroseconds(process.cpuUsage(cpuStart))
        const runtime = runtimeWatch.stop()
        const endMemory = process.memoryUsage()
        const wire = wireBefore && resource.wire ? resource.wire.diff(wireBefore) : undefined
        const changedBytes = operations * PAYLOAD_BYTES
        const representedBytes = candidate.includes('replay')
            ? changedBytes
            : representedPayloadBytes(operations)
        resource.verify(warmupOperations + operations)

        const expectedPatches = candidate.includes('replay')
            ? operations
            : sourceBatchCount(operations)
        if (candidate != 'plain-array' && resource.metrics().sourcePatches != expectedPatches) {
            throw new Error(candidate + ': produced ' + resource.metrics().sourcePatches
                + ' patches for ' + expectedPatches + ' array drain windows')
        }
        if (candidate.includes('replay') && resource.metrics().appliedPatches != expectedPatches) {
            throw new Error(candidate + ': applied ' + resource.metrics().appliedPatches
                + ' patches for ' + expectedPatches + ' array drain windows')
        }
        if (wire) {
            if (wire.frameProbe != 'ws-socket' || wire.s2c.frames <= 0) {
                throw new Error('physical WebSocket frame probe failed')
            }
            if (wire.s2c.tcpBytes < wire.s2c.wsBytes) {
                throw new Error('TCP byte count is smaller than WebSocket payload count')
            }
        }
        collectGarbage()
        await delay(20)
        collectGarbage()
        await delay(20)
        const retainedMemory = process.memoryUsage()

        const measurement: tMeasurement = {
            candidate,
            targetMiB: UNIT_TARGET_MIB,
            operations,
            payloadBytes: PAYLOAD_BYTES,
            changedPayloadMiB: rounded(changedBytes / MIB, 3)!,
            representedPayloadMiB: rounded(representedBytes / MIB, 3)!,
            patchAmplification: rounded(representedBytes / changedBytes, 3)!,
            wallMs: rounded(wallMs, 3)!,
            operationsPerSecond: rounded(operations / (wallMs / 1_000), 1)!,
            changedMiBPerSecond: rounded(changedBytes / MIB / (wallMs / 1_000), 3)!,
            representedMiBPerSecond: rounded(representedBytes / MIB / (wallMs / 1_000), 3)!,
            cpuUsPerOperation: rounded(cpuUs / operations, 3)!,
            cpuUtilizationPct: rounded(cpuUs / (wallMs * 1_000) * 100, 1)!,
            loopMeanMs: rounded(runtime.loopMeanMs),
            loopP95Ms: rounded(runtime.loopP95Ms),
            loopMaxMs: rounded(runtime.loopMaxMs),
            gcCount: runtime.gcCount,
            gcMs: rounded(runtime.gcMs, 3)!,
            heapDeltaMiB: rounded((endMemory.heapUsed - startMemory.heapUsed) / MIB, 3)!,
            peakHeapDeltaMiB: rounded((runtime.peakHeap - startMemory.heapUsed) / MIB, 3)!,
            rssDeltaMiB: rounded((endMemory.rss - startMemory.rss) / MIB, 3)!,
            peakRssDeltaMiB: rounded((runtime.peakRss - startMemory.rss) / MIB, 3)!,
            retainedHeapDeltaMiB: rounded((retainedMemory.heapUsed - startMemory.heapUsed) / MIB, 3)!,
            retainedRssDeltaMiB: rounded((retainedMemory.rss - startMemory.rss) / MIB, 3)!,
            pipeline: resource.metrics(),
            wire: wire == undefined ? undefined : {
                ...wire,
                wsBytesPerOperation: rounded((wire.c2s.wsBytes + wire.s2c.wsBytes) / operations, 3)!,
                tcpBytesPerOperation: rounded((wire.c2s.tcpBytes + wire.s2c.tcpBytes) / operations, 3)!,
                wsProtocolAmplification: rounded(
                    (wire.c2s.wsBytes + wire.s2c.wsBytes) / representedBytes, 4,
                )!,
                tcpProtocolAmplification: rounded(
                    (wire.c2s.tcpBytes + wire.s2c.tcpBytes) / representedBytes, 4,
                )!,
                wsEndToEndAmplification: rounded(
                    (wire.c2s.wsBytes + wire.s2c.wsBytes) / changedBytes, 4,
                )!,
                tcpEndToEndAmplification: rounded(
                    (wire.c2s.tcpBytes + wire.s2c.tcpBytes) / changedBytes, 4,
                )!,
                framingBytes: wire.c2s.tcpBytes + wire.s2c.tcpBytes - wire.c2s.wsBytes - wire.s2c.wsBytes,
            },
        }
        console.log(UNIT_MARKER + ' ' + JSON.stringify(measurement))
    } finally {
        await resource.close()
    }
}

// =====================================================================
// Orchestrator — randomized order, fresh process per sample
// =====================================================================

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

function benchFilePath() {
    const argvPath = process.argv[1] ?? ''
    if (argvPath.endsWith('bench.ts')) return resolvePath(argvPath)
    return resolvePath(process.cwd(), 'experiments/store-sync-load-2026-07/bench.ts')
}

function spawnUnit(candidate: tCandidateName, targetMiB: number) {
    return new Promise<tMeasurement>(function runChild(resolve, reject) {
        const child = spawn(process.execPath, ['--expose-gc', '--import', 'tsx', benchFilePath()], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                STORE_LOAD_UNIT: candidate,
                STORE_LOAD_TARGET_MIB: String(targetMiB),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        let err = ''
        child.stdout.on('data', function collectOut(chunk) {
            out += chunk
        })
        child.stderr.on('data', function collectErr(chunk) {
            err += chunk
        })
        child.once('error', reject)
        child.once('close', function childClosed(code) {
            const line = out.split(/\r?\n/).find(item => item.startsWith(UNIT_MARKER))
            if (code != 0 || !line) {
                reject(new Error('unit ' + candidate + '/' + targetMiB + ' MiB failed (code ' + code + ')\n'
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

type tSample = {
    run: number
    order: number
    measurement: tMeasurement
}

function metricValues(samples: tSample[], read: (measurement: tMeasurement) => number | undefined) {
    return samples.map(sample => read(sample.measurement)).filter(function isNumber(value): value is number {
        return typeof value == 'number' && Number.isFinite(value)
    })
}

function formatSpread(values: number[], digits = 3) {
    if (values.length == 0) return '—'
    const middle = rounded(median(values), digits)
    const min = rounded(Math.min(...values), digits)
    const max = rounded(Math.max(...values), digits)
    return min == max ? String(middle) : middle + ' [' + min + '…' + max + ']'
}

function aggregateTarget(targetMiB: number, samples: tSample[]) {
    const targetSamples = samples.filter(sample => sample.measurement.targetMiB == targetMiB)
    return CANDIDATE_NAMES.flatMap(function summarizeCandidate(candidate) {
        const list = targetSamples.filter(sample => sample.measurement.candidate == candidate)
        if (list.length == 0) return []
        return [{
            candidate,
            'wall ms': formatSpread(metricValues(list, value => value.wallMs), 1),
            'ops/s': formatSpread(metricValues(list, value => value.operationsPerSecond), 0),
            'changed MiB/s': formatSpread(metricValues(list, value => value.changedMiBPerSecond), 2),
            'represented MiB/s': formatSpread(metricValues(list, value => value.representedMiBPerSecond), 2),
            'CPU µs/op': formatSpread(metricValues(list, value => value.cpuUsPerOperation), 2),
            'CPU %': formatSpread(metricValues(list, value => value.cpuUtilizationPct), 1),
            'loop p95 ms': formatSpread(metricValues(list, value => value.loopP95Ms), 2),
            'GC ms': formatSpread(metricValues(list, value => value.gcMs), 2),
            'peak heap MiB': formatSpread(metricValues(list, value => value.peakHeapDeltaMiB), 2),
            'peak RSS MiB': formatSpread(metricValues(list, value => value.peakRssDeltaMiB), 2),
            'retained heap MiB': formatSpread(metricValues(list, value => value.retainedHeapDeltaMiB), 2),
            'retained RSS MiB': formatSpread(metricValues(list, value => value.retainedRssDeltaMiB), 2),
        }]
    })
}

function aggregatePipeline(targetMiB: number, samples: tSample[]) {
    const targetSamples = samples.filter(sample => sample.measurement.targetMiB == targetMiB)
    return CANDIDATE_NAMES.flatMap(function summarizePipeline(candidate) {
        const list = targetSamples.filter(sample => sample.measurement.candidate == candidate)
        if (list.length == 0 || candidate == 'plain-array') return []
        return [{
            candidate,
            sourceBatches: formatSpread(metricValues(list, value => value.pipeline.sourceBatches), 0),
            sourcePatches: formatSpread(metricValues(list, value => value.pipeline.sourcePatches), 0),
            replayBatches: formatSpread(metricValues(list, value => value.pipeline.emittedBatches), 0),
            'replay estimated MiB': formatSpread(
                metricValues(list, value => value.pipeline.estimatedBytes / MIB), 2,
            ),
            appliedBatches: formatSpread(metricValues(list, value => value.pipeline.appliedBatches), 0),
            appliedPatches: formatSpread(metricValues(list, value => value.pipeline.appliedPatches), 0),
        }]
    })
}

function aggregateWire(targetMiB: number, samples: tSample[]) {
    const list = samples.filter(sample =>
        sample.measurement.targetMiB == targetMiB && sample.measurement.wire != undefined)
    if (list.length == 0) return []
    return [{
        candidate: 'store-replay-socket',
        's2c frames': formatSpread(metricValues(list, value => value.wire?.s2c.frames), 0),
        's2c RPC emits': formatSpread(metricValues(list, value => value.wire?.s2c.rpcEmits), 0),
        'WS B/op': formatSpread(metricValues(list, value => value.wire?.wsBytesPerOperation), 2),
        'TCP B/op': formatSpread(metricValues(list, value => value.wire?.tcpBytesPerOperation), 2),
        'WS/patch payload': formatSpread(
            metricValues(list, value => value.wire?.wsProtocolAmplification), 3,
        ),
        'TCP/patch payload': formatSpread(
            metricValues(list, value => value.wire?.tcpProtocolAmplification), 3,
        ),
        'WS/changed payload': formatSpread(
            metricValues(list, value => value.wire?.wsEndToEndAmplification), 2,
        ),
        'TCP/changed payload': formatSpread(
            metricValues(list, value => value.wire?.tcpEndToEndAmplification), 2,
        ),
        'framing bytes': formatSpread(metricValues(list, value => value.wire?.framingBytes), 0),
    }]
}

function environmentBlock(candidates: readonly tCandidateName[]) {
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
            targetsMiB: TARGETS_MIB,
            candidates,
            arrayLength: ARRAY_LENGTH,
            payloadBytesPerOperation: PAYLOAD_BYTES,
            sourceBatchSize: SOURCE_BATCH_SIZE,
            warmupMiB: rounded(warmupOperationCount() * PAYLOAD_BYTES / MIB, 3),
        },
    }
}

function warmupOperationCount() {
    return Math.max(ARRAY_LENGTH, Math.ceil(WARMUP_MIB * MIB / PAYLOAD_BYTES))
}

function selectedCandidates() {
    if (CANDIDATE_FILTER.length == 0) return CANDIDATE_NAMES.slice()
    const unknown = CANDIDATE_FILTER.filter(name => !CANDIDATE_NAMES.includes(name as tCandidateName))
    if (unknown.length) throw new Error('unknown STORE_LOAD_CANDIDATE: ' + unknown.join(', '))
    return CANDIDATE_NAMES.filter(name => CANDIDATE_FILTER.includes(name))
}

async function runOrchestrator() {
    const candidates = selectedCandidates()
    console.log('Store synchronization load experiment — July 2026')
    console.log(JSON.stringify(environmentBlock(candidates), null, 2))

    const samples: tSample[] = []
    const orders: {run: number, targetMiB: number, candidates: tCandidateName[]}[] = []
    let orderIndex = 0

    for (let run = 1; run <= RUNS; run++) {
        for (const [targetIndex, targetMiB] of TARGETS_MIB.entries()) {
            const random = createRandom(SEED + run * 7_919 + targetIndex * 104_729)
            const order = shuffled(candidates, random)
            orders.push({run, targetMiB, candidates: order})
            for (const candidate of order) {
                process.stdout.write('  run ' + run + '  ' + targetMiB + ' MiB / ' + candidate + ' … ')
                const started = performance.now()
                const measurement = await spawnUnit(candidate, targetMiB)
                samples.push({run, order: orderIndex++, measurement})
                console.log(Math.round(performance.now() - started) + ' ms')
            }
        }
    }

    console.log('\nCandidate order')
    console.table(orders)
    for (const targetMiB of TARGETS_MIB) {
        console.log('\n' + targetMiB + ' MiB — median [min…max] over ' + RUNS + ' runs')
        console.table(aggregateTarget(targetMiB, samples))
        console.log('\n' + targetMiB + ' MiB — patch pipeline')
        console.table(aggregatePipeline(targetMiB, samples))
        const wire = aggregateWire(targetMiB, samples)
        if (wire.length) {
            console.log('\n' + targetMiB + ' MiB — exact live transport')
            console.table(wire)
        }
    }

    console.log('\n' + RESULT_MARKER)
    console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        environment: environmentBlock(candidates),
        candidateOrders: orders,
        samples: samples.map(sample => ({
            run: sample.run,
            order: sample.order,
            ...sample.measurement,
        })),
    }))
}

async function main() {
    if (UNIT != '') await runUnitInProcess()
    else await runOrchestrator()
}

main().catch(function reportStoreLoadFailure(error) {
    console.error(error)
    process.exit(1)
})
