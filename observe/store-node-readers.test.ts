// ============================================================
//  observe/store-node-readers.test.ts
//
//  The readers fact of a serving store node is the LINE subscriber count, so
//  it must fall exactly as it rises: a clean follower close releases its
//  subscription, an abrupt socket death releases every subscription of that
//  session, and a route hand-off — completed OR aborted mid-catch-up — never
//  strands a ghost subscription on the node it left. Proven over REAL RPC on
//  the in-process loopback, exactly like observe/store-node.test.ts.
//  Run: npx tsx observe/store-node-readers.test.ts
// ============================================================

import {createRpcClient} from '../src/Common/rcp/rpc-client'
import {createLoopbackSocketPair} from '../src/Common/rcp/rpc-inproc'
import type {SocketTmpl} from '../src/Common/rcp/rpc-protocol'
import {createNodeDirectory, type NodeDirectoryView} from '../src/Common/Observe/node-directory'
import {createStore} from '../src/Common/Observe/store'
import {syncStoreReplayRoute} from '../src/Common/Observe/store-replay'
import {createStoreFollower} from '../src/Common/Observe/store-follower'
import {createStoreReplicaSet} from '../src/Common/Observe/store-replica-set'
import {createStoreNode, type StoreNodeInstance} from '../src/Common/Observe/store-node'
import {createClusterClient} from '../src/Common/scale/scale-client'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

async function waitFor(message: string, check: () => boolean, timeoutMs = 4000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (check()) { ok(true, message); return }
        await new Promise(resolve => setTimeout(resolve, 15))
    }
    ok(false, message + ' (timed out)')
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type TickState = Record<string, {id: string, value: number}>

function bootNode(deps: {
    nodeId: string
    authority: ReturnType<typeof createStoreReplicaSet<TickState>>
    directory: ReturnType<typeof createNodeDirectory>
}) {
    let connect: ((socket: SocketTmpl) => void) | null = null
    const node = createStoreNode<TickState>({
        nodeId: deps.nodeId, storeId: 'readers-line', originId: 'readers-origin',
        graceMs: 40,
        upstream: () => ({
            replica: deps.authority.api.fragment,
            directory: deps.directory.api,
            register: entry => deps.directory.control.upsert({...entry, role: 'mirror'}),
            heartbeat: (nodeId, facts) => deps.directory.control.heartbeat(nodeId, {meta: {readers: facts?.readers ?? 0}}),
            goodbye: nodeId => deps.directory.control.remove(nodeId),
            onFail: {on: () => () => {}},
        }),
        serve: {onConnection(handler) { connect = handler }},
        selfUrl: () => 'mem://' + deps.nodeId,
        heartbeatMs: 50,
        onLeave: () => {},
        wrap: fragment => ({svc: fragment}),
        log: () => {},
    })
    return {node, connect: (socket: SocketTmpl) => connect!(socket)}
}

async function openReader(serve: (socket: SocketTmpl) => void) {
    const {client: clientEnd, server: serverEnd, kill} = createLoopbackSocketPair()
    serve(serverEnd)
    const client = createRpcClient<any>({socket: clientEnd, socketKey: 'app'})
    await client.readyStrict()
    return {client, remote: (client.func.svc.replica as any).replay, kill}
}

const readersOf = (node: StoreNodeInstance) => node.view.status().readers

