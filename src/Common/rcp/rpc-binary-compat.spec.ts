// ===========================================================================
// Universal binary RPC — compatibility and transport-generation contract
//
// These tests stay above the private byte layout. They observe SocketTmpl values
// and speak the historical array protocol where a real old peer is required.
// ===========================================================================

import * as assert from 'node:assert/strict'
import {listen as createListenPair} from '../events/Listen'
import {createRpcServerAutoDetect} from './createRpcServerAutoWithProtocolDetection'
import {createRpcClient} from './rpc-client'
import {createRpcClientHub} from './rpc-clientHub'
import {createInProcSocketPair} from './rpc-inproc'
import {Pkt, type SocketTmpl} from './rpc-protocol'
import {createRpcServer} from './rpc-server'
import {createRpcServerAuto} from './rpc-server-auto'
import {rpcEndCallback} from './rpc-walk'
import {Caps} from './rpc-caps'
import {
    inspectRpcBinaryEnvelope,
    RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
} from './rpc-binary-envelope'

type tWireRecords = {
    arrays: any[][]
    binary: Uint8Array[]
}

function delay(ms = 0) {
    return new Promise<void>(function waitDelay(resolve) {
        setTimeout(resolve, ms)
    })
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await delay(2)
    }
    throw new Error('timeout waiting for ' + label)
}

