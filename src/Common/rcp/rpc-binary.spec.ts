// ===========================================================================
// Universal binary RPC — public integration contract
//
// This suite deliberately observes only public RPC behavior and SocketTmpl
// values. It does not import the byte codec: a negotiated application packet
// is binary when the socket receives an ArrayBuffer/view, regardless of its
// private byte layout.
// ===========================================================================

import * as assert from 'node:assert/strict'
import {isDeepStrictEqual} from 'node:util'
import {createRpcClient} from './rpc-client'
import {createRpcServer} from './rpc-server'
import {createInProcSocketPair} from './rpc-inproc'
import {rpcEndCallback} from './rpc-walk'
import {Pkt, type SocketTmpl} from './rpc-protocol'
import type {RpcOpt} from './rpc-caps'

type tWireRecords = {
    arrays: any[][]
    binary: Uint8Array[]
}

function delay(ms = 0) {
    return new Promise<void>(function waitDelay(resolve) {
        setTimeout(resolve, ms)
    })
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 750) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await delay(2)
    }
    throw new Error('timeout waiting for ' + label)
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
        if (Array.isArray(data)) records.arrays.push(data)
        else {
            const bytes = wireBytes(data)
            if (bytes) {
                const copy = new Uint8Array(bytes.byteLength)
                copy.set(bytes)
                records.binary.push(copy)
            }
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
    return records.arrays.some(packet => packet[0] == opcode)
}

function exact(actual: unknown, expected: unknown, label: string) {
    if (actual instanceof Date && expected instanceof Date) {
        assert.ok(Object.is(actual.getTime(), expected.getTime()), label)
        return
    }
    assert.ok(isDeepStrictEqual(actual, expected), label)
}

function createOffsetUint16() {
    const backing = new Uint8Array(10)
    const value = new Uint16Array(backing.buffer, 2, 3)
    value.set([0x1234, 0xabcd, 0x0102])
    return value
}

function createNestedValue(levels: number) {
    let value: unknown = 'leaf'
    for (let level = 0; level < levels; level++) value = {value}
    return value
}

function createExactValues() {
    const dataViewBacking = new Uint8Array([0xa5, 7, 8, 9, 0xa5])
    const nullPrototype = Object.create(null) as Record<string, unknown>
    nullPrototype['enabled'] = false
    nullPrototype['missing'] = undefined
    const sparse = new Array<unknown>(5)
    sparse[1] = undefined
    sparse[3] = null
    sparse[4] = 'tail'
    const values: {label: string; value: unknown}[] = [
        {label: 'string', value: 'text'},
        {label: 'number', value: 42},
        {label: 'false', value: false},
        {label: 'true', value: true},
        {label: 'null', value: null},
        {label: 'undefined', value: undefined},
        {label: 'negative-zero', value: -0},
        {label: 'nan', value: Number.NaN},
        {label: 'positive-infinity', value: Number.POSITIVE_INFINITY},
        {label: 'negative-infinity', value: Number.NEGATIVE_INFINITY},
        {label: 'fraction', value: -123.75},
        {label: 'bigint', value: -9_007_199_254_740_993n},
        {label: 'lone-surrogate', value: '\ud800'},
        {label: 'object', value: {id: 'A', price: 12.5, active: false}},
        {label: 'same-shape-new-types', value: {id: 7, price: '12.5', active: null}},
        {label: 'nested', value: {rows: [{id: 'A'}, {id: 'B', missing: undefined}]}},
        {label: 'null-prototype', value: nullPrototype},
        {label: 'sparse', value: sparse},
        {label: 'date', value: new Date('2026-07-23T12:34:56.789Z')},
        {label: 'invalid-date', value: new Date(Number.NaN)},
        {label: 'regexp', value: /цена\s+"(?<pair>.+)"/giu},
        {label: 'map', value: new Map<unknown, unknown>([
            [undefined, Number.NaN],
            ['nested', new Set([false, true, 9n])],
        ])},
        {label: 'set', value: new Set<unknown>([undefined, -0, 'ETH'])},
        {label: 'array-buffer', value: new Uint8Array([1, 2, 3, 4]).buffer},
        {label: 'data-view', value: new DataView(dataViewBacking.buffer, 1, 3)},
        {label: 'uint8', value: new Uint8Array([0, 1, 255])},
        {label: 'offset-uint16', value: createOffsetUint16()},
        {label: 'float64', value: new Float64Array([-0, Number.NaN, Number.POSITIVE_INFINITY])},
    ]
    const BigInt64 = (globalThis as any).BigInt64Array
    if (typeof BigInt64 == 'function') {
        values.push({label: 'bigint64', value: new BigInt64([-1n, 0n, 1n])})
    }
    return values
}

