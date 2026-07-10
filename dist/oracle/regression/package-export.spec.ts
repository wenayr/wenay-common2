import {existsSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'

import * as srcIndex from '../../src/index'
import * as srcObserve from '../../src/Common/Observe/reactive'

type Api = {
    reactive: Function
    onUpdate: Function
    flushReactive: Function
    listenUpdate: Function
}

let failures = 0
const tests: Array<{name: string; run: () => void | Promise<void>}> = []
const requireFromSpec = createRequire(__filename)
const rootDir = resolve(__dirname, '../..')

function test(name: string, run: () => void | Promise<void>) {
    tests.push({name, run})
}

function assert(cond: unknown, message: string) {
    if (!cond) throw new Error(message)
}

function assertEq<T>(actual: T, expected: T, message: string) {
    if (!Object.is(actual, expected)) {
        throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
    }
}

function assertApi(label: string, api: any): asserts api is Api {
    assert(api, `${label} is missing`)
    assertEq(typeof api.reactive, 'function', `${label}.reactive export`)
    assertEq(typeof api.onUpdate, 'function', `${label}.onUpdate export`)
    assertEq(typeof api.flushReactive, 'function', `${label}.flushReactive export`)
    assertEq(typeof api.listenUpdate, 'function', `${label}.listenUpdate export`)
}

function skip(name: string, reason: string) {
    console.log(`SKIP ${name}: ${reason}`)
}

test('src/Common/Observe/reactive direct import exposes Observe API', () => {
    assertApi('src/Common/Observe/reactive', srcObserve)
})

test('src/index exports Observe namespace', () => {
    assertApi('src/index Observe', srcIndex.Observe)
    assertEq(srcIndex.Observe.reactive, srcObserve.reactive, 'src/index Observe.reactive re-exports direct src module')
    assertEq(srcIndex.Observe.onUpdate, srcObserve.onUpdate, 'src/index Observe.onUpdate re-exports direct src module')
})

test("package.json exports './observe'", () => {
    const packageJson = requireFromSpec(resolve(rootDir, 'package.json'))
    assertEq(packageJson.exports?.['./observe'], './lib/Common/Observe/index.js', "package.json exports['./observe']")

    const resolved = requireFromSpec.resolve('wenay-common2/observe')
    assert(
        resolved.replace(/\\/g, '/').endsWith('/lib/Common/Observe/index.js'),
        `wenay-common2/observe resolved to unexpected path: ${resolved}`,
    )
    assertApi('wenay-common2/observe', requireFromSpec('wenay-common2/observe'))
})

test('lib root index exports Observe namespace', () => {
    const libIndex = resolve(rootDir, 'lib/index.js')
    if (!existsSync(libIndex)) {
        skip('lib root index exports Observe namespace', 'lib/index.js is not present')
        return
    }

    const libApi = requireFromSpec(libIndex)
    assertApi('lib/index Observe', libApi.Observe)
})

test('dist package artifacts include observe export when dist is present', () => {
    const distDir = resolve(rootDir, 'dist')
    if (!existsSync(distDir)) {
        skip('dist package artifacts include observe export when dist is present', 'dist directory is not present')
        return
    }

    const distPackageJsonPath = resolve(distDir, 'package.json')
    const distObserveJs = resolve(distDir, 'lib/Common/Observe/reactive.js')
    const distObserveDts = resolve(distDir, 'lib/Common/Observe/reactive.d.ts')
    const distIndexJs = resolve(distDir, 'lib/index.js')

    assert(existsSync(distPackageJsonPath), 'dist/package.json is present')
    assert(existsSync(distObserveJs), 'dist observe JavaScript artifact is present')
    assert(existsSync(distObserveDts), 'dist observe declaration artifact is present')
    assert(existsSync(distIndexJs), 'dist lib/index.js artifact is present')

    const distPackageJson = requireFromSpec(distPackageJsonPath)
    assertEq(distPackageJson.exports?.['./observe'], './lib/Common/Observe/index.js', "dist package exports['./observe']")
    assertApi('dist/lib/Common/Observe/reactive.js', requireFromSpec(distObserveJs))
    assertApi('dist/lib/index.js Observe', requireFromSpec(distIndexJs).Observe)
})

async function main() {
    for (const t of tests) {
        try {
            await t.run()
            console.log(`OK ${t.name}`)
        } catch (e: any) {
            failures++
            console.error(`FAIL ${t.name}`)
            console.error(e?.stack ?? e)
        }
    }
    console.log(failures === 0 ? `ALL GREEN (${tests.length})` : `${failures} FAILURE(S) / ${tests.length}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => {
    console.error(e?.stack ?? e)
    process.exit(1)
})
