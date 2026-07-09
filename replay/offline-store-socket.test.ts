// ============================================================
//  replay/offline-store-socket.test.ts
//
//  Offline persisted mirror over a REAL Socket.IO localhost wire.
//  This is the end-to-end path:
//      exposeStoreReplay -> RPC -> createOfflineStore -> OfflineStorage
//
//  Covers:
//  - empty cache -> keyframe over the wire -> persisted snapshot+seq
//  - live patches over the wire persist without remote get() pulls
//  - app restart without network reads local cache immediately
//  - reconnect by saved seq costs a tail, not a snapshot
//  - evicted/future seq falls back to one fresh keyframe and overwrites cache
//
//  Run:
//      npx ts-node replay/offline-store-socket.test.ts
//      npx tsx replay/offline-store-socket.test.ts
// ============================================================

import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import {createOfflineStore, createMemoryOfflineStorage, OfflineStoreRecord} from '../src/Common/Observe/store-offline'
import {createStore, StorePatch} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {exposeStoreReplay} from '../src/Common/Observe/store-replay'
import {ReplayRemote} from '../src/Common/events/replay-index'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const json = (v: any) => JSON.stringify(v)

async function waitFor(label: string, cond: () => boolean) {
    for (let i = 0; i < 160; i++) {
        if (cond()) return
        await delay(25)
    }
    throw new Error(`timeout: ${label}`)
}

type World = {
    units: Record<string, {hp: number, x: number}>
    tick: number
    meta: {phase: string}
}

type Counters = {
    get: number
    since: number
    keyframe: number
}