function createApi() {
    function makeBox(value: number): any {
        return {
            value,
            add(delta: number) {
                return makeBox(value + delta)
            },
        }
    }

    return {
        ping: () => 'pong',
        add: (left: number, right: number) => left + right,
        echo: (value: any) => value,
        deepResult: (levels: number) => createNestedValue(levels),
        pair: (left: any, right: any) => [left, right],
        makeBox,
        callbackValues(values: any[], cb: (value: any) => void) {
            for (const value of values) cb(value)
            rpcEndCallback(cb)
            return values.length
        },
        callbackOne(cb: (value: string) => void) {
            cb('one')
            rpcEndCallback(cb)
            return 'one-done'
        },
        callbackStopLiteral(cb: (value: string) => void) {
            cb('___STOP')
            cb('after-stop-literal')
            rpcEndCallback(cb)
            return 'done'
        },
        callbackSnapshot(cb: (value: any) => void) {
            const value = {
                status: 'before',
                nested: {count: 1},
                when: new Date(1_000),
                bytes: new Uint8Array([1, 2, 3]),
            }
            cb(value)
            value.status = 'after'
            value.nested.count = 2
            value.when.setTime(2_000)
            value.bytes[0] = 9
            rpcEndCallback(cb)
            return 'snapshot-done'
        },
        callbackNested(levels: number, cb: (value: unknown) => void) {
            const value = createNestedValue(levels)
            cb(value)
            cb(value)
            rpcEndCallback(cb)
            return levels
        },
        nestedCallbacks(values: Map<string, unknown>, group: Set<unknown>) {
            const mapCallback = values.get('callback')
            const setCallback = [...group].find(value => typeof value == 'function')
            if (typeof mapCallback != 'function' || typeof setCallback != 'function') {
                throw new Error('nested callbacks were not restored')
            }
            mapCallback('map')
            setCallback('set')
            rpcEndCallback(mapCallback)
            rpcEndCallback(setCallback)
            return 'nested-done'
        },
        throwExact(value: unknown) {
            throw value
        },
        cyclicResult() {
            const value: Record<string, unknown> = {label: 'cycle'}
            value['self'] = value
            return value
        },
        functionResult() {
            return function unsupportedBusinessFunction() {
                return 'not callable over RPC'
            }
        },
        objectWithMethods() {
            return {
                value: 8,
                add(delta: number) {
                    return 8 + delta
                },
                nested: {
                    label: 'data',
                    mutate() {
                        return 'method'
                    },
                },
            }
        },
        invalidArg(_value: unknown) {
            return 'unexpected'
        },
        largeArray() {
            const value: unknown[] = Array.from({length: 10_001}, (_, index) => index)
            value[0] = {$_d: 5}
            value[1] = -0
            value[2] = NaN
            delete value[3]
            return value
        },
        largeCallback(cb: (value: unknown[]) => void) {
            const value: unknown[] = Array.from({length: 10_001}, (_, index) => index)
            value[0] = {$_d: 5}
            value[1] = -0
            value[2] = NaN
            delete value[3]
            cb(value)
            rpcEndCallback(cb)
            return 'large-callback-done'
        },
        throwLargeData() {
            const error: any = new Error('large error data')
            error.code = 'E_LARGE'
            error.data = Array.from({length: 10_001}, (_, index) => index)
            throw error
        },
        throwDeepData(levels: number) {
            const error: any = new Error('deep error data')
            error.code = 'E_DEEP'
            error.data = createNestedValue(levels)
            throw error
        },
    }
}

type tApi = ReturnType<typeof createApi>

