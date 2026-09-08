import assert from 'node:assert/strict'
import {createHosting} from './service'

async function until(label: string, predicate: () => boolean) {
    const deadline = Date.now() + 6000
    while (!predicate()) {
        assert(Date.now() < deadline, 'timeout: ' + label)
        await new Promise(function wait(resolve) { setTimeout(resolve, 10) })
    }
}

async function main() {
    const recovering = await createHosting({tenants: ['recovering', 'neighbor']})
    try {
        await recovering.control.deploy('recovering', 'v1')
        await recovering.control.deploy('recovering', 'v2')
        await recovering.control.deploy('neighbor', 'v1')
        await until('initial retirement', () => recovering.view.processes().filter(process => !process.exited).length == 2)
        const active = recovering.view.processes().find(process => process.tenant == 'recovering' && !process.exited)!
        const neighbor = recovering.view.processes().find(process => process.tenant == 'neighbor' && !process.exited)!
        assert(active.pid && active.release == 'v2')
        const endpoint = recovering.source.endpoint('recovering')
        const inFlight = fetch(endpoint + '?delayMs=1500').then(async function received(response) {
            await response.text()
            return response.status
        })
        await until('request executing in owned child', () => recovering.view.processes().some(process => process.pid == active.pid && process.pending == 1))
        // The PID comes only from this host's live fixture process inventory.
        process.kill(active.pid, 'SIGKILL')
        assert.equal(await inFlight, 503, 'a crashed in-flight request is not silently replayed')
        await until('failed release restarted after retry', () => recovering.view.processes().some(process => process.tenant == 'recovering' && process.release == 'v2' && process.pid != active.pid && !process.exited)
            && recovering.view.history().filter(event => event.to?.descriptor.implementationId == 'v2' && event.to.slotId == 'recovering').length >= 2)
        const history = recovering.view.history().filter(event => event.slotId == 'recovering')
        const failedAt = history.findIndex(event => event.reason == 'session failed')
        assert(failedAt >= 0)
        assert(history.slice(failedAt + 1).some(event => event.to?.descriptor.implementationId == 'v1'), 'previous healthy release is re-opened during retry cooldown')
        const response = await fetch(endpoint)
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('x-release'), 'v2')
        await response.text()
        const other = await fetch(recovering.source.endpoint('neighbor'))
        assert.equal(other.status, 200)
        assert.equal(other.headers.get('x-tenant'), 'neighbor')
        await other.text()
        assert(recovering.view.processes().some(process => process.pid == neighbor.pid && !process.exited), 'another site retains its process')
        await until('recovery children retired', () => recovering.view.processes().filter(process => !process.exited).length == 2)
    } finally { await recovering.close() }
    assert(recovering.view.processes().every(process => process.exited))
    console.log('PASS hosting: owned active child crash returns 503 in-flight, falls back, retries newest release and preserves neighbor')
    const overlapping = await createHosting({tenants: ['overlap']})
    try {
        const results = await Promise.allSettled([
            overlapping.control.deploy('overlap', 'v1'),
            overlapping.control.deploy('overlap', 'v2'),
        ])
        assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled'], 'healthy overlapping updates must not report health failure')
        const response = await fetch(overlapping.source.endpoint('overlap'))
        assert.equal(response.headers.get('x-release'), 'v2')
        await response.text()
        await until('superseded process retired', () => overlapping.view.processes().filter(process => !process.exited).length == 1)
        const recovered = await Promise.allSettled([
            overlapping.control.deploy('overlap', 'broken'),
            overlapping.control.deploy('overlap', 'v1'),
            overlapping.control.rollback('overlap'),
        ])
        assert.deepEqual(recovered.map(result => result.status), ['rejected', 'fulfilled', 'fulfilled'])
        if (recovered[0].status == 'rejected') assert.match(String(recovered[0].reason), /health check/)
        const rolledBack = await fetch(overlapping.source.endpoint('overlap'))
        assert.equal(rolledBack.headers.get('x-release'), 'v2', 'rollback follows the queued healthy update')
        await rolledBack.text()
        await until('rejected and retired children exit', () => overlapping.view.processes().filter(process => !process.exited).length == 1)
    } finally { await overlapping.close() }
    assert(overlapping.view.processes().every(process => process.exited))
    console.log('PASS hosting: overlapping updates ordered per site, rejected update does not block deploy/rollback, unused children exit')
    const hosting = await createHosting({tenants: ['bakery', 'studio']})
    try {
        const first = await hosting.control.deploy('bakery', 'v1')
        await hosting.control.deploy('studio', 'v1')
        assert.equal((await fetch(first.endpoint)).headers.get('x-release'), 'v1')
        const old = hosting.view.processes().find(process => process.tenant == 'bakery' && !process.exited)!
        const slow = fetch(first.endpoint + '?delayMs=1500')
        await until('old request executing', () => hosting.view.processes().some(process => process.pid == old.pid && process.pending == 1))
        const next = await hosting.control.deploy('bakery', 'v2')
        assert.equal(next.endpoint, first.endpoint)
        assert(!hosting.view.processes().find(process => process.pid == old.pid)!.exited, 'old process stays alive while request holds a lease')
        const fresh = await fetch(next.endpoint)
        assert.equal(fresh.headers.get('x-release'), 'v2')
        assert((await fresh.text()).includes('fresh release'))
        const oldResponse = await slow
        assert.equal(oldResponse.headers.get('x-release'), 'v1')
        await oldResponse.text()
        await until('old generation drained', () => hosting.view.processes().find(process => process.pid == old.pid)!.exited)
        await assert.rejects(hosting.control.deploy('bakery', 'broken'), /health check/)
        assert.equal((await fetch(first.endpoint)).headers.get('x-release'), 'v2')
        assert.equal((await fetch(hosting.source.endpoint('studio'))).headers.get('x-release'), 'v1')
        const restored = await hosting.control.rollback('bakery')
        assert.equal(restored.release, 'v1')
        assert.equal((await fetch(first.endpoint)).headers.get('x-release'), 'v1')
        await hosting.control.deploy('studio', 'v2')
        assert.equal((await fetch(first.endpoint)).headers.get('x-release'), 'v1', 'another deployment must not undo rollback')
        assert.equal((await fetch(hosting.source.endpoint('studio'))).headers.get('x-tenant'), 'studio')
        await assert.rejects(hosting.control.deploy('foreign', 'v1'), /unknown site/)
        assert.equal((await fetch(first.endpoint.replace('bakery', 'foreign'))).status, 404)
        assert(hosting.view.history().some(event => event.reason == 'rollback'))
        console.log('PASS hosting: real app processes, health gate, stable URL, leased in-flight request, drain, rollback and separate sites')
    } finally { await hosting.close() }
    assert(hosting.view.processes().every(process => process.exited), 'all child processes stopped')
    console.log('PASS hosting: gateway and all app processes closed')

    const interrupted = await createHosting({tenants: ['interrupted']})
    const deployment = interrupted.control.deploy('interrupted', 'v1')
    const rejected = assert.rejects(deployment, /closed/)
    const queued = assert.rejects(interrupted.control.deploy('interrupted', 'v2'), /closed/)
    try {
        await until('candidate process starts', () => interrupted.view.processes().length > 0)
        const firstClose = interrupted.close()
        assert.equal(interrupted.close(), firstClose, 'concurrent close calls share completion')
        await firstClose
        await rejected
        await queued
        assert(!interrupted.view.processes().some(process => process.release == 'v2'), 'shutdown refuses queued update before spawning')
        assert(interrupted.view.processes().every(process => process.exited), 'close waits for preparing child process exit')
        assert(!interrupted.view.history().some(event => event.to), 'interrupted candidate never activates')
        console.log('PASS hosting: close during process preparation rejects deployment and awaits child cleanup')
    } finally { await interrupted.close() }
}

main().catch(function fatal(error) { console.error(error); process.exitCode = 1 })
