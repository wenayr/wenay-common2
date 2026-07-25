// ============================================================
//  replay/rpc-auto.test.ts
//
//  Feature A+B (rev 2): replay-transparent RPC exposure.
//  - legacy subscription to replay-key = byte-for-byte plain Listen
//  - replaySubscribe against merged node (since:0, no gaps/dups)
//  - both consumers on ONE connection
//  - frame: mini-frame == fold of full tail (equivalence)
//  - current:'last' — keyframe without manual state
//  - lag gates (policy 'frame'): skip + frame recovery
//  - negative detection: similar object is NOT replay
//  - sacred line: frame throws loud (in-proc)
//  Run: npx tsx replay/rpc-auto.test.ts
// ============================================================

import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {replayListen, ReplayEvent} from '../src/Common/events/replay-listen'
import {replaySubscribe, ReplayRemote} from '../src/Common/events/replay-wire'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto, RpcReplayOpts} from '../src/Common/rcp/rpc-server-auto'
import {Pkt} from '../src/Common/rcp/rpc-protocol'
import {rpcPathKey} from '../src/Common/rcp/rpc-path'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const json = (v: any) => JSON.stringify(v)

async function waitFor(label: string, cond: () => boolean) {
    for (let i = 0; i < 200; i++) {
        if (cond()) return
        await delay(25)
    }
    throw new Error(`timeout: ${label}`)
}

