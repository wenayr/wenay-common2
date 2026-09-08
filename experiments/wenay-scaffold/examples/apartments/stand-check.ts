import assert from 'node:assert/strict'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

async function main() {
    const {startStand} = await import('./run.mjs')
    const temp = await realpath(tmpdir())
    const data = await mkdtemp(path.join(temp, 'apartments-stand-check-'))
    let stand: Awaited<ReturnType<typeof startStand>> | undefined
    const pending: Promise<unknown>[] = []
    try {
        const aborted = new AbortController()
        aborted.abort()
        await assert.rejects(startStand({nodes: 0, device: false, dataDir: data, signal: aborted.signal}), /cancelled/)
        stand = await startStand({nodes: 1, device: true, dataDir: data})
        assert.equal(stand.view.processes().length, 3, 'leader, serving node and device are owned')
        const first = stand.restartLeader()
        const duplicate = stand.restartLeader()
        pending.push(first, duplicate)
        assert.equal(first, duplicate, 'concurrent leader restarts share one replacement')
        const seq = await first
        assert.match(seq, /^\d+$/, 'restart retains archived sequence result')
        assert.equal(stand.view.processes().length, 4, 'only one replacement was created')
        const healthy = await fetch(stand.url + '/panel', {signal: AbortSignal.timeout(5000)})
        assert.equal(healthy.status, 200, 'restarted authority serves HTTP')
        await healthy.text()
        const restart = stand.restartLeader()
        pending.push(restart)
        const closing = stand.close()
        assert.equal(stand.close(), closing, 'close shares completion')
        const [result] = await Promise.allSettled([restart, closing])
        assert.equal(result.status, 'rejected', 'close wins over restart after old process stops')
        await closing
        assert.equal(stand.view.processes().length, 4, 'no child is created after close')
        for (const entry of stand.view.processes()) {
            assert(entry.exited, 'every owned process exited, including device')
            assert(entry.pid != undefined)
            assert.throws(function gone() { process.kill(entry.pid!, 0) })
        }
        assert.throws(() => stand!.restartLeader(), /closing/)
        console.log('PASS apartments stand: single-flight leader restart, archive sequence, healthy HTTP, close wins, device cleanup, pre-aborted startup')
    } finally {
        // Also clean up a broken implementation during the failing-first regression.
        await Promise.allSettled(pending)
        await stand?.close()
        for (const entry of stand?.view.processes() ?? []) {
            if (entry.pid && !entry.exited) {
                try { process.kill(entry.pid, 'SIGKILL') } catch {}
            }
        }
        const deadline = Date.now() + 5000
        while (stand?.view.processes().some(entry => !entry.exited) && Date.now() < deadline) {
            await new Promise(function wait(resolve) { setTimeout(resolve, 10) })
        }
        if (stand) assert(stand.view.processes().every(entry => entry.exited), 'test cleanup owns every child')
        const resolved = await realpath(data)
        assert.equal(path.dirname(resolved), temp)
        assert(path.basename(resolved).startsWith('apartments-stand-check-'))
        await rm(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 100})
    }
}

main().catch(function failed(error) {
    console.error(error)
    process.exitCode = 1
})
