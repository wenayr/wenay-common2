import * as assert from 'node:assert/strict'
import {createLoopbackSocketPair} from '../../src/Common/rcp/rpc-inproc'
import {createRpcServerAuto} from '../../src/Common/rcp/rpc-server-auto'
import {createRpcClient} from '../../src/Common/rcp/rpc-client'
import {bindRpcScopes, createRpcScope} from '../../src/Common/rcp/rpc-scope'
import {listen, listenStore} from '../../src/Common/events/Listen'
import {flowCallback} from '../../src/Common/rcp/rpc-flow'
import {noStrict} from '../../src/Common/rcp/rpc-dynamic'
import {runOracle} from '../run-oracle'

function barrier() {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    return {promise, release}
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

async function main() {
    const pair = createLoopbackSocketPair()
    const a = createRpcScope(), b = createRpcScope()
    const [emit, events] = listen<[number]>()
    const entered = barrier(), admit = barrier(), readEntered = barrier(), readDone = barrier()
    let calls = 0
    const shared = {read() { calls++; return 42 }, events, dynamic: noStrict({events})}
    const hooks = bindRpcScopes({
        async onRequest({key: path}: {key: string[]}) {
            if (path.at(-1) == 'pending') { entered.release(); await admit.promise }
            return true
        },
    }, path => path[0] == 'a' ? a : path[0] == 'b' ? b : undefined)
    const server = createRpcServerAuto({socket: pair.server, socketKey: 'scope', hooks,
        object: {a: {...shared, pending() { calls++; return 9 }}, b: shared,
            async late() { readEntered.release(); await readDone.promise; return 'secret' }, ping() { return 'pong' }},
    })
    const client = createRpcClient<any>({socket: pair.client, socketKey: 'scope'})
    await client.readyStrict()
    const gotA: number[] = [], gotB: number[] = []
    const handles = [client.func.a.events.on((n: number) => gotA.push(n)),
        client.func.a.dynamic.events.on((n: number) => gotA.push(n)),
        client.func.b.events.on((n: number) => gotB.push(n)),
        client.func.b.dynamic.events.on((n: number) => gotB.push(n))]
    await client.func.ping()
    await turn()
    assert.equal(server.api.subscriptions().reduce((count, item) => count + item.consumers, 0), 4)
    emit(1)
    await turn()
    assert.deepEqual(gotA, [1, 1])
    assert.deepEqual(gotB, [1, 1])
    const saved = client.func.a.read
    assert.equal(await saved(), 42)
    const pending = client.func.a.pending().then(() => null, (e: any) => e.code)
    await entered.promise
    a.close()
    admit.release()
    assert.equal(await pending, 'E_RESOURCE_CLOSED')
    await assert.rejects(saved(), {code: 'E_RESOURCE_CLOSED'})
    await Promise.all(handles.slice(0, 2).map(handle => Promise.resolve(handle)))
    await turn()
    const rejected = client.func.a.dynamic.events.on(() => { throw new Error('revoked delivery') })
    await Promise.resolve(rejected) // Listen handles settle at stream end; admission errors never attach.
    assert.equal(server.api.subscriptions().reduce((count, item) => count + item.consumers, 0), 2)
    emit(2)
    await turn()
    assert.deepEqual(gotA, [1, 1])
    assert.deepEqual(gotB, [1, 1, 2, 2])
    assert.equal(await client.func.b.read(), 42)
    assert.equal(calls, 2)
    assert.equal(await client.func.ping(), 'pong')
    for (const off of handles) off()
    b.close()
    client.dispose()
    pair.kill()

    const latePair = createLoopbackSocketPair()
    const scope = createRpcScope()
    const lateServer = createRpcServerAuto({socket: latePair.server, socketKey: 'late',
        hooks: bindRpcScopes({}, () => scope),
        object: {async read() { readEntered.release(); await readDone.promise; return 'secret' }},
    })
    const lateClient = createRpcClient<any>({socket: latePair.client, socketKey: 'late'})
    await lateClient.readyStrict()
    const result = lateClient.func.read().then(() => null, (e: any) => e.code)
    await readEntered.promise
    scope.close()
    readDone.release()
    assert.equal(await result, 'E_RESOURCE_CLOSED')
    lateClient.dispose()
    latePair.kill()
    const attachPair = createLoopbackSocketPair(), attachScope = createRpcScope()
    const admissionEntered = barrier(), admissionRelease = barrier()
    const attachServer = createRpcServerAuto({socket: attachPair.server, socketKey: 'attach', object: {events},
        hooks: bindRpcScopes({async onRequest() { admissionEntered.release(); await admissionRelease.promise; return true }}, () => attachScope),
    })
    const attachClient = createRpcClient<any>({socket: attachPair.client, socketKey: 'attach'})
    await attachClient.readyStrict()
    const subscription = attachClient.func.events.on(() => { throw new Error('late admission delivered') })
    await admissionEntered.promise
    attachScope.close(); admissionRelease.release()
    await subscription
    assert.equal(attachServer.api.subscriptions().length, 0)
    attachClient.dispose(); attachPair.kill()

    const reentrantPair = createLoopbackSocketPair(), reentrantScope = createRpcScope()
    const [, reentrant] = listenStore<[number]>({current() { reentrantScope.close(); return [1] }})
    createRpcServerAuto({socket: reentrantPair.server, socketKey: 'reentrant', object: {events: reentrant},
        hooks: bindRpcScopes({}, () => reentrantScope)})
    const reentrantClient = createRpcClient<any>({socket: reentrantPair.client, socketKey: 'reentrant'})
    await reentrantClient.readyStrict()
    await reentrantClient.func.events.on(() => { throw new Error('closed current was delivered') }, {current: true})
    assert.equal(reentrant.count(), 0, 'late subscription handle is released after reentrant close')
    reentrantClient.dispose(); reentrantPair.kill(); reentrant.close()

    const flowPair = createLoopbackSocketPair(), flowScope = createRpcScope(), flowing = barrier()
    createRpcServerAuto({socket: flowPair.server, socketKey: 'flow', hooks: bindRpcScopes({}, () => flowScope),
        object: {async stream(cb: (n: number) => void) {
            const flow = flowCallback(cb, {pending: () => 999, highWater: 1, lowWater: 0})
            flowing.release()
            await flow.push(1)
        }}})
    const flowClient = createRpcClient<any>({socket: flowPair.client, socketKey: 'flow'})
    await flowClient.readyStrict()
    const streaming = flowClient.func.stream(() => {}).then(() => null, (error: any) => error.code)
    await flowing.promise
    flowScope.close()
    assert.equal(await streaming, 'E_RESOURCE_CLOSED', 'scope close interrupts flow waits and their poll timers')
    flowClient.dispose(); flowPair.kill()
    console.log('PASS RPC resource scopes: methods, ordinary/dynamic streams, independent shared sources, admission and result races')
}
runOracle(main)
