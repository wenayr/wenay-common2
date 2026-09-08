import * as assert from 'node:assert/strict'
import {createCommandHost} from '../src/Common/command/command-host'
import {commandReceiptKey, createCommandReceipts, type CommandReceiptLine, type CommandReceiptRecord} from '../src/Common/command/command-receipts'
import {createStore} from '../src/Common/Observe/store'

async function testDistinctReceiptPairs() {
    const line = createCommandReceipts()
    let executions = 0
    const commands = {run() { return ++executions }}
    const first = createCommandHost({commands, receipts: {line: line.control}})
    try {
        const a = await first.execute('ab', 'run', 'c', undefined)
        const b = await first.execute('a', 'run', 'bc', undefined)
        assert.notEqual(commandReceiptKey('ab', 'c'), commandReceiptKey('a', 'bc'))
        assert.equal(Object.keys(line.control.snapshot()).length, 2)
        const successor = createCommandHost({commands, receipts: {line: line.control}})
        try {
            assert.equal(await successor.execute('ab', 'run', 'c', undefined), a)
            assert.equal(await successor.execute('a', 'run', 'bc', undefined), b)
            assert.equal(executions, 2)
        } finally { successor.close() }
    } finally { first.close(); line.close() }
}

function testLegacyReceiptRestore() {
    const first: CommandReceiptRecord = {account: 'a', requestId: 'b', command: 'run', ts: Date.now(), result: 1}
    // One legacy key is another record's NEW key: migration must not overwrite it mid-pass.
    const second: CommandReceiptRecord = {...first, account: '["a",', requestId: '"b"]', result: 2}
    const store = createStore({receipts: {'ab': first, '["a","b"]': second}, other: {kept: true}})
    const line = createCommandReceipts({store})
    try {
        assert.equal(line.control.get(commandReceiptKey(first.account, first.requestId)).result, 1)
        assert.equal(line.control.get(commandReceiptKey(second.account, second.requestId)).result, 2)
        assert.equal(Object.keys(line.control.snapshot()).length, 2)
        assert.equal(store.state.other.kept, true)
        line.control.delete(commandReceiptKey(first.account, first.requestId))
        assert.equal(Object.keys(line.control.snapshot()).length, 1)
    } finally { line.close() }
}

async function testPendingReceiptOwnership(change: 'close' | 'adopt', fail: boolean) {
    const original = createCommandReceipts()
    const replacement = createCommandReceipts({initial: [{account: 'a', requestId: 'r', command: 'run', ts: Date.now(), result: 42}]})
    let resolve!: (value: number) => void
    let reject!: (error: Error) => void
    const pending = new Promise<number>(function waitForCommand(yes, no) { resolve = yes; reject = no })
    const host = createCommandHost({commands: {run() { return pending }}, receipts: {line: original.control}})
    const answer = host.execute('a', 'run', 'r', undefined)
    await Promise.resolve()
    if (change == 'close') host.close()
    else host.adopt(replacement.control)
    try {
        if (fail) {
            reject(new Error('failed old command'))
            await assert.rejects(answer, /failed old command/)
        } else {
            resolve(7)
            assert.equal(await answer, 7, 'already-started work may still finish for its caller')
        }
        assert.equal(host.stats().receipts, change == 'close' ? 0 : 1, 'old cleanup cannot modify the active index')
        assert.equal(Object.keys(original.control.snapshot()).length, 0, 'closed/detached commands cannot publish')
        assert.equal(replacement.control.get(commandReceiptKey('a', 'r')).result, 42, 'old work cannot overwrite an adopted receipt')
        if (change == 'adopt') assert.equal(await host.execute('a', 'run', 'r', undefined), 42)
    } finally { host.close(); original.close(); replacement.close() }
}

async function testReentrantDuplicate() {
    let executions = 0
    let duplicate: Promise<number> | undefined
    function run() {
        executions++
        if (executions == 1) duplicate = host.execute('a', 'run', 'r', undefined)
        return executions
    }
    const host = createCommandHost({commands: {run}})
    try {
        const first = await host.execute('a', 'run', 'r', undefined)
        assert.equal(first, 1)
        assert.equal(await duplicate, 1)
        assert.equal(executions, 1, 'the receipt must exist before entering application code')
        assert.equal(host.stats().receipts, 1)
    } finally { host.close() }
}

async function testSynchronousOwnershipChange(change: 'close' | 'adopt') {
    let now = 1
    const original = createCommandReceipts()
    const replacement = createCommandReceipts()
    const host = createCommandHost({now: () => now, receipts: {keepMs: 10, line: original.control}, commands: {
        run(_ctx, input: boolean) {
            if (input) {
                if (change == 'close') host.close()
                else host.adopt(replacement.control)
            }
            return 1
        },
    }})
    try {
        await host.execute('a', 'run', 'old', false)
        now += 20
        await host.execute('a', 'run', 'change', true)
        assert.equal(host.stats().receipts, 0, 'post-entry sweep must not subtract detached receipts')
        assert.equal(Object.keys(original.control.snapshot()).length, 1, 'post-entry sweep must not mutate the detached line')
        assert.equal(Object.keys(replacement.control.snapshot()).length, 0)
    } finally { host.close(); original.close(); replacement.close() }
}

async function testLegacyCustomLineAdoption(mixed = false) {
    const records: Record<string, CommandReceiptRecord> = {
        legacyrequest: {account: 'legacy', requestId: 'request', command: 'run', ts: 1, result: 5},
    }
    if (mixed) records[commandReceiptKey('legacy', 'request')] = {...records['legacyrequest'], ts: 2, result: 6}
    const line = {
        snapshot() { return {...records} },
        set(record: CommandReceiptRecord) { records[commandReceiptKey(record.account, record.requestId)] = record },
        delete(key: string) { delete records[key] },
    } satisfies CommandReceiptLine
    let executions = 0
    const host = createCommandHost({now: () => 2, receipts: {line, maxTotal: 1}, commands: {run() { return ++executions }}})
    try {
        assert.equal(await host.execute('legacy', 'run', 'request', undefined), mixed ? 6 : 5)
        assert.equal(host.stats().receipts, 1, 'legacy/new aliases count as one receipt')
        assert.equal(executions, 0, 'legacy custom snapshots still answer duplicates')
        await host.execute('other', 'run', 'new', undefined)
        assert.equal(Object.keys(records).length, 1, 'eviction removes the original persisted key')
        assert.equal(records['legacyrequest'], undefined)
    } finally { host.close() }
}

async function main() {
    const cases = [testDistinctReceiptPairs, testLegacyReceiptRestore, testReentrantDuplicate,
        () => testLegacyCustomLineAdoption(false), () => testLegacyCustomLineAdoption(true),
        ...(['close', 'adopt'] as const).map(change => () => testSynchronousOwnershipChange(change)),
        ...(['close', 'adopt'] as const).flatMap(change => [false, true].map(fail => () => testPendingReceiptOwnership(change, fail)))]
    const failures: unknown[] = []
    for (const run of cases) {
        try { await run() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'command boundary regressions')
    console.log('command boundaries: ALL GREEN')
}

main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
