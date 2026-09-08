import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createServiceLeader} from '../../experiments/wenay-scaffold/template/leader'
import {serviceDefinition} from '../../experiments/wenay-scaffold/examples/rental/service'

test('rental scopes opaque booking identities to the verified account', async function scopedBookingIdentity() {
    const leader = createServiceLeader({definition: serviceDefinition, selfUrl: () => 'mem://rental', log() {}})
    try {
        const alice = leader.serve.browserFragment('alice-private').identity.login().token
        const bob = leader.serve.browserFragment('bob-private').identity.login().token
        const commands = leader.corridor.byToken()
        const firstInput = {itemId: 'kayak', from: '2026-10-01', to: '2026-10-03'}
        const secondInput = {itemId: 'tent', from: '2026-10-01', to: '2026-10-03'}
        const first = await commands.book(alice, 'same-request', firstInput)
        const second = await commands.book(bob, 'same-request', secondInput)
        assert.notEqual(first.id, second.id)
        const bookings = leader.line.control.store.snapshot().bookings
        assert.equal(Object.keys(bookings).length, 2)
        assert.equal(bookings[first.id].account, 'alice-private')
        assert.equal(bookings[second.id].account, 'bob-private')
        assert.deepEqual(await commands.book(alice, 'same-request', firstInput), first)
        await assert.rejects(commands.cancel(bob, 'steal', {bookingId: first.id}), /owner/)
        const board = serviceDefinition.readerFacet(leader.line.control.store.snapshot())
        assert.equal(board.bookings.length, 2)
        assert(!JSON.stringify(board).includes('alice-private'))
        assert(!JSON.stringify(board).includes('bob-private'))
        await commands.cancel(alice, 'cancel', {bookingId: first.id})
        assert.equal(leader.line.control.store.state.bookings[second.id].state, 'active')
        const saved = leader.line.control.store.snapshot()
        const restarted = createServiceLeader({
            definition: {...serviceDefinition, initial: saved}, selfUrl: () => 'mem://rental-restored', log() {},
        })
        try {
            const token = restarted.serve.browserFragment('alice-private').identity.login().token
            const before = restarted.line.control.store.snapshot()
            await assert.rejects(restarted.corridor.byToken().book(token, 'same-request', {
                itemId: 'ebike', from: '2026-11-01', to: '2026-11-03',
            }), /booking identity already exists/)
            assert.deepEqual(restarted.line.control.store.snapshot(), before)
        } finally { restarted.control.close() }
    } finally { leader.control.close() }
})