async function within<T>(label: string, value: Promise<T>, timeoutMs = 1000) {
    let timer: ReturnType<typeof setTimeout> | undefined
    return new Promise<T>(function waitWithin(resolve, reject) {
        timer = setTimeout(function timeoutWithin() {
            reject(new Error('timeout waiting for ' + label))
        }, timeoutMs)
        value.then(
            function resolveWithin(result) {
                if (timer) clearTimeout(timer)
                resolve(result)
            },
            function rejectWithin(error) {
                if (timer) clearTimeout(timer)
                reject(error)
            },
        )
    })
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

function assertSchemaBinaryFrames(records: tWireRecords, label: string) {
    assert.ok(records.binary.length > 0, label + ' has binary frames')
    for (const wire of records.binary) {
        const envelope = inspectRpcBinaryEnvelope(wire)
        assert.ok(envelope, label + ' frame has an RPC binary envelope')
        assert.equal(
            envelope.version,
            RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
            label + ' renegotiates schema binary v2',
        )
    }
}

function createBinaryGate(socket: SocketTmpl, initial: 'hold' | 'json' | 'version') {
    const originalEmit = socket.emit.bind(socket)
    const held: {event: string; data: any}[] = []
    let mode: 'hold' | 'json' | 'version' | 'pass' = initial

    socket.emit = function gateBinary(event, data) {
        if (!wireBytes(data)) {
            originalEmit(event, data)
            return
        }
        if (mode == 'hold') {
            held.push({event, data})
            return
        }
        if (mode == 'json') {
            originalEmit(event, JSON.parse(JSON.stringify(data)))
            return
        }
        if (mode == 'version') {
            const source = wireBytes(data)!
            const copy = new Uint8Array(source.byteLength)
            copy.set(source)
            copy[3] = (copy[3] + 1) & 0xff
            originalEmit(event, copy)
            return
        }
        originalEmit(event, data)
    }

    function release() {
        mode = 'pass'
        const packets = held.splice(0)
        for (const packet of packets) originalEmit(packet.event, packet.data)
    }

    return {
        held: () => held.length,
        release,
    }
}

function createSyncByteSafeSocketPair(): [SocketTmpl, SocketTmpl] {
    const clientListeners: Record<string, ((data: any) => void)[]> = {}
    const serverListeners: Record<string, ((data: any) => void)[]> = {}

    function cloneWire(value: any) {
        const binary = wireBytes(value)
        if (binary) {
            const copy = new Uint8Array(binary.byteLength)
            copy.set(binary)
            return copy
        }
        if (value === undefined) return undefined
        return JSON.parse(JSON.stringify(value))
    }

    function createSocket(
        own: typeof clientListeners,
        peer: typeof clientListeners,
    ): SocketTmpl {
        return {
            on(event, callback) {
                ;(own[event] ??= []).push(callback)
            },
            emit(event, data) {
                for (const callback of [...(peer[event] ?? [])]) {
                    callback(cloneWire(data))
                }
            },
        }
    }

    return [
        createSocket(clientListeners, serverListeners),
        createSocket(serverListeners, clientListeners),
    ]
}

function createEchoApi() {
    return {
        echo(value: unknown) {
            return value
        },
    }
}

type tEchoApi = ReturnType<typeof createEchoApi>

async function testNewClientWithManualOldServer() {
    for (const legacyCaps of [undefined, 1, 3] as const) {
        const [rawClientSocket, serverSocket] = createInProcSocketPair()
        const clientWire = observeSocket(rawClientSocket)
        const serverWire = observeSocket(serverSocket)
        serverSocket.on('legacy-server', function handleLegacyServerPacket(message) {
            if (message == Pkt.STRICT) {
                serverSocket.emit('legacy-server', [Pkt.MAP, {}, {echo: 'func'}, []])
                return
            }
            if (!Array.isArray(message)) return
            if (message[0] == Pkt.CAPS) {
                if (legacyCaps != undefined) {
                    serverSocket.emit('legacy-server', [Pkt.CAPS, legacyCaps])
                }
                return
            }
            if (message[0] == Pkt.CALL) {
                serverSocket.emit('legacy-server', [Pkt.RESP, message[1], message[3]?.[0]])
            }
        })

        const client = createRpcClient<tEchoApi>({
            socket: clientWire.socket,
            socketKey: 'legacy-server',
        })
        try {
            await client.ready()
            clientWire.reset()
            serverWire.reset()
            const marker = legacyCaps == undefined ? 'no-caps' : 'caps-' + legacyCaps
            assert.equal(await client.func.echo(marker), marker)
            assert.equal(clientWire.records.binary.length, 0)
            assert.equal(serverWire.records.binary.length, 0)
            assert.ok(hasArrayPacket(clientWire.records, Pkt.CALL))
            assert.ok(hasArrayPacket(serverWire.records, Pkt.RESP))
        } finally {
            client.close('manual old server test complete', {socketAlive: false})
        }
    }
}

async function testManualOldClientWithNewServer() {
    for (const legacyCaps of [undefined, 1, 3] as const) {
        const [clientSocket, rawServerSocket] = createInProcSocketPair()
        const serverWire = observeSocket(rawServerSocket)
        const received: any[] = []
        clientSocket.on('legacy-client', function receiveLegacyClientPacket(message) {
            received.push(message)
        })
        createRpcServer({
            socket: serverWire.socket,
            socketKey: 'legacy-client',
            object: createEchoApi(),
        })

        await waitFor('new server initial legacy MAP', function initialMapArrived() {
            return received.some(message => Array.isArray(message) && message[0] == Pkt.MAP)
        })
        if (legacyCaps != undefined) {
            clientSocket.emit('legacy-client', [Pkt.CAPS, legacyCaps])
            await delay(5)
        }
        received.length = 0
        serverWire.reset()
        const requestId = 70 + (legacyCaps ?? 0)
        const marker = legacyCaps == undefined ? 'no-caps' : 'caps-' + legacyCaps
        clientSocket.emit('legacy-client', [Pkt.CALL, requestId, ['echo'], [marker]])
        await waitFor('new server raw response to old client', function rawResponseArrived() {
            return received.some(message =>
                Array.isArray(message)
                && message[0] == Pkt.RESP
                && message[1] == requestId)
        })
        const response = received.find(message =>
            Array.isArray(message)
            && message[0] == Pkt.RESP
            && message[1] == requestId)
        assert.equal(response?.[2], marker)
        assert.equal(serverWire.records.binary.length, 0)
        assert.ok(hasArrayPacket(serverWire.records, Pkt.RESP))
    }
}

async function testJsonOnlyTransportStaysRaw() {
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    createBinaryGate(rawClientSocket, 'json')
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const client = createRpcClient<tEchoApi>({
        socket: clientWire.socket,
        socketKey: 'json-only',
    })
    createRpcServer({
        socket: serverWire.socket,
        socketKey: 'json-only',
        object: createEchoApi(),
    })

    try {
        await client.ready()
        await delay(20)
        assert.ok(clientWire.records.binary.length > 0, 'client attempted the byte probe')
        clientWire.reset()
        serverWire.reset()
        assert.equal(await client.func.echo('json fallback'), 'json fallback')
        assert.ok(hasArrayPacket(clientWire.records, Pkt.CALL))
        assert.ok(hasArrayPacket(serverWire.records, Pkt.RESP))
        assert.equal(serverWire.records.binary.length, 0)
    } finally {
        client.close('JSON-only transport test complete', {socketAlive: false})
    }
}

async function testUnknownBinaryBundleVersionStaysRaw() {
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    createBinaryGate(rawClientSocket, 'version')
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const client = createRpcClient<tEchoApi>({
        socket: clientWire.socket,
        socketKey: 'unknown-binary-version',
    })
    createRpcServer({
        socket: serverWire.socket,
        socketKey: 'unknown-binary-version',
        object: createEchoApi(),
    })

    try {
        await client.ready()
        await delay(20)
        assert.ok(clientWire.records.binary.length > 0, 'client attempted a versioned probe')
        assert.equal(serverWire.records.binary.length, 0, 'server did not acknowledge an unknown bundle')
        clientWire.reset()
        serverWire.reset()
        assert.equal(await client.func.echo('version fallback'), 'version fallback')
        assert.ok(hasArrayPacket(clientWire.records, Pkt.CALL))
        assert.ok(hasArrayPacket(serverWire.records, Pkt.RESP))
    } finally {
        client.close('unknown binary version test complete', {socketAlive: false})
    }
}

async function testRawCallKeepsRawResponseAfterDelayedProbe() {
    let resolveSlow: ((value: string) => void) | undefined
    let slowStarted = false
    const api = {
        slow(value: string) {
            slowStarted = true
            return new Promise<string>(function waitForSlow(resolve) {
                resolveSlow = () => resolve(value)
            })
        },
        echo(value: string) {
            return value
        },
    }
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const gate = createBinaryGate(rawClientSocket, 'hold')
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const client = createRpcClient<typeof api>({
        socket: clientWire.socket,
        socketKey: 'delayed-probe',
    })
    createRpcServer({
        socket: serverWire.socket,
        socketKey: 'delayed-probe',
        object: api,
    })

    try {
        await client.ready()
        await waitFor('held binary probe', () => gate.held() > 0)
        clientWire.reset()
        serverWire.reset()

        const slowResult = client.func.slow('started raw')
        await waitFor('raw slow CALL reaches server', () => slowStarted)
        const slowCall = clientWire.records.arrays.find(packet => packet[0] == Pkt.CALL)
        assert.ok(slowCall, 'pre-negotiation CALL is raw')
        const slowRequestId = slowCall![1]

        gate.release()
        await waitFor('delayed probe acknowledgement', () => serverWire.records.binary.length > 0)
        await delay(5)
        clientWire.reset()
        serverWire.reset()

        assert.equal(await client.func.echo('binary active'), 'binary active')
        assert.ok(clientWire.records.binary.length > 0)
        assert.ok(serverWire.records.binary.length > 0)
        assert.equal(hasArrayPacket(clientWire.records, Pkt.CALL), false)

        serverWire.reset()
        resolveSlow?.('started raw')
        assert.equal(await slowResult, 'started raw')
        const rawResponse = serverWire.records.arrays.find(packet =>
            packet[0] == Pkt.RESP && packet[1] == slowRequestId)
        assert.ok(rawResponse, 'response keeps the raw channel captured by its CALL')
    } finally {
        client.close('delayed probe test complete', {socketAlive: false})
    }
}

async function testHotServerReplacementRenegotiates() {
    let slowStarted = false
    let resolveOldSlow: ((value: string) => void) | undefined
    const oldApi = {
        version: () => 1,
        slow() {
            slowStarted = true
            return new Promise<string>(function holdOldGeneration(resolve) {
                resolveOldSlow = resolve
            })
        },
    }
    const newApi = {
        version: () => 2,
        slow: () => Promise.resolve('new generation'),
    }
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const client = createRpcClient<typeof oldApi>({
        socket: clientWire.socket,
        socketKey: 'hot-server',
    })
    createRpcServer({
        socket: serverWire.socket,
        socketKey: 'hot-server',
        object: oldApi,
    })

    try {
        await client.ready()
        await waitFor('first binary generation', function firstGenerationActive() {
            return clientWire.records.binary.length > 0
                && serverWire.records.binary.length > 0
        })
        await delay(5)
        assert.equal(await client.func.version(), 1)
        const oldSlow = client.func.slow()
        let oldSlowState = 'pending'
        oldSlow.then(
            function oldSlowUnexpectedlyResolved() { oldSlowState = 'resolved' },
            function oldSlowRejectedOnReplacement() { oldSlowState = 'rejected' },
        )
        await waitFor('old generation slow call started', () => slowStarted)
        const firstGeneration = serverWire.records.arrays
            .find(packet => packet[0] == Pkt.CAPS && packet[2] == null)?.[3]
        assert.ok(Number.isSafeInteger(firstGeneration))

        clientWire.reset()
        serverWire.reset()
        const originalWarn = console.warn
        console.warn = function suppressExpectedReplacementWarning(...args: any[]) {
            if (!String(args[0]).includes('repeated initialization')) originalWarn(...args)
        }
        try {
            createRpcServer({
                socket: serverWire.socket,
                socketKey: 'hot-server',
                object: newApi,
            })
        } finally {
            console.warn = originalWarn
        }

        await waitFor('replacement binary generation', function replacementGenerationActive() {
            const generation = serverWire.records.arrays
                .find(packet => packet[0] == Pkt.CAPS && packet[2] == null)?.[3]
            return generation != undefined
                && generation != firstGeneration
                && clientWire.records.binary.length > 0
                && serverWire.records.binary.length > 0
        })
        await delay(5)
        await waitFor('old generation pending call rejected',
            () => oldSlowState == 'rejected')
        assert.equal(client.api.pending(), 0)
        resolveOldSlow?.('obsolete result')
        await delay(5)
        clientWire.reset()
        serverWire.reset()
        assert.equal(await client.func.version(), 2)
        assert.ok(clientWire.records.binary.length > 0)
        assert.ok(serverWire.records.binary.length > 0)
        assert.equal(hasArrayPacket(clientWire.records, Pkt.CALL), false)
        assert.equal(hasArrayPacket(serverWire.records, Pkt.RESP), false)
    } finally {
        client.close('hot replacement test complete', {socketAlive: false})
    }
}

async function testHotAutoListenReplacementStaysBinary() {
    const [emitOldTick, oldTicks] = createListenPair<number>()
    const [emitNewTick, newTicks] = createListenPair<number>()
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const client = createRpcClient<{ticks: typeof oldTicks}>({
        socket: clientWire.socket,
        socketKey: 'hot-auto-listen',
    })
    const oldServer = createRpcServerAuto({
        socket: serverWire.socket,
        socketKey: 'hot-auto-listen',
        object: {ticks: oldTicks},
    })
    let off: (() => void) | undefined

    try {
        await client.ready()
        const received: number[] = []
        off = (client.func.ticks as any).on(function receiveHotTick(value: number) {
            received.push(value)
        })
        await waitFor('old auto Listen subscription', () =>
            oldServer.api.subscriptions().some(item => item.consumers == 1))
        emitOldTick(1)
        await waitFor('old auto Listen tick', () => received.length == 1)

        clientWire.reset()
        serverWire.reset()
        const originalWarn = console.warn
        console.warn = function suppressExpectedAutoReplacementWarning(...args: any[]) {
            if (!String(args[0]).includes('repeated initialization')) originalWarn(...args)
        }
        let newServer: ReturnType<typeof createRpcServerAuto>
        try {
            newServer = createRpcServerAuto({
                socket: serverWire.socket,
                socketKey: 'hot-auto-listen',
                object: {ticks: newTicks},
            })
        } finally {
            console.warn = originalWarn
        }

        await waitFor('new auto Listen binary resubscription', () =>
            newServer.api.subscriptions().some(item => item.consumers == 1)
            && clientWire.records.binary.length > 0
            && serverWire.records.binary.length > 0)
        assert.equal(oldServer.api.subscriptions().length, 0)
        clientWire.reset()
        serverWire.reset()

        emitOldTick(99)
        emitNewTick(2)
        await waitFor('new auto Listen tick', () => received.length == 2)
        await delay(5)
        assert.deepEqual(received, [1, 2])
        assert.ok(serverWire.records.binary.length > 0)
        assert.equal(hasArrayPacket(serverWire.records, Pkt.CB), false)
        assert.equal(hasArrayPacket(serverWire.records, Pkt.CB_BATCH), false)
    } finally {
        off?.()
        client.close('hot auto Listen test complete', {socketAlive: false})
    }
}

async function testThreeTransportGenerationsResetWithoutDuplicateCallbacks() {
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const clientSocket = Object.assign(clientWire.socket, {
        disconnect() {},
    })
    const [emitTick, ticks] = createListenPair<number>()
    const [emitTransportDisconnect, transportDisconnect] = createListenPair<string>()
    const api = {
        ticks,
        ping(value: number) {
            return value
        },
        echo(value: unknown) {
            return value
        },
    }
    const server = createRpcServerAuto({
        socket: serverWire.socket,
        socketKey: 'generation',
        object: api,
        disconnectListen: transportDisconnect,
    })
    const hub = createRpcClientHub(
        function useLifecycleSocket() {
            return clientSocket
        },
        helper => ({main: helper<typeof api>('generation')}),
    )
    const initial = hub.connect(null)
    rawServerSocket.emit('connect', 1)
    await within('initial hub connection', initial)
    await waitFor('initial binary generation', function initialBinaryGeneration() {
        return clientWire.records.binary.length > 0
            && serverWire.records.binary.length > 0
    })
    assertSchemaBinaryFrames(clientWire.records, 'initial client generation')
    assertSchemaBinaryFrames(serverWire.records, 'initial server generation')

    async function exerciseFreshSchema(generation: number) {
        const key = 'generation_' + generation
        for (let repeat = 0; repeat < 3; repeat++) {
            const expected = {
                [key]: {
                    repeat,
                    price: generation + repeat + 0.25,
                    active: repeat % 2 == 0,
                },
            }
            assert.deepEqual(
                await hub.facade.main.func.echo(expected),
                expected,
                'generation ' + generation + ' learns and decodes a fresh schema',
            )
        }
    }
    await exerciseFreshSchema(0)
    assertSchemaBinaryFrames(clientWire.records, 'initial client application')
    assertSchemaBinaryFrames(serverWire.records, 'initial server application')

    const received: number[] = []
    ;(hub.facade.main.func.ticks as any).on(function receiveTick(value: number) {
        received.push(value)
    })
    await waitFor('initial stream subscription', function initialSubscription() {
        return server.api.subscriptions().some(item => item.consumers == 1)
    })
    emitTick(0)
    await waitFor('initial callback', () => received.length == 1)

    for (let generation = 1; generation <= 3; generation++) {
        clientWire.reset()
        serverWire.reset()
        rawServerSocket.emit('disconnect', 'generation-' + generation)
        emitTransportDisconnect('generation-' + generation)
        await waitFor('server subscription cleanup ' + generation, function subscriptionCleaned() {
            return server.api.subscriptions().length == 0
        })
        rawServerSocket.emit('connect', generation + 1)
        await waitFor('hub reconnect ' + generation, () => hub.connectCount() == generation + 1)
        await waitFor('binary renegotiation ' + generation, function binaryRenegotiated() {
            return clientWire.records.binary.length > 0
                && serverWire.records.binary.length > 0
        })
        assertSchemaBinaryFrames(clientWire.records, 'client generation ' + generation)
        assertSchemaBinaryFrames(serverWire.records, 'server generation ' + generation)
        await exerciseFreshSchema(generation)
        assertSchemaBinaryFrames(clientWire.records, 'client application generation ' + generation)
        assertSchemaBinaryFrames(serverWire.records, 'server application generation ' + generation)
        await waitFor('stream resubscription ' + generation, function streamResubscribed() {
            return server.api.subscriptions().some(item => item.consumers == 1)
        })
        assert.equal(await hub.facade.main.func.ping(generation), generation)
        emitTick(generation)
        await waitFor('one callback in generation ' + generation,
            () => received.length == generation + 1)
        await delay(10)
        assert.deepEqual(received, Array.from(
            {length: generation + 1},
            (_, index) => index,
        ))
    }

    hub.facade.main.close('generation test complete', {socketAlive: false})
    emitTransportDisconnect('test complete')
}

async function testAutoDetectRecognizesCapsThenBinary() {
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const detected: string[] = []
    const auto = createRpcServerAutoDetect({
        socket: serverWire.socket,
        socketKey: 'auto-binary',
        object: {
            add(left: number, right: number) {
                return left + right
            },
        },
        onProtocolDetect(protocol) {
            detected.push(protocol)
        },
    })
    const client = createRpcClient<{add: (left: number, right: number) => number}>({
        socket: clientWire.socket,
        socketKey: 'auto-binary',
    })

    try {
        await client.ready()
        await waitFor('auto-detect binary negotiation', function autoBinaryActive() {
            return clientWire.records.binary.length > 0
                && serverWire.records.binary.length > 0
        })
        assert.deepEqual(detected, ['v2'])
        assert.equal(auto.getProtocol(), 'v2')
        clientWire.reset()
        serverWire.reset()
        assert.equal(await client.func.add(20, 22), 42)
        assert.ok(clientWire.records.binary.length > 0)
        assert.ok(serverWire.records.binary.length > 0)
        assert.equal(hasArrayPacket(clientWire.records, Pkt.CALL), false)
    } finally {
        client.close('auto-detect binary test complete', {socketAlive: false})
        auto.dispose('test complete')
    }
}

async function testBinaryFalseNeverProbesOrUsesBytes() {
    for (const side of ['client', 'server'] as const) {
        const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
        const clientWire = observeSocket(rawClientSocket)
        const serverWire = observeSocket(rawServerSocket)
        const client = createRpcClient<tEchoApi>({
            socket: clientWire.socket,
            socketKey: 'binary-off-' + side,
            opt: side == 'client' ? {binary: false} : undefined,
        })
        createRpcServer({
            socket: serverWire.socket,
            socketKey: 'binary-off-' + side,
            object: createEchoApi(),
            opt: side == 'server' ? {binary: false} : undefined,
        })

        try {
            await client.ready()
            await delay(20)
            assert.equal(clientWire.records.binary.length, 0)
            assert.equal(serverWire.records.binary.length, 0)
            clientWire.reset()
            serverWire.reset()
            assert.equal(await client.func.echo(side), side)
            assert.ok(hasArrayPacket(clientWire.records, Pkt.CALL))
            assert.ok(hasArrayPacket(serverWire.records, Pkt.RESP))
        } finally {
            client.close('binary false test complete', {socketAlive: false})
        }
    }
}

async function testBinarySessionAdmissionIsBoundedAndOwned() {
    const [clientSocket, serverSocket] = createInProcSocketPair()
    const received: any[] = []
    const invalid: any[] = []
    clientSocket.on('session-admission', function receiveSessionControl(message) {
        received.push(message)
    })
    createRpcServer({
        socket: serverSocket,
        socketKey: 'session-admission',
        object: createEchoApi(),
        hooks: {
            onInvalid(context) {
                invalid.push(context)
            },
        },
    })
    await waitFor('binary session generation challenge', function challengeArrived() {
        return received.some(message =>
            Array.isArray(message)
            && message[0] == Pkt.CAPS
            && message[2] == null
            && Number.isSafeInteger(message[3]))
    })
    const generation = received.find(message =>
        Array.isArray(message)
        && message[0] == Pkt.CAPS
        && message[2] == null)![3]
    const caps = Caps.COMPACT | Caps.CB_BATCH | Caps.BINARY

    for (let index = 1; index <= 16; index++) {
        clientSocket.emit('session-admission', [
            Pkt.CAPS,
            caps,
            index,
            generation,
            10_000 + index,
        ])
    }
    await waitFor('sixteen admitted binary sessions', function sessionsAdmitted() {
        return received.filter(message =>
            Array.isArray(message)
            && message[0] == Pkt.CAPS
            && Number.isSafeInteger(message[2])).length >= 16
    })

    clientSocket.emit('session-admission', [
        Pkt.CAPS,
        caps,
        17,
        generation,
        10_017,
    ])
    await waitFor('binary session admission limit', () =>
        invalid.some(context => context.reason == 'rate_limit'))

    clientSocket.emit('session-admission', [
        Pkt.CAPS,
        caps,
        1,
        generation,
        99_999,
    ])
    await waitFor('binary session owner collision', () =>
        invalid.some(context =>
            context.reason == 'invalid_payload'
            && String(context.error).includes('another client')))
}

async function testSynchronousBinaryCallbackCanReenterRpc() {
    const callbackValues = [
        {id: 'A', payload: 'a'.repeat(24 * 1024)},
        {id: 'B', payload: 'b'.repeat(24 * 1024)},
        {id: 'C', payload: 'c'.repeat(24 * 1024)},
    ]
    const nestedArguments: {id: string; length: number}[] = []
    const api = {
        echoNested(value: {id: string; length: number}) {
            nestedArguments.push(value)
            return {id: value.id, length: value.length, seen: true}
        },
        callbackBurst(callback: (value: {id: string; payload: string}) => void) {
            for (const value of callbackValues) callback(value)
            rpcEndCallback(callback)
            return 'outer'
        },
    }
    const [rawClientSocket, rawServerSocket] = createSyncByteSafeSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    createRpcServer({
        socket: serverWire.socket,
        socketKey: 'sync-reentrant',
        object: api,
    })
    const client = createRpcClient<typeof api>({
        socket: clientWire.socket,
        socketKey: 'sync-reentrant',
    })

    try {
        await client.ready()
        assert.deepEqual(
            await client.func.echoNested({id: 'probe-ready', length: 0}),
            {id: 'probe-ready', length: 0, seen: true},
        )
        assert.ok(clientWire.records.binary.length > 0)
        assert.ok(serverWire.records.binary.length > 0)
        nestedArguments.length = 0
        clientWire.reset()
        serverWire.reset()

        const callbackOrder: {id: string; payload: string}[] = []
        const nested: Promise<{id: string; length: number; seen: boolean}>[] = []
        const outer = client.func.callbackBurst(function receiveAndCallAgain(value) {
            callbackOrder.push(value)
            nested.push(client.func.echoNested({
                id: value.id,
                length: value.payload.length,
            }))
        })
        assert.equal(await outer, 'outer')
        assert.deepEqual(await Promise.all(nested), [
            {id: 'A', length: 24 * 1024, seen: true},
            {id: 'B', length: 24 * 1024, seen: true},
            {id: 'C', length: 24 * 1024, seen: true},
        ])
        assert.deepEqual(callbackOrder, callbackValues)
        assert.deepEqual(nestedArguments, [
            {id: 'A', length: 24 * 1024},
            {id: 'B', length: 24 * 1024},
            {id: 'C', length: 24 * 1024},
        ])
        assert.equal(client.api.callbacks(), 0)
        assert.equal(hasArrayPacket(clientWire.records, Pkt.CALL), false)
        assert.equal(hasArrayPacket(serverWire.records, Pkt.RESP), false)
        assert.ok(clientWire.records.binary.length > 0)
        assert.ok(serverWire.records.binary.length > 0)
    } finally {
        client.close('synchronous binary callback test complete', {socketAlive: false})
    }
}

async function testSynchronousTransportThrowDropsNestedQueueSafely() {
    const api = {
        echo(value: string) {
            return value
        },
        outer(callback: (value: string) => void) {
            callback('nested')
            return 'outer'
        },
    }
    const [rawClientSocket, serverSocket] = createSyncByteSafeSocketPair()
    const originalEmit = rawClientSocket.emit.bind(rawClientSocket)
    let throwAfterNextBinary = false
    rawClientSocket.emit = function throwAfterDelivery(event, data) {
        originalEmit(event, data)
        if (throwAfterNextBinary && wireBytes(data)) {
            throwAfterNextBinary = false
            throw new Error('transport threw after delivery')
        }
    }
    createRpcServer({
        socket: serverSocket,
        socketKey: 'sync-throw',
        object: api,
        opt: {callbackBatch: false},
    })
    const client = createRpcClient<typeof api>({
        socket: rawClientSocket,
        socketKey: 'sync-throw',
        opt: {callbackBatch: false},
    })

    try {
        await client.ready()
        assert.equal(await client.func.echo('ready'), 'ready')
        const nested: Promise<string>[] = []
        throwAfterNextBinary = true
        const outer = client.func.outer(function reenterBeforeTransportThrow(value) {
            nested.push(client.func.echo(value))
        })
        const outerOutcome = await within('outer transport failure', outer.then(
            value => ({state: 'resolved', value}),
            error => ({state: 'rejected', value: error}),
        ))
        assert.equal(outerOutcome.state, 'rejected')
        assert.equal(nested.length, 1)
        const nestedOutcome = await within('nested queue rejection', nested[0].then(
            value => ({state: 'resolved', value}),
            error => ({state: 'rejected', value: error}),
        ))
        assert.equal(nestedOutcome.state, 'rejected')
        assert.equal(client.api.pending(), 0)
        assert.equal(client.api.callbacks(), 0)
    } finally {
        client.close('sync throw test complete', {socketAlive: false})
    }
}

async function testMalformedBinaryResponseResetsGeneration() {
    for (const mode of ['truncate', 'magic'] as const) {
        const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
        const originalServerEmit = rawServerSocket.emit.bind(rawServerSocket)
        let corruptNextBinary = false
        rawServerSocket.emit = function corruptOneBinaryResponse(event, data) {
            const bytes = wireBytes(data)
            if (corruptNextBinary && bytes) {
                corruptNextBinary = false
                if (mode == 'truncate') {
                    originalServerEmit(event, bytes.slice(0, bytes.byteLength - 1))
                    return
                }
                const corrupted = bytes.slice()
                corrupted[0] ^= 0xff
                originalServerEmit(event, corrupted)
                return
            }
            originalServerEmit(event, data)
        }
        const clientWire = observeSocket(rawClientSocket)
        const serverWire = observeSocket(rawServerSocket)
        const socketKey = 'malformed-reset-' + mode
        const client = createRpcClient<tEchoApi>({
            socket: clientWire.socket,
            socketKey,
        })
        createRpcServer({
            socket: serverWire.socket,
            socketKey,
            object: createEchoApi(),
        })

        try {
            await client.ready()
            await waitFor('initial malformed-test binary generation ' + mode, () =>
                clientWire.records.binary.length > 0
                && serverWire.records.binary.length > 0)
            corruptNextBinary = true
            const damaged = await within(
                'damaged response rejection ' + mode,
                client.func.echo('damaged').then(
                    value => ({state: 'resolved', value}),
                    error => ({state: 'rejected', value: error}),
                ),
            )
            assert.equal(damaged.state, 'rejected')
            assert.equal(client.api.pending(), 0)
            await waitFor('binary generation renegotiated after ' + mode, () =>
                clientWire.records.binary.length >= 2
                && serverWire.records.binary.length >= 2)
            assert.equal(await client.func.echo('recovered-' + mode), 'recovered-' + mode)
            assert.equal(client.api.pending(), 0)
        } finally {
            client.close('malformed reset test complete', {socketAlive: false})
        }
    }
}

async function testMalformedBinaryRequestResetsGeneration() {
    for (const mode of ['truncate', 'magic'] as const) {
        const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
        const originalClientEmit = rawClientSocket.emit.bind(rawClientSocket)
        let corruptNextBinary = false
        rawClientSocket.emit = function corruptOneBinaryRequest(event, data) {
            const bytes = wireBytes(data)
            if (corruptNextBinary && bytes) {
                corruptNextBinary = false
                if (mode == 'truncate') {
                    originalClientEmit(event, bytes.slice(0, bytes.byteLength - 1))
                    return
                }
                const corrupted = bytes.slice()
                corrupted[0] ^= 0xff
                originalClientEmit(event, corrupted)
                return
            }
            originalClientEmit(event, data)
        }
        const clientWire = observeSocket(rawClientSocket)
        const serverWire = observeSocket(rawServerSocket)
        const socketKey = 'malformed-request-reset-' + mode
        const client = createRpcClient<tEchoApi>({
            socket: clientWire.socket,
            socketKey,
        })
        createRpcServer({
            socket: serverWire.socket,
            socketKey,
            object: createEchoApi(),
        })

        try {
            await client.ready()
            await waitFor('initial request-reset binary generation ' + mode, () =>
                clientWire.records.binary.length > 0
                && serverWire.records.binary.length > 0)
            corruptNextBinary = true
            const damaged = await within(
                'damaged request rejection ' + mode,
                client.func.echo({shape: 'damaged'}).then(
                    value => ({state: 'resolved', value}),
                    error => ({state: 'rejected', value: error}),
                ),
            )
            assert.equal(damaged.state, 'rejected')
            assert.equal(client.api.pending(), 0)
            await waitFor('request generation renegotiated after ' + mode, () =>
                clientWire.records.binary.length >= 2
                && serverWire.records.binary.length >= 2)
            assert.deepEqual(
                await client.func.echo({shape: 'recovered-' + mode}),
                {shape: 'recovered-' + mode},
            )
            assert.equal(client.api.pending(), 0)
        } finally {
            client.close('malformed request reset test complete', {socketAlive: false})
        }
    }
}

async function testPreCorrelationCallbackBatchIsolation() {
    const api = {
        burst(callback: (value: number) => void) {
            callback(1)
            callback(2)
            return 'ok'
        },
    }
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const baseServerEmit = rawServerSocket.emit.bind(rawServerSocket)
    const heldChallenges: {event: string, data: any}[] = []
    let holdChallenges = true
    rawServerSocket.emit = function holdCorrelatedCapsChallenge(event, data) {
        if (holdChallenges
            && Array.isArray(data)
            && data[0] == Pkt.CAPS
            && data[2] == null
            && Number.isSafeInteger(data[3])) {
            heldChallenges.push({event, data})
            return
        }
        baseServerEmit(event, data)
    }
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const directClient = createRpcClient<typeof api>({
        socket: clientWire.socket,
        socketKey: 'pre-correlation-batch',
        opt: {binary: false, callbackBatch: false},
    })
    const batchClient = createRpcClient<typeof api>({
        socket: clientWire.socket,
        socketKey: 'pre-correlation-batch',
        opt: {binary: false, callbackBatch: true},
    })
    createRpcServer({
        socket: serverWire.socket,
        socketKey: 'pre-correlation-batch',
        object: api,
        opt: {binary: false},
    })

    function releaseChallenges() {
        if (!holdChallenges) return
        holdChallenges = false
        for (const packet of heldChallenges.splice(0)) {
            baseServerEmit(packet.event, packet.data)
        }
    }

    try {
        await Promise.all([directClient.ready(), batchClient.ready()])
        await waitFor('anonymous capability advertisements', () =>
            clientWire.records.arrays.filter(packet =>
                packet[0] == Pkt.CAPS
                && packet[2] == undefined).length >= 2)
        assert.ok(heldChallenges.length > 0)
        await delay(5)
        clientWire.reset()
        serverWire.reset()

        const directValues: number[] = []
        assert.equal(
            await directClient.func.burst(function receiveDirectValue(value) {
                directValues.push(value)
            }),
            'ok',
        )
        assert.deepEqual(directValues, [1, 2])
        assert.equal(hasArrayPacket(serverWire.records, Pkt.CB_BATCH), false)
        assert.equal(
            serverWire.records.arrays.filter(packet => packet[0] == Pkt.CB).length,
            2,
        )

        clientWire.reset()
        releaseChallenges()
        await waitFor('both correlated raw sessions', () =>
            clientWire.records.arrays.filter(packet =>
                packet[0] == Pkt.CAPS
                && Number.isSafeInteger(packet[2])
                && Number.isSafeInteger(packet[4])).length >= 2)
        await delay(5)
        serverWire.reset()

        const batchValues: number[] = []
        assert.equal(
            await batchClient.func.burst(function receiveBatchValue(value) {
                batchValues.push(value)
            }),
            'ok',
        )
        assert.deepEqual(batchValues, [1, 2])
        assert.equal(hasArrayPacket(serverWire.records, Pkt.CB_BATCH), true)
    } finally {
        releaseChallenges()
        directClient.close('pre-correlation batch test complete', {socketAlive: false})
        batchClient.close('pre-correlation batch test complete', {socketAlive: false})
    }
}

export async function runRpcBinaryCompatTests() {
    let failures = 0
    const tests = [
        ['pre-correlation callback batching stays isolated per client',
            testPreCorrelationCallbackBatchIsolation],
        ['new client works with manual old servers (no CAPS / caps 1 / caps 3)',
            testNewClientWithManualOldServer],
        ['manual old clients work with a new server (no CAPS / caps 1 / caps 3)',
            testManualOldClientWithNewServer],
        ['JSON-only transport keeps application packets raw',
            testJsonOnlyTransportStaysRaw],
        ['unknown binary bundle version keeps application packets raw',
            testUnknownBinaryBundleVersionStaysRaw],
        ['raw CALL keeps a raw response after delayed binary activation',
            testRawCallKeepsRawResponseAfterDelayedProbe],
        ['hot createRpcServer replacement renegotiates binary',
            testHotServerReplacementRenegotiates],
        ['hot createRpcServerAuto Listen replacement stays binary',
            testHotAutoListenReplacementStaysBinary],
        ['three transport generations reset without duplicate callbacks',
            testThreeTransportGenerationsResetWithoutDuplicateCallbacks],
        ['auto-detect recognizes CAPS and continues in binary',
            testAutoDetectRecognizesCapsThenBinary],
        ['binary:false never probes or uses byte frames',
            testBinaryFalseNeverProbesOrUsesBytes],
        ['binary sessions are bounded and one-to-one owned',
            testBinarySessionAdmissionIsBoundedAndOwned],
        ['synchronous binary callback can reenter RPC',
            testSynchronousBinaryCallbackCanReenterRpc],
        ['synchronous transport throw rejects nested binary queue',
            testSynchronousTransportThrowDropsNestedQueueSafely],
        ['malformed binary response rejects pending and renegotiates',
            testMalformedBinaryResponseResetsGeneration],
        ['malformed binary request rejects pending and renegotiates',
            testMalformedBinaryRequestResetsGeneration],
    ] as const

    console.log('\n--- universal binary RPC compatibility/lifecycle ---')
    for (const [name, run] of tests) {
        try {
            await run()
            console.log('  OK  ' + name)
        } catch (error) {
            failures++
            console.error('  FAIL ' + name, error)
        }
    }
    console.log(failures == 0
        ? 'RPC binary compatibility/lifecycle tests: OK'
        : 'RPC binary compatibility/lifecycle tests: ' + failures + ' FAILED')
    return failures
}

if (require.main === module) {
    runRpcBinaryCompatTests().then(function finish(failures) {
        process.exitCode = failures == 0 ? 0 : 1
    })
}
