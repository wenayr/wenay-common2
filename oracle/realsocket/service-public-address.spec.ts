// The hosting example is the whole check. It ends through runCheck (experiments/wenay-scaffold/
// resources/run-check.ts): a stalled await exits 1 instead of 0, a hang exits 1 at its 120 s
// deadline. Run it as a child and still require both a clean exit and the PASS line it prints only
// after its last check, so a broken guard cannot pass either; the spawn timeout sits past that
// deadline, so the example's own message is what shows.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import path from 'node:path'
import {runOracle} from '../run-oracle'

const example = path.join(__dirname, '../../experiments/wenay-scaffold/examples/hosting/public-address.ts')
const tsx = path.join(__dirname, '../../node_modules/tsx/dist/cli.mjs')

function main() {
    const child = spawnSync(process.execPath, [tsx, example], {encoding: 'utf8', windowsHide: true, timeout: 150_000})
    process.stdout.write(child.stdout ?? '')
    process.stderr.write(child.stderr ?? '')
    assert.equal(child.status, 0, `public-address example exited with ${child.status}${child.error ? ' (' + child.error.message + ')' : ''}`)
    assert.match(child.stdout, /^PASS H3: /m, 'public-address example stopped before its closing PASS line')
}

runOracle(main)
