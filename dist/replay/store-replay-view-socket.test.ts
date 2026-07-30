// =====================================================================
// Selected/chunked Store Replay view over real Socket.IO
// =====================================================================

import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {isDeepStrictEqual} from 'node:util'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen} from '../src/Common/events/Listen'
import {flushReactive} from '../src/Common/Observe/reactive'
import {createStore} from '../src/Common/Observe/store'
import {
    createStoreReplayView,
    syncStoreReplayView,
    type StoreReplayViewRemote,
} from '../src/Common/Observe/store-replay'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

const SOCKET_KEY = 'store-replay-view-socket'
const MIB = 1024 * 1024
const SELECTED_COUNT = 112
const FOREIGN_COUNT = 16
const PAYLOAD_BYTES = 96 * 1024
const SNAPSHOT_CHUNK_BYTES = 128 * 1024
const SNAPSHOT_WINDOW_BYTES = 256 * 1024

type Row = {
    id: string
    revision: number
    payload: string
}

type State = Record<string, Row>
type SocketFacade = {view: StoreReplayViewRemote}

type PageTrace = {
    page: number
    callbacks: number
    emitted?: number
    lastCallbackOrder: number
    responseOrder?: number
    done?: boolean
}

function delay(ms: number) {
    return new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })
}

async function waitFor(label: string, condition: () => boolean) {
    for (let attempt = 0; attempt < 500; attempt++) {
        if (condition()) return
        await delay(10)
    }
    throw new Error('timeout: ' + label)
}

function numberedKey(prefix: string, index: number) {
    return prefix + '-' + index.toString().padStart(3, '0')
}

function createRow(id: string, revision: number) {
    const prefix = id + '|' + revision + '|'
    const fill = String.fromCharCode(97 + revision % 26)
    return {
        id,
        revision,
        payload: prefix + fill.repeat(PAYLOAD_BYTES - prefix.length),
    } satisfies Row
}

function selectedSnapshot(source: ReturnType<typeof createStore<State>>, keys: readonly string[]) {
    const snapshot = source.snapshot()
    const selected: State = {}
    for (const key of keys) selected[key] = snapshot[key]
    return selected
}

