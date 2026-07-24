// =====================================================================
// Replicated Map over real Socket.IO and RPC auto-projection
// =====================================================================

import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {
    createReplicatedMap, followReplicatedMap, FollowedReplicatedMap,
    ReplicatedMapChange, ReplicatedMapRemote,
} from '../src/Common/Observe'
import {listen} from '../src/Common/events/Listen'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

let fails = 0

function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

function delay(ms: number) {
    return new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })
}

async function waitFor(label: string, condition: () => boolean) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (condition()) return
        await delay(20)
    }
    throw new Error('timeout: ' + label)
}

type Item = {
    id: string
    value: number
    meta?: {explicit: undefined}
    bytes?: Uint8Array
    placeholder?: {_placeholder: true, num: number}
}
type SocketFacade = {map: ReplicatedMapRemote<Item>}
type WireStats = {
    rpcV2Frames: number
    embeddedV5Frames: number
}

function item(id: string, value: number) {
    return {id, value}
}

function comparableSnapshot(value: any): any {
    if (ArrayBuffer.isView(value)) {
        return {binary: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}
    }
    if (value instanceof ArrayBuffer) return {binary: Array.from(new Uint8Array(value))}
    if (Array.isArray(value)) return value.map(comparableSnapshot)
    if (value == null || typeof value != 'object') return value
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value)) result[key] = comparableSnapshot(value[key])
    return result
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
    for (const key of Object.keys(value)) {
        binaryLeaves((value as Record<string, unknown>)[key], leaves)
    }
    return leaves
}

function containsStoreV5(bytes: Uint8Array) {
    for (let index = 0; index <= bytes.length - 4; index++) {
        if (bytes[index] == 0x53 && bytes[index + 1] == 0x52
            && bytes[index + 2] == 0x42 && bytes[index + 3] == 5) return true
    }
    return false
}

function countWireReads<W extends {
    since(seq: number): any
    keyframe(): any
    frame?: (seq: number, hint?: unknown) => any
}>(remote: W, count: () => void) {
    const counted = {
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
        counted.frame = function countReplicatedMapFrame(seq: number, hint?: unknown) {
            count()
            return remote.frame!(seq, hint)
        }
    }
    return counted
}

async function startServer(remote: ReplicatedMapRemote<Item>, wireStats: WireStats) {
    const httpServer = createServer()
    const ioServer = new SocketIOServer(httpServer)

    ioServer.on('connection', function exposeReplicatedMap(socket) {
        const [emitDisconnect, disconnectListen] = listen<[]>()
        socket.on('disconnect', function replicatedMapSocketDisconnected() {
            emitDisconnect()
        })
        createRpcServerAuto({
            socket: {
                emit(key, data) {
                    if (key == 'replicated-map-socket') {
                        for (const bytes of binaryLeaves(data)) {
                            if (bytes[0] == 0x52 && bytes[1] == 0x50
                                && bytes[2] == 0x42 && bytes[3] == 2) wireStats.rpcV2Frames++
                            if (containsStoreV5(bytes)) wireStats.embeddedV5Frames++
                        }
                    }
                    socket.emit(key, data)
                },
                on(key, cb) { socket.on(key, cb) },
            },
            socketKey: 'replicated-map-socket',
            object: {map: remote} satisfies SocketFacade,
            disconnectListen,
        })
    })

    await new Promise<void>(function listenForConnections(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })

    return {
        port: (httpServer.address() as AddressInfo).port,
        close() {
            return new Promise<void>(function closeServer(resolve) {
                ioServer.close()
                httpServer.close(function serverClosed() { resolve() })
            })
        },
    }
}