function createFixture(options?: {clientOpt?: RpcOpt; serverOpt?: RpcOpt; limit?: number}) {
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const client = createRpcClient<tApi>({
        socket: clientWire.socket,
        socketKey: 'rpc-binary',
        opt: options?.clientOpt,
        limit: options?.limit,
    })
    createRpcServer({
        socket: serverWire.socket,
        socketKey: 'rpc-binary',
        object: createApi(),
        opt: options?.serverOpt,
    })

    function close() {
        client.close('rpc binary integration complete', {socketAlive: false})
    }

    return {client, clientWire, serverWire, close}
}

async function negotiateBinary(fixture: ReturnType<typeof createFixture>) {
    await fixture.client.ready()
    await waitFor('binary probe and acknowledgement', function binaryControlRoundTrip() {
        return fixture.clientWire.records.binary.length > 0
            && fixture.serverWire.records.binary.length > 0
    })
    await delay(5)
    fixture.clientWire.reset()
    fixture.serverWire.reset()
}

async function settleAsRejection(value: Promise<unknown>, timeoutMs = 500) {
    let timer: ReturnType<typeof setTimeout> | undefined
    return new Promise<{rejected: boolean; value: unknown}>(function waitForSettlement(resolve, reject) {
        timer = setTimeout(function settlementTimeout() {
            reject(new Error('RPC operation did not settle'))
        }, timeoutMs)
        value.then(
            function settledSuccessfully(result) {
                if (timer) clearTimeout(timer)
                resolve({rejected: false, value: result})
            },
            function settledWithRejection(error) {
                if (timer) clearTimeout(timer)
                resolve({rejected: true, value: error})
            },
        )
    })
}

async function testDefaultBinaryCallResponseAndPipe() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)

        assert.equal(await fixture.client.func.add(20, 22), 42)
        assert.ok(fixture.clientWire.records.binary.length > 0, 'CALL is a byte frame')
        assert.ok(fixture.serverWire.records.binary.length > 0, 'RESP is a byte frame')
        assert.equal(hasArrayPacket(fixture.clientWire.records, Pkt.CALL), false)
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.RESP), false)

        fixture.clientWire.reset()
        fixture.serverWire.reset()
        const piped = await (fixture.client.pipe as any).makeBox(7).add(5).value
        assert.equal(piped, 12)
        assert.ok(fixture.clientWire.records.binary.length > 0, 'PIPE is a byte frame')
        assert.ok(fixture.serverWire.records.binary.length > 0, 'PIPE result is a byte frame')
        assert.equal(hasArrayPacket(fixture.clientWire.records, Pkt.PIPE), false)
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.RESP), false)
    } finally {
        fixture.close()
    }
}

