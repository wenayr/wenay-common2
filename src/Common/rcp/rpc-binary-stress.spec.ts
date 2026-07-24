// ===========================================================================
// Universal binary RPC — deterministic integration stress
//
// This suite stays above the private byte layout. It deliberately pushes
// substantial values through the public CALL/RESP/PIPE/callback surfaces and
// observes only the SocketTmpl wire kind, ordering and recovered business data.
// ===========================================================================

import * as assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {listen as createListenPair} from '../events/Listen'
import {createRpcClient} from './rpc-client'
import {createRpcClientHub} from './rpc-clientHub'
import {createInProcSocketPair} from './rpc-inproc'
import {Pkt, type SocketTmpl} from './rpc-protocol'
import {createRpcServer, type RpcLimits} from './rpc-server'
import {createRpcServerAuto} from './rpc-server-auto'
import {rpcEndCallback} from './rpc-walk'
import type {RpcOpt} from './rpc-caps'

const LARGE_BINARY_BYTES = 4 * 1024 * 1024
const SNAPSHOT_BINARY_BYTES = 1 * 1024 * 1024
const CALLBACK_BINARY_BYTES = 1_250_000
const LOWER_BINARY_LIMIT = 1 * 1024 * 1024
const LARGE_ARRAY_ITEMS = 8_000
const LARGE_ARRAY_TEXT = 176
const LARGE_OBJECT_ROWS = 3_600
const LARGE_OBJECT_TEXT = 320
const CALLBACK_OBJECT_ROWS = 3_200
const CALLBACK_OBJECT_TEXT = 288
const CALLBACK_ARRAY_ITEMS = 7_000
const CALLBACK_ARRAY_TEXT = 176
const CALLBACK_BATCH_BYTES = 8 * 1024 * 1024

type tArrayRecord = {
    opcode: number
    second?: number
    generation?: number
}

type tWireRecords = {
    arrays: tArrayRecord[]
    binary: number[]
}

function delay(ms = 0) {
    return new Promise<void>(function waitDelay(resolve) {
        setTimeout(resolve, ms)
    })
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await delay(2)
    }
    throw new Error('timeout waiting for ' + label)
}

async function within<T>(label: string, value: Promise<T>, timeoutMs = 15_000) {
    let timer: ReturnType<typeof setTimeout> | undefined
    return new Promise<T>(function waitForValue(resolve, reject) {
        timer = setTimeout(function operationTimeout() {
            reject(new Error('timeout during ' + label))
        }, timeoutMs)
        value.then(
            function operationResolved(result) {
                if (timer) clearTimeout(timer)
                resolve(result)
            },
            function operationRejected(error) {
                if (timer) clearTimeout(timer)
                reject(error)
            },
        )
    })
}

async function captureFailure<T>(run: () => T | Promise<T>) {
    try {
        return {rejected: false, value: await run()}
    } catch (error) {
        return {rejected: true, value: error}
    }
}

function activeBytes(value: ArrayBuffer | ArrayBufferView) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function wireBytes(value: unknown) {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return activeBytes(value)
    }
    return undefined
}

function observeSocket(socket: SocketTmpl) {
    const records: tWireRecords = {arrays: [], binary: []}
    const originalEmit = socket.emit.bind(socket)
    socket.emit = function observeWire(event, data) {
        if (Array.isArray(data)) {
            records.arrays.push({
                opcode: typeof data[0] == 'number' ? data[0] : -1,
                second: typeof data[1] == 'number' ? data[1] : undefined,
                generation: data[0] == Pkt.CAPS && Number.isSafeInteger(data[3])
                    ? data[3]
                    : undefined,
            })
        } else {
            const bytes = wireBytes(data)
            if (bytes) records.binary.push(bytes.byteLength)
        }
        originalEmit(event, data)
    }

    function reset() {
        records.arrays.length = 0
        records.binary.length = 0
    }

    return {socket, records, reset}
}

function hasArrayPacket(records: tWireRecords, opcode: number) {
    return records.arrays.some(record => record.opcode == opcode)
}

function exact(actual: unknown, expected: unknown, label: string) {
    assert.ok(isDeepStrictEqual(actual, expected), label)
}