async function main() {
    console.log('\n[replicated-map-socket] RPC facade, batch and reconnect')
    const producer = createReplicatedMap<Item>({
        keyOf(value) { return value.id },
        initial: [{...item('seed', 0), meta: {explicit: undefined}}],
        delivery: 'latest',
        replay: {history: 32, batch: {history: 32}},
    })
    let v5Reads = 0
    let v6Reads = 0
    let v7Reads = 0
    const producerBatch = producer.api.batch!
    const measuredRemote = {
        ...producer.api,
        batch: {
            ...producerBatch,
            v5: countWireReads(producerBatch.v5!, function countV5Read() { v5Reads++ }),
            v6: countWireReads(producerBatch.v6!, function countV6Read() { v6Reads++ }),
            v7: countWireReads(producerBatch.v7!, function countV7Read() { v7Reads++ }),
        },
    }
    const wireStats: WireStats = {rpcV2Frames: 0, embeddedV5Frames: 0}
    const server = await startServer(measuredRemote, wireStats)
    const hub = createRpcClientHub(
        function connectSocket() {
            return io(`http://127.0.0.1:${server.port}`, {
                transports: ['websocket'],
                forceNew: true,
            })
        },
        remote => ({app: remote<SocketFacade>('replicated-map-socket')}) as const,
    )
    let follower: FollowedReplicatedMap<Item> | undefined

    try {
        const clients = await hub.setToken(null)
        await clients.app.readyStrict()
        const remote = clients.app.func.map
        const batches: ReplicatedMapChange<Item>[] = []
        const snapshots: Record<string, Item>[] = []

        follower = followReplicatedMap(remote, {
            onBatch(change) {
                batches.push(change)
                snapshots.push(follower!.snapshot())
            },
        })
        await follower.ready

        const descriptor = await remote.describe!()
        ok(descriptor?.replicatedMap?.delivery == 'latest'
            && follower.replayMode() == 'batch' && follower.delivery() == 'latest',
        'Replicated Map descriptor and compact batch facade pass RPC auto-projection')
        ok(v7Reads > 0 && v6Reads == 0 && v5Reads == 0,
            'Replicated Map initial catch-up selects Store Replay v7')
        ok(follower.get('seed')?.value == 0,
            'initial keyframe crosses the projected real-socket facade')
        ok(Object.prototype.hasOwnProperty.call(follower.get('seed')?.meta ?? {}, 'explicit'),
            'nested explicit undefined survives the compact real-socket keyframe')

        producer.control.set({
            ...item('binary-placeholder', 1),
            bytes: new Uint8Array([7, 8, 9]),
            placeholder: {_placeholder: true, num: 0},
        })
        await waitFor('binary placeholder business value', function binaryPlaceholderArrived() {
            return follower!.get('binary-placeholder')?.bytes?.[2] == 9
        })
        const binaryPlaceholder = follower.get('binary-placeholder')!
        ok(binaryPlaceholder.placeholder?._placeholder == true && binaryPlaceholder.placeholder.num == 0
            && binaryPlaceholder.bytes instanceof Uint8Array,
        'Store Replay v7 preserves a business Socket.IO placeholder beside real binary data')

        batches.length = 0
        snapshots.length = 0
        producer.control.setMany([
            item('A', 1),
            item('B', 2),
            item('C', 3),
        ])
        await waitFor('setMany snapshot', function setManyArrived() {
            return follower!.get('C')?.value == 3
        })
        await delay(30)

        ok(batches.length == 1 && batches[0].operations.length == 3,
            'one producer setMany becomes one follower onBatch over Socket.IO')
        ok(snapshots[0].A?.value == 1 && snapshots[0].B?.value == 2 && snapshots[0].C?.value == 3,
            'socket onBatch observes the fully applied setMany snapshot')

        batches.length = 0
        snapshots.length = 0
        const seqBeforeDisconnect = follower.seq()
        hub.socket?.disconnect?.()
        await waitFor('follower reconnecting', function followerIsReconnecting() {
            return follower!.status().state == 'reconnecting'
        })

        producer.control.setMany([
            item('A', 10),
            item('D', 4),
        ])
        ok(follower.get('A')?.value == 1 && !follower.has('D'),
            'disconnected follower does not observe offline writes early')

        hub.socket?.connect?.()
        await waitFor('missed batch after reconnect', function reconnectCaughtUp() {
            return follower!.get('A')?.value == 10 && follower!.get('D')?.value == 4
        })
        await waitFor('follower live after reconnect', function followerIsLive() {
            return follower!.status().state == 'live'
        })
        await delay(30)

        ok(follower.seq() > seqBeforeDisconnect && batches.length == 1,
            'reconnect resumes from replay coordinates and applies the missed batch once')
        ok(JSON.stringify(comparableSnapshot(follower.snapshot()))
            == JSON.stringify(comparableSnapshot(producer.control.snapshot())),
            'reconnected follower converges to the authoritative map')
        ok(v7Reads >= 2 && v6Reads == 0 && v5Reads == 0 && wireStats.rpcV2Frames > 0
            && wireStats.embeddedV5Frames == 0,
        `Replicated Map reconnect remains on v7 inside RPB/2 (${v7Reads}/${v6Reads}/${v5Reads}, `
            + `${wireStats.rpcV2Frames} frames)`)
    } finally {
        follower?.close()
        hub.socket?.disconnect?.()
        await delay(20)
        await server.close()
        producer.control.close()
    }

    console.log(fails ? `\n${fails} failed` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function replicatedMapSocketOracleFailed(error) {
    console.error(error)
    process.exit(1)
})
