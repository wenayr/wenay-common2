// ============================================================
// Batched Store Replay over real Socket.IO: sends, bytes, convergence.
// ============================================================

import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {isDeepStrictEqual} from 'node:util'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen} from '../src/Common/events/Listen'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import {createStore} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {exposeStoreReplay, StoreReplayRemote, syncStoreReplay} from '../src/Common/Observe/store-replay'
import {rpcResultWireMetrics} from '../src/Common/rcp/rpc-wire-size'

let fails = 0
function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Quotes = Record<string, {c: number, t: number}>
type MeasureWorkload = {
    initialRecords?: number
    updateRecords?: number
    reconnect?: boolean
    rich?: boolean
}
type WireStats = {
    armed: boolean
    sends: number
    bytes: number
    binaryAttachments: number
    v5Frames: number
    rpcBinaryFrames: number
    schemaBinaryFrames: number
    v5Calls: number
    v6Calls: number
    v7Calls: number
}

function binaryLeaves(value: unknown, leaves: Uint8Array[] = []) {
    if (value instanceof ArrayBuffer) {
        leaves.push(new Uint8Array(value))
        return leaves
    }
    if (ArrayBuffer.isView(value)) {
        leaves.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
        return leaves
    }
    if (value == null || typeof value != 'object') return leaves
    for (const key of Object.keys(value)) binaryLeaves((value as Record<string, unknown>)[key], leaves)
    return leaves
}

function countMagic(bytes: Uint8Array, magic: readonly number[]) {
    let count = 0
    for (let offset = 0; offset <= bytes.length - magic.length; offset++) {
        let matches = true
        for (let index = 0; index < magic.length; index++) {
            if (bytes[offset + index] != magic[index]) {
                matches = false
                break
            }
        }
        if (matches) count++
    }
    return count
}

function countStoreWireCalls(
    remote: NonNullable<StoreReplayRemote['batch']>['v5']
        | NonNullable<StoreReplayRemote['batch']>['v6']
        | NonNullable<StoreReplayRemote['batch']>['v7'],
    count: () => void,
) {
    if (!remote) return remote
    const counted: any = {
        ...remote,
        since(seq: number) {
            count()
            return remote.since(seq)
        },
        keyframe() {
            count()
            return remote.keyframe()
        },
    }
    if (remote.frame) {
        counted.frame = function countStoreFrame(seq: number, hint?: unknown) {
            count()
            return remote.frame!(seq, hint)
        }
    }
    return counted
}

async function waitFor(label: string, condition: () => boolean) {
    for (let i = 0; i < 2000; i++) {
        if (condition()) return
        await delay(10)
    }
    throw new Error('timeout: ' + label)
}

