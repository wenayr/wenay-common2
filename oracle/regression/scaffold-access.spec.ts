import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {createStore, listenStorePatches} from '../../src/Common/Observe/store'
import {createStoreFollower} from '../../src/Common/Observe/store-follower'
import {listen} from '../../src/Common/events/Listen'
import {createServiceAccess} from '../../experiments/wenay-scaffold/template/access'
import type {tServiceDefinition} from '../../experiments/wenay-scaffold/template/leader'
import {runOracle} from '../run-oracle'

const initial = {roles: {manager: ['manager'], other: ['manager']}, inventory: {flour: 5}}
const definition = {
    name: 'access-check', storeId: 'access-check', originId: 'leader', initial,
    access: {rolesOf: (state: typeof initial, account: string) => state.roles[account as keyof typeof state.roles] ?? []},
    commands: {change: {allow: ['manager'], apply() { return true }}},
    views: {
        inventory: {allow: ['manager'], shared: true, keys: ['inventory'], project: (state: typeof initial) => ({inventory: state.inventory})},
        public: {allow: 'public', project: () => ({open: true})},
    },
} satisfies tServiceDefinition<typeof initial>

async function until(check: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (check()) return
        await delay(10)
    }
    assert.fail('projection did not settle')
}

async function main() {
    const store = createStore(initial)
    const baseline = listenStorePatches(store).count()
    const access = createServiceAccess({definition, store})
    const [gone, goneListen] = listen<[]>()
    const session = {nodeId: 'node', onGone: goneListen.on}
    const [otherGone, otherListen] = listen<[]>()
    const otherSession = {nodeId: 'node', onGone: otherListen.on}
    const defaults = {whoami: () => 'manager', commands: {change: () => true}}
    const first = access.principal({account: 'manager'}, defaults, session)
    const other = access.principal({account: 'other'}, defaults, otherSession)
    const mirror = createStoreFollower({remote: first.views.inventory})
    const otherMirror = createStoreFollower({remote: other.views.inventory})
    const rights = createStoreFollower({remote: first.permissions})
    const oldCommand = first.commands.change
    const oldKeyframe = first.views.inventory.keyframe
    try {
        await Promise.all([mirror.ready, otherMirror.ready, rights.ready])
        assert.notEqual(first.views.inventory, other.views.inventory, 'shared content must retain a session access boundary')
        assert.equal(first.views.public, other.views.public)
        const seq = mirror.status.state.seq
        store.state.roles.manager = []
        await until(() => !('inventory' in mirror.store.state))
        assert.deepEqual(mirror.store.snapshot(), {}, 'role dependency outside view.keys clears the original mirror')
        assert.deepEqual(rights.store.state.commands, [])
        assert.deepEqual(first.me().roles, [], 'me reads current local roles')
        assert.throws(oldCommand, /forbidden/)
        assert.throws(oldKeyframe, /forbidden/)
        assert.throws(() => first.views.inventory.since(seq - 1), /forbidden/, 'old journal is guarded too')
        store.state.inventory.flour = 99
        await until(() => otherMirror.store.state.inventory.flour == 99)
        assert.deepEqual(mirror.store.snapshot(), {}, 'no private changes reach the revoked subscriber')
        assert.equal(otherMirror.store.state.inventory.flour, 99)
        const removed = access.principal({account: 'manager'}, defaults, session)
        assert.equal(removed.commands.change, null)
        assert.equal(removed.views.inventory, undefined)
        assert.equal(removed.permissions, first.permissions, 'reauth reuses the permissions resource')
        store.state.roles.manager = ['manager']
        await until(() => mirror.store.state.inventory?.flour == 99)
        const restored = access.principal({account: 'manager'}, defaults, session)
        assert.equal(restored.commands.change(), true)
        assert.equal(mirror.store.state.inventory.flour, 99)
        for (let index = 0; index < 20; index++) access.principal({account: 'manager'}, defaults, session)
        assert.equal(goneListen.count(), 1, 'reauth does not accumulate session cleanup or projection resources')
        gone()
        assert.throws(restored.commands.change, /closed/)
        assert.throws(restored.views.inventory.keyframe, /closed/)
    } finally {
        mirror.close(); otherMirror.close(); rights.close()
        gone(); otherGone(); access.close()
        goneListen.close(); otherListen.close()
    }
    assert.equal(listenStorePatches(store).count(), baseline)
    console.log('PASS scaffold access: live roles, guarded shared content/history/commands, isolated sessions, regrant and cleanup')
}

runOracle(main)
