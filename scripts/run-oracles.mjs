// run-oracles.mjs — run ALL oracles with one command (npm run test:all).
// Convention oracle/README.md: ts-node --transpile-only, PASS/FAIL to log,
// nonzero exit on failure. Sequential run: socket-oracles hold ports.
// NOT in the publish gate (fast npm run test stays there) — this is the
// command to 'verify everything' when touching core (events / Observe / replay / rpc).
// Files named *-extended-stress.* stay outside that routine gate and run through
// --extended-stress; their stdout is retained because workload counters are the result.
import {readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import path from 'node:path'

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const tsNode = path.join(root, 'node_modules', 'ts-node', 'dist', 'bin.js')
const stressOnly = process.argv.includes('--stress')
const extendedStressOnly = process.argv.includes('--extended-stress')

function isExtendedStress(name) {
    return name.endsWith('-extended-stress.test.ts')
        || name.endsWith('-extended-stress.spec.ts')
}

const allGroups = [
    ['observe', n => n.endsWith('.test.ts')],
    ['replay', n => (n.endsWith('.test.ts') || n.endsWith('.demo.ts')) && !isExtendedStress(n)],
    ['oracle', n => n.endsWith('.spec.ts')],
    [path.join('oracle', 'regression'), n => n.endsWith('.spec.ts')],
    [path.join('oracle', 'realsocket'), n => n.endsWith('.spec.ts') && !n.startsWith('_')],
    [path.join('src', 'Common', 'rcp'),
        n => n.endsWith('-stress.spec.ts') && !isExtendedStress(n)],
]

const stressGroups = [
    ['replay', n => n.endsWith('-stress.test.ts') && !isExtendedStress(n)],
    [path.join('src', 'Common', 'rcp'),
        n => n.endsWith('-stress.spec.ts') && !isExtendedStress(n)],
]
const extendedStressGroups = [
    ['replay', n => n.endsWith('-extended-stress.test.ts')],
    [path.join('src', 'Common', 'rcp'), n => n.endsWith('-extended-stress.spec.ts')],
]
const groups = extendedStressOnly ? extendedStressGroups : stressOnly ? stressGroups : allGroups

const files = []
for (const [dir, match] of groups) {
    for (const e of readdirSync(path.join(root, dir), {withFileTypes: true})) {
        if (e.isFile() && match(e.name)) files.push(path.join(dir, e.name))
    }
}
files.sort()

if (extendedStressOnly) {
    const expected = [
        path.join('replay', 'video-windows-extended-stress.test.ts'),
    ]
    const missing = expected.filter(file => !files.includes(file))
    if (missing.length) {
        console.error('Missing extended stress oracles: ' + missing.join(', '))
        process.exit(1)
    }
}

let failed = 0
const t0 = Date.now()
for (const file of files) {
    const start = Date.now()
    const res = spawnSync(process.execPath, [tsNode, '--transpile-only', file],
        {
            cwd: root,
            encoding: 'utf8',
            timeout: extendedStressOnly ? 900_000 : 300_000,
            maxBuffer: 64 * 1024 * 1024,
        })
    const secs = ((Date.now() - start) / 1000).toFixed(1)
    if (res.status == 0) {
        console.log(`OK    ${file} (${secs}s)`)
        if (extendedStressOnly) {
            const output = (res.stdout ?? '').trim()
            for (const line of output.split(/\r?\n/)) {
                if (line) console.log('      ' + line)
            }
        }
    } else {
        failed++
        console.log(`FAIL  ${file} (${secs}s, exit ${res.status})`)
        const lines = ((res.stdout ?? '') + (res.stderr ?? '')).trim().split(/\r?\n/)
        const tail = lines.slice(-25)
        const failures = lines.filter(line => /\bFAIL(?:ED)?\b/.test(line))
        for (const line of failures) {
            if (!tail.includes(line)) console.log('      ' + line)
        }
        for (const line of tail) console.log('      ' + line)
    }
}
const total = ((Date.now() - t0) / 1000).toFixed(0)
const label = extendedStressOnly
    ? 'extended stress oracles'
    : stressOnly
        ? 'stress oracles'
        : 'oracles'
console.log(`\n${files.length - failed}/${files.length} ${label} green in ${total}s${failed ? ` — ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
