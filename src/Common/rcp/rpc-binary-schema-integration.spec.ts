// ===========================================================================
// Universal schema binary RPC — negotiation and public channel contract
// ===========================================================================

import * as assert from 'node:assert/strict'
import {isDeepStrictEqual} from 'node:util'
import {createRpcClient} from './rpc-client'
import {createRpcServer} from './rpc-server'
import {createInProcSocketPair} from './rpc-inproc'
import {
    inspectRpcBinaryEnvelope,
    RPC_BINARY_PROTOCOL_VERSION,
    RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
    RpcBinaryFrame,
} from './rpc-binary-envelope'
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

async function waitFor(label: string, condition: () => boolean, timeoutMs = 1_000) {
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

function packetVersions(records: tWireRecords) {
    return records.binary
        .map(wire => inspectRpcBinaryEnvelope(wire))
        .filter(envelope => envelope?.kind == RpcBinaryFrame.PACKET)
        .map(envelope => envelope!.version)
}

function assertPacketVersion(
    records: tWireRecords,
    version: number,
    label: string,
) {
    const versions = packetVersions(records)
    assert.ok(versions.length > 0, label + ' emits application byte frames')
    assert.ok(versions.every(actual => actual == version), label + ' selects version ' + version)
}

function exact(actual: unknown, expected: unknown, label: string) {
    assert.ok(isDeepStrictEqual(actual, expected), label)
}

function createRichValue(seed: number) {
    return {
        symbol: 'PAIR-' + seed,
        price: seed + 0.25,
        enabled: seed % 2 == 0,
        missing: undefined,
        negativeZero: -0,
        invalid: NaN,
        bigint: BigInt(seed) * 9_007_199_254_740_993n,
        date: new Date(1_725_000_000_000 + seed),
        map: new Map<unknown, unknown>([
            ['seed', seed],
            [false, new Set([seed, 'value-' + seed])],
        ]),
        bytes: new Uint16Array([seed, seed + 1, 0xffff]),
        nested: {
            rows: Array.from({length: 12}, function createRow(_, index) {
                return {
                    id: index,
                    text: 'row-' + seed + '-' + index,
                    value: seed + index / 10,
                }
            }),
        },
    }
}

function createApi() {
    function makeBox(total: number): any {
        return {
            state: {
                total,
                when: new Date(1_725_000_000_000 + total),
                active: total > 0,
            },
            add(delta: number) {
                return makeBox(total + delta)
            },
        }
    }

    return {
        echo(value: unknown) {
            return value
        },
        makeBox,
        callbackOne(value: unknown, callback: (value: unknown) => void) {
            callback(value)
            rpcEndCallback(callback)
            return 'direct-done'
        },
        callbackMany(values: unknown[], callback: (value: unknown) => void) {
            for (const value of values) callback(value)
            rpcEndCallback(callback)
            return values.length
        },
        throwExact(value: unknown) {
            throw value
        },
    }
}

type tApi = ReturnType<typeof createApi>

function createFixture(options?: {clientOpt?: RpcOpt; serverOpt?: RpcOpt; socketKey?: string}) {
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const socketKey = options?.socketKey ?? 'rpc-schema-integration'
    const client = createRpcClient<tApi>({
        socket: clientWire.socket,
        socketKey,
        opt: options?.clientOpt,
    })
    createRpcServer({
        socket: serverWire.socket,
        socketKey,
        object: createApi(),
        opt: options?.serverOpt,
    })

    function close() {
        client.close('RPC schema integration test complete', {socketAlive: false})
    }

    return {client, clientWire, serverWire, close}
}

async function negotiateBinary(fixture: ReturnType<typeof createFixture>) {
    await fixture.client.ready()
    await waitFor('binary probe and acknowledgement', function binaryNegotiated() {
        return fixture.clientWire.records.binary.length > 0
            && fixture.serverWire.records.binary.length > 0
    })
    await delay(5)
    fixture.clientWire.reset()
    fixture.serverWire.reset()
}

// ===========================================================================
// Version selection
// ===========================================================================

async function testV2AndBothV1FallbackDirections() {
    const cases: {
        label: string
        clientOpt?: RpcOpt
        serverOpt?: RpcOpt
        version: number
    }[] = [
        {
            label: 'new client and new server',
            version: RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
        },
        {
            label: 'client schema:false and new server',
            clientOpt: {binary: {schema: false}},
            version: RPC_BINARY_PROTOCOL_VERSION,
        },
        {
            label: 'new client and server schema:false',
            serverOpt: {binary: {schema: false}},
            version: RPC_BINARY_PROTOCOL_VERSION,
        },
    ]

    for (let index = 0; index < cases.length; index++) {
        const test = cases[index]
        const fixture = createFixture({
            clientOpt: test.clientOpt,
            serverOpt: test.serverOpt,
            socketKey: 'schema-version-' + index,
        })
        try {
            await negotiateBinary(fixture)
            const expected = createRichValue(index + 1)
            exact(await fixture.client.func.echo(expected), expected, test.label + ' exact response')
            assertPacketVersion(fixture.clientWire.records, test.version, test.label + ' CALL')
            assertPacketVersion(fixture.serverWire.records, test.version, test.label + ' RESP')
            assert.equal(hasArrayPacket(fixture.clientWire.records, Pkt.CALL), false)
            assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.RESP), false)
        } finally {
            fixture.close()
        }
    }
}

