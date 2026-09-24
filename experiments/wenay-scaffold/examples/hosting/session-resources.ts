import assert from 'node:assert/strict'
import {listen} from '../../../../src/Common/events/listen-index'
import {createPeerHost} from '../../../../src/Common/peer/peer-index'
import {describeService, type ServiceResourceContext, type tServiceDefinition} from '../../../../src/service'
import {createServiceClient, type ServiceResourceController} from '../../../../src/service/client'
import {createServiceLeaderHost} from '../../../../src/service/host'
import {runCheck} from '../../resources/run-check'

// Server composition. A browser imports describeService's JSON and definition types only.
async function main() {
    const room = createPeerHost()
    const definition = {
        name: 'session-resources', storeId: 'session-resources', originId: 'authority', initial: {}, commands: {},
        access: {rolesOf: () => ['member']},
        resources: {
            presence: {allow: ['member'], placement: 'authority', open(ctx: ServiceResourceContext) {
                const peer = room.connection(ctx.resourceId)
                return {facade: {session: () => ctx.resourceId, peer: peer.fragment}, close: peer.close}
            }},
            counter: {allow: ['member'], placement: 'authority', open() {
                let count = 0
                const [emit, events] = listen<[number]>()
                return {facade: {control: {add(amount: number) { count += amount; emit(count); return count }},
                    view: {read: () => count}, events}, close: events.close}
            }},
        },
    } satisfies tServiceDefinition<any, any>
    const host = await createServiceLeaderHost({definition, env: {}, rest: false})
    const token = host.leader.identity.login('member-1').token
    const client = createServiceClient({definition: describeService(definition), url: host.url, auth: {token}})
    const counter = client.resources.open('counter'), presence = client.resources.open('presence')
    try {
        await ready(counter); await ready(presence)
        const current = counter.current()!
        assert.equal(await current.remote.control.add(3), 3)
        assert.equal(await current.remote.view.read(), 3)
        const peer = presence.current()!.remote
        assert((await peer.peer.presence.list()).includes(await peer.session()))
        await counter.close()
        await assert.rejects(current.remote.control.add(1))
        assert.equal((await client.identity.me()).account, 'member-1')
        console.log('PASS session resources: typed counter and peer, independent close, parent client remains available')
    } finally {
        await counter.close(); await presence.close()
        client.close()
        await host.close()
        room.close()
    }
}

async function ready<F extends object>(resource: ServiceResourceController<F>) {
    let stop = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        await new Promise<void>(function wait(resolve, reject) {
            timer = setTimeout(function timeout() { reject(new Error('Resource readiness timed out')) }, 5000)
            stop = resource.status.on(function changed(status) {
                if (status.phase == 'ready') resolve()
                if (status.phase == 'failed' || status.phase == 'closed') reject(new Error(status.error?.message ?? status.phase))
            }, {current: true})
        })
    } finally { stop(); clearTimeout(timer) }
}
runCheck(main)
