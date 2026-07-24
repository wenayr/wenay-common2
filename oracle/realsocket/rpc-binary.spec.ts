// ============================================================
// Universal binary RPC over a genuine Socket.IO WebSocket.
//
// The trace observes values at both Socket.IO emit and receive boundaries.
// The binary payload layout stays private; this acceptance test asserts the
// negotiated transport kind and exact public values.
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {Pkt} from '../../src/Common/rcp/rpc-protocol'

const PORT = 4140
const SOCKET_KEY = 'rpc-binary'

type tWireSide = {
    arrays: any[][]
    binary: number[]
}

function createWireSide(): tWireSide {
    return {arrays: [], binary: []}
}

function activeBytes(value: ArrayBuffer | ArrayBufferView) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function recordWire(side: tWireSide, data: unknown) {
    if (Array.isArray(data)) {
        side.arrays.push(data)
        return
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        side.binary.push(activeBytes(data).byteLength)
    }
}

function observeSocket(socket: any, socketKey = SOCKET_KEY) {
    const sent = createWireSide()
    const received = createWireSide()
    const originalEmit = socket.emit.bind(socket)

    socket.emit = function observeSocketEmit(event: string, data: unknown, ...rest: unknown[]) {
        if (event == socketKey) recordWire(sent, data)
        return originalEmit(event, data, ...rest)
    }

    function observeSocketReceive(event: string, data: unknown) {
        if (event == socketKey) recordWire(received, data)
    }
    if (typeof socket.prependAny == 'function') socket.prependAny(observeSocketReceive)
    else if (typeof socket.onAny == 'function') socket.onAny(observeSocketReceive)

    function reset() {
        sent.arrays.length = 0
        sent.binary.length = 0
        received.arrays.length = 0
        received.binary.length = 0
    }

    function close() {
        socket.emit = originalEmit
        socket.offAny?.(observeSocketReceive)
    }

    return {sent, received, reset, close}
}

function hasPacket(side: tWireSide, opcode: number) {
    return side.arrays.some(packet => packet[0] == opcode)
}

function createRichValue(label = 'request') {
    const wordsBacking = new Uint8Array(10)
    const words = new Uint16Array(wordsBacking.buffer, 2, 3)
    words.set([0x1234, 0xabcd, 0x0102])
    return {
        label,
        enabled: false,
        missing: undefined,
        negativeZero: -0,
        big: 9_007_199_254_740_993n,
        at: new Date('2026-07-23T12:34:56.789Z'),
        matcher: /BTC(?:USDT)?/gi,
        lookup: new Map<unknown, unknown>([
            ['kind', 'quote'],
            [7, false],
        ]),
        tags: new Set<unknown>(['live', 5, true]),
        bytes: new Uint8Array([0, 1, 127, 255]),
        words,
        nested: [null, {text: '\u0442\u0435\u043a\u0441\u0442', ok: true}],
    }
}

function isRichValue(value: any, label: string) {
    return value?.label == label
        && value.enabled == false
        && Object.prototype.hasOwnProperty.call(value, 'missing')
        && value.missing == undefined
        // msgpackr intentionally normalizes scalar -0 to ordinary zero.
        && (Object.is(value.negativeZero, -0) || Object.is(value.negativeZero, 0))
        && value.big == 9_007_199_254_740_993n
        && value.at instanceof Date
        && value.at.toISOString() == '2026-07-23T12:34:56.789Z'
        && value.matcher instanceof RegExp
        && value.matcher.source == 'BTC(?:USDT)?'
        && value.matcher.flags == 'gi'
        && value.lookup instanceof Map
        && value.lookup.get('kind') == 'quote'
        && value.lookup.get(7) == false
        && value.tags instanceof Set
        && value.tags.has('live')
        && value.tags.has(5)
        && value.tags.has(true)
        && value.bytes instanceof Uint8Array
        && [...value.bytes].join(',') == '0,1,127,255'
        && value.words instanceof Uint16Array
        && [...value.words].join(',') == '4660,43981,258'
        && value.nested?.[0] == null
        && value.nested?.[1]?.text == '\u0442\u0435\u043a\u0441\u0442'
        && value.nested?.[1]?.ok == true
}