function binaryDigest(value: ArrayBuffer | ArrayBufferView) {
    return createHash('sha256').update(activeBytes(value)).digest('hex')
}

function assertBinary(
    actual: ArrayBuffer | ArrayBufferView,
    expected: ArrayBuffer | ArrayBufferView,
    label: string,
) {
    assert.equal(actual.byteLength, expected.byteLength, label + ' byte length')
    assert.equal(binaryDigest(actual), binaryDigest(expected), label + ' SHA-256')
}

function createBytes(byteLength: number, seed: number) {
    const value = new Uint8Array(byteLength)
    let state = seed >>> 0
    for (let index = 0; index < value.length; index++) {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        value[index] = state & 0xff
    }
    return value
}

function createFixedText(index: number, width: number) {
    const prefix = 'row-' + String(index).padStart(6, '0') + '|'
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_'
    let value = prefix
    while (value.length < width) {
        const offset = (index * 17 + value.length) % alphabet.length
        value += alphabet.slice(offset) + alphabet.slice(0, offset)
    }
    return value.slice(0, width)
}

function createLargeArray(count = LARGE_ARRAY_ITEMS, width = LARGE_ARRAY_TEXT) {
    return Array.from({length: count}, function createLargeArrayItem(_, index) {
        return createFixedText(index, width)
    })
}

function createLargeObject(count = LARGE_OBJECT_ROWS, width = LARGE_OBJECT_TEXT) {
    const rows = Array.from({length: count}, function createLargeObjectRow(_, index) {
        return {
            id: index,
            symbol: 'PAIR-' + String(index % 250).padStart(3, '0'),
            price: 10_000 + index / 100,
            active: index % 3 != 0,
            note: createFixedText(index, width),
            nested: {
                revision: index * 7,
                flags: [index % 2 == 0, null, 'v' + index],
            },
        }
    })
    return {
        revision: 91,
        generatedAt: new Date('2026-07-23T12:34:56.789Z'),
        routes: new Map<unknown, unknown>([
            ['quotes', {first: 0, last: count - 1}],
            [7, new Set(['binary', 'batch', false])],
        ]),
        rows,
    }
}

function createMixedValues() {
    return [
        false,
        true,
        null,
        undefined,
        -123.75,
        '___STOP',
        'строка-値',
        {
            id: 7,
            active: false,
            nested: {missing: undefined, value: 'object'},
        },
        new Date('2026-07-23T12:34:56.789Z'),
        new Map<unknown, unknown>([
            ['false', false],
            [7, {kind: 'map-object'}],
        ]),
        new Set<unknown>([false, true, 'set', 9]),
        new Uint16Array([0, 1, 0xffff, 0x1234]),
    ]
}

function createStressApi(version = 1) {
    function wrap(value: unknown) {
        return {payload: value}
    }

    return {
        version: () => version,
        ping: (value: unknown) => value,
        echo: (value: unknown) => value,
        wrap,
        binaryPayload(byteLength: number, seed: number) {
            return createBytes(byteLength, seed)
        },
        objectPayload(count: number, width: number) {
            return createLargeObject(count, width)
        },
        callbackMatrix(
            values: unknown[],
            left: (side: string, index: number, value: unknown) => void,
            right: (side: string, index: number, value: unknown) => void,
        ) {
            for (let index = 0; index < values.length; index++) {
                left('left', index, values[index])
                right('right', index, values[index])
            }
            rpcEndCallback(left)
            rpcEndCallback(right)
            return values.length
        },
        async callbackTimed(cb: (phase: string, index: number) => void) {
            cb('sync', 0)
            await Promise.resolve()
            cb('microtask', 1)
            await delay(4)
            cb('timer', 2)
            rpcEndCallback(cb)
            return 'timed-done'
        },
        callbackSnapshot(byteLength: number, cb: (value: any) => void) {
            const value = {
                status: 'before',
                nested: {count: 1},
                when: new Date(1_000),
                route: new Map<unknown, unknown>([['state', 'before']]),
                bytes: createBytes(byteLength, 41),
            }
            cb(value)
            value.status = 'after'
            value.nested.count = 2
            value.when.setTime(2_000)
            value.route.set('state', 'after')
            value.bytes.fill(0)
            rpcEndCallback(cb)
            return 'snapshot-done'
        },
        callbackLarge(
            binaryBytes: number,
            objectRows: number,
            objectWidth: number,
            arrayItems: number,
            arrayWidth: number,
            cb: (kind: string, value: unknown) => void,
        ) {
            cb('binary', createBytes(binaryBytes, 73))
            cb('object', createLargeObject(objectRows, objectWidth))
            cb('array', createLargeArray(arrayItems, arrayWidth))
            rpcEndCallback(cb)
            return 3
        },
        callbackOneBinary(byteLength: number, cb: (value: Uint8Array) => void) {
            cb(createBytes(byteLength, 99))
            rpcEndCallback(cb)
            return byteLength
        },
    }
}

