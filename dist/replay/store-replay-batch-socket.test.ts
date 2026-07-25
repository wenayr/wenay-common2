// ============================================================
// Store Replay V2 over real Socket.IO
// ============================================================

import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {isDeepStrictEqual} from 'node:util'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen} from '../src/Common/events/Listen'
import {flushReactive} from '../src/Common/Observe/reactive'
import {createStore} from '../src/Common/Observe/store'
import {
    exposeStoreReplay,
    type StoreReplayRemote,
    syncStoreReplay,
} from '../src/Common/Observe/store-replay'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

function delay(ms: number) {
    return new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })
}

async function waitFor(label: string, condition: () => boolean) {
    for (let index = 0; index < 500; index++) {
        if (condition()) return
        await delay(10)
    }
    throw new Error('timeout: ' + label)
}

async function main() {
    type Quotes = Record<string, {c: number, t: number}>
    const initial: Quotes = {}
    for (let index = 0; index < 100; index++) {
        initial['S' + index] = {c: index, t: 1_000 + index}
    }
    const source = createStore<Quotes>(initial, {drain: 'micro'})
    const exposed = exposeStoreReplay(source, {history: 128, maxItems: 32})
    const replay = exposed.api.replay as StoreReplayRemote
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})
    let binaryPackets = 0

    ioServer.on('connection', function serveConnection(socket) {
        const [disconnect, disconnectListen] = listen<[]>()
        socket.on('disconnect', function closeConnection() { disconnect() })
        createRpcServerAuto({
            socket: {
                emit(key, data) {
                    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) binaryPackets++
                    socket.emit(key, data)
                },
                on: (key, cb) => socket.on(key, cb),
            },
            socketKey: 'store-v2',
            object: {replay},
            disconnectListen,
        })
    })

    await new Promise<void>(function start(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    const port = (httpServer.address() as AddressInfo).port
    const hub = createRpcClientHub(
        () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true}),
        remote => ({api: remote<{replay: StoreReplayRemote}>('store-v2')}) as const,
    )

    try {
        const client = await hub.setToken(null)
        await client.api.readyStrict()
        const mirror = createStore<Quotes>({}, {drain: 'micro'})
        const sub = syncStoreReplay(mirror, client.api.func.replay)
        await sub.ready
        await waitFor('initial V2 keyframe', () => Object.keys(mirror.state).length == 100)

        for (let index = 0; index < 25; index++) {
            source.state['S' + index] = {c: index + 10_000, t: index + 20_000}
        }
        await flushReactive(source.state)
        await waitFor('V2 live convergence', () => mirror.state.S24?.c == 10_024)

        const versionKeys = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7']
            .filter(key => Object.prototype.hasOwnProperty.call(client.api.func.replay, key))
        if (!isDeepStrictEqual(mirror.snapshot(), source.snapshot())) {
            throw new Error('Store Replay V2 socket mirror diverged')
        }
        if (versionKeys.length) throw new Error('numbered Store members remain: ' + versionKeys.join(','))
        if (binaryPackets != 0) throw new Error('Store V2 unexpectedly left the JSON-array RPC lane')
        sub()
    } finally {
        hub.socket?.disconnect?.()
        exposed.close()
        await new Promise<void>(resolve => ioServer.close(() => resolve()))
        await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }

    console.log('Store Replay V2 Socket.IO test: OK')
}

main().catch(function fail(error) {
    console.error(error)
    process.exit(1)
})
