// Real Socket.IO acceptance test for the demo Workboard boundary:
// intent commands -> authoritative Store -> replayed read-only client mirrors.

import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {createWorkboardClient} from '../demo/workboard-client'
import type {WorkboardRemote} from '../demo/workboard-contract'
import {createWorkboardHost} from '../demo/workboard-host'
import {listen} from '../src/Common/events/Listen'
import {flushReactive} from '../src/Common/Observe/reactive'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

let fails = 0

function ok(condition: any, message: string) {
    if (condition) console.log('  OK  ', message)
    else { fails++; console.log('  FAIL', message) }
}

function delay(ms: number) {
    return new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })
}

async function waitFor(label: string, condition: () => boolean) {
    for (let attempt = 0; attempt < 160; attempt++) {
        if (condition()) return
        await delay(25)
    }
    throw new Error('timeout: ' + label)
}

async function rejects(action: () => Promise<any>, includes: string) {
    try {
        await action()
        return false
    } catch (error) {
        return String((error as any)?.message ?? error).includes(includes)
    }
}

async function startServer(host: ReturnType<typeof createWorkboardHost>) {
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer)

    ioServer.on('connection', function bindWorkboardSocket(socket) {
        const account = String(socket.handshake.auth?.account ?? '')
        const workboard = host.connection(account)
        const [emitDisconnect, disconnectListen] = listen<[]>()
        socket.on('disconnect', function closeWorkboardConnection() {
            emitDisconnect()
            workboard.close()
        })
        createRpcServerAuto({
            socket: {emit: (key, data) => socket.emit(key, data), on: (key, cb) => socket.on(key, cb)},
            socketKey: 'workboard-test',
            object: {workboard: workboard.fragment},
            disconnectListen,
        })
    })

    await new Promise<void>(function waitForServer(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    const port = (httpServer.address() as AddressInfo).port
    return {
        port,
        close: () => new Promise<void>(function closeServer(resolve) {
            ioServer.close()
            httpServer.close(function serverClosed() { resolve() })
        }),
    }
}

async function startClient(port: number, account: string) {
    const hub = createRpcClientHub(
        () => io(`http://127.0.0.1:${port}`, {auth: {account}, transports: ['websocket'], forceNew: true}),
        r => ({app: r<any>('workboard-test')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.app.readyStrict()
    const workboard = createWorkboardClient({
        remote: clients.app.func.workboard as unknown as WorkboardRemote,
        drain: 'micro',
        transport: {
            connected: () => Boolean(hub.socket?.connected),
            connectListen: cb => hub.connectListen(function workboardConnected() { cb() }),
            disconnectListen: cb => hub.disconnectListen(cb),
        },
    })
    await workboard.ready
    ok(workboard.status().replayMode == 'batch', 'stand client negotiated compact Store Replay batch')
    return {
        hub,
        workboard,
        close() {
            workboard.close()
            hub.socket?.disconnect?.()
        },
    }
}

async function main() {
    console.log('\n[workboard-demo] authoritative commands and replay mirrors over real Socket.IO')
    let nextId = 0
    let clock = 1_000
    const host = createWorkboardHost({
        initial: [{id: 'seed', title: 'Review the stand', status: 'new'}],
        makeId: () => 'item-' + (++nextId),
        now: () => ++clock,
        history: 32,
    })
    const server = await startServer(host)
    const a = await startClient(server.port, 'person-a')
    const b = await startClient(server.port, 'person-b')

    try {
        ok(a.workboard.store.state.seed?.title == 'Review the stand' && b.workboard.store.state.seed?.revision == 1,
            'both clients receive the authoritative initial keyframe')

        const changedKeys: string[] = []
        const offEach = b.workboard.store.each().on(function trackChangedKey(key) { changedKeys.push(key) })
        const created = await a.workboard.create({requestId: 'create-1', title: 'Connect the Store screen'})
        await flushReactive(host.control.store.state)
        await waitFor('created item reaches client B', () => b.workboard.store.state[created.id]?.revision == 1)
        ok(changedKeys.includes(created.id), 'client rendering can subscribe per changed top-level work item')
        ok(created.createdBy == 'person-a' && created.status == 'new', 'server owns identity and initial workflow state')

        const duplicate = await a.workboard.create({requestId: 'create-1', title: 'ignored retry payload'})
        ok(duplicate.id == created.id && Object.keys(host.control.store.state).length == 2,
            'requestId retry returns the original receipt without a duplicate item')

        const staleRevision = b.workboard.store.state[created.id].revision
        const moved = await a.workboard.move({
            requestId: 'move-1', id: created.id, status: 'active', expectedRevision: created.revision,
        })
        await waitFor('move reaches client B', () => b.workboard.store.state[created.id]?.revision == moved.revision)
        ok(moved.revision == 2 && moved.status == 'active' && moved.updatedBy == 'person-a',
            'accepted command advances one authoritative item revision')
        ok(await rejects(() => b.workboard.rename({
            requestId: 'rename-stale', id: created.id, title: 'stale rename', expectedRevision: staleRevision,
        }), 'revision conflict'), 'stale expectedRevision is rejected')
        ok(host.control.store.state[created.id].title == created.title,
            'rejected command never mutates authoritative state')

        const renamed = await b.workboard.rename({
            requestId: 'rename-current', id: created.id, title: 'Store screen connected', expectedRevision: moved.revision,
        })
        await waitFor('rename reaches client A', () => a.workboard.store.state[created.id]?.revision == renamed.revision)
        ok(renamed.revision == 3 && renamed.updatedBy == 'person-b', 'another participant can commit against the current revision')

        ;(b.hub.socket as any).disconnect()
        await waitFor('client B reports reconnecting', () => b.workboard.status().connection == 'reconnecting')
        const whileAway = await a.workboard.create({requestId: 'create-away', title: 'Catch up after reconnect'})
        await flushReactive(host.control.store.state)
        ok(!b.workboard.store.state[whileAway.id], 'disconnected mirror does not invent missed state')
        ;(b.hub.socket as any).connect()
        await waitFor('client B catches up after reconnect', () => b.workboard.store.state[whileAway.id]?.revision == 1)
        await waitFor('client B reports live', () => b.workboard.status().connection == 'live')
        ok(Object.keys(b.workboard.store.state).length == Object.keys(host.control.store.state).length,
            'reconnect catches up without duplicate work items')

        const removed = await b.workboard.remove({
            requestId: 'remove-1', id: created.id, expectedRevision: renamed.revision,
        })
        await waitFor('delete reaches client A', () => !a.workboard.store.state[created.id])
        ok(removed.deleted && removed.revision == 4, 'delete returns the next authoritative revision and mirrors as a missing key')
        ok(await rejects(() => a.workboard.create({requestId: 'invalid-title', title: '   '}), 'title is required'),
            'invalid command payload is rejected at the host boundary')

        offEach()
    } finally {
        a.close()
        b.close()
        await server.close()
        host.close()
    }

    if (fails) {
        console.log(`\nFAIL: ${fails} workboard assertion(s)`)
        process.exit(1)
    }
    console.log('\nPASS: Workboard Store boundary, revisions and reconnect are green')
}

main().catch(function failWorkboardOracle(error) {
    console.error(error)
    process.exit(1)
})
