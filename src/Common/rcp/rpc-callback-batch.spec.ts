import * as assert from 'node:assert/strict'
import {createRpcClient, type RpcClientReturn} from './rpc-client'
import {createRpcServer} from './rpc-server'
import {createRpcServerAuto} from './rpc-server-auto'
import {Pkt, type SocketTmpl} from './rpc-protocol'
import {listen as createListenPair} from '../events/Listen'
import type {DeepSocketListen} from './listen-deep'
import {
    getRpcMemberState, getRpcSchemaReady, hasRpcMemberLookup, rpcMemberAvailable, RPC_TRANSPORT_CONTROL,
} from '../events/transport-lifecycle'
import {
    callbackBatchDirectBinaryOversize,
    createCallbackPacketBatcher,
} from './rpc-callback-batch'

function createLoopback(): [SocketTmpl, SocketTmpl] {
    const a: Record<string, ((data: any) => void)[]> = {}
    const b: Record<string, ((data: any) => void)[]> = {}
    function make(mine: typeof a, theirs: typeof a): SocketTmpl {
        return {
            on(event, cb) { (mine[event] ??= []).push(cb) },
            emit(event, data) {
                const wire = data === undefined ? undefined : JSON.parse(JSON.stringify(data))
                for (const cb of theirs[event] ?? []) queueMicrotask(function deliver() { cb(wire) })
            },
        }
    }
    return [make(a, b), make(b, a)]
}

function createSynchronousLoopback() {
    const a: Record<string, ((data: any) => void)[]> = {}
    const b: Record<string, ((data: any) => void)[]> = {}
    let online = true
    function make(mine: typeof a, theirs: typeof a): SocketTmpl {
        return {
            on(event, cb) { (mine[event] ??= []).push(cb) },
            emit(event, data) {
                if (!online) return
                const wire = data === undefined ? undefined : JSON.parse(JSON.stringify(data))
                for (const cb of theirs[event] ?? []) cb(wire)
            },
        }
    }
    return {
        clientSocket: make(a, b),
        serverSocket: make(b, a),
        setOnline(value: boolean) { online = value },
    }
}

function webListen<T extends object>(client: RpcClientReturn<T>) {
    return client.func as unknown as DeepSocketListen<T>
}

const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

async function testBurstBatchAndBounds() {
    const [clientSocket, serverSocket] = createLoopback()
    const [emit, stream] = createListenPair<number>()
    const object = {stream}
    const client = createRpcClient<typeof object>({socket: clientSocket, socketKey: 'rpc'})
    createRpcServerAuto({
        socket: serverSocket,
        object,
        socketKey: 'rpc',
        opt: {callbackBatch: {maxItems: 3, maxBytes: 10_000}},
    })
    await delay()

    const values: number[] = []
    webListen(client).stream.on(value => values.push(value))
    await delay(5)

    const batches: any[][] = []
    const originalEmit = serverSocket.emit.bind(serverSocket)
    serverSocket.emit = function inspectBatch(event, data) {
        if (Array.isArray(data) && data[0] == Pkt.CB_BATCH) batches.push(data[1])
        originalEmit(event, data)
    }
    for (let i = 0; i < 8; i++) emit(i)
    await delay(10)

    assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(batches.map(batch => batch.length), [3, 3, 2])
}

async function testByteBound() {
    const [clientSocket, serverSocket] = createLoopback()
    const [emit, stream] = createListenPair<string>()
    const object = {stream}
    const client = createRpcClient<typeof object>({socket: clientSocket, socketKey: 'rpc'})
    createRpcServerAuto({
        socket: serverSocket,
        object,
        socketKey: 'rpc',
        opt: {callbackBatch: {maxItems: 64, maxBytes: 256}},
    })
    await delay()

    const values: string[] = []
    webListen(client).stream.on(value => values.push(value))
    await delay(5)

    let batchCount = 0
    let directCount = 0
    const originalEmit = serverSocket.emit.bind(serverSocket)
    serverSocket.emit = function inspectByteBound(event, data) {
        if (Array.isArray(data) && data[0] == Pkt.CB_BATCH) batchCount++
        if (Array.isArray(data) && data[0] == Pkt.CB) directCount++
        originalEmit(event, data)
    }
    const expected = ['a', 'b', 'c'].map(value => value.repeat(180))
    for (const value of expected) emit(value)
    await delay(10)

    assert.deepEqual(values, expected)
    assert.equal(batchCount, 0)
    assert.equal(directCount, 3)
}

