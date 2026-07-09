// ============================================================
//  replay/video-socket.demo.ts
//
//  «Видео» через replay-линию по НАСТОЯЩЕМУ Socket.IO:
//  сервер стримит анимацию (мячик в ASCII-кадре) как store-патчи.
//  Кадр = состояние стора; дельта-кадр (P-frame) = патчи строк;
//  keyframe (I-frame) = снапшот. Ровно та же механика, что у
//  маркет-даты/зеркала стора — payload-agnostic.
//
//    - зритель A смотрит с начала (все дельты)
//    - зритель B приходит к СЕРЕДИНЕ фильма: получает keyframe
//      текущей картинки + live, а НЕ бэклог прошедших кадров
//    - зритель B «лагает» (обрыв на несколько кадров): реконнект
//      через since → только пропущенный хвост дельт
//
//  Запуск: npx ts-node replay/video-socket.demo.ts
// ============================================================

import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import {createStore, StorePatch} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {exposeStoreReplay, syncStoreReplay} from '../src/Common/Observe/store-replay'
import {ReplayRemote} from '../src/Common/events/replay-index'

const W = 32, H = 10, FRAMES = 60
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const json = (v: any) => JSON.stringify(v)

type Video = {
    tick: number
    rows: Record<number, string>
}

function assert(cond: any, message: string) {
    if (!cond) throw new Error(`FAIL: ${message}`)
    console.log('  OK  ', message)
}

// ============ «кодек»: мячик по кадру ============
function renderRow(y: number, bx: number, by: number) {
    let row = ''
    for (let x = 0; x < W; x++) row += (x == bx && y == by) ? 'O' : '·'
    return row
}

function paintFrame(video: Video, bx: number, by: number, prevBy: number) {
    // дельта-кадр: перерисовываем только изменившиеся строки (P-frame)
    video.rows[prevBy] = renderRow(prevBy, -1, -1)
    video.rows[by] = renderRow(by, bx, by)
    video.tick++
}

function printFrame(title: string, video: Video) {
    console.log(`\n  ${title} (tick ${video.tick})`)
    for (let y = 0; y < H; y++) console.log('  ' + (video.rows[y] ?? ''.padEnd(W, '?')))
}

// ============ провод ============
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
            socketKey: 'video',
            object,
            disconnectListen,
        })
    })
    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    const port = (httpServer.address() as AddressInfo).port
    return {
        port,
        close: () => new Promise<void>(resolve => {
            ioServer.close()
            httpServer.close(() => resolve())
        }),
    }
}

async function connectViewer(port: number, name: string) {
    const hub = createRpcClientHub(
        () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true}),
        r => ({api: r<any>('video')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.api.readyStrict()
    const deep = clients.api.func as any
    const remote: ReplayRemote<[StorePatch]> = {
        line: deep.replay.line,
        since: (s: number) => deep.replay.since(s),
        keyframe: () => deep.replay.keyframe(),
    }
    console.log(`  [${name}] connected`)
    return {remote, close: () => hub.socket?.disconnect?.()}
}

async function main() {
    console.log('\n[video] bouncing ball over a real Socket.IO wire')

    // ============ сервер: «съёмка» ============
    const film = createStore<Video>({tick: 0, rows: Object.fromEntries(
        Array.from({length: H}, (_, y) => [y, renderRow(y, 2, 3)]),
    )})
    const exposed = exposeStoreReplay(film, {history: 40})  // журнал ~13 кадров (3 патча/кадр)
    const stats = {keyframe: 0, since: 0}
    const facade = {
        ...exposed.api,
        replay: {
            ...exposed.api.replay,
            since: (s: number) => { stats.since++; return exposed.api.replay.since(s) },
            keyframe: () => { stats.keyframe++; return exposed.api.replay.keyframe() },
        },
    }
    const server = await startRealServer(facade)

    let bx = 2, by = 3, dx = 1, dy = 1
    async function playFrames(n: number) {
        for (let i = 0; i < n; i++) {
            const prevBy = by
            bx += dx; by += dy
            if (bx <= 0 || bx >= W - 1) dx = -dx
            if (by <= 0 || by >= H - 1) dy = -dy
            paintFrame(film.state, bx, by, prevBy)
            await flushReactive(film.state)
            await delay(15)  // ~66 fps
        }
    }

    const closers: (() => void)[] = []
    try {
        // ============ зритель A: с первого кадра ============
        const a = await connectViewer(server.port, 'viewer A')
        closers.push(a.close)
        const screenA = createStore<Video>({tick: -1, rows: {}})
        let seqA = -1
        const subA = syncStoreReplay(screenA, a.remote, {onSeq: s => seqA = s})
        await subA.ready

        await playFrames(25)
        await delay(60)
        assert(json(screenA.state) == json(film.snapshot()), 'viewer A is frame-perfect after 25 frames')

        // ============ зритель B: опоздал к середине фильма ============
        const b = await connectViewer(server.port, 'viewer B (late)')
        closers.push(b.close)
        const screenB = createStore<Video>({tick: -1, rows: {}})
        let seqB = -1
        let framesTraveledToB = 0
        const subB = syncStoreReplay(screenB, b.remote, {onSeq: s => { seqB = s; framesTraveledToB++ }})
        await subB.ready
        assert(json(screenB.state) == json(film.snapshot()), 'late viewer B got the CURRENT picture instantly')
        assert(framesTraveledToB == 1, `keyframe, not a 25-frame backlog (deliveries: ${framesTraveledToB})`)
        printFrame('viewer B first sees', screenB.state)

        // ============ зритель B лагает: короткий обрыв → хвост дельт ============
        subB()
        const kfBefore = stats.keyframe
        await playFrames(4)   // 12 патчей мимо B — влезают в журнал (40)
        let lagDeliveries = 0
        const subB2 = syncStoreReplay(screenB, b.remote, {since: seqB, onSeq: s => { seqB = s; lagDeliveries++ }})
        await subB2.ready
        assert(json(screenB.state) == json(film.snapshot()), 'lagging viewer B caught up via delta tail')
        assert(stats.keyframe == kfBefore, `no keyframe needed for a short lag (tail of ${lagDeliveries} patches)`)

        // ============ финал: все смотрят одно и то же ============
        await playFrames(FRAMES - 29)
        await delay(80)
        assert(json(screenA.state) == json(film.snapshot()), 'final frame: viewer A pixel-perfect')
        assert(json(screenB.state) == json(film.snapshot()), 'final frame: viewer B pixel-perfect')
        printFrame('final frame, both screens', screenB.state)
        console.log(`\n  server stats: keyframes served = ${stats.keyframe}, tail requests = ${stats.since}`)
        console.log('\nALL OK: video over replay line passed')
        subA()
        subB2()
    } finally {
        for (const close of closers) close()
        await delay(20)
        exposed.close()
        await server.close()
    }
}

main().catch(e => { console.error(e); process.exit(1) })