type tStressApi = ReturnType<typeof createStressApi>

function stressBinaryOpt(opt?: RpcOpt) {
    return {...opt, binary: opt?.binary ?? true}
}

function createFixture(options?: {
    clientOpt?: RpcOpt
    serverOpt?: RpcOpt
    clientLimits?: RpcLimits
    serverLimits?: RpcLimits
    version?: number
}) {
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const client = createRpcClient<tStressApi>({
        socket: clientWire.socket,
        socketKey: 'rpc-binary-stress',
        opt: stressBinaryOpt(options?.clientOpt),
        limits: options?.clientLimits,
    })
    createRpcServer({
        socket: serverWire.socket,
        socketKey: 'rpc-binary-stress',
        object: createStressApi(options?.version),
        opt: stressBinaryOpt(options?.serverOpt),
        limits: options?.serverLimits,
    })

    function close() {
        client.close('RPC binary stress fixture complete', {socketAlive: false})
    }

    return {
        client,
        clientWire,
        serverWire,
        rawServerSocket,
        close,
    }
}

async function negotiateBinary(fixture: ReturnType<typeof createFixture>) {
    await within('RPC map readiness', fixture.client.ready())
    await waitFor('binary probe and acknowledgement', function binaryControlRoundTrip() {
        return fixture.clientWire.records.binary.length > 0
            && fixture.serverWire.records.binary.length > 0
    })
    await delay(5)
    fixture.clientWire.reset()
    fixture.serverWire.reset()
}

async function testLargeCallResponseAndPipe() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)

        const binary = createBytes(LARGE_BINARY_BYTES, 17)
        const echoedBinary = await within(
            '4 MiB binary CALL/RESP',
            fixture.client.func.echo(binary),
        ) as Uint8Array
        assertBinary(echoedBinary, binary, '4 MiB binary CALL/RESP')
        assert.ok(
            fixture.clientWire.records.binary.some(size => size > LARGE_BINARY_BYTES),
            'CALL carries the 4 MiB value in an RPB frame',
        )
        assert.ok(
            fixture.serverWire.records.binary.some(size => size > LARGE_BINARY_BYTES),
            'RESP carries the 4 MiB value in an RPB frame',
        )
        assert.equal(hasArrayPacket(fixture.clientWire.records, Pkt.CALL), false)
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.RESP), false)

        fixture.clientWire.reset()
        fixture.serverWire.reset()
        const object = createLargeObject()
        exact(
            await within('large object CALL/RESP', fixture.client.func.echo(object)),
            object,
            'large object CALL/RESP remains exact',
        )
        assert.ok(fixture.clientWire.records.binary.some(size => size > 1_000_000))
        assert.ok(fixture.serverWire.records.binary.some(size => size > 1_000_000))

        fixture.clientWire.reset()
        fixture.serverWire.reset()
        const array = createLargeArray()
        exact(
            await within(
                'large array PIPE',
                (fixture.client.pipe as any).wrap(array).payload,
            ),
            array,
            'large array PIPE remains exact',
        )
        assert.ok(fixture.clientWire.records.binary.some(size => size > 1_000_000))
        assert.ok(fixture.serverWire.records.binary.some(size => size > 1_000_000))
        assert.equal(hasArrayPacket(fixture.clientWire.records, Pkt.PIPE), false)

        fixture.clientWire.reset()
        fixture.serverWire.reset()
        const generated = await within(
            'generated 4 MiB RESP',
            fixture.client.func.binaryPayload(LARGE_BINARY_BYTES, 29),
        )
        assertBinary(generated, createBytes(LARGE_BINARY_BYTES, 29), 'generated 4 MiB RESP')
        assert.ok(fixture.serverWire.records.binary.some(size => size > LARGE_BINARY_BYTES))
        assert.equal(fixture.client.api.pending(), 0)
    } finally {
        fixture.close()
    }
}