async function startRealServer(object: object, replayOpts?: RpcReplayOpts, captured?: {listenPaths?: string[]}) {
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})
    ioServer.on('connection', socket => {
        const [disconnect, disconnectListen] = createListenPair<[]>()
        socket.on('disconnect', () => disconnect())
        createRpcServerAuto({
            socket: {
                emit: (key, data) => {
                    // negative detection is verified by server declaration Pkt.MAP
                    if (captured && Array.isArray(data) && data[0] === Pkt.MAP) captured.listenPaths = data[3]
                    socket.emit(key, data)
                },
                on: (key, cb) => socket.on(key, cb),
            },
            socketKey: 'rpc-auto',
            object,
            disconnectListen,
            replayOpts,
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

async function startRealClient<T extends object>(port: number) {
    const hub = createRpcClientHub(
        () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true}),
        r => ({api: r<T>('rpc-auto')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.api.readyStrict()
    return {
        client: clients.api,
        close: () => hub.socket?.disconnect?.(),
    }
}

// facade: plain Listen (baseline), single-entity replay-line, multi-character
// with compactor, and fake for negative detection
function makeFacade() {
    const [emitPlain, plain] = createListenPair<[number]>()
    const [emitTicker, ticker] = replayListen<[number]>({history: 64, current: 'last'})
    const [emitQuote, quotes] = replayListen<[string, number]>({
        history: 256,
        frame: function lastPerSymbol(tail) {
            const held = new Map<string, ReplayEvent<[string, number]>>()
            for (const ev of tail) { held.delete(ev.event[0]); held.set(ev.event[0], ev) }
            return [...held.values()]
        },
    })
    const fake = {line: {x: 1}, getSince: 1, keyframe: 'no'}
    return {emitPlain, emitTicker, emitQuote, facade: {plain, ticker, quotes, fake}}
}

const foldQuotes = (envs: ReplayEvent<[string, number]>[]) => {
    const m: Record<string, number> = {}
    for (const ev of envs) m[ev.event[0]] = ev.event[1]
    return m
}

async function main() {
    console.log('\n[rpc-auto] replay-transparent exposure over a real Socket.IO wire')

    // ============ in-proc: sacred line throws loud ============
    {
        const [emit, sacred] = replayListen<[number]>({history: 2})
        for (let i = 1; i <= 5; i++) emit(i)
        let threw = false
        try { sacred.frame(0) } catch { threw = true }
        ok(threw, 'sacred line + evicted journal: frame(0) throws (no silent invention)')
        ok(sacred.frame(4).length == 1 && sacred.frame(4)[0].event[0] == 5, 'sacred line + covered gap: exact tail')
    }

    // ============ in-proc: stream end (non-envelope) — loud in onError ============
    {
        let err: any = null
        const remote: ReplayRemote<[number]> = {
            line: {on: (cb: any) => { setTimeout(() => cb('___STOP'), 5); return () => {} }},
            since: () => [],
            keyframe: () => null,
        }
        replaySubscribe(remote, () => {}, {since: 0, onError: e => err = e})
        await delay(30)
        ok(err != null, 'non-envelope on line (RPC_STOP) surfaces via onError, not silence')
    }

    const world = makeFacade()
    type Facade = typeof world.facade
    const captured: {listenPaths?: string[]} = {}
    const server = await startRealServer(world.facade, undefined, captured)
    const c1 = await startRealClient<Facade>(server.port)
    let gateServer: Awaited<ReturnType<typeof startRealServer>> | null = null
    let c3: Awaited<ReturnType<typeof startRealClient<Facade>>> | null = null

    try {
        const deep = c1.client.func

        // ============ MAP declaration: replay nodes declared, fake — not ============
        const lp = captured.listenPaths ?? []
        const partsOf = (key: string) => {
            try {
                const parsed = JSON.parse(key)
                if (Array.isArray(parsed)) return parsed.map(String)
            } catch {}
            return key.split('.')
        }
        const samePath = (key: string, path: string[]) => {
            const parts = partsOf(key)
            return parts.length == path.length && parts.every((p, i) => p == path[i])
        }
        const hasPath = (...path: string[]) => lp.includes(rpcPathKey(path)) || lp.some(k => samePath(k, path))
        const startsWithPath = (key: string, path: string[]) => path.every((p, i) => partsOf(key)[i] == p)
        ok(hasPath('ticker') && hasPath('quotes'), `replay keys declared as listen nodes (${json(lp)})`)
        ok(hasPath('ticker', 'line') && hasPath('quotes', 'frameLine'), 'replay wire sub-lines declared additively in Pkt.MAP')
        ok(hasPath('plain'), 'plain Listen declared as before (MAP grows additively)')
        ok(!lp.some(p => startsWithPath(p, ['fake'])), 'object with line/getSince/keyframe props is NOT misdetected (brand)')

        // ============ legacy parity: replay-key behaves like plain Listen ============
        const gotPlain: number[] = []
        const gotTicker: number[] = []
        deep.plain.callback((v: number) => gotPlain.push(v))
        deep.ticker.callback((v: number) => gotTicker.push(v))
        await delay(150) // subscriptions arrived
        for (let i = 1; i <= 5; i++) { world.emitPlain(i); world.emitTicker(i) }
        await waitFor('legacy live events', () => gotPlain.length >= 5 && gotTicker.length >= 5)
        ok(json(gotTicker) == json(gotPlain), `legacy path: replay key delivers exactly what a plain Listen does (${json(gotTicker)})`)

        // ============ replay-path on SAME connection (legacy + replay coexist) ============
        // merged node is structurally compatible with ReplayRemote — deep.ticker goes as-is
        const seqs: number[] = []
        const vals: number[] = []
        const sub = replaySubscribe(deep.ticker, (v: number) => vals.push(v), {since: 0, onSeq: s => seqs.push(s)})
        await sub.ready
        ok(json(vals) == json([1, 2, 3, 4, 5]), `replaySubscribe since:0 folded journal, no gaps/dups (${json(vals)})`)
        ok(seqs.every((s, i) => i == 0 || s == seqs[i - 1] + 1), 'seq strictly monotonic through catch-up')

        world.emitTicker(6)
        world.emitPlain(6)
        await waitFor('live after catch-up on both consumers', () => vals.includes(6) && gotTicker.includes(6))
        ok(true, 'legacy and replay subscriptions coexist live on ONE connection')

        // ============ current:'last' — keyframe without manual state ============
        const kf = await deep.ticker.keyframe()
        ok(kf && kf.event[0] == 6 && kf.seq == 6, `current:'last' keyframe = last envelope (${json(kf)})`)

        // ============ frame equivalence: mini-frame == fold of full tail ============
        world.emitQuote('AAPL', 100); world.emitQuote('AAPL', 101); world.emitQuote('MSFT', 300)
        world.emitQuote('AAPL', 102); world.emitQuote('MSFT', 301)
        const fullTail = await deep.quotes.since(0)
        const mini = await deep.quotes.frame(0)
        ok(fullTail.length == 5 && mini.length == 2, `mini-frame condensed 5 events into 2 (${mini.length})`)
        ok(json(foldQuotes(mini)) == json(foldQuotes(fullTail)), 'apply(mini-frame) == apply(full tail) — state equivalent')
        ok(mini.every((ev, i) => i == 0 || ev.seq > mini[i - 1].seq), 'mini-frame envelopes monotonic by seq')

        // ============ lag gates (Feature B): policy 'frame' ============
        let fakePending = 0
        gateServer = await startRealServer(world.facade, {pending: () => fakePending, highWater: 5, lowWater: 0, pollMs: 10})
        c3 = await startRealClient<Facade>(gateServer.port)
        const deep3 = c3.client.func
        const gated: Record<string, number> = {}
        let gatedDeliveries = 0
        const gsub = replaySubscribe(deep3.quotes, (sym, px) => { gated[sym] = px; gatedDeliveries++ }, {
            since: (await deep3.quotes.frame(0)).slice(-1)[0]?.seq ?? 0,
            policy: 'frame',
        })
        await gsub.ready
        world.emitQuote('AAPL', 110)
        await waitFor('gated line live while drained', () => gated['AAPL'] == 110)
        ok(true, 'frame policy: live pass-through while socket is drained')

        fakePending = 100 // client «stuck»
        await delay(20)
        const before = gatedDeliveries
        for (let i = 0; i < 30; i++) world.emitQuote('AAPL', 200 + i)
        for (let i = 0; i < 20; i++) world.emitQuote('MSFT', 400 + i)
        await delay(120)
        ok(gatedDeliveries == before, `lag: gate dropped everything, no queue (${gatedDeliveries - before} leaked)`)

        fakePending = 0 // buffer drained
        await waitFor('frame recovery after drain', () => gated['AAPL'] == 229 && gated['MSFT'] == 419)
        ok(gatedDeliveries - before == 2, `recovery = mini-frame: 50 missed events arrived as 2 envelopes (${gatedDeliveries - before})`)

        world.emitQuote('AAPL', 500)
        await waitFor('live continues after recovery', () => gated['AAPL'] == 500)
        ok(true, 'live stream continues after gate recovery')
        gsub()
        sub()

        console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    } finally {
        c1.close()
        c3?.close()
        await delay(20)
        await server.close()
        await gateServer?.close()
    }
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
