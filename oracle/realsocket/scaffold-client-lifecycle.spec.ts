import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {setTimeout as delay} from 'node:timers/promises'
import {Server} from 'socket.io'
import {createRpcServerAuto} from '../../src/Common/rcp/rpc-server-auto'
import {createNodeDirectory} from '../../src/Common/Observe/node-directory'
import {createStore} from '../../src/Common/Observe/store'
import {exposeStoreReplay} from '../../src/Common/Observe/store-replay'
import {createServiceClient} from '../../experiments/wenay-scaffold/template/client'
import type {tServiceDefinition} from '../../experiments/wenay-scaffold/template/leader'

const definition = {
    name: 'lifecycle', storeId: 'lifecycle', originId: 'leader', initial: {value: 1}, commands: {},
    views: {counter: {allow: 'public', project: (state: {value: number}) => state}},
} satisfies tServiceDefinition<{value: number}>

function gate() {
    let release!: () => void
    const promise = new Promise<void>(function wait(resolve) { release = resolve })
    return {promise, release}
}

async function until(check: () => boolean) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (check()) return
        await delay(10)
    }
    assert.fail('condition timed out')
}

async function fixture(deps: {rosterGate?: ReturnType<typeof gate>} = {}) {
    const http = createServer()
    const io = new Server(http)
    const directory = createNodeDirectory({replay: {}, sweepMs: 0})
    const source = exposeStoreReplay(createStore({value: 1}))
    let rosterRequested = false
    let connections = 0
    io.on('connection', function connected(socket) {
        connections++
        createRpcServerAuto({
            socket, socketKey: 'app', object: {lifecycle: {roster: directory.api, views: {counter: source.api.replay}}},
            hooks: {async onRequest(context) {
                if (context.key.includes('roster')) {
                    rosterRequested = true
                    await deps.rosterGate?.promise
                }
                return true
            }},
        })
        createRpcServerAuto({socket, socketKey: 'scale', object: {}})
    })
    await new Promise<void>(function listen(resolve) { http.listen(0, '127.0.0.1', resolve) })
    const address = http.address()
    assert(address && typeof address != 'string')
    const url = `http://127.0.0.1:${address.port}`
    directory.control.set({nodeId: 'leader', role: 'leader', url, weight: 1})
    return {
        url,
        view: {rosterRequested: () => rosterRequested, connections: () => connections, sockets: () => io.sockets.sockets.size},
        async close() {
            deps.rosterGate?.release()
            await new Promise<void>(function stop(resolve) { io.close(function stopped() { resolve() }) })
            directory.close()
            source.close()
        },
    }
}

async function main() {
    // Closing during the directory snapshot must settle both readiness surfaces.
    const blockedRoster = gate()
    const server = await fixture({rosterGate: blockedRoster})
    try {
        const client = createServiceClient({definition, url: server.url})
        const view = client.views.counter
        const ready = assert.rejects(client.ready(), /closed/, 'roster client ready')
        const viewReady = assert.rejects(view.ready, /closed/, 'roster view ready')
        await until(server.view.rosterRequested)
        client.close()
        await Promise.all([ready, viewReady])
        blockedRoster.release()
        await until(() => server.view.sockets() == 0)
        await delay(30)
        assert.equal(server.view.connections(), 1)
        assert.equal(client.view.endpoint(), null)
        assert.throws(() => client.views.counter, /closed/)
    } finally { await server.close() }

    // A view may close while a shared connection is opening; no late route is installed.
    const nextGate = gate()
    const next = await fixture({rosterGate: nextGate})
    try {
        const client = createServiceClient({definition, url: next.url})
        try {
            const view = client.views.counter
            const rejected = assert.rejects(view.ready, /closed/, 'individual view ready')
            await until(next.view.rosterRequested)
            view.close()
            await rejected
            nextGate.release()
            await client.ready()
            await delay(30)
            assert.equal(view.seq(), -1)
            const replacement = client.views.counter
            await replacement.ready
            assert.equal(replacement.store.state.value, 1)
            view.close()
            assert.equal(client.views.counter, replacement)
        } finally { client.close() }
        await until(() => next.view.sockets() == 0)
    } finally { await next.close() }

    // The hub owns login: close rejects readiness even if the external issuer has not replied.
    const issuer = gate()
    const authServer = await fixture()
    try {
        let calls = 0
        const client = createServiceClient({definition, url: authServer.url, auth: {
            async login() { calls++; await issuer.promise; return 'test-token' },
        }})
        const rejected = assert.rejects(client.ready(), /closed/, 'issuer client ready')
        await until(() => calls > 0)
        client.close()
        await rejected
        issuer.release()
        await until(() => authServer.view.sockets() == 0)
        assert.equal(calls, 1)
        assert.equal(client.identity.token(), null)
        assert.equal(client.view.endpoint(), null)
    } finally { issuer.release(); await authServer.close() }
    console.log('client lifecycle: 3 real-socket scenarios passed')
}

main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
