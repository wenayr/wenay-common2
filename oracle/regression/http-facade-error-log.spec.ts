// HTTP callers get error facts without stack frames (http-facade-error-stack.spec.ts); the operator
// must still see the whole error. The facade hands it to `onError` with its route and status, a
// throwing hook never breaks the response, and the service REST logs every 5xx through `log`.
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

async function listening(app: express.Express) {
    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const {port} = server.address() as AddressInfo
    return {url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve()))}
}

async function post(url: string, args: unknown[]) {
    const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(args)})
    return {status: response.status, body: await response.json() as {ok: boolean, error?: Record<string, unknown>}}
}

async function main() {
    const seen: {error: unknown, route: string, status: number}[] = []
    const app = express()
    app.use(express.json())
    createHttpFacadeServer({
        app, method: 'post', basePath: '/facade',
        object: {fail() { throw new Error('facade exploded') }},
        onError(error, context) { seen.push({error, ...context}) },
    })
    createHttpFacadeServer({
        app, method: 'post', basePath: '/hostile',
        object: {fail() { throw new Error('hook victim') }},
        onError() { throw new Error('the operator hook itself failed') },
    })
    const logged: string[] = []
    const definition = {
        name: 'logged', storeId: 'logged', originId: 'logged', initial: {count: 0},
        commands: {explode: {apply() { throw new Error('command exploded') }}},
    } satisfies tServiceDefinition<{count: number}>
    const leader = createServiceLeader({definition, selfUrl: () => 'mem://logged', log() {}})
    createServiceRest({app, leader, definition, pages: {panel: false, docs: false}, log(line) { logged.push(line) }})
    const server = await listening(app)
    try {
        await check('onError receives the whole server error with its route and status; the caller gets no stack', async function hookSeesError() {
            const {status, body} = await post(`${server.url}/facade/fail`, [])
            assert.equal(status, 500)
            assert.equal(body.error?.['message'], 'facade exploded')
            assert.equal(body.error?.['stack'], undefined)
            assert.equal(seen.length, 1, 'the hook was not called')
            const [entry] = seen
            assert.ok(entry!.error instanceof Error && /at /.test(entry!.error.stack ?? ''), 'the hook got no stack frames')
            assert.equal(entry!.status, 500)
            assert.match(entry!.route, /fail/)
        })

        await check('a throwing onError hook never breaks the response', async function hostileHook() {
            const {status, body} = await post(`${server.url}/hostile/fail`, [])
            assert.equal(status, 500)
            assert.equal(body.error?.['message'], 'hook victim')
        })

        await check('the service REST logs a 5xx with its stack through log', async function restLogs() {
            const token = leader.identity.login('someone').token
            const response = await fetch(`${server.url}/api/logged/commands/explode`, {
                method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
                body: JSON.stringify(['req-1', {}]),
            })
            assert.equal(response.status, 500)
            const line = logged.find(entry => entry.includes('command exploded'))
            assert.ok(line, `no log line for the 500; log: ${JSON.stringify(logged)}`)
            assert.match(line!, /at /, 'the log line carries no stack frames')
        })
    } finally {
        await server.close()
        await leader.control.close()
    }
    // exitCode, not exit(): closing sockets must drain first (libuv asserts on Windows otherwise)
    if (failed) process.exitCode = 1
    else console.log('PASS http facade error log: operator sees the error, callers see facts')
}

runOracle(main)
