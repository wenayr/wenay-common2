import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {createServiceLeaderHost} from '../../src/service/host'
import {createServiceClient} from '../../src/service/client'
import {describeService, type ServiceResourceContext} from '../../src/service'
import {runOracle} from '../run-oracle'

function barrier<T = void>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return {promise, resolve}
}
async function until(check: () => boolean, label: string) {
    const deadline = Date.now() + 4000
    while (!check()) { assert(Date.now() < deadline, label); await delay(5) }
}
async function main() {
    const errors: unknown[] = [], reports: unknown[] = []
    function unhandled(error: unknown) { errors.push(error) }
    process.on('unhandledRejection', unhandled)
    const entered = barrier(), release = barrier(), cleaned = barrier()
    let context: ServiceResourceContext | undefined, closes = 0, factories = 0
    const original = new Error('private disposer diagnostic')
    const definition = {
        name: 'resource-cancel', storeId: 'resource-cancel', originId: 'authority', initial: {roles: ['user']}, commands: {},
        access: {rolesOf: (state: {roles: string[]}) => state.roles},
        resources: {
            plain: {allow: ['user'], placement: 'authority' as const, open() { return {facade: {read: () => 1}, close() {}} }},
            late: {allow: ['user'], placement: 'authority' as const, async open(ctx: ServiceResourceContext) {
                factories++; context = ctx; entered.resolve(); await release.promise
                return {facade: {read: () => 1}, close() { closes++; cleaned.resolve() }}
            }},
            bad: {allow: ['user'], placement: 'authority' as const, open() {
                factories++
                return {facade: {}, close() { throw original }}
            }},
            failed: {allow: ['user'], placement: 'authority' as const, open() { factories++; throw original }},
        },
    }
    const host = await createServiceLeaderHost({definition, env: {}, rest: false, resourceOptions: {openTimeoutMs: 500, closeTimeoutMs: 100}})
    host.leader.resources.errors.on(function diagnostic(value) { reports.push(value.error) })
    const token = host.leader.identity.login('alice').token
    const descriptor = describeService(definition)
    const clients: {close: () => void}[] = []
    try {
        const client = createServiceClient({definition: descriptor, url: host.url, auth: {token}})
        clients.push(client)
        const late = client.resources.open('late')
        await entered.promise
        const closing = late.close()
        assert.equal(late.status.state.phase, 'closed')
        assert.equal(late.current(), null)
        assert.equal(late.close(), closing)
        await until(() => context!.signal.aborted, 'close aborts pending server factory')
        release.resolve()
        await closing; await cleaned.promise
        assert.equal(closes, 1)
        assert.equal(late.current(), null)
        const bad = client.resources.open('bad')
        await until(() => bad.status.state.phase == 'ready', 'bad disposer resource ready')
        const badClosing = bad.close()
        await assert.rejects(badClosing, {code: 'E_RESOURCE_CLEANUP'})
        assert.equal(bad.status.state.phase, 'closed')
        assert(!JSON.stringify(bad.status.snapshot()).includes('private'))
        assert(reports.includes(original))
        const failed = client.resources.open('failed')
        await until(() => failed.status.state.phase == 'failed', 'factory error is observable')
        const afterFailure = factories
        await failed.close()
        assert.equal(factories, afterFailure, 'failed controller does not retry factory')
        assert(!JSON.stringify(failed.status.snapshot()).includes('private'))
        const tokenGate = barrier<string>()
        const connecting = createServiceClient({definition: descriptor, url: host.url, auth: {login: () => tokenGate.promise}})
        clients.push(connecting)
        const opening = connecting.resources.open('late')
        connecting.close()
        const finished = opening.close()
        tokenGate.resolve(token)
        await finished
        assert.equal(opening.status.state.phase, 'closed')
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(factories, afterFailure, 'late token cannot start a resource after client close')
        const renewedToken = barrier<string>()
        let requests = 0
        const renewable = createServiceClient({definition: descriptor, url: host.url, auth: {login: async function provide() {
            return ++requests == 1 ? token : renewedToken.promise
        }}})
        clients.push(renewable)
        const recovered = renewable.resources.open('plain')
        await until(() => !!recovered.current(), 'resource before token revocation')
        const beforeRevocation = recovered.current()!.generation
        host.leader.control.revoke('alice')
        await until(() => recovered.status.state.phase == 'denied', 'token revocation cuts resource')
        renewedToken.resolve(host.leader.identity.login('alice').token)
        await until(() => !!recovered.current() && recovered.current()!.generation > beforeRevocation, 'fresh grant restores resource')
        host.leader.line.control.store.state.roles = []
        await until(() => recovered.status.state.phase == 'denied', 'role notifications remain attached after token regrant')
        host.leader.line.control.store.state.roles = ['user']
        await until(() => !!recovered.current(), 'subsequent role regrant remains live')
        await recovered.close()
    } finally {
        release.resolve()
        for (const client of clients) client.close()
        await host.close()
        process.off('unhandledRejection', unhandled)
    }
    assert.deepEqual(errors, [])
    console.log('PASS resource cancellation: pending factory/token, exactly-once cleanup, client close errors, no unhandled promises')
}
runOracle(main)
