import assert from 'node:assert/strict'
import {test} from 'node:test'
import {sleepAsync} from '../src/Common/core/common'
import {createAuthority} from '../src/Common/scale/scale-authority'

function authority(nodeId: string, epoch: number) {
    return createAuthority({
        line: {storeId: 'ownership', originId: 'ownership', nodeId, initial: {value: 0}},
        roster: {url: () => 'memory://' + nodeId, staleMs: 0},
        identity: {issue: account => account, verify: token => ({account: String(token)})},
        leadership: {epoch},
        log() {},
    })
}

test('an old node link cannot write through demotion or a later ownership generation', async function staleNodeLink() {
    const a = authority('a', 1)
    const b = authority('b', 2)
    try {
        const old = a.serve.nodeLink('worker')
        old.register({nodeId: 'worker', url: 'memory://worker'})
        a.line.control.addOffer({id: 'b', connect: () => ({remote: b.line.api.fragment, close() {}})})
        const deadline = Date.now() + 2000
        while (a.view.role() != 'standby' && Date.now() < deadline) await sleepAsync(5)
        assert.equal(a.view.role(), 'standby')
        assert.throws(function lateRegister() { old.register({nodeId: 'worker', url: 'memory://stale'}) })
        assert.throws(function lateHeartbeat() { old.heartbeat('worker', {readers: 999}) })
        assert.throws(function lateGoodbye() { old.goodbye('worker') })
        a.line.control.removeOffer('b')
        await a.control.promote()
        assert.equal(a.view.role(), 'leader')
        assert.throws(function previousGeneration() { old.register({nodeId: 'worker', url: 'memory://stale'}) })
        const fresh = a.serve.nodeLink('worker')
        fresh.register({nodeId: 'worker', url: 'memory://fresh'})
        assert.equal(a.roster.control.get('worker')?.url, 'memory://fresh')
        a.close()
        assert.throws(function afterClose() { fresh.heartbeat('worker') })
    } finally {
        a.close()
        b.close()
    }
})

test('authority refuses reentrant commands as soon as teardown starts', async function teardownAdmission() {
    const upstream = authority('upstream', 1)
    let applied = 0
    let attached = false
    const attempts: Promise<unknown>[] = []
    const current = createAuthority({
        line: {storeId: 'ownership', originId: 'ownership', nodeId: 'current', initial: {value: 0}},
        roster: {url: () => 'memory://current', staleMs: 0},
        identity: {issue: account => account, verify: token => ({account: String(token)})},
        corridor: {commands: {write() { return ++applied }}},
        leadership: {
            epoch: 2,
            upstream() {
                return {
                    ...upstream.serve.nodeLink('current'),
                    onFail: {on() {
                        attached = true
                        return function externalCleanup() {
                            attempts.push(current.corridor.execute('user', 'write', 'during-close', undefined).catch(error => error))
                        }
                    }},
                }
            },
        },
        log() {},
    })
    try {
        const deadline = Date.now() + 2000
        while (!attached && Date.now() < deadline) await sleepAsync(5)
        assert(attached)
        current.close()
        await Promise.all(attempts)
        assert(attempts.length > 0)
        assert.equal(applied, 0, 'external cleanup must not admit new domain work')
    } finally {
        current.close()
        upstream.close()
    }
})
