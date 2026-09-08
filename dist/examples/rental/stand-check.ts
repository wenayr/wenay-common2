import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {dirname, join} from 'node:path'
import {createTokenCodec} from 'wenay-common2/server/auth'

async function main() {
    const imported = spawnSync(process.execPath, ['--import', 'tsx', '-e', 'require(process.argv[1])', join(__dirname, 'leader-rental.ts')], {
        cwd: dirname(__filename), encoding: 'utf8', timeout: 5000, windowsHide: true,
    })
    assert.equal(imported.error, undefined, 'import must exit without starting a server')
    assert.equal(imported.status, 0, imported.stderr)
    assert.equal(imported.stdout, '', 'import must not announce a started leader')
    const {startStand} = await import('./run.mjs')
    const previousSecret = process.env.SERVICE_TOKEN_SECRET
    const pinnedSecret = 'rental-stand-pinned-identity-check'
    process.env.SERVICE_TOKEN_SECRET = pinnedSecret
    let stand: Awaited<ReturnType<typeof startStand>>
    try { stand = await startStand({nodes: 1}) }
    finally {
        if (previousSecret == undefined) delete process.env.SERVICE_TOKEN_SECRET
        else process.env.SERVICE_TOKEN_SECRET = previousSecret
    }
    try {
        assert.equal(createTokenCodec({secret: pinnedSecret}).verify(stand.token).ok, true, 'stand preserves configured identity')
        const first = stand.restartNode(0)
        const duplicate = stand.restartNode(0)
        // Let every launched operation settle before assertions so a failing regression cleans up.
        const outcomes = await Promise.allSettled([first, duplicate])
        assert.equal(first, duplicate, 'concurrent restarts share one replacement')
        assert(outcomes.every(outcome => outcome.status == 'fulfilled'))
        assert.equal(stand.view.processes().length, 3)
        assert.equal(stand.view.processes().filter(entry => !entry.exited).length, 2)
        const board = await fetch(stand.url + '/board', {signal: AbortSignal.timeout(5000)})
        assert.equal(board.status, 200)
        await board.arrayBuffer()
        const restart = stand.restartNode(0)
        const closing = stand.close()
        assert.equal(stand.close(), closing, 'close shares completion')
        const [result] = await Promise.allSettled([restart, closing])
        assert.equal(result.status, 'rejected', 'close wins over replacement startup')
        await closing
        assert.equal(stand.view.processes().length, 3, 'no late replacement process')
        for (const entry of stand.view.processes()) {
            assert(entry.exited)
            assert(entry.pid != undefined)
            assert.throws(function processGone() { process.kill(entry.pid!, 0) }, 'owned process has exited')
        }
        assert.throws(() => stand.restartNode(0), /closing/)
        console.log('PASS rental stand: shared restart, board HTTP 200, close wins, owned processes exited')
    } finally { await stand.close() }
}

main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