async function testUtf8ByteBound() {
    const [clientSocket, serverSocket] = createLoopback()
    const [emit, stream] = createListenPair<string>()
    const object = {stream}
    const client = createRpcClient<typeof object>({socket: clientSocket, socketKey: 'rpc'})
    createRpcServerAuto({
        socket: serverSocket,
        object,
        socketKey: 'rpc',
        opt: {callbackBatch: {maxItems: 64, maxBytes: 256}},
    })
    await delay()

    const values: string[] = []
    webListen(client).stream.on(value => values.push(value))
    await delay(5)

    const batchBytes: number[] = []
    const encoder = new TextEncoder()
    const originalEmit = serverSocket.emit.bind(serverSocket)
    serverSocket.emit = function inspectUtf8Bound(event, data) {
        if (Array.isArray(data) && data[0] == Pkt.CB_BATCH) {
            batchBytes.push(encoder.encode(JSON.stringify(data)).byteLength)
        }
        originalEmit(event, data)
    }
    const expected = Array.from({length: 6}, (_, i) => 'Ж'.repeat(45) + i)
    for (const value of expected) emit(value)
    await delay(10)

    assert.deepEqual(values, expected)
    assert.ok(batchBytes.length > 1)
    assert.ok(batchBytes.every(bytes => bytes <= 256), 'every physical JSON batch stays inside its UTF-8 ceiling')
}

async function testBinaryPacketBypass() {
    const sent: any[][] = []
    const batcher = createCallbackPacketBatcher({send: function collectCallbackPacket(packet) { sent.push(packet) }})
    const first = [Pkt.CB, 1, ['first']]
    const binary = [Pkt.CB, 1, [new Uint8Array([1, 2, 3])]]
    const last = [Pkt.CB, 1, ['last']]

    batcher.enqueue(first)
    batcher.enqueue(binary)
    batcher.enqueue(last)
    await delay()

    assert.deepEqual(sent, [first, binary, last])
}

function testDirectBinaryOversizeLowerBound() {
    assert.equal(callbackBatchDirectBinaryOversize([new Uint8Array(64 * 1024)]), true)
    assert.equal(callbackBatchDirectBinaryOversize([new Uint8Array(60 * 1024)]), false)
    assert.equal(
        callbackBatchDirectBinaryOversize(
            [new Uint8Array(1024)],
            {maxItems: 64, maxBytes: 1024},
        ),
        true,
    )
    assert.equal(
        callbackBatchDirectBinaryOversize(
            [{nested: new Uint8Array(1024)}],
            {maxItems: 64, maxBytes: 1024},
        ),
        false,
        'the cheap lower bound stays conservative for nested business values',
    )
}

async function testPersistentServerReconnectCaps() {
    const [clientSocket, serverSocket] = createLoopback()
    const [emit, stream] = createListenPair<number>()
    const object = {stream}
    const client = createRpcClient<typeof object>({socket: clientSocket, socketKey: 'rpc'})
    createRpcServerAuto({socket: serverSocket, object, socketKey: 'rpc'})
    await delay(5)

    const values: number[] = []
    webListen(client).stream.on(value => values.push(value))
    await delay(5)
    emit(1); emit(2)
    await delay(5)

    const control = (client as any)[RPC_TRANSPORT_CONTROL]
    control.disconnect('persistent server reconnect test')
    assert.equal(hasRpcMemberLookup((client.func as any).stream), true)
    assert.equal(rpcMemberAvailable(client.func, 'stream'), false)
    const schemaReady = getRpcSchemaReady((client.func as any).stream)
    assert.ok(schemaReady)
    await schemaReady()
    assert.equal(getRpcMemberState(client.func, 'stream'), true)
    assert.equal(rpcMemberAvailable(client.func, 'stream'), true)
    assert.equal(rpcMemberAvailable(client.func, 'missing'), false)
    assert.equal(hasRpcMemberLookup(object), false)
    assert.equal(rpcMemberAvailable(object, 'stream'), true)
    assert.equal(rpcMemberAvailable(object, 'missing'), false)
    assert.equal(getRpcSchemaReady(object), undefined)
    control.connect()
    await delay(5)

    let batches = 0
    const originalEmit = serverSocket.emit.bind(serverSocket)
    serverSocket.emit = function inspectReconnectBatch(event, data) {
        if (Array.isArray(data) && data[0] == Pkt.CB_BATCH) batches++
        originalEmit(event, data)
    }
    emit(3); emit(4)
    await delay(10)

    assert.deepEqual(values, [1, 2, 3, 4])
    assert.equal(batches, 1)
}

