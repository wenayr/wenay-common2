// =============================================================================
// Extended bounded media stress over the real Socket.IO/RPC wire.
//
// One publisher fans more than 100 MiB of deterministic video frames out to
// several raw and canvas consumers. Work is sent in small waves so the oracle
// stresses sustained throughput without constructing an unbounded in-flight
// queue. Publisher reconnects then prove that listener state is generation-local.
// =============================================================================

import {createHash} from 'node:crypto'
import express from 'express'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {
    attachVideoCanvas,
    decodeMediaFrame,
    encodeMediaFrame,
    toBytes,
} from '../src/Common/media/media-index'
import type {MediaFrameCodec} from '../src/Common/media/media-source'
import {createMediaRelay} from '../src/Common/peer/peer-media-relay'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

type tParticipant = {account: string, room: string}
type tDimensions = {width: number, height: number}
type tPayloadIdentity = {
    ownerTag: number
    lineTag: number
    generation: number
    seq: number
    declaredBytes: number
    patternTag: number
}

const PUBLISHER = 'extended-camera'
const WATCHERS = ['extended-viewer-a', 'extended-viewer-b', 'extended-viewer-c'] as const
const ROOM = 'extended-room'
const LINE = 'cam'
const PAYLOAD_MAGIC = 0x56455832
const PAYLOAD_HEADER_BYTES = 32
const PAYLOAD_DIGEST_BYTES = 32
const BULK_FRAMES = 3_072
const WAVE_FRAMES = 8
const RECONNECT_GENERATIONS = 4
const RECONNECT_BURST_FRAMES = 15
const FINAL_FRAME_BYTES = 1 * 1024 * 1024
const MAX_RPC_FRAME_BYTES = 4 * 1024 * 1024
const codecs: readonly MediaFrameCodec[] = ['jpeg', 'webp', 'png']
const dimensions: readonly tDimensions[] = [
    {width: 320, height: 240},
    {width: 1280, height: 720},
    {width: 1920, height: 1080},
]

let fails = 0

function ok(condition: unknown, message: string) {
    if (!condition) {
        fails++
        console.log('  FAIL', message)
        return
    }
    console.log('  OK  ', message)
}

function delay(ms: number) {
    return new Promise<void>(function waitDelay(resolve) {
        setTimeout(resolve, ms)
    })
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await delay(5)
    }
    throw new Error('timeout: ' + label)
}

async function within<T>(label: string, value: Promise<T>, timeoutMs = 30_000) {
    let timer: ReturnType<typeof setTimeout> | undefined
    return new Promise<T>(function waitForValue(resolve, reject) {
        timer = setTimeout(function operationTimedOut() {
            reject(new Error('timeout during ' + label))
        }, timeoutMs)
        value.then(
            function operationResolved(result) {
                if (timer) clearTimeout(timer)
                resolve(result)
            },
            function operationRejected(error) {
                if (timer) clearTimeout(timer)
                reject(error)
            },
        )
    })
}

function tagOf(value: string) {
    let hash = 2166136261
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
    if (left.byteLength != right.byteLength) return false
    for (let index = 0; index < left.byteLength; index++) {
        if (left[index] != right[index]) return false
    }
    return true
}

function frameCodec(seq: number) {
    return codecs[(seq - 1) % codecs.length]
}

function frameDimensions(seq: number) {
    return dimensions[Math.floor((seq - 1) / codecs.length) % dimensions.length]
}

function framePayloadBytes(seq: number) {
    if (seq % 12 == 0) return 1 * 1024 * 1024
    if (seq % 6 == 0) return 256 * 1024
    if (seq % 3 == 0) return 64 * 1024
    return 4 * 1024
}

function repeatedPattern(generation: number) {
    return (0x51 + generation * 17) & 0xff
}

function patternFor(generation: number, seq: number) {
    if (seq % 2 == 0) return repeatedPattern(generation)
    return (generation * 37 + seq * 29) & 0xff
}

