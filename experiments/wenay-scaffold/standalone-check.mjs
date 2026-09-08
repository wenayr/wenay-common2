// Verify the generated service using only an installed distribution, outside the repository.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {promises as fs} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {instantiate} from './create.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')

async function run(args, cwd) {
    return new Promise(function execute(resolve, reject) {
        const child = spawn(process.execPath, args, {cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true})
        let output = ''
        let settled = false
        const timer = setTimeout(function timedOut() {
            child.kill('SIGKILL')
            finish(new Error(`command exceeded 180s: ${args.join(' ')}`))
        }, 180_000)
        function finish(error) {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (error) reject(error)
            else resolve(output)
        }
        function capture(chunk) { output = (output + String(chunk)).slice(-1_000_000) }
        child.stdout.on('data', capture)
        child.stderr.on('data', capture)
        child.once('error', finish)
        child.once('exit', function exited(code) {
            finish(code != 0 ? new Error(`command failed (${code}): ${args.join(' ')}\n${output}`) : undefined)
        })
    })
}

const tempRoot = await fs.realpath(os.tmpdir())
const work = await fs.mkdtemp(path.join(tempRoot, 'wenay-scaffold-consumer-'))
try {
    const relative = path.relative(root, work)
    assert(relative == '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'consumer must be outside repository')
    const target = path.join(work, 'service')
    await instantiate({name: 'portable-counter', target})
    const packed = JSON.parse(await run([npm, 'pack', path.join(root, 'dist'), '--json', '--pack-destination', work], work))
    await run([npm, 'install', path.join(work, packed[0].filename), '--ignore-scripts', '--no-audit', '--no-fund'], target)

    // Reuse the process oracle, changing only module locations and child working directory.
    // Domain and consumer types still come from the generated factory, not a test schema.
    let runner = await fs.readFile(path.join(here, 'multiprocess-check.ts'), 'utf8')
    runner = runner
        .replace("../../src/Common/core/common", 'wenay-common2')
        .replace("../../src/Common/rcp/rpc-clientHub", 'wenay-common2/rpc')
        .replace("../../src/Common/Observe/node-directory", 'wenay-common2/observe')
        .replace("../../src/Common/Observe/store-follower", 'wenay-common2/observe')
        .replace("import {createClusterClient} from '../../src/Common/scale/scale-client'", "import {Scale} from 'wenay-common2'\nconst {createClusterClient} = Scale")
        .replaceAll("'./template/", "'./")
        .replace("path.resolve(__dirname, '../..')", '__dirname')
        .replace('log() {},', 'log(line) { console.log(line) },')
    assert(!runner.includes('../../src/'), 'consumer oracle must use public package exports')
    assert(!runner.includes("'./template/"), 'consumer oracle must use generated service')
    await fs.writeFile(path.join(target, 'consumer-check.ts'), runner)
    for (const wrapper of ['process-leader.ts', 'process-node.ts']) {
        const source = (await fs.readFile(path.join(here, wrapper), 'utf8')).replaceAll("'./template/", "'./")
        await fs.writeFile(path.join(target, wrapper), source)
    }
    await run([npm, 'run', 'typecheck'], target)
    console.log('PASS generated project and consumer: strict installed-package typecheck')
    console.log(await run(['--import', 'tsx', 'consumer-check.ts'], target))
    console.log('scaffold standalone: ALL GREEN')
} finally {
    const resolved = await fs.realpath(work)
    assert.equal(path.dirname(resolved), tempRoot)
    assert(path.basename(resolved).startsWith('wenay-scaffold-consumer-'))
    await fs.rm(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 100})
}
