import assert from 'node:assert/strict'
import {io} from 'socket.io-client'
import {createRpcClient} from '../../src/Common/rcp/rpc-client'
import {createMemoryReplayStorage} from '../../src/Common/events/replay-history'
import type {StorePatch} from '../../src/Common/Observe/store'
import {createServiceLeaderHost} from '../../src/service/host'
import {createServiceClient} from '../../src/service/client'
import {describeService, type ServiceResourceContext} from '../../src/service'
import {setTimeout as delay} from 'node:timers/promises'

async function until(check: () => boolean, label: string) {
    const deadline = Date.now() + 7000
    while (!check()) { assert(Date.now() < deadline, label); await delay(5) }
}
async function main() {
    const contexts: ServiceResourceContext[] = []
    const definition = {
        name: 'resource-restart', storeId: 'resource-restart', originId: 'authority', initial: {count: 0},
        access: {rolesOf: () => ['user']},
        commands: {add: {apply(ctx: {state: {count: number}}, n: number) { return ctx.state.count += n }}},
        resources: {counter: {allow: ['user'], placement: 'authority' as const, open(ctx: ServiceResourceContext) {
            contexts.push(ctx)
            return {facade: {view: {account: () => ctx.principal.account}}, close() {}}
        }}},
    }
    const durable = {storage: createMemoryReplayStorage<[readonly StorePatch[]]>()}, durableControl = {storage: createMemoryReplayStorage<[readonly StorePatch[]]>()}
    const env = {SERVICE_TOKEN_SECRET: 'stable-resource-test-secret', SERVICE_NODE_TOKEN: 'stable-node-test-secret'}
    let host = await createServiceLeaderHost({definition, durable, durableControl, env, rest: false})
    const url = host.url
    let token = host.leader.identity.login('alice').token
    const client = createServiceClient({definition: describeService(definition), url, auth: {login: async () => token}})
    try {
        const resource = client.resources.open('counter')
        await until(() => !!resource.current(), 'initial resource')
        const previous = resource.current()!
        assert.equal(await client.commands.add('receipt', 4), 4)
        // Raw paths on a still-live authenticated socket are also scoped.
        const socket = io(url, {forceNew: true, transports: ['websocket'], reconnection: false, auth: {sessionId: 'spoof', account: 'mallory'}})
        const rpc = createRpcClient<any>({socket, socketKey: 'resources', token})
        try {
            await rpc.readyStrict()
            const raw = rpc.func
            const item = await raw.control.open('counter')
            await raw.control.ready(item.id)
            const saved = raw.instances[item.id].view.account
            assert.equal(await saved(), 'alice')
            const context = contexts.at(-1)!
            await rpc.reauth(host.leader.identity.renew(token).token)
            assert.equal(await saved(), 'alice', 'same-account renew preserves resource path')
            assert.equal(context.signal.aborted, false)
            await raw.control.close(item.id)
            await assert.rejects(saved(), {code: 'E_RESOURCE_CLOSED'})
            assert.equal((await raw.control.state()).account, 'alice')
        } finally { rpc.dispose(); socket.close() }
        await host.close()
        await until(() => resource.status.state.phase == 'offline', 'resource offline at authority shutdown')
        host = await createServiceLeaderHost({definition, durable, durableControl, rest: false,
            env: {...env, SERVICE_PORT: new URL(url).port}})
        await until(() => !!resource.current() && resource.current()!.generation > previous.generation, 'resource recreated after authority restart')
        await assert.rejects(previous.remote.view.account())
        assert.equal(host.leader.line.control.store.state.count, 4)
        assert.equal(await client.commands.add('receipt', 4), 4, 'persisted receipt does not rerun command')
        assert.equal(host.leader.line.control.store.state.count, 4)
        token = host.leader.identity.login('bob').token
        await host.close()
        host = await createServiceLeaderHost({definition, durable, durableControl, rest: false,
            env: {...env, SERVICE_PORT: new URL(url).port}})
        await until(() => resource.status.state.phase == 'closed', 'account change terminally closes old controller')
        const next = client.resources.open('counter')
        await until(() => !!next.current(), 'new account can explicitly open')
        assert.equal(await next.current()!.remote.view.account(), 'bob')
        await next.close()
    } finally { client.close(); await host.close() }
    console.log('PASS resource authority restart: fresh generations, archive state, persisted receipt, raw paths, renew, account replacement')
}
main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
