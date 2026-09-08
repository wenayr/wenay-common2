import assert from 'node:assert/strict'
import {cpus, platform, arch, totalmem} from 'node:os'
import {performance} from 'node:perf_hooks'
import {connect, measure} from './benchmark-load'
import {measureProcesses} from './benchmark-processes'

const durationInput = process.env.RENTAL_BENCHMARK_MS
const sustainedMs = durationInput == undefined ? 0 : Number(durationInput)
assert(durationInput == undefined || (Number.isInteger(sustainedMs) && sustainedMs >= 1000 && sustainedMs <= 10000), 'RENTAL_BENCHMARK_MS must be an integer from 1000 to 10000')
const workload = {bookings: 32, warmupPerEndpoint: 80, requests: sustainedMs ? null : 600, sustainedMs, concurrency: 8, trials: 3} as const
const compareGenerators = process.env.RENTAL_BENCHMARK_GENERATORS == 'compare'
assert(process.env.RENTAL_BENCHMARK_GENERATORS == undefined || compareGenerators, 'RENTAL_BENCHMARK_GENERATORS must be compare')
assert(!compareGenerators || sustainedMs > 0, 'generator comparison requires RENTAL_BENCHMARK_MS')

async function runCase(nodes: number, trial: number, generators = 0) {
    const {startStand} = await import('./run.mjs')
    const started = performance.now()
    const stand = await startStand({nodes})
    const startupMs = performance.now() - started
    const clients: ReturnType<typeof connect>[] = []
    const watchdog = setTimeout(function expired() {
        for (const client of clients) client.close()
        void stand.close()
    }, 25000)
    try {
        for (let index = 0; index < workload.bookings; index++) {
            const from = new Date(Date.UTC(2026, 9, index + 1)).toISOString().slice(0, 10)
            const to = new Date(Date.UTC(2026, 9, index + 2)).toISOString().slice(0, 10)
            const response = await fetch(stand.url + '/api/rental/book', {
                method: 'POST', headers: {authorization: 'Bearer ' + stand.token, 'content-type': 'application/json'},
                body: JSON.stringify({args: ['baseline-' + index, {itemId: 'kayak', from, to}]}),
                signal: AbortSignal.timeout(5000),
            })
            assert.equal((await response.json()).ok, true)
        }
        const board = await fetch(stand.url + '/api/rental/board', {signal: AbortSignal.timeout(5000)}).then(response => response.json())
        assert.equal(board.ok, true)
        assert.equal(board.value.bookings.length, workload.bookings)
        const reference = connect(stand.url)
        clients.push(reference)
        await reference.ready()
        const expected = await reference.read()
        const expectedJson = JSON.stringify(expected)
        reference.close()
        clients.pop()
        const endpoints = nodes ? stand.nodeUrls : [stand.url]
        const connecting = performance.now()
        for (const url of endpoints) clients.push(connect(url))
        await Promise.all(clients.map(client => client.ready()))
        for (const client of clients) {
            const deadline = performance.now() + 5000
            while (JSON.stringify(await client.read()) != expectedJson) {
                assert(performance.now() < deadline, 'reader did not catch up')
                await new Promise(function tick(resolve) { setTimeout(resolve, 10) })
            }
            assert.deepEqual(await client.read(), expected)
        }
        const connectAndCatchupMs = performance.now() - connecting
        for (const client of clients) {
            for (let index = 0; index < workload.warmupPerEndpoint; index++) await client.read()
        }
        if (generators) {
            for (const client of clients) client.close()
            clients.length = 0
        }
        const measured = generators
            ? await measureProcesses({endpoints, expected, generators, sustainedMs, concurrency: workload.concurrency, warmup: workload.warmupPerEndpoint})
            : await measure({clients, expected, concurrency: workload.concurrency, sustainedMs, requests: workload.requests ?? 600})
        const {latencies: _samples, ...metrics} = measured
        let restartReadyMs: number | null = null
        if (nodes) {
            clients[0]?.close()
            const restarting = performance.now()
            await stand.restartNode(0)
            const replacement = connect(stand.nodeUrls[0])
            clients.push(replacement)
            await replacement.ready()
            const deadline = performance.now() + 5000
            while (JSON.stringify(await replacement.read()) != expectedJson) {
                assert(performance.now() < deadline, 'replacement did not catch up')
                await new Promise(function tick(resolve) { setTimeout(resolve, 10) })
            }
            assert.deepEqual(await replacement.read(), expected)
            restartReadyMs = performance.now() - restarting
        }
        return {trial, readers: nodes, generators, startupMs, connectAndCatchupMs, ...metrics,
            payloadJsonBytes: Buffer.byteLength(expectedJson), restartReadyMs}
    } finally {
        clearTimeout(watchdog)
        for (const client of clients) client.close()
        await stand.close()
    }
}

async function main() {
    assert(!process.env.SERVICE_DATA_DIR?.trim(), 'benchmark requires an ephemeral stand; unset SERVICE_DATA_DIR')
    const results = []
    for (let trial = 0; trial < workload.trials; trial++) {
        for (let position = 0; position < 3; position++) {
            const modes = compareGenerators ? (trial % 2 ? [2, 1] : [1, 2]) : [0]
            for (const generators of modes) results.push(await runCase((trial + position) % 3, trial + 1, generators))
        }
    }
    console.log('RENTAL_BASELINE ' + JSON.stringify({
        measuredAt: new Date().toISOString(), node: process.version,
        machine: {platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem()},
        workload, dispatch: compareGenerators ? 'two connections total, eight lanes total; one fresh worker owns both or two fresh workers own one each; one connection per reader when two readers exist' : 'explicit round robin; authority excluded when readers present; one client connection per endpoint',
        generator: 'all generator and server processes share a machine; closed-loop fixed total concurrency; latency includes RPC and payload validation; CPU/memory are generator-only; generator=0 means in-process baseline',
        results,
    }))
    if (results.some(result => result.errors)) process.exitCode = 1
}
void main().catch(function failed(error) { console.error(error); process.exitCode = 1 })

