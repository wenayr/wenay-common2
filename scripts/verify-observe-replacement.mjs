// Verify the regression through the installed public Observe entrypoint, without links.
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const published = process.argv.includes('--published')
const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const tempRoot = await fs.realpath(os.tmpdir())
const work = await fs.mkdtemp(path.join(tempRoot, 'common2-observe-replacement-'))

function run(args) {
    const result = spawnSync(process.execPath, args, {cwd: work, encoding: 'utf8', windowsHide: true, timeout: 180_000})
    if (result.error || result.status != 0) throw new Error(`${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    return result.stdout
}

try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    let dependency = manifest.version
    if (!published) {
        const packed = JSON.parse(run([npm, 'pack', path.join(root, 'dist'), '--json', '--pack-destination', work]))
        dependency = 'file:./' + packed[0].filename
    }
    await fs.writeFile(path.join(work, 'package.json'), JSON.stringify({private: true, dependencies: {
        'wenay-common2': dependency, 'tsx': manifest.devDependencies.tsx,
        'typescript': manifest.devDependencies.typescript, '@types/node': manifest.devDependencies['@types/node'],
    }}))
    const files = []
    for (const source of ['observe/reactive-admission.test.ts', 'oracle/regression/store-proxy-replacement.spec.ts']) {
        const file = path.basename(source)
        const code = (await fs.readFile(path.join(root, source), 'utf8')).replace(/['"](?:\.\.\/)+src\/Common\/Observe['"]/g, "'wenay-common2/observe'")
        assert(!code.includes('/src/'))
        await fs.writeFile(path.join(work, file), code)
        files.push(file)
    }
    await fs.writeFile(path.join(work, 'tsconfig.json'), JSON.stringify({compilerOptions: {
        target: 'ESNext', module: 'Node16', moduleResolution: 'Node16', strict: true,
        noEmit: true, skipLibCheck: false, lib: ['ESNext', 'DOM'], types: ['node'],
    }, files}))
    run([npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'])
    assert.equal(JSON.parse(await fs.readFile(path.join(work, 'node_modules/wenay-common2/package.json'), 'utf8')).version, manifest.version)
    console.log(run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']))
    for (const file of files) console.log(run(['--import', 'tsx', file]))
    console.log(`PASS ${published ? 'registry' : 'tarball'} Observe replacement ${manifest.version}: public types and regressions`)
} finally {
    const resolved = await fs.realpath(work)
    assert.equal(path.dirname(resolved), tempRoot)
    assert(path.basename(resolved).startsWith('common2-observe-replacement-'))
    await fs.rm(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 100})
}
