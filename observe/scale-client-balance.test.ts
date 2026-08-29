// ============================================================
//  observe/scale-client-balance.test.ts
//
//  The cluster client's balance placement policy: land on the EMPTIEST
//  eligible node by readers/weight, voluntarily migrate off a gross overload
//  toward a clearly underloaded node, respect the cooldown, and never move
//  while the fleet is fair. Placement decisions are driven purely by the
//  replicated directory facts, so the oracle steers them by editing rows.
//  Run: npx tsx observe/scale-client-balance.test.ts
// ============================================================

import {createAuthority} from '../src/Common/scale/scale-authority'
import {createClusterClient} from '../src/Common/scale/scale-client'
import type {NodeDirectoryView} from '../src/Common/Observe/node-directory'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

async function waitFor(message: string, check: () => boolean, timeoutMs = 8000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (check()) { ok(true, message); return }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    ok(false, message + ' (timed out)')
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type TickState = Record<string, {id: string, value: number}>

async function main() {
    const watchdog = setTimeout(function oracleTimedOut() {
        console.error('scale-client-balance oracle timed out')
        process.exit(3)
    }, 60_000)

    const authority = createAuthority<TickState>({
        storeId: 'balance-line', originId: 'balance-origin',
        initial: {tick: {id: 'tick', value: 0}},
        selfUrl: () => 'mem://authority',
        identity: {
            issue: account => 'tok:' + account,
            verify: presented => ({account: String(presented ?? '').slice(4)}),
        },
        heartbeatMs: 200,
        log: () => {},
    })
    authority.start()

    // three fake mirror rows: the ORACLE owns their readers facts; the client's
    // line itself always rides the authority fragment — placement is the subject
    function upsertMirror(nodeId: string, readers: number, weight = 4) {
        authority.directory.control.upsert({nodeId, url: 'mem://' + nodeId, role: 'mirror', weight, meta: {readers}})
    }
    upsertMirror('m-busy', 6)
    upsertMirror('m-mid', 3)
    upsertMirror('m-empty', 0)

    function connect(_view: NodeDirectoryView) {
        return {remote: authority.line.api.fragment, close() {}}
    }

    const moves: string[] = []
    const client = createClusterClient<TickState>({
        storeId: 'balance-line', originId: 'balance-origin', nodeId: 'consumer',
        initial: {},
        directory: authority.directory.api,
        connect,
        placement: {
            staleMs: 0,
            rng: () => 0,
            balance: {checkMs: 40, cooldownMs: 400, moveChance: 1},
        },
        log: line => { if (line.includes('rebalance')) moves.push(line) },
    })

    // ============== 1. the pick lands on the emptiest node, not by weight roll ==============
    await waitFor('balanced pick lands on the emptiest node (m-empty, readers 0)',
        () => client.placement.placedNodeId() == 'm-empty')
    await client.ready
    ok(moves.length == 0, 'no voluntary move right after placement')

    // ============== 2. fair fleet = no migration, ever ==============
    // placed node now reports the SAME load as everyone else
    upsertMirror('m-busy', 3)
    upsertMirror('m-mid', 3)
    upsertMirror('m-empty', 3)
    await sleep(300)
    ok(client.placement.placedNodeId() == 'm-empty', 'a fair fleet never triggers a voluntary move')
    ok(moves.length == 0, 'no rebalance log lines while the fleet is fair')

    // ============== 3. gross overload trickles to the clear underload ==============
    upsertMirror('m-empty', 12)   // the placed node grossly exceeds fair share
    upsertMirror('m-busy', 0)     // a clearly underloaded target exists
    upsertMirror('m-mid', 4)
    await waitFor('overload migrates: placement leaves the hot node',
        () => client.placement.placedNodeId() != 'm-empty')
    ok(client.placement.placedNodeId() == 'm-busy', 'the migration target is the emptiest node (m-busy, readers 0)')
    ok(moves.length == 1, `exactly one voluntary move so far (${moves.length})`)

    // ============== 4. the cooldown blocks an immediate second move ==============
    // make the NEW node instantly hot again — within the cooldown nothing moves
    upsertMirror('m-busy', 12)
    upsertMirror('m-empty', 0)
    await sleep(200)
    ok(client.placement.placedNodeId() == 'm-busy', 'cooldown holds the placement through a fresh overload')
    // ...and after the cooldown the trickle continues
    await waitFor('after the cooldown the overload migrates again',
        () => client.placement.placedNodeId() == 'm-empty', 4000)
    ok(moves.length == 2, `the second move waited for the cooldown (${moves.length} moves)`)

    // ============== 5. balance off = the old sticky weighted pick, untouched ==============
    const sticky = createClusterClient<TickState>({
        storeId: 'balance-line', originId: 'balance-origin', nodeId: 'consumer-sticky',
        initial: {},
        directory: authority.directory.api,
        connect,
        placement: {staleMs: 0, rng: () => 0.999},
        log: () => {},
    })
    await waitFor('without balance the weighted pick still rules (roll 0.999 → last by cumulative weight)',
        () => sticky.placement.placedNodeId() != null)
    upsertMirror(sticky.placement.placedNodeId()!, 50)
    await sleep(300)
    ok(sticky.placement.placedNodeId() != null && Number(
        authority.view.nodes().find(view => view.nodeId == sticky.placement.placedNodeId())?.meta?.['readers'],
    ) == 50, 'a plain sticky client never migrates off an overload')

    sticky.close()
    client.close()
    authority.close()
    clearTimeout(watchdog)
    console.log(fails ? `\nscale-client-balance: ${fails} FAILED` : '\nscale-client-balance: ALL GREEN')
    process.exit(fails ? 1 : 0)
}
main().catch(function fatal(error) { console.error(error); process.exit(2) })