async function testApplicationDepthBehindProtocolWrappers() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)
        // 32 object nodes plus the leaf occupy application depths 0..32. The codec needs
        // four additional levels for CB_BATCH/PIPE protocol collections.
        const boundary = createNestedValue(32)
        exact(await fixture.client.func.echo(boundary), boundary,
            'CALL/RESP accepts the application depth-32 boundary')
        exact(await (fixture.client.pipe as any).echo(boundary), boundary,
            'PIPE accepts the application depth-32 boundary')
        exact(await fixture.client.func.deepResult(32), boundary,
            'server-produced RESP accepts the application depth-32 boundary')

        const callbackValues: unknown[] = []
        assert.equal(await fixture.client.func.callbackNested(
            32,
            function receiveNestedCallback(value) {
                callbackValues.push(value)
            },
        ), 32)
        exact(callbackValues, [boundary, boundary],
            'CB_BATCH accepts depth 32 behind all four protocol wrappers')

        const over = await settleAsRejection(fixture.client.func.echo(createNestedValue(33)))
        assert.equal(over.rejected, true, 'client argument at application depth 33 rejects')
        assert.match(String((over.value as any)?.message), /max depth exceeded/)

        const overResult = await settleAsRejection(fixture.client.func.deepResult(33))
        assert.equal(overResult.rejected, true, 'server result at application depth 33 rejects')
        assert.match(String((overResult.value as any)?.message), /max depth exceeded/)

        const boundaryError = await settleAsRejection(fixture.client.func.throwDeepData(32))
        assert.equal(boundaryError.rejected, true, 'depth-32 error remains a rejection')
        exact((boundaryError.value as any)?.data, boundary,
            'error data accepts the application depth-32 boundary')

        const overError = await settleAsRejection(fixture.client.func.throwDeepData(33))
        assert.equal(overError.rejected, true, 'error data at application depth 33 rejects')
        assert.match(String((overError.value as any)?.message), /max depth exceeded/)

        const overCallback = await settleAsRejection(fixture.client.func.callbackNested(
            33,
            function receiveOverDepthCallback() {},
        ))
        assert.equal(overCallback.rejected, true, 'callback value at application depth 33 rejects')
        assert.match(String((overCallback.value as any)?.message), /max(?:imum)? depth exceeded/)
        assert.equal(await fixture.client.func.ping(), 'pong')
    } finally {
        fixture.close()
    }

    const directCallbackFixture = createFixture({
        clientOpt: {callbackBatch: false},
        serverOpt: {callbackBatch: false},
    })
    try {
        await negotiateBinary(directCallbackFixture)
        const directOverCallback = await settleAsRejection(
            directCallbackFixture.client.func.callbackNested(
                33,
                function receiveDirectOverDepthCallback() {},
            ),
        )
        assert.equal(directOverCallback.rejected, true)
        assert.match(String((directOverCallback.value as any)?.message), /max depth exceeded/)
        assert.equal(await directCallbackFixture.client.func.ping(), 'pong')
    } finally {
        directCallbackFixture.close()
    }
}

async function testBinaryDisabledOnEitherSide() {
    for (const [label, options] of [
        ['client', {clientOpt: {binary: false}}],
        ['server', {serverOpt: {binary: false}}],
    ] as const) {
        const fixture = createFixture(options)
        try {
            await fixture.client.ready()
            await delay(20)
            fixture.clientWire.reset()
            fixture.serverWire.reset()

            assert.equal(await fixture.client.func.echo(label), label)
            assert.equal(fixture.clientWire.records.binary.length, 0, label + ' opt-out emits no bytes')
            assert.equal(fixture.serverWire.records.binary.length, 0, label + ' opt-out receives no bytes')
            assert.ok(hasArrayPacket(fixture.clientWire.records, Pkt.CALL), label + ' CALL remains an array')
            assert.ok(hasArrayPacket(fixture.serverWire.records, Pkt.RESP), label + ' RESP remains an array')
        } finally {
            fixture.close()
        }
    }
}

async function testExactHeterogeneousValues() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)
        for (const entry of createExactValues()) {
            const actual = await fixture.client.func.echo(entry.value)
            exact(actual, entry.value, 'exact round-trip: ' + entry.label)
        }

        const pair = await fixture.client.func.pair('42', 42)
        exact(pair, ['42', 42], 'multiple arguments retain independent types')

        exact(await fixture.client.func.echo({$_d: 5}), {$_d: 5},
            'single-key $_d business object is not a Date marker')
        exact(await fixture.client.func.echo({$_f: 7}), {$_f: 7},
            'single-key $_f business object is not a callback marker')
    } finally {
        fixture.close()
    }
}

async function testUnequalShapeBudgetsRemainCompatible() {
    const options = [
        {clientOpt: {binary: {maxShapes: 0}}, serverOpt: {binary: {maxShapes: 1_000}}},
        {clientOpt: {binary: {maxShapes: 1_000}}, serverOpt: {binary: {maxShapes: 0}}},
        {clientOpt: {binary: {maxShapes: 1}}, serverOpt: {binary: {maxShapes: 3}}},
        {clientOpt: {binary: {maxShapes: 3}}, serverOpt: {binary: {maxShapes: 1}}},
    ] satisfies {clientOpt: RpcOpt; serverOpt: RpcOpt}[]
    const values = [{a: 1}, {b: 'two'}, {c: false}, {d: {nested: 4}}]

    for (const option of options) {
        const fixture = createFixture(option)
        try {
            await negotiateBinary(fixture)
            for (const value of values) {
                const outcome = await settleAsRejection(fixture.client.func.echo(value))
                assert.equal(outcome.rejected, false, 'unequal maxShapes must not stall a call')
                exact(outcome.value, value, 'unequal maxShapes keeps exact values')
            }
            assert.equal(fixture.client.api.pending(), 0)
        } finally {
            fixture.close()
        }
    }
}

