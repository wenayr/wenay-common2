// ============================================================
//  observe/node-directory.test.ts
//
//  Node directory: replicated roster of service nodes. Host verbs
//  (upsert/heartbeat/drain/undrain/remove), pure staleness/pick derivation,
//  the follow facade over the ordinary replay wire, and the offers bridge:
//  drain in the directory moves a replica-set client to another node with
//  seq continuity — the mini horizontal-scaling core.
//  Run: npx tsx observe/node-directory.test.ts
// ============================================================

import {
    createNodeDirectory, directoryReplicaOffers, followNodeDirectory,
    nodeDirectoryViews, pickDirectoryNode,
} from '../src/Common/Observe/node-directory'
import {createStoreReplicaSet} from '../src/Common/Observe/store-replica-set'
import {flushReactive} from '../src/Common/Observe/reactive'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const json = (v: any) => JSON.stringify(v)

async function waitFor(label: string, condition: () => boolean, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    fails++
    console.log('  FAIL timeout waiting for ' + label)
}

// ============== host verbs + pure derivation (fake clock) ==============
async function hostAndPickPart() {
    let t = 1000
    const dir = createNodeDirectory({now: () => t})
    dir.control.upsert({nodeId: 'a', url: 'u-a', role: 'leader', weight: 2})
    dir.control.upsert({nodeId: 'b', url: 'u-b', role: 'mirror', weight: 1})
    const viewOpts = {staleMs: 5000, now: () => t}

    let views = nodeDirectoryViews(dir.control.snapshot(), viewOpts)
    ok(views.length == 2 && views.every(v => v.eligible), 'two fresh nodes are eligible')
    ok(pickDirectoryNode(views, {rng: () => 0})?.nodeId == 'a', 'weighted pick: low roll lands on the heavy node')
    ok(pickDirectoryNode(views, {rng: () => 0.9})?.nodeId == 'b', 'weighted pick: high roll lands on the light node')
    ok(pickDirectoryNode(views, {exclude: 'a', rng: () => 0})?.nodeId == 'b', 'exclude removes a candidate')

    ok(dir.control.drain('b'), 'drain acks a known node')
    views = nodeDirectoryViews(dir.control.snapshot(), viewOpts)
    ok(views.find(v => v.nodeId == 'b')?.draining == true, 'drain publishes intent')
    ok(pickDirectoryNode(views, {rng: () => 0.99})?.nodeId == 'a', 'draining node takes no new placements')

    ok(dir.control.undrain('b', 5), 'undrain acks')
    views = nodeDirectoryViews(dir.control.snapshot(), viewOpts)
    ok(views.find(v => v.nodeId == 'b')?.weight == 5, 'undrain can restore a new weight')

    ok(dir.control.heartbeat('a', {weight: 0}), 'weight update via heartbeat')
    views = nodeDirectoryViews(dir.control.snapshot(), viewOpts)
    ok(views.find(v => v.nodeId == 'a')?.eligible == false, 'weight <= 0 closes the node')
    ok(dir.control.heartbeat('ghost') == false, 'heartbeat of an unknown node reports false')

    // meta merges one level at the DIRECTORY layer: each heartbeat writer owns its
    // facts and must not erase what another writer reported (readers vs labels)
    ok(dir.control.heartbeat('b', {meta: {readers: 7}}), 'heartbeat lands a meta fact')
    ok(dir.control.heartbeat('b', {meta: {labels: {app: 'x'}}}), 'a second writer patches its own fact')
    const bMeta = dir.control.get('b')?.meta
    ok(bMeta?.['readers'] == 7 && json(bMeta?.['labels']) == json({app: 'x'}),
        'heartbeat meta MERGES: one writer does not erase the other writer\'s fact')

    t += 20_000
    views = nodeDirectoryViews(dir.control.snapshot(), viewOpts)
    ok(views.every(v => v.stale), 'silent nodes go stale by heartbeat age')
    ok(pickDirectoryNode(views) == null, 'nothing eligible -> pick is null')
    dir.control.heartbeat('b')
    views = nodeDirectoryViews(dir.control.snapshot(), viewOpts)
    ok(views.find(v => v.nodeId == 'b')?.eligible == true, 'heartbeat revives a stale node')

    dir.control.remove('a')
    ok(dir.control.get('a') == undefined, 'remove deletes the row')
    dir.control.close()
}