async function testMixedCallbackOrderEndAndTypes() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)
        const values = createMixedValues()
        const left: unknown[] = []
        const right: unknown[] = []
        const global: unknown[] = []
        const count = await within(
            'mixed callback matrix',
            fixture.client.func.callbackMatrix(
                values,
                function receiveLeft(side, index, value) {
                    left.push(value)
                    global.push([side, index, value])
                },
                function receiveRight(side, index, value) {
                    right.push(value)
                    global.push([side, index, value])
                },
            ),
        )

        assert.equal(count, values.length)
        exact(left, values, 'left callback preserves every mixed value')
        exact(right, values, 'right callback preserves every mixed value')
        const expectedGlobal: unknown[] = []
        for (let index = 0; index < values.length; index++) {
            expectedGlobal.push(['left', index, values[index]])
            expectedGlobal.push(['right', index, values[index]])
        }
        exact(global, expectedGlobal, 'two callback ids retain global invocation order')
        await waitFor('mixed callback CB_END cleanup', () => fixture.client.api.callbacks() == 0)
        assert.ok(
            fixture.serverWire.records.binary.length < values.length * 2,
            'mixed callback burst is physically batched',
        )
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.CB), false)
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.CB_BATCH), false)
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.CB_END), false)
    } finally {
        fixture.close()
    }
}

async function testTimedCallbacksAndMegabyteSnapshot() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)
        const timed: [string, number][] = []
        assert.equal(
            await within(
                'timed callbacks',
                fixture.client.func.callbackTimed(function receiveTimedCallback(phase, index) {
                    timed.push([phase, index])
                }),
            ),
            'timed-done',
        )
        exact(timed, [
            ['sync', 0],
            ['microtask', 1],
            ['timer', 2],
        ], 'callbacks retain order across sync, microtask and timer boundaries')
        await waitFor('timed callback cleanup', () => fixture.client.api.callbacks() == 0)

        fixture.serverWire.reset()
        const snapshots: any[] = []
        assert.equal(
            await within(
                '1 MiB callback snapshot',
                fixture.client.func.callbackSnapshot(
                    SNAPSHOT_BINARY_BYTES,
                    function receiveSnapshot(value) {
                        snapshots.push(value)
                    },
                ),
            ),
            'snapshot-done',
        )
        assert.equal(snapshots.length, 1)
        const snapshot = snapshots[0]
        assert.equal(snapshot.status, 'before')
        assert.equal(snapshot.nested.count, 1)
        exact(snapshot.when, new Date(1_000), 'snapshot Date is captured at invocation')
        exact(
            snapshot.route,
            new Map<unknown, unknown>([['state', 'before']]),
            'snapshot Map is captured at invocation',
        )
        assertBinary(
            snapshot.bytes,
            createBytes(SNAPSHOT_BINARY_BYTES, 41),
            'snapshot typed array is captured before mutation',
        )
        await waitFor('snapshot callback cleanup', () => fixture.client.api.callbacks() == 0)
        assert.ok(fixture.serverWire.records.binary.some(size => size > SNAPSHOT_BINARY_BYTES))
    } finally {
        fixture.close()
    }
}