function makeRemote(deep: any): ReplayRemote<[StorePatch]> {
    return {
        line: deep.replay.line,
        since: (s: number) => deep.replay.since(s),
        keyframe: () => deep.replay.keyframe(),
    }
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
            socketKey: 'offline-store',
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
        r => ({api: r<T>('offline-store')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.api.readyStrict()
    return {
        client: clients.api,
        close: () => hub.socket?.disconnect?.(),
    }
}

function makeCountedFacade(exposed: ReturnType<typeof exposeStoreReplay<World>>, counters: Counters) {
    return {
        ...exposed.api,
        get: (mask?: any) => {
            counters.get++
            return exposed.api.get(mask)
        },
        replay: {
            ...exposed.api.replay,
            since: (seq: number) => {
                counters.since++
                return exposed.api.replay.since(seq)
            },
            keyframe: () => {
                counters.keyframe++
                return exposed.api.replay.keyframe()
            },
        },
    }
}

async function readRecord(storage: ReturnType<typeof createMemoryOfflineStorage>, key: string) {
    return await storage.read<OfflineStoreRecord<World>>(key)
}

async function main() {
    console.log('\n[offline-store-socket] persisted mirror over a real Socket.IO wire')

    const backend = createStore<World>({
        units: {alpha: {hp: 100, x: 0}},
        tick: 0,
        meta: {phase: 'boot'},
    }, {drain: 'micro'})
    const exposed = exposeStoreReplay(backend, {history: 6})
    const counters: Counters = {get: 0, since: 0, keyframe: 0}
    const facade = makeCountedFacade(exposed, counters)
    type Facade = typeof facade

    const server = await startRealServer(facade)
    let c1: Awaited<ReturnType<typeof startRealClient<Facade>>> | null = null
    let c2: Awaited<ReturnType<typeof startRealClient<Facade>>> | null = null
    let c3: Awaited<ReturnType<typeof startRealClient<Facade>>> | null = null

    try {
        const storage = createMemoryOfflineStorage()

        // ============ empty cache: keyframe over wire, no get() pulls ============
        c1 = await startRealClient<Facade>(server.port)
        const offline = await createOfflineStore<World>({
            key: 'world',
            remote: makeRemote(c1.client.func),
            initial: {units: {}, tick: -1, meta: {phase: 'empty'}},
            storage,
            debounceMs: 0,
            storeOpts: {drain: 'micro'},
        })
        await offline.ready
        await offline.flush()
        const saved0 = await readRecord(storage, 'world')
        ok(json(offline.state) == json(backend.snapshot()), 'empty cache converged from keyframe over the real wire')
        ok(saved0?.seq == 0 && json(saved0.snapshot) == json(backend.snapshot()), 'keyframe persisted as snapshot+seq')
        ok(counters.keyframe == 1 && counters.since == 0 && counters.get == 0, 'fresh offline store used replay keyframe only; no get() pull')

        // ============ live patches: storage follows wire changes ============
        const seqBeforeLive = offline.status().seq
        backend.state.units.beta = {hp: 50, x: 5}
        backend.state.tick = 1
        await flushReactive(backend.state)
        await waitFor('live patch reaches offline store', () => offline.state.tick == 1 && 'beta' in offline.state.units)
        await offline.flush()
        const saved1 = await readRecord(storage, 'world')
        ok(json(offline.state) == json(backend.snapshot()), 'live patches keep offline store converged')
        ok(saved1!.seq > seqBeforeLive && saved1!.snapshot.tick == 1 && saved1!.snapshot.units.beta.hp == 50, 'live patch advanced durable seq and snapshot')
        ok(counters.get == 0, 'live offline sync stayed pure push; no snapshot get() after startup')

        // ============ app restart while offline: local storage is enough for UI ============
        const seqBeforeOffline = offline.status().seq
        offline.close()
        c1.close()
        c1 = null
        await delay(50)

        backend.state.units.alpha.hp = 75
        await flushReactive(backend.state)
        backend.state.tick = 2
        backend.state.meta.phase = 'offline'
        await flushReactive(backend.state)

        const offlineOnly = await createOfflineStore<World>({
            key: 'world',
            initial: {units: {}, tick: -1, meta: {phase: 'empty'}},
            storage,
            debounceMs: 0,
            storeOpts: {drain: 'micro'},
        })
        await offlineOnly.ready
        ok(offlineOnly.state.tick == 1 && offlineOnly.state.units.alpha.hp == 100,
            'without network, UI gets cached state immediately')
        ok(offlineOnly.status().offline && offlineOnly.status().seq == seqBeforeOffline,
            'offline start keeps saved seq and marks offline status')

        // ============ reconnect by saved seq: tail only, no keyframe ============
        const keyframesBeforeReconnect = counters.keyframe
        c2 = await startRealClient<Facade>(server.port)
        await offlineOnly.reconnect(makeRemote(c2.client.func))
        await offlineOnly.ready
        await offlineOnly.flush()
        const saved2 = await readRecord(storage, 'world')
        ok(json(offlineOnly.state) == json(backend.snapshot()), 'reconnect applies missed tail on top of cached state')
        ok(counters.since == 1 && counters.keyframe == keyframesBeforeReconnect, 'reconnect used saved seq tail, not a full keyframe')
        ok(saved2!.seq > seqBeforeOffline && saved2!.snapshot.tick == 2 && saved2!.snapshot.meta.phase == 'offline',
            'tail reconnect persisted new seq and current data')

        // ============ long offline: journal evicted -> one keyframe fallback ============
        const seqBeforeEviction = offlineOnly.status().seq
        offlineOnly.close()
        c2.close()
        c2 = null
        await delay(50)

        for (let i = 3; i <= 20; i++) {
            backend.state.tick = i
            await flushReactive(backend.state)
        }
        backend.state.units.gamma = {hp: 5, x: 9}
        backend.state.meta.phase = 'evicted'
        await flushReactive(backend.state)

        const cachedAgain = await createOfflineStore<World>({
            key: 'world',
            initial: {units: {}, tick: -1, meta: {phase: 'empty'}},
            storage,
            debounceMs: 0,
            storeOpts: {drain: 'micro'},
        })
        ok(cachedAgain.state.tick == 2 && !('gamma' in cachedAgain.state.units),
            'second offline start still uses the last durable snapshot before network')

        const keyframesBeforeFallback = counters.keyframe
        const sinceBeforeFallback = counters.since
        c3 = await startRealClient<Facade>(server.port)
        await cachedAgain.reconnect(makeRemote(c3.client.func))
        await cachedAgain.ready
        await cachedAgain.flush()
        const saved3 = await readRecord(storage, 'world')
        ok(json(cachedAgain.state) == json(backend.snapshot()), 'evicted saved seq falls back to fresh keyframe over real wire')
        ok(counters.since == sinceBeforeFallback + 1 && counters.keyframe == keyframesBeforeFallback + 1,
            'fallback path first tried since, then requested exactly one keyframe')
        ok(saved3!.seq > seqBeforeEviction && saved3!.seq == cachedAgain.status().seq,
            'fallback persisted the fresh server seq, not the stale cached seq')
        ok(saved3!.snapshot.tick == 20 && saved3!.snapshot.units.gamma.hp == 5 && saved3!.snapshot.meta.phase == 'evicted',
            'fallback overwrote durable cache with the fresh keyframe state')

        // live after fallback still persists normally
        backend.state.tick = 21
        await flushReactive(backend.state)
        await waitFor('live after keyframe fallback', () => cachedAgain.state.tick == 21)
        await cachedAgain.flush()
        const saved4 = await readRecord(storage, 'world')
        ok(saved4!.snapshot.tick == 21 && saved4!.seq == cachedAgain.status().seq,
            'live stream continues and persists after keyframe recovery')
        cachedAgain.close()

        console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    } finally {
        c1?.close()
        c2?.close()
        c3?.close()
        await delay(20)
        exposed.close()
        await server.close()
    }
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