async function main() {
    const watchdog = setTimeout(function oracleTimedOut() {
        console.error('store-node-readers oracle timed out')
        process.exit(3)
    }, 60_000)

    const authority = createStoreReplicaSet<TickState>({
        storeId: 'readers-line', originId: 'readers-origin', nodeId: 'authority', lineId: 'authority-line',
        initial: {tick: {id: 'tick', value: 0}},
        leadership: {initialRole: 'leader', epoch: 1},
    })
    const directory = createNodeDirectory()
    const one = bootNode({nodeId: 'n1', authority, directory})
    const two = bootNode({nodeId: 'n2', authority, directory})
    await one.node.start()
    await two.node.start()
    ok(readersOf(one.node) == 0 && readersOf(two.node) == 0, 'a fresh node serves zero readers')

    // ============== A. count rises to the REAL reader count, no more ==============
    const readers = [] as Awaited<ReturnType<typeof openReader>>[]
    const followers = [] as ReturnType<typeof createStoreFollower<TickState>>[]
    for (let index = 0; index < 3; index++) {
        const reader = await openReader(one.connect)
        readers.push(reader)
        const follower = createStoreFollower<TickState>({remote: reader.remote})
        followers.push(follower)
        await follower.ready
    }
    await waitFor('three live followers count as exactly three readers', () => readersOf(one.node) == 3)
    await sleep(150)
    ok(readersOf(one.node) == 3, `the count stays 3 while the readers stay (got ${readersOf(one.node)})`)

    // ============== B. a clean close releases exactly one subscription ==============
    followers[0].close()
    await waitFor('a cleanly closed follower leaves the count', () => readersOf(one.node) == 2)

    // ============== C. socket death releases the dead session's subscriptions ==============
    readers[1].kill()
    await waitFor('an abrupt socket death releases its reader', () => readersOf(one.node) == 1)
    readers[2].kill()
    await waitFor('the second socket death releases the last reader', () => readersOf(one.node) == 0)
    await sleep(150)
    ok(readersOf(one.node) == 0, `no ghost subscriptions survive dead sessions (got ${readersOf(one.node)})`)

    // ============== D. route hand-offs: flapping between nodes strands nothing ==============
    const linkA = await openReader(one.connect)
    const linkB = await openReader(two.connect)
    const mirror = createStore<TickState>({})
    const route = syncStoreReplayRoute(mirror, linkA.remote, {label: 'n1', since: -1, reset: true})
    await route.ready
    await waitFor('the initial route subscribes one reader on n1', () => readersOf(one.node) == 1)
    for (let flap = 0; flap < 4; flap++) {
        await route.switch(linkB.remote, {label: 'n2'})
        await route.switch(linkA.remote, {label: 'n1'})
    }
    await waitFor('after 8 hand-offs the LEFT node holds zero readers', () => readersOf(two.node) == 0)
    await waitFor('after 8 hand-offs the active node holds exactly one reader', () => readersOf(one.node) == 1)

    // ============== E. an ABORTED hand-off (catch-up never finishes) must release too ==============
    const never = new Promise<never>(() => {})
    const stuck = {
        line: linkB.remote.line,
        since: () => never,
        keyframe: () => never,
        frame: () => never,
    }
    const aborted = await route.switch(stuck as any, {label: 'stuck', timeoutMs: 150}).then(
        () => 'completed',
        (error: any) => String(error?.message ?? error),
    )
    ok(aborted.includes('timeout'), `the stuck hand-off aborts by timeout (${aborted})`)
    await waitFor('the aborted hand-off releases its line subscription on n2', () => readersOf(two.node) == 0)
    ok(readersOf(one.node) == 1, 'the active route on n1 survives the aborted hand-off')

    // ============== F. closing the route client returns both nodes to baseline ==============
    route()
    await waitFor('closing the route client releases n1', () => readersOf(one.node) == 0)
    linkA.kill()
    linkB.kill()
    await sleep(150)
    ok(readersOf(one.node) == 0 && readersOf(two.node) == 0,
        `both nodes are back to zero readers (n1 ${readersOf(one.node)}, n2 ${readersOf(two.node)})`)

    // ============== G. a balance migration MOVES the line, not just the label ==============
    // The stand's readers fact IS the line subscriber count. placement.balance
    // promises "voluntarily migrate off a gross overload ... the hand-off itself
    // stays gap-free by seq" — so a voluntary move must RELEASE the old node's
    // subscription and subscribe the new one. A migration that only relabels
    // placedNodeId leaves the count on the old node forever: exactly the
    // "readers only ever grow" poisoning observed live on the mini stand.
    const sessionKills: (() => void)[] = []
    async function connectBalanced(view: NodeDirectoryView) {
        const serve = view.nodeId == 'n1' ? one.connect : two.connect
        const {client: clientEnd, server: serverEnd, kill} = createLoopbackSocketPair()
        serve(serverEnd)
        const client = createRpcClient<any>({socket: clientEnd, socketKey: 'app'})
        await client.readyStrict()
        sessionKills.push(kill)
        return {
            remote: (client.func.svc.replica as any),
            close() { kill() },
        }
    }
    const balanced = createClusterClient<TickState>({
        storeId: 'readers-line', originId: 'readers-origin', nodeId: 'balance-client',
        initial: {},
        directory: directory.api,
        connect: connectBalanced,
        placement: {
            staleMs: 10_000,
            rng: () => 0,
            balance: {aboveShare: 0.9, belowShare: 1.2, checkMs: 50, moveChance: 1, cooldownMs: 100},
        },
        log: () => {},
    })
    await balanced.ready
    const firstNode = balanced.placement.placedNodeId()
    ok(firstNode == 'n1' || firstNode == 'n2', `the balanced client placed somewhere (${firstNode})`)
    const nodeOf = (id: string | null) => id == 'n1' ? one.node : two.node
    const otherOf = (id: string | null) => id == 'n1' ? two.node : one.node
    await waitFor('the balanced client subscribes the placed node',
        () => readersOf(nodeOf(firstNode)) == 1 && readersOf(otherOf(firstNode)) == 0)
    // the placed node now reports load 1 vs 0 — the voluntary trickle must fire
    await waitFor('balance relabels the placement onto the empty node',
        () => balanced.placement.placedNodeId() != firstNode, 6000)
    const movedTo = balanced.placement.placedNodeId()
    await waitFor(`the LINE follows the voluntary move (readers 1 on ${movedTo}, 0 on ${firstNode})`,
        () => readersOf(nodeOf(movedTo)) == 1 && readersOf(nodeOf(firstNode)) == 0, 6000)
    balanced.close()
    for (const kill of sessionKills) kill()
    await waitFor('closing the balanced client returns both nodes to zero',
        () => readersOf(one.node) == 0 && readersOf(two.node) == 0)

    for (const follower of followers) follower.close()
    for (const reader of readers) reader.kill()
    one.node.close()
    two.node.close()
    directory.control.close()
    authority.close()
    clearTimeout(watchdog)
    console.log(fails == 0 ? '\nstore-node-readers: ALL GREEN' : `\nstore-node-readers: ${fails} FAILURES`)
    process.exit(fails ? 1 : 0)
}
void main()
