// runCheck (experiments/wenay-scaffold/resources/run-check.ts, shipped as run-check.ts in every
// example) through its facade, in child processes. A stalled main() fails at once; a failed one fails
// at once even while handles are open, with its error visible; a process still alive at the deadline
// fails and says whether main() had settled; a passing run, a main() that sets its own exit code and
// a deliberate process.exit(0) keep their code. Negative controls: the same stall and hang ended with
// the bare main().catch(...) of the examples exit 0 and never exit.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {runOracle} from '../run-oracle'

const root = path.join(__dirname, '../..')
const guard = pathToFileURL(path.join(root, 'experiments/wenay-scaffold/resources/run-check.ts')).href
const bareEnding = 'main().catch(function failed(error) { console.error(error); process.exitCode = 1 })\n'
const stall = 'async function main() { console.log("PASS first check"); await new Promise(() => {}); console.log("PASS never reached") }\n'
const hang = 'async function main() { setInterval(() => {}, 1000); await new Promise(() => {}); console.log("PASS never reached") }\n'

function main() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wenay-run-check-'))
    // one process per script (no tsx CLI wrapper), so a timeout kill cannot leave an orphan behind
    function run(name: string, body: string, timeout = 60_000) {
        const file = path.join(dir, name + '.ts')
        writeFileSync(file, body)
        const started = Date.now()
        const child = spawnSync(process.execPath, ['--import', 'tsx', file], {cwd: root, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024})
        return {code: child.status, timedOut: child.error != undefined, stdout: child.stdout, text: child.stdout + child.stderr, ms: Date.now() - started}
    }
    function guarded(name: string, body: string) {
        return run(name, `import {runCheck} from '${guard}'\n` + body)
    }
    try {
        const bare = run('bare-stall', stall + bareEnding)
        assert.equal(bare.code, 0, 'negative control: a stall ended with main().catch(...) exits 0 (the hole)')
        assert.doesNotMatch(bare.text, /never reached/)
        console.log('PASS  negative control: without runCheck a stalled main() exits 0 with its later checks unrun')

        const bareHang = run('bare-hang', hang + bareEnding, 3000)
        assert.equal(bareHang.timedOut, true, 'negative control: a hang ended with main().catch(...) never exits: ' + bareHang.text)
        console.log('PASS  negative control: without runCheck a stall with an open handle never exits (killed after 3 s)')

        const stalled = guarded('stalled', stall + 'runCheck(main)\n')
        assert.equal(stalled.code, 1, stalled.text)
        assert.match(stalled.text, /FAIL stalled\.ts: main\(\) never settled/)
        assert.doesNotMatch(stalled.text, /never reached/)
        console.log('PASS  a stalled main() exits 1 at once and names the file')

        // the default deadline (minutes) is far beyond this run: an unref'd timer lets it end at once
        const passed = guarded('passed', 'runCheck(async function main() { await new Promise(resolve => setTimeout(resolve, 5)); console.log("PASS done") })\n')
        assert.equal(passed.code, 0, passed.text)
        assert.equal(passed.text.trim(), 'PASS done', 'a passing run prints nothing else')
        assert.ok(passed.ms < 30_000, 'took ' + passed.ms + ' ms')
        console.log('PASS  a passing run is unchanged and not held by the deadline timer')

        const ownCode = guarded('own-code', 'runCheck(async function main() { console.log("1 check FAILED"); process.exitCode = 1 })\n')
        assert.equal(ownCode.code, 1, ownCode.text)
        assert.doesNotMatch(ownCode.text, /FAIL own-code\.ts/)
        console.log('PASS  a main() that sets process.exitCode keeps it')

        const failed = guarded('failed', 'runCheck(async function main() { throw new Error("boom: the assertion text") })\n')
        assert.equal(failed.code, 1, failed.text)
        assert.match(failed.text, /FAIL failed\.ts: main\(\) failed: Error: boom: the assertion text/)
        console.log('PASS  a failed main() exits 1 with its error visible')

        // with the default deadline only the immediate exit can beat the 60 s spawn timeout
        const failedOpen = guarded('failed-open', 'runCheck(async function main() { setInterval(() => {}, 1000); throw new Error("boom with a live handle") })\n')
        assert.equal(failedOpen.code, 1, 'a failed main() with an open handle must exit 1 at once: ' + failedOpen.text)
        assert.match(failedOpen.text, /boom with a live handle/)
        assert.ok(failedOpen.ms < 30_000, 'took ' + failedOpen.ms + ' ms')
        console.log('PASS  a failed main() with an open handle exits 1 at once')

        // POSIX pipes are asynchronous: the report and what main() printed must still arrive whole
        const large = guarded('large', 'runCheck(async function main() { setInterval(() => {}, 1000); console.log("o".repeat(1_000_000)); throw new Error("e".repeat(1_000_000)) })\n')
        assert.equal(large.code, 1)
        assert.ok(large.stdout.includes('o'.repeat(1_000_000)), 'stdout lost before exit')
        assert.ok(large.text.includes('e'.repeat(1_000_000)), 'the failure report was lost before exit')
        console.log('PASS  a large failure report and earlier output are flushed before the exit')

        const hung = guarded('hung', hang + 'runCheck(main, 1500)\n')
        assert.equal(hung.code, 1, hung.text)
        assert.match(hung.text, /FAIL hung\.ts: main\(\) still pending after 1\.5 s/)
        assert.ok(hung.ms >= 1500, 'exited before the deadline: ' + hung.ms + ' ms')
        console.log('PASS  a hang with an open handle exits 1 at the deadline')

        const leaked = guarded('leaked', 'runCheck(async function main() { setInterval(() => {}, 1000); console.log("PASS all checks") }, 1500)\n')
        assert.equal(leaked.code, 1, leaked.text)
        assert.match(leaked.text, /FAIL leaked\.ts: main\(\) finished, but an open socket, server, timer or child process kept the process alive for 1\.5 s/)
        console.log('PASS  a leaked handle after main() finished exits 1 at the deadline and says so')

        const exited = guarded('exited', 'runCheck(async function main() { setInterval(() => {}, 1000); await new Promise(resolve => setTimeout(resolve, 5)); process.exit(0) })\n')
        assert.equal(exited.code, 0, exited.text)
        assert.doesNotMatch(exited.text, /FAIL/)
        console.log('PASS  a deliberate process.exit(0) inside main() stays a success')
        console.log('PASS run-check: stalls, failures, hangs and leaked handles exit 1; passing runs and deliberate exits keep their code')
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
}

runOracle(main)
