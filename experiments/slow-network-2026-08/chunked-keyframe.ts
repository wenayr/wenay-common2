// =====================================================================
// Chunked keyframe on a slow link — live stand (August 2026)
// =====================================================================
// Proves the decided v1 protocol (doc/target/KEYFRAME-CHUNKING.md) does what it
// was built for: the SAME store that kills a monolithic-keyframe catch-up on a
// throttled link (the ping-starvation cycle RESULTS.md measured) converges when
// the keyframe travels as pulled chunks, and still converges when the socket
// dies mid-assembly. The relay and the scaled ping discipline are copied from
// bench.ts (not exported there, intentionally outside src).
// Run: npx tsx experiments/slow-network-2026-08/chunked-keyframe.ts

import {createServer, type Server as HttpServer} from 'node:http'
import {createServer as createTcpServer, connect as connectTcp, type Socket as TcpSocket} from 'node:net'
import {performance} from 'node:perf_hooks'
import {Server as SocketIoServer} from 'socket.io'
import {io as createSocketIoClient} from 'socket.io-client'
import {createStore} from '../../src/Common/Observe/store'
import {
    exposeStoreReplay, syncStoreReplay,
    type StoreReplayChunkedProgress,
} from '../../src/Common/Observe/store-replay'
import {listen} from '../../src/Common/events/Listen'
import {rpcMemberAvailable} from '../../src/Common/events/transport-lifecycle'
import {createRpcClientHub} from '../../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../../src/Common/rcp/rpc-server-auto'

// =====================================================================
// Options — the scaling discipline, stated honestly
// =====================================================================
// bench.ts scales the ping timers ~20x below production (300/1000 ms vs 25/20 s)
// so starvation shows in seconds. This stand keeps those timers and the full
// 100k-key store, but runs the link at 4x the 1 Mbit/s model (524288 B/s) so
// three full-keyframe transfers fit in under a minute. What the scenarios prove
// is a RATIO, and the ratio is preserved: the monolithic frame occupies the
// line for many multiples of the heartbeat budget, one chunk for a fraction of
// it. At a true 1 Mbit/s every duration below is exactly 4x longer.

const STORE_KEYS = 100_000
const VALUE_BYTES = 30
const LINK_BYTES_PER_SECOND = 4 * 131_072
const LINK_LATENCY_MS = 40
const SCALED_PING_INTERVAL_MS = 300     // bench.ts SCALED_PING_INTERVAL_MS
const SCALED_PING_TIMEOUT_MS = 1_000    // bench.ts SCALED_PING_TIMEOUT_MS
const CHUNK_BUDGET_BYTES = 256 * 1024
const CHUNK_MARGIN_BYTES = 32 * 1024    // codec envelope + framing headroom over the budget
const RELAY_MAX_BACKLOG_BYTES = 4 * 1_024 * 1_024
const MONOLITHIC_GUARD_MS = 30_000
const CHUNKED_GUARD_MS = 60_000
const RECONNECT_GUARD_MS = 90_000
const LIVE_TAIL_WAIT_MS = 10_000

const PING_BUDGET_MS = SCALED_PING_INTERVAL_MS + SCALED_PING_TIMEOUT_MS

type tStandState = Record<string, string>

let fails = 0

function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

function delay(ms: number) {
    return new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })
}

async function waitFor(condition: () => boolean, timeoutMs: number) {
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
        if (condition()) return true
        await delay(50)
    }
    return condition()
}

// =====================================================================
// Representative store — 100k keys, low-MB keyframe
// =====================================================================
// bench.ts's representative record (~164 JSON B/key) would put 100k keys at
// ~16 MB — far outside the low-MB range the plan targets — so each key carries
// a ~30-byte string instead, landing the keyframe where RECOMMENDATIONS.md
// measured it (~3.3 MiB at 100k representative keys).

function representativeValue(index: number) {
    return ('v' + index.toString(36) + '-').padEnd(VALUE_BYTES, 'kfchunks'.charAt(index % 8))
}

