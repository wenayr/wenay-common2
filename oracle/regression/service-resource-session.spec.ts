import assert from 'node:assert/strict'
import {createResourceSession, type ServiceResourceDiagnostic} from '../../src/service/resource-session'
import type {ServiceResourceContext} from '../../src/service'
import {listen} from '../../src/Common/events/Listen'
import {mock} from 'node:test'
import {runOracle} from '../run-oracle'

function barrier<T = void>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return {promise, resolve}
}
async function main() {
    const [changed, changes] = listen<[]>()
    let roles = ['user']
    const contexts: ServiceResourceContext[] = []
    const disposed: string[] = []
    const diagnostics: ServiceResourceDiagnostic[] = []
    const entered = barrier(), release = barrier()
    const failure = new Error('private factory credential')
    const session = createResourceSession({principalOf: who => ({account: who.account, roles}), changes: changes.on,
        options: {closeTimeoutMs: 30, openTimeoutMs: 1000}, report: diagnostic => diagnostics.push(diagnostic),
        registry: {
            counter: {allow: ['user'], placement: 'authority', open(ctx) {
                contexts.push(ctx)
                return {facade: {value: () => 1}, close() { disposed.push(ctx.resourceId) }}
            }},
            late: {allow: ['user'], placement: 'authority', async open(ctx) {
                contexts.push(ctx); entered.resolve(); await release.promise
                return {facade: {value: () => 2}, close() { disposed.push(ctx.resourceId) }}
            }},
            fail: {allow: ['user'], placement: 'authority', open() { throw failure }},
            badClose: {allow: ['user'], placement: 'authority', open() { return {facade: {}, close() { throw failure }} }},
            hang: {allow: ['user'], placement: 'authority', open() { return {facade: {}, close() { return new Promise<void>(() => {}) }} }},
        },
    })
    const api = session.update({account: 'alice', expiresAt: Date.now() + 100_000})
    const a = api.control.open('counter'), b = api.control.open('counter')
    await api.control.ready(a.id); await api.control.ready(b.id)
    assert.notEqual(a.id, b.id)
    assert.equal(contexts[0].sessionId, contexts[1].sessionId)
    const initialRevision = api.control.state().revision
    session.update({account: 'alice', expiresAt: Date.now() + 200_000})
    assert.equal(api.control.state().revision, initialRevision)
    assert.equal(contexts.length, 2)
    const completion = api.control.close(a.id)
    assert.equal(contexts[0].signal.aborted, true)
    assert.equal(contexts[1].signal.aborted, false)
    await completion
    const late = api.control.open('late')
    const ready = api.control.ready(late.id).then(() => null, error => error.code)
    await entered.promise
    const closed = api.control.close(late.id)
    release.resolve()
    await closed
    assert.equal(await ready, 'E_RESOURCE_CLOSED')
    assert.equal(disposed.filter(id => id == late.id).length, 1)
    assert.equal(api.instances[late.id], undefined)
    roles = ['user', 'another']
    changed()
    assert(contexts[1].signal.aborted, 'even an allowed role change replaces the generation')
    roles = []; changed()
    assert.throws(() => api.control.open('counter'), {code: 'E_RESOURCE_DENIED'})
    assert.equal(contexts.length, 3)
    roles = ['user']; changed()
    const bad = api.control.open('fail')
    await assert.rejects(api.control.ready(bad.id), {code: 'E_RESOURCE_OPEN'})
    assert(diagnostics.some(item => item.error == failure && item.phase == 'open'))
    const badClose = api.control.open('badClose')
    await api.control.ready(badClose.id)
    await assert.rejects(api.control.close(badClose.id), {code: 'E_RESOURCE_CLEANUP'})
    assert(diagnostics.some(item => item.error == failure && item.phase == 'close'))
    const hang = api.control.open('hang')
    await api.control.ready(hang.id)
    await assert.rejects(api.control.close(hang.id), {code: 'E_RESOURCE_CLEANUP'})
    const account = api.control.open('counter')
    await api.control.ready(account.id)
    session.update({account: 'bob'})
    assert(contexts.at(-1)!.signal.aborted)
    assert.equal(api.control.state().account, 'bob')
    const closing = session.close()
    assert.equal(session.close(), closing)
    await closing
    changes.close()
    mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1000})
    try {
        let signal: AbortSignal | undefined
        const timed = createResourceSession({registry: {counter: {allow: ['user'], placement: 'authority', open(ctx) {
            signal = ctx.signal
            return {facade: {}, close() {}}
        }}}, principalOf: who => ({account: who.account, roles: ['user']}), changes: () => () => {}, report() {}})
        const timedApi = timed.update({account: 'alice', expiresAt: 1100})
        const item = timedApi.control.open('counter')
        await timedApi.control.ready(item.id)
        timed.update({account: 'alice', expiresAt: 1300})
        mock.timers.tick(150)
        assert.equal(signal!.aborted, false, 'renewed deadline replaces the original timer')
        mock.timers.tick(151)
        assert.equal(signal!.aborted, true, 'scope cut at renewed deadline')
        assert.equal(timedApi.control.state().account, null)
        await timed.close()
        const long = createResourceSession({registry: {counter: {allow: ['user'], placement: 'authority', open(ctx) {
            signal = ctx.signal
            return {facade: {}, close() {}}
        }}}, principalOf: who => ({account: who.account, roles: ['user']}), changes: () => () => {}, report() {}})
        const longApi = long.update({account: 'alice', expiresAt: Date.now() + 2_147_483_647 + 100})
        const longItem = longApi.control.open('counter')
        await longApi.control.ready(longItem.id)
        mock.timers.tick(2_147_483_647)
        assert.equal(signal!.aborted, false, 'long grant is not truncated by the platform timer limit')
        mock.timers.tick(100)
        assert.equal(signal!.aborted, true)
        await long.close()
    } finally { mock.timers.reset() }
    console.log('PASS resource session: independent opens, renew, roles, account, cancellation, safe errors, bounded disposal')
}
runOracle(main)
