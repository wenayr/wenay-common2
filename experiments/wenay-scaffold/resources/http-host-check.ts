import assert from 'node:assert/strict'
import {get} from 'node:http'
import {io} from 'socket.io-client'
import {createHostResource, type HostResource} from './http-host'
import {runCheck} from './run-check'

async function within<T>(pending: Promise<T>, label: string) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([pending, new Promise<never>(function timeout(_resolve, reject) {
            timer = setTimeout(function expired() { reject(new Error('timed out: ' + label)) }, 3000)
        })])
    } finally {
        clearTimeout(timer)
    }
}

async function check() {
    const hosts: HostResource[] = []
    function host(deps: Parameters<typeof createHostResource>[0]) {
        const resource = createHostResource(deps)
        hosts.push(resource)
        resource.resource.app.get('/', function healthy(_request, response) { response.send('healthy') })
        return resource
    }
    try {
        const first = host({port: 0, closeTimeoutMs: 40})
        const second = host({port: 0, host: '127.0.0.1'})
        assert.throws(first.view.url, /not listening/)
        const listening = first.control.listen()
        assert.strictEqual(first.control.listen(), listening)
        await Promise.all([listening, second.control.listen()])
        const firstUrl = first.view.url()
        assert.equal(new URL(firstUrl).hostname, 'localhost')
        assert.equal(new URL(second.view.url()).hostname, '127.0.0.1')
        assert.equal(await (await fetch(firstUrl)).text(), 'healthy')
        const port = Number(new URL(firstUrl).port)

        const occupied = host({port})
        await assert.rejects(occupied.control.listen(), function originalError(error: NodeJS.ErrnoException) {
            return error.code == 'EADDRINUSE'
        })
        await occupied.close()
        assert.equal((await fetch(firstUrl)).status, 200)

        let reentrantClose: Promise<void> | undefined
        first.resource.io.on('connection', function watchClose(peer) {
            peer.on('disconnect', function closeFromCallback() { reentrantClose = first.close() })
        })
        const socket = io(firstUrl, {transports: ['websocket'], reconnection: false, forceNew: true})
        try {
            await within(new Promise<void>(function connected(resolve, reject) {
                socket.once('connect', resolve)
                socket.once('connect_error', reject)
            }), 'socket connection')
            const disconnected = new Promise<void>(function waitDisconnect(resolve) {
                socket.once('disconnect', function gone() { resolve() })
            })
            let requestSeen!: () => void
            const active = new Promise<void>(function waitRequest(resolve) { requestSeen = resolve })
            first.resource.app.get('/slow', function slow(_request, _response) { requestSeen() })
            const request = get(firstUrl + '/slow')
            request.on('error', function expectedDisconnect() {})
            try {
                await within(active, 'active HTTP request')
                const closing = first.close()
                assert.strictEqual(first.close(), closing)
                assert.strictEqual(reentrantClose, closing)
                await within(closing, 'bounded active HTTP shutdown')
                await within(disconnected, 'Socket.IO shutdown')
                assert.equal(socket.connected, false)
                await assert.rejects(first.control.listen(), /closed/)
                assert.throws(first.view.url, /not listening/)
            } finally {
                request.destroy()
            }
        } finally {
            socket.disconnect()
        }
        assert.equal((await fetch(second.view.url())).status, 200)
        const replacement = host({port})
        await replacement.control.listen()
        assert.equal((await fetch(replacement.view.url())).status, 200)

        const unbound = host({port: 0})
        const unboundClose = unbound.close()
        assert.strictEqual(unbound.close(), unboundClose)
        await within(unboundClose, 'unbound shutdown')
        await assert.rejects(unbound.control.listen(), /closed/)

        const binding = host({host: 'localhost', port: 0})
        const ready = binding.control.listen()
        const rejected = assert.rejects(ready, /closed while binding/)
        const bindingClose = binding.close()
        assert.strictEqual(binding.close(), bindingClose)
        await within(Promise.all([rejected, bindingClose]), 'close during binding')
        await assert.rejects(binding.control.listen(), /closed/)
        console.log('PASS HTTP host: independent instances, original bind error, bounded active HTTP and Socket.IO shutdown, port reuse, shared close and close during bind')
    } finally {
        await within(Promise.all(hosts.map(resource => resource.close())), 'all hosts cleanup')
    }
}

runCheck(check)
