// Oracle: ClientAPIAll/ClientAPIStrict replay projection is a TYPE-level contract, and
// tsconfig excludes *.spec.ts while oracles run through tsx — so the check
// here is an explicit `tsc --noEmit` over the fixture. A negative control compiles a
// deliberately broken snippet first: if THAT passes, the tsc invocation itself is broken
// and a green fixture would mean nothing.

import {spawnSync} from 'node:child_process'
import {writeFileSync, rmSync, mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'

const root = path.resolve(__dirname, '..', '..')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const flags = ['--ignoreConfig', '--noEmit', '--strict', '--target', 'esnext', '--module', 'commonjs',
    '--moduleResolution', 'bundler', '--esModuleInterop', '--skipLibCheck']

function typecheck(file: string) {
    const res = spawnSync(process.execPath, [tsc, ...flags, file],
        {cwd: root, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024})
    return {ok: res.status === 0, out: (res.stdout ?? '') + (res.stderr ?? '')}
}

let failures = 0
function report(name: string, ok: boolean, detail = '') {
    if (ok) console.log(`OK ${name}`)
    else {
        failures++
        console.error(`FAIL ${name}`)
        if (detail) console.error(detail.trim().split(/\r?\n/).slice(0, 20).join('\n'))
    }
}

// negative control — a broken file MUST fail
const dir = mkdtempSync(path.join(tmpdir(), 'wenay-types-'))
const bad = path.join(dir, 'bad.ts')
writeFileSync(bad, 'const x: number = "not a number"\nexport {x}\n')
const badRes = typecheck(bad)
report('negative control: broken snippet fails to compile', !badRes.ok)
rmSync(dir, {recursive: true, force: true})

// the fixture — replay projection with no casts must compile clean
const fixture = path.join(root, 'oracle', 'regression', '_clientapiall-replay.fixture.ts')
const fixRes = typecheck(fixture)
report('ClientAPIAll/Strict replay projection compiles with no casts', fixRes.ok, fixRes.out)

console.log(failures === 0 ? 'ALL GREEN (2)' : `${failures} FAILURE(S) / 2`)
process.exit(failures === 0 ? 0 : 1)
