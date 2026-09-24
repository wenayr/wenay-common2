// The hosting example is the whole check, and it ends with its own main().catch(...): a stalled
// await there lets the loop empty and the process exits 0 with its later checks unrun. Run it as
// a child and require both a clean exit and the PASS line it prints only after its last check.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import path from 'node:path'
import {runOracle} from '../run-oracle'

const example = path.join(__dirname, '../../experiments/wenay-scaffold/examples/hosting/public-address.ts')
const tsx = path.join(__dirname, '../../node_modules/tsx/dist/cli.mjs')

function main() {
    const child = spawnSync(process.execPath, [tsx, example], {encoding: 'utf8', windowsHide: true, timeout: 120_000})
    process.stdout.write(child.stdout ?? '')
    process.stderr.write(child.stderr ?? '')
    assert.equal(child.status, 0, `public-address example exited with ${child.status}${child.error ? ' (' + child.error.message + ')' : ''}`)
    assert.match(child.stdout, /^PASS H3: /m, 'public-address example stopped before its closing PASS line')
}

runOracle(main)
