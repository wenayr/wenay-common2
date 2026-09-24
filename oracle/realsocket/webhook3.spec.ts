// =====================================================================
//  WebHook3 through its facade over real HTTP: createWebhookServer + createWebhookClient.
//
//  The client and server exchange requests the way deployed peers do (loopback sockets, the
//  client-ip-derived callback URL). The file store is replaced by memory so nothing touches
//  ./subscribers.json. Pins the transport contract the axios -> fetch rewrite must keep:
//  delivery both ways, status/subscription reads, rejection on a refused request, and a
//  process that can exit (unsubscribe clears the renew timers).
// =====================================================================
import assert from 'node:assert/strict'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import express from 'express'
import {createWebhookClient, createWebhookServer} from '../../src/server/WebHook3'
import {runOracle} from '../run-oracle'

const token = 'webhook-oracle-token'
const memory = {loadSubscribers: () => new Map(), saveSubscribers() {}}

async function listen(app: express.Express) {
    const server = http.createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return {server, port: (server.address() as AddressInfo).port}
}

function nextPayload(received: unknown[], count: number) {
    return new Promise<void>(function wait(resolve, reject) {
        const deadline = Date.now() + 5000
        const timer = setInterval(function poll() {
            if (received.length >= count) { clearInterval(timer); resolve() }
            else if (Date.now() > deadline) { clearInterval(timer); reject(new Error(`expected ${count} deliveries, got ${received.length}`)) }
        }, 5)
    })
}

async function runChecks() {
    const serverApp = express()
    serverApp.use(express.json())
    const hub = createWebhookServer({authToken: token, port: 0, app: serverApp, file: memory})
    const {server: hubServer, port: hubPort} = await listen(serverApp)

    const clientApp = express()
    clientApp.use(express.json())
    const {server: clientServer, port: clientPort} = await listen(clientApp)
    const serverUrl = `http://127.0.0.1:${hubPort}`
    const client = createWebhookClient({serverUrl, clientPort, authToken: token, app: clientApp, autoRenew: true, renewIntervalMs: 20})
    let passed = 0
    async function check(name: string, fn: () => Promise<void>) {
        await fn()
        passed++
        console.log('PASS  ' + name)
    }

    try {
        const received: unknown[] = []
        await check('connect subscribes and a server emit reaches the handler', async function emitReaches() {
            await client.connect('orders', function onOrder(payload) { received.push(payload) })
            await hub.emit('orders', {id: 1})
            await nextPayload(received, 1)
            assert.deepEqual(received[0], {id: 1})
        })

        await check('status reports the subscription with the HTTP status and parsed body', async function statusRead() {
            const response = await client.status('orders')
            assert.equal(response.status, 200)
            assert.equal(response.data.subscribed, true)
            assert.equal(typeof response.data.expireAt, 'string')
        })

        await check('subscription and tag reads return parsed JSON', async function reads() {
            const mine = await client.getMySubscriptions()
            assert.equal(mine.length, 1)
            assert.equal(mine[0]!.tag, 'orders')
            assert.match(mine[0]!.url, new RegExp(`^http://127\\.0\\.0\\.1:${clientPort}/webHook_orders$`))
            assert.deepEqual(await client.getAvailableTags(), ['orders'])
            assert.deepEqual(client.tags(), ['orders'])
        })

        await check('Provider notifies through the server to the subscribed handler', async function provider() {
            await client.Provider('orders', {id: 2})
            await nextPayload(received, 2)
            assert.deepEqual(received[1], {id: 2})
        })

        await check('a refused request rejects instead of resolving', async function refused() {
            const intruder = createWebhookClient({serverUrl, clientPort, authToken: 'wrong', app: express()})
            await assert.rejects(intruder.connect('orders', () => undefined))
            await assert.rejects(intruder.getAvailableTags())
            await assert.rejects(intruder.status('orders'))
        })

        await check('unsubscribe ends delivery and the server forgets the url', async function unsubscribed() {
            await client.unsubscribe('orders')
            assert.equal((await client.status('orders')).data.subscribed, false)
            await hub.emit('orders', {id: 3})
            await new Promise(resolve => setTimeout(resolve, 50))
            assert.equal(received.length, 2)
            assert.deepEqual(client.tags(), [])
        })
        console.log(`PASS webhook3: ${passed}/6`)
    } finally {
        await client.unsubscribe()
        hubServer.close()
        clientServer.close()
    }
}

async function main() {
    await runChecks().catch(function failed(error) {
        console.error('FAIL webhook3:', error)
        process.exit(1)
    })
}

runOracle(main)
