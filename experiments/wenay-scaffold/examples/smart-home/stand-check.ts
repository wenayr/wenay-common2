import assert from 'node:assert/strict'
import {startHomeStand} from './stand'

async function main() {
    const stand = await startHomeStand()
    const pids = new Set([stand.view.pid('anna'), stand.view.pid('bob')])
    try {
        const first = stand.control.restart('anna')
        const second = stand.control.restart('anna')
        assert.equal(first, second, 'concurrent restart requests share one replacement process')
        await first
        pids.add(stand.view.pid('anna'))
        const restarting = stand.control.restart('anna')
        const closing = stand.close()
        const [restartResult] = await Promise.allSettled([restarting, closing])
        assert.equal(restartResult.status, 'rejected', 'close wins over a pending restart')
        await closing
        for (const pid of pids) {
            assert(pid != undefined)
            assert.throws(function processIsGone() { process.kill(pid, 0) }, 'all owned processes exited')
        }
        assert.throws(() => stand.control.restart('anna'), /closing/)
        console.log('PASS process resource: single-flight restart, close wins, no remaining owned process')
    } finally { await stand.close() }
}

main().catch(function fatal(error) { console.error(error); process.exitCode = 1 })
