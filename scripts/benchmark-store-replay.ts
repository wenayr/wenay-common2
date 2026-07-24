// Reproducible Store Replay diagnostic: RPC payloads over real Socket.IO + recovery + codec CPU.

import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {performance} from 'node:perf_hooks'
import {deflateRawSync} from 'node:zlib'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen} from '../src/Common/events/Listen'
import {mapListen} from '../src/Common/events/mapListen'
import {ListenReplayApi, ReplayEvent} from '../src/Common/events/replay-listen'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import type {RpcOpt} from '../src/Common/rcp/rpc-caps'
import {
    inspectRpcBinaryEnvelope,
    RPC_BINARY_PROTOCOL_VERSION,
    RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
} from '../src/Common/rcp/rpc-binary-envelope'
import {createRpcBinaryPeer} from '../src/Common/rcp/rpc-binary-peer'
import {RPC_BINARY_MAX_SHAPES} from '../src/Common/rcp/rpc-caps'
import {Pkt} from '../src/Common/rcp/rpc-protocol'
import {rpcResultWireMetrics} from '../src/Common/rcp/rpc-wire-size'
import {packResult} from '../src/Common/rcp/rpc-walk'
import {applyStorePatches, createStore, StorePatch} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {
    exposeStoreReplay, StoreReplayBatchRemote, StoreReplayRemote, syncStoreReplay,
} from '../src/Common/Observe/store-replay'
import {createReplicatedMap} from '../src/Common/Observe/replicated-map'
import {
    decodeStoreReplayBatch,
    decodeStoreReplayBatchV2,
    decodeStoreReplayBatchV3,
    decodeStoreReplayBatchV4,
    decodeStoreReplayBatchV5,
    encodeStoreReplayBatch,
    encodeStoreReplayBatchV2,
    encodeStoreReplayBatchV3,
    encodeStoreReplayBatchV4,
    encodeStoreReplayBatchV5,
    storeReplayBatchJsonBytes,
    storeReplayBatchV2JsonBytes,
    storeReplayBatchV3JsonBytes,
    storeReplayBatchV4WireBytes,
    storeReplayBatchV5WireBytes,
} from '../src/Common/Observe/store-replay-codec'

type Quotes = Record<string, {c: number, t: number}>
type SparseQuote = {
    s: string
    c: number
    t: number
    v: number
    active: boolean
    venue: string
}
type SparseQuotes = Record<string, SparseQuote>
const STORE_MODES = [
    'store-v1',
    'store-v2',
    'store-v3',
    'store-v4',
    'store-v5',
    'store-v6',
] as const
type tStoreMode = typeof STORE_MODES[number]
type tMode =
    | 'plain-legacy'
    | 'compact-per-patch'
    | 'per-patch'
    | 'callback-batch'
    | tStoreMode
type tTransport = 'raw' | 'rpb-v1' | 'rpb-v2'
type tRpcVersion = 0
    | typeof RPC_BINARY_PROTOCOL_VERSION
    | typeof RPC_BINARY_SCHEMA_PROTOCOL_VERSION
type tRoute = {
    name: string
    mode: tMode
    transport: tTransport
    rpcVersion: tRpcVersion
    opt: RpcOpt
}
type BenchmarkApi = {
    replay: StoreReplayRemote
    debug: {setPending(value: number): void}
}

const CALLBACK_BATCH_ITEMS = 64
const STORE_BATCH_ITEMS = 256
const WIRE_TARGET_BYTES = 64 * 1024
const SPARSE_STORE_KEYS = 500
const SPARSE_WAVES = [
    {name: 'first-20', indexes: Array.from({length: 20}, (_, index) => index)},
    {name: 'random-40', indexes: seededSparseIndexes(40, 0x4a17c9e3)},
    {name: 'random-50', indexes: seededSparseIndexes(50, 0x91e10da5)},
] as const
const SPARSE_PATCHES = SPARSE_WAVES.reduce((total, wave) => total + wave.indexes.length, 0)
const sizes = benchmarkSizes()

function benchmarkProfile() {
    const cliProfile = process.argv.find(value => value.startsWith('--profile='))?.slice('--profile='.length)
    const profile = cliProfile ?? process.env['STORE_REPLAY_BENCH_PROFILE'] ?? 'full'
    if (profile != 'full' && profile != 'sparse' && profile != 'socket-parser') {
        throw new RangeError('STORE_REPLAY_BENCH_PROFILE must be full, sparse, or socket-parser')
    }
    return profile
}

function sparseBenchmarkRounds() {
    const source = process.env['STORE_REPLAY_SPARSE_ROUNDS']
    if (source == undefined || source.trim() == '') return 200
    const rounds = Number(source)
    if (!Number.isSafeInteger(rounds) || rounds <= 0) {
        throw new RangeError('STORE_REPLAY_SPARSE_ROUNDS must be a positive integer')
    }
    return rounds
}

function seededSparseIndexes(count: number, seed: number) {
    let state = seed >>> 0
    const selected = new Set<number>()
    while (selected.size < count) {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        selected.add((state >>> 0) % SPARSE_STORE_KEYS)
    }
    return [...selected]
}

function benchmarkSizes() {
    const source = process.env['STORE_REPLAY_BENCH_SIZES']
    if (source == undefined || source.trim() == '') return [50, 700]
    const values = source.split(',').map(function parseBenchmarkSize(value) {
        return Number(value.trim())
    })
    if (values.length == 0 || values.some(value => !Number.isSafeInteger(value) || value <= 0)) {
        throw new RangeError('STORE_REPLAY_BENCH_SIZES must be comma-separated positive integers')
    }
    if (new Set(values).size != values.length) {
        throw new RangeError('STORE_REPLAY_BENCH_SIZES must not contain duplicates')
    }
    return values
}

function encodeStoreReplayBatchV6(event: ReplayEvent<[readonly StorePatch[]]>) {
    return event
}

function decodeStoreReplayBatchV6(event: ReplayEvent<[StorePatch[]]>) {
    return event
}

const storeCodec = {
    'store-v1': {
        generation: 1,
        encode: encodeStoreReplayBatch,
        decode: decodeStoreReplayBatch,
    },
    'store-v2': {
        generation: 2,
        encode: encodeStoreReplayBatchV2,
        decode: decodeStoreReplayBatchV2,
    },
    'store-v3': {
        generation: 3,
        encode: encodeStoreReplayBatchV3,
        decode: decodeStoreReplayBatchV3,
    },
    'store-v4': {
        generation: 4,
        encode: encodeStoreReplayBatchV4,
        decode: decodeStoreReplayBatchV4,
    },
    'store-v5': {
        generation: 5,
        encode: encodeStoreReplayBatchV5,
        decode: decodeStoreReplayBatchV5,
    },
    'store-v6': {
        generation: 6,
        encode: encodeStoreReplayBatchV6,
        decode: decodeStoreReplayBatchV6,
    },
} as const

function storeRoutes(mode: tStoreMode): tRoute[] {
    return [
        {
            name: mode + '-raw',
            mode,
            transport: 'raw',
            rpcVersion: 0,
            opt: {
                compact: false,
                callbackBatch: {maxItems: CALLBACK_BATCH_ITEMS, maxBytes: WIRE_TARGET_BYTES},
                binary: false,
            },
        },
        {
            name: mode + '-rpb-v1',
            mode,
            transport: 'rpb-v1',
            rpcVersion: RPC_BINARY_PROTOCOL_VERSION,
            opt: {
                compact: false,
                callbackBatch: {maxItems: CALLBACK_BATCH_ITEMS, maxBytes: WIRE_TARGET_BYTES},
                binary: {schema: false},
            },
        },
        {
            name: mode + '-rpb-v2',
            mode,
            transport: 'rpb-v2',
            rpcVersion: RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
            opt: {
                compact: false,
                callbackBatch: {maxItems: CALLBACK_BATCH_ITEMS, maxBytes: WIRE_TARGET_BYTES},
                binary: {schema: true},
            },
        },
    ]
}

const routes = [
    {
        name: 'plain-legacy',
        mode: 'plain-legacy',
        transport: 'raw',
        rpcVersion: 0,
        opt: {compact: false, callbackBatch: false, binary: false},
    },
    {
        name: 'compact-per-patch',
        mode: 'compact-per-patch',
        transport: 'raw',
        rpcVersion: 0,
        opt: {compact: true, callbackBatch: false, binary: false},
    },
    {
        name: 'callback-batch',
        mode: 'callback-batch',
        transport: 'raw',
        rpcVersion: 0,
        opt: {
            compact: true,
            callbackBatch: {maxItems: CALLBACK_BATCH_ITEMS, maxBytes: WIRE_TARGET_BYTES},
            binary: false,
        },
    },
    {
        name: 'per-patch-rpb-v1',
        mode: 'per-patch',
        transport: 'rpb-v1',
        rpcVersion: RPC_BINARY_PROTOCOL_VERSION,
        opt: {compact: false, callbackBatch: false, binary: {schema: false}},
    },
    {
        name: 'per-patch-rpb-v2',
        mode: 'per-patch',
        transport: 'rpb-v2',
        rpcVersion: RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
        opt: {compact: false, callbackBatch: false, binary: {schema: true}},
    },
    {
        name: 'callback-batch-rpb-v1',
        mode: 'callback-batch',
        transport: 'rpb-v1',
        rpcVersion: RPC_BINARY_PROTOCOL_VERSION,
        opt: {
            compact: false,
            callbackBatch: {maxItems: CALLBACK_BATCH_ITEMS, maxBytes: WIRE_TARGET_BYTES},
            binary: {schema: false},
        },
    },
    {
        name: 'callback-batch-rpb-v2',
        mode: 'callback-batch',
        transport: 'rpb-v2',
        rpcVersion: RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
        opt: {
            compact: false,
            callbackBatch: {maxItems: CALLBACK_BATCH_ITEMS, maxBytes: WIRE_TARGET_BYTES},
            binary: {schema: true},
        },
    },
    ...STORE_MODES.flatMap(storeRoutes),
] as const satisfies readonly tRoute[]
const utf8Encoder = new TextEncoder()

