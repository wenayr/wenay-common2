// Artifact runtime oracle: private storage keys stay server-side; authorized
// descriptor replay and short-lived open instructions travel over existing RPC.
import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {createArtifactClient, createArtifactFrame, createArtifactHost} from '../src/Common/artifact/artifact-index'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

let fails = 0
function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

function delay(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function waitFor(label: string, condition: () => boolean) {
    for (let i = 0; i < 150; i++) {
        if (condition()) return
        await delay(10)
    }
    throw new Error('timeout: ' + label)
}

async function main() {
    console.log('\n[artifact] storage-backed descriptors + sandboxed iframe over existing RPC')

    let clock = 1_000
    const removed: Array<{key: string, reason: string}> = []
    let retryRemoval = true
    let retryRevokeRemoval = true
    const host = createArtifactHost({
        storage: {
            open({storageKey, account}) {
                return {url: 'https://artifact.example/' + storageKey + '?account=' + account, expiresAt: clock + 60}
            },
            remove({storageKey, reason}) {
                removed.push({key: String(storageKey), reason})
                if (storageKey == 'private-object-retry' && retryRemoval) {
                    retryRemoval = false
                    throw new Error('temporary storage removal failure')
                }
                if (storageKey == 'private-object-revoke' && retryRevokeRemoval) {
                    retryRevokeRemoval = false
                    throw new Error('temporary storage removal failure')
                }
            },
        },
        id: (() => { let n = 0; return () => 'artifact-' + (++n) })(),
        now: () => clock,
        drain: 'micro',
    })
    let missingEphemeralExpiry = false
    try {
        host.register({
            owner: 'a',
            descriptor: {kind: 'assistant-app', label: 'Missing expiry', runtime: 'sandboxed-iframe'},
            storageKey: 'private-object-missing-expiry',
            retention: {class: 'ephemeral'} as any,
        })
    } catch { missingEphemeralExpiry = true }
    ok(missingEphemeralExpiry, 'ephemeral artifact cannot omit an expiry')
    const artifact = host.register({
        owner: 'a',
        descriptor: {kind: 'assistant-app', label: 'Counter', runtime: 'sandboxed-iframe', mime: 'text/html', version: '1'},
        storageKey: 'private-object-a',
        retention: {class: 'ephemeral', expiresAt: 1_500},
    })

    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer)
    ioServer.on('connection', function onConnection(socket) {
        const account = String(socket.handshake.auth?.account)
        const artifacts = host.connection(account)
        const [disconnect, disconnectListen] = createListenPair<[]>()
        socket.on('disconnect', function onDisconnect() { disconnect(); artifacts.close() })
        createRpcServerAuto({
            socket: {emit: (key, data) => socket.emit(key, data), on: (key, cb) => socket.on(key, cb)},
            socketKey: 'app',
            object: {legacy: () => 'still here', artifacts: artifacts.fragment},
            disconnectListen,
        })
    })
    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    const port = (httpServer.address() as AddressInfo).port

    async function connect(account: string) {
        const hub = createRpcClientHub(
            () => io('http://127.0.0.1:' + port, {transports: ['websocket'], forceNew: true, auth: {account}}),
            rpc => ({app: rpc<any>('app')}),
        )
        const clients = await hub.setToken(null)
        await clients.app.readyStrict()
        const artifacts = createArtifactClient({remote: clients.app.func.artifacts, drain: 'micro'})
        await artifacts.ready
        return {func: clients.app.func, artifacts, close: () => hub.socket?.disconnect?.()}
    }

    const a = await connect('a')
    const b = await connect('b')
    ok(await a.func.legacy() == 'still here', 'artifact fragment leaves existing RPC keys untouched')
    await waitFor('owner descriptor', () => !!a.artifacts.store.state.artifacts[artifact.id])
    ok(Object.keys(b.artifacts.store.state.artifacts).length == 0, 'other account cannot see owner descriptor')

    const visible = JSON.stringify(a.artifacts.store.snapshot())
    ok(!visible.includes('private-object-a') && !visible.includes('artifact.example'), 'Store/replay descriptor contains neither storage key nor open URL')

    let forbidden = false
    try { await b.artifacts.open(artifact.id) } catch { forbidden = true }
    ok(forbidden, 'other account cannot obtain an open instruction')

    const opened = await a.artifacts.open(artifact.id)
    ok(opened.url == 'https://artifact.example/private-object-a?account=a' && opened.expiresAt == 1_060, 'owner receives a short-lived direct storage instruction')
    ok(!JSON.stringify(a.artifacts.store.snapshot()).includes(opened.url), 'open instruction is not cached back into Store state')

    const attributes = new Map<string, string>()
    const frame = {
        src: '',
        setAttribute(name: string, value: string) { attributes.set(name, value) },
    }
    const runtime = createArtifactFrame({artifacts: a.artifacts, frame, allowedOrigins: ['https://artifact.example']})
    await runtime.mount(artifact.id)
    ok(frame.src == opened.url && attributes.get('sandbox') == 'allow-scripts' && attributes.get('referrerpolicy') == 'no-referrer', 'iframe runtime pins origin and applies strict sandbox defaults')
    runtime.clear()
    ok(frame.src == 'about:blank' && runtime.current() === undefined, 'iframe runtime clears the document explicitly')

    clock = 1_600
    const expired = await host.reap()
    ok(expired[0]?.state == 'expired' && removed.some(x => x.key == 'private-object-a' && x.reason == 'expired'), 'reap marks expiry and delegates physical cleanup to storage')
    await waitFor('expired projection', () => a.artifacts.store.state.artifacts[artifact.id]?.state == 'expired')
    let expiredOpen = false
    try { await a.artifacts.open(artifact.id) } catch { expiredOpen = true }
    ok(expiredOpen, 'expired artifact cannot issue another open instruction')

    const retryArtifact = host.register({
        owner: 'a',
        descriptor: {kind: 'assistant-app', label: 'Retry cleanup', runtime: 'sandboxed-iframe'},
        storageKey: 'private-object-retry',
        retention: {class: 'ephemeral', expiresAt: 1_700},
    })
    clock = 1_800
    let cleanupFailed = false
    try { await host.reap() } catch { cleanupFailed = true }
    ok(cleanupFailed && host.store.state.artifacts[retryArtifact.id]?.state == 'expired', 'cleanup failure still makes the artifact unopenable')
    await host.reap()
    ok(removed.filter(x => x.key == 'private-object-retry').length == 2, 'reap retries private storage cleanup after a transient failure')

    const retryRevokedArtifact = host.register({
        owner: 'a',
        descriptor: {kind: 'assistant-app', label: 'Retry revoke cleanup', runtime: 'sandboxed-iframe'},
        storageKey: 'private-object-revoke',
        retention: {class: 'persistent'},
    })
    let revokeCleanupFailed = false
    try { await a.artifacts.revoke(retryRevokedArtifact.id) } catch { revokeCleanupFailed = true }
    ok(revokeCleanupFailed && host.store.state.artifacts[retryRevokedArtifact.id]?.state == 'revoked', 'revoke failure still makes the artifact unopenable')
    await host.reap()
    ok(removed.filter(x => x.key == 'private-object-revoke').length == 2, 'reap retries cleanup for a revoked artifact too')

    a.artifacts.close()
    b.artifacts.close()
    a.close()
    b.close()
    host.close()
    ioServer.close()
    await new Promise<void>(resolve => httpServer.close(() => resolve()))

    console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
