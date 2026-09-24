// =====================================================================
//  WebHook3 /webHook_client_subscriptions lists a caller's OWN subscriptions: every subscriber
//  url is http://<client ip>:..., so the filter must match the hostname exactly. A string-prefix
//  match lets 127.0.0.1 read what 127.0.0.10 (or 10.0.0.1 → 10.0.0.12) subscribed.
//  Two loopback source addresses stand in for two machines (127.0.0.0/8 is loopback).
// =====================================================================
import assert from 'node:assert/strict'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import express from 'express'
import {createWebhookServer} from '../../src/server/WebHook3'

const token = 'client-subscriptions-token'

function request(port: number, localAddress: string, method: string, path: string, body?: unknown) {
    return new Promise<{status: number, json: any}>(function send(resolve, reject) {
        const payload = body === undefined ? undefined : JSON.stringify(body)
        const req = http.request({host: '127.0.0.1', port, path, method, localAddress, agent: false,
            headers: {authorization: token, ...(payload ? {'content-type': 'application/json'} : {})}}, function answered(res) {
            let text = ''
            res.on('data', chunk => text += chunk)
            res.on('end', () => resolve({status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null}))
        })
        req.on('error', reject)
        req.end(payload)
    })
}

async function main() {
    const app = express()
    app.use(express.json())
    createWebhookServer({authToken: token, port: 0, app, file: {loadSubscribers: () => new Map(), saveSubscribers() {}}})
    const server = http.createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const {port} = server.address() as AddressInfo
    try {
        const other = await request(port, '127.0.0.10', 'POST', '/webHook_subscribe', {url: ':5555/webHook_x', tag: 'x'})
        assert.equal(other.status, 200, 'the 127.0.0.10 client could not subscribe: ' + JSON.stringify(other.json))
        const own = await request(port, '127.0.0.1', 'POST', '/webHook_subscribe', {url: ':6666/webHook_y', tag: 'y'})
        assert.equal(own.status, 200)

        const mine = await request(port, '127.0.0.1', 'GET', '/webHook_client_subscriptions')
        const urls = (mine.json as {url: string}[]).map(s => s.url)
        assert.deepEqual(urls, ['http://127.0.0.1:6666/webHook_y'], 'listed another client\'s subscriptions: ' + JSON.stringify(urls))
        console.log('PASS  a client lists only the subscriptions of its own address')

        const theirs = await request(port, '127.0.0.10', 'GET', '/webHook_client_subscriptions')
        assert.deepEqual((theirs.json as {url: string}[]).map(s => s.url), ['http://127.0.0.10:5555/webHook_x'])
        console.log('PASS  the other address still sees its own')
        console.log('PASS webhook3 client subscriptions: exact address, no prefix leak')
    } finally {
        server.closeAllConnections()
        server.close()
    }
}

main().catch(function failed(error) {
    console.error('FAIL webhook3 client subscriptions:', error?.message ?? error)
    process.exitCode = 1
})
