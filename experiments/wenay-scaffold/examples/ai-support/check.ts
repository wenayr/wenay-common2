import assert from 'node:assert/strict'
import {io} from 'socket.io-client'
import {createRpcClient} from '../../../../src/Common/rcp/rpc-client'
import {startSupportHost} from './host'
import {connectSupport} from './client'
import type {SupportFacade} from './service'
import {createDemoProvider} from './provider'
import {runCheck} from '../../resources/run-check'

async function until(label: string, predicate: () => boolean) {
    const deadline = Date.now() + 5000
    while (!predicate()) {
        assert(Date.now() < deadline, 'timeout: ' + label)
        await new Promise(function wait(resolve) { setTimeout(resolve, 10) })
    }
}
async function main() {
    const provider = createDemoProvider({stepMs: 150})
    const host = await startSupportHost({runner: {...provider, async run(context) {
        if ((context.input as {ticket: string}).ticket == 'provider-failure-test') throw new Error('demo provider unavailable')
        return provider.run(context)
    }}})
    const clients: Awaited<ReturnType<typeof connectSupport>>[] = []
    try {
        const alice = await connectSupport({url: host.url, token: () => host.source.token('alice')})
        const bob = await connectSupport({url: host.url, token: () => host.source.token('bob')})
        clients.push(alice, bob)
        const aliceStore = alice.store
        const events: string[] = []
        alice.events.on(function observed(event) { events.push(event.type) })
        const first = await alice.control.create({requestId: 'same', kind: 'ticket', input: {ticket: 'Private Alice invoice refund'}})
        const other = await bob.control.create({requestId: 'same', kind: 'ticket', input: {ticket: 'Private Bob login failure'}})
        assert.notEqual(first.id, other.id)
        assert.equal((await alice.control.create({requestId: 'same', kind: 'ticket', input: {ticket: 'ignored retry'}})).id, first.id)
        await until('live progress', () => events.includes('progress'))
        await assert.rejects(bob.control.cancel(first.id), /forbidden|unknown|not found/i)
        alice.control.offline()
        await until('other account completes while first client offline', () => bob.store.state.runs[other.id]?.state == 'completed')
        alice.control.online()
        await until('same Store catches up after reconnect', () => alice.store.state.runs[first.id]?.state == 'completed')
        assert.equal(alice.store, aliceStore)
        assert.deepEqual(Object.keys(alice.store.state.runs), [first.id])
        assert.deepEqual(Object.keys(bob.store.state.runs), [other.id])
        assert(!JSON.stringify(alice.store.state).includes('Private Bob'))
        assert.equal(alice.store.state.runs[first.id].usage, undefined, 'demo invents no token usage')
        const result = alice.store.state.runs[first.id].result as {provider: string, category: string, draft: string}
        assert.equal(result.provider, 'demo, no AI model')
        assert.equal(result.category, 'billing')
        const cancelled = await alice.control.create({requestId: 'cancel', kind: 'ticket', input: {ticket: 'Cancel this draft'}})
        await alice.control.cancel(cancelled.id)
        await until('cancelled state', () => alice.store.state.runs[cancelled.id]?.state == 'cancelled')
        await new Promise(function wait(resolve) { setTimeout(resolve, 500) })
        assert.equal(alice.store.state.runs[cancelled.id].state, 'cancelled')
        assert.equal(alice.store.state.runs[cancelled.id].result, undefined)
        const failed = await alice.control.create({requestId: 'provider-failure', kind: 'ticket', input: {ticket: 'provider-failure-test'}})
        await until('provider failure is visible', () => alice.store.state.runs[failed.id]?.state == 'failed')
        assert.match(alice.store.state.runs[failed.id].error ?? '', /demo provider unavailable/)
        const recovered = await alice.control.create({requestId: 'after-provider-failure', kind: 'ticket', input: {ticket: 'Please help with account access'}})
        await until('fresh task succeeds after provider failure', () => alice.store.state.runs[recovered.id]?.state == 'completed')
        await assert.rejects(alice.control.create({requestId: 'bad', kind: 'ticket', input: {ticket: ''}}), /forbidden/)
        const socket = io(host.url, {transports: ['websocket'], forceNew: true})
        const anonymous = createRpcClient<SupportFacade>({socket, socketKey: 'support'})
        try {
            await anonymous.readyStrict()
            assert.deepEqual(Object.keys(anonymous.strict), [])
            await assert.rejects(anonymous.func.createRun({requestId: 'anonymous', kind: 'ticket', input: {ticket: 'no'}}), /Unauthorized/)
        } finally {
            anonymous.close()
            socket.disconnect()
        }
        const page = await fetch(host.url).then(response => response.text())
        assert(page.includes('Demo, no AI model'))
        new Function(page.match(/<script>([\s\S]*)<\/script>/)![1])
        const denied = await fetch(host.url + '/api/bob/runs', {headers: {authorization: 'Bearer ' + host.source.token('alice')}})
        assert.equal(denied.status, 401)
        console.log('PASS ai-support: real RPC progress/cancel, provider failure recovery, scoped requests, account isolation, same Store reconnect, empty anonymous facade, honest demo usage')
    } finally {
        for (const client of clients) client.close()
        await host.close()
    }
}
runCheck(main)
