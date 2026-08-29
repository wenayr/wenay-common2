// REAL-SOCKET store-node readers oracle. The mini-scale stand observed line
// subscriber counts on mini nodes that only ever grow; the in-process loopback
// oracle (observe/store-node-readers.test.ts) is green, so this spec mirrors
// the REAL topology: two store nodes served over genuine Socket.IO, cluster
// clients with balance placement whose per-node hubs call io(url) WITHOUT
// forceNew — exactly like demo/mini-scale-demo.ts sim readers, where several
// hubs in one process share managers. Counts must track the truth through
// migrations, transport blips and reader closes. Ports 4171/4172.
import {Server as SocketIOServer} from 'socket.io'
import {createServer} from 'http'
import {io} from 'socket.io-client'
import {makeChecker, delay} from './_rs'
import {listen as createListenPair} from '../../src/Common/events/Listen'
import {createRpcClientHub} from '../../src/Common/rcp/rpc-clientHub'
import {createNodeDirectory, type NodeDirectoryView} from '../../src/Common/Observe/node-directory'
import {createStoreReplicaSet} from '../../src/Common/Observe/store-replica-set'
import {createStoreNode, type StoreNodeInstance} from '../../src/Common/Observe/store-node'
import {createClusterClient} from '../../src/Common/scale/scale-client'

const PORTS: Record<string, number> = {n1: 4171, n2: 4172}
const WAIT_MS = 12_000

type TickState = Record<string, {id: string, value: number}>

async function waitFor(name: string, predicate: () => boolean, timeoutMs = WAIT_MS) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await delay(20)
    }
    throw new Error('timeout waiting for ' + name)
}

// ============================================================
// real-socket store node: the EXACT serving shape of demo/mini-scale-node.ts
// ============================================================
async function bootRealNode(deps: {
    nodeId: string
    authority: ReturnType<typeof createStoreReplicaSet<TickState>>
    directory: ReturnType<typeof createNodeDirectory>
}) {
    const port = PORTS[deps.nodeId]
    const httpServer = createServer()
    const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})
    const node = createStoreNode<TickState>({
        nodeId: deps.nodeId, storeId: 'rs-readers', originId: 'rs-readers-origin',
        graceMs: 40,
        upstream: () => ({
            replica: deps.authority.api.fragment,
            directory: deps.directory.api,
            register: entry => deps.directory.control.upsert({...entry, role: 'mirror'}),
            heartbeat: (nodeId, facts) => {
                const meta = {...deps.directory.control.get(nodeId)?.meta, readers: facts?.readers ?? 0}
                return deps.directory.control.heartbeat(nodeId, {meta})
            },
            goodbye: nodeId => deps.directory.control.remove(nodeId),
            onFail: {on: () => () => {}},
        }),
        serve: {onConnection(handler) { ioServer.on('connection', handler) }},
        selfUrl: () => 'http://localhost:' + port,
        heartbeatMs: 60,
        onLeave: () => {},
        wrap: fragment => ({svc: fragment}),
        log: () => {},
    })
    await new Promise<void>(resolve => httpServer.listen(port, resolve))
    await node.start()
    return {
        node,
        /** Live engine connections — zombie sockets are invisible to line counts. */
        sockets: () => ioServer.engine.clientsCount,
        close: () => new Promise<void>(resolve => { ioServer.close(); httpServer.close(() => resolve()) }),
    }
}

// ============================================================
// sim reader: the EXACT client shape of demo/mini-scale-demo.ts spawnSimReader
// (per-node hub, io(url) WITHOUT forceNew, close disconnects the hub sockets)
// ============================================================
function spawnSimReader(k: number, directory: ReturnType<typeof createNodeDirectory>) {
    const hubs = new Set<ReturnType<typeof createRpcClientHub>>()
    async function connectReaderNode(node: NodeDirectoryView) {
        const hub = createRpcClientHub(
            () => io(node.url, {transports: ['websocket'], auth: {tab: 'sim-' + k, role: 'reader'}}),
            r => ({app: r<any>('app')}) as const,
        )
        hubs.add(hub)
        const clients = await hub.setToken(null)
        await (clients as any).app.readyStrict()
        return {
            remote: ((clients as any).app.func as any).svc.replica,
            onFail: {on: (cb: () => void) => hub.disconnectListen(cb)},
            close() {
                hubs.delete(hub)
                ;(hub.socket as any)?.disconnect?.()
            },
        }
    }
    const reader = createClusterClient<TickState>({
        storeId: 'rs-readers', originId: 'rs-readers-origin',
        nodeId: 'sim-' + k,
        initial: {},
        directory: directory.api,
        connect: connectReaderNode,
        placement: {staleMs: 10_000, label: `sim #${k}`, balance: {checkMs: 60, cooldownMs: 250, moveChance: 1}},
        log: () => {},
    })
    return {
        k,
        reader,
        hubs,
        routeNodeId: () => reader.status.state.routeNodeId,
        close() {
            reader.close()
            for (const hub of hubs) (hub.socket as any)?.disconnect?.()
            hubs.clear()
        },
    }
}