// ============== follow facade over the in-process replay wire ==============
async function followPart() {
    const dir = createNodeDirectory()
    dir.control.upsert({nodeId: 'a', url: 'u-a', role: 'leader', weight: 1})
    const followed = followNodeDirectory(dir.api, {staleMs: 0})
    await followed.ready
    await tick()
    ok(followed.nodes().length == 1, 'follower sees the registered node')

    let observed: string[] = []
    const offNodes = followed.onNodes(views => { observed = views.map(v => v.nodeId + ':' + (v.eligible ? 1 : 0)) })
    dir.control.upsert({nodeId: 'b', url: 'u-b', role: 'mirror', weight: 3})
    await waitFor('follower observes the new node', () => observed.length == 2)
    dir.control.drain('b')
    await waitFor('follower observes the drain', () => observed.includes('b:0'))
    ok(followed.pick({rng: () => 0.99})?.nodeId == 'a', 'follower pick avoids the draining node')
    offNodes()
    followed.close()
    dir.control.close()
}

// ============== staleness is host-clock anchored (reader-skew immune) ==============
async function skewPart() {
    // the host clock lives 'far in the reader's past' — a real browser-vs-server skew
    let hostT = 1_000_000
    const dir = createNodeDirectory({now: () => hostT})
    dir.control.upsert({nodeId: 's1', url: 'u-s1', role: 'leader', weight: 1})
    // no explicit now: the follower must anchor on host stamps, never read its own clock as absolute
    const followed = followNodeDirectory(dir.api, {staleMs: 250})
    await followed.ready
    await tick()
    ok(followed.nodes().find(v => v.nodeId == 's1')?.eligible == true,
        'a freshly heartbeaten row is eligible under massive reader-host clock skew')
    // death detection still works, measured in LOCALLY elapsed time
    await new Promise<void>(resolve => setTimeout(resolve, 400))
    ok(followed.nodes().find(v => v.nodeId == 's1')?.stale == true,
        'a silent node still goes stale by locally-elapsed heartbeat age')
    // a heartbeat revives it: the anchor follows the freshest host stamp
    hostT += 5_000
    dir.control.heartbeat('s1')
    await waitFor('the skewed follower sees the revived row',
        () => followed.nodes().find(v => v.nodeId == 's1')?.eligible == true)
    followed.close()
    dir.control.close()
}

// ============== offers bridge: pure heartbeats publish nothing ==============
async function offersChurnPart() {
    const dir = createNodeDirectory()
    dir.control.upsert({nodeId: 'p1', url: 'u-p1', role: 'leader', weight: 2})
    const followed = followNodeDirectory(dir.api, {staleMs: 0})
    await followed.ready
    await tick()
    const offers = directoryReplicaOffers({
        directory: followed,
        connect: () => ({remote: null as any, close() {}}),
    })
    let publishes = 0
    const offPublishes = offers.api.changes.on(() => { publishes++ })
    dir.control.heartbeat('p1')
    dir.control.heartbeat('p1')
    for (let i = 0; i < 6; i++) await tick()
    ok(publishes == 0, 'pure heartbeat ticks publish NO offer replacement (eligibility and price unchanged)')
    dir.control.heartbeat('p1', {weight: 9})
    await waitFor('a reprice publishes a fresh offer list', () => publishes > 0)
    if (typeof offPublishes == 'function') offPublishes()
    offers.close()
    followed.close()
    dir.control.close()
}

