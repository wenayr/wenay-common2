// ============================================================
//  replay/canvas-socket.test.ts
//
//  «Канвас-стрим»: настоящие БАЙТЫ (Uint8Array RGBA) кадрами через
//  replay-линию по НАСТОЯЩЕМУ Socket.IO. Проверяет binary passthrough
//  в rpc-walk: байты едут бинарём (socket.io native), а не {0:…,1:…}.
//
//  Кадр = байтовый буфер; дельта (P-frame) = dirty-rect с байтами;
//  keyframe (I-frame) = полный буфер кадра. Память внешняя: сервер
//  сам владеет «текущим кадром», current() отдаёт его копию.
//
//  Запуск: npx ts-node replay/canvas-socket.test.ts
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

const W = 64, H = 48, BPP = 4  // 12288 байт на кадр

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Дельта-кадр: прямоугольник пикселей с СЫРЫМИ байтами (как canvas putImageData). */
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

// принятый по проводу бинарь приходит как Buffer/Uint8Array — нормализуем вид
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

    // ============ сервер: канвас + линия дельт ============
    const frame = new Uint8Array(W * H * BPP)  // внешняя память: текущий кадр владеет сервер
    const [emitRect, line] = replayListen<[Rect]>({
        current: () => [{x: 0, y: 0, w: W, h: H, bytes: frame.slice()}],  // keyframe = полный кадр
        history: 24,
    })
    function draw(r: Rect) {
        blitRect(frame, r)
        emitRect(r)
    }
    const server = await startRealServer({replay: exposeReplay(line)})

    let px = 0
    function paintTick() {
        draw(fillRect(px, 10, 4, 4, [0, 0, 0, 255]))          // стереть старый квадрат
        px = (px + 4) % (W - 4)
        draw(fillRect(px, 10, 4, 4, [255, 64, 0, 255]))       // нарисовать новый
    }
    // фон + первые кадры до подключения зрителя
    draw(fillRect(0, 0, W, H, [0, 0, 0, 255]))
    for (let i = 0; i < 10; i++) paintTick()

    const closers: (() => void)[] = []
    try {
        // ============ зритель приходит ПОСЛЕ 21 события ============
        const viewer = await connectViewer(server.port)
        closers.push(viewer.close)
        const screen = new Uint8Array(W * H * BPP)
        let deliveries = 0
        let lastSeq = -1
        let binaryOnWire = true
        const sub = replaySubscribe<[Rect]>(viewer.remote, function applyRect(r) {
            if (!ArrayBuffer.isView(r.bytes)) binaryOnWire = false  // {0:…,1:…} — провал passthrough
            blitRect(screen, {...r, bytes: asBytes(r.bytes)})
            deliveries++
        }, {onSeq: s => lastSeq = s})
        await sub.ready
        ok(binaryOnWire, 'bytes traveled as REAL binary (TypedArray/Buffer), not a {0:…} dictionary')
        ok(deliveries == 1, `late viewer got 1 keyframe, not a ${line.head()}-event backlog`)
        ok(sameBytes(screen, frame), 'keyframe is byte-for-byte identical to the server canvas')

        // ============ live-дельты ============
        for (let i = 0; i < 5; i++) paintTick()
        await delay(150)
        ok(sameBytes(screen, frame), 'live dirty-rect deltas keep the canvas pixel-perfect')

        // ============ лаг → реконнект хвостом дельт ============
        sub()
        paintTick(); paintTick()  // 4 события мимо зрителя, журнал (24) их держит
        let tailDeliveries = 0
        const sub2 = replaySubscribe<[Rect]>(viewer.remote, function applyRect(r) {
            blitRect(screen, {...r, bytes: asBytes(r.bytes)})
            tailDeliveries++
        }, {since: lastSeq, onSeq: s => lastSeq = s})
        await sub2.ready
        ok(tailDeliveries == 4, `short lag → tail of 4 rect deltas, no keyframe (got ${tailDeliveries})`)
        ok(sameBytes(screen, frame), 'after catch-up the canvas is pixel-perfect again')

        // ============ долгий лаг → журнал вытеснен → keyframe ============
        sub2()
        for (let i = 0; i < 30; i++) paintTick()  // 60 событий >> history 24
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