async function main() {
    const selectedKeys = Array.from(
        {length: SELECTED_COUNT},
        (_value, index) => numberedKey('selected', index),
    )
    const foreignKeys = Array.from(
        {length: FOREIGN_COUNT},
        (_value, index) => numberedKey('foreign', index),
    )
    const initial: State = {}
    for (const key of selectedKeys) initial[key] = createRow(key, 0)
    for (const key of foreignKeys) initial[key] = createRow(key, 0)

    const selectedBytes = selectedKeys.reduce(
        (total, key) => total + Buffer.byteLength(initial[key].payload),
        0,
    )
    assert.ok(selectedBytes >= 8 * MIB && selectedBytes <= 15 * MIB,
        'selected test fixture must stay within the requested 8–15 MiB range')

    const source = createStore<State>(initial, {drain: 'micro'})
    const view = createStoreReplayView(source, {
        keys: selectedKeys,
        lineId: 'selected-large-view-v1',
        history: 4096,
        snapshot: {
            chunkBytes: SNAPSHOT_CHUNK_BYTES,
            windowBytes: SNAPSHOT_WINDOW_BYTES,
            maxItems: 1,
            maxSessions: 4,
            ttlMs: 30_000,
        },
    })

    const httpServer = createServer()
    const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 2 * MIB})
    ioServer.on('connection', function serveStoreReplayView(socket) {
        const [emitDisconnect, disconnectListen] = listen<[]>()
        socket.on('disconnect', function storeReplayViewDisconnected() {
            emitDisconnect()
        })
        createRpcServerAuto({
            socket: {
                emit(key, data) { socket.emit(key, data) },
                on(key, cb) { socket.on(key, cb) },
            },
            socketKey: SOCKET_KEY,
            object: {view: view.resource} satisfies SocketFacade,
            disconnectListen,
        })
    })

    await new Promise<void>(function startServer(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })

    const port = (httpServer.address() as AddressInfo).port
    const hub = createRpcClientHub(
        function connectStoreReplayViewSocket() {
            return io(`http://127.0.0.1:${port}`, {
                transports: ['websocket'],
                forceNew: true,
                reconnection: false,
            })
        },
        remote => ({api: remote<SocketFacade>(SOCKET_KEY)}) as const,
    )

    let sync: ReturnType<typeof syncStoreReplayView<State>> | undefined
    try {
        const clients = await hub.setToken(null)
        await clients.api.readyStrict()
        const remote = clients.api.func.view
        const mirror = createStore<State>({
            stale: createRow('stale', -1),
        }, {drain: 'micro'})

        let order = 0
        let callbackChunks = 0
        let partialVisibility = false
        let finalResponseOrder = 0
        let doneProgressOrder = 0
        let initialCommitOrder = 0
        let initialRootCommits = 0
        const orderingFailures: string[] = []
        const pageTraces: PageTrace[] = []

        const measuredRemote: StoreReplayViewRemote = {
            describe: () => remote.describe(),
            replay: remote.replay,
            snapshot: {
                open: () => remote.snapshot.open(),
                read(request, emit) {
                    const trace: PageTrace = {
                        page: request.after,
                        callbacks: 0,
                        lastCallbackOrder: 0,
                    }
                    pageTraces.push(trace)
                    const response = remote.snapshot.read(request, function measureSnapshotChunk(chunk) {
                        trace.callbacks++
                        callbackChunks++
                        trace.lastCallbackOrder = ++order
                        if (!Object.prototype.hasOwnProperty.call(mirror.state, 'stale')
                            || selectedKeys.some(key => Object.prototype.hasOwnProperty.call(mirror.state, key))) {
                            partialVisibility = true
                        }
                        emit(chunk)
                    })
                    return Promise.resolve(response).then(function measureReadResponse(result) {
                        trace.responseOrder = ++order
                        trace.emitted = result.emitted
                        trace.done = result.done
                        finalResponseOrder = trace.responseOrder
                        if (trace.callbacks != result.emitted) {
                            orderingFailures.push(
                                `page ${trace.page}: ${trace.callbacks} callbacks, response says ${result.emitted}`,
                            )
                        }
                        if (trace.callbacks > 0 && trace.lastCallbackOrder >= trace.responseOrder) {
                            orderingFailures.push(`page ${trace.page}: response overtook its callbacks`)
                        }
                        return result
                    })
                },
                close: transferId => remote.snapshot.close(transferId),
            },
        }

        sync = syncStoreReplayView(mirror, measuredRemote, {
            snapshotWindowBytes: SNAPSHOT_WINDOW_BYTES,
            onSnapshotProgress(progress) {
                if (progress.done) doneProgressOrder = ++order
            },
            onBatch(patches) {
                if (!patches.some(patch => patch.path.length == 0)) return
                initialRootCommits++
                initialCommitOrder = ++order
            },
        })
        await sync.ready

        assert.ok(callbackChunks > 80,
            `small chunks should produce many callback deliveries, received ${callbackChunks}`)
        assert.ok(pageTraces.length > 20,
            `small windows should produce many read pages, received ${pageTraces.length}`)
        assert.equal(orderingFailures.length, 0, orderingFailures.join('; '))
        assert.ok(pageTraces.every(trace => trace.callbacks > 0
            && trace.emitted == trace.callbacks
            && trace.responseOrder! > trace.lastCallbackOrder),
        'every read response must arrive after every callback chunk of that page')
        assert.equal(pageTraces.filter(trace => trace.done).length, 1,
            'exactly one read response commits the completed snapshot')
        assert.equal(initialRootCommits, 1, 'initial snapshot becomes one visible root commit')
        assert.ok(finalResponseOrder > 0 && doneProgressOrder > finalResponseOrder
            && initialCommitOrder > doneProgressOrder,
        'final callbacks and read response must precede progress completion and visible commit')
        assert.equal(partialVisibility, false,
            'callback chunks must assemble outside the visible Store')

        const initialExpected = selectedSnapshot(source, selectedKeys)
        assert.ok(isDeepStrictEqual(mirror.snapshot(), initialExpected),
            'initial selected mirror must equal the authoritative selected keys')
        assert.deepEqual(Object.keys(mirror.state).sort(), [...selectedKeys].sort(),
            'initial mirror must contain exactly the selected keys')
        assert.ok(foreignKeys.every(key => !Object.prototype.hasOwnProperty.call(mirror.state, key)),
            'initial snapshot must contain no foreign key')

        const stats = view.view.stats()
        assert.equal(stats.snapshotChunks, callbackChunks,
            'server chunk metrics must match callbacks observed after real RPC delivery')
        assert.equal(stats.snapshotPages, pageTraces.length,
            'server page metrics must match read responses observed by the client')

        const liveKey = selectedKeys[Math.floor(selectedKeys.length / 2)]
        const foreignKey = foreignKeys[0]
        const initialSeq = sync.seq()
        source.state[liveKey] = createRow(liveKey, 1)
        source.state[foreignKey] = createRow(foreignKey, 1)
        await flushReactive(source.state)
        await waitFor('selected live update', function selectedLiveUpdateArrived() {
            return mirror.state[liveKey]?.revision == 1
        })
        await delay(20)

        assert.ok(sync.seq() > initialSeq, 'selected live update must advance the replay cursor')
        assert.equal(mirror.state[foreignKey], undefined,
            'foreign live update must remain outside the selected mirror')
        assert.deepEqual(Object.keys(mirror.state).sort(), [...selectedKeys].sort(),
            'live delivery must preserve the exact selected key set')
        assert.ok(isDeepStrictEqual(mirror.snapshot(), selectedSnapshot(source, selectedKeys)),
            'selected mirror must converge after live selected and foreign writes')

        await waitFor('snapshot cursor cleanup', function snapshotCursorClosed() {
            return view.view.stats().activeSessions == 0
        })
        console.log(
            `Store Replay view Socket.IO test: OK `
            + `(${(selectedBytes / MIB).toFixed(2)} MiB, `
            + `${callbackChunks} chunks, ${pageTraces.length} pages)`,
        )
    } finally {
        sync?.()
        hub.socket?.disconnect?.()
        await delay(20)
        view.close()
        await new Promise<void>(function closeSocketServer(resolve) {
            ioServer.close(function socketServerClosed() { resolve() })
        })
        if (httpServer.listening) {
            await new Promise<void>(function closeHttpServer(resolve) {
                httpServer.close(function httpServerClosed() { resolve() })
            })
        }
    }
}

main().catch(function storeReplayViewSocketTestFailed(error) {
    console.error(error)
    process.exit(1)
})
