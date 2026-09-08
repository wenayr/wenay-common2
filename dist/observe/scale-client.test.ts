// ============================================================
//  observe/scale-client.test.ts
//
//  Scale cluster client against a LIVE createAuthority: catches up through
//  the directory-driven offers, sticky weighted placement (no re-roll on
//  directory churn while the placed node stays eligible; re-pick on drain and
//  on staleness), gap-free route hand-off with a monotonic tick line,
//  placement.repick() forcing a fresh pick, and view facts matching status.
//  Run: npx tsx observe/scale-client.test.ts
// ============================================================

import {createStoreReplicaSet} from '../src/Common/Observe/store-replica-set'
import {flushReactive} from '../src/Common/Observe/reactive'
import {createAuthority} from '../src/Common/scale/scale-authority'
import {createClusterClient} from '../src/Common/scale/scale-client'
import type {NodeDirectoryView} from '../src/Common/Observe/node-directory'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const json = (v: any) => JSON.stringify(v)

async function waitFor(message: string, check: () => boolean, timeoutMs = 8000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (check()) { ok(true, message); return }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    ok(false, message + ' (timed out)')
}

type TickState = Record<string, {id: string, value: number}>

async function main() {
    const watchdog = setTimeout(function oracleTimedOut() {
        console.error('scale-client oracle timed out')
        process.exit(3)
    }, 60_000)

    // ============== a live authority + one in-process mirror node line ==============
    const authority = createAuthority<TickState>({
        line: {storeId: 'cluster-line', originId: 'cluster-origin', initial: {tick: {id: 'tick', value: 0}}},
        // the OWNER publishes liveness: 400 ms of silence and a row is dead
        roster: {url: () => 'mem://authority', heartbeatMs: 200, staleMs: 400},
        identity: {
            issue: account => 'tok:' + account,
            verify: presented => ({account: String(presented ?? '').slice(4)}),
        },
        log: () => {},
    })
    authority.start()

    const mirror = createStoreReplicaSet<TickState>({
        storeId: 'cluster-line', originId: 'cluster-origin', nodeId: 'm1', lineId: 'm1-line',
        initial: {},
        leadership: {initialRole: 'follower', eligible: false},
    })
    mirror.control.addOffer({
        id: 'to-authority',
        connect: () => ({remote: authority.line.api.fragment, close() {}}),
    })
    await mirror.api.ready
    authority.roster.control.set({nodeId: 'm1', url: 'mem://m1', role: 'mirror', weight: 4})
    // the oracle IS m1's process here: keep its row alive until the staleness scenario
    let m1Pulse: ReturnType<typeof setInterval> | null = setInterval(function beatM1() { authority.roster.control.heartbeat('m1') }, 100)

    /** The transport adapter: in-process fragments — the host owns real sockets. */
    function connect(view: NodeDirectoryView) {
        return {
            remote: view.nodeId == 'authority' ? authority.line.api.fragment : mirror.api.fragment,
            close() {},
        }
    }

    // ============== sticky weighted placement, deterministic through rng ==============
    let roll = 0.9   // [authority w1, m1 w4]: 0.9 -> m1, 0.01 -> authority
    const client = createClusterClient<TickState>({
        line: {storeId: 'cluster-line', originId: 'cluster-origin', nodeId: 'consumer', initial: {}},
        roster: authority.roster.api,
        connect,
        placement: {rng: () => roll},
        log: () => {},
    })
    // the directory arrives over the replay wire: the pick lands on the first batch
    await waitFor('the weighted pick honors weights (roll 0.9 lands the w4 mirror)',
        () => client.placement.placedNodeId() == 'm1')

    authority.line.control.store.state.tick = {id: 'tick', value: 1}
    await flushReactive(authority.line.control.store.state)
    await client.ready
    await waitFor('the client catches up through its placed node', () => client.store.state.tick?.value == 1)
    await waitFor('the route lands on the placed node', () => client.status.state.routeId == 'm1')
    ok(client.view.route() == client.status.state.routeId, 'view.route() matches status.routeId')
    ok(client.view.nodes().length == 2, 'view.nodes() shows the whole roster')

    // ============== directory churn does NOT re-roll a live placement ==============
    roll = 0.01   // would land the authority IF a re-roll happened
    authority.roster.control.set({nodeId: 'n2', url: 'mem://n2', role: 'mirror', weight: 40})
    await waitFor('the client sees the churn', () => client.view.nodes().length == 3)
    await new Promise(resolve => setTimeout(resolve, 300))   // a heartbeat cycle of churn
    ok(client.placement.placedNodeId() == 'm1', 'churn (spawn + heartbeats) never re-rolls a live placement')
    ok(client.status.state.routeId == 'm1', 'the route stays put with the placement')

    // ============== drain: re-pick + gap-free hand-off, tick monotonic ==============
    authority.roster.control.remove('n2')
    const ticks: number[] = []
    const sampler = setInterval(function sampleTick() {
        const value = client.store.state.tick?.value
        if (value != undefined && value != ticks[ticks.length - 1]) ticks.push(value)
    }, 5)
    const ticker = setInterval(function advanceTick() {
        const current = authority.line.control.store.state.tick
        authority.line.control.store.state.tick = {id: 'tick', value: (current?.value ?? 0) + 1}
        void flushReactive(authority.line.control.store.state)
    }, 25)
    await waitFor('the tick line is live before the drain', () => (client.store.state.tick?.value ?? 0) >= 3)

    authority.roster.control.drain('m1')
    await waitFor('drain re-picks the placement', () => client.placement.placedNodeId() == 'authority')
    await waitFor('the route hands off to the authority', () => client.status.state.routeId == 'authority')
    const atHandoff = authority.line.control.store.state.tick?.value ?? 0
    await waitFor('the line keeps advancing on the new route',
        () => (client.store.state.tick?.value ?? 0) > atHandoff)
    clearInterval(ticker)
    clearInterval(sampler)
    const monotonic = ticks.every((value, index) => index == 0 || value > ticks[index - 1]!)
    ok(monotonic && ticks.length >= 3, `the tick line stayed monotonic across the hand-off (${ticks.length} samples)`)
    await flushReactive(authority.line.control.store.state)
    await waitFor('the client converges on the authority snapshot',
        () => json(client.store.snapshot()) == json(authority.line.api.store.snapshot()))

    // ============== repick(): sticky until FORCED, then a fresh weighted pick ==============
    authority.roster.control.undrain('m1', 4)
    await waitFor('the mirror is eligible again',
        () => client.view.nodes().some(view => view.nodeId == 'm1' && view.eligible))
    ok(client.placement.placedNodeId() == 'authority', 'undrain alone does not move a live placement')
    roll = 0.9
    ok(client.placement.repick() == 'm1', 'repick() forces a fresh weighted pick')
    await waitFor('the forced pick moves the route, by seq', () => client.status.state.routeId == 'm1')

    // ============== liveness: a node the authority publishes dead loses its placements ==============
    authority.roster.control.heartbeat('m1')   // alive for the new consumer
    const client2 = createClusterClient<TickState>({
        line: {storeId: 'cluster-line', originId: 'cluster-origin', nodeId: 'consumer-2', initial: {}},
        roster: authority.roster.api,
        connect,
        placement: {rng: () => 0.9, label: 'reader #2'},
        log: () => {},
    })
    await waitFor('the second consumer places on the fresh mirror', () => client2.placement.placedNodeId() == 'm1')
    // m1 now goes silent; the authority's sweep publishes the dead verdict on the roster line
    if (m1Pulse) { clearInterval(m1Pulse); m1Pulse = null }
    await waitFor('the dead verdict re-picks the placement to a live node',
        () => client2.placement.placedNodeId() == 'authority', 8000)
    await waitFor('the dead node also loses the route', () => client2.status.state.routeId == 'authority')
    ok(client2.view.route() == client2.status.state.routeId, 'view facts match status on the second consumer')

    client2.close()
    client.close()
    mirror.close()
    authority.close()
    clearTimeout(watchdog)
    console.log(fails == 0 ? '\nscale-client: ALL GREEN' : `\nscale-client: ${fails} FAILURES`)
    process.exit(fails ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