async function measure(
    batch: boolean,
    serverBatch = true,
    callbackBatch = true,
    serverBinary = true,
    clientBinary = serverBinary,
    workload: MeasureWorkload = {},
) {
    const initialRecords = workload.initialRecords ?? 0
    const updateRecords = workload.updateRecords ?? 50
    const initial: Quotes = {}
    for (let index = 0; index < initialRecords; index++) {
        initial['S' + String(index).padStart(5, '0')] = {c: index + 0.5, t: 1000 + index}
    }
    const source = createStore<Quotes>(initial, {drain: 'micro'})
    const exposed = exposeStoreReplay(source, {history: 256, batch: serverBatch})
    const stats: WireStats = {
        armed: false,
        sends: 0,
        bytes: 0,
        binaryAttachments: 0,
        v5Frames: 0,
        rpcBinaryFrames: 0,
        schemaBinaryFrames: 0,
        v5Calls: 0,
        v6Calls: 0,
        v7Calls: 0,
    }
    const replay = exposed.api.replay as StoreReplayRemote
    const exposedBatch = replay.batch
    const replayFacade = exposedBatch
        ? {
            ...replay,
            batch: {
                ...exposedBatch,
                v5: countStoreWireCalls(exposedBatch.v5, function countV5Call() { stats.v5Calls++ }),
                v6: countStoreWireCalls(exposedBatch.v6, function countV6Call() { stats.v6Calls++ }),
                v7: countStoreWireCalls(exposedBatch.v7, function countV7Call() { stats.v7Calls++ }),
            },
        }
        : replay
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})
    const schemaSamples = [{
        seq: 1,
        ts: 1,
        event: [[{
            path: ['S00000'],
            exists: true,
            value: {c: 1.5, t: 1},
        }]],
    }]
    const serverBinaryOpt = serverBinary ? {predeclared: schemaSamples} : false
    const clientBinaryOpt = clientBinary ? {predeclared: schemaSamples} : false

    ioServer.on('connection', function serveConnection(socket) {
        const [disconnect, disconnectListen] = listen<[]>()
        socket.on('disconnect', function closeConnection() { disconnect() })
        createRpcServerAuto({
            socket: {
                emit(key, data) {
                    if (stats.armed && key == 'store-batch') {
                        const metrics = rpcResultWireMetrics(data)
                        stats.sends++
                        stats.bytes += metrics.byteLength
                        stats.binaryAttachments += metrics.binaryCount
                        stats.v5Frames += binaryLeaves(data).reduce(function countEmbeddedStoreV5(total, bytes) {
                            return total + countMagic(bytes, [0x53, 0x52, 0x42, 5])
                        }, 0)
                        stats.rpcBinaryFrames += binaryLeaves(data).filter(function isRpcBinary(bytes) {
                            return bytes[0] == 0x52 && bytes[1] == 0x50 && bytes[2] == 0x42
                        }).length
                        stats.schemaBinaryFrames += binaryLeaves(data).filter(function isSchemaRpcBinary(bytes) {
                            return bytes[0] == 0x52 && bytes[1] == 0x50 && bytes[2] == 0x42 && bytes[3] == 2
                        }).length
                    }
                    socket.emit(key, data)
                },
                on: (key, cb) => socket.on(key, cb),
            },
            socketKey: 'store-batch',
            object: {replay: replayFacade},
            disconnectListen,
            opt: {callbackBatch, binary: serverBinaryOpt},
        })
    })

    await new Promise<void>(function start(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    const port = (httpServer.address() as AddressInfo).port
    const hub = createRpcClientHub(
        () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true}),
        remote => ({api: remote<{replay: StoreReplayRemote}>('store-batch')}) as const,
        {opt: {binary: clientBinaryOpt}},
    )

    try {
        const client = await hub.setToken(null)
        await client.api.readyStrict()
        const mirror = createStore<Quotes>({}, {drain: 'micro'})
        const sub = syncStoreReplay(mirror, client.api.func.replay, {batch})
        await sub.ready
        const initialConverged = Object.keys(mirror.state).length == initialRecords
            && isDeepStrictEqual(mirror.snapshot(), source.snapshot())
        stats.armed = true

        for (let index = 0; index < updateRecords; index++) {
            const key = initialRecords
                ? 'S' + String(index % initialRecords).padStart(5, '0')
                : 'S' + index
            source.state[key] = {c: index + 10_000.5, t: 20_000 + index}
        }
        const rich = workload.rich ?? (batch && serverBatch)
        if (rich) {
            const state = source.state as any
            const exactBuffer = Uint8Array.from([9, 8, 7, 6, 5])
            state.UNDEF = undefined
            state.BOOL_FALSE = false
            state.BOOL_TRUE = true
            state.NULL = null
            state.NAN = Number.NaN
            state.BIGINT = 9_007_199_254_740_993n
            state.NESTED = {enabled: false, missing: undefined, rows: [null, true]}
            state.DATE = new Date(1_700_000_000_123)
            state.MAP = new Map([['spot', new Set([false, true])]])
            state.VIEW = new Uint8Array([0xa5, 7, 8, 9, 0xa5]).subarray(1, 4)
            state.EXACT = {
                maxSafeInteger: Number.MAX_SAFE_INTEGER,
                minSafeInteger: Number.MIN_SAFE_INTEGER,
                decimal: 1.2345678901234567,
                nan: Number.NaN,
                positiveInfinity: Number.POSITIVE_INFINITY,
                negativeInfinity: Number.NEGATIVE_INFINITY,
                unicode: 'котировка 🚀\u0000',
                largeBigint: 1n << 80n,
                invalidAt: new Date(Number.NaN),
                pattern: /quote/giu,
                arrayBuffer: exactBuffer.buffer,
                dataView: new DataView(exactBuffer.buffer, 1, 3),
                integers: new Int16Array([-32768, 0, 32767]),
                decimals: new Float64Array([-0, Number.NaN, 1.25]),
            }
        }
        await flushReactive(source.state)
        const expectedKeys = initialRecords || updateRecords
        const richKeys = rich ? expectedKeys + 11 : expectedKeys
        await waitFor('quotes arrive', () => Object.keys(mirror.state).length == richKeys)
        await delay(20)
        const mirrorState = mirror.state as any
        const richPreserved = !rich || (
            Object.prototype.hasOwnProperty.call(mirrorState, 'UNDEF') && mirrorState.UNDEF === undefined
            && mirrorState.BOOL_FALSE == false && mirrorState.BOOL_TRUE == true && mirrorState.NULL == null
            && Number.isNaN(mirrorState.NAN)
            && mirrorState.BIGINT == 9_007_199_254_740_993n
            && mirrorState.NESTED?.enabled == false
            && Object.prototype.hasOwnProperty.call(mirrorState.NESTED, 'missing')
            && mirrorState.DATE instanceof Date && mirrorState.DATE.valueOf() == 1_700_000_000_123
            && mirrorState.MAP instanceof Map && mirrorState.MAP.get('spot') instanceof Set
            && mirrorState.VIEW instanceof Uint8Array
            && isDeepStrictEqual(Array.from(mirrorState.VIEW), [7, 8, 9])
            && isDeepStrictEqual(mirrorState.EXACT, (source.state as any).EXACT)
        )
        let reconnected = true
        if (workload.reconnect) {
            const beforeDisconnectSeq = sub.seq()
            hub.socket?.disconnect?.()
            await delay(30)
            for (let index = 0; index < updateRecords; index++) {
                const sourceIndex = (index + updateRecords) % initialRecords
                const key = 'S' + String(sourceIndex).padStart(5, '0')
                source.state[key] = {c: index + 30_000.5, t: 40_000 + index}
            }
            await flushReactive(source.state)
            hub.socket?.connect?.()
            await waitFor('v7 reconnect convergence', function v7ReconnectConverged() {
                return sub.seq() > beforeDisconnectSeq
                    && isDeepStrictEqual(mirror.snapshot(), source.snapshot())
            })
            reconnected = sub.seq() > beforeDisconnectSeq
                && isDeepStrictEqual(mirror.snapshot(), source.snapshot())
        }
        const result = {
            ...stats,
            initialConverged,
            reconnected,
            converged: isDeepStrictEqual(mirror.snapshot(), source.snapshot()),
            richPreserved,
        }
        stats.armed = false
        sub()
        return result
    } finally {
        hub.socket?.disconnect?.()
        await delay(20)
        exposed.close()
        await new Promise<void>(resolve => {
            ioServer.close()
            httpServer.close(() => resolve())
        })
    }
}

