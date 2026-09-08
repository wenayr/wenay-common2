// ============================================================
//  observe/scale-durable-receipts.test.ts
//
//  ROADMAP §6.3's follow-up, triggered by the SaaS examples: a solo
//  deployment restarted from its archive re-executed a requestId the client
//  had already seen acknowledged, because receipts (and the deny list) live on
//  the CONTROL line, which only a standby carried across a restart. With
//  `control: {durable}` the control line has its own archive: receipts answer
//  after a restart, a revoked account stays revoked, and the roster — liveness
//  facts of a dead lifetime — is wiped so nodes re-register. Control: without
//  the seam the same requestId executes twice, exactly as before.
//  Run: node node_modules/tsx/dist/cli.mjs observe/scale-durable-receipts.test.ts
// ============================================================

import {createAuthority} from '../src/Common/scale/scale-authority'
import {createMemoryReplayStorage} from '../src/Common/events/replay-history'

type State = {counter: {value: number}}

let fails = 0
let step = 0
const ok = (condition: any, message: string) => {
    const label = String(++step).padStart(2, ' ')
    if (!condition) { fails++; console.log(`${label}. FAIL ${message}`) }
    else console.log(`${label}. OK   ${message}`)
}
const quiet = () => {}

function boot(line: ReturnType<typeof createMemoryReplayStorage>, control: ReturnType<typeof createMemoryReplayStorage> | null, executions: {count: number}) {
    const authority = createAuthority<State, {add: (ctx: any, input: {delta: number}) => {value: number}}>({
        line: {storeId: 'receipts-line', originId: 'receipts-origin', initial: {counter: {value: 0}}, durable: {storage: line, everyEvents: 1000}},
        ...(control ? {control: {durable: {storage: control, everyEvents: 1000}}} : {}),
        roster: {url: () => 'mem://authority'},
        identity: {issue: account => 'tok:' + account, verify: presented => ({account: String(presented).slice(4)})},
        corridor: {commands: {add(_ctx, input) {
            executions.count++
            const store = authority.line.control.store
            store.state.counter = {value: store.state.counter.value + input.delta}
            return {value: store.state.counter.value}
        }}},
        log: quiet,
    })
    authority.start()
    return authority
}

async function main() {
    // ============== the seam: receipts and the deny list survive a solo restart ==============
    const line = createMemoryReplayStorage()
    const control = createMemoryReplayStorage()
    const executions = {count: 0}
    const first = boot(line, control, executions)
    const acked = await first.corridor.execute('alice', 'add', 'r1', {delta: 5})
    first.roster.control.set({nodeId: 'n1', url: 'mem://n1', role: 'mirror', weight: 4})
    first.identity.revoke('bob')
    ok(acked.value == 5 && executions.count == 1 && first.view.nodes().some(node => node.nodeId == 'n1') && first.view.isRevoked('bob'),
        'first lifetime: a command acknowledged, a node registered, an account revoked')
    first.close()

    const second = boot(line, control, executions)
    const restored = second.view.restored()
    ok(restored?.fromArchive == true && restored.control?.fromArchive == true, `the second lifetime restored both archives (${JSON.stringify(restored)})`)
    const again = await second.corridor.execute('alice', 'add', 'r1', {delta: 5})
    ok(again.value == 5 && executions.count == 1 && second.line.control.store.state.counter.value == 5,
        `the acknowledged requestId answers its RECEIPT after the restart — nothing executed twice (${executions.count} executions, counter ${second.line.control.store.state.counter.value})`)
    ok(second.view.isRevoked('bob'), 'the deny list survived: bob is still revoked')
    ok(!second.view.nodes().some(node => node.nodeId == 'n1') && second.view.nodes().some(node => node.nodeId == 'authority'),
        'the roster did not: the dead lifetime\'s node row is gone, the authority\'s own row is back')
    const fresh = await second.corridor.execute('alice', 'add', 'r2', {delta: 1})
    ok(fresh.value == 6 && executions.count == 2, 'a new requestId executes normally')
    second.close()

    const third = boot(line, control, executions)
    const twice = await third.corridor.execute('alice', 'add', 'r2', {delta: 1})
    ok(twice.value == 6 && executions.count == 2, 'the third lifetime still answers the receipt written by the second (immediate close, flushed)')
    third.close()

    // ============== control: without the seam a restart re-executes an acknowledged requestId ==============
    const plainLine = createMemoryReplayStorage()
    const plainRuns = {count: 0}
    const plainFirst = boot(plainLine, null, plainRuns)
    await plainFirst.corridor.execute('alice', 'add', 'r1', {delta: 5})
    plainFirst.close()
    const plainSecond = boot(plainLine, null, plainRuns)
    const repeated = await plainSecond.corridor.execute('alice', 'add', 'r1', {delta: 5})
    ok(repeated.value == 10 && plainRuns.count == 2 && plainSecond.view.restored()?.control == undefined,
        'control: without control.durable the same requestId executes again after a restart (the documented boundary)')
    plainSecond.close()

    console.log(fails == 0 ? '\nscale-durable-receipts: ALL GREEN' : `\nscale-durable-receipts: ${fails} FAILURES`)
    process.exit(fails ? 1 : 0)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
