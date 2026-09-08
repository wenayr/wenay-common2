import assert from 'node:assert/strict'
import {performance} from 'node:perf_hooks'
import {io} from 'socket.io-client'
import {createRpcClient} from 'wenay-common2/rpc'
import type {createServiceLeader} from './leader'
import type {serviceDefinition} from './service'

type Leader = ReturnType<typeof createServiceLeader<typeof serviceDefinition>>
type Reader = ReturnType<Leader['serve']['readFragment']>

export function connect(url: string) {
    const socket = io(url, {transports: ['websocket'], forceNew: true, reconnection: false})
    const rpc = createRpcClient<{rental: Reader}>({socket, socketKey: 'app'})
    async function read() {
        const frame = await rpc.func.rental.replica.replay.keyframe()
        if (!frame) throw new Error('replica keyframe unavailable')
        return frame[3]
    }
    return {ready: rpc.readyStrict, read, close() { rpc.close(); socket.disconnect() }}
}

export async function measure(deps: {
    clients: ReturnType<typeof connect>[], expected: unknown, concurrency: number, sustainedMs: number, requests: number, fixedLanes?: boolean,
}) {
    const {clients, expected} = deps
    const latencies: number[] = []
    const completions = clients.map(() => 0)
    let attempts = 0
    let errors = 0
    const firstErrors: string[] = []
    const generatorMemoryBefore = process.memoryUsage()
    const generatorCpuBefore = process.cpuUsage()
    const startedAt = Date.now()
    const begin = performance.now()
    async function lane(_value: unknown, laneIndex: number) {
        while (deps.sustainedMs ? performance.now() - begin < deps.sustainedMs : attempts < deps.requests) {
            const sequence = attempts++
            const index = deps.fixedLanes ? laneIndex % clients.length : sequence % clients.length
            const before = performance.now()
            try {
                assert.deepEqual(await clients[index].read(), expected)
                latencies.push(performance.now() - before)
                completions[index]++
            } catch (error) {
                errors++
                if (firstErrors.length < 3) firstErrors.push(String(error))
            }
        }
    }
    await Promise.all(Array.from({length: deps.concurrency}, lane))
    const durationMs = performance.now() - begin
    const generatorCpu = process.cpuUsage(generatorCpuBefore)
    const generatorMemoryAfter = process.memoryUsage()
    latencies.sort((a, b) => a - b)
    return {startedAt, durationMs, attempts, successfulRequests: latencies.length,
        successfulRequestsPerSecond: latencies.length * 1000 / durationMs,
        p50SuccessMs: latencies[Math.ceil(latencies.length * 0.50) - 1] ?? null,
        p95SuccessMs: latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null,
        p99SuccessMs: latencies[Math.ceil(latencies.length * 0.99) - 1] ?? null,
        generatorCpu, generatorMemoryBefore, generatorMemoryAfter, errors, firstErrors, completions, latencies}
}
