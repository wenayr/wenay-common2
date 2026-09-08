import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {cpus, platform, arch} from 'node:os'
import {performance} from 'node:perf_hooks'
import {createEntityProbe} from './entity-probe-resource'

const workload = {reads: 100000, writes: 20000, warmupReads: 10000, trials: 3} as const

function heap() {
    assert(global.gc, 'run with --expose-gc')
    global.gc()
    return process.memoryUsage().heapUsed
}

async function measure(mode: 'shared' | 'facades', count: number, active: number) {
    const ids = Array.from({length: count}, (_, index) => String(index))
    // Warm module/factory paths equally; larger loops below warm the measured read path separately.
    for (const strategy of ['shared', 'facades'] as const) {
        const warm = createEntityProbe({mode: strategy, count: 10})
        warm.view.read('0', 'alice')
        warm.close()
    }
    const baselineHeap = heap()
    const creating = performance.now()
    let probe: ReturnType<typeof createEntityProbe> | undefined = createEntityProbe({mode, count})
    const createMs = performance.now() - creating
    const createdHeap = heap()
    let notifications = 0
    function changed() { notifications++ }
    const offs: (() => void)[] = []
    const subscribing = performance.now()
    for (let index = 0; index < active; index++) offs.push(probe.events.on(ids[index], 'alice', changed))
    const subscribeMs = performance.now() - subscribing
    const subscribedHeap = heap()
    assert.equal(probe.view.counts().streams, active)
    assert.equal(probe.view.counts().subscriptions, active)
    for (let index = 0; index < workload.warmupReads; index++) probe.view.read(ids[index % count], 'alice')
    let checksum = 0
    const reading = performance.now()
    for (let index = 0; index < workload.reads; index++) checksum += probe.view.read(ids[index % count], 'alice').value
    const readMs = performance.now() - reading
    assert.equal(checksum, 0)
    const writing = performance.now()
    for (let index = 0; index < workload.writes; index++) probe.control.write(ids[index % count], 'alice', index + 1)
    const writeMs = performance.now() - writing
    const expectedNotifications = Math.floor(workload.writes / count) * active + Math.min(workload.writes % count, active)
    assert.equal(notifications, expectedNotifications)
    const activeCounts = probe.view.counts()
    const cleaning = performance.now()
    for (const off of offs) off()
    offs.length = 0
    assert.equal(probe.view.counts().streams, 0)
    probe.close()
    const closedCounts = probe.view.counts()
    probe = undefined
    const cleanupMs = performance.now() - cleaning
    await new Promise<void>(function nextTurn(resolve) { setImmediate(resolve) })
    const releasedHeap = heap()
    return {mode, count, active, createMs, subscribeMs, readMs, writeMs, cleanupMs, notifications,
        activeCounts, closedCounts, baselineHeap, createdHeap, subscribedHeap, releasedHeap,
        resourceHeapDelta: createdHeap - baselineHeap, subscriptionHeapDelta: subscribedHeap - createdHeap,
        releasedHeapDelta: releasedHeap - baselineHeap}
}

async function main() {
    if (process.argv.includes('--child')) {
        const mode = process.argv[process.argv.indexOf('--child') + 1]
        assert(mode == 'shared' || mode == 'facades')
        const count = Number(process.argv[process.argv.indexOf('--child') + 2])
        const active = Number(process.argv[process.argv.indexOf('--child') + 3])
        assert([100, 1000, 10000].includes(count) && [0, 100].includes(active))
        console.log(JSON.stringify(await measure(mode, count, active)))
        return
    }
    const results = []
    for (let trial = 1; trial <= workload.trials; trial++) {
        for (const count of [100, 1000, 10000]) {
            for (const active of [0, 100]) {
                const modes = trial % 2 ? ['shared', 'facades'] : ['facades', 'shared']
                for (const mode of modes) {
                    const child = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', __filename, '--child', mode, String(count), String(active)], {
                        encoding: 'utf8', timeout: 15000, windowsHide: true,
                    })
                    assert.equal(child.error, undefined, 'entity probe timed out')
                    assert.equal(child.status, 0, child.stderr)
                    results.push({trial, ...JSON.parse(child.stdout)})
                }
            }
        }
    }
    console.log('ENTITY_API_PROBE ' + JSON.stringify({measuredAt: new Date().toISOString(), node: process.version,
        machine: {platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length}, workload,
        scope: 'local calls only; resource heap includes identical rows/maps; no RPC, HTTP routes or schema generation', results}))
}

void main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