async function testSchemaReadyWithSynchronousMap() {
    const pair = createSynchronousLoopback()
    pair.serverSocket.on('rpc', function answerStrict(data) {
        if (data == Pkt.STRICT) pair.serverSocket.emit('rpc', [Pkt.MAP, {}, {ping: 'func'}, []])
    })
    const client = createRpcClient({socket: pair.clientSocket, socketKey: 'rpc'})

    const ready = await Promise.race([client.ready().then(() => 'ready'), delay(60).then(() => 'timeout')])
    assert.equal(ready, 'ready')
    assert.equal(getRpcMemberState(client.func, 'ping'), true)
}

async function testSchemaReadyOfflineThenConnect() {
    const pair = createSynchronousLoopback()
    pair.serverSocket.on('rpc', function answerStrict(data) {
        if (data == Pkt.STRICT) pair.serverSocket.emit('rpc', [Pkt.MAP, {}, {stream: {}}, []])
    })
    const client = createRpcClient({socket: pair.clientSocket, socketKey: 'rpc'})
    const control = (client as any)[RPC_TRANSPORT_CONTROL]
    control.disconnect('offline schema request')
    pair.setOnline(false)

    const schemaReady = getRpcSchemaReady((client.func as any).stream)
    assert.ok(schemaReady)
    const waiting = schemaReady!()
    const offline = await Promise.race([waiting.then(() => 'ready'), delay(10).then(() => 'pending')])
    assert.equal(offline, 'pending')

    pair.setOnline(true)
    control.connect()
    const connected = await Promise.race([waiting.then(() => 'ready'), delay(60).then(() => 'timeout')])
    assert.equal(connected, 'ready')
    assert.equal(getRpcMemberState(client.func, 'stream'), true)
}

async function testServerReplacementGenerationBarrier() {
    const [clientSocket, serverSocket] = createLoopback()
    const [emitOld, oldStream] = createListenPair<number>()
    const [, newStream] = createListenPair<number>()
    const client = createRpcClient({socket: clientSocket, socketKey: 'rpc'})
    createRpcServerAuto({socket: serverSocket, object: {stream: oldStream}, socketKey: 'rpc'})
    await delay(5)

    const values: number[] = []
    ;(webListen(client) as any).stream.on((value: number) => values.push(value))
    await delay(5)

    const opcodes: number[] = []
    const originalEmit = serverSocket.emit.bind(serverSocket)
    serverSocket.emit = function inspectGenerationBarrier(event, data) {
        if (Array.isArray(data) && (data[0] == Pkt.CB_BATCH || data[0] == Pkt.MAP)) opcodes.push(data[0])
        originalEmit(event, data)
    }

    emitOld(1)
    emitOld(2)
    createRpcServerAuto({socket: serverSocket, object: {stream: newStream}, socketKey: 'rpc'})
    emitOld(3)
    await delay(10)

    assert.deepEqual(opcodes.slice(0, 2), [Pkt.CB_BATCH, Pkt.MAP])
    assert.deepEqual(values, [1, 2])
}

async function testEndAndErrorOrder() {
    {
        const [clientSocket, serverSocket] = createLoopback()
        const [emit, stream] = createListenPair<number>()
        const object = {stream}
        const client = createRpcClient<typeof object>({socket: clientSocket, socketKey: 'rpc'})
        createRpcServerAuto({socket: serverSocket, object, socketKey: 'rpc'})
        await delay()

        const values: number[] = []
        const done = webListen(client).stream.once(value => values.push(value))
        await delay(5)
        const opcodes: number[] = []
        const originalEmit = serverSocket.emit.bind(serverSocket)
        serverSocket.emit = function inspectEndOrder(event, data) {
            if (Array.isArray(data) && (data[0] == Pkt.CB || data[0] == Pkt.CB_BATCH || data[0] == Pkt.CB_END)) opcodes.push(data[0])
            originalEmit(event, data)
        }
        emit(7)
        await Promise.race([done, delay(60)])

        assert.deepEqual(values, [7])
        assert.deepEqual(opcodes, [Pkt.CB, Pkt.CB_END])
    }

    {
        const [clientSocket, serverSocket] = createLoopback()
        const object = {
            burst(cb: (value: number) => void) {
                cb(1)
                cb(2)
                throw new Error('burst failed')
            },
        }
        const client = createRpcClient<typeof object>({socket: clientSocket, socketKey: 'rpc'})
        createRpcServer({socket: serverSocket, object, socketKey: 'rpc'})
        await delay()

        const opcodes: number[] = []
        const originalEmit = serverSocket.emit.bind(serverSocket)
        serverSocket.emit = function inspectErrorOrder(event, data) {
            if (Array.isArray(data) && (data[0] == Pkt.CB_BATCH || data[0] == Pkt.RESP)) opcodes.push(data[0])
            originalEmit(event, data)
        }
        const values: number[] = []
        const error = await client.func.burst(value => values.push(value)).then(() => '', caught => caught.message)

        assert.deepEqual(values, [1, 2])
        assert.equal(error, 'burst failed')
        assert.deepEqual(opcodes, [Pkt.CB_BATCH, Pkt.RESP])
    }
}