function delay(ms: number) {
    return new Promise<void>(function waitDelay(resolve) { setTimeout(resolve, ms) })
}

async function waitFor(label: string, condition: () => boolean) {
    for (let i = 0; i < 500; i++) {
        if (condition()) return
        await delay(5)
    }
    throw new Error('benchmark timeout: ' + label)
}

function check(condition: unknown, message: string) {
    if (!condition) throw new Error('benchmark assertion failed: ' + message)
}

function snapshotEqual(left: unknown, right: unknown) {
    return JSON.stringify(left) == JSON.stringify(right)
}

function isStoreMode(mode: tMode) {
    return mode in storeCodec
}

function asStoreMode(mode: tMode) {
    return mode as tStoreMode
}

function nativeBinaryBytes(value: unknown): number {
    if (ArrayBuffer.isView(value)) return value.byteLength
    if (value instanceof ArrayBuffer) return value.byteLength
    if (value instanceof Map) {
        let bytes = 0
        for (const [key, item] of value) bytes += nativeBinaryBytes(key) + nativeBinaryBytes(item)
        return bytes
    }
    if (value instanceof Set) {
        let bytes = 0
        for (const item of value) bytes += nativeBinaryBytes(item)
        return bytes
    }
    if (value == null || typeof value != 'object') return 0
    let bytes = 0
    for (const key of Object.keys(value)) bytes += nativeBinaryBytes((value as Record<string, unknown>)[key])
    return bytes
}

function packetWireBytes(value: unknown) {
    const measured = rpcResultWireMetrics(value)
    const binaryBytes = nativeBinaryBytes(value)
    return {
        headerBytes: measured.byteLength - binaryBytes,
        binaryBytes,
        totalBytes: measured.byteLength,
        attachments: measured.binaryCount,
    }
}

function packedJson(value: unknown) {
    return utf8Encoder.encode(JSON.stringify(packResult(value)))
}

function deflatePackedJsonBytes(value: unknown) {
    return deflateRawSync(packedJson(value)).byteLength
}

function createBenchmarkHub(deps: {port: number, opt: RpcOpt}) {
    function createSocket() {
        return io('http://127.0.0.1:' + deps.port, {transports: ['websocket'], forceNew: true})
    }
    return createRpcClientHub(
        createSocket,
        function buildSchema(remote) { return {api: remote<BenchmarkApi>('store-benchmark')} as const },
        {opt: deps.opt},
    )
}

function createBatchFrameLine<W>(deps: {
    replay: ListenReplayApi<[readonly StorePatch[]]>
    pending: () => number
    encode: (event: ReplayEvent<[readonly StorePatch[]]>) => W
    onSubscribe?: () => void
}) {
    const {replay, pending, encode, onSubscribe} = deps
    const [emit, rawLine] = listen<[ReplayEvent<[readonly StorePatch[]]>]>()
    const [, line] = mapListen(rawLine, function encodeFrameEvent(event) {
        return [encode(event)]
    })
    let lastSent = replay.head()
    let gated = false
    let timer: any = null
    let closed = false

    function stopPoll() {
        if (timer) { clearInterval(timer); timer = null }
    }

    function recoverIfDrained() {
        if (!gated || closed || pending() > 0) return
        gated = false
        stopPoll()
        for (const event of replay.frame(lastSent)) {
            lastSent = Math.max(lastSent, event.seq)
            emit(event)
        }
    }

    function startPoll() {
        if (timer || closed) return
        timer = setInterval(recoverIfDrained, 2)
        timer.unref?.()
    }

    const offReplay = replay.line.on(function gateBatchEvent(event) {
        if (closed) return
        if (!gated && pending() > 1) {
            gated = true
            startPoll()
        }
        if (gated) {
            recoverIfDrained()
            return
        }
        lastSent = event.seq
        emit(event)
    })

    function close() {
        if (closed) return
        closed = true
        stopPoll()
        offReplay()
        rawLine.close()
    }

    function subscribeFrameLine(cb: Parameters<typeof line.on>[0]) {
        onSubscribe?.()
        return line.on(cb)
    }

    return {line: {...line, on: subscribeFrameLine}, close}
}

function limitBatchGeneration(
    batch: StoreReplayBatchRemote,
    mode: tStoreMode,
    frameLine: any,
): StoreReplayBatchRemote {
    const {v2, v3, v4, v5, v6, ...v1} = batch
    if (mode == 'store-v1') {
        return {...v1, frameLine}
    }
    if (mode == 'store-v2') {
        return {...v1, v2: {...v2!, frameLine}}
    }
    if (mode == 'store-v3') {
        return {...v1, v2, v3: {...v3!, frameLine}}
    }
    if (mode == 'store-v4') {
        return {...v1, v2, v3, v4: {...v4!, frameLine}}
    }
    if (mode == 'store-v5') {
        return {...v1, v2, v3, v4, v5: {...v5!, frameLine}}
    }
    return {...v1, v2, v3, v4, v5, v6: {...v6!, frameLine}}
}

