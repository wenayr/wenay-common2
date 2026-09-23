// Verify the actual consumer's migrated Docker/LXD compositions, sequentially.
// Only the isolated copy is changed. --published installs the exact registry release.
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {migrateHostingAgent} from './hosting-agent-migration.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = path.resolve(process.argv[2] ?? path.join(root, '../wenay-examples/apps/hosting'))
const published = process.argv.includes('--published')
const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const tempRoot = await fs.realpath(os.tmpdir())
const work = await fs.mkdtemp(path.join(tempRoot, 'common2-hosting-agents-'))

function run(command, args, accepted = [0]) {
    const result = spawnSync(command, args, {cwd: work, encoding: 'utf8', windowsHide: true, timeout: 240_000})
    if (result.error || !accepted.includes(result.status)) throw new Error(`${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    return result.stdout
}

try {
    for (const directory of ['backend', 'frontend']) await fs.cp(path.join(app, directory), path.join(work, directory), {recursive: true})
    await fs.copyFile(path.join(app, 'tsconfig.json'), path.join(work, 'tsconfig.json'))
    await fs.writeFile(path.join(work, 'tsconfig.agents.json'), JSON.stringify({extends: './tsconfig.json',
        include: ['backend/agent.ts', 'backend/lxd-agent.ts', 'backend/agent-check.ts', 'backend/lxd-check.ts']}))
    const manifest = JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8'))
    const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version
    let dependency = version
    if (!published) {
        const packed = JSON.parse(run(process.execPath, [npm, 'pack', path.join(root, 'dist'), '--json', '--pack-destination', work]))
        dependency = 'file:./' + packed[0].filename
    }
    manifest.dependencies['wenay-common2'] = dependency
    await fs.writeFile(path.join(work, 'package.json'), JSON.stringify(manifest, null, 4))
    let patch = ''
    for (const [file, kind] of [['agent.ts', 'docker'], ['lxd-agent.ts', 'lxd']]) {
        const original = await fs.readFile(path.join(work, 'backend', file), 'utf8')
        const migrated = migrateHostingAgent(original, kind)
        assert(!/\b(busy|dirty|running|closing)\b|new AbortController|setTimeout/.test(migrated), 'duplicated orchestration survived')
        const before = path.join(work, 'before', 'apps', 'hosting', 'backend', file)
        const after = path.join(work, 'after', 'apps', 'hosting', 'backend', file)
        await fs.mkdir(path.dirname(before), {recursive: true})
        await fs.mkdir(path.dirname(after), {recursive: true})
        await fs.writeFile(before, original.replaceAll('\r\n', '\n'))
        await fs.writeFile(after, migrated)
        const diff = run('git', ['diff', '--no-index', '--no-prefix', '--', 'before/apps/hosting/backend/' + file, 'after/apps/hosting/backend/' + file], [0, 1])
        patch += diff.replaceAll('before/apps/', 'a/apps/').replaceAll('after/apps/', 'b/apps/')
        await fs.writeFile(path.join(work, 'backend', file), migrated)
    }
    if (!published) {
        await fs.mkdir(path.join(root, 'doc/migrations'), {recursive: true})
        await fs.writeFile(path.join(root, `doc/migrations/hosting-${version}.patch`), patch)
    } else assert.equal(patch, await fs.readFile(path.join(root, `doc/migrations/hosting-${version}.patch`), 'utf8'), 'consumer changed since the migration was verified')
    run(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'])
    assert.equal(JSON.parse(await fs.readFile(path.join(work, 'node_modules/wenay-common2/package.json'), 'utf8')).version, version)
    if (published) assert.equal(await fs.readFile(path.join(work, `node_modules/wenay-common2/doc/migrations/hosting-${version}.patch`), 'utf8'), patch)
    console.log(run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.agents.json']))
    for (const check of ['resource-scope.spec.ts', 'reconciler.spec.ts']) {
        const source = await fs.readFile(path.join(root, 'oracle/regression', check), 'utf8')
        assert(source.includes("'../../src'"))
        await fs.writeFile(path.join(work, check), source.replaceAll("'../../src'", "'wenay-common2'"))
        console.log(run(process.execPath, ['--import', 'tsx', check]))
    }
    for (const check of ['agent-check.ts', 'lxd-check.ts']) console.log(run(process.execPath, ['--import', 'tsx', 'backend/' + check]))
    console.log(`PASS actual migrated Docker/LXD agents against ${published ? 'registry' : 'tarball'} common2 ${version}`)
} finally {
    const resolved = await fs.realpath(work)
    assert.equal(path.dirname(resolved), tempRoot)
    assert(path.basename(resolved).startsWith('common2-hosting-agents-'))
    if (process.env.KEEP_WORK == '1') console.log('kept ' + resolved)
    else await fs.rm(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 100})
}
