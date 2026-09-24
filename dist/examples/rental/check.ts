import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createRentalClient, type RentalClient} from './rental-client'
import {runCheck} from './run-check'

// Compile-only checks: the consumer type must originate in the domain factory.
function typeContract(client: RentalClient) {
    // @ts-expect-error unknown domain command
    client.control.remove('request')
    // @ts-expect-error itemId must be a string
    client.control.book('request', {itemId: 1, from: '2026-10-01', to: '2026-10-03'})
    // @ts-expect-error result is a booking, not a number
    const result: Promise<number> = client.control.cancel('request', {bookingId: 'id'})
    return result
}
void typeContract

async function waitFor(check: () => boolean) {
    const deadline = Date.now() + 10_000
    while (!check()) {
        if (Date.now() > deadline) throw new Error('state did not catch up')
        await new Promise(function tick(resolve) { setTimeout(resolve, 25) })
    }
}

async function main() {
    const {startStand} = await import('./run.mjs')
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(startStand({signal: cancelled.signal}), /cancelled/)
    const stand = await startStand({nodes: 1})
    const clients: RentalClient[] = []
    const watchdog = setTimeout(function expired() {
        for (const client of clients) client.close()
        void stand.close()
        process.exitCode = 1
    }, 40_000)
    try {
        for (const suffix of ['/board', '/docs', '/openapi.json', '/docs/assets/swagger-ui-bundle.js']) {
            const response = await fetch(stand.url + suffix, {signal: AbortSignal.timeout(5000)})
            assert.equal(response.status, 200, suffix)
            await response.arrayBuffer()
        }
        const spec = await fetch(stand.url + '/openapi.json').then(response => response.json())
        assert(spec.paths['/api/rental/book'].post)
        for (const [index, url] of [stand.url, ...stand.nodeUrls].entries()) {
            const client = createRentalClient({url, token: stand.token, nodeId: 'check-' + index})
            clients.push(client)
            await client.ready
            const input = {itemId: index == 0 ? 'kayak' : 'tent', from: '2026-10-01', to: '2026-10-03'}
            const booked = await client.control.book('book-' + index, input)
            assert.equal(booked.account, 'demo-renter')
            assert.deepEqual(await client.control.book('book-' + index, input), booked)
            await assert.rejects(client.control.book('conflict-' + index, input))
            await waitFor(() => client.view.store.state.bookings[booked.id]?.state == 'active')
            if (index == 1) {
                const store = client.view.store
                let lostRoute = false
                const off = client.view.status.node.routeId.on(function routeChanged(route) { if (route == null) lostRoute = true })
                try {
                    await stand.restartNode(0)
                    await waitFor(() => lostRoute && client.view.status.state.role == 'follower'
                        && client.view.status.state.routes['rental-endpoint']?.state == 'open')
                } finally { off() }
                // A command after restart proves that the replacement write session is live too.
                assert.deepEqual(await client.control.book('book-' + index, input), booked)
                assert.equal(client.view.store, store)
            }
            await client.control.cancel('cancel-' + index, {bookingId: booked.id})
            await waitFor(() => client.view.store.state.bookings[booked.id]?.state == 'cancelled')
        }
        await new Promise<void>(function runApplication(resolve, reject) {
            const child = spawn(process.execPath, ['--import', 'tsx', 'example.ts'], {
                cwd: __dirname, env: {...process.env, RENTAL_URL: stand.nodeUrls[0], RENTAL_TOKEN: stand.token},
                stdio: 'ignore', windowsHide: true,
            })
            const timeout = setTimeout(function stop() { child.kill('SIGKILL') }, 25_000)
            child.once('error', function failed(error) { clearTimeout(timeout); reject(error) })
            child.once('exit', function exited(code) {
                clearTimeout(timeout)
                if (code == 0) resolve()
                else reject(new Error('example.ts failed: ' + code))
            })
        })
        console.log('PASS rental: HTTP/Swagger, authority + node clients, receipts, conflict, node restart, live state and example.ts')
    } finally {
        clearTimeout(watchdog)
        for (const client of clients) client.close()
        await stand.close()
    }
}

runCheck(main)