async function measureSocket(items: number, route: tRoute) {
    const {mode} = route
    const source = createStore<Quotes>({}, {drain: 'micro'})
    const exposed = exposeStoreReplay(source, {
        history: Math.max(1024, items * 2),
        batch: {maxItems: STORE_BATCH_ITEMS, maxBytes: WIRE_TARGET_BYTES},
    })
    const httpServer = createServer()
    const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})
    let armed = false
    let socketEmits = 0
    let binaryAttachments = 0
    let headerBytes = 0
    let binaryBytes = 0
    let logicalEvents = 0
    let frameLineSubscriptions = 0
    const selectedStoreGenerations: number[] = []
    const rpcProtocolVersions = new Set<number>()
    let maxBatchLatencyMs = 0
    let latencyError = ''
    const emittedAt: number[] = []
    const offLegacy = exposed.replay.line.on(function markLegacyEmission() {
        if (armed && !isStoreMode(mode)) emittedAt.push(performance.now())
    })
    const offBatch = exposed.replayBatch!.line.on(function markBatchEmission() {
        if (armed && isStoreMode(mode)) emittedAt.push(performance.now())
    })

    ioServer.on('connection', function serveConnection(socket) {
        const [disconnect, disconnectListen] = listen<[]>()
        let pending = 0
        const selectedMode = isStoreMode(mode) ? asStoreMode(mode) : undefined
        const batchFrame = selectedMode
            ? createBatchFrameLine({
                replay: exposed.replayBatch!,
                pending: () => pending,
                encode: storeCodec[selectedMode].encode,
                onSubscribe() {
                    frameLineSubscriptions++
                    selectedStoreGenerations.push(storeCodec[selectedMode].generation)
                },
            })
            : undefined
        let replay: typeof exposed.replay | StoreReplayRemote = exposed.replay
        if (selectedMode) {
            replay = {
                ...exposed.api.replay,
                batch: limitBatchGeneration(exposed.api.replay.batch!, selectedMode, batchFrame!.line),
            }
        }
        socket.on('disconnect', function closeConnection() {
            batchFrame?.close()
            disconnect()
        })
        createRpcServerAuto({
            socket: {
                emit(key, data) {
                    if (armed && key == 'store-benchmark') {
                        const measured = packetWireBytes(data)
                        const binaryEnvelope = inspectRpcBinaryEnvelope(data)
                        socketEmits++
                        binaryAttachments += measured.attachments
                        headerBytes += measured.headerBytes
                        binaryBytes += measured.binaryBytes
                        if (binaryEnvelope) rpcProtocolVersions.add(binaryEnvelope.version)
                    }
                    socket.emit(key, data)
                },
                on: (key, cb) => socket.on(key, cb),
            },
            socketKey: 'store-benchmark',
            object: {
                replay,
                debug: {setPending(value: number) { pending = value }},
            },
            disconnectListen,
            opt: route.opt,
            replayOpts: {pending: () => pending, highWater: 1, lowWater: 0, pollMs: 2},
        })
    })
    await new Promise<void>(function start(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    const port = (httpServer.address() as AddressInfo).port
    const hub = createBenchmarkHub({port, opt: route.opt})
    let reconnectHub: ReturnType<typeof createBenchmarkHub> | undefined

    try {
        const client = await hub.setToken(null)
        await client.api.readyStrict()
        const mirror = createStore<Quotes>({}, {drain: 'micro'})
        const sub = syncStoreReplay(mirror, client.api.func.replay, {
            batch: isStoreMode(mode),
            policy: 'frame',
            onBatch() {
                if (!armed) return
                logicalEvents++
                const sentAt = emittedAt.shift()
                if (sentAt == null) {
                    latencyError = 'client received a logical event without a matching server emission'
                    return
                }
                maxBatchLatencyMs = Math.max(maxBatchLatencyMs, performance.now() - sentAt)
            },
        })
        await sub.ready
        const actualMode = sub.mode
        armed = true
        const started = performance.now()
        for (let i = 0; i < items; i++) source.state['S' + i] = {c: i + 0.5, t: 1_000_000 + i}
        await flushReactive(source.state)
        await waitFor(String(items) + ' quotes', () => Object.keys(mirror.state).length == items)
        await flushReactive(mirror.state)
        await delay(5)
        const totalLatencyMs = performance.now() - started
        armed = false

        const converged = snapshotEqual(source.snapshot(), mirror.snapshot())
        let journalBytes = 0
        let journalEvents = 0
        if (isStoreMode(mode)) {
            const selectedMode = asStoreMode(mode)
            const journal = exposed.replayBatch!.getSince(0) ?? []
            const wire = journal.map(function encodeJournalEvent(event) {
                return storeCodec[selectedMode].encode(event)
            })
            journalBytes = packetWireBytes(wire).totalBytes
            journalEvents = journal.length
        } else {
            const journal = exposed.replay.getSince(0) ?? []
            journalBytes = packetWireBytes(journal).totalBytes
            journalEvents = journal.length
        }
        const pendingLatencies = emittedAt.length

        // A real frame subscriber is stalled for two intersecting drain windows.
        const valueBeforeFrame = mirror.state['S0'].c
        await client.api.func.debug.setPending(100)
        source.state['S0'] = {c: 10_000 + items, t: 2_000_001}
        source.state['FRAME_ETH'] = {c: 20_001, t: 2_000_001}
        await flushReactive(source.state)
        source.state['S0'] = {c: 30_000 + items, t: 2_000_002}
        source.state['FRAME_SOL'] = {c: 20_002, t: 2_000_002}
        await flushReactive(source.state)
        await delay(20)
        const frameHeld = mirror.state['S0'].c == valueBeforeFrame
            && !Object.prototype.hasOwnProperty.call(mirror.state, 'FRAME_ETH')
            && !Object.prototype.hasOwnProperty.call(mirror.state, 'FRAME_SOL')
        await client.api.func.debug.setPending(0)
        await waitFor('frame recovery ' + items + '/' + route.name, function frameRecovered() {
            return mirror.state['S0']?.c == 30_000 + items
                && mirror.state['FRAME_ETH']?.c == 20_001
                && mirror.state['FRAME_SOL']?.c == 20_002
        })
        const frameSnapshotConverged = snapshotEqual(source.snapshot(), mirror.snapshot())
        const frameConverged = frameHeld && frameSnapshotConverged

        // Preserve the selected coordinate space across a fresh transport connection.
        const since = sub.seq()
        sub()
        hub.socket?.disconnect?.()
        await delay(10)
        source.state['S0'] = {c: 40_000 + items, t: 3_000_001}
        source.state['RECONNECT'] = {c: 40_001, t: 3_000_001}
        await flushReactive(source.state)

        reconnectHub = createBenchmarkHub({port, opt: route.opt})
        const reconnectClient = await reconnectHub.setToken(null)
        await reconnectClient.api.readyStrict()
        const reconnectSub = syncStoreReplay(mirror, reconnectClient.api.func.replay, {
            batch: isStoreMode(mode),
            policy: 'frame',
            since,
        })
        await reconnectSub.ready
        const reconnectMode = reconnectSub.mode
        const reconnectConverged = snapshotEqual(source.snapshot(), mirror.snapshot())
        reconnectSub()

        check(!latencyError, latencyError)
        const routeLabel = items + '/' + route.name
        check(pendingLatencies == 0, routeLabel + ' has unmatched latency samples')
        check(actualMode == (isStoreMode(mode) ? 'batch' : 'legacy'), routeLabel + ' selected wrong mode')
        check(reconnectMode == actualMode, routeLabel + ' changed coordinates on reconnect')
        check(converged, routeLabel + ' initial mirror did not converge')
        check(frameHeld, routeLabel + ' slow client was not held behind the frame gate')
        check(frameSnapshotConverged, routeLabel + ' frame recovery snapshot differs')
        check(reconnectConverged, routeLabel + ' reconnect did not converge')
        check(socketEmits > 0 && headerBytes > 0, routeLabel + ' did not measure outbound RPC payloads')
        if (route.rpcVersion != 0) {
            check(binaryAttachments == socketEmits && binaryBytes > 0,
                routeLabel + ' did not use one outer binary attachment per emit')
            check(
                rpcProtocolVersions.size == 1 && rpcProtocolVersions.has(route.rpcVersion),
                routeLabel + ' did not use the requested RPB protocol v' + route.rpcVersion,
            )
        } else if (mode == 'store-v5') {
            check(binaryAttachments > 0 && binaryBytes > 0, routeLabel + ' did not use the Store v5 attachment')
            check(rpcProtocolVersions.size == 0, routeLabel + ' unexpectedly used an outer RPB envelope')
        } else {
            check(binaryAttachments == 0 && binaryBytes == 0,
                routeLabel + ' quote workload unexpectedly used binary attachments')
            check(rpcProtocolVersions.size == 0, routeLabel + ' unexpectedly used an outer RPB envelope')
        }
        if (isStoreMode(mode)) {
            const expectedGeneration = storeCodec[asStoreMode(mode)].generation
            check(frameLineSubscriptions >= 2, routeLabel + ' did not bind the selected frame line on reconnect')
            check(
                selectedStoreGenerations.every(generation => generation == expectedGeneration),
                routeLabel + ' selected another Store generation',
            )
        }
        check(logicalEvents == journalEvents, routeLabel + ' delivered/journal event count differs')
        check(Number.isFinite(maxBatchLatencyMs), routeLabel + ' batch latency is invalid')

        return {
            items,
            route: route.name,
            transport: route.transport,
            rpcVersion: rpcProtocolVersions.values().next().value ?? 0,
            mode,
            codec: selectedStoreGenerations[0] ?? 0,
            inputArrays: 1,
            writes: items,
            logicalEvents,
            socketEmits,
            binaryAttachments,
            enginePackets: socketEmits + binaryAttachments,
            headerBytes,
            binaryBytes,
            wireBytes: headerBytes + binaryBytes,
            totalLatencyMs,
            maxBatchLatencyMs,
            journalEvents,
            journalBytes,
            frameLineSubscriptions,
            frameConverged,
            reconnectConverged,
        }
    } finally {
        hub.socket?.disconnect?.()
        reconnectHub?.socket?.disconnect?.()
        await delay(5)
        offLegacy()
        offBatch()
        exposed.close()
        await new Promise<void>(function closeBenchmarkServers(resolve) {
            ioServer.close()
            httpServer.close(function benchmarkServerClosed() { resolve() })
        })
    }
}

function measureUs(rounds: number, run: () => void) {
    const started = performance.now()
    for (let index = 0; index < rounds; index++) run()
    return (performance.now() - started) * 1000 / rounds
}

function measureStableUs(rounds: number, run: () => void) {
    for (let window = 0; window < 2; window++) measureUs(rounds, run)
    const samples = new Array<number>(7)
    for (let window = 0; window < samples.length; window++) {
        samples[window] = measureUs(rounds, run)
    }
    samples.sort((left, right) => left - right)
    return samples[Math.floor(samples.length / 2)]
}

function percentFrom(value: number, baseline: number) {
    return ((value / baseline - 1) * 100).toFixed(1) + '%'
}

type tOuterProtocol =
    | typeof RPC_BINARY_PROTOCOL_VERSION
    | typeof RPC_BINARY_SCHEMA_PROTOCOL_VERSION

function asBenchmarkStoreCodec(mode: tStoreMode) {
    return storeCodec[mode] as {
        encode(event: ReplayEvent<[StorePatch[]]>): any
        decode(value: any): ReplayEvent<[StorePatch[]]>
    }
}

function createOuterCodecPair(protocolVersion: tOuterProtocol) {
    const sender = createRpcBinaryPeer({
        sessionId: 1,
        maxShapes: RPC_BINARY_MAX_SHAPES,
        protocolVersion,
    })
    const receiver = createRpcBinaryPeer({
        sessionId: 1,
        maxShapes: RPC_BINARY_MAX_SHAPES,
        protocolVersion,
    })
    const prelude = sender.encodePrelude()
    receiver.decodePrelude(prelude)
    return {sender, receiver, preludeBytes: prelude.byteLength}
}

function encodeOuterPacket(
    peer: ReturnType<typeof createRpcBinaryPeer>,
    packet: any[],
) {
    const prepared = peer.prepare(packet)
    prepared.commit()
    return prepared.wire
}

function decodeOuterPacket(
    peer: ReturnType<typeof createRpcBinaryPeer>,
    wire: Uint8Array,
    protocolVersion: tOuterProtocol,
) {
    const envelope = inspectRpcBinaryEnvelope(wire)
    check(envelope?.version == protocolVersion, 'outer codec emitted another RPB version')
    return peer.decode(envelope!.payload)
}

function callbackPacket(value: unknown) {
    // This is the exact wrapper emitted for one frameLine callback argument.
    return [Pkt.CB, 1, [value]]
}

function decodedCallbackValue(packet: any[]) {
    check(packet[0] == Pkt.CB, 'outer codec changed callback opcode')
    check(packet[1] == 1, 'outer codec changed callback id')
    check(Array.isArray(packet[2]) && packet[2].length == 1,
        'outer codec changed callback arguments')
    return packet[2][0]
}

function measureFullOuterCodec(
    items: number,
    mode: tStoreMode,
    protocolVersion: tOuterProtocol,
) {
    const patches: StorePatch[] = Array.from({length: items}, function makePatch(_, i) {
        return {path: ['S' + i], exists: true, value: {c: i + 0.5, t: 1_000_000 + i}}
    })
    const event = {seq: 1, ts: 1, event: [patches] as [StorePatch[]]}
    const codec = asBenchmarkStoreCodec(mode)
    const encodedStoreEvent = codec.encode(event)
    const rounds = Math.max(400, Math.floor(200_000 / items))
    const setupRounds = Math.max(100, Math.min(400, rounds))
    const coldRounds = Math.max(100, Math.min(250, rounds))

    const setupUs = measureUs(setupRounds, function createCodecPairRound() {
        createOuterCodecPair(protocolVersion)
    })

    // Fresh peers are allocated before the timer, so cold codec cost does not
    // accidentally include factory/handshake allocation.
    const coldPairs = Array.from({length: coldRounds}, function createColdPair() {
        return createOuterCodecPair(protocolVersion)
    })
    const coldWires: Uint8Array[] = new Array(coldRounds)
    let coldEncodeIndex = 0
    const coldEncodeUs = measureUs(coldRounds, function encodeColdRound() {
        const index = coldEncodeIndex++
        coldWires[index] = encodeOuterPacket(
            coldPairs[index].sender,
            callbackPacket(encodedStoreEvent),
        )
    })
    let coldDecodeIndex = 0
    const coldPackets: any[][] = new Array(coldRounds)
    const coldDecodeUs = measureUs(coldRounds, function decodeColdRound() {
        const index = coldDecodeIndex++
        coldPackets[index] = decodeOuterPacket(
            coldPairs[index].receiver,
            coldWires[index],
            protocolVersion,
        )
    })
    for (const packet of coldPackets) {
        const decoded = codec.decode(decodedCallbackValue(packet))
        check(snapshotEqual(decoded.event[0], patches),
            items + '/' + mode + ' cold outer round-trip changed patches')
    }

    const pair = createOuterCodecPair(protocolVersion)
    const stableSizes: number[] = []
    let stableWire = new Uint8Array()
    for (let index = 0; index < 20; index++) {
        stableWire = encodeOuterPacket(pair.sender, callbackPacket(encodedStoreEvent))
        const packet = decodeOuterPacket(pair.receiver, stableWire, protocolVersion)
        const decoded = codec.decode(decodedCallbackValue(packet))
        check(snapshotEqual(decoded.event[0], patches),
            items + '/' + mode + ' warm-up outer round-trip changed patches')
        if (index >= 16) stableSizes.push(stableWire.byteLength)
    }
    check(stableSizes.every(bytes => bytes == stableSizes[0]),
        items + '/' + mode + ' outer codec size did not stabilize')

    const storeEncodeUs = measureUs(rounds, function encodeStoreRound() {
        codec.encode(event)
    })
    const storeDecodeUs = measureUs(rounds, function decodeStoreRound() {
        codec.decode(encodedStoreEvent)
    })
    const outerEncodeUs = measureUs(rounds, function encodeOuterRound() {
        encodeOuterPacket(pair.sender, callbackPacket(encodedStoreEvent))
    })
    const outerDecodeUs = measureUs(rounds, function decodeOuterRound() {
        decodeOuterPacket(pair.receiver, stableWire, protocolVersion)
    })
    let fullWire = stableWire
    const fullEncodeUs = measureStableUs(rounds, function encodeFullRound() {
        const storeValue = codec.encode(event)
        fullWire = encodeOuterPacket(pair.sender, callbackPacket(storeValue))
    })
    const fullDecodeUs = measureStableUs(rounds, function decodeFullRound() {
        const packet = decodeOuterPacket(pair.receiver, fullWire, protocolVersion)
        codec.decode(decodedCallbackValue(packet))
    })
    const finalPacket = decodeOuterPacket(pair.receiver, fullWire, protocolVersion)
    const finalEvent = codec.decode(decodedCallbackValue(finalPacket))

    check(snapshotEqual(finalEvent.event[0], patches),
        items + '/' + mode + ' full outer round-trip changed patches')
    check(
        [
            setupUs, coldEncodeUs, coldDecodeUs, storeEncodeUs, storeDecodeUs,
            outerEncodeUs, outerDecodeUs, fullEncodeUs, fullDecodeUs,
        ].every(Number.isFinite),
        items + '/' + mode + ' full outer CPU measurement is invalid',
    )

    return {
        items,
        mode,
        rpc: protocolVersion,
        rounds,
        coldRounds,
        preludeBytes: pair.preludeBytes,
        coldBytes: coldWires[0].byteLength,
        warmBytes: stableWire.byteLength,
        setupUs,
        coldEncodeUs,
        coldDecodeUs,
        storeEncodeUs,
        storeDecodeUs,
        outerEncodeUs,
        outerDecodeUs,
        fullEncodeUs,
        fullDecodeUs,
    }
}

function measureCodec(items: number) {
    const patches: StorePatch[] = Array.from({length: items}, function makePatch(_, i) {
        return {path: ['S' + i], exists: true, value: {c: i + 0.5, t: 1_000_000 + i}}
    })
    const event = {seq: 1, ts: 1, event: [patches] as [StorePatch[]]}
    const v1 = encodeStoreReplayBatch(event)
    const v2 = encodeStoreReplayBatchV2(event)
    const v3 = encodeStoreReplayBatchV3(event)
    const v4 = encodeStoreReplayBatchV4(event)
    const v5 = encodeStoreReplayBatchV5(event)
    const decodedV1 = decodeStoreReplayBatch(v1)
    const decodedV2 = decodeStoreReplayBatchV2(v2)
    const decodedV3 = decodeStoreReplayBatchV3(v3)
    const decodedV4 = decodeStoreReplayBatchV4(v4)
    const decodedV5 = decodeStoreReplayBatchV5(v5)
    const rounds = Math.max(400, Math.floor(200_000 / items))

    check(snapshotEqual(decodedV1.event[0], patches), items + ' v1 codec round-trip changed patches')
    check(snapshotEqual(decodedV2.event[0], patches), items + ' v2 codec round-trip changed patches')
    check(snapshotEqual(decodedV3.event[0], patches), items + ' v3 codec round-trip changed patches')
    check(snapshotEqual(decodedV4.event[0], patches), items + ' v4 codec round-trip changed patches')
    check(snapshotEqual(decodedV5.event[0], patches), items + ' v5 codec round-trip changed patches')

    const v1EncodeUs = measureUs(rounds, function encodeV1Round() { encodeStoreReplayBatch(event) })
    const v1DecodeUs = measureUs(rounds, function decodeV1Round() { decodeStoreReplayBatch(v1) })
    const v2EncodeUs = measureUs(rounds, function encodeV2Round() { encodeStoreReplayBatchV2(event) })
    const v2DecodeUs = measureUs(rounds, function decodeV2Round() { decodeStoreReplayBatchV2(v2) })
    const v3EncodeUs = measureUs(rounds, function encodeV3Round() { encodeStoreReplayBatchV3(event) })
    const v3DecodeUs = measureUs(rounds, function decodeV3Round() { decodeStoreReplayBatchV3(v3) })
    const v4EncodeUs = measureUs(rounds, function encodeV4Round() { encodeStoreReplayBatchV4(event) })
    const v4DecodeUs = measureUs(rounds, function decodeV4Round() { decodeStoreReplayBatchV4(v4) })
    const v5EncodeUs = measureUs(rounds, function encodeV5Round() { encodeStoreReplayBatchV5(event) })
    const v5DecodeUs = measureUs(rounds, function decodeV5Round() { decodeStoreReplayBatchV5(v5) })

    const mirror = createStore<Quotes>({})
    const applyUs = measureUs(rounds, function applyRound() { applyStorePatches(mirror, patches) })

    check(Object.keys(mirror.state).length == items, items + ' apply benchmark did not converge')
    check(
        [
            v1EncodeUs, v1DecodeUs, v2EncodeUs, v2DecodeUs, v3EncodeUs, v3DecodeUs,
            v4EncodeUs, v4DecodeUs, v5EncodeUs, v5DecodeUs, applyUs,
        ].every(Number.isFinite),
        items + ' codec CPU measurement is invalid',
    )

    return {
        items,
        rounds,
        v1Bytes: storeReplayBatchJsonBytes(v1),
        v2Bytes: storeReplayBatchV2JsonBytes(v2),
        v3Bytes: storeReplayBatchV3JsonBytes(v3),
        v4Bytes: storeReplayBatchV4WireBytes(v4),
        v5Bytes: storeReplayBatchV5WireBytes(v5),
        v3DeflateBytes: deflatePackedJsonBytes(v3),
        v4DeflateBytes: deflatePackedJsonBytes(v4),
        v5DeflateBytes: deflateRawSync(v5).byteLength,
        v1EncodeUs,
        v1DecodeUs,
        v2EncodeUs,
        v2DecodeUs,
        v3EncodeUs,
        v3DecodeUs,
        v4EncodeUs,
        v4DecodeUs,
        v5EncodeUs,
        v5DecodeUs,
        applyUs,
    }
}

function sparseKey(index: number) {
    return 'S' + index
}

function createSparseQuote(index: number, revision: number): SparseQuote {
    return {
        s: sparseKey(index),
        c: index + 0.5 + revision / 100,
        t: 1_000_000 + revision,
        v: 10_000 + index * 3,
        active: index % 2 == 0,
        venue: index % 3 == 0 ? 'alpha' : 'beta',
    }
}

function createSparseValues(revisions: Uint32Array) {
    return Array.from({length: SPARSE_STORE_KEYS}, function createSparseValue(_, index) {
        return createSparseQuote(index, revisions[index])
    })
}

function sparseState(values: readonly SparseQuote[]) {
    const state: SparseQuotes = {}
    for (const value of values) state[value.s] = value
    return state
}

function median(values: readonly number[]) {
    const ordered = [...values].sort((left, right) => left - right)
    return ordered[Math.floor(ordered.length / 2)]
}

function checkSparsePatchKeys(
    patches: readonly StorePatch[],
    indexes: readonly number[],
    label: string,
) {
    check(patches.length == indexes.length, label + ' emitted another patch count')
    const expected = new Set(indexes.map(sparseKey))
    const actual = new Set<string>()
    for (const patch of patches) {
        check(patch.path.length == 1 && typeof patch.path[0] == 'string',
            label + ' emitted a non-key patch')
        check(patch.exists, label + ' unexpectedly deleted a stable key')
        actual.add(patch.path[0] as string)
    }
    check(actual.size == patches.length, label + ' emitted a duplicate key')
    check(actual.size == expected.size, label + ' changed the expected key set size')
    for (const key of expected) check(actual.has(key), label + ' omitted ' + key)
}

function measureSparseProducer(rounds: number) {
    const revisions = new Uint32Array(SPARSE_STORE_KEYS)
    const initialValues = createSparseValues(revisions)
    let previousValues = initialValues
    const producer = createReplicatedMap<SparseQuote>({
        keyOf: value => value.s,
        initial: initialValues,
        delivery: 'latest',
        replay: {
            history: Math.max(1024, rounds * SPARSE_WAVES.length + 8),
            batch: {maxItems: STORE_BATCH_ITEMS, maxBytes: WIRE_TARGET_BYTES},
        },
    })
    const captured: ReplayEvent<[StorePatch[]]>[] = []
    const batchV6 = producer.api.batch?.v6
    check(batchV6, 'sparse ReplicatedMap did not expose Store v6')
    const off = batchV6!.line.on(function captureSparseBatch(event) {
        captured.push({
            seq: event.seq,
            ts: event.ts,
            event: [[...event.event[0]]],
        })
    })
    const mirror = createStore<SparseQuotes>(sparseState(createSparseValues(new Uint32Array(SPARSE_STORE_KEYS))))
    const expectedStates: SparseQuotes[] = []
    const waveSamples = new Map<string, number[]>()
    for (const wave of SPARSE_WAVES) waveSamples.set(wave.name, [])
    let totalPatches = 0

    try {
        for (let sequence = 0; sequence < rounds; sequence++) {
            for (const wave of SPARSE_WAVES) {
                for (const index of wave.indexes) revisions[index]++
                const values = createSparseValues(revisions)
                for (let index = 0; index < values.length; index++) {
                    check(values[index] != previousValues[index],
                        wave.name + ' reused a value object from the previous full snapshot')
                }
                if (sequence == 0) {
                    const changed = new Set(wave.indexes)
                    for (let index = 0; index < values.length; index++) {
                        const equal = snapshotEqual(values[index], previousValues[index])
                        check(equal == !changed.has(index),
                            wave.name + ' fixture changed another semantic value')
                    }
                }

                const eventIndex = captured.length
                const started = performance.now()
                producer.control.replaceAll(values)
                const elapsedUs = (performance.now() - started) * 1000
                waveSamples.get(wave.name)!.push(elapsedUs)

                check(captured.length == eventIndex + 1,
                    wave.name + ' full snapshot did not produce exactly one Store batch')
                const event = captured[eventIndex]
                const patches = event.event[0]
                checkSparsePatchKeys(patches, wave.indexes, wave.name)
                totalPatches += patches.length

                if (sequence == 0) {
                    applyStorePatches(mirror, patches)
                    const expected = sparseState(values)
                    expectedStates.push(expected)
                    check(snapshotEqual(mirror.snapshot(), expected),
                        wave.name + ' materialized round-trip diverged')
                }
                previousValues = values
            }
        }

        check(captured.length == rounds * SPARSE_WAVES.length,
            'sparse producer emitted another packet count')
        check(totalPatches == rounds * SPARSE_PATCHES,
            'sparse producer sent unchanged full-snapshot values')
        check(snapshotEqual(producer.control.snapshot(), sparseState(previousValues)),
            'sparse producer materialized state diverged')

        return {
            initialValues,
            expectedStates,
            events: captured.slice(0, SPARSE_WAVES.length),
            rows: SPARSE_WAVES.map(wave => ({
                wave: wave.name,
                inputKeys: SPARSE_STORE_KEYS,
                freshObjects: SPARSE_STORE_KEYS,
                emittedPatches: wave.indexes.length,
                unchangedNotSent: SPARSE_STORE_KEYS - wave.indexes.length,
                replaceAllUs: median(waveSamples.get(wave.name)!).toFixed(2),
            })),
        }
    } finally {
        if (typeof off == 'function') off()
        producer.control.close()
    }
}

function createSparsePatchSequence(sequence: number) {
    return SPARSE_WAVES.map(function createSparseWaveEvent(wave, waveIndex) {
        const revision = sequence * SPARSE_WAVES.length + waveIndex + 1
        const patches: StorePatch[] = wave.indexes.map(function createSparsePatch(index) {
            return {
                path: [sparseKey(index)],
                exists: true,
                value: createSparseQuote(index, revision),
            }
        })
        return {
            seq: 10_000 + sequence * SPARSE_WAVES.length + waveIndex,
            ts: 2_000_000 + sequence * SPARSE_WAVES.length + waveIndex,
            event: [patches] as [StorePatch[]],
        }
    })
}

function measureSparseOuterMode(
    mode: tStoreMode,
    rounds: number,
    canonical: ReturnType<typeof measureSparseProducer>,
) {
    const codec = asBenchmarkStoreCodec(mode)
    const pair = createOuterCodecPair(RPC_BINARY_SCHEMA_PROTOCOL_VERSION)

    // Teach both peers the recurring layouts before any byte or CPU sample.
    for (const event of createSparsePatchSequence(1)) {
        const wire = encodeOuterPacket(pair.sender, callbackPacket(codec.encode(event)))
        const packet = decodeOuterPacket(
            pair.receiver,
            wire,
            RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
        )
        codec.decode(decodedCallbackValue(packet))
    }

    const mirror = createStore<SparseQuotes>(
        sparseState(createSparseValues(new Uint32Array(SPARSE_STORE_KEYS))),
    )
    const packetBytes: number[] = []
    for (let waveIndex = 0; waveIndex < canonical.events.length; waveIndex++) {
        const event = canonical.events[waveIndex]
        const wire = encodeOuterPacket(pair.sender, callbackPacket(codec.encode(event)))
        packetBytes.push(wire.byteLength)
        const packet = decodeOuterPacket(
            pair.receiver,
            wire,
            RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
        )
        const decoded = codec.decode(decodedCallbackValue(packet))
        checkSparsePatchKeys(
            decoded.event[0],
            SPARSE_WAVES[waveIndex].indexes,
            mode + '/' + SPARSE_WAVES[waveIndex].name,
        )
        applyStorePatches(mirror, decoded.event[0])
        check(snapshotEqual(mirror.snapshot(), canonical.expectedStates[waveIndex]),
            mode + '/' + SPARSE_WAVES[waveIndex].name + ' exact round-trip diverged')
    }

    const encodeSamples: number[] = []
    const decodeSamples: number[] = []
    const measuredWindows = 5
    for (let window = 0; window <= measuredWindows; window++) {
        const events: ReplayEvent<[StorePatch[]]>[] = []
        for (let round = 0; round < rounds; round++) {
            events.push(...createSparsePatchSequence(100 + window * rounds + round))
        }
        const wires = new Array<Uint8Array>(events.length)
        const encodeStarted = performance.now()
        for (let index = 0; index < events.length; index++) {
            const storeValue = codec.encode(events[index])
            wires[index] = encodeOuterPacket(pair.sender, callbackPacket(storeValue))
        }
        const encodeUs = (performance.now() - encodeStarted) * 1000 / rounds

        let decodedPatches = 0
        const decodeStarted = performance.now()
        for (const wire of wires) {
            const packet = decodeOuterPacket(
                pair.receiver,
                wire,
                RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
            )
            const decoded = codec.decode(decodedCallbackValue(packet))
            decodedPatches += decoded.event[0].length
        }
        const decodeUs = (performance.now() - decodeStarted) * 1000 / rounds
        check(wires.length == rounds * SPARSE_WAVES.length,
            mode + ' sparse CPU window emitted another packet count')
        check(decodedPatches == rounds * SPARSE_PATCHES,
            mode + ' sparse CPU window decoded another patch count')
        if (window > 0) {
            encodeSamples.push(encodeUs)
            decodeSamples.push(decodeUs)
        }
    }

    const totalBytes = packetBytes.reduce((total, bytes) => total + bytes, 0)
    const fullEncodeUs = median(encodeSamples)
    const fullDecodeUs = median(decodeSamples)
    return {
        mode,
        rounds,
        packets: packetBytes.length,
        patches: SPARSE_PATCHES,
        freshInputs: SPARSE_STORE_KEYS * SPARSE_WAVES.length,
        wireValues: SPARSE_PATCHES,
        packetBytes,
        totalBytes,
        averagePacketBytes: totalBytes / packetBytes.length,
        fullEncodeUs,
        fullDecodeUs,
    }
}

function runSparseBenchmark() {
    const rounds = sparseBenchmarkRounds()
    console.log('\nFocused sparse ReplicatedMap -> Store v1-v6 -> warm RPB/2 benchmark')
    console.log('Each producer call receives 500 freshly allocated values with one stable object layout.')
    console.log('The three deterministic waves change only 20, 40 and 50 values; unchanged values must not reach wire.')
    console.log('CPU samples: 1 warm-up + 5 measured windows, ' + rounds + ' three-packet sequences per window.')

    const producer = measureSparseProducer(rounds)
    console.log('\nProducer scan/diff: ReplicatedMap.replaceAll(latest), full 500-key input')
    console.table(producer.rows)
    check(producer.events.length == 3, 'sparse canonical sequence did not contain three packets')
    check(
        producer.events.reduce((total, event) => total + event.event[0].length, 0)
            == SPARSE_PATCHES,
        'sparse canonical sequence did not contain 110 patches',
    )

    const measured = STORE_MODES.map(mode => measureSparseOuterMode(mode, rounds, producer))
    const baseline = measured.find(row => row.mode == 'store-v1')
    check(baseline, 'sparse Store v1 baseline is absent')
    console.log('\nWarm RPB/2 full Store transform + outer codec')
    console.log('One row is the same exact 3-packet/110-patch sequence; packetB is 20 / 40 / 50 changes.')
    console.log('fullEncUs/fullDecUs are per complete three-packet sequence; object creation is outside the timer.')
    console.table(measured.map(row => ({
        store: row.mode,
        packets: row.packets,
        patches: row.patches,
        freshInputs: row.freshInputs,
        wireValues: row.wireValues,
        packetB: row.packetBytes.join(' / '),
        totalB: row.totalBytes,
        avgPacketB: row.averagePacketBytes.toFixed(1),
        bytesVsV1: percentFrom(row.totalBytes, baseline!.totalBytes),
        fullEncUs: row.fullEncodeUs.toFixed(2),
        encVsV1: percentFrom(row.fullEncodeUs, baseline!.fullEncodeUs),
        encPacketUs: (row.fullEncodeUs / row.packets).toFixed(2),
        fullDecUs: row.fullDecodeUs.toFixed(2),
        decVsV1: percentFrom(row.fullDecodeUs, baseline!.fullDecodeUs),
        decPacketUs: (row.fullDecodeUs / row.packets).toFixed(2),
        exact: true,
    })))
    console.log('\nSparse benchmark invariants passed: 1,500 fresh inputs -> 110 patches -> 3 packets per sequence')
}

const SOCKET_PARSER_MODES = ['store-v2', 'store-v3', 'store-v6'] as const
const SOCKET_PARSER_TRANSPORTS = ['json', 'rpb-v2'] as const
type tSocketParserMode = typeof SOCKET_PARSER_MODES[number]
type tSocketParserTransport = typeof SOCKET_PARSER_TRANSPORTS[number]
type tSocketParserRoute = {
    name: string
    mode: tSocketParserMode
    transport: tSocketParserTransport
}

const socketParserRoutes = SOCKET_PARSER_TRANSPORTS.flatMap(function makeTransportRoutes(transport) {
    return SOCKET_PARSER_MODES.map(function makeStoreRoute(mode) {
        return {name: transport + '/' + mode, mode, transport}
    })
})

function positiveBenchmarkInteger(name: string, fallback: number) {
    const source = process.env[name]
    if (source == undefined || source.trim() == '') return fallback
    const value = Number(source)
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(name + ' must be a positive integer')
    }
    return value
}