async function testCallbackBatchOrderEndAndPolymorphism() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)
        const values = createExactValues().map(entry => entry.value)
        const received: unknown[] = []
        const count = await fixture.client.func.callbackValues(values, function receiveBinaryValue(value) {
            received.push(value)
        })
        assert.equal(count, values.length)
        assert.equal(received.length, values.length, 'callback burst keeps its length')
        for (let index = 0; index < values.length; index++) {
            exact(received[index], values[index],
                'callback burst keeps exact value and order at index ' + index)
        }
        await waitFor('binary CB_END cleanup', () => fixture.client.api.callbacks() == 0)
        assert.ok(fixture.serverWire.records.binary.length < values.length,
            'callback burst is physically batched before byte encoding')
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.CB), false)
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.CB_BATCH), false)
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.CB_END), false)

        fixture.serverWire.reset()
        const stopValues: string[] = []
        assert.equal(await fixture.client.func.callbackStopLiteral(function receiveStopLiteral(value) {
            stopValues.push(value)
        }), 'done')
        exact(stopValues, ['___STOP', 'after-stop-literal'],
            'literal legacy stop string remains ordinary binary callback data')
        await waitFor('literal callback CB_END cleanup', () => fixture.client.api.callbacks() == 0)
    } finally {
        fixture.close()
    }
}

async function testCallbackBatchCapturesCallTimeSnapshot() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)
        const received: any[] = []
        assert.equal(await fixture.client.func.callbackSnapshot(function receiveSnapshot(value) {
            received.push(value)
        }), 'snapshot-done')
        await waitFor('snapshot callback delivery', () => received.length == 1)
        exact(received[0], {
            status: 'before',
            nested: {count: 1},
            when: new Date(1_000),
            bytes: new Uint8Array([1, 2, 3]),
        }, 'binary callback batch captures objects, Date and bytes at invocation time')
    } finally {
        fixture.close()
    }
}

async function testDirectCallbackErrorsRemainObservable() {
    const fixture = createFixture({
        clientOpt: {callbackBatch: false},
        serverOpt: {callbackBatch: false},
    })
    let onUncaught: ((error: Error) => void) | undefined
    const uncaught = new Promise<Error>(function waitForUncaught(resolve) {
        onUncaught = function receiveUncaught(error) {
            resolve(error)
        }
        process.once('uncaughtException', onUncaught)
    })
    try {
        await negotiateBinary(fixture)
        assert.equal(await fixture.client.func.callbackOne(function throwFromDirectCallback() {
            throw new Error('direct binary callback failed')
        }), 'one-done')
        const error = await Promise.race([
            uncaught,
            delay(500).then(function callbackErrorTimeout() {
                throw new Error('direct callback error was swallowed')
            }),
        ])
        assert.equal(error.message, 'direct binary callback failed')
    } finally {
        if (onUncaught) process.removeListener('uncaughtException', onUncaught)
        fixture.close()
    }
}

async function testPipeLimitDoesNotLeakCallbackIds() {
    const fixture = createFixture({limit: 0})
    try {
        await negotiateBinary(fixture)
        const outcome = await settleAsRejection(
            (fixture.client.pipe as any).invalidArg(function unusedPipeCallback() {}),
        )
        assert.equal(outcome.rejected, true)
        assert.equal(fixture.client.api.pending(), 0)
        assert.equal(fixture.client.api.callbacks(), 0)
    } finally {
        fixture.close()
    }
}

