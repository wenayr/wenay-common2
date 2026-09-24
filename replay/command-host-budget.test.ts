// ============================================================
//  replay/command-host-budget.test.ts
//
//  Found by examples/apartments: the corridor's per-account budget applied to
//  the HOST's own principal too — a burst of webhook settlements or effect
//  outcomes ran into "rate limit exceeded" like any visitor. `limits.budgetOf`
//  gives an account its own budget (Infinity = unlimited) while `perMinute`
//  stays the default for everyone else.
//  Run: node node_modules/tsx/dist/cli.mjs replay/command-host-budget.test.ts
// ============================================================

import {createCommandHost} from '../src/Common/command/command-host'
import {runOracle} from '../oracle/run-oracle'

let fails = 0
let step = 0
const ok = (condition: any, message: string) => {
    const label = String(++step).padStart(2, ' ')
    if (!condition) { fails++; console.log(`${label}. FAIL ${message}`) }
    else console.log(`${label}. OK   ${message}`)
}

async function runChecks() {
    let executed = 0
    const host = createCommandHost({
        commands: {tick(ctx, input: {n: number}) { executed++; return {n: input.n, by: ctx.account} }},
        limits: {perMinute: 2, budgetOf: account => account == 'system' ? Infinity : account == 'vip' ? 3 : 2},
    })
    const attempt = (account: string, id: string) => host.execute(account, 'tick', id, {n: 1}).then(() => 'ok', (error: Error) => error.message)

    ok(await attempt('guest', 'g1') == 'ok' && await attempt('guest', 'g2') == 'ok', 'a visitor spends the default budget')
    ok(/rate limit/.test(await attempt('guest', 'g3')), 'the third execution within the minute is refused')
    ok(await attempt('guest', 'g1') == 'ok', 'a receipt answer is free (same requestId)')
    for (let i = 0; i < 50; i++) ok_silent(await attempt('system', 's' + i) == 'ok')
    ok(executed == 52, `the system principal is unlimited (50 executions in a row, ${executed} total)`)
    ok(await attempt('vip', 'v1') == 'ok' && await attempt('vip', 'v2') == 'ok' && await attempt('vip', 'v3') == 'ok' && /rate limit/.test(await attempt('vip', 'v4')),
        'a per-account budget above the default is honored')

    // without budgetOf the default applies to everyone, including system — the old behavior
    const plain = createCommandHost({commands: {tick(_ctx, input: {n: number}) { return input }}, limits: {perMinute: 1}})
    const p = (id: string) => plain.execute('system', 'tick', id, {n: 1}).then(() => 'ok', (error: Error) => error.message)
    ok(await p('a') == 'ok' && /rate limit/.test(await p('b')), 'control: without budgetOf the system account is limited like anyone')

    host.close()
    plain.close()
    console.log(fails == 0 ? '\ncommand-host-budget: ALL GREEN' : `\ncommand-host-budget: ${fails} FAILURES`)
    process.exit(fails ? 1 : 0)
}
function ok_silent(condition: boolean) { if (!condition) fails++ }

async function main() {
    await runChecks().catch(function fatal(error) {
        console.error(error)
        process.exit(2)
    })
}

runOracle(main)