function createPayload(generation: number, seq: number, byteLength: number) {
    if (byteLength < PAYLOAD_HEADER_BYTES + PAYLOAD_DIGEST_BYTES) {
        throw new RangeError('extended media payload is too short')
    }
    const payload = new Uint8Array(byteLength)
    const digestOffset = byteLength - PAYLOAD_DIGEST_BYTES
    const patternTag = patternFor(generation, seq)
    payload.fill(patternTag, PAYLOAD_HEADER_BYTES, digestOffset)
    const view = new DataView(payload.buffer)
    view.setUint32(0, PAYLOAD_MAGIC, true)
    view.setUint32(4, tagOf(PUBLISHER), true)
    view.setUint32(8, tagOf(LINE), true)
    view.setUint32(12, generation, true)
    view.setUint32(16, seq, true)
    view.setUint32(20, byteLength, true)
    view.setUint32(24, patternTag, true)
    view.setUint32(28, (generation ^ seq ^ byteLength ^ patternTag) >>> 0, true)
    const digest = createHash('sha256').update(payload.subarray(0, digestOffset)).digest()
    payload.set(digest, digestOffset)
    return payload
}

function readPayload(payloadLike: ArrayBuffer | ArrayBufferView): tPayloadIdentity {
    const payload = toBytes(payloadLike)
    if (payload.byteLength < PAYLOAD_HEADER_BYTES + PAYLOAD_DIGEST_BYTES) {
        throw new Error('extended media payload is too short')
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    if (view.getUint32(0, true) != PAYLOAD_MAGIC) {
        throw new Error('extended media payload magic mismatch')
    }
    const generation = view.getUint32(12, true)
    const seq = view.getUint32(16, true)
    const declaredBytes = view.getUint32(20, true)
    const patternTag = view.getUint32(24, true)
    if (declaredBytes != payload.byteLength) {
        throw new Error('extended media payload length mismatch')
    }
    if (view.getUint32(28, true) != ((generation ^ seq ^ declaredBytes ^ patternTag) >>> 0)) {
        throw new Error('extended media payload header checksum mismatch')
    }
    if (patternTag != patternFor(generation, seq)) {
        throw new Error('extended media payload pattern mismatch')
    }
    const digestOffset = payload.byteLength - PAYLOAD_DIGEST_BYTES
    if (digestOffset > PAYLOAD_HEADER_BYTES
        && (payload[PAYLOAD_HEADER_BYTES] != patternTag
            || payload[digestOffset - 1] != patternTag)) {
        throw new Error('extended media payload body pattern mismatch')
    }
    const expectedDigest = createHash('sha256').update(payload.subarray(0, digestOffset)).digest()
    if (!sameBytes(payload.subarray(digestOffset), expectedDigest)) {
        throw new Error('extended media payload SHA-256 mismatch')
    }
    return {
        ownerTag: view.getUint32(4, true),
        lineTag: view.getUint32(8, true),
        generation,
        seq,
        declaredBytes,
        patternTag,
    }
}

function createFrame(generation: number, seq: number, payloadBytes = framePayloadBytes(seq)) {
    const size = frameDimensions(seq)
    return encodeMediaFrame({
        kind: 'video-frame',
        codec: frameCodec(seq),
        seq,
        tMono: generation * 1_000_000 + seq + 0.125,
        width: size.width,
        height: size.height,
    }, createPayload(generation, seq, payloadBytes))
}

function createMemoryMeter() {
    let sampledPeakRss = process.memoryUsage().rss

    function sample() {
        sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss)
    }

    return {
        sample,
        peakMiB: () => sampledPeakRss / 1024 / 1024,
    }
}

async function createStressServer(roomByAccount: Map<string, string>) {
    const media = createMediaRelay({
        lines: {cam: 'video'},
        videoHistory: 8,
        canWatch: function canWatch(watcher, owner) {
            const room = roomByAccount.get(watcher)
            return !!room && room == roomByAccount.get(owner)
        },
    })
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer, {
        transports: ['websocket'],
        maxHttpBufferSize: MAX_RPC_FRAME_BYTES,
        pingTimeout: 30_000,
    })

    ioServer.on('connection', function onConnection(socket) {
        const account = String(socket.handshake.auth?.account ?? '')
        const [disconnect, disconnectListen] = createListenPair<[]>()
        const publish = media.publishOf(account)
        socket.on('disconnect', function onDisconnect() {
            disconnect()
            media.dropAccount(account)
        })
        createRpcServerAuto({
            socket: {
                emit: (key, data) => socket.emit(key, data),
                on: (key, cb) => socket.on(key, cb),
            },
            socketKey: 'video-extended-stress',
            object: {
                media: {
                    publish,
                    watch: media.watchOf(account),
                },
            },
            disconnectListen,
        })
    })

    await new Promise<void>(function startServer(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })

    return {
        port: (httpServer.address() as AddressInfo).port,
        media,
        ioServer,
        async close() {
            ioServer.close()
            await new Promise<void>(function closeHttpServer(resolve) {
                httpServer.close(function serverClosed() {
                    resolve()
                })
            })
        },
    }
}

