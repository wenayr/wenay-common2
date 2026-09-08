// ============================================================
//  observe/scale-solo.test.ts
//
//  The growth path (ROADMAP §6.1): an authority with ZERO nodes is a
//  deployment — it serves the readers itself and the cluster client places
//  on the leader row. A store node added later BY CONFIG takes new readers
//  over by weight, placed clients stay sticky, and a drain returns them to
//  the authority gap-free. Two authorities in one process share nothing
//  (multi-tenancy = closures). The consumer's config is the same object at
//  every step — only the roster changes. Node legs ride REAL RPC on the
//  in-process loopback, as in observe/store-node-readers.test.ts.
//  Run: npx tsx observe/scale-solo.test.ts
// ============================================================

import {listen} from '../src/Common/events/Listen'
import {createRpcClient} from '../src/Common/rcp/rpc-client'
import {createLoopbackSocketPair} from '../src/Common/rcp/rpc-inproc'
import type {SocketTmpl} from '../src/Common/rcp/rpc-protocol'
import type {NodeDirectoryView} from '../src/Common/Observe/node-directory'
import {listenStorePatches} from '../src/Common/Observe/store'
import {createStoreNode} from '../src/Common/Observe/store-node'
import {createAuthority, type AuthorityUpstream} from '../src/Common/scale/scale-authority'
import {createClusterClient} from '../src/Common/scale/scale-client'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

async function waitFor(message: string, check: () => boolean, timeoutMs = 5000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (check()) { ok(true, message); return }
        await new Promise(resolve => setTimeout(resolve, 15))
    }
    ok(false, message + ' (timed out)')
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type TickState = Record<string, {id: string, value: number}>

/** An in-process node link to an authority (the host owns the real link). */
function linkTo(authority: ReturnType<typeof createAuthority<TickState>>, asNode: string) {
    const [fail, onFail] = listen<[]>()
    const link = authority.serve.nodeLink(asNode)
    const upstream: AuthorityUpstream = {
        replica: link.replica, control: link.control,
        register: link.register, heartbeat: link.heartbeat, goodbye: link.goodbye,
        onFail: {on: (cb: () => void) => onFail.on(cb)},
    }
    return {upstream, fail}
}

function bootAuthority(storeId: string) {
    const authority = createAuthority<TickState>({
        line: {storeId, originId: storeId + '-origin', initial: {tick: {id: 'tick', value: 0}}},
        roster: {url: () => 'mem://' + storeId, heartbeatMs: 50, staleMs: 400},
        identity: {issue: account => 'tok:' + account, verify: presented => ({account: String(presented ?? '').slice(4)})},
        log: () => {},
    })
    authority.start()
    const ticker = setInterval(function advance() {
        const current = authority.line.control.store.state.tick
        authority.line.control.store.state.tick = {id: 'tick', value: (current?.value ?? 0) + 1}
    }, 20)
    return {authority, close() { clearInterval(ticker); authority.close() }}
}