function buildStandState() {
    const state: tStandState = {}
    for (let index = 0; index < STORE_KEYS; index++) state['row-' + index] = representativeValue(index)
    return state
}

function jsonBytes(value: unknown) {
    return value == null ? 0 : Buffer.byteLength(JSON.stringify(value))
}

// =====================================================================
// Metered / throttled TCP relay — bench.ts's token bucket, FIFO delivery
// =====================================================================
// bench.ts schedules every TCP chunk with an independent setTimeout. At this
// stand's 4x link rate two deliveries can come due within the same millisecond
// (a 4-byte ping queued between big frames), and Node keeps timers in
// per-duration lists, so equal-expiry timers from different durations may fire
// out of order — observed here as ws "Invalid WebSocket frame: invalid UTF-8
// sequence" mid-catch-up. The token-bucket accounting (occupation + fixed
// one-way delay) is bench's unchanged; delivery drains ONE queue in order.

type tRelay = {
    port: number
    toClientBytes: () => number
    reset: () => void
    close: () => Promise<void>
}

async function createMeteredRelay(deps: {targetPort: number, bytesPerSecond: number, latencyMs: number}): Promise<tRelay> {
    const {bytesPerSecond, latencyMs} = deps
    let toClient = 0
    const openSockets = new Set<TcpSocket>()

    function pipeThrottled(source: TcpSocket, sink: TcpSocket, count: (bytes: number) => void) {
        // Token bucket: each chunk occupies the modeled line for length/rate,
        // then arrives after the fixed one-way delay — in receive order.
        let lineFreeAtMs = 0
        let backlogBytes = 0
        let ended = false
        let timer: any = null
        const queue: {chunk: Buffer, dueAtMs: number}[] = []
        function drainQueue() {
            timer = null
            while (queue.length) {
                const head = queue[0]!
                const now = performance.now()
                if (head.dueAtMs > now) {
                    timer = setTimeout(drainQueue, Math.max(1, Math.ceil(head.dueAtMs - now)))
                    return
                }
                queue.shift()
                backlogBytes -= head.chunk.length
                if (!sink.destroyed) sink.write(head.chunk)
                if (source.isPaused() && backlogBytes <= RELAY_MAX_BACKLOG_BYTES / 2) source.resume()
            }
            if (ended && !sink.destroyed) sink.end()
        }
        source.on('data', function forwardThrottled(chunk: Buffer) {
            count(chunk.length)
            const now = performance.now()
            const startMs = Math.max(now, lineFreeAtMs)
            lineFreeAtMs = startMs + chunk.length * 1_000 / bytesPerSecond
            backlogBytes += chunk.length
            if (backlogBytes > RELAY_MAX_BACKLOG_BYTES) source.pause()
            queue.push({chunk, dueAtMs: lineFreeAtMs + latencyMs})
            if (!timer) drainQueue()
        })
        source.on('end', function endSinkThrottled() {
            ended = true
            if (!timer && queue.length == 0 && !sink.destroyed) sink.end()
        })
    }

    const relayServer = createTcpServer(function relayConnection(clientSide) {
        const serverSide = connectTcp(deps.targetPort, '127.0.0.1')
        openSockets.add(clientSide)
        openSockets.add(serverSide)
        clientSide.on('error', teardown)
        serverSide.on('error', teardown)
        clientSide.on('close', teardown)
        serverSide.on('close', teardown)
        pipeThrottled(clientSide, serverSide, function countUpstream() {})
        pipeThrottled(serverSide, clientSide, function countDownstream(bytes) { toClient += bytes })

        function teardown() {
            clientSide.destroy()
            serverSide.destroy()
            openSockets.delete(clientSide)
            openSockets.delete(serverSide)
        }
    })

    await new Promise<void>(function listenRelay(resolve, reject) {
        relayServer.once('error', reject)
        relayServer.listen(0, '127.0.0.1', function listening() {
            relayServer.off('error', reject)
            resolve()
        })
    })
    const address = relayServer.address()
    if (address == null || typeof address == 'string') throw new Error('missing relay address')

    async function close() {
        for (const socket of openSockets) socket.destroy()
        openSockets.clear()
        await new Promise<void>(function closeRelay(resolve) {
            relayServer.close(function closed() { resolve() })
        })
    }

    return {
        port: address.port,
        toClientBytes: () => toClient,
        reset: function resetCounters() { toClient = 0 },
        close,
    }
}

