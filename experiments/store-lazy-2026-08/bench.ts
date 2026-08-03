// =====================================================================
// August 2026 lazy Store line stand
// =====================================================================
// One question: on a link slow enough to matter, what does a subscriber pay to
// reach current Store state — a monolithic keyframe, or a progressive merge fill?
//
// Both candidates run over a REAL socket.io + RPC connection through the shared
// metered relay, against the SAME Store under the SAME churn, so the numbers are
// comparable within one run. Intentionally outside src: no package API or build
// artifact depends on it.

import {createServer, type Server as HttpServer} from 'node:http'
import {cpus, arch, platform, release} from 'node:os'
import {performance} from 'node:perf_hooks'
import express from 'express'
import {Server as SocketIoServer} from 'socket.io'
import {io as createSocketIoClient} from 'socket.io-client'

import {createMeteredRelay} from '../_shared/metered-relay'
import {listen as createListenPair} from '../../src/Common/events/Listen'
import {createRpcClientHub} from '../../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../../src/Common/rcp/rpc-server-auto'
import {createStore} from '../../src/Common/Observe/store'
import {flushReactive} from '../../src/Common/Observe/reactive'
import {exposeStoreReplay, syncStoreReplay} from '../../src/Common/Observe/store-replay'
import {exposeStoreLazyLine, syncStoreLazyLine} from '../../src/Common/Observe/store-lazy-line'

const LINK_BYTES_PER_SECOND = positiveIntegerEnv('LAZY_BENCH_LINK_BPS', 131_072)
const LINK_LATENCY_MS = nonNegativeNumberEnv('LAZY_BENCH_LINK_LATENCY_MS', 80)
// Churn must stay BELOW link capacity or no protocol can converge and the stand
// measures nothing. At ~140 wire bytes per quote and a 128 KiB/s link, the
// profiles below sit near half the line.
const CHURN_INTERVAL_MS = positiveIntegerEnv('LAZY_BENCH_CHURN_MS', 250)
// Must match the library default. An earlier draft left this at 16 KiB — below the
// link's bandwidth-delay product — which made the fill latency-bound and produced a
// measurement that said more about the stand than about the line.
const READ_BYTES = positiveIntegerEnv('LAZY_BENCH_READ_BYTES', 256 * 1024)
const CONVERGE_TIMEOUT_MS = positiveIntegerEnv('LAZY_BENCH_TIMEOUT_MS', 60_000)

type tProfile = {
    name: string
    keys: number
    /** Keys rewritten on every churn tick. 0 = a quiet Store. */
    churnKeys: number
}

const PROFILES: readonly tProfile[] = [
    // The shape described for a live quote board: a few hundred symbols, most of
    // the board rewritten every quarter second (~480 keys/s, about half the line).
    {name: 'symbols-350-churn-120', keys: 350, churnKeys: 120},
    // The same board with nothing moving — isolates transfer cost from churn.
    {name: 'symbols-350-quiet', keys: 350, churnKeys: 0},
    // Large enough that one keyframe is itself a slow-link problem.
    {name: 'board-20000-churn-100', keys: 20_000, churnKeys: 100},
]

type Measurement = {
    profile: string
    candidate: 'keyframe' | 'lazy'
    firstDataMs: number | null
    convergedMs: number | null
    converged: boolean
    wireBytes: number
    keys: number
}

// =====================================================================
// Options
// =====================================================================

function positiveIntegerEnv(name: string, fallback: number) {
    const raw = process.env[name]
    if (raw == null || raw == '') return fallback
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(name + ' must be a positive integer')
    return value
}

function nonNegativeNumberEnv(name: string, fallback: number) {
    const raw = process.env[name]
    if (raw == null || raw == '') return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) throw new RangeError(name + ' must be a non-negative number')
    return value
}

function delay(ms: number) {
    return new Promise<void>(function wait(resolve) {
        setTimeout(resolve, ms)
    })
}

// =====================================================================
// Authoritative Store under churn
// =====================================================================

type Quote = {bid: number, ask: number, size: number, ts: number}

function quoteFor(index: number, revision: number): Quote {
    return {
        bid: 104_245.12 + index,
        ask: 104_245.18 + index,
        size: 1 + (index % 7),
        ts: 1_785_000_000_000 + revision,
    }
}