async function testLargePhysicalCallbackBatch() {
    const opt: RpcOpt = {
        callbackBatch: {
            maxItems: 16,
            maxBytes: CALLBACK_BATCH_BYTES,
        },
    }
    const fixture = createFixture({clientOpt: opt, serverOpt: opt})
    try {
        await negotiateBinary(fixture)
        const received: {kind: string; value: any}[] = []
        assert.equal(
            await within(
                'multi-megabyte callback batch',
                fixture.client.func.callbackLarge(
                    CALLBACK_BINARY_BYTES,
                    CALLBACK_OBJECT_ROWS,
                    CALLBACK_OBJECT_TEXT,
                    CALLBACK_ARRAY_ITEMS,
                    CALLBACK_ARRAY_TEXT,
                    function receiveLargeCallback(kind, value) {
                        received.push({kind, value})
                    },
                ),
            ),
            3,
        )
        assert.deepEqual(received.map(item => item.kind), ['binary', 'object', 'array'])
        assertBinary(
            received[0].value,
            createBytes(CALLBACK_BINARY_BYTES, 73),
            'large callback binary value',
        )
        exact(
            received[1].value,
            createLargeObject(CALLBACK_OBJECT_ROWS, CALLBACK_OBJECT_TEXT),
            'large callback object value',
        )
        exact(
            received[2].value,
            createLargeArray(CALLBACK_ARRAY_ITEMS, CALLBACK_ARRAY_TEXT),
            'large callback array value',
        )
        await waitFor('large callback CB_END cleanup', () => fixture.client.api.callbacks() == 0)
        assert.ok(
            fixture.serverWire.records.binary.some(size => size > 3_000_000),
            'three large callbacks share one multi-megabyte binary batch frame',
        )
        assert.ok(
            fixture.serverWire.records.binary.length <= 4,
            'large callback batch, CB_END and RESP use a bounded frame count',
        )
    } finally {
        fixture.close()
    }
}

async function testLimitsFailClosedAndRecover() {
    const serverLimited = createFixture({
        serverLimits: {maxBinaryLen: LOWER_BINARY_LIMIT},
    })
    try {
        await negotiateBinary(serverLimited)
        const overflow = createBytes(LOWER_BINARY_LIMIT + 1, 101)
        const rejected = await captureFailure(function sendServerLimitOverflow() {
            return serverLimited.client.func.echo(overflow)
        })
        assert.equal(rejected.rejected, true)
        assert.match(String((rejected.value as any)?.message), /binary (?:too long|value exceeds limit)/)
        assert.equal(await serverLimited.client.func.ping('after-server-limit'), 'after-server-limit')

        const boundary = createBytes(LOWER_BINARY_LIMIT, 102)
        assertBinary(
            await within(
                'server binary limit boundary',
                serverLimited.client.func.echo(boundary),
            ) as Uint8Array,
            boundary,
            'server binary limit boundary',
        )
        assert.equal(serverLimited.client.api.pending(), 0)
    } finally {
        serverLimited.close()
    }

    const clientLimited = createFixture({
        clientLimits: {maxBinaryLen: LOWER_BINARY_LIMIT},
    })
    try {
        await negotiateBinary(clientLimited)
        const response = await captureFailure(function receiveClientLimitOverflow() {
            return clientLimited.client.func.binaryPayload(LOWER_BINARY_LIMIT + 1, 103)
        })
        assert.equal(response.rejected, true)
        assert.match(String((response.value as any)?.message), /binary (?:too long|value exceeds limit)/)

        let callbackCalls = 0
        assert.equal(
            await within(
                'oversize callback is dropped',
                clientLimited.client.func.callbackOneBinary(
                    LOWER_BINARY_LIMIT + 1,
                    function receiveForbiddenOversizeCallback() {
                        callbackCalls++
                    },
                ),
            ),
            LOWER_BINARY_LIMIT + 1,
        )
        assert.equal(callbackCalls, 0, 'incoming callback over the local limit fails closed')
        await waitFor('limited callback CB_END cleanup',
            () => clientLimited.client.api.callbacks() == 0)

        const cyclic: Record<string, unknown> = {kind: 'cycle'}
        cyclic['self'] = cyclic
        const pendingBefore = clientLimited.client.api.pending()
        const callbacksBefore = clientLimited.client.api.callbacks()
        const cycle = await captureFailure(function sendCyclicArgument() {
            return clientLimited.client.func.echo(cyclic)
        })
        assert.equal(cycle.rejected, true)
        assert.match(String((cycle.value as any)?.message), /cyclic values are not supported/)
        assert.equal(clientLimited.client.api.pending(), pendingBefore)
        assert.equal(clientLimited.client.api.callbacks(), callbacksBefore)
        assert.equal(await clientLimited.client.func.ping('after-client-limit'), 'after-client-limit')
    } finally {
        clientLimited.close()
    }
}