async function listenEphemeral(server: HttpServer) {
    await new Promise<void>(function listenHttp(resolve, reject) {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', function listening() {
            server.off('error', reject)
            resolve()
        })
    })
    const address = server.address()
    if (address == null || typeof address == 'string') throw new Error('missing TCP server address')
    return address.port
}

// =====================================================================
// Server-side message measurement — countWireReads style, brand symbols kept
// =====================================================================
// The claim under test is about SINGLE-MESSAGE size, so each catch-up answer is
// measured where it is produced (JSON payload bytes; WS framing rides on top
// and the relay counter reports the wire truth per scenario).

type tWireLogEntry = {member: string, bytes: number}

let wireLog: tWireLogEntry[] = []

function logWire(entry: tWireLogEntry) {
    wireLog.push(entry)
}

function largestWireMessage(members?: string[]) {
    let largest = 0
    for (const entry of wireLog) {
        if (members && !members.includes(entry.member)) continue
        if (entry.bytes > largest) largest = entry.bytes
    }
    return largest
}

function withWireMeasurement<R extends Record<string, any>>(remote: R): R {
    function measured(member: string, call: (...args: any[]) => any) {
        return function measureWireAnswer(...args: any[]) {
            const result = call(...args)
            logWire({member, bytes: jsonBytes(result)})
            return result
        }
    }
    const wrapped: any = {
        ...remote,
        since: measured('since', (seq: number) => remote.since(seq)),
        keyframe: measured('keyframe', () => remote.keyframe()),
        frame: measured('frame', (seq: number, hint?: unknown) => remote.frame(seq, hint)),
        chunks: {
            begin: measured('chunks.begin', (opts?: {budgetBytes?: number}) => remote.chunks.begin(opts)),
            pull: measured('chunks.pull', (snapshotId: string, index: number) => remote.chunks.pull(snapshotId, index)),
            end: (snapshotId: string) => remote.chunks.end(snapshotId),
        },
    }
    // The replay-wire brand and lifecycle symbols make RPC auto-projection work.
    for (const key of Object.getOwnPropertySymbols(remote)) {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(remote, key)!)
    }
    return wrapped
}

// =====================================================================
// Socket.IO server + RPC facade — the replicated-map-socket.test.ts wiring
// =====================================================================

type tReplayWire = ReturnType<typeof exposeStoreReplay>['api']['replay']
type StandFacade = {replay: tReplayWire}

async function startStandServer(replayFacade: tReplayWire) {
    const httpServer = createServer()
    const ioServer = new SocketIoServer(httpServer, {
        transports: ['websocket'],
        serveClient: false,
        maxHttpBufferSize: 32 * 1_024 * 1_024,
        perMessageDeflate: false,   // deflate would hide the size problem this stand measures
        pingInterval: SCALED_PING_INTERVAL_MS,
        pingTimeout: SCALED_PING_TIMEOUT_MS,
    })

    ioServer.on('connection', function exposeStandReplay(socket) {
        const [emitDisconnect, disconnectListen] = listen<[]>()
        socket.on('disconnect', function standSocketDisconnected() { emitDisconnect() })
        createRpcServerAuto({
            socket: {
                emit(key, data) { socket.emit(key, data) },
                on(key, cb) { socket.on(key, cb) },
            },
            socketKey: 'chunked-keyframe-stand',
            object: {replay: replayFacade} satisfies StandFacade,
            disconnectListen,
        })
    })

    const port = await listenEphemeral(httpServer)
    return {
        port,
        close() {
            return new Promise<void>(function closeServer(resolve) {
                ioServer.close()
                httpServer.close(function serverClosed() { resolve() })
            })
        },
    }
}

