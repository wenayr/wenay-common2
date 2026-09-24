// The leader host admits a node link only for the fleet's node token. The check must be a
// constant-time comparison of the presented STRING: loose `!=` stops at the first differing
// character and also coerces a non-string (an array holding the token) into a match.
import assert from 'node:assert/strict'
import {io} from 'socket.io-client'
import {createRpcClient} from '../../src/Common/rcp/rpc-client'
import {createServiceLeaderHost} from '../../src/service/host'
import type {tServiceDefinition} from '../../src/service'

// Spy on the constant-time primitive: timing itself is not measurable reliably over loopback.
const nodeCrypto = require('node:crypto') as typeof import('node:crypto')
const timingSafeEqual = nodeCrypto.timingSafeEqual
let constantTimeChecks = 0
nodeCrypto.timingSafeEqual = function countedTimingSafeEqual(a, b) {
    constantTimeChecks++
    return timingSafeEqual(a, b)
}

const definition = {
    name: 'node-token', storeId: 'node-token', originId: 'node-token', initial: {count: 0}, commands: {},
} satisfies tServiceDefinition<{count: number}>

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

/** One node-link attempt: 'linked' when the node-link key answers, 'refused' when the host drops the socket. */
function linkAttempt(url: string, token: unknown) {
    const socket = io(url, {transports: ['websocket'], forceNew: true, reconnection: false, auth: {role: 'service-node', node: 'probe-node', token}})
    return new Promise<'linked' | 'refused' | 'timeout'>(function attempt(resolve) {
        const timer = setTimeout(function expired() { resolve('timeout') }, 3000)
        socket.once('disconnect', function dropped() { clearTimeout(timer); resolve('refused') })
        socket.once('connect_error', function failedDial() { clearTimeout(timer); resolve('refused') })
        const link = createRpcClient<any>({socket: socket as any, socketKey: 'node-link'})
        link.readyStrict().then(function answered() { clearTimeout(timer); resolve('linked') }, function rejected() {})
    }).finally(function closeProbe() { socket.close() })
}

async function main() {
    const host = await createServiceLeaderHost({definition, host: '127.0.0.1', env: {}, rest: false})
    const token = host.leader.secrets.nodeToken
    try {
        await check('the fleet token links, and the check runs through a constant-time comparison', async function fleetToken() {
            const before = constantTimeChecks
            assert.equal(await linkAttempt(host.url, token), 'linked')
            assert.equal(await linkAttempt(host.url, token.slice(0, -1) + (token.endsWith('x') ? 'y' : 'x')), 'refused')
            assert(constantTimeChecks - before >= 2, `timingSafeEqual consulted ${constantTimeChecks - before} times for 2 attempts`)
        })
        await check('shorter, longer and missing tokens are refused', async function wrongTokens() {
            assert.equal(await linkAttempt(host.url, token.slice(0, -1)), 'refused')
            assert.equal(await linkAttempt(host.url, token + 'x'), 'refused')
            assert.equal(await linkAttempt(host.url, undefined), 'refused')
        })
        await check('a non-string token is refused, never coerced into a match', async function coercedToken() {
            assert.equal(await linkAttempt(host.url, [token]), 'refused')
        })
    } finally {
        await host.close()
        nodeCrypto.timingSafeEqual = timingSafeEqual
    }
    if (failed) process.exitCode = 1
    else console.log('PASS service node token: constant-time string comparison on the node link')
}

main().catch(function crashed(error) { console.error(error); process.exitCode = 1 })
