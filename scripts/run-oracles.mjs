// run-oracles.mjs — run ALL oracles with one command (npm run test:all).
// Convention oracle/README.md: tsx, PASS/FAIL to log, nonzero exit on failure.
// Files run in a pool of child processes (`--jobs N`, default: all cores but two; `--jobs 1` runs
// them in order). A file that binds fixed ports (a `...PORT = 4101` constant) holds those ports
// while it runs, so two files sharing a port never overlap; everything else runs side by side.
import {readdirSync, readFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {availableParallelism} from 'node:os'
import {fileURLToPath} from 'node:url'
import path from 'node:path'

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const groups = [
    ['observe', n => n.endsWith('.test.ts')],
    ['replay', n => n.endsWith('.test.ts') || n.endsWith('.demo.ts')],
    ['oracle', n => n.endsWith('.spec.ts')],
    [path.join('oracle', 'regression'), n => n.endsWith('.spec.ts')],
    [path.join('oracle', 'realsocket'), n => n.endsWith('.spec.ts') && !n.startsWith('_')],
]

const files = []
for (const [dir, match] of groups) {
    for (const e of readdirSync(path.join(root, dir), {withFileTypes: true})) {
        if (e.isFile() && match(e.name)) files.push(path.join(dir, e.name))
    }
}
files.sort()

// An async oracle must end through runOracle (oracle/run-oracle.ts): otherwise an awaited promise
// that never settles lets Node exit 0 and the file reads green while its later checks never ran.
// node:test files report through their runner, synchronous scripts throw by themselves, and a file
// with its own stall guard names it with a `// oracle-ends: <reason>` line.
const sources = new Map(files.map(file => [file, readFileSync(path.join(root, file), 'utf8')]))
function endsHonestly(file) {
    const source = sources.get(file)
    if (/\brunOracle\(/.test(source) || /from ['"]node:test['"]/.test(source)) return true
    if (/^\/\/ oracle-ends: \S/m.test(source)) return true
    return !/\bawait\b|\.then\(/.test(source)
}
const unguarded = files.filter(file => !endsHonestly(file))
if (unguarded.length) {
    console.error('Oracles that can exit 0 without finishing — end them through runOracle (oracle/run-oracle.ts):')
    for (const file of unguarded) console.error('  ' + file)
    process.exit(1)
}

// ======================================== running ========================================

function fixedPorts(source) {
    return [...source.matchAll(/\b\w*port\w*\s*=\s*(\d{4,5})\b/gi)].map(match => Number(match[1]))
}
const ports = new Map(files.map(file => [file, fixedPorts(sources.get(file))]))

function jobsOption() {
    const at = process.argv.indexOf('--jobs')
    const value = at < 0 ? NaN : Number(process.argv[at + 1])
    if (Number.isSafeInteger(value) && value > 0) return value
    return Math.max(1, availableParallelism() - 2)
}

const timeoutMs = 300_000
const maxOutput = 64 * 1024 * 1024

function runFile(file) {
    return new Promise(function runOne(resolve) {
        const start = Date.now()
        const child = spawn(process.execPath, [tsx, file], {cwd: root, windowsHide: true})
        const chunks = []
        let size = 0
        function collect(chunk) {
            if (size >= maxOutput) return
            size += chunk.length
            chunks.push(chunk)
        }
        child.stdout.on('data', collect)
        child.stderr.on('data', collect)
        let timedOut = false
        const timer = setTimeout(function killHung() {
            timedOut = true
            child.kill('SIGKILL')
        }, timeoutMs)
        child.once('error', function failedToStart(error) {
            chunks.push(Buffer.from(String(error)))
        })
        child.once('close', function finished(code) {
            clearTimeout(timer)
            resolve({
                file,
                status: timedOut ? 'timeout' : code,
                secs: ((Date.now() - start) / 1000).toFixed(1),
                output: Buffer.concat(chunks).toString('utf8'),
            })
        })
    })
}

let failed = 0
function report(result) {
    if (result.status == 0) {
        console.log(`OK    ${result.file} (${result.secs}s)`)
        return
    }
    failed++
    console.log(`FAIL  ${result.file} (${result.secs}s, exit ${result.status})`)
    const lines = result.output.trim().split(/\r?\n/)
    const tail = lines.slice(-25)
    const failures = lines.filter(line => /\bFAIL(?:ED)?\b/.test(line))
    for (const line of failures) {
        if (!tail.includes(line)) console.log('      ' + line)
    }
    for (const line of tail) console.log('      ' + line)
}

function runAll(jobs) {
    const queue = [...files]
    const busy = new Set()
    let running = 0
    return new Promise(function schedule(resolve) {
        function pump() {
            while (running < jobs) {
                const index = queue.findIndex(file => ports.get(file).every(port => !busy.has(port)))
                if (index < 0) break
                const [file] = queue.splice(index, 1)
                for (const port of ports.get(file)) busy.add(port)
                running++
                runFile(file).then(function settled(result) {
                    running--
                    for (const port of ports.get(file)) busy.delete(port)
                    report(result)
                    pump()
                })
            }
            if (queue.length == 0 && running == 0) resolve()
        }
        pump()
    })
}

const jobs = jobsOption()
const t0 = Date.now()
await runAll(jobs)
const total = ((Date.now() - t0) / 1000).toFixed(0)
console.log(`\n${files.length - failed}/${files.length} oracles green in ${total}s (${jobs} jobs)${failed ? ` — ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
