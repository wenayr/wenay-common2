// runOracle through its facade, in child processes: a stalled main() must fail the process, a
// finished one must not, an explicit process.exit(0) stays a deliberate success, a throw fails.
// Negative control: the same stalled script WITHOUT runOracle exits 0 — the hole it closes.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const guard = pathToFileURL(path.join(__dirname, 'run-oracle.ts')).href
const tsx = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const dir = mkdtempSync(path.join(os.tmpdir(), 'wenay-run-oracle-'))

function exitOf(name: string, body: string) {
    const file = path.join(dir, name + '.ts')
    writeFileSync(file, body)
    const result = spawnSync(process.execPath, [tsx, file], {encoding: 'utf8', windowsHide: true, timeout: 30_000})
    return {code: result.status, text: result.stdout + result.stderr}
}

const stall = 'async function main() { console.log("PASS first check"); await new Promise(() => {}); console.log("never") }\n'

try {
    const bare = exitOf('bare-stall', stall + 'main().catch(e => { console.error(e); process.exitCode = 1 })\n')
    assert.equal(bare.code, 0, 'negative control: a bare stalled main should exit 0 (the hole)')
    console.log('PASS  negative control: without runOracle a stalled main() exits 0')

    const stalled = exitOf('stalled', `import {runOracle} from '${guard}'\n` + stall + 'runOracle(main)\n')
    assert.equal(stalled.code, 1, stalled.text)
    assert.match(stalled.text, /stopped before main\(\) settled/)
    console.log('PASS  a stalled main() fails the process')

    const finished = exitOf('finished', `import {runOracle} from '${guard}'\nrunOracle(async function main() { await new Promise(r => setTimeout(r, 5)); console.log('PASS done') })\n`)
    assert.equal(finished.code, 0, finished.text)
    console.log('PASS  a finished main() exits 0')

    const exited = exitOf('exited', `import {runOracle} from '${guard}'\nrunOracle(async function main() { await new Promise(r => setTimeout(r, 5)); process.exit(0) })\n`)
    assert.equal(exited.code, 0, exited.text)
    console.log('PASS  an explicit process.exit(0) stays a success')

    const thrown = exitOf('thrown', `import {runOracle} from '${guard}'\nrunOracle(async function main() { throw new Error('boom') })\n`)
    assert.equal(thrown.code, 1, thrown.text)
    assert.match(thrown.text, /boom/)
    console.log('PASS  a thrown main() fails the process')

    // a throw must end the run now, not when open sockets/timers happen to close (a hang until the runner timeout)
    const started = Date.now()
    const thrownOpen = exitOf('thrown-open', `import {runOracle} from '${guard}'\nrunOracle(async function main() { setInterval(() => {}, 1000); throw new Error('boom with a live handle') })\n`)
    assert.equal(thrownOpen.code, 1, 'a thrown main with an open handle must exit 1 promptly: ' + thrownOpen.text)
    assert.ok(Date.now() - started < 20_000, 'took ' + (Date.now() - started) + ' ms')
    console.log('PASS  a thrown main() with an open handle exits at once')

    const failedExit = exitOf('failed-exit', `import {runOracle} from '${guard}'\nrunOracle(async function main() { process.exit(1) })\n`)
    assert.equal(failedExit.code, 1, failedExit.text)
    console.log('PASS run-oracle: stalled and thrown mains fail, finished and deliberate exits keep their code')
} finally {
    rmSync(dir, {recursive: true, force: true})
}
