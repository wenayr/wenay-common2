// prepare.mjs — install consumer-test deps once.
// Cross-platform replacement for the cmd-only `IF not exist node_modules\wenay-common2 (npm install)`.
import {existsSync} from 'node:fs'
import {execSync} from 'node:child_process'

if (!existsSync('node_modules/wenay-common2')) execSync('npm install', {stdio: 'inherit'})
