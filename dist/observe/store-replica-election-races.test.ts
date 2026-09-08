import {strict as assert} from 'node:assert'
import {test} from 'node:test'
import {setImmediate as nextTurn} from 'node:timers/promises'
import {createStoreReplicaSet} from '../src/Common/Observe/store-replica-set'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(function capture(next) { resolve = next })
    return {promise, resolve}
}

test('both public write-admission facets reject a closed owner', function closedOwnerAdmission() {
    const owner = createStoreReplicaSet({storeId: 's', originId: 'o', nodeId: 'owner', initial: {}})
    assert.equal(owner.api.canWrite(), true)
    assert.equal(owner.control.canWrite(), true)
    owner.close()
    assert.equal(owner.api.canWrite(), false)
    assert.equal(owner.control.canWrite(), false)
    assert.equal(owner.api.status.state.role, 'closed')
})

test('write admission closes before external session teardown callbacks', async function closeBeforeResourceTeardown() {
    const other = createStoreReplicaSet({
        storeId: 's', originId: 'o', nodeId: 'other', initial: {}, leadership: {epoch: 1},
    })
    const owner = createStoreReplicaSet({
        storeId: 's', originId: 'o', nodeId: 'owner', initial: {}, leadership: {epoch: 2},
    })
    let duringClose: boolean[] = []
    owner.control.addOffer({id: 'other', connect() {
        return {remote: other.api.fragment, close() { duringClose = [owner.api.canWrite(), owner.control.canWrite()] }}
    }})
    try {
        await owner.control.probe()
        assert.equal(owner.api.canWrite(), true)
        owner.close()
        assert.deepEqual(duringClose, [false, false])
    } finally { owner.close(); other.close() }
})

test('a declined pending election cannot demote a newer successful election', async function lateDeclinedElection() {
    const earlier = deferred<{epoch: number} | null>()
    let elections = 0
    const replica = createStoreReplicaSet({
        storeId: 's', originId: 'o', nodeId: 'local', initial: {},
        leadership: {
            initialRole: 'follower',
            elect() { return ++elections == 1 ? earlier.promise : {epoch: 1} },
        },
    })
    try {
        const pending = replica.control.promote()
        await replica.control.promote()
        assert.equal(replica.api.canWrite(), true)
        earlier.resolve(null)
        await pending
        assert.equal(replica.api.status.state.role, 'leader')
        assert.equal(replica.api.canWrite(), true)
    } finally { earlier.resolve(null); replica.close() }
})

test('a declined election preserves a follower attached while the election was pending', async function lateDeclineAfterHandoff() {
    const election = deferred<{epoch: number} | null>()
    const leader = createStoreReplicaSet({
        storeId: 's', originId: 'o', nodeId: 'leader', initial: {value: 1},
        leadership: {initialRole: 'leader', epoch: 2},
    })
    const follower = createStoreReplicaSet({
        storeId: 's', originId: 'o', nodeId: 'follower', initial: {value: 0},
        leadership: {initialRole: 'follower', elect() { return election.promise }},
    })
    try {
        const pending = follower.control.promote()
        follower.control.addOffer({id: 'leader', connect() { return {remote: leader.api.fragment, close() {}} }})
        await follower.api.ready
        assert.equal(follower.api.status.state.role, 'follower')
        election.resolve(null)
        await pending
        assert.equal(follower.api.status.state.role, 'follower')
        assert.equal(follower.api.status.state.routeId, 'leader')
        leader.control.store.node.value.set(2)
        await nextTurn()
        await nextTurn()
        assert.equal(follower.api.store.state.value, 2)
    } finally { election.resolve(null); follower.close(); leader.close() }
})