async function testOversizeValuesRejectWithoutLegacyCorruption() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)

        fixture.serverWire.reset()
        const large = await settleAsRejection(fixture.client.func.largeArray())
        assert.equal(large.rejected, true)
        assert.match(String((large.value as any)?.message), /array (?:exceeds item limit|too long)/)
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.RESP), false,
            'oversize exact result never falls back to marker-based legacy data')
        assert.ok(fixture.serverWire.records.binary.length > 0)

        fixture.serverWire.reset()
        let callbackValue: unknown[] | undefined
        const largeCallback = await settleAsRejection(
            fixture.client.func.largeCallback(function receiveLargeCallback(value) {
            callbackValue = value
            }),
        )
        assert.equal(largeCallback.rejected, true)
        assert.equal(callbackValue, undefined)
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.CB), false,
            'oversize exact callback never falls back to marker-based legacy data')
        assert.ok(fixture.serverWire.records.binary.length > 0)

        fixture.serverWire.reset()
        const thrown = await settleAsRejection(fixture.client.func.throwLargeData())
        assert.equal(thrown.rejected, true)
        assert.match(
            String((thrown.value as any)?.message),
            /RPC response serialization failed:.*array (?:exceeds item limit|too long)/,
        )
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.RESP), false,
            'oversize error DTO never falls back to marker-based legacy data')
        assert.ok(fixture.serverWire.records.binary.length > 0)

        fixture.serverWire.reset()
        assert.equal(await fixture.client.func.ping(), 'pong')
        assert.ok(fixture.serverWire.records.binary.length > 0,
            'binary generation remains usable after explicit capacity errors')
    } finally {
        fixture.close()
    }
}

async function testNestedCallbacksInMapAndSet() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)
        const received: string[] = []
        function receiveMap(value: string) {
            received.push(value)
        }
        function receiveSet(value: string) {
            received.push(value)
        }
        const result = await fixture.client.func.nestedCallbacks(
            new Map<string, unknown>([['callback', receiveMap], ['value', 7]]),
            new Set<unknown>(['value', receiveSet]),
        )
        assert.equal(result, 'nested-done')
        exact(received, ['map', 'set'], 'callbacks nested in Map and Set are restored')
        await waitFor('nested callback cleanup', () => fixture.client.api.callbacks() == 0)
    } finally {
        fixture.close()
    }
}

async function testFalseyThrowsStayErrors() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)
        for (const expected of [false, 0, '', null, undefined]) {
            const outcome = await settleAsRejection(fixture.client.func.throwExact(expected))
            assert.equal(outcome.rejected, true, 'falsey throw must reject')
            assert.ok(Object.is(outcome.value, expected), 'falsey rejection payload stays exact')
        }
        assert.equal(await fixture.client.func.ping(), 'pong')
    } finally {
        fixture.close()
    }
}

async function testInvalidResultsBecomeRpcErrors() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)
        const cyclic = await settleAsRejection(fixture.client.func.cyclicResult())
        assert.equal(cyclic.rejected, true, 'cyclic result rejects')
        assert.equal(await fixture.client.func.ping(), 'pong')

        const functionValue = await settleAsRejection(fixture.client.func.functionResult())
        assert.equal(functionValue.rejected, true, 'function result rejects')
        assert.equal(await fixture.client.func.ping(), 'pong')
        assert.equal(fixture.client.api.pending(), 0)
    } finally {
        fixture.close()
    }
}

async function testResultObjectMethodsKeepLegacyProjection() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)
        exact(
            await fixture.client.func.objectWithMethods(),
            {value: 8, nested: {label: 'data'}},
            'schema binary keeps the legacy JSON data projection',
        )
        assert.equal(await fixture.client.func.ping(), 'pong')
    } finally {
        fixture.close()
    }
}

async function testInvalidClientArgumentRollsBackTracking() {
    const fixture = createFixture()
    try {
        await negotiateBinary(fixture)
        const invalid: Record<string, unknown> = {
            callback: function unreachableCallback() {},
        }
        invalid['self'] = invalid
        const pendingBefore = fixture.client.api.pending()
        const callbacksBefore = fixture.client.api.callbacks()
        let rejected = false
        try {
            const operation = fixture.client.func.invalidArg(invalid)
            rejected = (await settleAsRejection(operation)).rejected
        } catch {
            rejected = true
        }
        assert.equal(rejected, true)
        assert.equal(fixture.client.api.pending(), pendingBefore)
        assert.equal(fixture.client.api.callbacks(), callbacksBefore)
        assert.equal(await fixture.client.func.ping(), 'pong')
    } finally {
        fixture.close()
    }
}

