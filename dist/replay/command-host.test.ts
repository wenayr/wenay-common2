// ============================================================
//  replay/command-host.test.ts
//
//  Command corridor: at-most-once per (account, requestId) with receipts,
//  in-flight dedupe, error = honest retry, rate limits that duplicates do not
//  burn, receipt retention, and the two-hop property: a command forwarded by a
//  mirror shares ONE receipt space with a direct call on the authority.
//  Run: npx tsx replay/command-host.test.ts
// ============================================================

import {createCommandHost, forwardCommands} from '../src/Common/command/command-host'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

async function rejects(run: () => Promise<unknown>, match: string) {
    try { await run() } catch (error) { return String((error as any)?.message ?? error).includes(match) }
    return false
}

async function main() {
    let t = 1_000_000
    let applied = 0
    const host = createCommandHost({
        now: () => t,
        limits: {perMinute: 3},
        receipts: {keepMs: 5_000, maxPerAccount: 2},
        commands: {
            add(ctx, input: {delta: number}) {
                applied += input.delta
                return {value: applied, by: ctx.account}
            },
            async slow(_ctx, input: {delta: number}) {
                await tick(); await tick()
                applied += input.delta
                return {value: applied}
            },
            boom() { throw new Error('command exploded') },
        },
    })

    // ============== at-most-once + receipt answers ==============
    const first = await host.execute('a', 'add', 'r1', {delta: 10})
    ok(first.value == 10 && applied == 10, 'first execution applies')
    const dup = await host.execute('a', 'add', 'r1', {delta: 999})
    ok(dup.value == 10 && applied == 10, 'duplicate requestId answers the receipt, not a second run')
    ;(dup as any).value = -1
    const dupAgain = await host.execute('a', 'add', 'r1', {delta: 999})
    ok(dupAgain.value == 10, 'receipt answers with a copy — a mutated result does not corrupt it')
    ok(await rejects(() => host.execute('a', 'boom', 'r1', undefined), 'another command'),
        'same requestId with another command is rejected')
    await host.execute('b', 'add', 'r1', {delta: 1})
    ok(applied == 11, 'the same requestId under ANOTHER account is a different command')

    // ============== in-flight dedupe ==============
    const p1 = host.execute('a', 'slow', 'r-slow', {delta: 100})
    const p2 = host.execute('a', 'slow', 'r-slow', {delta: 100})
    const [s1, s2] = await Promise.all([p1, p2])
    ok(s1.value == 111 && s2.value == 111 && applied == 111, 'concurrent duplicates share ONE in-flight execution')
    // the receipt guarantee ("answers with a COPY") must hold under concurrency too:
    // the duplicate gets its own object, not the original caller's reference
    ok(s1 != s2, 'an in-flight duplicate answers with its OWN copy, not a shared reference')
    ;(s1 as any).value = -1
    ok(s2.value == 111, "mutating one caller's result cannot leak into the other")

    // ============== error commits nothing (a failed run still burns budget, so its own account) ==============
    ok(await rejects(() => host.execute('e', 'boom', 'r-err', undefined), 'exploded'), 'command error propagates')
    ok(await rejects(() => host.execute('e', 'boom', 'r-err', undefined), 'exploded'),
        'a failed requestId honestly retries (no error receipt)')

    // ============== rate limit: new executions only ==============
    t += 61_000
    for (let i = 1; i <= 3; i++) await host.execute('c', 'add', 'rc' + i, {delta: 1})
    ok(await rejects(() => host.execute('c', 'add', 'rc4', {delta: 1}), 'rate limit'),
        'the 4th NEW execution in a minute is limited')
    const freeDup = await host.execute('c', 'add', 'rc3', {delta: 1})
    ok(freeDup.value != undefined, 'a duplicate is answered from the receipt even while limited')
    t += 61_000
    await host.execute('c', 'add', 'rc4', {delta: 1})
    ok(true, 'the budget window rolls over')

    // ============== retention: keepMs + maxPerAccount ==============
    t += 61_000
    await host.execute('d', 'add', 'rd1', {delta: 0})
    t += 6_000 // beyond keepMs = 5000
    const before = applied
    await host.execute('d', 'add', 'rd2', {delta: 0}) // insert sweeps the expired rd1
    await host.execute('d', 'add', 'rd1', {delta: 5})
    ok(applied == before + 5, 'an expired receipt re-executes (retention is a WINDOW, not forever)')

    // ============== rolling window: a boundary burst cannot double the limit ==============
    t += 61_000
    const w0 = t
    await host.execute('w', 'add', 'rw1', {delta: 0})   // would anchor a FIXED window here
    t = w0 + 59_000
    await host.execute('w', 'add', 'rw2', {delta: 0})
    await host.execute('w', 'add', 'rw3', {delta: 0})
    t = w0 + 61_000                                     // a fixed window would reset now
    await host.execute('w', 'add', 'rw4', {delta: 0})   // fine: rw1 has left the rolling window
    ok(await rejects(() => host.execute('w', 'add', 'rw5', {delta: 0}), 'rate limit'),
        'the window ROLLS: 3 executions in the last 60s still block the 4th at the boundary')

    // ============== departed accounts do not accumulate forever ==============
    t += 61_000
    for (let i = 0; i < 40; i++) {
        await host.execute('ghost-' + i, 'add', 'g' + i, {delta: 0})
        t += 500
    }
    t += 6_000  // beyond keepMs: every ghost's receipts are expired now
    await host.execute('a', 'add', 'r-after-ghosts', {delta: 0})
    const ghostStats = host.stats()
    ok(ghostStats.accounts <= 5,
        `departed accounts are swept, receipts and all (${ghostStats.accounts} left)`)

    // ============== the global receipts bound stays flat ==============
    let t2 = 0
    const bounded = createCommandHost({
        now: () => t2,
        receipts: {maxTotal: 10, maxPerAccount: 8},
        commands: {noop: () => 0},
    })
    for (let i = 0; i < 50; i++) {
        t2 += 10
        await bounded.execute('acc' + (i % 25), 'noop', 'q' + i, undefined)
    }
    const boundedStats = bounded.stats()
    ok(boundedStats.receipts <= 10,
        `total receipts respect the global bound — the stand stays memory-flat (${boundedStats.receipts})`)
    bounded.close()

    // ============== two hops share one receipt space ==============
    const mirror = forwardCommands({upstream: host.forwardFragment(), names: host.names})
    const viaMirror = mirror.fragment('a')
    const direct = host.fragment('a')
    t += 61_000
    const m1 = await viaMirror.add('r-hop', {delta: 1000})
    const d1 = await direct.add('r-hop', {delta: 1000})
    ok(m1.value == d1.value && m1.by == 'a', 'mirror call and direct call share ONE receipt: no double apply')
    const statsNow = host.stats()
    ok(statsNow.duplicates >= 1 && statsNow.receipts >= 1, 'stats expose receipts and duplicate answers')
    ok(Object.keys(viaMirror).sort().join(',') == Object.keys(direct).sort().join(','),
        'mirror fragment shape is identical to the authority fragment')

    host.close()
    ok(await rejects(() => host.execute('a', 'add', 'r-closed', {delta: 1}), 'closed'), 'closed host refuses')

    // ============== draining an expired account keeps its rate window ==============
    {
        let now = 5_000_000
        const short = createCommandHost({
            now: () => now,
            limits: {perMinute: 2},
            receipts: {keepMs: 10},   // receipts die long before the minute does
            commands: {noop() { return 1 }},
        })
        await short.execute('lim', 'noop', 'l1', undefined)
        await short.execute('lim', 'noop', 'l2', undefined)
        now += 20   // receipts expired, minute still running
        await short.execute('other', 'noop', 'o1', undefined)   // compact() drains 'lim'
        ok(short.stats().accounts == 1, 'the fully-expired account was drained')
        ok(await rejects(() => short.execute('lim', 'noop', 'l3', undefined), 'rate limit'),
            'draining expired receipts does not hand the account a fresh minute')
        now += 61_000
        ok((await short.execute('lim', 'noop', 'l4', undefined)) == 1, 'the window still expires on its own clock')
        short.close()
    }

    // ============== fragment construction refuses prototype-shaped names ==============
    ok((() => {
        try { forwardCommands({upstream: {} as any, names: ['ok', '__proto__']}).fragment('a'); return false }
        catch (error) { return String((error as any).message).includes('reserved') }
    })(), 'a fragment refuses a __proto__ command name instead of binding onto the prototype')

    console.log(fails ? `command-host: ${fails} FAILED` : 'command-host: ALL GREEN')
    process.exit(fails ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