async function main() {
    const {check, done} = makeChecker('store-node-readers')
    const watchdog = setTimeout(function watchdogTimeout() {
        console.error('WATCHDOG timeout')
        process.exit(3)
    }, 180_000)

    const authority = createStoreReplicaSet<TickState>({
        storeId: 'rs-readers', originId: 'rs-readers-origin', nodeId: 'authority', lineId: 'authority-line',
        initial: {tick: {id: 'tick', value: 0}},
        leadership: {initialRole: 'leader', epoch: 1},
    })
    const directory = createNodeDirectory()
    const one = await bootRealNode({nodeId: 'n1', authority, directory})
    const two = await bootRealNode({nodeId: 'n2', authority, directory})
    const counts = () => ({n1: one.node.view.status().readers, n2: two.node.view.status().readers})

    // a live tick stream, so followers really consume the line
    const ticker = setInterval(function tickAuthority() {
        authority.control.store.state.tick = {id: 'tick', value: Date.now() % 100000}
    }, 40)

    // truth = how many readers are ACTIVELY routed to each node right now
    const readers: ReturnType<typeof spawnSimReader>[] = []
    function truth() {
        const t = {n1: 0, n2: 0}
        for (const sim of readers) {
            const at = sim.routeNodeId()
            if (at == 'n1') t.n1++
            if (at == 'n2') t.n2++
        }
        return t
    }
    function countsMatchTruth() {
        const c = counts()
        const t = truth()
        return c.n1 == t.n1 && c.n2 == t.n2
    }

    // ============== 1. spawn: counts equal actual routes ==============
    for (let k = 1; k <= 4; k++) readers.push(spawnSimReader(k, directory))
    await Promise.all(readers.map(sim => sim.reader.ready))
    await waitFor('all four readers actively routed', () => truth().n1 + truth().n2 == 4)
    await waitFor('spawn: counts equal actual routes', countsMatchTruth)
    await check('spawn: total subscriber count is exactly four', () => {
        const c = counts()
        return c.n1 + c.n2
    }, 4)

    // ============== 2. churn: weight swings force voluntary migrations ==============
    function setWeight(nodeId: string, weight: number) {
        const row = directory.control.get(nodeId)
        if (row) directory.control.upsert({...row, weight})
    }
    let routeMoves = 0
    let lastRoutes = readers.map(sim => sim.routeNodeId())
    for (let swing = 0; swing < 4; swing++) {
        setWeight('n1', swing % 2 == 0 ? 12 : 1)
        setWeight('n2', swing % 2 == 0 ? 1 : 12)
        await delay(700)
        const nowRoutes = readers.map(sim => sim.routeNodeId())
        for (let at = 0; at < nowRoutes.length; at++) {
            if (nowRoutes[at] != lastRoutes[at]) routeMoves++
        }
        lastRoutes = nowRoutes
    }
    setWeight('n1', 4)
    setWeight('n2', 4)
    await delay(1200) // let the last migrations and cooldowns settle
    await waitFor('churn: counts settle back to actual routes', countsMatchTruth, WAIT_MS)
    await check('churn: no ghost subscriptions after migrations', () => {
        const c = counts()
        const t = truth()
        return [c.n1 - t.n1, c.n2 - t.n2]
    }, [0, 0])
    // A balance migration is a LINE move, not a label move: the weight swings above
    // must have re-routed someone for real (this is what the repriced-offer adoption
    // in store-replica-set.setOffers guarantees; without it routeMoves stays 0).
    await check('churn: voluntary migrations actually moved routes', () => routeMoves > 0, true)

    // ============== 3. transport blips: reconnect repairs, never duplicates ==============
    for (let blip = 0; blip < 2; blip++) {
        for (const sim of readers) {
            for (const hub of sim.hubs) {
                const socket = hub.socket as any
                const engine = socket?.io?.engine
                if (socket?.connected && engine?.close) engine.close()
            }
        }
        await delay(900) // sockets reconnect and recoverable listens re-issue
    }
    await waitFor('blips: every reader is routed again', () => truth().n1 + truth().n2 == 4)
    await waitFor('blips: counts equal actual routes after reconnects', countsMatchTruth, WAIT_MS)
    await check('blips: reconnect leaves no ghost subscriptions', () => {
        const c = counts()
        const t = truth()
        return [c.n1 - t.n1, c.n2 - t.n2]
    }, [0, 0])

    // ============== 4. closing readers: counts AND sockets must FALL to zero ==============
    // The stand's second live defect: after closeSimReaders the browser still held
    // 13 established TCP connections per mini. Line counts alone cannot see a
    // zombie socket, so this phase asserts the ENGINE connection count too.
    for (const sim of readers) sim.close()
    await waitFor('close: both nodes return to zero readers', () => {
        const c = counts()
        return c.n1 == 0 && c.n2 == 0
    }, WAIT_MS)
    await check('close: no subscription survives its reader', counts, {n1: 0, n2: 0})
    await waitFor('close: every reader SOCKET drains from both nodes',
        () => one.sockets() == 0 && two.sockets() == 0, WAIT_MS)
    await check('close: no zombie socket survives its reader', () =>
        [one.sockets(), two.sockets()], [0, 0])

    // ============== 4b. close DURING reconnection backoff: no resurrected engines ==============
    // The browser stand closes readers while some hubs sit in a reconnect cycle
    // (background-tab throttling drops engines). A disconnect issued during the
    // backoff must also cancel the manager's pending reconnect — a timer that
    // fires after the disconnect would resurrect an engine no hub points at any
    // more: an unkillable ESTABLISHED socket exactly like the 13 chrome zombies.
    const lateReaders = [spawnSimReader(11, directory), spawnSimReader(12, directory)]
    readers.push(...lateReaders)
    await Promise.all(lateReaders.map(sim => sim.reader.ready))
    await waitFor('backoff-close: late readers subscribed', () => truth().n1 + truth().n2 == 2)
    for (const sim of lateReaders) {
        for (const hub of sim.hubs) (hub.socket as any)?.io?.engine?.close()
    }
    // inside the reconnection window: engines are down, managers hold retry timers
    await delay(30)
    for (const sim of lateReaders) sim.close()
    readers.length -= 2
    await delay(2500) // give any stray reconnect timer time to resurrect an engine
    await check('backoff-close: line counts drain to zero', counts, {n1: 0, n2: 0})
    await check('backoff-close: no resurrected engine survives the close', () =>
        [one.sockets(), two.sockets()], [0, 0])

    // ============== 5. rapid LIVE-socket hand-offs: the stand's flap corridor ==============
    // Both sessions stay OPEN (fork-choice keeps sockets to every node), the line
    // moves by switch() — unsubscribes ride the LIVE socket as removeCallback while
    // ticks keep flowing. Switches are issued back-to-back WITHOUT awaiting, the
    // way route churn overlaps catch-ups in the real stand.
    function openHub(nodeId: string) {
        const hub = createRpcClientHub(
            () => io('http://localhost:' + PORTS[nodeId], {transports: ['websocket'], auth: {tab: 'flap', role: 'reader'}, forceNew: true}),
            r => ({app: r<any>('app')}) as const,
        )
        return hub
    }
    const {createStore} = await import('../../src/Common/Observe/store')
    const {syncStoreReplayRoute} = await import('../../src/Common/Observe/store-replay')
    const hubA = openHub('n1')
    const hubB = openHub('n2')
    const clientsA = await hubA.setToken(null) as any
    const clientsB = await hubB.setToken(null) as any
    await clientsA.app.readyStrict()
    await clientsB.app.readyStrict()
    const remoteA = clientsA.app.func.svc.replica.replay
    const remoteB = clientsB.app.func.svc.replica.replay
    const mirror = createStore<TickState>({})
    const route = syncStoreReplayRoute(mirror, remoteA, {label: 'n1', since: -1, reset: true})
    await route.ready
    await waitFor('flap: initial live-socket route counts one on n1', () => counts().n1 == 1)
    for (let i = 0; i < 25; i++) {
        const toB = route.switch(remoteB, {label: 'n2'})
        const backA = route.switch(remoteA, {label: 'n1'})
        await Promise.allSettled([toB, backA])
    }
    await delay(600)
    await check('flap: 50 live hand-offs leave exactly the active subscription', counts, {n1: 1, n2: 0})

    // ============== 6. a blip in the MIDDLE of a hand-off must strand nothing ==============
    for (let i = 0; i < 3; i++) {
        const toB = route.switch(remoteB, {label: 'n2'})
        ;(hubB.socket as any)?.io?.engine?.close()   // transient failure mid-catch-up
        await Promise.allSettled([toB])
        await waitFor('flap-blip: n2 socket reconnects', () => (hubB.socket as any)?.connected == true)
        const backA = route.switch(remoteA, {label: 'n1'})
        await Promise.allSettled([backA])
    }
    await delay(600)
    await check('flap-blip: interrupted hand-offs leave exactly the active subscription', () => {
        const c = counts()
        return {n1: c.n1, n2: c.n2, active: route.active(), label: route.label()}
    }, {n1: 1, n2: 0, active: true, label: 'n1'})

    route()
    ;(hubA.socket as any)?.disconnect?.()
    ;(hubB.socket as any)?.disconnect?.()
    await waitFor('flap: teardown returns both nodes to zero', () => {
        const c = counts()
        return c.n1 == 0 && c.n2 == 0
    }, WAIT_MS)
    await waitFor('flap: teardown drains every socket too',
        () => one.sockets() == 0 && two.sockets() == 0, WAIT_MS)
    await check('teardown: zero sockets on both nodes at the end', () =>
        [one.sockets(), two.sockets()], [0, 0])

    clearInterval(ticker)
    one.node.close()
    two.node.close()
    await one.close()
    await two.close()
    directory.control.close()
    authority.close()
    clearTimeout(watchdog)
    process.exit(done() == 0 ? 0 : 1)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
