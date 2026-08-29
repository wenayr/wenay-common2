// ============================================================
//  replay/journal-bytes.test.ts
//
//  Journal byte budget: keepBytes evicts oldest while the retained total
//  exceeds it (the newest entry always survives), sizeOf is called once per
//  event at ingest, all three bounds (history/keepMs/keepBytes) coexist with
//  whichever bites first winning, journalWindow() reports bytes and
//  cappedByBytes, and the Store layer measures with the packed-V2 wire
//  estimator instead of JSON.stringify. keepBytes unset = nothing measured.
//  Run: npx tsx replay/journal-bytes.test.ts
// ============================================================

import {replayListen} from '../src/Common/events/replay-listen'
import {createStore, listenStorePatches, type StorePatch} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {exposeStoreReplay} from '../src/Common/Observe/store-replay'
import {storeReplayPatchV2WireMetrics} from '../src/Common/Observe/store-replay-codec'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

let t = 1_000_000
const now = () => t

async function main() {
    // ============== keepBytes evicts oldest, newest tail stays servable ==============
    {
        const [emit, line] = replayListen<[number]>({keepBytes: 100, sizeOf: () => 10, current: 'last', now})
        for (let value = 1; value <= 15; value++) emit(value)
        const window = line.journalWindow()
        ok(window.entries == 10, 'budget 100 at 10 bytes each retains exactly 10 entries')
        ok(window.bytes == 100 && window.bytes <= 100, 'retained total stays at or under the budget')
        ok(window.oldestSeq == 6, 'the five oldest entries were evicted')
        ok(window.keepBytes == 100, 'the configured target is reported')
        ok(line.getSince(2) == undefined, 'evicted seq answers undefined (keyframe fallback)')
        const frame = line.frame(2)
        ok(frame.length == 1 && frame[0].seq == 15, 'frame falls back to the keyframe at head')
        ok(line.getSince(12)?.map(event => event.event[0]).join(',') == '13,14,15',
            'a recent seq is served from the retained tail')
    }

    // ============== the newest entry always survives, even oversized ==============
    {
        const [emit, line] = replayListen<[string]>({keepBytes: 100, sizeOf: event => event.event[0].length, now})
        emit('x'.repeat(500))
        let window = line.journalWindow()
        ok(window.entries == 1 && window.bytes == 500, 'one event larger than the whole budget is retained, reported honestly')
        emit('y'.repeat(400))
        window = line.journalWindow()
        ok(window.entries == 1 && window.bytes == 400 && window.oldestSeq == 2,
            'the next oversized event replaces it — the newest entry never goes')
    }

    // ============== whichever bites first: keepBytes tighter than history ==============
    {
        const [emit, line] = replayListen<[number]>({history: 50, keepBytes: 100, sizeOf: () => 10, now})
        for (let value = 1; value <= 30; value++) emit(value)
        const window = line.journalWindow()
        ok(window.entries == 10 && window.bytes == 100, 'the byte budget bites before the count cap')
        ok(window.cappedByBytes == true, 'and reports that it did')
        ok(window.cappedByCount == false, 'the count cap never fired')
    }

    // ============== whichever bites first: history tighter than keepBytes ==============
    {
        const [emit, line] = replayListen<[number]>({history: 3, keepBytes: 1_000, sizeOf: () => 10, now})
        for (let value = 1; value <= 10; value++) emit(value)
        const window = line.journalWindow()
        ok(window.entries == 3 && window.bytes == 30, 'the hard count cap bites first and bytes follow the evictions')
        ok(window.cappedByCount == true && window.cappedByBytes == false,
            'the count cap reports, the byte budget stays silent')
    }

    // ============== cappedByBytes false when only age evicts ==============
    {
        const [emit, line] = replayListen<[number]>({keepMs: 1_000, keepBytes: 1_000_000, sizeOf: () => 10, now})
        for (let value = 1; value <= 5; value++) emit(value)
        t += 2_000
        emit(6)
        const window = line.journalWindow()
        ok(window.entries == 1 && window.bytes == 10, 'age evicted the burst and the byte total followed')
        ok(window.cappedByBytes == false, 'age eviction alone never claims a byte cut')
    }

    // ============== cappedByBytes true exactly when bytes cut inside the keepMs window ==============
    {
        const [emit, line] = replayListen<[number]>({keepMs: 60_000, keepBytes: 25, sizeOf: () => 10, now})
        for (let value = 1; value <= 5; value++) emit(value)
        const window = line.journalWindow()
        ok(window.entries == 2 && window.bytes == 20,
            'entries the age window would have kept were cut to fit the budget')
        ok(window.cappedByBytes == true, 'and the cut is reported')
        // Age pruning at a later read releases bytes lazily, no new emit needed.
        t += 120_000
        ok(line.getSince(line.head())?.length == 0, 'up-to-date consumer stays cheap')
        ok(line.journalWindow().bytes == 0, 'the aged-out bytes were released at the read')
    }

    // ============== custom sizeOf: measured once per event at ingest ==============
    {
        let calls = 0
        const [emit, line] = replayListen<[number]>({keepBytes: 100, sizeOf: () => { calls++; return 10 }, now})
        for (let value = 1; value <= 15; value++) emit(value)
        line.journalWindow()
        line.getSince(12)
        line.journalWindow()
        ok(calls == 15, 'sizeOf ran once per event at ingest — reads never re-measure')
    }

    // ============== default estimator when sizeOf omitted: UTF-8 JSON of the tuple ==============
    {
        const [emit, line] = replayListen<[string]>({keepBytes: 1_000_000, now})
        emit('abcd')                 // ["abcd"] = 8 bytes
        emit('€')               // ["€"] = 7 UTF-8 bytes (the euro sign is 3)
        ok(line.journalWindow().bytes == 15, 'default estimator counts UTF-8 JSON bytes of the event tuple')
    }

    // ============== unmeasurable events price at the fixed fallback ==============
    {
        const [emit, line] = replayListen<[any]>({keepBytes: 1_000_000, now})
        const circular: any = {}
        circular.self = circular
        emit(circular)
        ok(line.journalWindow().bytes == 1024, 'a circular event falls back to the fixed conservative cost')
    }
    {
        const [emit, line] = replayListen<[number]>({
            keepBytes: 1_000_000,
            sizeOf: () => { throw new Error('measure exploded') },
            now,
        })
        emit(1)
        ok(line.journalWindow().bytes == 1024, 'a throwing sizeOf falls back instead of failing the publication')
        const [emitNan, lineNan] = replayListen<[number]>({keepBytes: 1_000_000, sizeOf: () => NaN, now})
        emitNan(1)
        ok(lineNan.journalWindow().bytes == 1024, 'a non-finite measure falls back too — the total must stay subtractable')
    }

    // ============== zero-cost path: keepBytes unset measures nothing ==============
    {
        let calls = 0
        const [emit, line] = replayListen<[number]>({history: 5, sizeOf: () => { calls++; return 1 }, now})
        for (let value = 1; value <= 10; value++) emit(value)
        const window = line.journalWindow()
        ok(calls == 0, 'without keepBytes the sizeOf lambda is never invoked')
        ok(window.bytes == 0 && window.keepBytes == 0 && window.cappedByBytes == false,
            'journalWindow reports bytes 0 and no byte bound in force')
    }

    // ============== bookkeeping survives compaction on a long-lived line ==============
    {
        const [emit, line] = replayListen<[number]>({keepBytes: 100, sizeOf: () => 1, now})
        for (let value = 1; value <= 1_000; value++) emit(value)
        const window = line.journalWindow()
        ok(window.entries == 100 && window.bytes == 100, 'sizes stay aligned across thousands of compactions')
        ok(line.getSince(998)?.map(event => event.event[0]).join(',') == '999,1000',
            'the tail is still served correctly after compaction')
    }

    // ============== Store layer: default sizeOf = packed-V2 wire estimator ==============
    {
        const store = createStore<Record<string, any>>({})
        const captured: StorePatch[][] = []
        const offCapture = listenStorePatches(store).on(function capturePatches(patches) {
            captured.push(patches.map(patch => ({...patch, path: [...patch.path]})))
        })
        const exposed = exposeStoreReplay(store, {history: 100, keepBytes: 1_000_000, now})
        store.state['alpha'] = {value: 1, tags: ['a', 'b']}
        await flushReactive(store.state)
        ok(captured.length == 1 && exposed.replay.journalWindow().entries == 1,
            'one drain became one journal envelope')
        const expected = 48 + captured[0].reduce(
            (total, patch) => total + storeReplayPatchV2WireMetrics(patch).byteLength + 1, 0)
        ok(exposed.replay.journalWindow().bytes == expected,
            'Store lines measure with the wire estimator, not a JSON guess')
        offCapture()
        exposed.close()
    }

    // ============== Store layer: keepBytes + custom sizeOf thread through ==============
    {
        const store = createStore<Record<string, number>>({})
        const exposed = exposeStoreReplay(store, {history: 100, keepBytes: 50, sizeOf: () => 10, now})
        for (let value = 1; value <= 10; value++) {
            store.state['k' + value] = value
            await flushReactive(store.state)
        }
        const window = exposed.replay.journalWindow()
        ok(window.entries == 5 && window.bytes == 50 && window.cappedByBytes == true,
            'the budget bounds the Store journal and reports the cut')
        const head = exposed.replay.head()
        ok(exposed.replay.getSince(head - 6) == undefined, 'an evicted Store seq falls back to the keyframe')
        ok(exposed.replay.getSince(head - 5)?.length == 5, 'the retained Store tail is served')
        exposed.close()
    }

    console.log(fails ? `journal-bytes: ${fails} FAILED` : 'journal-bytes: ALL GREEN')
    process.exit(fails ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
