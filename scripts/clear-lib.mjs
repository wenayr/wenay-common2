// clear-lib.mjs — reset lib/ before tsc --build.
// Cross-platform replacement for the cmd-only `IF exist lib (rd /s /q lib) && mkdir && copy`.
import * as fs from 'node:fs'

fs.rmSync('lib', {recursive: true, force: true})
fs.mkdirSync('lib')
fs.copyFileSync('tsconfig_lib.json', 'lib/tsconfig.json')
