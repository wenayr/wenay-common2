// REAL-SOCKET oracle: Store replica offers carry a descriptor + replay line
// over the ordinary RPC facade. A follower may expose the same fragment again,
// so a browser-like client can join through a cascade without transport-specific
// replica-set logic.
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {flushReactive} from '../../src/Common/Observe/reactive'
import {createStoreReplicaSet, StoreReplicaOffer} from '../../src/Common/Observe/store-replica-set'

const LEADER_PORT = 3166
const FOLLOWER_PORT = 3167

type State = Record<string, {id: string, value: number}>

async function waitFor(label: string, condition: () => boolean, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await delay(10)
    }
    throw new Error('timeout waiting for ' + label)
}

function socketOffer(id: string, connection: Awaited<ReturnType<typeof startRealClient>>, fragment: any): StoreReplicaOffer {
    return {
        id,
        async connect() {
            return {
                remote: fragment,
                onFail: {on: connection.client.onDisconnect},
                close() {},
            }
        },
    }
}

async function main() {
    const {check, done} = makeChecker('store-replica-set')
    const watchdog = setTimeout(function specTimedOut() {
        console.error('store-replica-set oracle timed out')
        process.exit(3)
    }, 120000)

    const leader = createStoreReplicaSet<State>({
        storeId: 'real-mesh',
        originId: 'real-mesh-origin',
        nodeId: 'leader',
        lineId: 'leader-line',
        initial: {seed: {id: 'seed', value: 1}},
        leadership: {initialRole: 'leader', epoch: 4},
    })
    const leaderServer = await startRealServer({
        port: LEADER_PORT,
        makeObject: () => ({replica: leader.api.fragment}),
    })
    const leaderConnection = await startRealClient({port: LEADER_PORT})

    const follower = createStoreReplicaSet<State>({
        storeId: 'real-mesh',
        originId: 'real-mesh-origin',
        nodeId: 'follower',
        lineId: 'follower-line',
        initial: {},
        leadership: {initialRole: 'follower', eligible: false},
    })
    follower.control.addOffer(socketOffer('rpc-to-leader', leaderConnection, leaderConnection.api.replica))
    await follower.api.ready
    await check('RPC offer carries the authority descriptor', () => ({
        leader: follower.api.status.state.leaderId,
        epoch: follower.api.status.state.epoch,
        path: follower.api.status.state.path,
    }), {leader: 'leader', epoch: 4, path: ['leader', 'follower']})
    await check('RPC offer keyframe converges', () => follower.api.store.snapshot(), leader.api.store.snapshot())

    const followerServer = await startRealServer({
        port: FOLLOWER_PORT,
        makeObject: () => ({replica: follower.api.fragment}),
    })
    const followerConnection = await startRealClient({port: FOLLOWER_PORT})
    const client = createStoreReplicaSet<State>({
        storeId: 'real-mesh',
        originId: 'real-mesh-origin',
        nodeId: 'browser',
        lineId: 'browser-line',
        initial: {},
        leadership: {initialRole: 'follower', eligible: false},
    })
    client.control.addOffer(socketOffer('rpc-to-follower', followerConnection, followerConnection.api.replica))
    await client.api.ready
    await check('client participates through a real two-hop cascade', () => client.api.status.state.path,
        ['leader', 'follower', 'browser'])

    leader.control.store.state.live = {id: 'live', value: 2}
    await flushReactive(leader.control.store.state)
    await waitFor('live patch crosses both sockets', () => client.api.store.state.live?.value == 2)
    await check('leader and both replicas converge after a live write', () => [
        follower.api.store.snapshot(),
        client.api.store.snapshot(),
    ], [leader.api.store.snapshot(), leader.api.store.snapshot()])

    client.close()
    follower.close()
    leader.close()
    followerConnection.close()
    leaderConnection.close()
    await followerServer.close()
    await leaderServer.close()
    clearTimeout(watchdog)
    process.exit(done() == 0 ? 0 : 1)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
