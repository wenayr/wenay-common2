// An HTTP facade answers untrusted callers: a thrown error must reach them as facts
// (name, message, code, data, cause) and never as server stack frames.
import assert from 'node:assert/strict'
import express from 'express'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {createHttpFacadeServer} from '../../src/server/httpFacadeServer'
import {createServiceLeader} from '../../src/service/leader'
import {createServiceRest} from '../../src/service/rest'
import type {tServiceDefinition} from '../../src/service'
import {runOracle} from '../run-oracle'

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

/** Every `stack` key anywhere in a JSON body, with its path. */
function stacksIn(value: unknown, path = '$'): string[] {
    if (value == null || typeof value != 'object') return []
    const found: string[] = []
    for (const [key, child] of Object.entries(value)) {
        if (key == 'stack') found.push(path + '.stack')
        found.push(...stacksIn(child, path + '.' + key))
    }
    return found
}

async function listening(app: express.Express) {
    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const {port} = server.address() as AddressInfo
    return {url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve()))}
}

async function main() {
    const facade = {
        fail() {
            const cause = new Error('inner detail')
            throw Object.assign(new Error('outer failure', {cause}), {code: 'E_OUTER', data: {attempt: 2}})
        },
        plain() { throw {reason: 'not an Error'} },
    }
    const app = express()
    app.use(express.json())
    createHttpFacadeServer({app, object: facade, method: 'post', basePath: '/facade'})
    const definition = {
        name: 'stackless', storeId: 'stackless', originId: 'stackless', initial: {count: 0},
        commands: {explode: {apply() { throw new Error('command exploded') }}},
    } satisfies tServiceDefinition<{count: number}>
    const leader = createServiceLeader({definition, selfUrl: () => 'mem://stackless', log() {}})
    createServiceRest({app, leader, definition, pages: {panel: false, docs: false}})
    const server = await listening(app)
    try {
        await check('a throwing facade function answers 500 with name/message/code/data/cause and no stack', async function facadeError() {
            const response = await fetch(server.url + '/facade/fail', {method: 'POST'})
            const body = await response.json() as {ok: boolean, error: Record<string, any>}
            assert.equal(response.status, 500)
            assert.deepEqual(stacksIn(body), [], 'stack leaked: ' + JSON.stringify(body).slice(0, 300))
            assert.equal(body.error['name'], 'Error')
            assert.equal(body.error['message'], 'outer failure')
            assert.equal(body.error['code'], 'E_OUTER')
            assert.deepEqual(body.error['data'], {attempt: 2})
            assert.equal(body.error['cause']?.message, 'inner detail')
        })
        await check('a thrown non-Error value is still relayed as is', async function plainValue() {
            const response = await fetch(server.url + '/facade/plain', {method: 'POST'})
            const body = await response.json() as {ok: boolean, error: unknown}
            assert.equal(response.status, 500)
            assert.deepEqual(body.error, {reason: 'not an Error'})
        })
        await check('a malformed request answers 400 without a stack', async function badRequest() {
            const response = await fetch(server.url + '/facade/fail', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"args": 1}'})
            const body = await response.json()
            assert.equal(response.status, 400)
            assert.deepEqual(stacksIn(body), [], 'stack leaked: ' + JSON.stringify(body).slice(0, 300))
        })
        await check('a throwing service command on the REST corridor answers without a stack', async function restCommand() {
            const token = leader.identity.login('alice').token
            const response = await fetch(server.url + '/api/stackless/commands/explode', {
                method: 'POST',
                headers: {'content-type': 'application/json', authorization: 'Bearer ' + token},
                body: JSON.stringify({args: ['r1', {}]}),
            })
            const body = await response.json() as {ok: boolean, error: Record<string, unknown>}
            assert.equal(response.status, 500)
            assert.equal(body.error['message'], 'command exploded')
            assert.deepEqual(stacksIn(body), [], 'stack leaked: ' + JSON.stringify(body).slice(0, 300))
        })
        await check('a refused bearer on a REST view answers without a stack', async function restMe() {
            const response = await fetch(server.url + '/api/stackless/me', {headers: {authorization: 'Bearer forged'}})
            const body = await response.json()
            assert.equal(response.status, 500)
            assert.deepEqual(stacksIn(body), [], 'stack leaked: ' + JSON.stringify(body).slice(0, 300))
        })
    } finally {
        await server.close()
        await leader.control.close()
    }
    if (failed) process.exitCode = 1
    else console.log('PASS HTTP facade errors: facts relayed, stacks stay on the server')
}

runOracle(main)
