// ============================================================
//  replay/canvas-socket.test.ts
//
//  "Canvas stream": real BYTES (Uint8Array RGBA) as frames over a
//  replay line on REAL Socket.IO. Verifies binary passthrough
//  in rpc-walk: bytes travel as binary (socket.io native), not {0:…,1:…}.
//
//  A frame = a byte buffer; a delta (P-frame) = a dirty-rect with bytes;
//  keyframe (I-frame) = the full frame buffer. Memory is external: the server
//  owns the "current frame" itself, current() returns a copy of it.
//
//  Run: npx ts-node replay/canvas-socket.test.ts
// ============================================================

import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import {replayListen, exposeReplay, replaySubscribe, ReplayRemote} from '../src/Common/events/replay-index'

const W = 64, H = 48, BPP = 4  // 12288 bytes per frame

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Delta-frame: rectangle of pixels with RAW bytes (like canvas putImageData). */
type Rect = {x: number, y: number, w: number, h: number, bytes: Uint8Array}

function blitRect(screen: Uint8Array, r: Rect) {
    for (let row = 0; row < r.h; row++) {
        const src = r.bytes.subarray(row * r.w * BPP, (row + 1) * r.w * BPP)
        screen.set(src, ((r.y + row) * W + r.x) * BPP)
    }
}

function fillRect(x: number, y: number, w: number, h: number, rgba: number[]): Rect {
    const bytes = new Uint8Array(w * h * BPP)
    for (let i = 0; i < w * h; i++) bytes.set(rgba, i * BPP)
    return {x, y, w, h, bytes}
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
    a.byteLength == b.byteLength && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) == 0

// binary received over wire comes as Buffer/Uint8Array — normalize view
const asBytes = (v: any): Uint8Array => v instanceof Uint8Array ? v : new Uint8Array(v.buffer ?? v)

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
            socketKey: 'canvas',
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

async function connectViewer(port: number) {
    const hub = createRpcClientHub(
        () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true}),
        r => ({api: r<any>('canvas')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.api.readyStrict()
    const deep = clients.api.func as any
    const remote: ReplayRemote<[Rect]> = {
        line: deep.replay.line,
        since: (s: number) => deep.replay.since(s),
        keyframe: () => deep.replay.keyframe(),
    }
    return {remote, close: () => hub.socket?.disconnect?.()}
}

async function main() {
    console.log('\n[canvas] raw RGBA byte stream over a real Socket.IO wire')

    // ============ server: canvas + line of deltas ============
    const frame = new Uint8Array(W * H * BPP)  // external memory: server owns current frame
    const [emitRect, line] = replayListen<[Rect]>({
        current: () => [{x: 0, y: 0, w: W, h: H, bytes: frame.slice()}],  // keyframe = full frame
        history: 24,
    })
    function draw(r: Rect) {
        blitRect(frame, r)
        emitRect(r)
    }
    const server = await startRealServer({replay: exposeReplay(line)})

    let px = 0
    function paintTick() {
        draw(fillRect(px, 10, 4, 4, [0, 0, 0, 255]))          // erase old square
        px = (px + 4) % (W - 4)
        draw(fillRect(px, 10, 4, 4, [255, 64, 0, 255]))       // draw new
    }
    // background + first frames before viewer connects
    draw(fillRect(0, 0, W, H, [0, 0, 0, 255]))
    for (let i = 0; i < 10; i++) paintTick()

    const closers: (() => void)[] = []
    try {
        // ============ viewer comes AFTER 21 events ============
        const viewer = await connectViewer(server.port)
        closers.push(viewer.close)
        const screen = new Uint8Array(W * H * BPP)
        let deliveries = 0
        let lastSeq = -1
        let binaryOnWire = true
        const sub = replaySubscribe<[Rect]>(viewer.remote, function applyRect(r) {
            if (!ArrayBuffer.isView(r.bytes)) binaryOnWire = false  // {0:…,1:…} — passthrough failure
            blitRect(screen, {...r, bytes: asBytes(r.bytes)})
            deliveries++
        }, {onSeq: s => lastSeq = s})
        await sub.ready
        ok(binaryOnWire, 'bytes traveled as REAL binary (TypedArray/Buffer), not a {0:…} dictionary')
        ok(deliveries == 1, `late viewer got 1 keyframe, not a ${line.head()}-event backlog`)
        ok(sameBytes(screen, frame), 'keyframe is byte-for-byte identical to the server canvas')

        // ============ live-deltas ============
        for (let i = 0; i < 5; i++) paintTick()
        await delay(150)
        ok(sameBytes(screen, frame), 'live dirty-rect deltas keep the canvas pixel-perfect')

        // ============ lag → reconnect via tail of deltas ============
        sub()
        paintTick(); paintTick()  // 4 events past viewer, journal (24) holds them
        let tailDeliveries = 0
        const sub2 = replaySubscribe<[Rect]>(viewer.remote, function applyRect(r) {
            blitRect(screen, {...r, bytes: asBytes(r.bytes)})
            tailDeliveries++
        }, {since: lastSeq, onSeq: s => lastSeq = s})
        await sub2.ready
        ok(tailDeliveries == 4, `short lag → tail of 4 rect deltas, no keyframe (got ${tailDeliveries})`)
        ok(sameBytes(screen, frame), 'after catch-up the canvas is pixel-perfect again')

        // ============ long lag → journal evicted → keyframe ============
        sub2()
        for (let i = 0; i < 30; i++) paintTick()  // 60 events >> history 24
        let resync = 0
        const sub3 = replaySubscribe<[Rect]>(viewer.remote, function applyRect(r) {
            blitRect(screen, {...r, bytes: asBytes(r.bytes)})
            resync++
        }, {since: lastSeq})
        await sub3.ready
        ok(resync == 1, `long lag → 60 missed deltas collapsed into 1 keyframe (got ${resync})`)
        ok(sameBytes(screen, frame), 'keyframe recovery is byte-for-byte exact')
        sub3()

        const kb = (n: number) => `${Math.round(n / 102.4) / 10}kb`
        console.log(`\n  frame = ${kb(frame.byteLength)} raw; mangled {0:…} JSON of the same frame would be ~${kb(JSON.stringify({...frame.slice(0, 256)}).length * (frame.byteLength / 256))}`)
        console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    } finally {
        for (const close of closers) close()
        await delay(20)
        await server.close()
    }
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