function createPrincipal(role: 'user' | 'admin') {
    function echo(value: unknown) {
        return value
    }

    function callbackBurst(callback: (value: unknown) => void) {
        callback('first')
        callback(42)
        callback(false)
        callback(createRichValue('callback'))
        return 4
    }

    function fail(data: unknown) {
        const error: any = new Error('binary failure')
        error.name = 'BinaryAcceptanceError'
        error.code = 'E_BINARY_ACCEPTANCE'
        error.data = data
        throw error
    }

    const common = {
        echo,
        callbackBurst,
        fail,
        who: () => role,
    }
    if (role == 'user') return common
    return {
        ...common,
        adminOnly(value: unknown) {
            return {role, value}
        },
    }
}

async function waitForBinaryApplication(
    api: any,
    clientWire: ReturnType<typeof observeSocket>,
    serverWire: ReturnType<typeof observeSocket>,
) {
    for (let attempt = 0; attempt < 20; attempt++) {
        clientWire.reset()
        serverWire.reset()
        const marker = 'warm-' + attempt
        if (await api.echo(marker) != marker) throw new Error('binary warm-up response changed')
        await delay(15)
        if (clientWire.sent.binary.length > 0
            && serverWire.received.binary.length > 0
            && serverWire.sent.binary.length > 0
            && clientWire.received.binary.length > 0) {
            clientWire.reset()
            serverWire.reset()
            return
        }
        await delay(20)
    }
    throw new Error('binary application packets were not negotiated')
}

async function runBinaryScenario(check: ReturnType<typeof makeChecker>['check']) {
    let serverWire: ReturnType<typeof observeSocket> | undefined
    const server = await startRealServer({
        port: PORT,
        socketKey: SOCKET_KEY,
        makeObject: () => ({}),
        serverOpts: {
            opt: {binary: true},
            auth: {
                gate: true,
                resolveAuth(token: unknown) {
                    if (token != 'user' && token != 'admin') throw new Error('bad token')
                    return {
                        object: createPrincipal(token),
                        ack: {ok: true, role: token},
                    }
                },
            },
        },
        onServer(_api, socket) {
            serverWire = observeSocket(socket)
        },
    })
    const client = await startRealClient({
        port: PORT,
        token: 'user',
        socketKey: SOCKET_KEY,
        opt: {binary: true},
    })
    const clientWire = observeSocket(client.hub.socket)

    try {
        if (!serverWire) throw new Error('server socket trace was not installed')
        await check('auth: initial principal is user',
            async () => (await client.client.auth())?.role, 'user')
        await waitForBinaryApplication(client.api, clientWire, serverWire)

        // ===== CALL + RESP: exact rich request and response are physical bytes =====
        const rich = await client.api.echo(createRichValue())
        await check('new/new: rich CALL + RESP round-trip exactly',
            () => isRichValue(rich, 'request'), true)
        await check('new/new: client emitted one binary CALL',
            () => clientWire.sent.binary.length, 1)
        await check('new/new: server received one binary CALL',
            () => serverWire!.received.binary.length, 1)
        await check('new/new: server emitted one binary RESP',
            () => serverWire!.sent.binary.length, 1)
        await check('new/new: client received one binary RESP',
            () => clientWire.received.binary.length, 1)
        await check('new/new: no array CALL/RESP fallback',
            () => hasPacket(clientWire.sent, Pkt.CALL)
                || hasPacket(serverWire!.sent, Pkt.RESP), false)

        // ===== Heterogeneous callbacks: one physical batch plus one RESP =====
        clientWire.reset()
        serverWire.reset()
        const callbackValues: unknown[] = []
        const count = await client.api.callbackBurst(function receiveMixedValue(value: unknown) {
            callbackValues.push(value)
        })
        await check('callback: method result survives batching', () => count, 4)
        await check('callback: string, number and boolean stay distinct',
            () => [
                callbackValues[0],
                callbackValues[1],
                callbackValues[2],
                typeof callbackValues[0],
                typeof callbackValues[1],
                typeof callbackValues[2],
            ],
            ['first', 42, false, 'string', 'number', 'boolean'])
        await check('callback: rich/typed value stays exact',
            () => isRichValue(callbackValues[3], 'callback'), true)
        await check('callback: one physical batch plus one response',
            () => [serverWire!.sent.binary.length, clientWire.received.binary.length],
            [2, 2])
        await check('callback: application packets do not fall back to arrays',
            () => hasPacket(serverWire!.sent, Pkt.CB)
                || hasPacket(serverWire!.sent, Pkt.CB_BATCH)
                || hasPacket(serverWire!.sent, Pkt.RESP), false)

        // ===== Error payload remains an error and keeps binary rich data =====
        clientWire.reset()
        serverWire.reset()
        const error = await client.api.fail(createRichValue('error')).then(
            () => null,
            (value: unknown) => value,
        )
        await check('error: name/message/code are preserved',
            () => [error?.name, error?.message, error?.code],
            ['BinaryAcceptanceError', 'binary failure', 'E_BINARY_ACCEPTANCE'])
        await check('error: rich error data stays exact',
            () => isRichValue(error?.data, 'error'), true)
        await check('error: CALL and rejected RESP are binary both ways',
            () => [
                clientWire.sent.binary.length,
                serverWire!.received.binary.length,
                serverWire!.sent.binary.length,
                clientWire.received.binary.length,
            ],
            [1, 1, 1, 1])

        // ===== Soft reauth changes facade without losing binary mode =====
        const acknowledgements = await client.hub.reauth('admin')
        await check('reauth: admin principal acknowledged',
            () => acknowledgements?.[0]?.role, 'admin')
        await waitForBinaryApplication(client.api, clientWire, serverWire)
        const admin = await client.api.adminOnly(createRichValue('admin'))
        await check('reauth: new facade returns exact rich value',
            () => admin?.role == 'admin' && isRichValue(admin?.value, 'admin'), true)
        await check('reauth: post-reauth CALL + RESP remain binary',
            () => [
                clientWire.sent.binary.length,
                serverWire.received.binary.length,
                serverWire.sent.binary.length,
                clientWire.received.binary.length,
            ],
            [1, 1, 1, 1])
    } finally {
        clientWire.close()
        serverWire?.close()
        client.close()
        await server.close()
    }
}

