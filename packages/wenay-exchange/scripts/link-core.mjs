// Development only: resolve 'wenay-common2' to the repository's built package (../../dist), the
// same way the repository's test/ project consumes it. Consumers get it as a peer dependency.
import {existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.resolve(here, '../../dist')
const link = path.join(here, 'node_modules', 'wenay-common2')

if (!existsSync(path.join(target, 'package.json'))) throw new Error(`build wenay-common2 first: ${target} has no package.json`)
let current = null
try { current = lstatSync(link).isSymbolicLink() ? path.resolve(path.dirname(link), readlinkSync(link)) : 'not a link' } catch {}
if (current != target) {
    rmSync(link, {recursive: true, force: true})
    mkdirSync(path.dirname(link), {recursive: true})
    // A junction needs no elevation on Windows; other platforms ignore the type.
    symlinkSync(target, link, 'junction')
}