async function testBatchedCallbackPreservesAllErrors() {
    const [clientSocket, serverSocket] = createLoopback()
    const object = {
        burst(first: (value: number) => void, second: (value: number) => void) {
            first(1)
            second(2)
        },
    }
    const client = createRpcClient<typeof object>({socket: clientSocket, socketKey: 'rpc'})
    createRpcServer({socket: serverSocket, object, socketKey: 'rpc'})
    await delay(5)

    let resolveThrown = function resolveThrownLater(_error: unknown) {}
    const thrown = new Promise<unknown>(resolve => { resolveThrown = resolve })
    function rememberConsumerErrors(error: unknown) { resolveThrown(error) }
    process.once('uncaughtException', rememberConsumerErrors)
    const values: number[] = []
    await client.func.burst(
        function failFirst(value) { values.push(value); throw new Error('first callback failed') },
        function failSecond(value) { values.push(value); throw new Error('second callback failed') },
    )
    const caught = await Promise.race([thrown, delay(100).then(() => 'timeout')])
    process.off('uncaughtException', rememberConsumerErrors)

    assert.deepEqual(values, [1, 2])
    assert.ok(caught instanceof AggregateError)
    assert.deepEqual(caught.errors.map(error => error.message), ['first callback failed', 'second callback failed'])
}

async function testLegacyFallback() {
    {
        const [clientSocket, serverSocket] = createLoopback()
        const [emit, stream] = createListenPair<number>()
        const object = {stream}
        const originalClientEmit = clientSocket.emit.bind(clientSocket)
        clientSocket.emit = function suppressCaps(event, data) {
            if (Array.isArray(data) && data[0] == Pkt.CAPS) return
            originalClientEmit(event, data)
        }
        const client = createRpcClient<typeof object>({socket: clientSocket, socketKey: 'rpc'})
        createRpcServerAuto({socket: serverSocket, object, socketKey: 'rpc'})
        await delay()

        const values: number[] = []
        webListen(client).stream.on(value => values.push(value))
        await delay(5)
        let batchCount = 0
        let directCount = 0
        const originalServerEmit = serverSocket.emit.bind(serverSocket)
        serverSocket.emit = function inspectLegacy(event, data) {
            if (Array.isArray(data) && data[0] == Pkt.CB_BATCH) batchCount++
            if (Array.isArray(data) && data[0] == Pkt.CB) directCount++
            originalServerEmit(event, data)
        }
        for (let i = 0; i < 8; i++) emit(i)
        await delay(10)

        assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7])
        assert.equal(batchCount, 0)
        assert.equal(directCount, 8)
    }

    {
        const [clientSocket, serverSocket] = createLoopback()
        const [emit, stream] = createListenPair<number>()
        const object = {stream}
        const client = createRpcClient<typeof object>({socket: clientSocket, socketKey: 'rpc'})
        createRpcServerAuto({socket: serverSocket, object, socketKey: 'rpc', opt: {callbackBatch: false}})
        await delay()

        const values: number[] = []
        webListen(client).stream.on(value => values.push(value))
        await delay(5)
        let batchCount = 0
        let directCount = 0
        const originalServerEmit = serverSocket.emit.bind(serverSocket)
        serverSocket.emit = function inspectOldServer(event, data) {
            if (Array.isArray(data) && data[0] == Pkt.CB_BATCH) batchCount++
            if (Array.isArray(data) && data[0] == Pkt.CB) directCount++
            originalServerEmit(event, data)
        }
        for (let i = 0; i < 8; i++) emit(i)
        await delay(10)

        assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7])
        assert.equal(batchCount, 0)
        assert.equal(directCount, 8)
    }
}

