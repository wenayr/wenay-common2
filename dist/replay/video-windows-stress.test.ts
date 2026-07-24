// ============================================================
//  replay/video-windows-stress.test.ts
//
//  Synthetic video-window stress over the real Socket.IO/RPC wire:
//  - five concurrent publishers, ten rendered windows, large binary frames
//  - callback fan-out and per-stream ordering under a concurrent burst
//  - room isolation and live ACL revocation/regrant
//  - window stop/current/rejoin and publisher disconnect/rejoin
//  - createVideoSource + pipeMediaPublish without a camera or browser
//  - disconnect cleanup, bounded callback listener counts, no listener leaks
// ============================================================

import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {
    attachVideoCanvas,
    createVideoSource,
    decodeMediaFrame,
    encodeMediaFrame,
    pipeMediaPublish,
    toBytes,
} from '../src/Common/media/media-index'
import {createMediaRelay} from '../src/Common/peer/peer-media-relay'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

type tLine = 'cam' | 'screen'
type tParticipant = {account: string, room: string}
type tFrameIdentity = {ownerTag: number, lineTag: number, seq: number, declaredBytes: number}

const PAYLOAD_MAGIC = 0x56494e32
const CORE_FRAMES = 14
const LARGE_FRAME_BYTES = 512 * 1024
const participants: tParticipant[] = [
    {account: 'red-a', room: 'red'},
    {account: 'red-b', room: 'red'},
    {account: 'red-c', room: 'red'},
    {account: 'blue-a', room: 'blue'},
    {account: 'blue-b', room: 'blue'},
]

let fails = 0

function ok(condition: any, message: string) {
    if (!condition) {
        fails++
        console.log('  FAIL', message)
        return
    }
    console.log('  OK  ', message)
}

function delay(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await delay(20)
    }
    throw new Error(`timeout: ${label}`)
}

function tagOf(value: string) {
    let hash = 2166136261
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

function makePayload(owner: string, line: tLine, seq: number, bytes: number) {
    const payload = new Uint8Array(bytes)
    const view = new DataView(payload.buffer)
    const seed = (tagOf(owner) ^ tagOf(line) ^ seq) & 0xff
    payload.fill(seed)
    view.setUint32(0, PAYLOAD_MAGIC, true)
    view.setUint32(4, tagOf(owner), true)
    view.setUint32(8, tagOf(line), true)
    view.setUint32(12, seq, true)
    view.setUint32(16, bytes, true)
    view.setUint32(bytes - 4, (PAYLOAD_MAGIC ^ seq ^ bytes) >>> 0, true)
    return payload
}

function readIdentity(payloadLike: ArrayBuffer | ArrayBufferView): tFrameIdentity {
    const payload = toBytes(payloadLike)
    if (payload.byteLength < 24) throw new Error('synthetic payload is too short')
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    if (view.getUint32(0, true) != PAYLOAD_MAGIC) throw new Error('synthetic payload magic mismatch')
    const seq = view.getUint32(12, true)
    const declaredBytes = view.getUint32(16, true)
    if (declaredBytes != payload.byteLength) throw new Error('synthetic payload length mismatch')
    if (view.getUint32(payload.byteLength - 4, true) != ((PAYLOAD_MAGIC ^ seq ^ declaredBytes) >>> 0)) {
        throw new Error('synthetic payload tail mismatch')
    }
    return {
        ownerTag: view.getUint32(4, true),
        lineTag: view.getUint32(8, true),
        seq,
        declaredBytes,
    }
}

function makeFrame(owner: string, line: tLine, seq: number, payloadBytes: number) {
    const screen = line == 'screen'
    return encodeMediaFrame({
        kind: 'video-frame',
        codec: seq % 3 == 0 ? 'webp' : 'jpeg',
        seq,
        tMono: seq + 0.25,
        width: screen ? 1920 : 1280,
        height: screen ? 1080 : 720,
    }, makePayload(owner, line, seq, payloadBytes))
}

function frameSequence(frameLike: ArrayBuffer | ArrayBufferView) {
    const frame = decodeMediaFrame(frameLike)
    const identity = readIdentity(frame.payload)
    if (frame.seq != identity.seq) throw new Error('media header/payload sequence mismatch')
    return identity.seq
}

function sequencesAreOrdered(values: number[]) {
    for (let i = 1; i < values.length; i++) {
        if (values[i] <= values[i - 1]) return false
    }
    return true
}

async function createStressServer(roomByAccount: Map<string, string>) {
    const media = createMediaRelay({
        lines: {cam: 'video', screen: 'video'},
        videoHistory: 24,
        canWatch: function canWatch(watcher, owner) {
            const room = roomByAccount.get(watcher)
            return !!room && room == roomByAccount.get(owner)
        },
    })
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer, {
        transports: ['websocket'],
        maxHttpBufferSize: 8 * 1024 * 1024,
        pingTimeout: 20000,
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
            socketKey: 'video-stress',
            object: {
                media: {
                    publish,
                    watch: media.watchOf(account),
                },
            },
            disconnectListen,
        })
    })

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })

    return {
        port: (httpServer.address() as AddressInfo).port,
        media,
        ioServer,
        async close() {
            ioServer.close()
            await new Promise<void>(resolve => httpServer.close(() => resolve()))
        },
    }
}

