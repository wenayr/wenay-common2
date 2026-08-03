// =====================================================================
// Metered TCP relay — the shared slow-network model for experiment stands
// =====================================================================
// A token bucket limits throughput per direction and a fixed one-way delay is
// applied on top, so a stand measures bandwidth and latency the way a real
// constrained link imposes them. Byte counters observe the actual wire,
// WebSocket framing and compression included.
//
// It models bandwidth and latency, NOT packet loss: TCP hides loss as extra
// delay, which the bucket already represents. Loss-specific effects still need
// a route test on the real deployment.
//
// Extracted from experiments/slow-network-2026-08 so a second stand cannot
// drift into a private copy of the model.

import {createServer as createTcpServer, connect as connectTcp, type Socket as TcpSocket} from 'node:net'
import {performance} from 'node:perf_hooks'

const RELAY_MAX_BACKLOG_BYTES = 4 * 1_024 * 1_024

export type MeteredRelayDeps = {
    targetPort: number
    /** Per-direction throughput. Omit for an unmetered pass-through. */
    bytesPerSecond?: number
    /** Fixed one-way delay applied after the line time. */
    latencyMs?: number
}

export type MeteredRelay = {
    port: number
    toServerBytes: () => number
    toClientBytes: () => number
    reset: () => void
    close: () => Promise<void>
}

export async function createMeteredRelay(deps: MeteredRelayDeps): Promise<MeteredRelay> {
    const bytesPerSecond = deps.bytesPerSecond ?? Number.POSITIVE_INFINITY
    const latencyMs = deps.latencyMs ?? 0
    let toServer = 0
    let toClient = 0
    const openSockets = new Set<TcpSocket>()

    function pipeThrottled(source: TcpSocket, sink: TcpSocket, count: (bytes: number) => void) {
        if (bytesPerSecond == Number.POSITIVE_INFINITY && latencyMs == 0) {
            source.on('data', function forward(chunk: Buffer) {
                count(chunk.length)
                if (!sink.destroyed) sink.write(chunk)
            })
            source.on('end', function endSink() {
                if (!sink.destroyed) sink.end()
            })
            return
        }
        // Token bucket: each chunk occupies the modeled line for length/rate,
        // then arrives after the fixed one-way delay.
        let lineFreeAtMs = 0
        let backlogBytes = 0
        source.on('data', function forwardThrottled(chunk: Buffer) {
            count(chunk.length)
            const now = performance.now()
            const startMs = Math.max(now, lineFreeAtMs)
            lineFreeAtMs = startMs + chunk.length * 1_000 / bytesPerSecond
            backlogBytes += chunk.length
            if (backlogBytes > RELAY_MAX_BACKLOG_BYTES) source.pause()
            setTimeout(function deliver() {
                backlogBytes -= chunk.length
                if (!sink.destroyed) sink.write(chunk)
                if (source.isPaused() && backlogBytes <= RELAY_MAX_BACKLOG_BYTES / 2) source.resume()
            }, lineFreeAtMs + latencyMs - now)
        })
        source.on('end', function endSinkThrottled() {
            const now = performance.now()
            setTimeout(function deliverEnd() {
                if (!sink.destroyed) sink.end()
            }, Math.max(0, lineFreeAtMs + latencyMs - now))
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
        pipeThrottled(clientSide, serverSide, bytes => { toServer += bytes })
        pipeThrottled(serverSide, clientSide, bytes => { toClient += bytes })

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
            relayServer.close(function closed() {
                resolve()
            })
        })
    }

    return {
        port: address.port,
        toServerBytes: () => toServer,
        toClientBytes: () => toClient,
        reset: function resetCounters() {
            toServer = 0
            toClient = 0
        },
        close,
    }
}