function createBoard(keys: number) {
    const store = createStore<Record<string, Quote>>({})
    for (let index = 0; index < keys; index++) store.state['sym-' + index] = quoteFor(index, 0)
    return store
}

function startChurn(store: ReturnType<typeof createBoard>, profile: tProfile) {
    if (profile.churnKeys == 0) return function stopQuiet() {}
    let revision = 0
    const timer = setInterval(function rewriteBoard() {
        revision++
        for (let offset = 0; offset < profile.churnKeys; offset++) {
            const index = (offset + revision * 37) % profile.keys
            store.state['sym-' + index] = quoteFor(index, revision)
        }
        void flushReactive(store.state)
    }, CHURN_INTERVAL_MS)
    timer.unref?.()
    return function stopChurn() {
        clearInterval(timer)
    }
}

// =====================================================================
// Real socket.io + RPC host behind the metered relay
// =====================================================================

async function listenEphemeral(server: HttpServer) {
    await new Promise<void>(function listening(resolve, reject) {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', function bound() {
            server.off('error', reject)
            resolve()
        })
    })
    const address = server.address()
    if (address == null || typeof address == 'string') throw new Error('missing TCP server address')
    return address.port
}

async function startHost(store: ReturnType<typeof createBoard>) {
    const replay = exposeStoreReplay(store, {history: 4_096})
    const lazy = exposeStoreLazyLine(store, {chunkBytes: 16 * 1024, windowBytes: 64 * 1024})

    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIoServer(httpServer, {
        transports: ['websocket'],
        maxHttpBufferSize: 1e8,
        serveClient: false,
    })
    ioServer.on('connection', function serve(socket) {
        const [disconnect, disconnectListen] = createListenPair()
        socket.on('disconnect', () => disconnect())
        createRpcServerAuto({
            socket: {
                emit: (key: string, data: any) => socket.emit(key, data),
                on: (key: string, cb: any) => socket.on(key, cb),
            },
            socketKey: 'rpc',
            disconnectListen,
            object: {board: replay.api, lazy: lazy.api},
        })
    })

    const serverPort = await listenEphemeral(httpServer)
    const relay = await createMeteredRelay({
        targetPort: serverPort,
        bytesPerSecond: LINK_BYTES_PER_SECOND,
        latencyMs: LINK_LATENCY_MS,
    })

    async function close() {
        await new Promise<void>(function closeIo(resolve) {
            ioServer.close(function closed() { resolve() })
        })
        await new Promise<void>(function closeHttp(resolve) {
            httpServer.close(function closed() { resolve() })
        })
        await relay.close()
        replay.close?.()
        lazy.close()
    }

    return {relay, close}
}

