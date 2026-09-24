// WebHook3 server hardening through its facade over real HTTP (loopback, memory store):
//   - the bearer is compared in constant time (a string !== stops at the first differing char);
//   - one authenticated client IP cannot grow the subscriber table (and subscribers.json) without bound.
import assert from 'node:assert/strict'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import express from 'express'
import {createWebhookServer} from '../../src/server/WebHook3'

// Spy on the constant-time primitive: timing itself is not measurable reliably over loopback HTTP.
const nodeCrypto = require('node:crypto') as typeof import('node:crypto')
const timingSafeEqual = nodeCrypto.timingSafeEqual
let constantTimeChecks = 0
nodeCrypto.timingSafeEqual = function countedTimingSafeEqual(a, b) {
    constantTimeChecks++
    return timingSafeEqual(a, b)
}

const token = 'webhook-hardening-token-0123456789'
let failed = 0
async function check(label: string, run: () => Promise<void>) {
    try {
        await run()
        console.log('PASS ' + label)
    } catch (error) {
        failed++
        console.log('FAIL ' + label + ': ' + ((error as Error)?.message ?? error))
    }
}

async function hub(extra: {maxSubscribersPerIp?: number} = {}) {
    let saves = 0
    const file = {loadSubscribers: () => new Map(), saveSubscribers() { saves++ }}
    const app = express()
    app.use(express.json())
    createWebhookServer({authToken: token, port: 0, app, file, ...extra})
    const server = http.createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
        url, saves: () => saves,
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
        request(method: string, route: string, body?: unknown, authorization: string | null = token) {
            return fetch(url + route, {method, headers: {'content-type': 'application/json', ...(authorization != null ? {authorization} : {})},
                ...(body != undefined ? {body: JSON.stringify(body)} : {})})
        },
    }
}

async function main() {
    const hubs: Awaited<ReturnType<typeof hub>>[] = []
    try {
        await check('the bearer is compared in constant time; right passes, wrong/longer/missing are refused', async function bearer() {
            const server = await hub()
            hubs.push(server)
            const before = constantTimeChecks
            const right = await server.request('GET', '/webHook_all_tags')
            const sameLength = await server.request('GET', '/webHook_all_tags', undefined, token.slice(0, -1) + 'x')
            const longer = await server.request('GET', '/webHook_all_tags', undefined, token + 'x')
            const missing = await server.request('GET', '/webHook_all_tags', undefined, null)
            assert.deepEqual([right.status, sameLength.status, longer.status, missing.status], [200, 403, 403, 403])
            assert(constantTimeChecks - before >= 2, `timingSafeEqual consulted ${constantTimeChecks - before} times for 4 requests`)
        })

        await check('one client IP cannot register more than 32 distinct subscribers by default (429)', async function defaultCap() {
            const server = await hub()
            hubs.push(server)
            for (let index = 0; index < 32; index++) {
                const answer = await server.request('POST', '/webHook_subscribe', {url: `:${20_000 + index}/webHook_orders`, tag: 'orders'})
                assert.equal(answer.status, 200, 'subscriber ' + index)
            }
            const saves = server.saves()
            const refused = await server.request('POST', '/webHook_subscribe', {url: ':20032/webHook_orders', tag: 'orders'})
            assert.equal(refused.status, 429)
            assert.equal(server.saves(), saves, 'a refused subscription must not rewrite the store')
            const renewed = await server.request('POST', '/webHook_subscribe', {url: ':20000/webHook_orders', tag: 'orders'})
            assert.equal(renewed.status, 200, 're-subscribing a known url is a renewal, not a new subscriber')
            const removed = await server.request('DELETE', '/webHook_unsubscribe', {url: ':20001/webHook_orders'})
            assert.equal(removed.status, 200)
            const freed = await server.request('POST', '/webHook_subscribe', {url: ':20032/webHook_orders', tag: 'orders'})
            assert.equal(freed.status, 200, 'an unsubscribed slot is free again')
        })

        await check('the cap is configurable through params.maxSubscribersPerIp', async function configuredCap() {
            const server = await hub({maxSubscribersPerIp: 2})
            hubs.push(server)
            const statuses: number[] = []
            for (let index = 0; index < 3; index++) {
                statuses.push((await server.request('POST', '/webHook_subscribe', {url: `:${21_000 + index}/webHook_orders`, tag: 'orders'})).status)
            }
            assert.deepEqual(statuses, [200, 200, 429])
        })
    } finally {
        for (const server of hubs) await server.close()
        nodeCrypto.timingSafeEqual = timingSafeEqual
    }
    if (failed) process.exitCode = 1
    else console.log('PASS webhook3 hardening: constant-time bearer, bounded subscribers per client IP')
}

main().catch(function crashed(error) { console.error(error); process.exitCode = 1 })
