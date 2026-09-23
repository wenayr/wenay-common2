import assert from 'node:assert/strict'
import {io} from 'socket.io-client'
import {listen} from '../../src/Common/events/listen-index'
import {createPeerHost, createPeerClient, type PatchEnvelope} from '../../src/Common/peer/peer-index'
import {createRpcServerAuto, createRpcClientHub} from '../../src/Common/rcp/rpc-index'
import {createHostResource} from '../../src/service/host'
import {createServiceLeader} from '../../src/service/server'
const definition = {
    name: 'peer-test',
    storeId: 'peer-test',
    originId: 'authority',
    initial: {},
    commands: {},
    access: {rolesOf: (_state: object, account: string) => [account]},
    views: {},
} as const

async function waitFor(label: string, predicate: ()=>boolean) {
    const deadline = Date.now()+5000
    while (!predicate()) {
        assert(Date.now()<deadline, 'Timeout: '+label)
        await new Promise(function tick(resolve) {setTimeout(resolve, 15)})
    }
}

async function main() {
    const unhandled: unknown[] = []
    function rejected(reason: unknown) {
        unhandled.push(reason)
    }
    process.on('unhandledRejection', rejected)
    // This is a protocol fixture, not a second application runtime.
    const room = createPeerHost({history: 8})
    const leader = createServiceLeader({definition, selfUrl: ()=>'http://127.0.0.1'})
    const host = createHostResource({port: 0, host: '127.0.0.1'})
    const sessions = new Map<string, ReturnType<typeof room.connection>>()
    const subscriptions = new Map<string, () => number>()
    const catchUpGates = new Map<string, Promise<boolean>>()
    type RoomFragment = ReturnType<typeof room.connection>['fragment']
    type Facade = {session: ()=>string, peer: RoomFragment}
    const disposers: (()=>void)[] = []
    host.resource.io.on('connection', function accepted(socket) {
        const [gone, disconnectListen] = listen<[]>()
        let connection: ReturnType<typeof room.connection> | undefined
        const server = createRpcServerAuto({socket, socketKey: 'peer-audit', object: {}, disconnectListen,
            hooks: {onRequest({key}) {
                if (key[0] == 'peer' && ['since', 'frame', 'keyframe'].includes(key.at(-1)!)) {
                    return catchUpGates.get(socket.id) ?? true
                }
                return true
            }},
            auth: {gate: true, resolveAuth(presented) {
                const principal = leader.identity.principal(presented)
                const roles = leader.access.principalOf(principal).roles
                if (!roles.some(role=>['owner', 'manager', 'member'].includes(role))) throw new Error('forbidden')
                connection?.close()
                const id = principal.account+'-'+socket.id
                connection = room.connection(id)
                sessions.set(id, connection)
                return {account: principal.account, object: {session: ()=>id, peer: connection.fragment} satisfies Facade}
            }},
        })
        subscriptions.set(socket.id, () => server.api.subscriptions().length)
        socket.on('disconnect', function disconnected() {
            gone()
            connection?.close()
        })
    })
    await host.control.listen()
    async function connect(account: string) {
        const token = leader.identity.login(account).token
        const hub = createRpcClientHub(()=>io(host.view.url(), {forceNew: true, transports: ['websocket'], reconnection: false}),
            rpc=>({room: rpc<Facade>('peer-audit')}), {token: ()=>token})
        disposers.push(function closeHub() {hub.close()})
        const remote = await hub.promise
        await remote.room.readyStrict()
        const fragment = remote.room.func
        const id = await fragment.session()
        const client = createPeerClient({account: id, remote: fragment.peer, initial: {x: 0}})
        disposers.push(client.close)
        return {id, client, fragment, hub}
    }
    try {
        const tabA = await connect('owner')
        const tabB = await connect('owner')
        const manager = await connect('manager')
        assert.notEqual(tabA.id, tabB.id)
        const seenA = manager.client.peer(tabA.id)
        const seenB = manager.client.peer(tabB.id)
        await Promise.all([seenA.ready, seenB.ready])
        tabA.client.store.state.x = 12
        tabB.client.store.state.x = 88
        await waitFor('RPC cursors from two sessions', ()=>seenA.store.state.x==12&&seenB.store.state.x==88)
        console.log('PASS network peer: real Socket.IO/RPC, service-issued tokens, independent tab cursors')

        if (!process.argv.includes('--shutdown-only')) {
            // Leaving a room does not imply disconnecting the parent application socket.
            tabA.client.close()
            sessions.get(tabA.id)!.close()
            const oldX = room.relay(tabA.id).snapshot().x
            const frame: PatchEnvelope = {seq: room.relay(tabA.id).seq()+1, ts: Date.now(), event: [{path: [], value: {x: 777}, exists: true}]}
            let result: unknown
            try {result = await tabA.fragment.peer.publish(frame)} catch {result = 'rejected'}
            const changed = room.relay(tabA.id).snapshot().x!=oldX
            assert.equal(result, false)
            assert.equal(changed, false, 'retained RPC facade of closed room must not publish')
            assert.equal(await tabA.fragment.session(), tabA.id, 'parent RPC remains usable')
            console.log('PASS network peer close regression')
        }
        assert(room.presence.list().includes(tabB.id))
        // Closing only the peer must release its dynamic RPC subscriptions.
        seenA.close()
        seenB.close()
        const managerSocket = manager.id.slice('manager-'.length)
        await waitFor('peer unsubscribe releases server resources', () => subscriptions.get(managerSocket)!() == 0)
        assert.equal(await manager.fragment.session(), manager.id)

        const active = manager.client.peer(tabB.id)
        await active.ready
        tabB.client.store.state.x = 89
        await waitFor('updates after another session closes', () => active.store.state.x == 89)
        manager.client.close()
        manager.client.close()
        assert.throws(() => manager.client.peer(tabA.id), /closed/)
        manager.hub.close()
        await waitFor('socket disconnect clears presence', ()=>!room.presence.list().includes(manager.id))
        console.log('PASS network peer: parent socket disconnect clears presence; another tab remains online')

        const early = await connect('manager')
        const pending = early.client.peer(tabB.id)
        early.client.close()
        early.hub.close()
        await pending.ready

        const catchingUp = await connect('manager')
        const catchingSocket = catchingUp.id.slice('manager-'.length)
        let release!: (allowed: boolean) => void
        catchUpGates.set(catchingSocket, new Promise<boolean>(function gate(resolve) { release = resolve }))
        const pendingView = catchingUp.client.peer(tabB.id)
        let ready = false
        void pendingView.ready.then(function becameReady() { ready = true })
        await waitFor('subscription exists before catch-up finishes', () => subscriptions.get(catchingSocket)!() == 1)
        assert.equal(ready, false)
        catchingUp.client.close()
        catchingUp.hub.close()
        release(true)
        catchUpGates.delete(catchingSocket)
        await pendingView.ready

        const broken = await connect('manager')
        const brokenView = broken.client.peer(tabB.id)
        await brokenView.ready
        broken.hub.socket?.disconnect()
        await waitFor('broken transport clears session', () => !room.presence.list().includes(broken.id))
        broken.client.close()
        broken.hub.close()
        console.log('PASS network peer: close before subscribe, during catch-up and after transport break')
    } finally {
        for (const dispose of disposers.reverse()) dispose()
        await host.close()
        room.close()
        leader.control.close()
        await new Promise(function settle(resolve) {setTimeout(resolve, 30)})
        process.off('unhandledRejection', rejected)
        assert.deepEqual(unhandled, [], 'peer fixture shutdown must not leave unhandled rejections')
    }
}

main().catch(function failed(error) {
    console.error(error)
    process.exitCode = 1
})

