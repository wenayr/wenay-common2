import assert from 'node:assert/strict'
import {spawn, spawnSync} from 'node:child_process'
import {mkdtemp, mkdir, copyFile, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createTokenCodec} from '../../../../src/server/auth-token'
import type {RentalBooking} from './service'
import {runCheck} from '../../resources/run-check'

async function check() {
    const temp = await realpath(tmpdir())
    const work = await mkdtemp(path.join(temp, 'rental-durable-'))
    const data = path.join(work, 'data')
    const backup = path.join(work, 'backup')
    const tokenSecret = 'rental-durable-check-token-secret'
    const token = createTokenCodec({secret: tokenSecret, ttlMs: 60_000}).issue({sub: 'demo-renter'})
    const stops: (() => Promise<void>)[] = []

    async function boot(directory: string) {
        const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'leader-rental.ts')], {
            env: {...process.env, RENTAL_PORT: '0', SERVICE_DATA_DIR: directory,
                SERVICE_NODE_TOKEN: 'rental-durable-check-node-secret', SERVICE_TOKEN_SECRET: tokenSecret},
            stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        })
        let output = ''
        let failure: Error | undefined
        let exited = false
        const done = new Promise<void>(function stopped(resolve) {
            child.once('error', function failed(error) { failure = error; exited = true; resolve() })
            child.once('exit', function ended() { exited = true; resolve() })
        })
        child.stdout.on('data', function capture(chunk) { output = (output + String(chunk)).slice(-16000) })
        child.stderr.resume()
        async function stop() {
            if (!exited) child.kill('SIGKILL')
            await done
        }
        stops.push(stop)
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
            if (failure || exited) throw new Error('rental durable process failed before ready')
            const match = /leader listening on (http:\/\/localhost:\d+)/.exec(output)
            if (match) return {url: match[1], stop}
            await new Promise(function tick(resolve) { setTimeout(resolve, 20) })
        }
        throw new Error('rental durable process readiness timeout')
    }

    async function command(url: string, name: 'book' | 'cancel', id: string, input: object) {
        const response = await fetch(url + '/api/rental/' + name, {
            method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
            body: JSON.stringify({args: [id, input]}), signal: AbortSignal.timeout(5000),
        })
        const envelope = await response.json()
        assert.equal(response.ok && envelope.ok, true, 'rental command should succeed: ' + name)
        return envelope.value as RentalBooking
    }

    async function assertRestored(url: string, booked: RentalBooking, cancelled: RentalBooking, held: RentalBooking) {
        // Original active reply after cancellation proves the control receipt survived, not just the row.
        assert.deepEqual(await command(url, 'book', 'original-book', {
            itemId: 'kayak', from: '2026-10-01', to: '2026-10-03',
        }), booked)
        assert.deepEqual(await command(url, 'cancel', 'original-cancel', {bookingId: booked.id}), cancelled)
        const board = await fetch(url + '/api/rental/board', {signal: AbortSignal.timeout(5000)}).then(response => response.json())
        assert.equal(board.ok, true)
        assert.equal(board.value.bookings.length, 1)
        assert.equal(board.value.bookings[0].id, held.id)
        const conflict = await fetch(url + '/api/rental/book', {
            method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
            body: JSON.stringify({args: ['conflict', {itemId: 'tent', from: '2026-10-01', to: '2026-10-03'}]}),
            signal: AbortSignal.timeout(5000),
        })
        assert.equal((await conflict.json()).ok, false, 'restored active booking still prevents overlap')
    }

    try {
        const first = await boot(data)
        const booked = await command(first.url, 'book', 'original-book', {itemId: 'kayak', from: '2026-10-01', to: '2026-10-03'})
        const cancelled = await command(first.url, 'cancel', 'original-cancel', {bookingId: booked.id})
        const held = await command(first.url, 'book', 'held-book', {itemId: 'tent', from: '2026-10-01', to: '2026-10-03'})
        assert.equal(booked.state, 'active')
        assert.equal(cancelled.state, 'cancelled')
        await first.stop()
        const restarted = await boot(data)
        await assertRestored(restarted.url, booked, cancelled, held)
        await restarted.stop()
        const incomplete = path.join(work, 'incomplete')
        await mkdir(incomplete)
        await copyFile(path.join(data, 'rental.jsonl'), path.join(incomplete, 'rental.jsonl'))
        const refused = spawnSync(process.execPath, ['--import', 'tsx', path.join(__dirname, 'leader-rental.ts')], {
            env: {...process.env, RENTAL_PORT: '0', SERVICE_DATA_DIR: incomplete,
                SERVICE_NODE_TOKEN: 'rental-durable-check-node-secret', SERVICE_TOKEN_SECRET: tokenSecret},
            encoding: 'utf8', timeout: 10000, windowsHide: true,
        })
        assert.equal(refused.error, undefined)
        assert.equal(refused.status, 2, 'an incomplete archive pair must refuse startup')
        assert.match(refused.stderr, /requires both archives/)
        // Copy the complete pair only while its sole writer is stopped.
        await mkdir(backup)
        for (const file of ['rental.jsonl', 'rental.control.jsonl']) {
            await copyFile(path.join(data, file), path.join(backup, file))
        }
        const restored = await boot(backup)
        await assertRestored(restored.url, booked, cancelled, held)
        await restored.stop()
        console.log('PASS durable rental: acknowledged data and original receipts survive process kill/restart and stopped two-archive backup restore')
    } finally {
        await Promise.all(stops.map(stop => stop()))
        const resolved = await realpath(work)
        assert.equal(path.dirname(resolved), temp)
        assert(path.basename(resolved).startsWith('rental-durable-'))
        await rm(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 100})
    }
}

runCheck(check)
