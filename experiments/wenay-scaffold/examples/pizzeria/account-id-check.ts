import assert from 'node:assert/strict'
import {createServiceLeader} from '../../template/leader'
import {serviceDefinition} from './service'
import {runCheck} from '../../resources/run-check'

async function main() {
    const leader = createServiceLeader({definition: serviceDefinition, selfUrl: () => 'http://localhost', log: () => {}})
    try {
        await leader.serve.signup('signup-collision', {account: 'dana', name: 'Dana', phone: '', password: 'dana-pass'})
        const input = {items: ['margherita'], address: 'Same Street'}
        const alice = await leader.corridor.execute('alice', 'placeOrder', 'shared-request', input)
        const dana = await leader.corridor.execute('dana', 'placeOrder', 'shared-request', input)
        assert.notEqual(alice.id, dana.id, 'different accounts must not overwrite the same order')
        assert.equal(leader.view.state().orders[alice.id].customer, 'alice')
        assert.equal(leader.view.state().orders[dana.id].customer, 'dana')
        const retry = await leader.corridor.execute('alice', 'placeOrder', 'shared-request', input)
        assert.equal(retry.id, alice.id, 'same account and request replay their receipt')
        assert.equal(Object.keys(leader.view.state().orders).length, 2)
        assert.match(alice.id, /^o-[a-f0-9]{64}$/, 'public identifiers expose no raw account or request tuple')
        const saved = leader.line.control.store.snapshot()
        const restored = createServiceLeader({definition: {...serviceDefinition, initial: saved}, selfUrl: () => 'http://localhost', log: () => {}})
        try {
            await assert.rejects(restored.corridor.execute('alice', 'placeOrder', 'shared-request', {items: ['diavola'], address: 'Changed'}), /already used/)
            assert.deepEqual(restored.line.control.store.snapshot(), saved, 'an expired receipt cannot overwrite its surviving order')
        } finally { restored.control.close() }
        console.log('PASS pizzeria account-scoped order identifiers and receipt retries')
    } finally { leader.control.close() }
}

runCheck(main)

