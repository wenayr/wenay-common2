import assert from 'node:assert/strict'

async function main() {
    const {startStand} = await import('./run.mjs')
    const stand = await startStand({nodes: 1})
    try {
        const first = stand.restartNode(0)
        const duplicate = stand.restartNode(0)
        assert.equal(first, duplicate, 'concurrent restarts share one replacement')
        await first
        assert.equal(stand.view.processes().length, 3, 'one leader, one stopped node, one replacement')
        assert.equal(stand.view.processes().filter(entry => !entry.exited).length, 2)
        const restart = stand.restartNode(0)
        const closing = stand.close()
        assert.equal(stand.close(), closing, 'concurrent close shares completion')
        const [result] = await Promise.allSettled([restart, closing])
        assert.equal(result.status, 'rejected', 'close wins over replacement startup')
        await closing
        assert.equal(stand.view.processes().length, 3, 'close prevented a late replacement process')
        for (const entry of stand.view.processes()) {
            assert(entry.exited)
            assert(entry.pid != undefined)
            assert.throws(function processGone() { process.kill(entry.pid!, 0) }, 'owned process has exited')
        }
        assert.throws(() => stand.restartNode(0), /closing/)
        console.log('PASS small-jobs stand: single-flight restart, close wins, owned processes exited')
    } finally { await stand.close() }
}

main().catch(function fatal(error) { console.error(error); process.exitCode = 1 })