async function testShapeSignatureAndServerKeys() {
    const [clientSocket, serverSocket] = createLoopback()
    const [emit, stream] = createListenPair<Record<string, any>>()
    const object = {stream}
    const client = createRpcClient<typeof object>({socket: clientSocket, socketKey: 'rpc'})
    createRpcServerAuto({socket: serverSocket, object, socketKey: 'rpc'})
    await delay()

    const values: Record<string, any>[] = []
    webListen(client).stream.on(value => values.push(value))
    await delay(5)
    for (let i = 0; i < 5; i++) emit({a: i, b: i + 10})
    for (let i = 0; i < 5; i++) emit({['a\0b']: i + 20})
    await delay(10)

    const expected = [
        ...Array.from({length: 5}, (_, i) => ({a: i, b: i + 10})),
        ...Array.from({length: 5}, (_, i) => ({['a\0b']: i + 20})),
    ]
    assert.deepEqual(values, expected)

    values.length = 0
    let unsafeShape = false
    const originalEmit = serverSocket.emit.bind(serverSocket)
    serverSocket.emit = function inspectUnsafeShape(event, data) {
        const packets = Array.isArray(data) && data[0] == Pkt.CB_BATCH ? data[1] : [data]
        for (const packet of packets) {
            if (!Array.isArray(packet) || packet[0] != Pkt.SHAPE || !Array.isArray(packet[3])) continue
            if (packet[3].some((key: string) => key == '__proto__' || key == 'constructor' || key == 'prototype')) unsafeShape = true
        }
        originalEmit(event, data)
    }
    const unsafe = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true},"safe":1}')
    for (let i = 0; i < 8; i++) emit(unsafe)
    await delay(10)

    assert.equal(unsafeShape, false)
    assert.deepEqual(values, Array.from({length: 8}, () => ({safe: 1})))
    assert.equal(({} as any).polluted, undefined)
}

async function testHostileClientShape() {
    const [clientSocket, serverSocket] = createLoopback()
    const [, stream] = createListenPair<Record<string, any>>()
    const object = {stream}
    let callbackId = -1

    function findCallbackId(value: any): number | undefined {
        if (value == null || typeof value != 'object') return
        if (Object.prototype.hasOwnProperty.call(value, '$_f') && typeof value.$_f == 'number') return value.$_f
        for (const key of Object.keys(value)) {
            const found = findCallbackId(value[key])
            if (found != undefined) return found
        }
    }

    const originalClientEmit = clientSocket.emit.bind(clientSocket)
    clientSocket.emit = function captureCallbackId(event, data) {
        if (Array.isArray(data) && data[0] == Pkt.CALL) callbackId = findCallbackId(data[3]) ?? callbackId
        originalClientEmit(event, data)
    }
    const client = createRpcClient<typeof object>({socket: clientSocket, socketKey: 'rpc'})
    createRpcServerAuto({socket: serverSocket, object, socketKey: 'rpc'})
    await delay()

    const values: Record<string, any>[] = []
    const off = webListen(client).stream.on(value => values.push(value))
    await delay(5)
    assert.notEqual(callbackId, -1)

    serverSocket.emit('rpc', [Pkt.SHAPE, callbackId, 99, ['__proto__', 'safe']])
    serverSocket.emit('rpc', [Pkt.CBV, callbackId, 99, [{polluted: true}, 1]])
    serverSocket.emit('rpc', [Pkt.SHAPE, callbackId, 100, ['constructor']])
    serverSocket.emit('rpc', [Pkt.CBV, callbackId, 100, [{prototype: {polluted: true}}]])
    serverSocket.emit('rpc', [Pkt.SHAPE, callbackId, 101, ['prototype']])
    serverSocket.emit('rpc', [Pkt.CBV, callbackId, 101, [{polluted: true}]])
    await delay(10)
    off()

    assert.deepEqual(values, [])
    assert.equal(({} as any).polluted, undefined)
}

export async function runRpcCallbackBatchTests() {
    await testBurstBatchAndBounds()
    await testByteBound()
    await testUtf8ByteBound()
    await testBinaryPacketBypass()
    testDirectBinaryOversizeLowerBound()
    await testPersistentServerReconnectCaps()
    await testSchemaReadyWithSynchronousMap()
    await testSchemaReadyOfflineThenConnect()
    await testServerReplacementGenerationBarrier()
    await testEndAndErrorOrder()
    await testBatchedCallbackPreservesAllErrors()
    await testLegacyFallback()
    await testShapeSignatureAndServerKeys()
    await testHostileClientShape()
    console.log('RPC callback batch tests: OK')
}

if (require.main === module) {
    runRpcCallbackBatchTests().catch(function fail(error) {
        console.error(error)
        process.exit(1)
    })
}
