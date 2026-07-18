// ============================================================
//  replay/media-socket.test.ts
//
//  Media over socket smoke oracle:
//  - fixed binary header + payload for audio/video frames
//  - createAudioSource/createVideoSource are plain binary Listens
//  - frames cross real Socket.IO/RPC as native binary, not a {0:...} object
//  - browser capture absence returns typed state in Node, not throw
// ============================================================

import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {
    MEDIA_FRAME_HEADER_BYTES,
    createAudioSource,
    createVideoSource,
    decodeMediaFrame,
    encodeMediaFrame,
} from '../src/Common/media/media-index'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function sameBytes(a: Uint8Array, b: Uint8Array) {
    return a.byteLength == b.byteLength
        && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) == 0
}

function asBytes(v: any): Uint8Array {
    if (v instanceof Uint8Array) return v
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    return new Uint8Array(v)
}

async function startRealServer(object: object) {
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})
    ioServer.on('connection', socket => {
        const [disconnect, disconnectListen] = createListenPair<[]>()
        socket.on('disconnect', () => disconnect())
        createRpcServerAuto({
            socket: {
                emit: (key, data) => socket.emit(key, data),
                on: (key, cb) => socket.on(key, cb),
            },
            socketKey: 'media',
            object,
            disconnectListen,
        })
    })
    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    return {
        port: (httpServer.address() as AddressInfo).port,
        close: () => new Promise<void>(resolve => {
            ioServer.close()
            httpServer.close(() => resolve())
        }),
    }
}

async function connectClient<T extends object>(port: number) {
    const hub = createRpcClientHub(
        () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true}),
        r => ({api: r<T>('media')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.api.readyStrict()
    return {client: clients.api, close: () => hub.socket?.disconnect?.()}
}

async function waitFor(label: string, cond: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (cond()) return
        await delay(20)
    }
    throw new Error(`timeout: ${label}`)
}

async function main() {
    console.log('\n[media] fixed binary frames over a real Socket.IO wire')

    const pcm = new Int16Array([0, 1000, -1000, 32767, -32768])
    const audioFrame = encodeMediaFrame({
        kind: 'audio-pcm',
        codec: 'pcm16',
        seq: 7,
        tMono: 123.5,
        sampleRate: 16000,
        channels: 1,
        nSamples: pcm.length,
    }, new Uint8Array(pcm.buffer))
    const decodedAudio = decodeMediaFrame(audioFrame)
    ok(audioFrame.byteLength == MEDIA_FRAME_HEADER_BYTES + pcm.byteLength, 'audio frame is fixed header + raw PCM payload')
    ok(decodedAudio.kind == 'audio-pcm' && decodedAudio.codec == 'pcm16', 'audio kind/codec decode from binary header')
    ok(decodedAudio.sampleRate == 16000 && decodedAudio.nSamples == pcm.length, 'audio sample metadata decode from binary header')
    ok(sameBytes(decodedAudio.payload, new Uint8Array(pcm.buffer)), 'audio payload stays byte-for-byte')

    const jpg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
    const videoFrame = encodeMediaFrame({
        kind: 'video-frame',
        codec: 'jpeg',
        seq: 2,
        tMono: 200,
        width: 320,
        height: 240,
    }, jpg)
    const decodedVideo = decodeMediaFrame(videoFrame)
    ok(decodedVideo.width == 320 && decodedVideo.height == 240, 'video dimensions decode from binary header')
    ok(sameBytes(decodedVideo.payload, jpg), 'video payload stays byte-for-byte')

    const audio = createAudioSource({sourceId: 'mic'})
    const video = createVideoSource({sourceId: 'cam'})
    const replayVideo = createVideoSource({sourceId: 'cam-replay', replay: true})
    ok(audio.kind == 'audio' && video.kind == 'video', 'media factories return control + [emit, listen] tuple')
    ok(!!(replayVideo[1] as any).line && typeof (replayVideo[1] as any).frame == 'function', 'media replay:true returns replay-listen surface for RPC auto exposure')
    ok(await audio.start() == 'no-device', 'Node without getUserMedia returns typed no-device state, not throw')
    ok(await video.start() == 'no-device', 'video source also returns typed no-device state without browser globals')
    ok(audio.state == 'no-device' && audio.getStats().state == 'no-device', 'audio state getter stays live after construction')
    ok(video.state == 'no-device' && video.getStats().state == 'no-device', 'video state getter stays live after construction')

    const [emitAudio, audioListen] = audio
    const server = await startRealServer({audio: audioListen})
    const client = await connectClient<{audio: typeof audioListen}>(server.port)
    try {
        const got: Uint8Array[] = []
        const deep = client.client.func as any
        deep.audio.callback((frame: any) => got.push(asBytes(frame)))
        await delay(100)
        emitAudio(audioFrame)
        await waitFor('binary media frame over rpc', () => got.length == 1)
        const overWire = decodeMediaFrame(got[0])
        ok(ArrayBuffer.isView(got[0]), 'RPC delivered media frame as native binary view')
        ok(sameBytes(overWire.payload, decodedAudio.payload), 'RPC media payload survived byte-for-byte')
        ok(overWire.seq == 7 && overWire.sampleRate == 16000, 'RPC media header survived byte-for-byte')
    } finally {
        client.close()
        await delay(20)
        await server.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
