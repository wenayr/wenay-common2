// ============================================================
//  replay/conflate-socket.test.ts
//
//  Layer D.1 via REAL Socket.IO: per-connection conflation
//  + snapshot recovery. Gates are built for each connection;
//  buffer fullness is simulated (managed by test via
//  debug-method) — in prod it's socket.conn.writeBuffer.length.
//  Scenarios: keyframe recovery; keyOf-tail and maxKeys-degradation
//  over wire; two clients on one line (slow + fast);
//  reconnect in MIDDLE of conflation-episode via since (journal full,
//  drops from gates don't leak it).
//  Run:
//      npx tsx replay/conflate-socket.test.ts
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
import {conflateReplay, exposeReplay} from '../src/Common/events/replay-index'
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

type ConflateStats = {conflating: boolean, dropped: number, keyframes: number, coalesced: number, flushes: number}

async function main() {
    console.log('\n[conflate-socket] per-connection conflation over a real Socket.IO wire')

    const backend = createStore<World>({units: {alpha: {hp: 100, x: 0}, beta: {hp: 100, x: 0}, gamma: {hp: 100, x: 0}}, tick: 0}, {drain: 'micro'})
    const exposed = exposeStoreReplay(backend, {history: 1000})

    // ============ server: gates per EACH connection ============
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})
    ioServer.on('connection', socket => {
        const buf = {v: 0}   // simulated outgoing buffer of THIS client
        const bufK = {v: 0}  // separate buffer of line with keyOf-collapse
        // one-line gate form (parity with manual conflateReplay — gatedK below):
        // close/stats are destructured AWAY and don't enter rpc-object
        const {close: gatedClose, stats: gatedStats, ...gatedApi} =
            exposeReplay(exposed.replay, {conflate: {pending: () => buf.v, highWater: 5, pollMs: 10}})
        const gatedK = conflateReplay(exposed.replay, {
            pending: () => bufK.v, highWater: 5, pollMs: 10,
            keyOf: patches => patches.length == 1 ? JSON.stringify(patches[0].path) : null,
            maxKeys: 4,
        })
        const [disconnect, disconnectListen] = createListenPair<[]>()
        socket.on('disconnect', () => { disconnect(); gatedClose(); gatedK.close() })
        createRpcServerAuto({
            socket: {
                emit: (key, data) => socket.emit(key, data),
                on: (key, cb) => socket.on(key, cb),
            },
            socketKey: 'conflate-store',
            object: {
                ...exposed.api,
                replay: gatedApi,
                replayK: gatedK.api,
                debug: {
                    setPending: (n: number) => { buf.v = n },
                    setPendingK: (n: number) => { bufK.v = n },
                    stats: () => gatedStats(),
                    statsK: () => gatedK.stats(),
                },
            },
            disconnectListen,
        })
    })
    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    const port = (httpServer.address() as AddressInfo).port
    console.log(`  [server] listening on 127.0.0.1:${port}`)

    // ============ client ============
    const hub = createRpcClientHub(
        () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true}),
        r => ({api: r<any>('conflate-store')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.api.readyStrict()
    const deep = clients.api.func as any
    let hubB: any = null   // second client (fast neighbor of slow)
    let hub2: any = null   // reconnect of first client

    try {
        let envelopes = 0
        const remote: ReplayRemote<[StorePatch]> = {
            line: {on: (cb: any) => deep.replay.line.on((ev: any) => { envelopes++; cb(ev) })},
            since: (s: number) => deep.replay.since(s),
            keyframe: () => deep.replay.keyframe(),
        }
        const mirror = createStore<World>({units: {}, tick: -1})
        const seqs: number[] = []
        const sub = syncStoreReplay(mirror, remote, {onSeq: s => seqs.push(s)})
        await sub.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'fresh client converged via keyframe over the wire')

        backend.state.tick = 1
        await flushReactive(backend.state)
        await waitFor('live patch over wire', () => mirror.state.tick == 1)
        ok(json(mirror.state) == json(backend.snapshot()), 'live patches flow through the transparent gate')

        // ============ buffer client «overflowed»: deltas don't go over wire ============
        await deep.debug.setPending(100)
        for (let i = 2; i <= 12; i++) {
            backend.state.units['alpha'].hp = 100 - i
            backend.state.tick = i
            await flushReactive(backend.state)
        }
        await delay(150)
        ok(mirror.state.tick == 1, 'stalled client received NO deltas over the wire')
        const stats1: ConflateStats = await deep.debug.stats()
        ok(stats1.conflating && stats1.dropped >= 11, `deltas were dropped server-side, not queued (dropped=${stats1.dropped})`)
        const envBefore = envelopes

        // ============ buffer drained → ONE keyframe instead of 22 patches ============
        await deep.debug.setPending(0)
        await waitFor('recovery over wire', () => mirror.state.tick == 12)
        ok(json(mirror.state) == json(backend.snapshot()), 'recovered mirror equals backend')
        ok(envelopes - envBefore == 1, `stall collapsed into 1 envelope on the wire (got ${envelopes - envBefore})`)
        const stats2: ConflateStats = await deep.debug.stats()
        ok(stats2.keyframes == 1 && !stats2.conflating, 'recovery cost exactly one keyframe')

        // ============ live after recovery ============
        backend.state.tick = 13
        await flushReactive(backend.state)
        await waitFor('live after recovery', () => mirror.state.tick == 13)
        ok(json(mirror.state) == json(backend.snapshot()), 'live stream continues after recovery')

        // ============ keyOf-gates: congestion collapses into tail of latest values, NOT keyframe ============
        let envelopesK = 0
        const remoteK: ReplayRemote<[StorePatch]> = {
            line: {on: (cb: any) => deep.replayK.line.on((ev: any) => { envelopesK++; cb(ev) })},
            since: (s: number) => deep.replayK.since(s),
            keyframe: () => deep.replayK.keyframe(),
        }
        const mirrorK = createStore<World>({units: {}, tick: -1})
        const subK = syncStoreReplay(mirrorK, remoteK)
        await subK.ready
        ok(json(mirrorK.state) == json(backend.snapshot()), 'keyOf line: fresh mirror converged via keyframe')

        await deep.debug.setPendingK(100)
        for (let i = 14; i <= 23; i++) {
            backend.state.units['alpha'].hp = 200 - i
            backend.state.tick = i
            await flushReactive(backend.state)
        }
        await delay(150)
        ok(mirrorK.state.tick == 13, 'stalled keyOf client received NO deltas over the wire')
        const envKBefore = envelopesK
        await deep.debug.setPendingK(0)
        await waitFor('coalesced recovery over wire', () => mirrorK.state.tick == 23)
        ok(json(mirrorK.state) == json(backend.snapshot()), 'keyOf mirror equals backend after recovery')
        ok(envelopesK - envKBefore == 1, `10 missed V2 envelopes collapsed into one keyframe (got ${envelopesK - envKBefore})`)
        const statsK1: ConflateStats = await deep.debug.statsK()
        ok(statsK1.flushes == 0 && statsK1.keyframes == 1, 'multi-patch V2 envelopes recover through one keyframe')

        // ============ maxKeys: five paths in congestion → degradation to keyframe, memory limited by keys ============
        await deep.debug.setPendingK(100)
        backend.state.units['alpha'].hp = 1
        backend.state.units['alpha'].x = 2
        backend.state.units['beta'].hp = 3
        backend.state.units['beta'].x = 4
        backend.state.units['gamma'].hp = 5
        await flushReactive(backend.state)
        await deep.debug.setPendingK(0)
        await waitFor('keyframe degradation over wire', () => mirrorK.state.units['gamma']?.hp == 5)
        ok(json(mirrorK.state) == json(backend.snapshot()), 'over-maxKeys episode converged via keyframe')
        const statsK2: ConflateStats = await deep.debug.statsK()
        ok(statsK2.keyframes == 2 && statsK2.flushes == 0, 'the next multi-patch episode also degrades to one keyframe')
        subK()

        // ============ two clients on one line: slow conflates, fast streams ============
        hubB = createRpcClientHub(
            () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true}),
            r => ({api: r<any>('conflate-store')}) as const,
        )
        const clientsB = await hubB.setToken(null)
        await clientsB.api.readyStrict()
        const deepB = clientsB.api.func as any
        const remoteB: ReplayRemote<[StorePatch]> = {
            line: {on: (cb: any) => deepB.replay.line.on(cb)},
            since: (s: number) => deepB.replay.since(s),
            keyframe: () => deepB.replay.keyframe(),
        }
        const mirrorB = createStore<World>({units: {}, tick: -1})
        const subB = syncStoreReplay(mirrorB, remoteB)
        await subB.ready
        ok(json(mirrorB.state) == json(backend.snapshot()), 'second client converged via its own keyframe')

        await deep.debug.setPending(100)
        const tickBeforeStall = mirror.state.tick
        for (let i = 30; i <= 35; i++) {
            backend.state.tick = i
            await flushReactive(backend.state)
        }
        await waitFor('fast client streams live', () => mirrorB.state.tick == 35)
        ok(mirror.state.tick == tickBeforeStall, 'slow client got NOTHING while its neighbour streamed live')
        const statsB: ConflateStats = await deepB.debug.stats()
        ok(!statsB.conflating && statsB.dropped == 0 && statsB.keyframes == 0, 'fast client gate stayed fully transparent')

        const envABefore = envelopes
        await deep.debug.setPending(0)
        await waitFor('slow client recovery', () => mirror.state.tick == 35)
        ok(json(mirror.state) == json(backend.snapshot()), 'slow client converged after drain')
        ok(envelopes - envABefore == 1, `slow client stall collapsed into 1 envelope (got ${envelopes - envABefore})`)
        ok(json(mirrorB.state) == json(backend.snapshot()), 'fast client unaffected by neighbour recovery')
        subB()

        // ============ reconnect in MIDDLE of conflation-episode: journal full, since catches dropped ============
        await deep.debug.setPending(100)
        for (let i = 36; i <= 42; i++) {
            backend.state.units['alpha'].hp = i
            backend.state.tick = i
            await flushReactive(backend.state)
        }
        await delay(100)
        ok(mirror.state.tick == 35, 'client is mid-episode: deltas dropped server-side')
        const statsMid: ConflateStats = await deep.debug.stats()
        ok(statsMid.conflating, 'gate is still conflating at disconnect time')
        const at = sub.seq()
        sub()
        hub.socket?.disconnect?.()

        hub2 = createRpcClientHub(
            () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true}),
            r => ({api: r<any>('conflate-store')}) as const,
        )
        const clients2 = await hub2.setToken(null)
        await clients2.api.readyStrict()
        const deep2 = clients2.api.func as any
        const seqs2: number[] = []
        const remote2: ReplayRemote<[StorePatch]> = {
            line: {on: (cb: any) => deep2.replay.line.on(cb)},
            since: (s: number) => deep2.replay.since(s),
            keyframe: () => deep2.replay.keyframe(),
        }
        const sub2 = syncStoreReplay(mirror, remote2, {since: at, onSeq: s => seqs2.push(s)})
        await sub2.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'reconnect mid-episode converged from the journal tail')
        ok(seqs2.length == 7, `gate drops did not hole the journal: since delivered seven V2 envelopes (got ${seqs2.length})`)
        ok(seqs2.every((s, i) => i == 0 || s > seqs2[i - 1]), `reconnect seqs strictly ascending: ${seqs2.join(',')}`)
        sub2()

        ok(seqs.every((s, i) => i == 0 || s > seqs[i - 1]), `delivered seqs strictly ascending: ${seqs.join(',')}`)
        console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    } finally {
        hub.socket?.disconnect?.()
        hubB?.socket?.disconnect?.()
        hub2?.socket?.disconnect?.()
        await delay(20)
        exposed.close()
        ioServer.close()
        await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
