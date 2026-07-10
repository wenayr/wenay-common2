// ============================================================
//  replay/socket-replay.test.ts
//
//  Слой B через НАСТОЯЩИЙ Socket.IO localhost WebSocket:
//  зеркало стора по replay-линии (keyframe + seq-дельты).
//  Запуск:
//      npx ts-node replay/socket-replay.test.ts
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

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const json = (v: any) => JSON.stringify(v)

async function waitFor(label: string, cond: () => boolean) {
    for (let i = 0; i < 120; i++) {
        if (cond()) return
        await delay(25)
    }
    throw new Error(`timeout: ${label}`)
}

type World = {
    units: Record<string, {hp: number, x: number}>
    tick: number
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
            socketKey: 'replay-store',
            object,
            disconnectListen,
        })
    })
    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    const port = (httpServer.address() as AddressInfo).port
    console.log(`  [server] listening on 127.0.0.1:${port}`)
    return {
        port,
        close: () => new Promise<void>(resolve => {
            ioServer.close()
            httpServer.close(() => resolve())
        }),
    }
}

async function startRealClient<T extends object>(port: number) {
    const hub = createRpcClientHub(
        () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true}),
        r => ({api: r<T>('replay-store')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.api.readyStrict()
    return {
        client: clients.api,
        close: () => hub.socket?.disconnect?.(),
    }
}

async function main() {
    console.log('\n[socket-replay] store mirror over a real Socket.IO wire')

    const backend = createStore<World>({units: {alpha: {hp: 100, x: 0}}, tick: 0}, {drain: 'micro'})
    const exposed = exposeStoreReplay(backend, {history: 6})

    // счётчики серверной цены: pull-ов быть не должно, keyframe — только по fallback
    const counters = {get: 0, since: 0, keyframe: 0}
    const facade = {
        ...exposed.api,
        get: (mask?: any) => { counters.get++; return exposed.api.get(mask) },
        replay: {
            ...exposed.api.replay,
            since: (s: number) => { counters.since++; return exposed.api.replay.since(s) },
            keyframe: () => { counters.keyframe++; return exposed.api.replay.keyframe() },
        },
    }

    type Client = Awaited<ReturnType<typeof startRealClient<typeof facade>>>
    const server = await startRealServer(facade)
    let c1: Client | null = null
    let c2: Client | null = null

    try {
        // ============ свежий клиент: keyframe + live ============
        c1 = await startRealClient<typeof facade>(server.port)
        const deep1 = c1.client.func as any
        const remote1: ReplayRemote<[StorePatch]> = {
            line: deep1.replay.line,
            since: (s: number) => deep1.replay.since(s),
            keyframe: () => deep1.replay.keyframe(),
        }
        const mirror = createStore<World>({units: {}, tick: -1})
        let lastSeq = -1
        const sub = syncStoreReplay(mirror, remote1, {onSeq: s => lastSeq = s})
        await sub.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'fresh client converged via keyframe over the wire')
        ok(counters.keyframe == 1 && counters.since == 0, 'exactly one keyframe request, no tail request')

        backend.state.units['beta'] = {hp: 50, x: 5}
        backend.state.tick = 1
        await flushReactive(backend.state)
        await waitFor('live patches over wire', () => mirror.state.tick == 1 && 'beta' in mirror.state.units)
        ok(json(mirror.state) == json(backend.snapshot()), 'live patches keep the wire mirror converged')
        ok(counters.get == 0, 'pure push: server get() was never pulled')

        // ============ обрыв связи, изменения в оффлайне ============
        sub()
        c1.close()
        c1 = null
        await delay(30)

        backend.state.units['alpha'].hp = 75
        await flushReactive(backend.state)
        backend.state.tick = 2
        await flushReactive(backend.state)

        // ============ реконнект с since → только хвост ============
        const kfBefore = counters.keyframe
        c2 = await startRealClient<typeof facade>(server.port)
        const deep2 = c2.client.func as any
        const remote2: ReplayRemote<[StorePatch]> = {
            line: deep2.replay.line,
            since: (s: number) => deep2.replay.since(s),
            keyframe: () => deep2.replay.keyframe(),
        }
        let tailPatches = 0
        const sub2 = syncStoreReplay(mirror, remote2, {
            since: lastSeq,
            onSeq: s => { lastSeq = s; tailPatches++ },
        })
        await sub2.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'reconnect with since converged over the wire')
        ok(counters.keyframe == kfBefore, 'reconnect did NOT cost a snapshot — tail of patches sufficed')
        ok(tailPatches == 2, `tail was exactly the missed patches (got ${tailPatches})`)

        // ============ долгий оффлайн → журнал (history: 6) вытеснен → keyframe ============
        sub2()
        for (let i = 3; i <= 30; i++) {
            backend.state.tick = i
            await flushReactive(backend.state)
        }
        let resyncDeliveries = 0
        const sub3 = syncStoreReplay(mirror, remote2, {
            since: lastSeq,
            onSeq: s => { lastSeq = s; resyncDeliveries++ },
        })
        await sub3.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'evicted journal → fresh keyframe converged')
        ok(counters.keyframe == kfBefore + 1, 'fallback took exactly one fresh keyframe')
        ok(resyncDeliveries == 1, `no backlog: 28 missed patches collapsed into 1 keyframe (got ${resyncDeliveries})`)

        // live после fallback продолжает идти
        backend.state.tick = 31
        await flushReactive(backend.state)
        await waitFor('live after fallback', () => mirror.state.tick == 31)
        ok(true, 'live stream continues after keyframe recovery')
        sub3()

        console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    } finally {
        c1?.close()
        c2?.close()
        await delay(20)
        exposed.close()
        await server.close()
    }
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
