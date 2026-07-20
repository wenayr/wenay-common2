// ============================================================
//  observe/usage-real-socket.ts
//
//  Same store mirror add/delete, but via real Socket.IO
//  localhost WebSocket, not in-memory loopback.
//  Run:
//      npx tsx observe/usage-real-socket.ts
// ============================================================

import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import type {DeepSocketListen} from '../src/Common/rcp/listen-deep'
import {createStore, createStoreMirror, exposeStore} from './store'
import {flushReactive} from './reactive'

type Strategy = {
    status: boolean
    limit: number
}

type StrategyStore = {
    strategies: Record<string, Strategy>
    meta: {status: string}
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const keys = (state: StrategyStore) => Object.keys(state.strategies).sort()
const json = (v: any) => JSON.stringify(v)

function scenario(title: string, expected: string) {
    console.log(`\n  ${title}`)
    console.log(`  ожидаем: ${expected}`)
}

function expectEq(label: string, got: any, expected: any) {
    const g = json(got)
    const e = json(expected)
    console.log(`  ${label}:`, g)
    if (g !== e) throw new Error(`${label}: expected ${e}, got ${g}`)
    console.log('  OK')
}

async function waitFor(label: string, ok: () => boolean) {
    for (let i = 0; i < 80; i++) {
        if (ok()) return
        await delay(25)
    }
    throw new Error(`timeout: ${label}`)
}

async function startRealServer(object: object) {
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})

    ioServer.on('connection', socket => {
        console.log('  [server] client connected')
        const [disconnect, disconnectListen] = createListenPair()
        socket.on('disconnect', () => disconnect())
        createRpcServerAuto({
            socket: {
                emit: (key, data) => socket.emit(key, data),
                on: (key, cb) => socket.on(key, cb),
            },
            socketKey: 'store2',
            object,
            disconnectListen,
        })
    })

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })

    const port = (httpServer.address() as AddressInfo).port
    console.log(`  [server] listening on 127.0.0.1:${port}`)

    return {
        port,
        close: () => new Promise<void>(resolve => {
            ioServer.close()
            httpServer.close(() => resolve())
        }),
    }
}

async function startRealClient<T extends object>(port: number) {
    const hub = createRpcClientHub(
        () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true}),
        r => ({api: r<T>('store2')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.api.readyStrict()
    console.log('  [client] connected and schema is ready')
    return {
        client: clients.api,
        close: () => hub.socket?.disconnect?.(),
    }
}

async function main() {
    console.log('\n[real socket] Observe store mirror add/delete')

    const backend = createStore<StrategyStore>({
        strategies: {alpha: {status: false, limit: 100}},
        meta: {status: 'ok'},
    }, {drain: 'micro'})

    const exposed = exposeStore(backend)
    const pulls: any[] = []
    const facade = {
        ...exposed,
        get(mask?: any) {
            pulls.push(mask)
            console.log('  [server] get mask =', json(mask))
            return exposed.get(mask)
        },
    }

    let server: Awaited<ReturnType<typeof startRealServer>> | null = null
    let client: Awaited<ReturnType<typeof startRealClient<typeof facade>>> | null = null

    try {
        server = await startRealServer(facade)
        client = await startRealClient<typeof facade>(server.port)

        const listen = client.client.func as unknown as DeepSocketListen<typeof facade>
        const remote = {
            get: (mask?: any) => client!.client.func.get(mask),
            changed: listen.changed,
            changedPaths: listen.changedPaths,
        }

        const mirror = createStoreMirror<StrategyStore>(remote, {strategies: {}, meta: {status: ''}}, {drain: 'micro'})
        const stopSync = await mirror.sync({strategies: true}, {current: true, drain: 'micro'})
        await waitFor('initial mirror sync over socket', () => 'alpha' in mirror.state.strategies)
        await delay(80) // give network subscription changedPaths time to settle exactly
        pulls.length = 0

        scenario('case A: server добавляет beta', 'client mirror увидит alpha,beta; по сети уйдет pull mask {strategies:{beta:true}}')
        backend.state.strategies.beta = {status: true, limit: 200}
        await flushReactive(backend.state)
        await waitFor('client mirror got beta', () => 'beta' in mirror.state.strategies)
        expectEq('client mirror keys после add', keys(mirror.state), ['alpha', 'beta'])
        expectEq('server last get mask после add', pulls[pulls.length - 1], {strategies: {beta: true}})

        scenario('case B: server удаляет beta', 'client mirror удалит beta; по сети уйдет pull mask {strategies:{beta:true}}')
        pulls.length = 0
        delete backend.state.strategies.beta
        await flushReactive(backend.state)
        await waitFor('client mirror removed beta', () => !('beta' in mirror.state.strategies))
        expectEq('client mirror keys после delete', keys(mirror.state), ['alpha'])
        expectEq('server last get mask после delete', pulls[pulls.length - 1], {strategies: {beta: true}})

        stopSync()
        console.log('\nALL OK: real socket usage example passed')
    } finally {
        client?.close()
        await delay(20)
        await server?.close()
    }
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