async function connectParticipant(port: number, account: string) {
    const hub = createRpcClientHub(
        function createSocket() {
            return io(`http://127.0.0.1:${port}`, {
                transports: ['websocket'],
                forceNew: true,
                auth: {account},
            })
        },
        r => ({api: r<any>('video-stress')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.api.readyStrict()
    let closed = false
    return {
        account,
        func: clients.api.func as any,
        close() {
            if (closed) return
            closed = true
            hub.socket?.disconnect?.()
        },
    }
}

function createVideoWindow(deps: {
    watcher: string
    owner: string
    line: tLine
    remote: any
    current?: boolean
    decodeDelayMs?: number
}) {
    const {watcher, owner, line, remote, current = false, decodeDelayMs = 2} = deps
    const rawSeq: number[] = []
    const rawBytes: number[] = []
    const draws: number[] = []
    const errors: string[] = []
    let nativeViews = 0
    let closedBitmaps = 0
    let ended = false

    function collectRawFrame(raw: any) {
        try {
            if (ArrayBuffer.isView(raw)) nativeViews++
            const frame = decodeMediaFrame(toBytes(raw))
            const identity = readIdentity(frame.payload)
            if (identity.ownerTag != tagOf(owner)) throw new Error('owner identity mismatch')
            if (identity.lineTag != tagOf(line)) throw new Error('line identity mismatch')
            if (identity.seq != frame.seq) throw new Error('sequence identity mismatch')
            rawSeq.push(frame.seq)
            rawBytes.push(frame.payload.byteLength)
        } catch (error) {
            errors.push(String((error as any)?.message ?? error))
        }
    }
    // Omitting the options argument is significant for RPC subscription dedup:
    // on(cb) and on(cb, undefined) are distinct wire argument lists.
    const rawHandle = current
        ? remote.on(collectRawFrame, {current: true})
        : remote.on(collectRawFrame)
    function markStreamEnded() {
        ended = true
    }
    void Promise.resolve(rawHandle).then(markStreamEnded, markStreamEnded)

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
            if (decodeDelayMs) await delay(decodeDelayMs)
            const identity = readIdentity(await blob.arrayBuffer())
            return {
                seq: identity.seq,
                close() {
                    closedBitmaps++
                },
            }
        },
        onError(error) {
            errors.push(String((error as any)?.message ?? error))
        },
    })
    let disposed = false

    async function close() {
        if (disposed) return
        disposed = true
        // Dynamic noStrict owner paths are resolved after the initial MAP, so their
        // direct on() result is the pending stream Promise. The node-level teardown
        // remains removeCallback(), which closes both consumers deterministically.
        await remote.removeCallback()
    }

    return {
        key: `${watcher}<-${owner}.${line}`,
        watcher,
        owner,
        line,
        rawSeq,
        rawBytes,
        draws,
        errors,
        canvas,
        view,
        get nativeViews() { return nativeViews },
        get closedBitmaps() { return closedBitmaps },
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

async function expectDenied(label: string, run: () => Promise<any>) {
    let denied = false
    try {
        await run()
    } catch {
        denied = true
    }
    ok(denied, label)
}

async function main() {
    console.log('\n[video-windows-stress] synthetic multi-participant video over real RPC')
    const roomByAccount = new Map(participants.map(item => [item.account, item.room]))
    const server = await createStressServer(roomByAccount)
    const connections = new Map<string, Awaited<ReturnType<typeof connectParticipant>>>()
    const allConnections: Array<Awaited<ReturnType<typeof connectParticipant>>> = []
    const windows: Array<ReturnType<typeof createVideoWindow>> = []
    const observedLines = new Set<any>()

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

    function remoteLine(watcher: string, owner: string, line: tLine) {
        return connections.get(watcher)!.func.media.watch[owner][line]
    }

    async function publish(owner: string, line: tLine, seq: number, payloadBytes: number) {
        const sentAt = Date.now()
        await connections.get(owner)!.func.media.publish(line, makeFrame(owner, line, seq, payloadBytes), sentAt)
    }

    try {
        // ============== concurrent participants and rendered windows ==============
        await Promise.all(participants.map(async function connectCoreParticipant(item) {
            await connect(item.account)
        }))
        ok(server.media.accounts().length == participants.length, 'five publisher/watch participants are live')

        const groups = [
            participants.filter(item => item.room == 'red'),
            participants.filter(item => item.room == 'blue'),
        ]
        for (const group of groups) {
            for (let i = 0; i < group.length; i++) {
                const owner = group[i].account
                const watcher = group[(i + 1) % group.length].account
                for (const line of ['cam', 'screen'] as const) {
                    const window = createVideoWindow({
                        watcher,
                        owner,
                        line,
                        remote: remoteLine(watcher, owner, line),
                        decodeDelayMs: (i + (line == 'screen' ? 2 : 1)) % 4,
                    })
                    windows.push(window)
                    rememberLine(server.media.watchOf(watcher)[owner][line])
                    rememberLine(server.media.lines(owner)[line])
                }
            }
        }
        ok(windows.length == 10, 'ten independent synthetic video windows are attached')

        await waitFor('video callback subscriptions', function callbackSubscriptionsReady() {
            return windows.every(window => server.media.watchOf(window.watcher)[window.owner][window.line].count() == 2)
        })
        ok(true, 'each remote path has exactly its two requested callback consumers: raw + canvas')

        const burst: Promise<void>[] = []
        for (let seq = 1; seq <= CORE_FRAMES; seq++) {
            for (const participant of participants) {
                for (const line of ['cam', 'screen'] as const) {
                    const payloadBytes = seq % 5 == 0 ? 256 * 1024 : 96 * 1024 + seq * 1024
                    burst.push(publish(participant.account, line, seq, payloadBytes))
                }
            }
        }
        await Promise.all(burst)
        await waitFor('all concurrent callback deliveries', function allCallbacksDelivered() {
            return windows.every(window => window.rawSeq.length == CORE_FRAMES)
        })
        ok(windows.every(window => sequencesAreOrdered(window.rawSeq)), 'all ten callback streams preserve strict per-line order')
        ok(windows.every(window => window.rawSeq[0] == 1 && window.rawSeq.at(-1) == CORE_FRAMES),
            'every callback stream receives the complete concurrent burst')
        ok(windows.every(window => window.nativeViews == CORE_FRAMES), 'all large RPC media packets remain native binary views')
        ok(windows.every(window => window.errors.length == 0), 'binary header, owner, line, length and tail survive every callback')
        ok(windows.some(window => window.rawBytes.some(bytes => bytes == 256 * 1024)),
            'the burst includes 256 KiB synthetic encoded-image payloads')

        await delay(100)
        await Promise.all(participants.flatMap(function publishLargeFinal(participant) {
            return (['cam', 'screen'] as const).map(line => publish(participant.account, line, CORE_FRAMES + 1, LARGE_FRAME_BYTES))
        }))
        await waitFor('large final frames rendered', function finalFramesRendered() {
            return windows.every(window => window.rawSeq.at(-1) == CORE_FRAMES + 1 && window.draws.at(-1) == CORE_FRAMES + 1)
        })
        ok(windows.every(window => window.rawBytes.at(-1) == LARGE_FRAME_BYTES),
            'ten 512 KiB final frames arrive byte-complete')
        ok(windows.every(window => window.closedBitmaps == window.draws.length),
            'every synthetic bitmap drawn by a video window is closed')
        ok(windows.some(window => window.view.stats().drawn < window.view.stats().frames),
            'slow render windows busy-skip overload instead of building an unbounded decode queue')

        // ============== isolation and live policy changes ==============
        await expectDenied('blue participant cannot resolve a red-room video line', async function forbiddenBlueToRed() {
            await connections.get('blue-a')!.func.media.watch['red-a'].cam.keyframe()
        })
        await expectDenied('red participant cannot resolve a blue-room video line', async function forbiddenRedToBlue() {
            await connections.get('red-a')!.func.media.watch['blue-a'].screen.keyframe()
        })

        const revokedCam = windows.find(window => window.watcher == 'red-b' && window.owner == 'red-a' && window.line == 'cam')!
        const revokedScreen = windows.find(window => window.watcher == 'red-b' && window.owner == 'red-a' && window.line == 'screen')!
        const beforeRevokedCam = revokedCam.rawSeq.length
        const beforeRevokedScreen = revokedScreen.rawSeq.length
        roomByAccount.set('red-b', 'quarantine')
        await Promise.all([
            publish('red-a', 'cam', CORE_FRAMES + 2, 128 * 1024),
            publish('red-a', 'screen', CORE_FRAMES + 2, 128 * 1024),
        ])
        await delay(100)
        ok(revokedCam.rawSeq.length == beforeRevokedCam && revokedScreen.rawSeq.length == beforeRevokedScreen,
            'revocation blocks an already-open pair of video subscriptions')
        await expectDenied('revocation also blocks a fresh keyframe resolution', async function forbiddenAfterRevoke() {
            await connections.get('red-b')!.func.media.watch['red-a'].cam.keyframe()
        })

        roomByAccount.set('red-b', 'red')
        await Promise.all([
            publish('red-a', 'cam', CORE_FRAMES + 3, 128 * 1024),
            publish('red-a', 'screen', CORE_FRAMES + 3, 128 * 1024),
        ])
        await waitFor('regranted live subscriptions', function regrantedFramesArrive() {
            return revokedCam.rawSeq.at(-1) == CORE_FRAMES + 3
                && revokedScreen.rawSeq.at(-1) == CORE_FRAMES + 3
        })
        const regrantKeyframe = await connections.get('red-b')!.func.media.watch['red-a'].cam.keyframe()
        ok(frameSequence(regrantKeyframe.event[0]) == CORE_FRAMES + 3,
            'regrant resumes live delivery and exposes only the newest video keyframe')

        // ============== one window stops, misses traffic, then catches current ==============
        const stopped = windows.find(window => window.watcher == 'red-c' && window.owner == 'red-b' && window.line == 'cam')!
        const stoppedLine = rememberLine(server.media.watchOf('red-c')['red-b'].cam)
        const stoppedCount = stopped.rawSeq.length
        await stopped.close()
        await waitFor('stopped window unsubscribed', () => stoppedLine.count() == 0)
        await publish('red-b', 'cam', CORE_FRAMES + 2, 160 * 1024)
        await delay(80)
        ok(stopped.rawSeq.length == stoppedCount, 'stopped window receives no late callback')

        const missedKeyframe = await remoteLine('red-c', 'red-b', 'cam').keyframe()
        ok(frameSequence(missedKeyframe.event[0]) == CORE_FRAMES + 2,
            'stopped window can recover the latest frame without replaying old video')
        const rejoinedWindow = createVideoWindow({
            watcher: 'red-c',
            owner: 'red-b',
            line: 'cam',
            remote: remoteLine('red-c', 'red-b', 'cam'),
            current: true,
        })
        windows.push(rejoinedWindow)
        await waitFor('current frame on rejoined window', () => rejoinedWindow.rawSeq[0] == CORE_FRAMES + 2)
        await publish('red-b', 'cam', CORE_FRAMES + 3, LARGE_FRAME_BYTES)
        await waitFor('live frame after window rejoin', function liveAfterWindowRejoin() {
            return rejoinedWindow.rawSeq.at(-1) == CORE_FRAMES + 3
                && rejoinedWindow.draws.at(-1) == CORE_FRAMES + 3
        })
        ok(rejoinedWindow.rawSeq.join(',') == `${CORE_FRAMES + 2},${CORE_FRAMES + 3}`,
            'current:true gives one current frame, followed by new live traffic')

        // ============== real createVideoSource without a camera ==============
        roomByAccount.set('camera-bot', 'green')
        roomByAccount.set('camera-viewer', 'green')
        await Promise.all([connect('camera-bot'), connect('camera-viewer')])
        const sourceWindow = createVideoWindow({
            watcher: 'camera-viewer',
            owner: 'camera-bot',
            line: 'cam',
            remote: remoteLine('camera-viewer', 'camera-bot', 'cam'),
        })
        windows.push(sourceWindow)
        rememberLine(server.media.watchOf('camera-viewer')['camera-bot'].cam)
        rememberLine(server.media.lines('camera-bot').cam)
        await waitFor('camera source viewer subscription', function sourceViewerReady() {
            return server.media.watchOf('camera-viewer')['camera-bot'].cam.count() == 2
        })

        let capturedSeq = 0
        let stoppedTracks = 0
        const sourceErrors: unknown[] = []
        const source = createVideoSource({
            sourceId: 'synthetic-camera',
            fps: 30,
            width: 1280,
            height: 720,
            worker: false,
            stream: function createSyntheticStream() {
                const track = {stop() { stoppedTracks++ }}
                return {
                    getTracks: () => [track],
                    getVideoTracks: () => [track],
                }
            },
            video: {
                videoWidth: 1280,
                videoHeight: 720,
                async play() {},
            },
            canvas: {
                width: 0,
                height: 0,
                getContext: () => ({drawImage() {}}),
                async convertToBlob() {
                    const payload = makePayload('camera-bot', 'cam', ++capturedSeq, 96 * 1024)
                    return {arrayBuffer: async () => payload.buffer}
                },
            },
        })
        const offPipe = pipeMediaPublish(source[1], function publishSyntheticCapture(frame, sentAt) {
            return connections.get('camera-bot')!.func.media.publish('cam', frame, sentAt)
        }, {onError: error => sourceErrors.push(error)})

        ok(await source.start() == 'live', 'synthetic createVideoSource starts without camera/browser globals')
        await waitFor('first synthetic capture run', () => sourceWindow.rawSeq.length >= 6)
        source.stop()
        await delay(120)
        const stoppedAt = sourceWindow.rawSeq.length
        await delay(150)
        ok(sourceWindow.rawSeq.length == stoppedAt, 'stopping the synthetic source stops publish callbacks')

        ok(await source.start() == 'live', 'the same synthetic video source restarts cleanly')
        await waitFor('second synthetic capture run', () => sourceWindow.rawSeq.length >= stoppedAt + 4)
        source.stop()
        offPipe()
        await delay(100)
        ok(sequencesAreOrdered(sourceWindow.rawSeq), 'capture sequence remains ordered across source stop/restart')
        ok(stoppedTracks == 2 && sourceErrors.length == 0, 'both synthetic MediaStreams are released and publish pipe stays healthy')
        ok(source.getStats().frames >= 10 && source.getStats().bytes >= 10 * 96 * 1024,
            'source statistics account for the sustained large-frame capture')

        // ============== publisher disconnect/rejoin creates a fresh generation ==============
        const oldBlueCam = windows.find(window => window.watcher == 'blue-a' && window.owner == 'blue-b' && window.line == 'cam')!
        const oldBlueScreen = windows.find(window => window.watcher == 'blue-a' && window.owner == 'blue-b' && window.line == 'screen')!
        const oldCamCount = oldBlueCam.rawSeq.length
        const oldScreenCount = oldBlueScreen.rawSeq.length
        const oldSourceLine = rememberLine(server.media.lines('blue-b').cam)
        const oldFilteredLine = rememberLine(server.media.watchOf('blue-a')['blue-b'].cam)
        connections.get('blue-b')!.close()
        connections.delete('blue-b')
        await waitFor('publisher generation removed', function oldPublisherRemoved() {
            return !server.media.accounts().includes('blue-b')
                && oldBlueCam.ended
                && oldBlueScreen.ended
        })
        oldBlueCam.abandon()
        oldBlueScreen.abandon()
        ok(oldSourceLine.count() == 0 && oldFilteredLine.count() == 0,
            'publisher disconnect closes its source and all watcher-side filtered lines')

        await connect('blue-b')
        const freshBlueCam = createVideoWindow({
            watcher: 'blue-a',
            owner: 'blue-b',
            line: 'cam',
            remote: remoteLine('blue-a', 'blue-b', 'cam'),
        })
        const freshBlueScreen = createVideoWindow({
            watcher: 'blue-a',
            owner: 'blue-b',
            line: 'screen',
            remote: remoteLine('blue-a', 'blue-b', 'screen'),
        })
        windows.push(freshBlueCam, freshBlueScreen)
        rememberLine(server.media.lines('blue-b').cam)
        rememberLine(server.media.lines('blue-b').screen)
        rememberLine(server.media.watchOf('blue-a')['blue-b'].cam)
        rememberLine(server.media.watchOf('blue-a')['blue-b'].screen)
        await waitFor('fresh publisher subscriptions', function freshSubscriptionsReady() {
            return server.media.watchOf('blue-a')['blue-b'].cam.count() == 2
                && server.media.watchOf('blue-a')['blue-b'].screen.count() == 2
        })
        await Promise.all([
            publish('blue-b', 'cam', 1, LARGE_FRAME_BYTES),
            publish('blue-b', 'screen', 1, LARGE_FRAME_BYTES),
        ])
        await waitFor('fresh publisher generation visible', function freshPublisherVisible() {
            return freshBlueCam.rawSeq[0] == 1 && freshBlueScreen.rawSeq[0] == 1
        })
        ok(oldBlueCam.rawSeq.length == oldCamCount && oldBlueScreen.rawSeq.length == oldScreenCount,
            'closed generation receives nothing after the same publisher account rejoins')
        const freshBlueKeyframe = await remoteLine('blue-a', 'blue-b', 'screen').keyframe()
        ok(frameSequence(freshBlueKeyframe.event[0]) == 1,
            'rejoined publisher exposes a fresh latest-frame generation')

        // ============== abrupt viewer cleanup and local callback dedup ==============
        roomByAccount.set('spectator-red', 'red')
        await connect('spectator-red')
        const redCSource = rememberLine(server.media.lines('red-c').cam)
        const sourceListenersBefore = redCSource.count()
        const spectatorWindows = Array.from({length: 4}, function makeDuplicateWindow() {
            const window = createVideoWindow({
                watcher: 'spectator-red',
                owner: 'red-c',
                line: 'cam',
                remote: remoteLine('spectator-red', 'red-c', 'cam'),
            })
            windows.push(window)
            return window
        })
        const spectatorFiltered = rememberLine(server.media.watchOf('spectator-red')['red-c'].cam)
        await waitFor('bounded spectator subscriptions', function spectatorReady() {
            return spectatorFiltered.count() == 8 && redCSource.count() == sourceListenersBefore + 1
        })
        ok(true, 'four windows allocate exactly eight requested callbacks and one filtered source forwarder')

        connections.get('spectator-red')!.close()
        connections.delete('spectator-red')
        await waitFor('abrupt spectator cleanup', function spectatorCleaned() {
            return !server.media.accounts().includes('spectator-red')
                && spectatorFiltered.count() == 0
                && redCSource.count() == sourceListenersBefore
                && spectatorWindows.every(window => window.ended)
        })
        ok(true, 'socket disconnect removes watcher cache, callbacks and source forwarding listener')
        const spectatorCounts = spectatorWindows.map(window => window.rawSeq.length)
        await publish('red-c', 'cam', CORE_FRAMES + 2, 128 * 1024)
        await delay(100)
        ok(spectatorWindows.every((window, index) => window.rawSeq.length == spectatorCounts[index]),
            'no callback reaches abruptly closed video windows')
        for (const window of spectatorWindows) window.abandon()

        // ============== full cleanup ==============
        await Promise.all(windows.map(function closeWindow(window) {
            return window.close().catch(function ignoreAlreadyClosedWindow() {})
        }))
        for (const connection of allConnections) connection.close()
        connections.clear()
        await waitFor('all relay accounts removed', () => server.media.accounts().length == 0)
        await waitFor('all observed media listeners removed', function allListenersRemoved() {
            return Array.from(observedLines).every(line => line.count() == 0)
        })
        ok(server.ioServer.sockets.sockets.size == 0, 'Socket.IO has no participant connections after teardown')
        ok(true, 'all observed source, filtered and RPC callback listener counts return to zero')
    } finally {
        for (const window of windows) window.dispose()
        for (const connection of allConnections) connection.close()
        await delay(50)
        server.media.close()
        await server.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function onFatal(error) {
    console.error(error)
    process.exit(1)
})
