import {flushReactive} from '../src/Common/Observe/reactive'
import {
    createStoreReplicaSet,
    StoreReplicaOffer,
    StoreReplicaSet,
} from '../src/Common/Observe/store-replica-set'

type Item = {id: string, value: number, owner: string}
type State = Record<string, Item>

let fails = 0
function ok(condition: unknown, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

const delay = (ms: number) => new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })
const json = (value: unknown) => JSON.stringify(value)

async function waitFor(label: string, condition: () => boolean | Promise<boolean>, attempts = 200) {
    for (let i = 0; i < attempts; i++) {
        if (await condition()) return
        await delay(10)
    }
    throw new Error('timeout: ' + label)
}

function createRoute(id: string, target: StoreReplicaSet<State>, initialLatency: number) {
    let online = true
    let latency = initialLatency
    const sessions = new Set<{fail: (reason?: unknown) => void}>()

    const offer: StoreReplicaOffer = {
        id,
        async connect() {
            if (!online) throw new Error(id + ' offline')
            let closed = false
            const failCbs = new Set<(reason?: unknown) => void>()
            const session = {
                fail(reason?: unknown) {
                    if (closed) return
                    for (const cb of Array.from(failCbs)) cb(reason)
                },
            }
            sessions.add(session)
            return {
                remote: {
                    descriptor: target.api.fragment.descriptor,
                    changed: target.api.fragment.changed,
                    replay: target.api.fragment.replay,
                    async ping() { await delay(latency) },
                },
                onFail: {
                    on(cb: (reason?: unknown) => void) {
                        failCbs.add(cb)
                        return function offRouteFailure() { failCbs.delete(cb) }
                    },
                },
                close() {
                    if (closed) return
                    closed = true
                    failCbs.clear()
                    sessions.delete(session)
                },
            }
        },
    }

    return {
        offer,
        latency(value: number) { latency = value },
        online(value: boolean) {
            online = value
            if (!value) for (const session of Array.from(sessions)) session.fail(new Error(id + ' failed'))
        },
    }
}

function createNode(nodeId: string, initialRole: 'leader' | 'follower', epoch = 0, eligible = true) {
    return createStoreReplicaSet<State>({
        storeId: 'board',
        originId: 'board-origin',
        nodeId,
        lineId: nodeId + '-line',
        initial: {},
        expose: {history: 100},
        leadership: {initialRole, epoch, eligible, autoPromoteMs: 35},
        route: {reconnectMs: 15, pingTimeoutMs: 200, hysteresisMs: 2},
    })
}

