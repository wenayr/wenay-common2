import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {connect, measure} from './benchmark-load'

type Job = {urls: string[], expected: unknown, concurrency: number, sustainedMs: number, warmup: number}
type Result = Awaited<ReturnType<typeof measure>>

async function worker() {
    const clients: ReturnType<typeof connect>[] = []
    function receive() {
        return new Promise<unknown>(function message(resolve) { process.once('message', resolve) })
    }
    try {
        const job = await receive() as Job
        for (const url of job.urls) clients.push(connect(url))
        await Promise.all(clients.map(client => client.ready()))
        for (const client of clients) {
            for (let index = 0; index < job.warmup; index++) assert.deepEqual(await client.read(), job.expected)
        }
        const start = receive()
        process.send!({ready: true})
        const {startAt} = await start as {startAt: number}
        await new Promise(function wait(resolve) { setTimeout(resolve, Math.max(0, startAt - Date.now())) })
        const result = await measure({...job, clients, requests: 0, fixedLanes: true})
        await new Promise<void>(function report(resolve, reject) {
            process.send!({result}, function sent(error) { if (error) reject(error); else resolve() })
        })
    } finally {
        for (const client of clients) client.close()
        process.disconnect?.()
    }
}

export async function measureProcesses(deps: {
    endpoints: string[], expected: unknown, generators: number, sustainedMs: number, concurrency: number, warmup: number,
}) {
    assert([1, 2].includes(deps.generators) && deps.sustainedMs > 0)
    // Two connections total in both variants: split those same connections across workers.
    const urls = [deps.endpoints[0], deps.endpoints[1] ?? deps.endpoints[0]]
    const workers = Array.from({length: deps.generators}, function launch(_, index) {
        const child = spawn(process.execPath, ['--import', 'tsx', __filename, '--load-worker'], {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
        })
        let stderr = ''
        child.stderr!.on('data', function errorData(chunk) { stderr = (stderr + String(chunk)).slice(-2000) })
        let readyResolve!: () => void
        let readyReject!: (error: Error) => void
        const ready = new Promise<void>(function waitReady(resolve, reject) { readyResolve = resolve; readyReject = reject })
        let resultResolve!: (result: Result) => void
        let resultReject!: (error: Error) => void
        let received = false
        const result = new Promise<Result>(function waitResult(resolve, reject) { resultResolve = resolve; resultReject = reject })
        // Both channels can fail before the orchestrator starts awaiting them.
        void ready.catch(function observed() {})
        void result.catch(function observed() {})
        function fail(error: Error) { readyReject(error); resultReject(error) }
        const done = new Promise<void>(function waitExit(resolve, reject) {
            child.once('error', function failed(error) { fail(error); reject(error) })
            child.once('exit', function exited(code) {
                if (code != 0 || !received) {
                    const error = new Error('load worker exited: ' + code + ' ' + stderr)
                    fail(error)
                    reject(error)
                } else resolve()
            })
        })
        void done.catch(function observed() {})
        child.on('message', function message(value: unknown) {
            const data = value as {ready?: boolean, result?: Result}
            if (data.ready) readyResolve()
            if (data.result) { received = true; resultResolve(data.result) }
        })
        const timeout = setTimeout(function expired() {
            fail(new Error('load worker timed out'))
            child.kill('SIGKILL')
        }, 20000)
        child.send({urls: deps.generators == 1 ? urls : [urls[index]], expected: deps.expected,
            concurrency: deps.concurrency / deps.generators, sustainedMs: deps.sustainedMs,
            warmup: deps.warmup}, function sent(error) { if (error) fail(error) })
        return {child, ready, result, done, timeout, fail}
    })
    try {
        await Promise.all(workers.map(item => item.ready))
        const startAt = Date.now() + 150
        for (const item of workers) item.child.send({startAt}, function sent(error) { if (error) item.fail(error) })
        const results = await Promise.all(workers.map(item => item.result))
        await Promise.all(workers.map(item => item.done))
        const startedAt = Math.min(...results.map(item => item.startedAt))
        const durationMs = Math.max(...results.map(item => item.startedAt + item.durationMs)) - startedAt
        const latencies = results.flatMap(item => item.latencies).sort((a, b) => a - b)
        return {startedAt, durationMs, attempts: results.reduce((sum, item) => sum + item.attempts, 0),
            successfulRequests: latencies.length, successfulRequestsPerSecond: latencies.length * 1000 / durationMs,
            p50SuccessMs: latencies[Math.ceil(latencies.length * 0.50) - 1] ?? null,
            p95SuccessMs: latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null,
            p99SuccessMs: latencies[Math.ceil(latencies.length * 0.99) - 1] ?? null,
            errors: results.reduce((sum, item) => sum + item.errors, 0),
            firstErrors: results.flatMap(item => item.firstErrors).slice(0, 3),
            completions: results.flatMap(item => item.completions),
            workers: results.map(function summary({latencies: _samples, ...facts}) { return facts }), latencies}
    } finally {
        for (const item of workers) {
            clearTimeout(item.timeout)
            if (item.child.exitCode == null && item.child.signalCode == null) item.child.kill('SIGKILL')
        }
        await Promise.allSettled(workers.map(item => item.done))
    }
}

if (process.argv.includes('--load-worker')) void worker().catch(function failed(error) { console.error(error); process.exitCode = 1 })