async function connectParticipant(port: number, account: string) {
    const hub = createRpcClientHub(
        function createSocket() {
            return io('http://127.0.0.1:' + port, {
                transports: ['websocket'],
                forceNew: true,
                auth: {account},
            })
        },
        function createFacade(remote) {
            return {api: remote<any>('video-extended-stress')} as const
        },
    )
    const clients = await hub.setToken(null)
    await clients.api.readyStrict()
    let closed = false

    function close() {
        if (closed) return
        closed = true
        hub.socket?.disconnect?.()
    }

    return {
        account,
        func: clients.api.func as any,
        close,
    }
}

function createVideoWindow(deps: {
    watcher: string
    generation: number
    remote: any
    current?: boolean
    decodeDelayMs: number
}) {
    const {watcher, generation, remote, current = false, decodeDelayMs} = deps
    const rawSeq: number[] = []
    const draws: number[] = []
    const errors: string[] = []
    let rawBytes = 0
    let nativeViews = 0
    let repeated = 0
    let changing = 0
    let closedBitmaps = 0
    let activeDecodes = 0
    let maxActiveDecodes = 0
    let ended = false
    let disposed = false

    function validateFrame(raw: any) {
        if (ArrayBuffer.isView(raw)) nativeViews++
        const frame = decodeMediaFrame(toBytes(raw))
        const identity = readPayload(frame.payload)
        const size = frameDimensions(identity.seq)
        if (identity.ownerTag != tagOf(PUBLISHER)) throw new Error('owner identity mismatch')
        if (identity.lineTag != tagOf(LINE)) throw new Error('line identity mismatch')
        if (identity.generation != generation) throw new Error('publisher generation mismatch')
        if (identity.seq != frame.seq) throw new Error('media header/payload sequence mismatch')
        if (frame.codec != frameCodec(identity.seq)) throw new Error('media codec mismatch')
        if (frame.width != size.width || frame.height != size.height) {
            throw new Error('media dimensions mismatch')
        }
        rawSeq.push(frame.seq)
        rawBytes += frame.payload.byteLength
        if (frame.seq % 2 == 0) repeated++
        else changing++
    }

    function collectRawFrame(raw: any) {
        try {
            validateFrame(raw)
        } catch (error) {
            errors.push(String((error as any)?.message ?? error))
        }
    }

    const rawHandle = current
        ? remote.on(collectRawFrame, {current: true})
        : remote.on(collectRawFrame)
    function markEnded() {
        ended = true
    }
    void Promise.resolve(rawHandle).then(markEnded, markEnded)

    const canvas: any = {
        width: 0,
        height: 0,
        getContext() {
            return {
                drawImage(bitmap: any) {
                    draws.push(bitmap.seq)
                },
            }
        },
    }
    const view = attachVideoCanvas(remote, canvas, {
        async createBitmap(blob) {
            activeDecodes++
            maxActiveDecodes = Math.max(maxActiveDecodes, activeDecodes)
            try {
                if (decodeDelayMs) await delay(decodeDelayMs)
                const identity = readPayload(await blob.arrayBuffer())
                if (identity.generation != generation) {
                    throw new Error('canvas received a stale publisher generation')
                }
                return {
                    seq: identity.seq,
                    close() {
                        closedBitmaps++
                    },
                }
            } finally {
                activeDecodes--
            }
        },
        onError(error) {
            errors.push(String((error as any)?.message ?? error))
        },
    })

    async function close() {
        if (disposed) return
        disposed = true
        await remote.removeCallback()
    }

    return {
        key: watcher + '<-' + PUBLISHER + '.' + LINE + '@' + generation,
        watcher,
        generation,
        rawSeq,
        draws,
        errors,
        canvas,
        view,
        get rawBytes() { return rawBytes },
        get nativeViews() { return nativeViews },
        get repeated() { return repeated },
        get changing() { return changing },
        get closedBitmaps() { return closedBitmaps },
        get activeDecodes() { return activeDecodes },
        get maxActiveDecodes() { return maxActiveDecodes },
        get ended() { return ended },
        close,
        abandon() {
            disposed = true
        },
        dispose() {
            if (disposed) return
            disposed = true
            void Promise.resolve(remote.removeCallback()).catch(function ignoreClosedRemote() {})
        },
    }
}