async function testReconnectKeepsOneLargeCallbackPerGeneration() {
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const clientSocket = Object.assign(clientWire.socket, {
        disconnect() {},
    })
    const [emitPayload, payloads] = createListenPair<Uint8Array>()
    const [emitTransportDisconnect, transportDisconnect] = createListenPair<string>()
    const api = {
        payloads,
        ping(value: number) {
            return value
        },
    }
    const server = createRpcServerAuto({
        socket: serverWire.socket,
        socketKey: 'rpc-binary-stress-reconnect',
        object: api,
        disconnectListen: transportDisconnect,
        opt: {binary: true},
    })
    const hub = createRpcClientHub(
        function useLifecycleSocket() {
            return clientSocket
        },
        helper => ({main: helper<typeof api>('rpc-binary-stress-reconnect')}),
        {opt: {binary: true}},
    )

    try {
        const initial = hub.connect(null)
        rawServerSocket.emit('connect', 1)
        await within('initial reconnect fixture connection', initial)
        await waitFor('initial reconnect binary generation', function initialBinaryGeneration() {
            return clientWire.records.binary.length > 0
                && serverWire.records.binary.length > 0
        })

        const received: string[] = []
        ;(hub.facade.main.func.payloads as any).on(function receiveGenerationPayload(
            value: Uint8Array,
        ) {
            received.push(binaryDigest(value))
        })
        await waitFor('initial reconnect subscription', function initialSubscription() {
            return server.api.subscriptions().some(item => item.consumers == 1)
        })

        const expected: string[] = []
        for (let generation = 0; generation <= 2; generation++) {
            if (generation > 0) {
                clientWire.reset()
                serverWire.reset()
                rawServerSocket.emit('disconnect', 'stress-generation-' + generation)
                emitTransportDisconnect('stress-generation-' + generation)
                await waitFor('subscription cleanup ' + generation,
                    () => server.api.subscriptions().length == 0)
                rawServerSocket.emit('connect', generation + 1)
                await waitFor('hub reconnect ' + generation,
                    () => hub.connectCount() == generation + 1)
                await waitFor('binary renegotiation ' + generation, function binaryRenegotiated() {
                    return clientWire.records.binary.length > 0
                        && serverWire.records.binary.length > 0
                })
                await waitFor('subscription restore ' + generation, function subscriptionRestored() {
                    return server.api.subscriptions().some(item => item.consumers == 1)
                })
            }

            assert.equal(await hub.facade.main.func.ping(generation), generation)
            const payload = createBytes(SNAPSHOT_BINARY_BYTES, 200 + generation)
            expected.push(binaryDigest(payload))
            emitPayload(payload)
            await waitFor('large callback generation ' + generation,
                () => received.length == generation + 1)
            await delay(5)
            assert.deepEqual(received, expected)
            assert.ok(serverWire.records.binary.some(size => size > SNAPSHOT_BINARY_BYTES))
        }
    } finally {
        hub.facade.main.close('RPC binary reconnect stress complete', {socketAlive: false})
        emitTransportDisconnect('RPC binary reconnect stress complete')
    }
}

