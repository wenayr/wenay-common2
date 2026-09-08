import {strict as assert} from 'node:assert'
import {test} from 'node:test'
import {setImmediate as nextTurn} from 'node:timers/promises'
import {createStoreReplicaSet} from '../src/Common/Observe/store-replica-set'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(function capture(next) { resolve = next })
    return {promise, resolve}
}

for (const result of [{epoch: 1}, null]) {
    test('closing during election stays terminal: ' + JSON.stringify(result), async function closeDuringElection() {
        const election = deferred<{epoch: number} | null>()
        const replica = createStoreReplicaSet({
            storeId: 's', originId: 'o', nodeId: 'local', initial: {},
            leadership: {initialRole: 'follower', elect() { return election.promise }},
        })
        const pending = replica.control.promote()
        const outcome = pending.then(() => null, error => error)
        replica.close()
        election.resolve(result)
        assert.match(String(await outcome), /closed/)
        assert.equal(replica.api.canWrite(), false)
        assert.equal(replica.api.status.state.role, 'closed')
    })
}

for (const initialRole of ['leader', 'follower'] as const) {
    test('closing during keyframe stays terminal for ' + initialRole, async function closeDuringAuthorityFrame() {
        const leader = createStoreReplicaSet({
            storeId: 's', originId: 'o', nodeId: 'leader', initial: {value: 2},
            expose: {chunks: false},
            leadership: {initialRole: 'leader', epoch: 2},
        })
        const replica = createStoreReplicaSet({
            storeId: 's', originId: 'o', nodeId: 'local', initial: {value: 1},
            leadership: {initialRole, epoch: 1},
        })
        const entered = deferred<void>()
        const resume = deferred<void>()
        let subscriptions = 0
        let closes = 0
        const remote = leader.api.fragment
        try {
            replica.control.addOffer({
                id: 'leader',
                connect() {
                    return {
                        remote: {
                            ...remote,
                            replay: {
                                ...remote.replay,
                                line: {on(cb) { subscriptions++; return remote.replay.line.on(cb) }},
                                async keyframe() {
                                    entered.resolve()
                                    await resume.promise
                                    return remote.replay.keyframe()
                                },
                            },
                        },
                        close() { closes++ },
                    }
                },
            })
            await entered.promise
            const openedSubscriptions = subscriptions
            replica.close()
            resume.resolve()
            await nextTurn()
            await nextTurn()
            assert.equal(subscriptions, openedSubscriptions, 'a closed replica must not acquire a new replay resource')
            assert.equal(replica.api.status.state.role, 'closed')
            assert.equal(replica.api.canWrite(), false)
            assert.deepEqual(replica.api.store.snapshot(), {value: 1})
            assert.equal(closes, 1)
        } finally {
            resume.resolve()
            replica.close()
            leader.close()
        }
    })
}