async function testMixedClientsOnOneSocketKey() {
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const binaryClient = createRpcClient<tApi>({
        socket: clientWire.socket,
        socketKey: 'shared-rpc-binary',
    })
    const arrayClient = createRpcClient<tApi>({
        socket: clientWire.socket,
        socketKey: 'shared-rpc-binary',
        opt: {binary: false},
    })
    createRpcServer({
        socket: serverWire.socket,
        socketKey: 'shared-rpc-binary',
        object: createApi(),
    })

    try {
        await Promise.all([binaryClient.ready(), arrayClient.ready()])
        await waitFor('shared binary client probe', function sharedProbeFinished() {
            return clientWire.records.binary.length > 0 && serverWire.records.binary.length > 0
        })
        await delay(5)

        clientWire.reset()
        serverWire.reset()
        assert.equal(await binaryClient.func.echo('binary-client'), 'binary-client')
        assert.ok(clientWire.records.binary.length > 0)
        assert.ok(serverWire.records.binary.length > 0)
        assert.equal(hasArrayPacket(clientWire.records, Pkt.CALL), false)
        assert.equal(hasArrayPacket(serverWire.records, Pkt.RESP), false)

        clientWire.reset()
        serverWire.reset()
        assert.equal(await arrayClient.func.echo('array-client'), 'array-client')
        assert.equal(clientWire.records.binary.length, 0)
        assert.equal(serverWire.records.binary.length, 0)
        assert.ok(hasArrayPacket(clientWire.records, Pkt.CALL))
        assert.ok(hasArrayPacket(serverWire.records, Pkt.RESP))
    } finally {
        binaryClient.close('shared binary test complete', {socketAlive: false})
        arrayClient.close('shared array test complete', {socketAlive: false})
    }
}

export async function runRpcBinaryTests() {
    let failures = 0
    const tests = [
        ['default CALL/RESP/PIPE use byte frames', testDefaultBinaryCallResponseAndPipe],
        ['application depth stays exact behind CALL/PIPE/CB_BATCH wrappers',
            testApplicationDepthBehindProtocolWrappers],
        ['binary:false on either peer keeps arrays', testBinaryDisabledOnEitherSide],
        ['heterogeneous values remain exact', testExactHeterogeneousValues],
        ['unequal local shape budgets remain wire-compatible',
            testUnequalShapeBudgetsRemainCompatible],
        ['callback batch/order/CB_END remains exact', testCallbackBatchOrderEndAndPolymorphism],
        ['callback batching captures call-time snapshots',
            testCallbackBatchCapturesCallTimeSnapshot],
        ['direct callback consumer errors remain observable',
            testDirectCallbackErrorsRemainObservable],
        ['nested Map/Set callbacks remain callable', testNestedCallbacksInMapAndSet],
        ['falsey throws remain rejections', testFalseyThrowsStayErrors],
        ['invalid results become RPC errors', testInvalidResultsBecomeRpcErrors],
        ['result object methods keep the legacy projection',
            testResultObjectMethodsKeepLegacyProjection],
        ['invalid client args roll back tracking', testInvalidClientArgumentRollsBackTracking],
        ['PIPE limit rejection does not leak callback ids',
            testPipeLimitDoesNotLeakCallbackIds],
        ['oversize values reject without legacy marker corruption',
            testOversizeValuesRejectWithoutLegacyCorruption],
        ['mixed clients sharing socket/key stay isolated', testMixedClientsOnOneSocketKey],
    ] as const

    console.log('\n--- universal binary RPC integration ---')
    for (const [name, run] of tests) {
        try {
            await run()
            console.log('PASS  ' + name)
        } catch (error: any) {
            failures++
            console.log('FAIL  ' + name + ': ' + String(error?.message ?? error))
        }
    }
    console.log(failures == 0
        ? 'RPC binary integration tests: OK'
        : 'RPC binary integration tests: ' + failures + ' FAILED')
    return failures
}

if (require.main === module) {
    runRpcBinaryTests().then(function finish(failures) {
        process.exit(failures == 0 ? 0 : 1)
    })
}