function createSocketParserPatches(items: number) {
    return Array.from({length: items}, function createSocketParserPatch(_, index): StorePatch {
        const symbol = 'S' + index
        return {
            path: [symbol],
            exists: true,
            value: {
                s: symbol,
                c: index + 0.125,
                t: 1_000_000 + index,
                active: index % 5 != 0,
                venue: index % 2 == 0 ? 'spot' : 'futures',
                meta: {
                    bid: index + 0.1,
                    ask: index + 0.2,
                    tags: ['live', 'group-' + (index % 8)],
                },
                note: index % 17 == 0 ? null : 'quote-' + index,
            },
        }
    })
}

function socketParserEvent(seq: number, patches: StorePatch[]) {
    return {
        seq,
        ts: 1_000_000 + seq,
        event: [patches] as [StorePatch[]],
    }
}

function asUint8Array(value: unknown) {
    check(ArrayBuffer.isView(value), 'RPB/2 socket payload is not a binary view')
    const view = value as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function createSocketParserRouteCodec(deps: {
    route: tSocketParserRoute
    patches: StorePatch[]
}) {
    const {route, patches} = deps
    const codec = asBenchmarkStoreCodec(route.mode)
    const pair = route.transport == 'rpb-v2'
        ? createOuterCodecPair(RPC_BINARY_SCHEMA_PROTOCOL_VERSION)
        : undefined

    function storePacket(seq: number) {
        return callbackPacket(codec.encode(socketParserEvent(seq, patches)))
    }

    function decodeStorePacket(packet: any[]) {
        return codec.decode(decodedCallbackValue(packet))
    }

    function prepareSocket(seq: number) {
        const packet = storePacket(seq)
        if (route.transport == 'json') return packet
        return encodeOuterPacket(pair!.sender, packet)
    }

    function receiveSocket(wire: unknown) {
        if (route.transport == 'json') return decodeStorePacket(wire as any[])
        const packet = decodeOuterPacket(
            pair!.receiver,
            asUint8Array(wire),
            RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
        )
        return decodeStorePacket(packet)
    }

    function encodeCore(seq: number) {
        const packet = storePacket(seq)
        if (route.transport == 'json') return JSON.stringify(packet)
        return encodeOuterPacket(pair!.sender, packet)
    }

    function decodeCore(wire: string | Uint8Array) {
        const packet = route.transport == 'json'
            ? JSON.parse(wire as string)
            : decodeOuterPacket(
                pair!.receiver,
                wire as Uint8Array,
                RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
            )
        return decodeStorePacket(packet)
    }

    return {
        route,
        preludeBytes: pair?.preludeBytes ?? 0,
        prepareSocket,
        receiveSocket,
        encodeCore,
        decodeCore,
    }
}

function socketPacketBytes(data: unknown) {
    if (typeof data == 'string') return utf8Encoder.encode(data).byteLength
    if (ArrayBuffer.isView(data)) return data.byteLength
    if (data instanceof ArrayBuffer) return data.byteLength
    return utf8Encoder.encode(JSON.stringify(data)).byteLength
}

function measureSocketParserCore(
    route: tSocketParserRoute,
    patches: StorePatch[],
    rounds: number,
) {
    const state = createSocketParserRouteCodec({route, patches})
    let seq = 1
    let wire = state.encodeCore(seq++)
    for (let index = 0; index < 20; index++) {
        wire = state.encodeCore(seq++)
        state.decodeCore(wire)
    }
    const wireBytes = typeof wire == 'string'
        ? utf8Encoder.encode(wire).byteLength
        : wire.byteLength
    const encodeUs = measureStableUs(rounds, function encodeSocketParserCore() {
        wire = state.encodeCore(seq++)
    })
    const decodeUs = measureStableUs(rounds, function decodeSocketParserCore() {
        state.decodeCore(wire)
    })
    const decoded = state.decodeCore(wire)
    check(snapshotEqual(decoded.event[0], patches), route.name + ' core parser changed patches')
    return {
        route: route.name,
        store: route.mode,
        transport: route.transport,
        rounds,
        preludeBytes: state.preludeBytes,
        wireBytes,
        encodeUs,
        decodeUs,
        exact: true,
    }
}

async function measureSocketParser() {
    const items = positiveBenchmarkInteger('STORE_REPLAY_SOCKET_ITEMS', 250)
    const frames = positiveBenchmarkInteger('STORE_REPLAY_SOCKET_FRAMES', 80)
    const windows = positiveBenchmarkInteger('STORE_REPLAY_SOCKET_WINDOWS', 5)
    const warmupWindows = positiveBenchmarkInteger('STORE_REPLAY_SOCKET_WARMUP_WINDOWS', 2)
    const coreRounds = positiveBenchmarkInteger('STORE_REPLAY_SOCKET_CORE_ROUNDS', 400)
    const patches = createSocketParserPatches(items)
    const expectedPatches = JSON.stringify(patches)
    const routeStates = socketParserRoutes.map(function createRouteState(route) {
        return createSocketParserRouteCodec({route, patches})
    })
    const httpServer = createServer()
    const ioServer = new SocketIOServer(httpServer, {
        maxHttpBufferSize: 1e8,
        perMessageDeflate: false,
    })
    let serverSocket: any
    let activeServerWindow: {
        ack(result: unknown): void
        started: number
        prepareMs: number
        emitMs: number
        enginePackets: number
        engineBytes: number
    } | undefined

    ioServer.on('connection', function serveSocketParser(socket) {
        serverSocket = socket
        socket.conn.on('packetCreate', function measureEnginePacket(packet: {type: string, data?: unknown}) {
            if (!activeServerWindow || packet.type != 'message') return
            activeServerWindow.enginePackets++
            activeServerWindow.engineBytes += socketPacketBytes(packet.data)
        })
        socket.on('store-parser-complete', function finishSocketParserWindow(result: {
            received: number
            decodeMs: number
            exact: boolean
        }) {
            const active = activeServerWindow
            check(active, 'socket parser completed without an active server window')
            const elapsedMs = performance.now() - active!.started
            activeServerWindow = undefined
            active!.ack({
                ...result,
                elapsedMs,
                prepareMs: active!.prepareMs,
                emitMs: active!.emitMs,
                enginePackets: active!.enginePackets,
                engineBytes: active!.engineBytes,
            })
        })
        socket.on('store-parser-run', function runSocketParserWindow(
            request: {route: number, frames: number, firstSeq: number},
            ack: (result: unknown) => void,
        ) {
            check(!activeServerWindow, 'socket parser windows overlap')
            const route = routeStates[request.route]
            check(route, 'unknown socket parser route')
            activeServerWindow = {
                ack,
                started: performance.now(),
                prepareMs: 0,
                emitMs: 0,
                enginePackets: 0,
                engineBytes: 0,
            }
            for (let index = 0; index < request.frames; index++) {
                const prepareStarted = performance.now()
                const wire = route.prepareSocket(request.firstSeq + index)
                activeServerWindow!.prepareMs += performance.now() - prepareStarted
                const emitStarted = performance.now()
                socket.emit('store-parser-frame', wire)
                activeServerWindow!.emitMs += performance.now() - emitStarted
            }
        })
    })

    await new Promise<void>(function startSocketParserServer(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    const port = (httpServer.address() as AddressInfo).port
    const clientSocket = io('http://127.0.0.1:' + port, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
    })
    let activeClientWindow: {
        route: ReturnType<typeof createSocketParserRouteCodec>
        frames: number
        firstSeq: number
        received: number
        decodeMs: number
        last?: ReplayEvent<[StorePatch[]]>
    } | undefined

    clientSocket.on('store-parser-frame', function receiveSocketParserFrame(wire) {
        const active = activeClientWindow
        check(active, 'socket parser received a frame without an active client window')
        const decodeStarted = performance.now()
        const decoded = active!.route.receiveSocket(wire)
        active!.decodeMs += performance.now() - decodeStarted
        check(
            decoded.seq == active!.firstSeq + active!.received,
            active!.route.route.name + ' socket parser changed frame order',
        )
        active!.last = decoded
        active!.received++
        if (active!.received != active!.frames) return
        const exact = JSON.stringify(active!.last!.event[0]) == expectedPatches
        clientSocket.emit('store-parser-complete', {
            received: active!.received,
            decodeMs: active!.decodeMs,
            exact,
        })
    })

    try {
        await new Promise<void>(function waitForSocketParserConnect(resolve, reject) {
            clientSocket.once('connect', resolve)
            clientSocket.once('connect_error', reject)
        })
        check(serverSocket, 'socket parser server connection is absent')
        let nextSeq = 1

        function runWindow(routeIndex: number) {
            const route = routeStates[routeIndex]
            check(!activeClientWindow, 'socket parser client windows overlap')
            activeClientWindow = {
                route,
                frames,
                firstSeq: nextSeq,
                received: 0,
                decodeMs: 0,
            }
            nextSeq += frames
            return new Promise<any>(function waitForSocketParserWindow(resolve, reject) {
                const timeout = setTimeout(function rejectSocketParserWindow() {
                    reject(new Error('socket parser window timed out: ' + route.route.name))
                }, 30_000)
                clientSocket.emit('store-parser-run', {
                    route: routeIndex,
                    frames,
                    firstSeq: activeClientWindow!.firstSeq,
                }, function finishSocketParserRun(result: any) {
                    clearTimeout(timeout)
                    activeClientWindow = undefined
                    try {
                        check(result.received == frames, route.route.name + ' socket frame count changed')
                        check(result.exact, route.route.name + ' socket round-trip changed patches')
                        resolve(result)
                    } catch (error) {
                        reject(error)
                    }
                })
            })
        }

        const rows = []
        for (let routeIndex = 0; routeIndex < routeStates.length; routeIndex++) {
            for (let window = 0; window < warmupWindows; window++) await runWindow(routeIndex)
            const samples = []
            for (let window = 0; window < windows; window++) samples.push(await runWindow(routeIndex))
            const route = routeStates[routeIndex].route
            rows.push({
                route: route.name,
                store: route.mode,
                transport: route.transport,
                frames,
                items,
                enginePackets: median(samples.map(sample => sample.enginePackets)),
                engineBytes: median(samples.map(sample => sample.engineBytes)),
                prepareMs: median(samples.map(sample => sample.prepareMs)),
                emitMs: median(samples.map(sample => sample.emitMs)),
                decodeMs: median(samples.map(sample => sample.decodeMs)),
                elapsedMs: median(samples.map(sample => sample.elapsedMs)),
                exact: samples.every(sample => sample.exact),
            })
        }

        console.log('\nStore Replay parser benchmark over a real localhost Socket.IO WebSocket')
        console.log('One frame carries one callback packet with ' + items + ' Store patches.')
        console.log('JSON rows pass objects to Socket.IO; its JSON stringify/parse is inside socketUs, before the client handler.')
        console.log('RPB/2 rows pass one Uint8Array attachment; prepare/handler columns include RPB/2 encode/decode.')
        console.log('Engine bytes include the actual Socket.IO packet headers and binary attachments before WebSocket framing.')
        console.table(rows.map(function printSocketParserRow(row) {
            return {
                route: row.route,
                frames: row.frames,
                patches: row.frames * row.items,
                enginePacketsPerFrame: (row.enginePackets / row.frames).toFixed(2),
                engineBytesPerFrame: Math.round(row.engineBytes / row.frames),
                prepareUsPerFrame: (row.prepareMs * 1000 / row.frames).toFixed(2),
                emitUsPerFrame: (row.emitMs * 1000 / row.frames).toFixed(2),
                handlerDecodeUs: (row.decodeMs * 1000 / row.frames).toFixed(2),
                socketUsPerFrame: (row.elapsedMs * 1000 / row.frames).toFixed(2),
                patchesPerSecond: Math.round(row.frames * row.items * 1000 / row.elapsedMs),
                exact: row.exact,
            }
        }))

        const coreRows = socketParserRoutes.map(function measureCoreRoute(route) {
            return measureSocketParserCore(route, patches, coreRounds)
        })
        console.log('\nNode parser CPU without Socket.IO scheduling')
        console.log('JSON = Store transform + JSON.stringify/parse of the exact callback packet.')
        console.log('RPB/2 = Store transform + warm universal binary encode/decode; prelude is paid once per connection.')
        console.table(coreRows.map(function printSocketParserCoreRow(row) {
            return {
                route: row.route,
                rounds: row.rounds,
                preludeB: row.preludeBytes,
                wireB: row.wireBytes,
                encodeUs: row.encodeUs.toFixed(2),
                decodeUs: row.decodeUs.toFixed(2),
                encodeMBps: (row.wireBytes / row.encodeUs).toFixed(1),
                decodeMBps: (row.wireBytes / row.decodeUs).toFixed(1),
                exact: row.exact,
            }
        }))
        console.log('\nSocket parser invariants passed')
        return {rows, coreRows}
    } finally {
        clientSocket.close()
        await new Promise<void>(function closeSocketParserServers(resolve) {
            ioServer.close()
            httpServer.close(function socketParserServerClosed() { resolve() })
        })
    }
}

async function main() {
    if (benchmarkProfile() == 'sparse') {
        runSparseBenchmark()
        return
    }
    if (benchmarkProfile() == 'socket-parser') {
        await measureSocketParser()
        return
    }
    console.log('\nStore Replay cross-version routes over loopback Socket.IO')
    console.log('Workload sizes: ' + sizes.join(', ') + '. Override with STORE_REPLAY_BENCH_SIZES=1,10,50.')
    console.log('Use STORE_REPLAY_BENCH_PROFILE=sparse for the short 500-key sparse-update profile.')
    console.log('Wire bytes are RPC payload bytes before Socket.IO/Engine.IO/WebSocket framing.')
    console.log('enginePackets = Socket.IO emits + binary attachments (an Engine.IO-equivalent packet count).')
    console.log('settledMs includes a 5 ms settle window; burstTailMs is max server-emission -> logical-delivery latency.')
    console.log('plain-legacy uses a modern peer with every capability refused, so the measured data path is legacy-compatible.')
    console.log('RPB v1 is pinned with binary.schema:false; RPB v2 is explicitly schema-enabled.')
    console.log('Each store-vN route hides every newer member; raw/RPB-v1/RPB-v2 routes use the same logical workload.')
    const wire = []
    for (const items of sizes) {
        for (const route of routes) wire.push(await measureSocket(items, route))
    }

    for (const items of sizes) {
        const rows = wire.filter(row => row.items == items)
        function row(route: string) {
            const found = rows.find(candidate => candidate.route == route)
            check(found, items + '/' + route + ' route is absent')
            return found!
        }

        function checkCounts(route: string, logical: number, emits: number, attachments: number) {
            const current = row(route)
            check(current.logicalEvents == logical, items + '/' + route + ' logical event count changed')
            check(current.socketEmits == emits, items + '/' + route + ' Socket.IO emit count changed')
            check(current.binaryAttachments == attachments, items + '/' + route + ' attachment count changed')
            check(current.enginePackets == emits + attachments,
                items + '/' + route + ' Engine.IO-equivalent packet count changed')
        }

        const compactPackets = items + (items >= 5 ? 1 : 0)
        checkCounts('plain-legacy', items, items, 0)
        checkCounts('compact-per-patch', items, compactPackets, 0)
        checkCounts(
            'callback-batch',
            items,
            Math.ceil(compactPackets / CALLBACK_BATCH_ITEMS),
            0,
        )
        checkCounts('per-patch-rpb-v1', items, items, items)
        checkCounts('per-patch-rpb-v2', items, items, items)
        const rpbCallbackEmits = Math.ceil(items / CALLBACK_BATCH_ITEMS)
        checkCounts('callback-batch-rpb-v1', items, rpbCallbackEmits, rpbCallbackEmits)
        checkCounts('callback-batch-rpb-v2', items, rpbCallbackEmits, rpbCallbackEmits)

        const storeEvents = Math.ceil(items / STORE_BATCH_ITEMS)
        for (const mode of STORE_MODES) {
            const generation = storeCodec[mode].generation
            const rawEmits = mode == 'store-v5' ? storeEvents : 1
            const rawAttachments = mode == 'store-v5' ? storeEvents : 0
            checkCounts(mode + '-raw', storeEvents, rawEmits, rawAttachments)
            checkCounts(mode + '-rpb-v1', storeEvents, 1, 1)
            checkCounts(mode + '-rpb-v2', storeEvents, 1, 1)
            check(row(mode + '-raw').codec == generation, items + '/' + mode + ' raw selected wrong codec')
            check(row(mode + '-rpb-v1').codec == generation,
                items + '/' + mode + ' RPB v1 selected wrong Store codec')
            check(row(mode + '-rpb-v2').codec == generation,
                items + '/' + mode + ' RPB v2 selected wrong Store codec')
            check(row(mode + '-raw').rpcVersion == 0,
                items + '/' + mode + ' raw unexpectedly selected RPB')
            check(row(mode + '-rpb-v1').rpcVersion == RPC_BINARY_PROTOCOL_VERSION,
                items + '/' + mode + ' did not select RPB v1')
            check(row(mode + '-rpb-v2').rpcVersion == RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
                items + '/' + mode + ' did not select RPB v2')
            check(row(mode + '-raw').frameConverged && row(mode + '-raw').reconnectConverged,
                items + '/' + mode + ' raw failed frame/reconnect invariants')
            check(row(mode + '-rpb-v1').frameConverged && row(mode + '-rpb-v1').reconnectConverged,
                items + '/' + mode + ' RPB v1 failed frame/reconnect invariants')
            check(row(mode + '-rpb-v2').frameConverged && row(mode + '-rpb-v2').reconnectConverged,
                items + '/' + mode + ' RPB v2 failed frame/reconnect invariants')
        }

        const plain = row('plain-legacy')
        const compact = row('compact-per-patch')
        const callbackRaw = row('callback-batch')
        check(callbackRaw.socketEmits <= compact.socketEmits, items + ' callback batching increased emits')
        if (compact.socketEmits > 1) {
            check(callbackRaw.socketEmits < compact.socketEmits, items + ' callback batching did not reduce emits')
        }
        if (items >= 50) {
            check(compact.wireBytes < plain.wireBytes, items + ' compact route did not reduce legacy bytes')
            check(callbackRaw.wireBytes < plain.wireBytes, items + ' callback batching lost compact wire savings')
            for (const mode of STORE_MODES.slice(0, 5)) {
                check(row(mode + '-raw').wireBytes < callbackRaw.wireBytes,
                    items + '/' + mode + ' raw did not reduce callback wire bytes')
            }
        }
    }

    console.table(wire.map(row => ({
        items: row.items,
        route: row.route,
        transport: row.transport,
        rpc: row.rpcVersion || '-',
        codec: row.codec || '-',
        arrays: row.inputArrays,
        writes: row.writes,
        logical: row.logicalEvents,
        emits: row.socketEmits,
        attachments: row.binaryAttachments,
        enginePackets: row.enginePackets,
        headerBytes: row.headerBytes,
        binaryBytes: row.binaryBytes,
        wireBytes: row.wireBytes,
        settledMs: row.totalLatencyMs.toFixed(2),
        burstTailMs: row.maxBatchLatencyMs.toFixed(2),
        journalEvents: row.journalEvents,
        journalBytes: row.journalBytes,
        frameSubs: row.frameLineSubscriptions,
        frame: row.frameConverged,
        reconnect: row.reconnectConverged,
    })))

    const codecRows = sizes.map(measureCodec)
    console.log('\nStandalone Store v1-v5 codec bytes before transport compression; v6 is measured only in the route table.')
    console.log('DeflateRaw shows the compression-sensitive view.')
    console.table(codecRows.map(row => ({
        items: row.items,
        rounds: row.rounds,
        v1Bytes: row.v1Bytes,
        v2Bytes: row.v2Bytes,
        v3Bytes: row.v3Bytes,
        v4Bytes: row.v4Bytes,
        v5Bytes: row.v5Bytes,
        v4Saved: ((1 - row.v4Bytes / row.v1Bytes) * 100).toFixed(2) + '%',
        v5Saved: ((1 - row.v5Bytes / row.v1Bytes) * 100).toFixed(2) + '%',
        v3Deflate: row.v3DeflateBytes,
        v4Deflate: row.v4DeflateBytes,
        v5Deflate: row.v5DeflateBytes,
    })))

    console.log('\nStore transform CPU, microseconds per complete logical batch')
    console.log('v1-v4 encode excludes JSON/Socket.IO serialization; v5 encode includes its inner byte serialization.')
    console.log('Use the route table above for full local delivery comparisons.')
    console.table(codecRows.map(row => ({
        items: row.items,
        v1EncodeUs: row.v1EncodeUs.toFixed(2),
        v1DecodeUs: row.v1DecodeUs.toFixed(2),
        v2EncodeUs: row.v2EncodeUs.toFixed(2),
        v2DecodeUs: row.v2DecodeUs.toFixed(2),
        v3EncodeUs: row.v3EncodeUs.toFixed(2),
        v3DecodeUs: row.v3DecodeUs.toFixed(2),
        v4EncodeUs: row.v4EncodeUs.toFixed(2),
        v4DecodeUs: row.v4DecodeUs.toFixed(2),
        v5EncodeUs: row.v5EncodeUs.toFixed(2),
        v5DecodeUs: row.v5DecodeUs.toFixed(2),
        applyUs: row.applyUs.toFixed(2),
    })))

    const fullOuterRows = sizes.flatMap(function measureOuterSize(items) {
        return STORE_MODES.flatMap(function measureOuterMode(mode) {
            return [
                measureFullOuterCodec(items, mode, RPC_BINARY_PROTOCOL_VERSION),
                measureFullOuterCodec(items, mode, RPC_BINARY_SCHEMA_PROTOCOL_VERSION),
            ]
        })
    })
    console.log('\nFull Store callback pipeline CPU and bytes, apples-to-apples for v1-v6')
    console.log('Every row measures Store transform + exact [Pkt.CB, id, [event]] outer RPB envelope.')
    console.log('cold = first packet of fresh peers; warm = stable state after schema/shape learning.')
    console.log('pairSetupUs is sender + receiver peer creation and schema prelude handoff; paid once per connection.')
    console.log('coldEncUs/coldDecUs isolate the first outer RPB packet and exclude Store transforms.')
    console.log('store/outer columns phase-separate the work; full columns time both phases together.')
    console.log('fullEncUs/fullDecUs are medians of 7 measured windows after 2 warm-up windows.')
    console.table(fullOuterRows.map(row => ({
        items: row.items,
        store: row.mode,
        rpc: 'RPB/' + row.rpc,
        rounds: row.rounds,
        coldRounds: row.coldRounds,
        preludeB: row.preludeBytes,
        coldB: row.coldBytes,
        warmB: row.warmBytes,
        pairSetupUs: row.setupUs.toFixed(2),
        coldEncUs: row.coldEncodeUs.toFixed(2),
        coldDecUs: row.coldDecodeUs.toFixed(2),
        storeEncUs: row.storeEncodeUs.toFixed(2),
        outerEncUs: row.outerEncodeUs.toFixed(2),
        fullEncUs: row.fullEncodeUs.toFixed(2),
        outerDecUs: row.outerDecodeUs.toFixed(2),
        storeDecUs: row.storeDecodeUs.toFixed(2),
        fullDecUs: row.fullDecodeUs.toFixed(2),
    })))

    console.log('\nCurrent RPB/2 Store v1-v6 summary; percentages are relative to Store v1.')
    console.log('Negative percentages mean fewer bytes or less CPU.')
    console.table(sizes.flatMap(function summarizeOuterSize(items) {
        const rows = fullOuterRows.filter(
            row => row.items == items && row.rpc == RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
        )
        const baseline = rows.find(row => row.mode == 'store-v1')
        check(baseline, items + '/store-v1 RPB/2 benchmark baseline is absent')
        return rows.map(row => ({
            items,
            store: row.mode,
            warmB: row.warmBytes,
            bytesVsV1: percentFrom(row.warmBytes, baseline!.warmBytes),
            fullEncUs: row.fullEncodeUs.toFixed(2),
            encodeVsV1: percentFrom(row.fullEncodeUs, baseline!.fullEncodeUs),
            fullDecUs: row.fullDecodeUs.toFixed(2),
            decodeVsV1: percentFrom(row.fullDecodeUs, baseline!.fullDecodeUs),
        }))
    }))
    console.log('\nAll benchmark invariants passed')
}

main().catch(function reportFailure(error) { console.error(error); process.exit(1) })
