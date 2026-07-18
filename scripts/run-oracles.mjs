// run-oracles.mjs — прогнать ВСЕ оракулы одной командой (npm run test:all).
// Конвенция oracle/README.md: ts-node --transpile-only, PASS/FAIL в лог,
// ненулевой exit при провале. Запуск последовательный: socket-оракулы держат порты.
// В publish-гейт НЕ входит (там остаётся быстрый npm run test) — это команда
// «проверить всё», когда трогаешь ядро (events / Observe / replay / rpc).
import {readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import path from 'node:path'

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const tsNode = path.join(root, 'node_modules', 'ts-node', 'dist', 'bin.js')

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

let failed = 0
const t0 = Date.now()
for (const file of files) {
    const start = Date.now()
    const res = spawnSync(process.execPath, [tsNode, '--transpile-only', file],
        {cwd: root, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024})
    const secs = ((Date.now() - start) / 1000).toFixed(1)
    if (res.status === 0) {
        console.log(`OK    ${file} (${secs}s)`)
    } else {
        failed++
        console.log(`FAIL  ${file} (${secs}s, exit ${res.status})`)
        const tail = ((res.stdout ?? '') + (res.stderr ?? '')).trim().split(/\r?\n/).slice(-25)
        for (const line of tail) console.log('      ' + line)
    }
}
const total = ((Date.now() - t0) / 1000).toFixed(0)
console.log(`\n${files.length - failed}/${files.length} oracles green in ${total}s${failed ? ` — ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