// ============== offers bridge + replica set: the scaling core ==============
async function balancePart() {
    type State = Record<string, {id: string, value: number}>
    const leader = createStoreReplicaSet<State>({
        storeId: 'balance', originId: 'balance-origin', nodeId: 'node-a', lineId: 'line-a',
        initial: {seed: {id: 'seed', value: 1}},
        leadership: {initialRole: 'leader', epoch: 1},
    })
    const mirror = createStoreReplicaSet<State>({
        storeId: 'balance', originId: 'balance-origin', nodeId: 'node-b', lineId: 'line-b',
        initial: {},
        leadership: {initialRole: 'follower', eligible: false},
    })
    mirror.control.addOffer({
        id: 'to-leader',
        connect: () => ({remote: leader.api.fragment, close() {}}),
    })
    await mirror.api.ready

    const dir = createNodeDirectory()
    dir.control.upsert({nodeId: 'node-a', url: 'inproc:a', role: 'leader', weight: 1})
    dir.control.upsert({nodeId: 'node-b', url: 'inproc:b', role: 'mirror', weight: 100})
    const followed = followNodeDirectory(dir.api, {staleMs: 0})
    await followed.ready
    await tick()

    const offers = directoryReplicaOffers({
        directory: followed,
        connect: node => ({
            remote: node.nodeId == 'node-a' ? leader.api.fragment : mirror.api.fragment,
            close() {},
        }),
    })
    ok(offers.api.list().length == 2, 'bridge exposes both eligible nodes as offers')
    const priorities = new Map(offers.api.list().map(offer => [offer.id, offer.priority]))
    ok((priorities.get('node-b') ?? 0) < (priorities.get('node-a') ?? 0), 'higher weight -> cheaper route')

    const client = createStoreReplicaSet<State>({
        storeId: 'balance', originId: 'balance-origin', nodeId: 'client', lineId: 'line-c',
        initial: {},
        leadership: {initialRole: 'follower', eligible: false},
        offers: offers.api,
    })
    await client.api.ready
    await waitFor('client lands on the heavy mirror', () => client.api.status.state.routeId == 'node-b')
    ok(json(client.api.status.state.path) == json(['node-a', 'node-b', 'client']), 'route path is the two-hop cascade')

    leader.control.store.state.k1 = {id: 'k1', value: 10}
    await flushReactive(leader.control.store.state)
    await waitFor('live write reaches the client through the mirror', () => client.api.store.state.k1?.value == 10)

    // drain the serving node -> the client must move to the leader without loss
    dir.control.drain('node-b')
    await waitFor('drain moves the client to the leader', () => client.api.status.state.routeId == 'node-a')
    leader.control.store.state.k2 = {id: 'k2', value: 20}
    await flushReactive(leader.control.store.state)
    await waitFor('post-drain write arrives on the new route', () => client.api.store.state.k2?.value == 20)
    ok(json(client.api.store.snapshot()) == json(leader.api.store.snapshot()), 'no loss across the drain hand-off')

    // drain everything -> offline; undrain -> the client comes back
    dir.control.drain('node-a')
    await waitFor('no eligible nodes -> client loses its route', () => client.api.status.state.routeId == null)
    dir.control.undrain('node-a')
    await waitFor('undrain restores the route', () => client.api.status.state.routeId == 'node-a')
    leader.control.store.state.k3 = {id: 'k3', value: 30}
    await flushReactive(leader.control.store.state)
    await waitFor('write after the outage converges', () => client.api.store.state.k3?.value == 30)

    client.close()
    offers.close()
    followed.close()
    dir.control.close()
    mirror.close()
    leader.close()
}

async function main() {
    const watchdog = setTimeout(function oracleTimedOut() {
        console.error('node-directory oracle timed out')
        process.exit(3)
    }, 60_000)
    await hostAndPickPart()
    await followPart()
    await skewPart()
    await offersChurnPart()
    await balancePart()
    clearTimeout(watchdog)
    console.log(fails ? `node-directory: ${fails} FAILED` : 'node-directory: ALL GREEN')
    process.exit(fails ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
