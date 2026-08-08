import {existsSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'

import * as srcIndex from '../../src/index'
import * as srcObserve from '../../src/Common/Observe/reactive'
import * as srcConversation from '../../src/Common/conversation/conversation-index'
import * as srcContract from '../../src/Common/contract/contract-index'
import * as srcHttps from '../../src/Common/https/https-index'

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
const focusedExports = [
    {subpath: 'listen', target: './lib/Common/events/listen-index.js', sentinel: 'listen'},
    {subpath: 'rpc', target: './lib/Common/rcp/rpc-index.js', sentinel: 'createRpcClient'},
    {subpath: 'debug-console', target: './lib/debug-console.js', sentinel: 'installConsoleCallerAnnotations'},
    {subpath: 'server/fs', target: './lib/server/fs-index.js', sentinel: 'openFsReplayStorage'},
    {subpath: 'server/auth', target: './lib/server/auth-token.js', sentinel: 'createTokenCodec'},
    {subpath: 'server/http', target: './lib/server/httpFacadeServer.js', sentinel: 'createHttpFacadeServer'},
    {subpath: 'server/webhook', target: './lib/server/WebHook3.js', sentinel: 'createWebhookServer'},
] as const

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

function assertConversationApi(label: string, api: any) {
    assert(api, `${label} is missing`)
    assertEq(typeof api.createConversationHost, 'function', `${label}.createConversationHost export`)
    assertEq(typeof api.createConversationClient, 'function', `${label}.createConversationClient export`)
    assertEq(typeof api.copyConversationData, 'function', `${label}.copyConversationData export`)
}

function assertContractApi(label: string, api: any) {
    assert(api, `${label} is missing`)
    assertEq(typeof api.createContractOffers, 'function', `${label}.createContractOffers export`)
    assertEq(typeof api.resolveContractBinding, 'function', `${label}.resolveContractBinding export`)
    assertEq(typeof api.createContractRuntime, 'function', `${label}.createContractRuntime export`)
}

function assertHttpsApi(label: string, api: any) {
    assert(api, `${label} is missing`)
    assertEq(typeof api.createNodeHttpsManager, 'function', `${label}.createNodeHttpsManager export`)
    assertEq(typeof api.normalizeHttpsConfig, 'function', `${label}.normalizeHttpsConfig export`)
    assertEq(typeof api.createCaddyfile, 'function', `${label}.createCaddyfile export`)
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

test('src/index exports Conversation namespace', () => {
    assertConversationApi('src/index Conversation', srcIndex.Conversation)
    assertEq(srcIndex.Conversation.createConversationHost, srcConversation.createConversationHost,
        'src/index Conversation.createConversationHost re-exports direct src module')
})

test('src/index exports Contract namespace', () => {
    assertContractApi('src/index Contract', srcIndex.Contract)
    assertEq(srcIndex.Contract.createContractRuntime, srcContract.createContractRuntime,
        'src/index Contract.createContractRuntime re-exports direct src module')
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

test("package.json exports './conversation'", () => {
    const packageJson = requireFromSpec(resolve(rootDir, 'package.json'))
    assertEq(packageJson.exports?.['./conversation'], './lib/Common/conversation/conversation-index.js',
        "package.json exports['./conversation']")
})

for (const entry of focusedExports) {
    test(`package.json exports './${entry.subpath}'`, () => {
        const packageJson = requireFromSpec(resolve(rootDir, 'package.json'))
        assertEq(packageJson.exports?.[`./${entry.subpath}`], entry.target,
            `package.json exports['./${entry.subpath}']`)

        const packageName = `wenay-common2/${entry.subpath}`
        const resolved = requireFromSpec.resolve(packageName)
        assert(
            resolved.replace(/\\/g, '/').endsWith(entry.target.slice(1)),
            `${packageName} resolved to unexpected path: ${resolved}`,
        )
        const api = requireFromSpec(packageName)
        assertEq(typeof api[entry.sentinel], 'function', `${packageName}.${entry.sentinel} export`)

        const declaration = resolve(rootDir, entry.target.slice(2).replace(/\.js$/, '.d.ts'))
        assert(existsSync(declaration), `${packageName} declaration is present`)
    })
}

test("package.json exports './contract'", () => {
    const packageJson = requireFromSpec(resolve(rootDir, 'package.json'))
    assertEq(packageJson.exports?.['./contract'], './lib/Common/contract/contract-index.js',
        "package.json exports['./contract']")
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

test('lib artifacts export Conversation namespace and direct module', () => {
    const libIndex = resolve(rootDir, 'lib/index.js')
    const libConversation = resolve(rootDir, 'lib/Common/conversation/conversation-index.js')
    if (!existsSync(libIndex) || !existsSync(libConversation)) {
        skip('lib artifacts export Conversation namespace and direct module', 'Conversation build artifacts are not present')
        return
    }
    assertConversationApi('lib/index Conversation', requireFromSpec(libIndex).Conversation)
    assertConversationApi('lib/Common/conversation', requireFromSpec(libConversation))
})

test("package.json exports './https' and the installed CLI", () => {
    const packageJson = requireFromSpec(resolve(rootDir, 'package.json'))
    assertEq(packageJson.exports?.['./https'], './lib/Common/https/https-index.js',
        "package.json exports['./https']")
    assertEq(packageJson.bin?.['wenay-https'], './lib/cli/wenay-https.js',
        "package.json bin['wenay-https']")
    assertHttpsApi('src/Common/https', srcHttps)

    const resolved = requireFromSpec.resolve('wenay-common2/https')
    assert(
        resolved.replace(/\\/g, '/').endsWith('/lib/Common/https/https-index.js'),
        `wenay-common2/https resolved to unexpected path: ${resolved}`,
    )
    assertHttpsApi('wenay-common2/https', requireFromSpec('wenay-common2/https'))
})

test('lib artifacts export Contract namespace and direct module', () => {
    const libIndex = resolve(rootDir, 'lib/index.js')
    const libContract = resolve(rootDir, 'lib/Common/contract/contract-index.js')
    if (!existsSync(libIndex) || !existsSync(libContract)) {
        skip('lib artifacts export Contract namespace and direct module', 'Contract build artifacts are not present')
        return
    }
    assertContractApi('lib/index Contract', requireFromSpec(libIndex).Contract)
    assertContractApi('lib/Common/contract', requireFromSpec(libContract))
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

test('dist package artifacts include Conversation exports when dist is present', () => {
    const distDir = resolve(rootDir, 'dist')
    if (!existsSync(distDir)) {
        skip('dist package artifacts include Conversation exports when dist is present', 'dist directory is not present')
        return
    }
    const distPackageJson = requireFromSpec(resolve(distDir, 'package.json'))
    const distIndex = requireFromSpec(resolve(distDir, 'lib/index.js'))
    const distConversationPath = resolve(distDir, 'lib/Common/conversation/conversation-index.js')
    assertEq(distPackageJson.exports?.['./conversation'], './lib/Common/conversation/conversation-index.js',
        "dist package exports['./conversation']")
    assert(existsSync(distConversationPath), 'dist Conversation JavaScript artifact is present')
    assert(existsSync(resolve(distDir, 'lib/Common/conversation/conversation-index.d.ts')),
        'dist Conversation declaration artifact is present')
    assertConversationApi('dist/lib/index Conversation', distIndex.Conversation)
    assertConversationApi('dist/lib/Common/conversation', requireFromSpec(distConversationPath))
})

test('dist package artifacts include Contract exports when dist is present', () => {
    const distDir = resolve(rootDir, 'dist')
    if (!existsSync(distDir)) {
        skip('dist package artifacts include Contract exports when dist is present', 'dist directory is not present')
        return
    }
    const distPackageJson = requireFromSpec(resolve(distDir, 'package.json'))
    const distIndex = requireFromSpec(resolve(distDir, 'lib/index.js'))
    const distContractPath = resolve(distDir, 'lib/Common/contract/contract-index.js')
    assertEq(distPackageJson.exports?.['./contract'], './lib/Common/contract/contract-index.js',
        "dist package exports['./contract']")
    assert(existsSync(distContractPath), 'dist Contract JavaScript artifact is present')
    assert(existsSync(resolve(distDir, 'lib/Common/contract/contract-index.d.ts')),
        'dist Contract declaration artifact is present')
    assertContractApi('dist/lib/index Contract', distIndex.Contract)
    assertContractApi('dist/lib/Common/contract', requireFromSpec(distContractPath))
})

test('dist package artifacts include HTTPS API, declarations, and CLI when dist is present', () => {
    const distDir = resolve(rootDir, 'dist')
    if (!existsSync(distDir)) {
        skip('dist package artifacts include HTTPS API, declarations, and CLI', 'dist directory is not present')
        return
    }
    const distPackageJson = requireFromSpec(resolve(distDir, 'package.json'))
    const distHttpsPath = resolve(distDir, 'lib/Common/https/https-index.js')
    const distHttpsDts = resolve(distDir, 'lib/Common/https/https-index.d.ts')
    const distCliPath = resolve(distDir, 'lib/cli/wenay-https.js')
    assertEq(distPackageJson.exports?.['./https'], './lib/Common/https/https-index.js',
        "dist package exports['./https']")
    assertEq(distPackageJson.bin?.['wenay-https'], './lib/cli/wenay-https.js',
        "dist package bin['wenay-https']")
    assert(existsSync(distHttpsPath), 'dist HTTPS JavaScript artifact is present')
    assert(existsSync(distHttpsDts), 'dist HTTPS declaration artifact is present')
    assert(existsSync(distCliPath), 'dist HTTPS CLI artifact is present')
    assertHttpsApi('dist/lib/Common/https', requireFromSpec(distHttpsPath))
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