async function connectStandClient(relayPort: number) {
    const hub = createRpcClientHub(
        function connectStandSocket() {
            return createSocketIoClient('http://127.0.0.1:' + relayPort, {
                transports: ['websocket'],
                forceNew: true,
                reconnection: false,    // every reconnect in this stand is a deliberate, observed act
                perMessageDeflate: false,
            })
        },
        remote => ({stand: remote<StandFacade>('chunked-keyframe-stand')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.stand.readyStrict()
    return {hub, remote: clients.stand.func.replay as any}
}

// =====================================================================
// Scenario rows
// =====================================================================

type tScenarioRow = {
    scenario: string
    keyframeBytes: number
    chunks: number | string
    largestMsgBytes: number
    catchUpMs: number
    pingTimeouts: number
    outcome: string
}

// =====================================================================
// Scenario A — monolithic keyframe (chunkedKeyframe: false): the control
// =====================================================================
// PASS = the measured problem REPRODUCES: one keyframe occupies the line far
// beyond the heartbeat budget and the connection dies mid-catch-up.

async function scenarioMonolithic(relayPort: number, keyframeBytes: number): Promise<tScenarioRow> {
    console.log('\nScenario A — monolithic keyframe over the slow link (the control)')
    wireLog = []
    const {hub, remote} = await connectStandClient(relayPort)
    const mirror = createStore<tStandState>({})
    const syncErrors: unknown[] = []
    const started = performance.now()
    let disconnectAtMs = 0
    let converged = false

    const outcome = await new Promise<{kind: 'disconnect' | 'converged' | 'guard', reason?: string}>(
        function raceMonolithicCatchUp(resolve) {
            const guard = setTimeout(function guardMonolithic() {
                resolve({kind: 'guard'})
            }, MONOLITHIC_GUARD_MS)
            hub.socket.on('disconnect', function monolithicDisconnected(reason: string) {
                clearTimeout(guard)
                disconnectAtMs = performance.now() - started
                resolve({kind: 'disconnect', reason: String(reason)})
            })
            syncStoreReplay(mirror, remote, {
                chunkedKeyframe: false,
                onError: function recordMonolithicError(error) { syncErrors.push(error) },
                onLive: function monolithicConverged() {
                    clearTimeout(guard)
                    converged = true
                    resolve({kind: 'converged'})
                },
            })
        })

    const occupationMs = keyframeBytes / LINK_BYTES_PER_SECOND * 1_000
    console.log('  occupation arithmetic: ' + keyframeBytes + ' B / ' + LINK_BYTES_PER_SECOND
        + ' B/s = ' + occupationMs.toFixed(0) + ' ms on the line vs a ' + PING_BUDGET_MS
        + ' ms heartbeat budget (' + (occupationMs / PING_BUDGET_MS).toFixed(1) + 'x over)')
    if (outcome.kind == 'disconnect') {
        console.log('  observed: disconnect "' + outcome.reason + '" at ' + disconnectAtMs.toFixed(0)
            + ' ms — the keyframe never finished delivery')
    }

    ok(occupationMs > PING_BUDGET_MS, 'the monolithic frame occupies the line beyond the ping budget '
        + `(${occupationMs.toFixed(0)} ms > ${PING_BUDGET_MS} ms)`)
    ok(outcome.kind == 'disconnect', 'the ping-starvation disconnect is OBSERVED during monolithic catch-up '
        + `(${outcome.kind}${outcome.reason ? ': ' + outcome.reason : ''})`)
    ok(outcome.reason == 'ping timeout' || outcome.reason == 'transport close',
        `the disconnect is the heartbeat kill, not an artifact (reason "${outcome.reason}")`)
    ok(!converged && Object.keys(mirror.snapshot()).length == 0,
        'the mirror received nothing — catch-up cannot complete on this link')

    hub.socket.disconnect?.()
    await delay(200)
    return {
        scenario: 'A monolithic',
        keyframeBytes,
        chunks: 1,
        largestMsgBytes: largestWireMessage(['keyframe']),
        catchUpMs: Math.round(disconnectAtMs),
        pingTimeouts: outcome.kind == 'disconnect' ? 1 : 0,
        outcome: outcome.kind == 'disconnect' ? 'disconnect: ' + outcome.reason + ' (problem reproduced)' : outcome.kind,
    }
}

// =====================================================================
// Scenario B — chunked keyframe (default ON): the same store converges
// =====================================================================

async function scenarioChunked(relayPort: number, relay: tRelay, source: ReturnType<typeof createStore<tStandState>>,
    keyframeBytes: number): Promise<tScenarioRow> {
    console.log('\nScenario B — chunked keyframe over the SAME link')
    wireLog = []
    relay.reset()
    const {hub, remote} = await connectStandClient(relayPort)
    ok(rpcMemberAvailable(remote, 'chunks'), 'the RPC-projected wire advertises the chunks facet')
    const mirror = createStore<tStandState>({})
    const progress: StoreReplayChunkedProgress[] = []
    const disconnects: string[] = []
    const syncErrors: unknown[] = []
    hub.socket.on('disconnect', function chunkedDisconnected(reason: string) { disconnects.push(String(reason)) })

    const started = performance.now()
    const sub = syncStoreReplay(mirror, remote, {
        chunkedKeyframe: {
            budgetBytes: CHUNK_BUDGET_BYTES,
            onProgress: function recordProgress(p) { progress.push(p) },
        },
        onError: function recordChunkedError(error) { syncErrors.push(error) },
    })
    const guard = delay(CHUNKED_GUARD_MS).then(function chunkedGuard() {
        throw new Error('scenario B guard timeout after ' + CHUNKED_GUARD_MS + ' ms')
    })
    await Promise.race([sub.ready, guard])
    const catchUpMs = performance.now() - started
    const disconnectsDuringCatchUp = disconnects.length

    // The live tail must resume from the snapshot's one seq — write after bootstrap.
    source.state['row-0'] = 'updated-after-chunked-bootstrap'
    const liveArrived = await waitFor(
        function liveTailApplied() { return mirror.snapshot()['row-0'] == 'updated-after-chunked-bootstrap' },
        LIVE_TAIL_WAIT_MS,
    )

    const total = progress.length ? progress[progress.length - 1]!.total : 0
    const oneSnapshot = new Set(progress.map(p => p.snapshotId)).size == 1
    const monotonic = progress.every((p, index) => p.received == index + 1 && p.total == total)
    const largest = largestWireMessage(['chunks.begin', 'chunks.pull'])
    const chunkOccupationMs = largest / LINK_BYTES_PER_SECOND * 1_000

    ok(JSON.stringify(mirror.snapshot()) == JSON.stringify(source.snapshot()),
        'the mirror deep-equals the source after chunked catch-up plus a live write')
    ok(liveArrived, 'the live tail resumed from the snapshot seq (post-bootstrap write arrived)')
    ok(total > 5, `the tuned budget splits the keyframe into more than 5 chunks (total ${total})`)
    ok(oneSnapshot && monotonic && progress.length == total,
        `onProgress reported monotonically 1..total for one snapshotId (${progress.length}/${total})`)
    ok(disconnectsDuringCatchUp == 0, 'NO ping-timeout disconnect during chunked catch-up')
    ok(!wireLog.some(entry => entry.member == 'keyframe'),
        'the chunked path never fell back to the monolithic keyframe')
    ok(largest <= CHUNK_BUDGET_BYTES + CHUNK_MARGIN_BYTES,
        `the largest single message stays under budget + codec margin (${largest} <= ${CHUNK_BUDGET_BYTES + CHUNK_MARGIN_BYTES})`)
    ok(syncErrors.length == 0, 'the sync surfaced no errors')
    console.log('  chunk occupation: ' + largest + ' B = ' + chunkOccupationMs.toFixed(0)
        + ' ms on the line — the heartbeat breathes between pulls (budget ' + PING_BUDGET_MS + ' ms)')
    console.log('  relay wire bytes for the whole catch-up: ' + relay.toClientBytes())

    sub()
    hub.socket.disconnect?.()
    await delay(200)
    return {
        scenario: 'B chunked',
        keyframeBytes,
        chunks: total,
        largestMsgBytes: largest,
        catchUpMs: Math.round(catchUpMs),
        pingTimeouts: disconnectsDuringCatchUp,
        outcome: 'converged',
    }
}

// =====================================================================
// Scenario C — socket killed mid-assembly, ONE sync survives via reconnect
// =====================================================================
// Progress may restart (a fresh begin, a fresh snapshotId); correctness holds:
// the abandoned catch-up generation is discarded, the reconnect catch-up
// assembles a complete snapshot, and the mirror never shows a partial one.

async function scenarioReconnect(relayPort: number, source: ReturnType<typeof createStore<tStandState>>,
    keyframeBytes: number): Promise<tScenarioRow> {
    console.log('\nScenario C — reconnect mid-assembly')
    wireLog = []
    const {hub, remote} = await connectStandClient(relayPort)
    const mirror = createStore<tStandState>({})
    const progress: StoreReplayChunkedProgress[] = []
    const disconnects: string[] = []
    const syncErrors: unknown[] = []
    let killedAtReceived = 0
    let partialObserved = false
    let reconnectScheduled = false

    hub.socket.on('disconnect', function midAssemblyDisconnected(reason: string) {
        disconnects.push(String(reason))
        if (reconnectScheduled) return
        reconnectScheduled = true
        setTimeout(function reconnectStandSocket() { hub.socket.connect?.() }, 300)
    })

    const started = performance.now()
    const sub = syncStoreReplay(mirror, remote, {
        chunkedKeyframe: {
            budgetBytes: CHUNK_BUDGET_BYTES,
            onProgress: function killAtHalf(p) {
                progress.push(p)
                if (killedAtReceived == 0 && p.received >= Math.ceil(p.total / 2)) {
                    killedAtReceived = p.received
                    // Atomicity check at the worst moment: half the chunks are
                    // assembled off-Store, the mirror must still be empty.
                    if (Object.keys(mirror.snapshot()).length != 0) partialObserved = true
                    hub.socket.disconnect?.()
                }
            },
        },
        onError: function recordReconnectError(error) { syncErrors.push(error) },
    })
    const guard = delay(RECONNECT_GUARD_MS).then(function reconnectGuard() {
        throw new Error('scenario C guard timeout after ' + RECONNECT_GUARD_MS + ' ms')
    })
    await Promise.race([sub.ready, guard])
    const catchUpMs = performance.now() - started
    const disconnectsDuringRun = disconnects.length
    const pingTimeoutDisconnects = disconnects.filter(reason => reason == 'ping timeout').length

    const snapshotIds = new Set(progress.map(p => p.snapshotId))
    const last = progress[progress.length - 1]!
    const perSnapshotMonotonic = [...snapshotIds].every(function receivedGrows(snapshotId) {
        const received = progress.filter(p => p.snapshotId == snapshotId).map(p => p.received)
        return received.every((value, index) => index == 0 || value > received[index - 1])
    })
    const total = last.total

    ok(killedAtReceived > 0 && disconnectsDuringRun == 1,
        `the socket was killed at ${killedAtReceived}/${total} chunks (disconnect "${disconnects[0]}")`)
    ok(pingTimeoutDisconnects == 0,
        'no heartbeat kill during either assembly — the only disconnect was the deliberate one')
    ok(!partialObserved, 'the mirror never exposed a half-assembled snapshot')
    ok(snapshotIds.size >= 2, `the reconnect catch-up began a FRESH attempt (${snapshotIds.size} snapshotIds)`)
    ok(perSnapshotMonotonic && last.received == last.total,
        'progress restarted cleanly and the second assembly ran to total')
    ok(JSON.stringify(mirror.snapshot()) == JSON.stringify(source.snapshot()),
        'the mirror deep-equals the source after the mid-assembly reconnect')
    ok(!wireLog.some(entry => entry.member == 'keyframe'),
        'correctness came from a fresh chunked attempt, not a monolithic fallback')
    ok(syncErrors.length == 0, 'ONE sync survived the reconnect without surfacing an error')

    sub()
    hub.socket.disconnect?.()
    await delay(200)
    return {
        scenario: 'C reconnect',
        keyframeBytes,
        chunks: `${killedAtReceived}/${total} + ${total}`,
        largestMsgBytes: largestWireMessage(['chunks.begin', 'chunks.pull']),
        catchUpMs: Math.round(catchUpMs),
        pingTimeouts: pingTimeoutDisconnects,
        outcome: 'converged after mid-assembly kill',
    }
}

// =====================================================================
// Stand
// =====================================================================

async function main() {
    console.log('Chunked keyframe on a slow link — live stand (2026-08-28)')
    console.log(JSON.stringify({
        storeKeys: STORE_KEYS,
        valueBytes: VALUE_BYTES,
        linkBytesPerSecond: LINK_BYTES_PER_SECOND,
        linkLatencyMs: LINK_LATENCY_MS,
        pingIntervalMs: SCALED_PING_INTERVAL_MS,
        pingTimeoutMs: SCALED_PING_TIMEOUT_MS,
        chunkBudgetBytes: CHUNK_BUDGET_BYTES,
    }))
    console.log('Scaling note: ping timers are bench.ts\'s scaled values (~20x below production); the link runs')
    console.log('at 4x the 1 Mbit/s model so three full transfers of the 100k-key store fit in under a minute.')
    console.log('The proven quantity is the occupation/budget ratio, which the scaling preserves; at a true')
    console.log('1 Mbit/s every duration below is exactly 4x longer.')

    const source = createStore<tStandState>(buildStandState())
    const exposed = exposeStoreReplay(source, {history: 1024})
    const keyframeBytes = jsonBytes(exposed.api.replay.keyframe())
    console.log('\nmeasured monolithic keyframe payload: ' + keyframeBytes + ' B ('
        + (keyframeBytes / 1024 / 1024).toFixed(2) + ' MiB) for ' + STORE_KEYS + ' keys')

    const measuredReplay = withWireMeasurement(exposed.api.replay as any) as tReplayWire
    const server = await startStandServer(measuredReplay)
    const relay = await createMeteredRelay({
        targetPort: server.port,
        bytesPerSecond: LINK_BYTES_PER_SECOND,
        latencyMs: LINK_LATENCY_MS,
    })

    const rows: tScenarioRow[] = []
    const scenarios: Array<() => Promise<tScenarioRow>> = [
        () => scenarioMonolithic(relay.port, keyframeBytes),
        () => scenarioChunked(relay.port, relay, source, keyframeBytes),
        () => scenarioReconnect(relay.port, source, keyframeBytes),
    ]
    for (const scenario of scenarios) {
        try { rows.push(await scenario()) }
        catch (error) {
            fails++
            console.log('  FAIL scenario crashed: ' + (error instanceof Error ? error.message : String(error)))
        }
        // Let dead-connection relay timers drain before the next scenario measures.
        await delay(500)
    }

    console.log('')
    console.table(rows)
    console.log(fails == 0 ? 'ALL GREEN' : fails + ' FAILURES')

    await relay.close()
    await server.close()
    exposed.close()
    process.exit(fails == 0 ? 0 : 1)
}

main().catch(function standFailed(error) {
    console.error(error)
    process.exit(1)
})
