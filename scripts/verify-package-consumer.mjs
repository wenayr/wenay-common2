import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this check with npm run test:package')

const tempRoot = realpathSync(tmpdir())
const consumer = mkdtempSync(path.join(tempRoot, 'wenay-package-consumer-'))

function run(script, args, cwd, capture = false) {
    const result = spawnSync(process.execPath, [script, ...args], {
        cwd,
        encoding: 'utf8',
        stdio: capture ? 'pipe' : 'inherit',
        timeout: 300_000,
    })
    if (result.error) throw result.error
    if (result.status != 0) {
        if (capture) process.stderr.write((result.stdout ?? '') + (result.stderr ?? ''))
        throw new Error(`Package consumer command failed with exit ${result.status}`)
    }
    return result.stdout
}

try {
    const relative = path.relative(realpathSync(root), realpathSync(consumer))
    if (!path.isAbsolute(relative) && relative != '..' && !relative.startsWith(`..${path.sep}`)) {
        throw new Error('Package consumer temp directory must be outside the repository')
    }
    const packed = JSON.parse(run(npm, ['pack', './dist', '--json', '--pack-destination', consumer], root, true))
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
        name: 'wenay-package-consumer',
        private: true,
        dependencies: {
            'wenay-common2': `file:./${packed[0].filename}`,
            '@types/node': manifest.devDependencies['@types/node'],
            'socket.io': manifest.devDependencies['socket.io'],
            'socket.io-client': manifest.devDependencies['socket.io-client'],
        },
    }, null, 4))
    run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer)

    // Reuse the installed-package smoke; the temp directory cannot see repository dev dependencies.
    const smoke = readFileSync(path.join(root, 'test', 'test.ts'), 'utf8')
    writeFileSync(path.join(consumer, 'test.ts'), smoke + `
import express from 'express'

createHttpFacadeServer({
    app: express(),
    object: {ping() { return 'pong' }},
    method: 'post',
    basePath: '/consumer',
    middleware: function checkRequestTypes(request, response, next) {
        const requestPath: string = request.path
        // @ts-expect-error Express request fields must retain their public types.
        const invalidPath: number = request.path
        void requestPath
        void invalidPath
        response.setHeader('x-consumer', 'verified')
        next()
    },
})
`)
    writeFileSync(path.join(consumer, 'esm.mts'), `
import assert from 'node:assert/strict'
import {listen, Observe, Scale} from 'wenay-common2'
import {listen as clientListen, createRpcClientHub} from 'wenay-common2/client'
import {createStore} from 'wenay-common2/observe'
import {createRpcClient} from 'wenay-common2/rpc'
import {createPeerHost} from 'wenay-common2/peer'
import {openFsReplayStorage} from 'wenay-common2/server/fs'
import {createTokenCodec} from 'wenay-common2/server/auth'
import {createHttpFacadeServer} from 'wenay-common2/server/http'

const store = createStore({count: 0})
const peerHost = createPeerHost()
const peerConnection = peerHost.connection('consumer')
peerConnection.close()
assert.equal(peerConnection.fragment.publish({seq: 0, ts: 0, event: [{path: [], exists: true, value: {count: 1}}]}), false)
assert.equal(peerConnection.fragment.publishBatch([]), false)
assert.equal(await peerConnection.fragment.signal.send({type: 'ice', from: 'consumer', to: 'other', pair: 'consumer-other'}), false)
peerHost.close()
const [emit, changes] = listen<[number]>()
const off = changes.on(function updateCount(value) { store.state.count = value })
emit(7)
off()
assert.equal(store.snapshot().count, 7)
assert.equal(Observe.createStore, createStore)
assert.equal(clientListen, listen)
for (const value of [Scale.createClusterClient, createRpcClientHub, createRpcClient,
    openFsReplayStorage, createTokenCodec, createHttpFacadeServer]) {
    assert.equal(typeof value, 'function')
}
console.log('ESM consumer: named exports and runtime passed')
`)
    // Re-export the full browser surface so tree shaking cannot hide an incompatible member.
    writeFileSync(path.join(consumer, 'browser.ts'), `export * from 'wenay-common2/client'\nexport * from 'wenay-common2/service'\nexport * from 'wenay-common2/service/client'\n`)
    const serviceTypes = readFileSync(path.join(root, 'type-tests', 'service-runtime.ts'), 'utf8')
        .replaceAll('../src/service/client', 'wenay-common2/service/client')
        .replaceAll('../src/service', 'wenay-common2/service')
    writeFileSync(path.join(consumer, 'service-types.ts'), serviceTypes)
    const arrayTypes = readFileSync(path.join(root, 'type-tests', 'service-schema-object-arrays.ts'), 'utf8')
        .replaceAll('../src/service/client', 'wenay-common2/service/client')
        .replaceAll('../src/service', 'wenay-common2/service')
    writeFileSync(path.join(consumer, 'service-array-types.ts'), arrayTypes)
    const resourceTypes = readFileSync(path.join(root, 'type-tests', 'service-resources.ts'), 'utf8')
        .replaceAll('../src/service/client', 'wenay-common2/service/client')
        .replaceAll('../src/service', 'wenay-common2/service')
        .replaceAll('../src/Common/events/Listen', 'wenay-common2/listen')
    writeFileSync(path.join(consumer, 'service-resource-types.ts'), resourceTypes)
    const persistenceTypes = readFileSync(path.join(root, 'type-tests', 'ai-run-persistence.ts'), 'utf8')
        .replaceAll('../src/Common/ai/ai-index', 'wenay-common2/ai')
        .replaceAll('../src/service/host', 'wenay-common2/service/host')
    writeFileSync(path.join(consumer, 'ai-persistence-types.ts'), persistenceTypes)
    const ownershipTypes = readFileSync(path.join(root, 'type-tests', 'async-ownership.ts'), 'utf8')
        .replaceAll('../src/client', 'wenay-common2/client')
        .replaceAll('../src', 'wenay-common2')
    writeFileSync(path.join(consumer, 'async-ownership-types.ts'), ownershipTypes)
    writeFileSync(path.join(consumer, 'service-server.cjs'), `
const assert = require('node:assert/strict')
const {describeService, createServiceLeader, schemaCommand} = require('wenay-common2/service/server')
const definition = {name: 'isolated', storeId: 'isolated', originId: 'isolated', initial: {secret: 'MUST_NOT_LEAK'}, commands: {ping: {apply() { return 1 }}}}
const descriptor = describeService(definition)
assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), {name: 'isolated', commands: {ping: null}, views: {}})
const leader = createServiceLeader({definition, selfUrl: () => 'http://localhost'})
leader.control.close()
assert.equal(typeof schemaCommand, 'function')
assert.equal(typeof require('wenay-common2/server/process').createProcessResource, 'function')
assert.equal(typeof require('wenay-common2/server/blob').createLocalBlobStorage, 'function')
`)
    writeFileSync(path.join(consumer, 'type-flow.ts'), `
import {Observe, createRpcClient, type SocketTmpl} from 'wenay-common2'
declare const socket: SocketTmpl
function checkPublicTypeFlow() {
    const store = Observe.createStore({count: 0, label: 'counter'})
    const exposed = Observe.exposeStoreReplay(store)
    const client = createRpcClient<typeof exposed.api>({socket, socketKey: 'typed'})
    const follower = Observe.createStoreFollower({remote: client.func.replay})
    const count: number = follower.store.state.count
    // @ts-expect-error installed declarations retain replay state fields
    const wrong: string = follower.store.state.count
    // @ts-expect-error typed source cannot populate an unrelated destination
    Observe.syncStoreReplay(Observe.createStore({count: ''}), client.func.replay)
    async function read() {
        const all = await client.func.get()
        const value: number = all.count
        const selected = await client.func.get({count: true})
        // @ts-expect-error installed declarations preserve the selected mask
        selected.label
        void value
    }
    void count
    void wrong
    void read
}
void checkPublicTypeFlow
`)
    writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            target: 'ES2022',
            module: 'Node16',
            moduleResolution: 'Node16',
            strict: true,
            skipLibCheck: false,
            esModuleInterop: true,
            types: ['node'],
            outDir: 'output',
        },
        files: ['test.ts', 'esm.mts', 'browser.ts', 'type-flow.ts', 'service-types.ts', 'service-array-types.ts', 'service-resource-types.ts', 'ai-persistence-types.ts', 'async-ownership-types.ts'],
    }, null, 4))
    run(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ['-p', 'tsconfig.json'], consumer)
    run(path.join(consumer, 'output', 'test.js'), [], consumer)
    run(path.join(consumer, 'output', 'esm.mjs'), [], consumer)
    run(path.join(consumer, 'service-server.cjs'), [], consumer)
    run(path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), [
        'browser.ts', '--bundle', '--platform=browser', '--format=esm', '--outfile=browser.js',
    ], consumer)
    console.log('Isolated tarball consumer: CJS/ESM types and runtime, browser bundle passed')
} finally {
    const resolved = realpathSync(consumer)
    if (path.dirname(resolved) != tempRoot || !path.basename(resolved).startsWith('wenay-package-consumer-')) {
        throw new Error(`Refusing to remove unexpected consumer directory: ${resolved}`)
    }
    rmSync(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 100})
}
