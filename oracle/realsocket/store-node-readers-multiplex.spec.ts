// REAL-SOCKET multiplex-faithful readers oracle. The browser demo creates every
// sim reader's per-node socket EXACTLY as io(node.url, {transports:
// ['websocket', 'polling'], auth}) — same URL per node, NO forceNew, NO
// multiplex:false — so socket.io-client's manager cache is in play (the first
// call per URL owns the cached manager, later calls fork fresh ones only
// because the namespace is occupied). If that reuse strands or shares engines,
// closing a reader through the demo's exact sequence (clusterClient.close(),
// then a raw-socket sweep of every socket its createSocket ever returned) must
// leave another reader's subscriptions or sockets behind. Both legs run: the
// browser-faithful shared style, then the forceNew contrast — a divergence
// between them IS the multiplex verdict. Ports 4181/4182.
import {Server as SocketIOServer} from 'socket.io'
import {createServer} from 'http'
import {io} from 'socket.io-client'
import {makeChecker, delay} from './_rs'
import {createRpcClientHub} from '../../src/Common/rcp/rpc-clientHub'
import {createNodeDirectory, type NodeDirectoryView} from '../../src/Common/Observe/node-directory'
import {createStoreReplicaSet} from '../../src/Common/Observe/store-replica-set'
import {createStoreNode} from '../../src/Common/Observe/store-node'
import {createClusterClient} from '../../src/Common/scale/scale-client'

const PORTS: Record<string, number> = {n1: 4181, n2: 4182}
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

async function bootRealNode(deps: {
    nodeId: string
    authority: ReturnType<typeof createStoreReplicaSet<TickState>>
    directory: ReturnType<typeof createNodeDirectory>
}) {
    const port = PORTS[deps.nodeId]
    const httpServer = createServer()
    const ioServer = new SocketIOServer(httpServer, {cors: {origin: true, methods: ['GET', 'POST']}})
    const node = createStoreNode<TickState>({
        nodeId: deps.nodeId, storeId: 'mx-readers', originId: 'mx-readers-origin',
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
        wrap: fragment => ({miniScale: fragment}),
        log: () => {},
    })
    await new Promise<void>(resolve => httpServer.listen(port, resolve))
    await node.start()
    return {
        node,
        sockets: () => ioServer.engine.clientsCount,
        close: () => new Promise<void>(resolve => { ioServer.close(); httpServer.close(() => resolve()) }),
    }
}

// the demo's sim reader, byte-faithful: per-node hub whose createSocket is
// literally io(node.url, {transports: ['websocket', 'polling'], auth}); the
// close path is clusterClient.close() FIRST, then the raw-socket sweep
function spawnDemoReader(k: number, directory: ReturnType<typeof createNodeDirectory>, forceNew: boolean) {
    const hubs = new Set<ReturnType<typeof createRpcClientHub>>()
    const rawSockets = new Set<any>()
    async function connectReaderNode(node: NodeDirectoryView) {
        const hub = createRpcClientHub(
            () => {
                const socket = io(node.url, {
                    transports: ['websocket', 'polling'],
                    auth: {tab: 'mx-reader-' + k, role: 'reader'},
                    ...(forceNew ? {forceNew: true} : {}),
                })
                rawSockets.add(socket)
                return socket
            },
            r => ({app: r<any>('app')}) as const,
        )
        hubs.add(hub)
        const clients = await hub.setToken(null)
        await (clients as any).app.readyStrict()
        return {
            remote: ((clients as any).app.func as any).miniScale.replica,
            onFail: {on: (cb: () => void) => hub.disconnectListen(cb)},
            close() {
                hubs.delete(hub)
                ;(hub.socket as any)?.disconnect?.()
            },
        }
    }
    const reader = createClusterClient<TickState>({
        storeId: 'mx-readers', originId: 'mx-readers-origin',
        nodeId: 'mx-sim-' + k,
        initial: {},
        directory: directory.api,
        connect: connectReaderNode,
        placement: {staleMs: 10_000, label: `mx #${k}`, balance: {checkMs: 60, cooldownMs: 250, moveChance: 1}},
        log: () => {},
    })
    return {
        k,
        reader,
        routeNodeId: () => reader.status.state.routeNodeId,
        close() {
            try { reader.close() }
            finally {
                for (const socket of rawSockets) socket?.disconnect?.()
                rawSockets.clear()
                hubs.clear()
            }
        },
    }
}