async function testLegacyFallbackBothDirectionsWithLargeValues() {
    const [rawClientSocket, serverSocket] = createInProcSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(serverSocket)
    serverSocket.on('rpc-binary-stress-old-server', function handleOldServer(message) {
        if (message == Pkt.STRICT) {
            serverSocket.emit('rpc-binary-stress-old-server', [
                Pkt.MAP,
                {},
                {echo: 'func'},
                [],
            ])
            return
        }
        if (!Array.isArray(message)) return
        if (message[0] == Pkt.CALL) {
            serverSocket.emit('rpc-binary-stress-old-server', [
                Pkt.RESP,
                message[1],
                message[3]?.[0],
            ])
        }
    })
    const client = createRpcClient<{echo(value: unknown): unknown}>({
        socket: clientWire.socket,
        socketKey: 'rpc-binary-stress-old-server',
    })

    try {
        await within('new client with old server readiness', client.ready())
        clientWire.reset()
        serverWire.reset()
        const rich = [
            false,
            true,
            null,
            17.25,
            'legacy',
            new Date(1_234),
            new Map<unknown, unknown>([['state', false], [7, 'seven']]),
            new Set<unknown>([false, true, 'set']),
            new Uint16Array([0, 1, 0xffff]),
        ]
        exact(
            await within('legacy rich echo', client.func.echo(rich)),
            rich,
            'new client preserves legacy rich-value behavior',
        )

        const binary = createBytes(SNAPSHOT_BINARY_BYTES, 301)
        assertBinary(
            await within('legacy 1 MiB binary echo', client.func.echo(binary)) as Uint8Array,
            binary,
            'new client to old server large binary fallback',
        )
        const object = createLargeObject(2_000, 256)
        exact(
            await within('legacy large object echo', client.func.echo(object)),
            object,
            'new client to old server large object fallback',
        )
        assert.equal(clientWire.records.binary.length, 0)
        assert.equal(serverWire.records.binary.length, 0)
        assert.ok(hasArrayPacket(clientWire.records, Pkt.CALL))
        assert.ok(hasArrayPacket(serverWire.records, Pkt.RESP))
    } finally {
        client.close('new client to old server stress complete', {socketAlive: false})
    }

    const [oldClientSocket, rawNewServerSocket] = createInProcSocketPair()
    const newServerWire = observeSocket(rawNewServerSocket)
    const received: any[] = []
    oldClientSocket.on('rpc-binary-stress-old-client', function receiveOldClientPacket(message) {
        received.push(message)
    })
    createRpcServer({
        socket: newServerWire.socket,
        socketKey: 'rpc-binary-stress-old-client',
        object: createStressApi(),
    })
    await waitFor('new server initial MAP for old client', function initialMapArrived() {
        return received.some(message => Array.isArray(message) && message[0] == Pkt.MAP)
    })
    received.length = 0
    newServerWire.reset()
    const requestId = 700
    const oldClientBinary = createBytes(SNAPSHOT_BINARY_BYTES, 302)
    oldClientSocket.emit('rpc-binary-stress-old-client', [
        Pkt.CALL,
        requestId,
        ['echo'],
        [oldClientBinary],
    ])
    await waitFor('raw large response to old client', function rawResponseArrived() {
        return received.some(message =>
            Array.isArray(message)
            && message[0] == Pkt.RESP
            && message[1] == requestId)
    })
    const response = received.find(message =>
        Array.isArray(message)
        && message[0] == Pkt.RESP
        && message[1] == requestId)
    assertBinary(response[2], oldClientBinary, 'old client to new server large binary fallback')
    assert.equal(newServerWire.records.binary.length, 0)
    assert.ok(hasArrayPacket(newServerWire.records, Pkt.RESP))
}

export async function runRpcBinaryStressTests() {
    let failures = 0
    const tests = [
        ['multi-megabyte CALL/RESP/PIPE values', testLargeCallResponseAndPipe],
        ['mixed callback types, global order and CB_END', testMixedCallbackOrderEndAndTypes],
        ['timed callbacks and megabyte call-time snapshot', testTimedCallbacksAndMegabyteSnapshot],
        ['multi-megabyte physical callback batch', testLargePhysicalCallbackBatch],
        ['lower limits fail closed and binary generation recovers', testLimitsFailClosedAndRecover],
        ['two reconnects keep one large callback per generation',
            testReconnectKeepsOneLargeCallbackPerGeneration],
        ['legacy fallback in both client/server directions with large values',
            testLegacyFallbackBothDirectionsWithLargeValues],
    ] as const

    console.log('\n--- universal binary RPC deterministic stress ---')
    const startedAt = Date.now()
    for (const [name, run] of tests) {
        const testStartedAt = Date.now()
        try {
            await run()
            console.log('PASS  ' + name + ' (' + (Date.now() - testStartedAt) + ' ms)')
        } catch (error: any) {
            failures++
            console.log('FAIL  ' + name + ': ' + String(error?.stack ?? error))
        }
    }
    console.log(failures == 0
        ? 'RPC binary stress tests: OK in ' + (Date.now() - startedAt) + ' ms'
        : 'RPC binary stress tests: ' + failures + ' FAILED')
    return failures
}

if (require.main === module) {
    runRpcBinaryStressTests().then(function finish(failures) {
        process.exit(failures == 0 ? 0 : 1)
    })
}
