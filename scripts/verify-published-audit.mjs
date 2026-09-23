import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const tempRoot = await fs.realpath(os.tmpdir())
const directory = await fs.mkdtemp(path.join(tempRoot, 'wenay-audit-published-'))
function run(args) {
    const result = spawnSync(process.execPath, args, {cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 120_000})
    if (result.error || result.status != 0) throw new Error(`${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    console.log(result.stdout.trim())
}
try {
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({name: 'published-audit', private: true,
        dependencies: {'wenay-common2': manifest.version, tsx: manifest.devDependencies.tsx}}))
    run([npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'])
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'node_modules/wenay-common2/package.json'), 'utf8')).version, manifest.version)
    const mediaFile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'oracle/regression/media-source-generation.spec.ts')
    const media = (await fs.readFile(mediaFile, 'utf8')).replaceAll('../../src/Common/media/media-index', 'wenay-common2/media')
    await fs.writeFile(path.join(directory, 'media.ts'), media)
    const tsx = path.join(directory, 'node_modules/tsx/dist/cli.mjs')
    run([tsx, 'media.ts', '--expect-fixed'])
    const ai = (await fs.readFile(path.join(root, 'oracle/regression/ai-run-persistence.spec.ts'), 'utf8'))
        .replaceAll('../../src/Common/ai/ai-index', 'wenay-common2/ai')
        .replaceAll('../../src/Common/ai/ai-run-client', 'wenay-common2/ai')
    await fs.writeFile(path.join(directory, 'ai.ts'), ai)
    run([tsx, 'ai.ts'])
    console.log(`PASS audit against registry wenay-common2@${manifest.version}; no linked or substituted library`)
} finally {
    const resolved = await fs.realpath(directory)
    assert.equal(path.dirname(resolved), tempRoot)
    assert(path.basename(resolved).startsWith('wenay-audit-published-'))
    await fs.rm(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 100})
}
