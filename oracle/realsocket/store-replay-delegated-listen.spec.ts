import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {Server} from 'socket.io'
import {io} from 'socket.io-client'
import {listen} from '../../src/Common/events/Listen'
import {createStore} from '../../src/Common/Observe/store'
import {exposeStoreReplay, syncStoreReplay} from '../../src/Common/Observe/store-replay'
import {createRpcServerAuto} from '../../src/Common/rcp/rpc-server-auto'
import {createRpcClientHub} from '../../src/Common/rcp/rpc-clientHub'
import {runOracle} from '../run-oracle'

async function main() {
    const source = createStore({reading: 0})
    const exposed = exposeStoreReplay(source)
    type tBatch = Parameters<Parameters<typeof exposed.api.replay.line.on>[0]>[0]
    const [emit, ticks] = listen<[tBatch]>()
    const off = exposed.api.replay.line.on(function relay(batch) { emit(batch) })
    const facade = {source: {line: ticks, since: exposed.api.replay.since, keyframe: exposed.api.replay.keyframe}}
    const http = createServer()
    const sockets = new Server(http)
    sockets.on('connection', function connected(socket) {
        const [gone, disconnectListen] = listen<[]>()
        createRpcServerAuto({socket, object: facade, socketKey: 'test', disconnectListen})
        socket.on('disconnect', function disconnected() { gone(); disconnectListen.close() })
    })
    await new Promise<void>(function start(resolve) { http.listen(0, '127.0.0.1', resolve) })
    const address = http.address()
    assert(address && typeof address != 'string')
    const hub = createRpcClientHub(
        function socket() { return io('http://127.0.0.1:' + address.port, {transports: ['websocket'], forceNew: true}) },
        r => ({test: r<typeof facade>('test')}),
    )
    let sync: ReturnType<typeof syncStoreReplay> | undefined
    try {
        await hub.connect(null)
        await hub.facade.test.readyStrict()
        let error: unknown
        const mirror = createStore({reading: -1})
        sync = syncStoreReplay(mirror, hub.facade.test.func.source, {onError(cause) { error = cause }})
        await sync.ready
        assert.equal(error, undefined, 'a delegated full Listen is mapped as a subscription, not an ordinary callback method')
        assert.equal(mirror.state.reading, 0)
        source.state.reading = 2
        const deadline = Date.now() + 3000
        // read through a call: assert.equal(..., 0) above narrowed the property to 0 for TS,
        // but the mirror changes asynchronously
        const reading = () => mirror.state.reading
        while (reading() != 2 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 5))
        }
        assert.equal(error, undefined)
        assert.equal(mirror.state.reading, 2, 'the delegated Listen carries live replay batches')
        console.log('PASS delegated Store replay Listen over JSON socket: snapshot and live updates')
    } finally {
        sync?.()
        hub.close()
        await new Promise<void>(function close(resolve) { sockets.close(function closed() { resolve() }) })
        off(); ticks.close(); exposed.close()
    }
}

runOracle(main)