function exactSequence(values: readonly number[], first: number, last: number) {
    if (values.length != last - first + 1) return false
    for (let index = 0; index < values.length; index++) {
        if (values[index] != first + index) return false
    }
    return true
}

function strictlyIncreasing(values: readonly number[]) {
    for (let index = 1; index < values.length; index++) {
        if (values[index] <= values[index - 1]) return false
    }
    return true
}

async function main() {
    console.log('\n[video-windows-extended-stress] bounded 100+ MiB fan-out and reconnect matrix')
    const startedAt = Date.now()
    const memory = createMemoryMeter()
    const participantRows: tParticipant[] = [
        {account: PUBLISHER, room: ROOM},
        ...WATCHERS.map(function watcherParticipant(account) {
            return {account, room: ROOM}
        }),
    ]
    const roomByAccount = new Map(participantRows.map(item => [item.account, item.room]))
    const server = await createStressServer(roomByAccount)
    const connections = new Map<string, Awaited<ReturnType<typeof connectParticipant>>>()
    const allConnections: Array<Awaited<ReturnType<typeof connectParticipant>>> = []
    const allWindows: Array<ReturnType<typeof createVideoWindow>> = []
    const observedLines = new Set<any>()
    let sourceFrames = 0
    let sourceBytes = 0
    let reconnects = 0

    async function connect(account: string) {
        const connection = await connectParticipant(server.port, account)
        connections.set(account, connection)
        allConnections.push(connection)
        return connection
    }

    function rememberLine(line: any) {
        observedLines.add(line)
        return line
    }

    function remoteLine(watcher: string) {
        return connections.get(watcher)!.func.media.watch[PUBLISHER][LINE]
    }

    async function publish(generation: number, seq: number, payloadBytes = framePayloadBytes(seq)) {
        const frame = createFrame(generation, seq, payloadBytes)
        sourceFrames++
        sourceBytes += payloadBytes
        await within(
            'publish generation ' + generation + ' seq ' + seq,
            connections.get(PUBLISHER)!.func.media.publish(LINE, frame, Date.now()),
        )
    }

    function createGenerationWindows(generation: number) {
        return WATCHERS.map(function createWatcherWindow(watcher, index) {
            const window = createVideoWindow({
                watcher,
                generation,
                remote: remoteLine(watcher),
                decodeDelayMs: 4 + index * 4,
            })
            allWindows.push(window)
            return window
        })
    }

    function generationLines() {
        const source = rememberLine(server.media.lines(PUBLISHER)[LINE])
        const filtered = WATCHERS.map(function filteredLine(watcher) {
            return rememberLine(server.media.watchOf(watcher)[PUBLISHER][LINE])
        })
        return {source, filtered}
    }

    async function waitForSubscriptions(
        label: string,
        lines: ReturnType<typeof generationLines>,
        callbackCounts = WATCHERS.map(function defaultCallbackCount() { return 2 }),
    ) {
        await waitFor(label, function subscriptionsReady() {
            return lines.source.count() == WATCHERS.length
                && lines.filtered.every(function filteredReady(line, index) {
                    return line.count() == callbackCounts[index]
                })
        })
    }

    async function publishWaves(
        generation: number,
        first: number,
        last: number,
        windows: readonly ReturnType<typeof createVideoWindow>[],
    ) {
        for (let waveStart = first; waveStart <= last; waveStart += WAVE_FRAMES) {
            const waveEnd = Math.min(last, waveStart + WAVE_FRAMES - 1)
            const publications: Promise<void>[] = []
            for (let seq = waveStart; seq <= waveEnd; seq++) {
                publications.push(publish(generation, seq))
            }
            await Promise.all(publications)
            await waitFor(
                'raw fan-out generation ' + generation + ' through seq ' + waveEnd,
                function waveDelivered() {
                    return windows.every(window => window.rawSeq.at(-1) == waveEnd)
                },
            )
            memory.sample()
        }
    }

    async function waitForFinalDraw(
        label: string,
        windows: readonly ReturnType<typeof createVideoWindow>[],
        seq: number,
    ) {
        await waitFor(label, function finalDrawn() {
            return windows.every(window => window.draws.at(-1) == seq)
        })
    }

    async function disconnectPublisher(
        generation: number,
        windows: readonly ReturnType<typeof createVideoWindow>[],
        lines: ReturnType<typeof generationLines>,
    ) {
        const before = windows.map(window => window.rawSeq.length)
        connections.get(PUBLISHER)!.close()
        connections.delete(PUBLISHER)
        await waitFor('publisher generation ' + generation + ' removed', function publisherRemoved() {
            return !server.media.accounts().includes(PUBLISHER)
                && windows.every(window => window.ended)
        })
        await waitFor('generation ' + generation + ' listeners released', function listenersReleased() {
            return lines.source.count() == 0
                && lines.filtered.every(line => line.count() == 0)
        })
        await delay(20)
        ok(windows.every(function oldGenerationStayedClosed(window, index) {
            return window.rawSeq.length == before[index]
        }), 'generation ' + generation + ' receives no callback after publisher disconnect')
        ok(windows.every(window => window.closedBitmaps == window.draws.length),
            'generation ' + generation + ' closes every created bitmap')
        ok(windows.every(window => window.activeDecodes == 0
            && window.maxActiveDecodes == 1
            && strictlyIncreasing(window.draws)),
        'generation ' + generation + ' keeps one ordered decode in flight')
        for (const window of windows) window.abandon()
    }

    try {
        await Promise.all(participantRows.map(async function connectInitialParticipant(item) {
            await connect(item.account)
        }))
        ok(server.media.accounts().length == participantRows.length,
            'publisher and three independent fan-out viewers are live')

        // ==================== sustained mixed-size fan-out ====================
        const bulkGeneration = 1
        const bulkWindows = createGenerationWindows(bulkGeneration)
        const bulkLines = generationLines()
        await waitForSubscriptions('bulk generation subscriptions', bulkLines)
        ok(bulkLines.source.count() == WATCHERS.length,
            'three watcher filters share one upstream listener each')

        await publishWaves(bulkGeneration, 1, BULK_FRAMES, bulkWindows)
        ok(sourceFrames == BULK_FRAMES,
            'bulk phase publishes exactly ' + BULK_FRAMES + ' source frames')
        ok(sourceBytes > 100 * 1024 * 1024,
            'bulk phase carries more than 100 MiB of logical source payload')
        ok(bulkWindows.every(window => exactSequence(window.rawSeq, 1, BULK_FRAMES)),
            'every fan-out viewer receives all bulk frames once and in strict order')
        ok(bulkWindows.every(window => window.nativeViews == BULK_FRAMES),
            'all sustained RPC frames remain native binary views')
        ok(bulkWindows.every(window => window.errors.length == 0),
            'all mixed-size frames preserve header, tail, SHA-256, codec and dimensions')
        ok(bulkWindows.every(window => window.repeated > 0 && window.changing > 0),
            'each viewer observes repeated and changing payload patterns')
        await waitFor('all bulk canvas callbacks observed', function bulkCanvasCallbacksObserved() {
            return bulkWindows.every(window => window.view.stats().frames == BULK_FRAMES)
        })
        ok(bulkWindows.every(window => window.view.stats().frames == BULK_FRAMES
            && window.view.stats().drawn < window.view.stats().frames),
        'slow canvases busy-skip sustained overload without queuing every bitmap')

        await delay(50)
        const latestSeq = BULK_FRAMES + 1
        await publish(bulkGeneration, latestSeq, FINAL_FRAME_BYTES)
        await waitFor('latest marker raw delivery', function latestMarkerDelivered() {
            return bulkWindows.every(window => window.rawSeq.at(-1) == latestSeq)
        })
        await waitForFinalDraw('latest marker rendered', bulkWindows, latestSeq)

        const keyframe = await within<any>(
            'latest keyframe',
            remoteLine(WATCHERS[0]).keyframe(),
        )
        const keyframeFrame = decodeMediaFrame(toBytes(keyframe.event[0]))
        const keyframeIdentity = readPayload(keyframeFrame.payload)
        ok(keyframeIdentity.seq == latestSeq && keyframeIdentity.generation == bulkGeneration,
            'keyframe exposes only the latest byte-complete frame')

        const currentWindow = createVideoWindow({
            watcher: WATCHERS[0],
            generation: bulkGeneration,
            remote: remoteLine(WATCHERS[0]),
            current: true,
            decodeDelayMs: 3,
        })
        allWindows.push(currentWindow)
        const bulkWithCurrent = [...bulkWindows, currentWindow]
        await waitForSubscriptions('current:true extra consumers', bulkLines, [4, 2, 2])
        await waitFor('current:true latest raw frame', function currentRawReady() {
            return currentWindow.rawSeq[0] == latestSeq
        })

        const afterCurrentSeq = BULK_FRAMES + 2
        await publish(bulkGeneration, afterCurrentSeq, 256 * 1024)
        await waitFor('post-current fan-out', function postCurrentDelivered() {
            return bulkWithCurrent.every(window => window.rawSeq.at(-1) == afterCurrentSeq)
        })
        await waitForFinalDraw('post-current latest draw', bulkWithCurrent, afterCurrentSeq)
        await delay(20)
        ok(currentWindow.rawSeq.length == 2
            && currentWindow.rawSeq[0] == latestSeq
            && currentWindow.rawSeq[1] == afterCurrentSeq,
        'current:true receives one latest frame followed by one live frame')
        ok(bulkWithCurrent.every(window => window.activeDecodes == 0
            && window.maxActiveDecodes == 1
            && strictlyIncreasing(window.draws)
            && window.draws.at(-1) == afterCurrentSeq),
        'canvas decode stays single-flight, ordered and settled on the final marker')
        ok(bulkWithCurrent.every(window => window.closedBitmaps == window.draws.length),
            'all completed bulk/current bitmap decodes are closed')

        await disconnectPublisher(bulkGeneration, bulkWithCurrent, bulkLines)

        // ==================== publisher generation churn ====================
        for (let generation = 2; generation <= RECONNECT_GENERATIONS + 1; generation++) {
            await connect(PUBLISHER)
            reconnects++
            const windows = createGenerationWindows(generation)
            const lines = generationLines()
            await waitForSubscriptions('reconnect generation ' + generation, lines)
            await publishWaves(generation, 1, RECONNECT_BURST_FRAMES, windows)
            await delay(30)
            const finalSeq = RECONNECT_BURST_FRAMES + 1
            await publish(generation, finalSeq, FINAL_FRAME_BYTES)
            await waitFor('reconnect final raw ' + generation, function reconnectFinalRaw() {
                return windows.every(window => window.rawSeq.at(-1) == finalSeq)
            })
            await waitForFinalDraw('reconnect final draw ' + generation, windows, finalSeq)
            ok(windows.every(window => exactSequence(window.rawSeq, 1, finalSeq)),
                'reconnect generation ' + generation + ' is exact and independently ordered')
            ok(windows.every(window => window.errors.length == 0),
                'reconnect generation ' + generation + ' has no integrity error')
            await disconnectPublisher(generation, windows, lines)
            memory.sample()
        }

        ok(reconnects == RECONNECT_GENERATIONS,
            'four fresh publisher generations reconnect and tear down cleanly')
        ok(Array.from(observedLines).every(line => line.count() == 0),
            'every observed source and watcher-filter line returns to zero listeners')

        for (const watcher of WATCHERS) {
            connections.get(watcher)?.close()
            connections.delete(watcher)
        }
        await waitFor('viewer accounts removed', function viewersRemoved() {
            return server.media.accounts().length == 0
        })
        ok(server.ioServer.sockets.sockets.size == 0,
            'Socket.IO has no remaining participant connections')
    } finally {
        for (const window of allWindows) window.dispose()
        for (const connection of allConnections) connection.close()
        connections.clear()
        await delay(50)
        server.media.close()
        await server.close()
    }

    memory.sample()
    const elapsedMs = Date.now() - startedAt
    const rawDeliveries = allWindows.reduce(function countRawFrames(total, window) {
        return total + window.rawSeq.length
    }, 0)
    const rawBytes = allWindows.reduce(function countRawBytes(total, window) {
        return total + window.rawBytes
    }, 0)
    const draws = allWindows.reduce(function countDraws(total, window) {
        return total + window.draws.length
    }, 0)
    const closedBitmaps = allWindows.reduce(function countClosedBitmaps(total, window) {
        return total + window.closedBitmaps
    }, 0)

    console.log('\n[video-windows-extended-stress] metrics')
    console.log('  source frames       ' + sourceFrames)
    console.log('  source payload      ' + (sourceBytes / 1024 / 1024).toFixed(1) + ' MiB')
    console.log('  raw deliveries      ' + rawDeliveries)
    console.log('  raw payload         ' + (rawBytes / 1024 / 1024).toFixed(1) + ' MiB')
    console.log('  canvas draws/closed ' + draws + '/' + closedBitmaps)
    console.log('  reconnects          ' + reconnects)
    console.log('  sampled peak RSS    ' + memory.peakMiB().toFixed(1) + ' MiB')
    console.log('  elapsed             ' + (elapsedMs / 1000).toFixed(1) + ' s')
    console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function extendedVideoStressFailed(error) {
    console.error(error)
    process.exit(1)
})
