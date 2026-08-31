// =====================================================================
// In-proc transport spec — createLoopbackSocketPair (testing kit) and
// the storeExternal adapter driven over a real RPC wire
// =====================================================================

import * as assert from 'node:assert/strict'
import {createLoopbackSocketPair, createInProcSocketPair} from './rpc-inproc'
import {createRpcServerAuto} from './rpc-server-auto'
import {createRpcClient} from './rpc-client'
import {listen as createListenPair} from '../events/Listen'
import {storeExternal} from '../Observe/store-external'
import {createStore} from '../Observe/store'

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function testEndToEnd() {
    const pair = createLoopbackSocketPair()
    const [emitTick, ticks] = createListenPair<[number]>()
    const [disconnect, disconnectListen] = createListenPair<[]>()
    pair.server.on('disconnect', function onServerDisconnect() { disconnect() })

    createRpcServerAuto({
        socket: pair.server,
        socketKey: 'rpc',
        disconnectListen,
        object: {
            add: (a: number, b: number) => a + b,
            echoBin: (v: Uint8Array) => v,
            ticks,
        },
    })
    const client = createRpcClient<any>({socket: pair.client, socketKey: 'rpc'})
    await client.readyStrict()

    assert.equal(await client.func['add'](2, 3), 5, 'plain call over the loopback pair')

    const bin = await client.func['echoBin'](new Uint8Array([7, 8, 9]))
    assert.deepEqual([...new Uint8Array(bin)], [7, 8, 9], 'binary leaves survive the in-proc wire')

    const got: number[] = []
    const off = client.func['ticks'].on(function onTick(v: number) { got.push(v) })
    await wait()
    emitTick(1)
    emitTick(2)
    await wait()
    assert.deepEqual(got, [1, 2], 'Listen stream flows server -> client')
    off()
    return {pair, client, emitTick, got}
}

async function testOfflineWindow() {
    const {pair, client} = await testEndToEnd()

    pair.setOnline(false)
    let settled = false
    client.func['add'](1, 1).then(function markSettled() { settled = true }, function markSettled() { settled = true })
    await wait(40)
    assert.equal(settled, false, 'a call during the offline window neither resolves nor rejects')
    assert.equal(pair.online(), false)

    pair.setOnline(true)
    assert.equal(await client.func['add'](4, 4), 8, 'a NEW call after the window succeeds')
}

async function testKill() {
    const pair = createLoopbackSocketPair()
    let clientSaw = 0
    let serverSaw = 0
    pair.client.on('disconnect', function onClientDead() { clientSaw++ })
    pair.server.on('disconnect', function onServerDead() { serverSaw++ })

    assert.equal(pair.kill(), true, 'first kill reports the cut')
    assert.equal(pair.kill(), false, 'second kill is a no-op')
    assert.equal(clientSaw, 1, 'client end saw exactly one disconnect')
    assert.equal(serverSaw, 1, 'server end saw exactly one disconnect')
    assert.equal(pair.online(), false)

    let delivered = false
    pair.server.on('x', function onX() { delivered = true })
    pair.client.emit('x', 1)
    await wait()
    assert.equal(delivered, false, 'delivery stops forever after kill')
}

function testSyncDelivery() {
    const pair = createLoopbackSocketPair({delivery: 'sync'})
    let got: any = null
    pair.server.on('x', function onX(d: any) { got = d })
    pair.client.emit('x', {n: 1})
    assert.deepEqual(got, {n: 1}, 'sync delivery lands before emit returns')
}

function testWireDetachment() {
    const [a, b] = createInProcSocketPair()
    let received: any = null
    b.on('x', function onX(d: any) { received = d })
    const sent = {n: 1}
    a.emit('x', sent)
    return new Promise<void>(function afterMicrotasks(resolve) {
        queueMicrotask(function check() {
            assert.notEqual(received, sent, 'no object identity leaks across the wire')
            assert.deepEqual(received, sent)
            resolve()
        })
    })
}

async function testStoreExternal() {
    const store = createStore<{items: Record<string, {n: number}>, count: number}>(
        {items: {}, count: 0}, {drain: 'micro'})
    const ext = storeExternal(store.node.items)

    const s0 = ext.getSnapshot()
    assert.equal(ext.getSnapshot(), s0, 'snapshot identity is STABLE between changes (React contract)')

    let notified = 0
    const unsubscribe = ext.subscribe(function onChange() { notified++ })
    assert.equal(notified, 0, 'subscribe does not fire immediately')

    store.state.items['a'] = {n: 1}
    await wait()
    assert.equal(notified, 1, 'a change under the node notifies')
    const s1 = ext.getSnapshot()
    assert.notEqual(s1, s0, 'a change produces a NEW snapshot identity')
    assert.deepEqual(s1, {a: {n: 1}})
    assert.equal(ext.getSnapshot(), s1, 'identity stable again until the next change')

    store.state.count = 5
    await wait()
    assert.equal(notified, 1, 'a change OUTSIDE the node does not notify')

    unsubscribe()
    store.state.items['b'] = {n: 2}
    await wait()
    assert.equal(notified, 1, 'no notifications after unsubscribe')
    assert.deepEqual(ext.getSnapshot(), {a: {n: 1}, b: {n: 2}},
        'getSnapshot after unsubscribe recomputes (cache was invalidated)')
}

async function run() {
    await testEndToEnd()
    await testOfflineWindow()
    await testKill()
    testSyncDelivery()
    await testWireDetachment()
    await testStoreExternal()
    console.log('rpc-inproc: OK')
    process.exit(0)
}

run().catch(function fail(error) {
    console.error(error)
    process.exit(1)
})