async function testBinaryFalseOnEitherPeerKeepsLegacyArrays() {
    const cases: {clientOpt?: RpcOpt; serverOpt?: RpcOpt; label: string}[] = [
        {clientOpt: {binary: false}, label: 'client binary:false'},
        {serverOpt: {binary: false}, label: 'server binary:false'},
    ]

    for (let index = 0; index < cases.length; index++) {
        const test = cases[index]
        const fixture = createFixture({
            clientOpt: test.clientOpt,
            serverOpt: test.serverOpt,
            socketKey: 'schema-disabled-' + index,
        })
        try {
            await fixture.client.ready()
            await delay(10)
            fixture.clientWire.reset()
            fixture.serverWire.reset()
            const expected = {mode: test.label, value: index}
            exact(await fixture.client.func.echo(expected), expected, test.label + ' exact response')
            assert.equal(fixture.clientWire.records.binary.length, 0)
            assert.equal(fixture.serverWire.records.binary.length, 0)
            assert.ok(hasArrayPacket(fixture.clientWire.records, Pkt.CALL))
            assert.ok(hasArrayPacket(fixture.serverWire.records, Pkt.RESP))
        } finally {
            fixture.close()
        }
    }
}

async function testNewClientFallsBackToNoCapsServer() {
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    rawServerSocket.on('schema-no-caps', function handleOldServerPacket(message) {
        if (message == Pkt.STRICT) {
            rawServerSocket.emit('schema-no-caps', [Pkt.MAP, {}, {echo: 'func'}, []])
            return
        }
        if (!Array.isArray(message)) return
        if (message[0] == Pkt.CALL) {
            rawServerSocket.emit('schema-no-caps', [Pkt.RESP, message[1], message[3]?.[0]])
        }
    })
    const client = createRpcClient<tApi>({
        socket: clientWire.socket,
        socketKey: 'schema-no-caps',
    })
    try {
        await client.ready()
        clientWire.reset()
        serverWire.reset()
        const expected = {legacy: true, value: 'no-caps'}
        exact(await client.func.echo(expected), expected, 'no-CAPS server preserves legacy value')
        assert.equal(clientWire.records.binary.length, 0)
        assert.equal(serverWire.records.binary.length, 0)
        assert.ok(hasArrayPacket(clientWire.records, Pkt.CALL))
        assert.ok(hasArrayPacket(serverWire.records, Pkt.RESP))
    } finally {
        client.close('no-CAPS schema fallback complete', {socketAlive: false})
    }
}

// ===========================================================================
// Public RPC channels on v2
// ===========================================================================