async function main() {
    console.log('\n[store-replica-set] dynamic offers and latency route choice')
    const a = createNode('a', 'leader')
    a.control.store.state.seed = {id: 'seed', value: 1, owner: 'a'}
    await flushReactive(a.control.store.state)

    const b = createNode('b', 'follower')
    const slow = createRoute('relay-a', a, 25)
    const fast = createRoute('direct-a', a, 2)
    b.control.addOffer(slow.offer)
    await b.api.ready
    await waitFor('B follows A', () => b.api.status.state.role == 'follower')
    ok(json(b.api.store.snapshot()) == json(a.api.store.snapshot()), 'follower starts from the leader keyframe')
    ok(b.api.status.state.routeId == 'relay-a', 'the first discovered route becomes active')

    b.control.addOffer(fast.offer)
    await b.control.probe()
    await waitFor('fast route selected', () => b.api.status.state.routeId == 'direct-a')
    ok(b.api.status.state.rtt! < 15, 'a shorter measured route replaces the relay')

    const seen: number[] = []
    const offSeen = b.api.store.node.at('seed').at('value').on(function seeReplicaValue(value) { seen.push(value) })
    a.control.store.state.seed.value = 2
    await flushReactive(a.control.store.state)
    await waitFor('value crosses direct route', () => b.api.store.state.seed.value == 2)
    slow.latency(1)
    fast.latency(45)
    for (let i = 0; i < 7; i++) await b.control.probe()
    await waitFor('latency route returns to relay', () => b.api.status.state.routeId == 'relay-a')
    a.control.store.state.seed.value = 3
    await flushReactive(a.control.store.state)
    await waitFor('value crosses replacement route', () => b.api.store.state.seed.value == 3)
    await flushReactive(b.api.store.state)
    ok(json(seen.slice(-2)) == json([2, 3]), 'route hand-off is gap-free and duplicate-free: ' + json(seen))
    offSeen()

    const c = createNode('c', 'follower', 0, false)
    const cToB = createRoute('c-to-b', b, 3)
    c.control.addOffer(cToB.offer)
    await c.api.ready
    await waitFor('C cascades through B', () => c.api.status.state.role == 'follower')
    ok(json(c.api.descriptor().path) == json(['a', 'b', 'c']), 'authority path is propagated through a cascade')
    const bToC = createRoute('b-to-c', c, 1)
    b.control.addOffer(bToC.offer)
    await b.control.probe()
    await waitFor('cycle route rejected', () => b.api.status.state.routes['b-to-c']?.state == 'rejected')
    ok(b.api.status.state.routeId == 'relay-a', 'a faster route through a descendant cannot form a cycle')
    b.control.removeOffer('b-to-c')
    c.close()

    const middle = createNode('middle', 'follower', 0, false)
    middle.control.addOffer(createRoute('middle-to-a', a, 20).offer)
    await middle.api.ready
    const chooser = createNode('chooser', 'follower', 0, false)
    chooser.control.addOffer(createRoute('chooser-to-middle', middle, 1).offer)
    chooser.control.addOffer(createRoute('chooser-to-a', a, 8).offer)
    await chooser.api.ready
    await chooser.control.probe()
    await waitFor('end-to-end route cost selected', () => chooser.api.status.state.routeId == 'chooser-to-a')
    ok(json(chooser.api.status.state.path) == json(['a', 'chooser']),
        'route choice uses cumulative authority cost instead of only the nearest hop ping')
    chooser.close()
    middle.close()

    console.log('\n[store-replica-set] automatic failover and fork reconciliation')
    const bConflicts: unknown[] = []
    const aConflicts: Array<{diff: {localOnly: Item[], conflicts: unknown[]}}> = []
    b.api.conflicts.on(function rememberBConflict(event) { bConflicts.push(event) })
    a.api.conflicts.on(function rememberAConflict(event) { aConflicts.push(event as any) })
    slow.online(false)
    fast.online(false)
    await waitFor('B promotes after losing A', () => b.api.status.state.role == 'leader')
    ok(b.api.status.state.epoch == 1 && b.api.canWrite(), 'isolated replica automatically becomes epoch 1 leader')

    // Both partitions accept writes. The higher epoch wins later; the losing tail
    // is reported before its local state is replaced by the winner keyframe.
    a.control.store.state.seed = {id: 'seed', value: 40, owner: 'a'}
    a.control.store.state.onlyA = {id: 'onlyA', value: 1, owner: 'a'}
    b.control.store.state.seed = {id: 'seed', value: 30, owner: 'b'}
    b.control.store.state.onlyB = {id: 'onlyB', value: 1, owner: 'b'}
    await Promise.all([flushReactive(a.control.store.state), flushReactive(b.control.store.state)])

    const aToB = createRoute('a-to-b', b, 3)
    a.control.addOffer(aToB.offer)
    await waitFor('old A adopts promoted B', () => a.api.status.state.role == 'follower' && a.api.status.state.leaderId == 'b')
    await waitFor('A converges after fork', () => json(a.api.store.snapshot()) == json(b.api.store.snapshot()))
    ok(a.api.status.state.epoch == 1, 'higher epoch wins after partition merge')
    ok(aConflicts.length == 1, 'the writable losing branch emits one conflict event')
    ok(aConflicts[0].diff.localOnly.some(item => item.id == 'onlyA') && aConflicts[0].diff.conflicts.length == 1,
        'conflict report keeps both local-only and same-key divergent writes')
    ok(bConflicts.length == 0, 'the winning branch is not reported as a conflict')

    console.log('\n[store-replica-set] client participation without leadership eligibility')
    const client = createNode('browser-client', 'follower', 0, false)
    const clientToB = createRoute('client-to-b', b, 4)
    client.control.addOffer(clientToB.offer)
    await client.api.ready
    await waitFor('client follows B', () => client.api.status.state.role == 'follower')
    ok(json(client.api.store.snapshot()) == json(b.api.store.snapshot()), 'a client can hold and serve a live replica')
    clientToB.online(false)
    await waitFor('client becomes offline', () => client.api.status.state.role == 'offline')
    await delay(80)
    ok(!client.api.canWrite() && client.api.status.state.role == 'offline', 'ineligible client never promotes itself')

    console.log('\n[store-replica-set] equal-epoch partition tie converges deterministically')
    const d = createNode('d', 'leader', 5)
    const e = createNode('e', 'leader', 5)
    d.control.store.state.shared = {id: 'shared', value: 4, owner: 'd'}
    e.control.store.state.shared = {id: 'shared', value: 5, owner: 'e'}
    await Promise.all([flushReactive(d.control.store.state), flushReactive(e.control.store.state)])
    const dConflicts: unknown[] = []
    d.api.conflicts.on(function rememberTieConflict(event) { dConflicts.push(event) })
    const dToE = createRoute('d-to-e', e, 2)
    const eToD = createRoute('e-to-d', d, 2)
    d.control.addOffer(dToE.offer)
    e.control.addOffer(eToD.offer)
    await waitFor('D follows tie-break winner E', () => d.api.status.state.role == 'follower' && d.api.status.state.leaderId == 'e')
    ok(e.api.status.state.role == 'leader', 'lexical node-id tie-break leaves one epoch-5 leader')
    ok(d.api.store.state.shared.value == 5 && dConflicts.length == 1, 'losing equal-epoch fork converges and remains observable')

    client.close()
    d.close()
    e.close()
    a.close()
    b.close()
    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
