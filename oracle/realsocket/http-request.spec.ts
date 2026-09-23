// =====================================================================
//  httpRequest (src/Common/http-request.ts) against a loopback server: the internal fetch
//  primitive that replaced axios in server/webhook and the HTTPS resource. It must keep the
//  axios behaviours those callers relied on — non-2xx rejects, timeouts abort — and deliver
//  JSON bodies, query strings, redirects and binary bodies unchanged.
// =====================================================================
import assert from 'node:assert/strict'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import {httpRequest, HttpStatusError} from '../../src/Common/http-request'

const binary = Buffer.from(Array.from({length: 256}, (_, i) => i))

const server = http.createServer(function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://local')
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', function respond() {
        if (url.pathname == '/echo') {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({method: req.method, type: req.headers['content-type'] ?? null,
                auth: req.headers['authorization'] ?? null, query: Object.fromEntries(url.searchParams),
                body: Buffer.concat(chunks).toString()}))
        } else if (url.pathname == '/missing') { res.statusCode = 404; res.end('<html>not found</html>') }
        else if (url.pathname == '/redirect') { res.statusCode = 302; res.setHeader('location', '/binary'); res.end() }
        else if (url.pathname == '/binary') res.end(binary)
        else if (url.pathname == '/slow') setTimeout(() => res.end('late'), 2000)
        else { res.statusCode = 500; res.end() }
    })
})

async function main() {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
        const echoed = await (await httpRequest(`${base}/echo`, {method: 'POST', json: {tag: 'a'}, headers: {authorization: 't'}})).json()
        assert.deepEqual(echoed, {method: 'POST', type: 'application/json', auth: 't', query: {}, body: '{"tag":"a"}'})
        console.log('PASS  json body carries its content type and caller headers')

        const queried = await (await httpRequest(`${base}/echo`, {query: {url: ':1/webHook_a b&c'}})).json()
        assert.deepEqual(queried.query, {url: ':1/webHook_a b&c'})
        assert.equal(queried.method, 'GET')
        assert.equal(queried.type, null)
        console.log('PASS  query values are encoded; a GET without json sends no body type')

        const failure = await httpRequest(`${base}/missing`).then(() => null, error => error)
        assert.ok(failure instanceof HttpStatusError, 'a 404 must reject')
        assert.equal(failure.status, 404)
        assert.match(failure.message, /GET .*\/missing failed with status 404/)
        console.log('PASS  a non-2xx status rejects with its status instead of returning the error page')

        const bytes = Buffer.from(await (await httpRequest(`${base}/redirect`)).arrayBuffer())
        assert.deepEqual(bytes, binary)
        console.log('PASS  redirects are followed and binary bodies arrive byte-exact')

        const started = Date.now()
        await assert.rejects(httpRequest(`${base}/slow`, {timeoutMs: 100}), (error: Error) => error.name == 'TimeoutError')
        assert.ok(Date.now() - started < 1500, 'the timeout aborted before the slow response')
        console.log('PASS  timeoutMs aborts a slow response')
        console.log('PASS http-request: 5/5')
    } finally {
        server.closeAllConnections()
        server.close()
    }
}

main().catch(function failed(error) {
    console.error('FAIL http-request:', error)
    process.exit(1)
})