async function testV2CallResponsePipeAndErrorExactness() {
    const fixture = createFixture({socketKey: 'schema-v2-core-channels'})
    try {
        await negotiateBinary(fixture)
        const expected = createRichValue(17)
        exact(await fixture.client.func.echo(expected), expected, 'v2 CALL/RESP exact')

        const piped = await (fixture.client.pipe as any).makeBox(10).add(7).state
        exact(piped, {
            total: 17,
            when: new Date(1_725_000_000_017),
            active: true,
        }, 'v2 PIPE result exact')

        const thrown = {code: 'E_SCHEMA_TEST', data: createRichValue(18)}
        let rejection: unknown
        try {
            await fixture.client.func.throwExact(thrown)
        } catch (error) {
            rejection = error
        }
        assert.ok(rejection != undefined, 'v2 error remains a rejection')
        assert.equal((rejection as any)?.code, thrown.code)
        exact((rejection as any)?.data, thrown.data, 'v2 error data exact')

        assertPacketVersion(
            fixture.clientWire.records,
            RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
            'v2 CALL/PIPE',
        )
        assertPacketVersion(
            fixture.serverWire.records,
            RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
            'v2 RESP/error',
        )
    } finally {
        fixture.close()
    }
}

async function testV2DirectCallbackExactness() {
    const fixture = createFixture({
        socketKey: 'schema-v2-direct-callback',
        clientOpt: {callbackBatch: false},
        serverOpt: {callbackBatch: false},
    })
    try {
        await negotiateBinary(fixture)
        const expected = createRichValue(21)
        const received: unknown[] = []
        assert.equal(await fixture.client.func.callbackOne(
            expected,
            function receiveDirectCallback(value) {
                received.push(value)
            },
        ), 'direct-done')
        await waitFor('direct callback value', () => received.length == 1)
        exact(received, [expected], 'v2 direct callback exact')
        assertPacketVersion(
            fixture.serverWire.records,
            RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
            'v2 direct callback',
        )
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.CB), false)
    } finally {
        fixture.close()
    }
}

async function testV2BatchedCallbackExactnessAndOrder() {
    const fixture = createFixture({socketKey: 'schema-v2-batched-callback'})
    try {
        await negotiateBinary(fixture)
        const expected = [
            'text',
            42,
            false,
            true,
            null,
            undefined,
            -0,
            NaN,
            9_007_199_254_740_993n,
            createRichValue(31),
            createRichValue(32),
        ]
        const received: unknown[] = []
        assert.equal(await fixture.client.func.callbackMany(
            expected,
            function receiveBatchedCallback(value) {
                received.push(value)
            },
        ), expected.length)
        await waitFor('all batched callback values', () => received.length == expected.length)
        exact(received, expected, 'v2 callback batch keeps exact values and order')
        assertPacketVersion(
            fixture.serverWire.records,
            RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
            'v2 callback batch',
        )
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.CB), false)
        assert.equal(hasArrayPacket(fixture.serverWire.records, Pkt.CB_BATCH), false)
    } finally {
        fixture.close()
    }
}

export async function runRpcBinarySchemaIntegrationTests() {
    let failures = 0
    const tests = [
        ['v2/new-new and both schema:false fallback directions',
            testV2AndBothV1FallbackDirections],
        ['binary:false on either peer keeps legacy arrays',
            testBinaryFalseOnEitherPeerKeepsLegacyArrays],
        ['new client falls back to a no-CAPS server', testNewClientFallsBackToNoCapsServer],
        ['v2 CALL/RESP/PIPE/error exactness', testV2CallResponsePipeAndErrorExactness],
        ['v2 direct callback exactness', testV2DirectCallbackExactness],
        ['v2 batched callback exactness and order', testV2BatchedCallbackExactnessAndOrder],
    ] as const

    console.log('\n--- universal schema binary RPC integration ---')
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
        ? 'RPC schema binary integration tests: OK'
        : 'RPC schema binary integration tests: ' + failures + ' FAILED')
    return failures
}

if (require.main === module) {
    runRpcBinarySchemaIntegrationTests().then(function finish(failures) {
        process.exit(failures == 0 ? 0 : 1)
    })
}
