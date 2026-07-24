import express, {type NextFunction, type Request, type Response} from 'express'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'

import {unpackResult} from '../../src/Common/rcp/rpc-walk'
import {createHttpFacadeServer} from '../../src/server'

function assert(condition: unknown, message: string) {
    if (!condition) throw new Error(message)
}

async function main() {
    const calls: Array<{kind: string; limit: number}> = []
    const facade = {
        status: () => ({ready: true}),
        journal: {
            history: function history(kind: string, limit: number) {
                calls.push({kind, limit})
                return {
                    at: new Date('2026-07-22T10:00:00.000Z'),
                    counts: new Map([[kind, limit]]),
                }
            },
            acceptsDate: (at: Date) => at instanceof Date ? at.getUTCFullYear() : 0,
            withCallback: function withCallback(_value: number, callback: (value: number) => void) {
                callback(_value)
            },
            fail: function fail() {
                const error = new Error('journal failed') as Error & {code: string}
                error.code = 'E_JOURNAL'
                throw error
            },
        },
    }

    const app = express()
    app.use(express.json())
    const getServer = createHttpFacadeServer({app, object: facade, method: 'get', basePath: '/inspect'})
    const postServer = createHttpFacadeServer({app, object: facade, method: 'post', basePath: '/inspect'})
    function authorize(req: Request, res: Response, next: NextFunction) {
        if (req.get('authorization') == 'Bearer test-token') {
            next()
            return
        }
        res.status(401).json({ok: false, error: {message: 'Unauthorized'}})
    }
    createHttpFacadeServer({
        app,
        object: {ping: () => 'pong'},
        method: 'post',
        basePath: '/secure',
        middleware: authorize,
    })
    const server = createServer(app)

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const {port} = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}`

    try {
        const getArgs = encodeURIComponent(JSON.stringify(['error', 2]))
        const getResponse = await fetch(`${url}/inspect/journal/history?args=${getArgs}`)
        const getBody = await getResponse.json() as any
        const getValue = unpackResult(getBody.value)
        assert(getResponse.status == 200 && getBody.ok == true, 'nested GET route did not respond successfully')
        assert(getValue.at instanceof Date, 'GET result did not restore Date through the RPC codec')
        assert(getValue.counts instanceof Map && getValue.counts.get('error') == 2,
            'GET result did not restore Map through the RPC codec')

        const postResponse = await fetch(`${url}/inspect/journal/history`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({args: ['warning', 3]}),
        })
        const postBody = await postResponse.json() as any
        const postValue = unpackResult(postBody.value)
        assert(postResponse.status == 200 && postBody.ok == true, 'nested POST route did not respond successfully')
        assert(postValue.counts.get('warning') == 3, 'POST positional args did not reach the facade function')

        const richArgResponse = await fetch(`${url}/inspect/journal/acceptsDate`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({args: [{$_d: Date.UTC(2024, 0, 1)}]}),
        })
        const richArgBody = await richArgResponse.json() as any
        assert(richArgBody.ok == true && richArgBody.value == 2024,
            'POST args did not restore a rich RPC value')

        const invalidResponse = await fetch(`${url}/inspect/status?args=${encodeURIComponent('{}')}`)
        const invalidBody = await invalidResponse.json() as any
        assert(invalidResponse.status == 400 && invalidBody.ok == false,
            'invalid GET args did not produce a request error')

        const failResponse = await fetch(`${url}/inspect/journal/fail`)
        const failBody = await failResponse.json() as any
        assert(failResponse.status == 500 && failBody.error.code == 'E_JOURNAL',
            'facade error did not retain its code')

        const unauthorizedResponse = await fetch(`${url}/secure/ping`, {method: 'POST'})
        assert(unauthorizedResponse.status == 401, 'HTTP facade middleware did not reject an unauthorized request')
        const authorizedResponse = await fetch(`${url}/secure/ping`, {
            method: 'POST',
            headers: {authorization: 'Bearer test-token'},
        })
        const authorizedBody = await authorizedResponse.json() as any
        assert(authorizedResponse.status == 200 && authorizedBody.value == 'pong',
            'HTTP facade middleware did not pass an authorized request')

        const getRoutes = getServer.routes()
        const postRoutes = postServer.routes()
        assert(getRoutes.some(item => item.route == '/inspect/journal/withCallback'),
            'callback-shaped function was incorrectly filtered from route discovery')
        assert(postRoutes.every(item => item.method == 'post'), 'POST route metadata has a wrong method')
        assert(calls.length == 2 && calls[0].kind == 'error' && calls[1].kind == 'warning',
            'facade functions were invoked an unexpected number of times')

        let duplicate = ''
        try {
            createHttpFacadeServer({app, object: facade, method: 'get', basePath: '/inspect'})
        } catch (error: any) {
            duplicate = error?.message ?? String(error)
        }
        assert(duplicate.includes('already registered'), 'duplicate route registration was not rejected')

        console.log('PASS HTTP facade recursively exposes nested GET and POST routes')
        console.log('PASS HTTP facade preserves positional args, rich values, and errors')
        console.log('PASS HTTP facade exposes callback-shaped functions without guessing their signature')
        console.log('PASS HTTP facade applies authorization middleware before generated routes')
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
}

main().catch(function reportFailure(error) {
    console.error(error?.stack ?? error)
    process.exitCode = 1
})