async function runLeg(
    label: string,
    forceNew: boolean,
    check: ReturnType<typeof makeChecker>['check'],
    env: {
        directory: ReturnType<typeof createNodeDirectory>
        one: Awaited<ReturnType<typeof bootRealNode>>
        two: Awaited<ReturnType<typeof bootRealNode>>
        setWeight: (nodeId: string, weight: number) => void
    },
) {
    const {directory, one, two, setWeight} = env
    const counts = () => ({n1: one.node.view.status().readers, n2: two.node.view.status().readers})
    const readers = [] as ReturnType<typeof spawnDemoReader>[]
    function truth() {
        const t = {n1: 0, n2: 0}
        for (const sim of readers) {
            const at = sim.routeNodeId()
            if (at == 'n1') t.n1++
            if (at == 'n2') t.n2++
        }
        return t
    }
    const matches = () => {
        const c = counts()
        const t = truth()
        return c.n1 == t.n1 && c.n2 == t.n2
    }

    // storm-shaped spawn: one reader at a time onto one shared URL per node
    for (let k = 1; k <= 6; k++) {
        readers.push(spawnDemoReader(k * (forceNew ? 100 : 1), directory, forceNew))
        await delay(120)
    }
    await Promise.all(readers.map(sim => sim.reader.ready))
    await waitFor(label + ': six readers routed', () => truth().n1 + truth().n2 == 6)
    await waitFor(label + ': counts match routes after the storm', matches)

    // a weight swing forces real balance migrations across the SHARED-url sockets
    setWeight('n1', 12)
    setWeight('n2', 1)
    await delay(900)
    setWeight('n1', 4)
    setWeight('n2', 4)
    await delay(900)
    await waitFor(label + ': counts match routes after migrations', matches)

    // close HALF through the demo's exact sequence
    for (const sim of readers.slice(0, 3)) sim.close()
    const survivors = readers.slice(3)
    readers.length = 0
    readers.push(...survivors)
    await waitFor(label + ': closed half release their lines', matches)
    await check(label + ': half-close leaves only the survivors subscribed', () => {
        const c = counts()
        const t = truth()
        return [c.n1 - t.n1, c.n2 - t.n2]
    }, [0, 0])

    // close the rest: both counts AND engines must reach the baseline
    for (const sim of readers) sim.close()
    readers.length = 0
    await waitFor(label + ': full close drains both lines', () => {
        const c = counts()
        return c.n1 == 0 && c.n2 == 0
    })
    await waitFor(label + ': full close drains every engine', () => one.sockets() == 0 && two.sockets() == 0)
    await check(label + ': no ghost line subscription survives', counts, {n1: 0, n2: 0})
    await check(label + ': no ghost engine survives', () => [one.sockets(), two.sockets()], [0, 0])
}

async function main() {
    const {check, done} = makeChecker('store-node-readers-multiplex')
    const watchdog = setTimeout(function watchdogTimeout() {
        console.error('WATCHDOG timeout')
        process.exit(3)
    }, 240_000)

    const authority = createStoreReplicaSet<TickState>({
        storeId: 'mx-readers', originId: 'mx-readers-origin', nodeId: 'authority', lineId: 'authority-line',
        initial: {tick: {id: 'tick', value: 0}},
        leadership: {initialRole: 'leader', epoch: 1},
    })
    const directory = createNodeDirectory()
    const one = await bootRealNode({nodeId: 'n1', authority, directory})
    const two = await bootRealNode({nodeId: 'n2', authority, directory})
    const ticker = setInterval(function tickAuthority() {
        authority.control.store.state.tick = {id: 'tick', value: Date.now() % 100000}
    }, 40)
    function setWeight(nodeId: string, weight: number) {
        const row = directory.control.get(nodeId)
        if (row) directory.control.upsert({...row, weight})
    }
    const env = {directory, one, two, setWeight}

    // leg 1: the browser-faithful shape — shared URL, no forceNew, polling in the list
    await runLeg('shared', false, check, env)
    // leg 2: the forceNew contrast — a divergence between the legs is the multiplex verdict
    await runLeg('forceNew', true, check, env)

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