async function main() {
    const watchdog = setTimeout(function oracleTimedOut() {
        console.error('scale-solo oracle timed out')
        process.exit(3)
    }, 60_000)

    // ============== day 1: the authority alone IS the deployment ==============
    const solo = bootAuthority('solo-line')
    const {authority} = solo
    ok(authority.view.nodes().length == 1 && authority.view.nodes()[0].nodeId == 'authority', 'the roster holds only the leader row')

    // the node legs: a node registers its serve handler here, readers open loopback sockets to it
    const serveOf = new Map<string, (socket: SocketTmpl) => void>()
    async function openNodeSession(nodeId: string) {
        const {client: clientEnd, server: serverEnd, kill} = createLoopbackSocketPair()
        serveOf.get(nodeId)!(serverEnd)
        const rpc = createRpcClient<any>({socket: clientEnd, socketKey: 'app'})
        await rpc.readyStrict()
        return {remote: rpc.func.svc.replica, close: kill}
    }
    /** The consumer's config — the SAME object on day 1 and after every node joins. */
    function bootClient(nodeId: string, roll: number) {
        const client = createClusterClient<TickState>({
            line: {storeId: 'solo-line', originId: 'solo-line-origin', nodeId, initial: {}},
            roster: authority.roster.api,
            connect: function connectByRow(view: NodeDirectoryView) {
                if (view.nodeId == 'authority') return {remote: authority.line.api.fragment, close() {}}
                return openNodeSession(view.nodeId)
            },
            placement: {rng: () => roll},
            log: () => {},
        })
        // the ledger: every tick the client sees must be monotonic across every hand-off
        // (the gap-free seq hand-off itself is proven in observe/scale-client.test.ts)
        let last = -1
        let regressions = 0
        listenStorePatches(client.store).on(function audit() {
            const value = client.store.state.tick?.value ?? -1
            if (value < last) regressions++
            last = Math.max(last, value)
        })
        return {client, facts: () => ({last, regressions})}
    }

    const first = bootClient('reader-1', 0.9)
    await first.client.ready
    ok(first.client.placement.placedNodeId() == 'authority', 'day 1: the consumer places on the authority — nothing else exists')
    await waitFor('day 1: the consumer follows the live line', () => (first.client.store.state.tick?.value ?? 0) >= 3)
    await waitFor('the authority counts that reader', () => authority.view.readers() >= 1)

    // ============== day N: a node joins BY CONFIG; the consumer config does not change ==============
    const nodeLink = linkTo(authority, 'n1')
    let left = ''
    const node = createStoreNode<TickState>({
        line: {nodeId: 'n1', storeId: 'solo-line', originId: 'solo-line-origin'},
        roster: {url: () => 'mem://n1', heartbeatMs: 50, graceMs: 60},
        upstream: () => nodeLink.upstream,
        serve: {onConnection(handler) { serveOf.set('n1', handler) }, wrap: (fragment: Record<string, unknown>) => ({svc: fragment})},
        onLeave(reason) { left = reason },
        log: () => {},
    })
    await node.start()
    await waitFor('the node is in the roster, eligible and alive', () => authority.view.nodes().some(view => view.nodeId == 'n1' && view.eligible && view.alive))
    await sleep(100)
    ok(first.client.placement.placedNodeId() == 'authority', 'a placed consumer is NOT yanked by the new node (sticky)')

    const second = bootClient('reader-2', 0.9)
    await second.client.ready
    ok(second.client.placement.placedNodeId() == 'n1', 'a new consumer lands on the node by weight (n1:4 vs authority:1)')
    await waitFor('the new consumer reads THROUGH the node over real RPC', () => (second.client.store.state.tick?.value ?? 0) >= 3)
    await waitFor('the node reports its reader', () => node.view.status().readers == 1)
    ok(second.client.view.route() == 'n1', 'its route is the node')

    // an existing consumer can be asked to re-place: the pick is a config-free operation
    ok(first.client.placement.repick() == 'n1', 'repick moves the first consumer onto the node')
    await waitFor('...and its line hands off to the node gap-free', () => first.client.view.route() == 'n1')

    // ============== shrink: drain the node; the consumers return to the authority ==============
    const before = {first: first.facts().last, second: second.facts().last}
    authority.roster.control.drain('n1')
    await waitFor('the drained node leaves on its own row fact', () => left != '')
    await waitFor('the first consumer is back on the authority', () => first.client.placement.placedNodeId() == 'authority' && first.client.view.route() == 'authority')
    await waitFor('the second consumer is back on the authority', () => second.client.placement.placedNodeId() == 'authority' && second.client.view.route() == 'authority')
    await waitFor('both keep reading the live line', () => first.facts().last > before.first + 3 && second.facts().last > before.second + 3)
    ok(first.facts().regressions == 0, `first consumer: the tick stayed monotonic across join, repick and drain ${JSON.stringify(first.facts())}`)
    ok(second.facts().regressions == 0, `second consumer: the tick stayed monotonic across the drain ${JSON.stringify(second.facts())}`)

    // ============== multi-tenancy: a second authority in the same process shares nothing ==============
    const other = bootAuthority('other-line')
    const tenant = createClusterClient<TickState>({
        line: {storeId: 'other-line', originId: 'other-line-origin', nodeId: 'tenant-reader', initial: {}},
        roster: other.authority.roster.api,
        connect: () => ({remote: other.authority.line.api.fragment, close() {}}),
        log: () => {},
    })
    await tenant.ready
    ok(tenant.placement.placedNodeId() == 'authority' && other.authority.view.nodes().length == 1, 'the second authority has its own roster with its own single row')
    await waitFor('the tenant follows the SECOND line', () => (tenant.store.state.tick?.value ?? 0) >= 2)
    ok(other.authority.view.readers() == 1 && authority.view.readers() == 2, `readers are counted per authority (other ${other.authority.view.readers()}, solo ${authority.view.readers()})`)
    ok(!authority.view.nodes().some(view => view.nodeId == 'n1'), 'the drained node is gone from the first roster only')

    tenant.close()
    other.close()
    first.client.close()
    second.client.close()
    node.close()
    solo.close()
    clearTimeout(watchdog)
    console.log(fails ? `\nFAIL scale-solo: ${fails} check(s)` : '\nPASS scale-solo')
    process.exit(fails ? 1 : 0)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