async function connectClient(relayPort: number) {
    const hub = createRpcClientHub(
        () => createSocketIoClient('http://127.0.0.1:' + relayPort, {
            transports: ['websocket'],
            forceNew: true,
        }),
        r => ({api: r('rpc')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.api.readyStrict()
    return {
        api: clients.api.func as any,
        close: () => hub.socket?.disconnect?.(),
    }
}

// =====================================================================
// Convergence observation
// =====================================================================

function mirrorMatches(store: ReturnType<typeof createBoard>, mirror: ReturnType<typeof createBoard>) {
    const source = store.state as Record<string, Quote>
    const target = mirror.state as Record<string, Quote>
    const sourceKeys = Object.keys(source)
    if (Object.keys(target).length != sourceKeys.length) return false
    for (const key of sourceKeys) {
        if (target[key]?.ts != source[key].ts) return false
    }
    return true
}

async function waitForConvergence(
    store: ReturnType<typeof createBoard>,
    mirror: ReturnType<typeof createBoard>,
    startedAt: number,
) {
    const deadline = performance.now() + CONVERGE_TIMEOUT_MS
    for (;;) {
        if (mirrorMatches(store, mirror)) return performance.now() - startedAt
        if (performance.now() > deadline) return null
        await delay(20)
    }
}

function watchFirstData(mirror: ReturnType<typeof createBoard>, startedAt: number) {
    const state = {firstDataMs: null as number | null}
    const timer = setInterval(function pollFirstKey() {
        if (state.firstDataMs == null && Object.keys(mirror.state).length > 0) {
            state.firstDataMs = performance.now() - startedAt
            clearInterval(timer)
        }
    }, 5)
    timer.unref?.()
    return {state, stop: () => clearInterval(timer)}
}

// =====================================================================
// Candidates
// =====================================================================

async function measureKeyframe(profile: tProfile): Promise<Measurement> {
    const store = createBoard(profile.keys)
    const host = await startHost(store)
    const stopChurn = startChurn(store, profile)
    const client = await connectClient(host.relay.port)
    const mirror = createStore<Record<string, Quote>>({})

    host.relay.reset()
    const startedAt = performance.now()
    const first = watchFirstData(mirror, startedAt)
    let off: any = null
    try {
        off = syncStoreReplay(mirror, client.api.board.replay)
        await off.ready
        stopChurn()
        await flushReactive(store.state)
        const convergedMs = await waitForConvergence(store, mirror, startedAt)
        return {
            profile: profile.name,
            candidate: 'keyframe',
            firstDataMs: first.state.firstDataMs,
            convergedMs,
            converged: convergedMs != null,
            wireBytes: host.relay.toClientBytes(),
            keys: Object.keys(mirror.state).length,
        }
    } finally {
        first.stop()
        stopChurn()
        off?.()
        client.close()
        await host.close()
    }
}

async function measureLazy(profile: tProfile): Promise<Measurement> {
    const store = createBoard(profile.keys)
    const host = await startHost(store)
    const stopChurn = startChurn(store, profile)
    const client = await connectClient(host.relay.port)
    const mirror = createStore<Record<string, Quote>>({})

    host.relay.reset()
    const startedAt = performance.now()
    const first = watchFirstData(mirror, startedAt)
    let sync: ReturnType<typeof syncStoreLazyLine> | null = null
    try {
        sync = syncStoreLazyLine(mirror, client.api.lazy, {readBytes: READ_BYTES, fillIntervalMs: 0, liveIntervalMs: 50})
        await sync.filled
        stopChurn()
        await flushReactive(store.state)
        const convergedMs = await waitForConvergence(store, mirror, startedAt)
        return {
            profile: profile.name,
            candidate: 'lazy',
            firstDataMs: first.state.firstDataMs,
            convergedMs,
            converged: convergedMs != null,
            wireBytes: host.relay.toClientBytes(),
            keys: Object.keys(mirror.state).length,
        }
    } finally {
        first.stop()
        stopChurn()
        await sync?.close()
        client.close()
        await host.close()
    }
}

// =====================================================================
// Report
// =====================================================================

function rounded(value: number | null) {
    return value == null ? null : Number(value.toFixed(1))
}

async function main() {
    const environment = {
        node: process.version,
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
    }
    const options = {
        linkBytesPerSecond: LINK_BYTES_PER_SECOND,
        linkLatencyMs: LINK_LATENCY_MS,
        churnIntervalMs: CHURN_INTERVAL_MS,
        readBytes: READ_BYTES,
    }
    console.log('Lazy Store line stand — August 2026')
    console.log(JSON.stringify({runtime: environment, options}, null, 2))

    const results: Measurement[] = []
    for (const profile of PROFILES) {
        console.log('\n  profile ' + profile.name)
        for (const candidate of ['keyframe', 'lazy'] as const) {
            console.log('    running ' + candidate)
            results.push(candidate == 'keyframe' ? await measureKeyframe(profile) : await measureLazy(profile))
        }
    }

    console.table(results.map(function row(result) {
        return {
            profile: result.profile,
            candidate: result.candidate,
            firstDataMs: rounded(result.firstDataMs),
            convergedMs: rounded(result.convergedMs),
            converged: result.converged,
            wireKiB: Number((result.wireBytes / 1024).toFixed(1)),
            keys: result.keys,
        }
    }))

    console.log('\n##RESULT##')
    console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        runtime: environment,
        options,
        results,
    }))
}

main().then(function done() {
    process.exit(0)
}, function reportFailure(error) {
    console.error(error)
    process.exit(1)
})
