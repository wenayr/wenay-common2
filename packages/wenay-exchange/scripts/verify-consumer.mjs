// Prove wenay-exchange as a real consumer gets it: pack the built wenay-common2 (../../dist) and this
// package, install both tarballs outside the repository, compile a consumer strictly against the
// installed declarations (skipLibCheck off) and run it, plus this package's specs rewritten to
// import the installed packages.
//   npm run build && node scripts/verify-consumer.mjs
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(here, '../..')
const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const work = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'wenay-exchange-consumer-'))

function run(args, capture = false) {
    const result = spawnSync(process.execPath, args, {cwd: work, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 300_000, windowsHide: true})
    if (result.error || result.status != 0) throw new Error(`${args.join(' ')} failed\n${result.error ?? ''}${capture ? result.stdout + result.stderr : ''}`)
    return result.stdout
}

function pack(directory) {
    return path.join(work, JSON.parse(run([npm, 'pack', directory, '--json', '--pack-destination', work], true))[0].filename)
}

// The consumer smoke: the old root shape, one TF identity, and the streams CTimeSeries needs.
const consumer = `
import assert from 'node:assert/strict'
import {TF, Params} from 'wenay-common2'
import {Bars, CQuotesHistory, ByteStreamR, ByteStreamW} from 'wenay-exchange'

// Bars carries the core time surface by re-export: one class, so identity checks keep working.
assert.equal(Bars.TF, TF)
assert.equal(Bars.TF.H1, TF.H1)

const bars = Bars.createRandomBars(TF.M1, new Date(Date.UTC(2020, 0, 1)), 120, 100, 1, 0.01)
assert.equal(bars.length, 120)
assert.equal(bars.Tf, TF.M1)
const history = new CQuotesHistory(bars)
const hourly = history.get(TF.H1)
assert.ok(hourly && hourly.length >= 2 && hourly.length <= 3, 'M1 bars build H1 on demand')

const series = new Bars.CTimeSeries<number>('closes', [...bars].slice(0, 5).map(bar => ({time: bar.time, value: bar.close})))
const out = new ByteStreamW()
assert.ok(series.write(out, 'double'))
const back = Bars.CTimeSeries.read(new ByteStreamR(out.data), 'double')
assert.deepEqual([...back].map(point => point.value), [...series].map(point => point.value))

// Params stays in the core: it is the generic settings model (wenay-react2 edits it), not exchange data.
const values = Params.toValues({period: {name: 'period', value: 14, range: {min: 1, max: 100, step: 1}}})
assert.equal(values.period, 14)
console.log('wenay-exchange consumer: shared TF identity, bars, history and time-series streams passed; Params from the core')
`

try {
    const built = JSON.parse(readFileSync(path.join(repo, 'dist', 'package.json'), 'utf8'))
    assert.ok(existsSync(path.join(here, 'lib', 'index.js')), 'build wenay-exchange first (npm run build)')
    const core = pack(path.join(repo, 'dist'))
    const exchange = pack(here)
    const rootManifest = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'))
    writeFileSync(path.join(work, 'package.json'), JSON.stringify({name: 'wenay-exchange-consumer', private: true}))
    run([npm, 'install', core, exchange, `@types/node@${rootManifest.devDependencies['@types/node']}`, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'])
    const installed = name => JSON.parse(readFileSync(path.join(work, 'node_modules', name, 'package.json'), 'utf8')).version
    assert.equal(installed('wenay-common2'), built.version)
    assert.equal(installed('wenay-exchange'), JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8')).version)
    // The peer resolved to the single installed core: no nested second copy.
    assert.ok(!existsSync(path.join(work, 'node_modules', 'wenay-exchange', 'node_modules', 'wenay-common2')), 'a second wenay-common2 copy was installed')
    // A project that needs only the core downloads no server stack (express is an optional peer since 3.0.0).
    for (const server of ['express', 'axios', 'socket.io']) assert.ok(!existsSync(path.join(work, 'node_modules', server)), `${server} was installed`)

    writeFileSync(path.join(work, 'consumer.ts'), consumer)
    const bars = readFileSync(path.join(here, 'test', 'bars-ticksize.spec.ts'), 'utf8')
        .replace("import {CBar, CBars, CBarsMutable} from '../src/Bars'", "import {Bars} from 'wenay-exchange'\nconst {CBar, CBars, CBarsMutable} = Bars")
    const streams = readFileSync(path.join(here, 'test', 'bytestream.spec.ts'), 'utf8').replace("from '../src/ByteStream'", "from 'wenay-exchange'")
    assert.ok(!/from '\.\.?\//.test(bars + streams), 'a spec still imports a repository path')
    writeFileSync(path.join(work, 'bars-ticksize.spec.ts'), bars)
    writeFileSync(path.join(work, 'bytestream.spec.ts'), streams)
    writeFileSync(path.join(work, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', strict: true, skipLibCheck: false,
            esModuleInterop: true, types: ['node'], outDir: 'output'},
        files: ['consumer.ts', 'bars-ticksize.spec.ts', 'bytestream.spec.ts'],
    }))
    run([path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'])
    for (const file of ['consumer.js', 'bars-ticksize.spec.js', 'bytestream.spec.js']) run([path.join(work, 'output', file)])
    console.log(`Installed wenay-common2 ${built.version} + wenay-exchange tarballs: strict types and runtime passed`)
} finally {
    rmSync(work, {recursive: true, force: true, maxRetries: 3, retryDelay: 100})
}