async function runOptOutScenario(check: ReturnType<typeof makeChecker>['check']) {
    let serverWire: ReturnType<typeof observeSocket> | undefined
    const server = await startRealServer({
        port: PORT + 1,
        socketKey: SOCKET_KEY,
        makeObject: () => ({echo: (value: unknown) => value}),
        serverOpts: {opt: {binary: false}},
        onServer(_api, socket) {
            serverWire = observeSocket(socket)
        },
    })
    const client = await startRealClient({
        port: PORT + 1,
        socketKey: SOCKET_KEY,
    })
    const clientWire = observeSocket(client.hub.socket)

    try {
        if (!serverWire) throw new Error('server socket trace was not installed')
        await delay(60)
        clientWire.reset()
        serverWire.reset()
        const value = await client.api.echo({mode: 'array', enabled: false})
        await check('opt-out: ordinary value still round-trips',
            () => value, {mode: 'array', enabled: false})
        await check('opt-out: one-sided binary:false keeps CALL + RESP arrays',
            () => [
                hasPacket(clientWire.sent, Pkt.CALL),
                hasPacket(serverWire!.received, Pkt.CALL),
                hasPacket(serverWire!.sent, Pkt.RESP),
                hasPacket(clientWire.received, Pkt.RESP),
            ],
            [true, true, true, true])
        await check('opt-out: no binary application frame is emitted',
            () => clientWire.sent.binary.length + serverWire.sent.binary.length, 0)
    } finally {
        clientWire.close()
        serverWire?.close()
        client.close()
        await server.close()
    }
}

async function main() {
    const {check, done} = makeChecker('rpc-binary')
    const watchdog = setTimeout(function binarySocketWatchdog() {
        console.error('WATCHDOG timeout')
        process.exit(3)
    }, 60000)

    try {
        await runBinaryScenario(check)
        await runOptOutScenario(check)
    } finally {
        clearTimeout(watchdog)
    }
    process.exit(done() == 0 ? 0 : 1)
}

main().catch(function reportBinarySocketFailure(error) {
    console.error(error)
    process.exit(2)
})
