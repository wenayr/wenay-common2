import assert from 'node:assert/strict'
import express from 'express'
import {spawnSync} from 'node:child_process'
import {performance} from 'node:perf_hooks'
import {cpus, platform} from 'node:os'
import {createHttpFacadeServer} from 'wenay-common2/server'
import {createHostResource} from './http-host'
import {createEntityProbe} from './entity-probe-resource'

type tMode = 'shared' | 'routes'
const workload = {requests: 200, concurrency: 4, warmup: 20, trials: 3} as const

function mount(mode: tMode, count: number, host: ReturnType<typeof createHostResource>, resource: ReturnType<typeof createEntityProbe>) {
    host.resource.app.use(express.json({limit: '4kb'}))
    const authenticate: express.RequestHandler = function principal(request, response, next) {
        const token = request.headers.authorization
        const account = token == 'Bearer demo-alice' ? 'alice' : token == 'Bearer demo-bob' ? 'bob' : null
        if (!account) { response.sendStatus(401); return }
        if (!Array.isArray(request.body?.args)) { response.sendStatus(400); return }
        request.body = {args: [account, ...request.body.args]}
        next()
    }
    function read(account: string, id: string) { return resource.view.read(id, account) }
    const object = mode == 'shared' ? {read} : Object.fromEntries(Array.from({length: count}, function entity(_, index) {
        const id = String(index)
        return ['e' + id, {read: function readEntity(account: string) { return read(account, id) }}]
    }))
    return createHttpFacadeServer({app: host.resource.app, method: 'post', basePath: '/entity', object, middleware: authenticate}).routes().length
}

function heap() {
    assert(global.gc, 'use --expose-gc')
    global.gc()
    return process.memoryUsage().heapUsed
}

async function measure(mode: tMode, count: number) {
    let host: ReturnType<typeof createHostResource> | undefined = createHostResource({host: '127.0.0.1', port: 0})
    let resource: ReturnType<typeof createEntityProbe> | undefined = createEntityProbe({mode: 'shared', count})
    const beforeHeap = heap()
    const registering = performance.now()
    const routeCount = mount(mode, count, host, resource)
    const registerMs = performance.now() - registering
    const registeredHeap = heap()
    try {
        await host.control.listen()
        const url = host.view.url()
        async function request(index: number, token = 'demo-alice', suppliedBody?: object) {
            const id = String(index)
            const response = await fetch(url + (mode == 'shared' ? '/entity/read' : '/entity/e' + id + '/read'), {
                method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + token},
                body: JSON.stringify(suppliedBody ?? {args: mode == 'shared' ? [id] : []}), signal: AbortSignal.timeout(5000),
            })
            const body = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text()
            return {status: response.status, body}
        }
        assert.equal((await request(0, 'invalid')).status, 401)
        assert.equal((await request(count - 1, 'demo-bob')).body.ok, false)
        assert.equal((await request(0, 'demo-bob', {account: 'alice', args: ['alice', '0']})).body.ok, false)
        for (let index = 0; index < workload.warmup; index++) {
            const id = Math.floor(index * count / workload.warmup)
            assert.deepEqual((await request(id)).body.value, {id: String(id), value: 0})
        }
        let next = 0
        let errors = 0
        const latencies: number[] = []
        async function lane() {
            while (next < workload.requests) {
                const id = Math.floor(next++ * (count - 1) / (workload.requests - 1))
                const before = performance.now()
                try {
                    const result = await request(id)
                    assert.equal(result.status, 200)
                    assert.deepEqual(result.body.value, {id: String(id), value: 0})
                    latencies.push(performance.now() - before)
                } catch { errors++ }
            }
        }
        const reading = performance.now()
        await Promise.all(Array.from({length: workload.concurrency}, lane))
        const durationMs = performance.now() - reading
        const postTrafficHeap = heap()
        resource.control.remove('0', 'alice')
        assert.equal((await request(0)).body.ok, false, 'deleted entity has no readable state despite its registered route')
        latencies.sort((a, b) => a - b)
        const closing = performance.now()
        await host.close()
        resource.close()
        const closeMs = performance.now() - closing
        host = undefined
        resource = undefined
        await new Promise<void>(function nextTurn(resolve) { setImmediate(resolve) })
        const releasedHeap = heap()
        assert.equal(errors, 0, 'HTTP request failures invalidate the sample')
        return {mode, count, routeCount, registerMs, registrationHeapDelta: registeredHeap - beforeHeap,
            beforeHeap, registeredHeap, postTrafficHeap, releasedHeap, durationMs,
            successfulRequests: latencies.length, errors, p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1], closeMs}
    } finally {
        await host?.close()
        resource?.close()
    }
}

async function main() {
    const childIndex = process.argv.indexOf('--child')
    if (childIndex >= 0) {
        const mode = process.argv[childIndex + 1]
        const count = Number(process.argv[childIndex + 2])
        assert((mode == 'shared' || mode == 'routes') && [100, 1000, 10000].includes(count))
        console.log(JSON.stringify(await measure(mode, count)))
        return
    }
    const results = []
    for (let trial = 1; trial <= workload.trials; trial++) {
        for (const count of [100, 1000, 10000]) {
            for (const mode of trial % 2 ? ['shared', 'routes'] : ['routes', 'shared']) {
                const child = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', __filename, '--child', mode, String(count)], {
                    encoding: 'utf8', timeout: 30000, windowsHide: true,
                })
                assert.equal(child.error, undefined)
                assert.equal(child.status, 0, child.stderr)
                results.push({trial, ...JSON.parse(child.stdout)})
            }
        }
    }
    console.log('ENTITY_HTTP_PROBE ' + JSON.stringify({measuredAt: new Date().toISOString(), node: process.version,
        machine: {platform: platform(), cpu: cpus()[0]?.model, logicalCpus: cpus().length}, workload,
        scope: 'HTTP loopback in one child process; shared storage; fixed route versus per-entity routes; fixture bearer authentication', results}))
}
void main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
