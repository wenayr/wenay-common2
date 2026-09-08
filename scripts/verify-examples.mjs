// Prove one copyable example as a real consumer: pack dist, install the tarball
// outside the repository, copy the example FROM THE INSTALLED PACKAGE, install
// its own dependencies, then run its typecheck and its check.
//   node scripts/verify-examples.mjs <name>     (rental | pizzeria | apartments | smart-home)
// Add --benchmark to explicitly run an example's optional benchmark after correctness checks.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {promises as fs} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const name = process.argv[2]
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('usage: node scripts/verify-examples.mjs <example-name>')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const tempRoot = await fs.realpath(os.tmpdir())
const work = await fs.mkdtemp(path.join(tempRoot, `wenay-${name}-consumer-`))
function run(args, cwd = work) {
    const result = spawnSync(process.execPath, args, {cwd, encoding: 'utf8', timeout: 240_000, windowsHide: true})
    if (result.error || result.status != 0) throw new Error(`${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    return result.stdout
}
try {
    await fs.writeFile(path.join(work, 'package.json'), JSON.stringify({name: `${name}-package-check`, private: true}))
    const packed = JSON.parse(run([npm, 'pack', path.join(root, 'dist'), '--json', '--pack-destination', work]))
    assert(packed[0].files.some(file => file.path == `examples/${name}/package.json`), `examples/${name} is not packed`)
    const archive = path.join(work, packed[0].filename)
    // Extract the example from the actual installed package, not the checkout.
    run([npm, 'install', archive, '--ignore-scripts', '--no-audit', '--no-fund'])
    const target = path.join(work, name)
    await fs.cp(path.join(work, `node_modules/wenay-common2/examples/${name}`), target, {recursive: true})
    run([npm, 'install', archive, '--ignore-scripts', '--no-audit', '--no-fund'], target)
    console.log(run([npm, 'run', 'typecheck'], target))
    console.log(run([npm, 'run', 'check'], target))
    if (process.argv.includes('--benchmark')) console.log(run([npm, 'run', 'benchmark'], target))
    if (process.argv.includes('--entity-probe')) console.log(run([npm, 'run', 'probe:entities'], target))
    if (process.argv.includes('--http-probe')) console.log(run([npm, 'run', 'probe:http'], target))
    console.log(`PASS installed ${name} example outside repository`)
} finally {
    const resolved = await fs.realpath(work)
    assert.equal(path.dirname(resolved), tempRoot)
    assert(path.basename(resolved).startsWith(`wenay-${name}-consumer-`))
    // KEEP_WORK=1 leaves the installed project behind for a type probe or a manual run
    if (process.env.KEEP_WORK == '1') console.log('kept ' + resolved)
    else await fs.rm(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 100})
}