async function main() {
    console.log('\n[store-replay-batch-socket] packet and byte amplification over real Socket.IO')
    const oldTransport = await measure(false, true, false, false)
    const callbackBatch = await measure(false, true, true, false)
    const batch = await measure(true)
    const largeV7 = await measure(true, true, true, true, true, {
        initialRecords: 15_000,
        updateRecords: 250,
        reconnect: true,
        rich: false,
    })
    const fallback = await measure(true, false, false, false, true)
    ok(oldTransport.converged && callbackBatch.converged && batch.converged, 'all transport/store modes converge')
    ok(oldTransport.sends >= 50, `old RPC transport sends per patch (${oldTransport.sends})`)
    ok(callbackBatch.sends == 1, `generic callback batching wraps the unchanged legacy line once (${callbackBatch.sends})`)
    ok(batch.sends == 1, `batch sends one physical RPC/Socket.IO message (${batch.sends})`)
    ok(batch.binaryAttachments == 1 && batch.rpcBinaryFrames == 1 && batch.schemaBinaryFrames == 1
        && batch.v5Frames == 0 && batch.v7Calls > 0 && batch.v6Calls == 0 && batch.v5Calls == 0,
    `Store v7 uses one msgpackr value inside the existing schema-v2 RPC frame `
        + `(${batch.binaryAttachments}/${batch.schemaBinaryFrames}, routes `
        + `${batch.v7Calls}/${batch.v6Calls}/${batch.v5Calls})`)
    ok(oldTransport.binaryAttachments == 0 && callbackBatch.binaryAttachments == 0,
        'explicit binary opt-out preserves JSON transport')
    ok(batch.richPreserved,
        'msgpackr Store v7 preserves false/true/null/undefined/numbers/nested/rich/binary values over real Socket.IO')
    ok(batch.bytes < callbackBatch.bytes * 0.8,
        `Store batch also cuts logical-envelope bytes (${callbackBatch.bytes} -> ${batch.bytes})`)
    ok(fallback.converged && fallback.sends >= 50, 'new client negotiates back to legacy against an old server')
    ok(largeV7.initialConverged && largeV7.converged && largeV7.reconnected,
        'msgpackr Store v7 converges a 15k keyframe, 250 live updates and 250 reconnect updates')
    ok(largeV7.v7Calls >= 2 && largeV7.v6Calls == 0 && largeV7.v5Calls == 0
        && largeV7.v5Frames == 0 && largeV7.schemaBinaryFrames >= 2,
    `15k/reconnect stays on v7 and outer RPB/2 without inner SRB `
        + `(${largeV7.v7Calls}/${largeV7.v6Calls}/${largeV7.v5Calls}, `
        + `${largeV7.schemaBinaryFrames} frames)`)
    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
