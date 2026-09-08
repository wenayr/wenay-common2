import * as assert from 'node:assert/strict'
import {createRpcServer} from './rpc-server'
import {createRpcServerAuto} from './rpc-server-auto'
import {createRpcClient} from './rpc-client'
import {createInProcSocketPair} from './rpc-inproc'
import {Pkt, type SocketTmpl} from './rpc-protocol'
import {listen} from '../events/Listen'
import type {DeepSocketListen} from './listen-deep'

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function createPacketResource() {
    const packets: any[] = []
    let receive: (packet: any) => void = function beforeAttach() {}
    const socket = {
        on(_event: string, callback: (packet: any) => void) { receive = callback },
        emit(_event: string, packet: any) { packets.push(packet) },
    } satisfies SocketTmpl
    return {socket, packets, receive: (packet: any) => Promise.resolve(receive(packet))}
}

async function testRejectedRenewalKeepsDeadline(gate: boolean, withObject: boolean) {
    const [clientSocket, serverSocket] = createInProcSocketPair()
    const [emit, stream] = listen<number>()
    const principal = {who: () => 'original', stream}
    const {control, api} = createRpcServerAuto({
        socket: serverSocket, socketKey: 'rpc', object: {},
        auth: {gate, resolveAuth: () => ({ack: {ok: false}, ...(withObject ? {object: {who: () => 'refused'}, expiresAt: Infinity} : {})})},
    })
    const client = createRpcClient<typeof principal>({socket: clientSocket, socketKey: 'rpc'})
    await client.initStrict()
    control.grant({object: principal, expiresAt: Date.now() + 180, renewBeforeMs: 0})
    await delay(0)
    const got: number[] = []
    const sub = (client.func as unknown as DeepSocketListen<typeof principal>).stream.on(function receive(value) { got.push(value) })
    await delay(0)
    try {
        const ack = await client.reauth('refused')
        assert.equal(ack.ok, false)
        assert.equal(await client.func.who(), 'original', 'refusal must preserve the previous principal and admission')
        emit(1)
        await delay(0)
        assert.deepEqual(got, [1], 'refusal must preserve the existing subscription')
        await delay(220)
        emit(2)
        await delay(0)
        assert.deepEqual(got, [1], 'the original deadline must still cut its subscription')
        assert.deepEqual(api.subscriptions(), [])
        assert.equal(await Promise.race([sub.then(() => 'ended'), delay(40).then(() => 'hung')]), 'ended')
        assert.equal((await client.auth()).state, 'expired')
    } finally {
        sub()
        client.dispose()
        control.revoke()
    }
}

async function testInitialRefusal(gate: boolean) {
    const resource = createPacketResource()
    createRpcServer({socket: resource.socket, socketKey: 'rpc', object: {public: () => 'public'},
        auth: {gate, resolveAuth: () => ({object: {secret: () => 'secret'}, ack: {ok: false}})}})
    await resource.receive([Pkt.HELLO, 'refused', 1])
    await resource.receive([Pkt.CALL, 1, ['public'], [], true])
    const response = resource.packets.find(packet => packet[0] == Pkt.RESP && packet[1] == 1)
    if (gate) assert.equal(response[3].code, 'E_UNAUTHORIZED')
    else assert.equal(response[2], 'public')
    const map = resource.packets.findLast(packet => packet[0] == Pkt.MAP)
    assert.deepEqual(map[2], {public: 'func'})
}

async function testPendingAdmission(change: 'revoke' | 'replace' | 'detach' | 'expire' | 'refuse', pipe: boolean) {
    const resource = createPacketResource()
    let release!: (value: boolean) => void
    const admission = new Promise<boolean>(resolve => { release = resolve })
    let calls = 0
    const {control} = createRpcServer({socket: resource.socket, socketKey: 'rpc', object: {},
        auth: {gate: true, resolveAuth: () => ({})},
        hooks: {onRequest: function waitAdmission() { return admission }}})
    control.grant({object: {protected: () => ++calls}, ...(change == 'expire' ? {expiresAt: Date.now() + 20} : {})})
    const pending = resource.receive([pipe ? Pkt.PIPE : Pkt.CALL, 1, ['protected'], pipe ? [{type: 'call', args: []}] : [], true])
    if (change == 'revoke') control.revoke()
    else if (change == 'replace') control.grant({object: {public: () => 'public'}})
    else if (change == 'expire') await delay(50)
    else if (change == 'refuse') control.grant({ack: {ok: false}, object: {}})
    else createRpcServer({socket: resource.socket, socketKey: 'rpc', object: {}})
    release(true)
    await pending
    assert.equal(calls, change == 'refuse' ? 1 : 0, `${change}: admission belongs to the current principal`)
    if (change != 'detach') {
        const response = resource.packets.findLast(packet => packet[0] == Pkt.RESP)
        if (change == 'refuse') assert.equal(response[2], 1)
        else assert.equal(response[3].code, 'E_UNAUTHORIZED')
    }
}

async function testDebugRedactsHello() {
    const resource = createPacketResource()
    const logs: unknown[][] = []
    const originalLog = console.log
    let presented: unknown
    console.log = function capture(...args) { logs.push(args) }
    try {
        createRpcServer({socket: resource.socket, socketKey: 'rpc', object: {}, debug: true,
            auth: {resolveAuth: function resolveAuth(token) { presented = token; return {} }}})
        const token = {secret: 'private-token-value'}
        await resource.receive([Pkt.HELLO, token, 23])
        await delay(0)
        assert.deepEqual(presented, token, 'redaction must not alter the token delivered to the resolver')
        assert.equal(JSON.stringify(logs).includes('private-token-value'), false)
        assert.equal(JSON.stringify(logs).includes('[redacted]'), true)
        assert.equal(JSON.stringify(logs).includes('23'), true, 'correlation stays useful in debug output')
    } finally { console.log = originalLog }
}

export async function runRpcAuthBoundaryTests() {
    const failures: unknown[] = []
    const cases = [
        ...[false, true].flatMap(gate => [false, true].map(withObject => () => testRejectedRenewalKeepsDeadline(gate, withObject))),
        () => testInitialRefusal(true),
        () => testInitialRefusal(false),
        ...(['revoke', 'replace', 'detach', 'expire', 'refuse'] as const).flatMap(change => [false, true].map(pipe => () => testPendingAdmission(change, pipe))),
        testDebugRedactsHello,
    ]
    for (const run of cases) {
        try { await run() }
        catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'RPC auth boundary regressions')
    console.log('RPC auth boundary tests: OK')
}

if (require.main == module) {
    runRpcAuthBoundaryTests().catch(function fail(error) {
        console.error(error)
        process.exitCode = 1
    })
}
