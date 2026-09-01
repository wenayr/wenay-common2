// ============================================================
//  replay/command-receipts.test.ts
//
//  The receipt space as a replicated line: a host publishes committed
//  receipts (and their drops) to the line, a follower sees the same facts,
//  and a SUCCESSOR host that adopts a line seeded from the followed snapshot
//  answers the old requestIds from the receipt instead of running them again.
//  Bounds hold on the line too; pending receipts are never published.
//  Run: npx tsx replay/command-receipts.test.ts
// ============================================================

import {createCommandHost} from '../src/Common/command/command-host'
import {commandReceiptKey, createCommandReceipts} from '../src/Common/command/command-receipts'
import {followReplicatedMap} from '../src/Common/Observe/replicated-map'
import type {CommandReceiptRecord} from '../src/Common/command/command-receipts'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

async function waitFor(message: string, check: () => boolean, timeoutMs = 3000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (check()) { ok(true, message); return }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    ok(false, message + ' (timed out)')
}

async function main() {
    let t = 1_000_000
    let applied = 0
    const commands = {
        add(ctx: {account: string}, input: {delta: number}) {
            applied += input.delta
            return {value: applied, by: ctx.account}
        },
        async slow(_ctx: {account: string}, input: {delta: number}) {
            await tick(); await tick()
            applied += input.delta
            return {value: applied}
        },
    }

    // ============== the FIRST authority publishes its receipts ==============
    const receiptsA = createCommandReceipts()
    const hostA = createCommandHost({now: () => t, commands, receipts: {keepMs: 60_000, line: receiptsA.control}})
    const follower = followReplicatedMap<CommandReceiptRecord>(receiptsA.api)
    await follower.ready

    const first = await hostA.execute('alice', 'add', 'r1', {delta: 5})
    ok(first.value == 5 && applied == 5, 'first execution applies')
    const key = commandReceiptKey('alice', 'r1')
    ok(receiptsA.control.get(key)?.result != undefined && (receiptsA.control.get(key)!.result as any).value == 5,
        'the committed receipt is published on the line with its result')
    await waitFor('a follower of the line sees the receipt', () => follower.get(key)?.command == 'add')

    const slow = hostA.execute('alice', 'slow', 'r2', {delta: 1})
    ok(receiptsA.control.get(commandReceiptKey('alice', 'r2')) == undefined, 'an in-flight receipt is NOT on the line')
    await slow
    ok(receiptsA.control.get(commandReceiptKey('alice', 'r2'))?.command == 'slow', 'it lands when the command commits')

    const failed = await hostA.execute('alice', 'boom' as any, 'r3', undefined).catch(() => 'rejected')
    ok(failed == 'rejected' && receiptsA.control.get(commandReceiptKey('alice', 'r3')) == undefined,
        'an unknown/failed command leaves nothing on the line')

    // ============== the SUCCESSOR seeds from the followed snapshot and adopts ==============
    await waitFor('follower holds both committed receipts', () => Object.keys(follower.snapshot()).length == 2)
    const receiptsB = createCommandReceipts({initial: Object.values(follower.snapshot()) as CommandReceiptRecord[]})
    const hostB = createCommandHost({now: () => t, commands, receipts: {keepMs: 60_000, line: receiptsB.control}})
    ok(hostB.stats().receipts == 2 && hostB.stats().accounts == 1, 'the successor index is rebuilt from the line')

    const replayed = await hostB.execute('alice', 'add', 'r1', {delta: 999})
    ok(replayed.value == 5 && applied == 6, 'the OLD requestId answers the receipt on the successor — nothing re-applied')
    ok(hostB.stats().duplicates == 1 && hostB.stats().executions == 0, 'it counts as a duplicate, not an execution')
    const wrongCommand = await hostB.execute('alice', 'slow', 'r1', {delta: 1}).catch((error: any) => String(error.message))
    ok(String(wrongCommand).includes('another command'), 'the receipt remembers WHICH command the requestId was used for')

    const fresh = await hostB.execute('alice', 'add', 'r4', {delta: 10})
    ok(fresh.value == 16 && receiptsB.control.get(commandReceiptKey('alice', 'r4'))?.command == 'add',
        'new commands on the successor publish to ITS line')

    // ============== drops mirror to the line: expiry and bounds ==============
    t += 61_000
    await hostB.execute('bob', 'add', 'b1', {delta: 1})   // triggers compact: alice fully expired
    ok(hostB.stats().accounts == 1 && receiptsB.control.get(commandReceiptKey('alice', 'r1')) == undefined
        && receiptsB.control.get(commandReceiptKey('alice', 'r4')) == undefined,
        'an expired account leaves the line with all its receipts')

    const bounded = createCommandReceipts()
    const hostC = createCommandHost({now: () => t, commands, receipts: {keepMs: 60_000, maxPerAccount: 2, line: bounded.control}})
    for (let i = 1; i <= 3; i++) await hostC.execute('carol', 'add', 'c' + i, {delta: 1})
    ok(Object.keys(bounded.control.snapshot()).length == 2 && bounded.control.get(commandReceiptKey('carol', 'c1')) == undefined,
        'maxPerAccount evicts the oldest receipt from the line as well')

    // ============== adopting an OVERFULL line enforces the bounds on the line ==============
    const overfull = createCommandReceipts({initial: [1, 2, 3, 4].map(i =>
        ({account: 'dan', requestId: 'd' + i, command: 'add', ts: t - 1000 + i, result: {value: i}}))})
    const hostD = createCommandHost({now: () => t, commands, receipts: {keepMs: 60_000, maxPerAccount: 3, line: overfull.control}})
    ok(hostD.stats().receipts == 3 && overfull.control.get(commandReceiptKey('dan', 'd1')) == undefined
        && overfull.control.get(commandReceiptKey('dan', 'd4')) != undefined,
        'adopt keeps the newest receipts within bounds and trims the line to match')

    // ============== detach: adopt(null) stops publishing, keeps answering ==============
    hostD.adopt(null)
    ok(hostD.stats().receipts == 0, 'adopt(null) clears the index')
    await hostD.execute('dan', 'add', 'd9', {delta: 0})
    ok(overfull.control.get(commandReceiptKey('dan', 'd9')) == undefined, 'after detaching nothing is published')

    follower.close()
    hostA.close(); hostB.close(); hostC.close(); hostD.close()
    receiptsA.control.close(); receiptsB.control.close(); bounded.control.close(); overfull.control.close()

    console.log(fails ? `command-receipts: ${fails} FAILED` : 'command-receipts: ALL GREEN')
    process.exit(fails ? 1 : 0)
}

main().catch(function crashed(error) { console.error(error); process.exit(1) })
