// =====================================================================
// Replay journal retention: count cap, keepMs window, and their interaction
// =====================================================================
// Run: npx tsx observe/replay-journal-retention.test.ts

import assert from 'node:assert/strict'

import {replayListen} from '../src/Common/events/replay-listen'
import {createStore} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {exposeStoreReplay} from '../src/Common/Observe/store-replay'

let clock = 1_000
const now = () => clock

function tick(ms: number) {
    clock += ms
}

// =====================================================================
// Count-only: unchanged historical behaviour
// =====================================================================

function countOnlyRetentionIsUnchanged() {
    const [emit, line] = replayListen<[number]>({history: 3, now})
    for (let value = 1; value <= 5; value++) emit(value)

    assert.equal(line.head(), 5)
    // Journal holds 3, 4, 5 — asking from 2 is the oldest still-servable point.
    assert.deepEqual(line.getSince(2)?.map(event => event.event[0]), [3, 4, 5])
    assert.equal(line.getSince(1), undefined, 'evicted by the count cap')
    assert.deepEqual(line.getSince(5), [], 'already at head')

    const window = line.journalWindow()
    assert.equal(window.entries, 3)
    assert.equal(window.oldestSeq, 3)
    assert.equal(window.historyLimit, 3)
    assert.equal(window.keepMs, 0)
    assert.equal(window.cappedByCount, true)
    console.log('ok  count-only retention unchanged')
}

function historyZeroKeepsNoJournal() {
    const [emit, line] = replayListen<[number]>({now})
    emit(1)
    emit(2)
    assert.equal(line.getSince(1), undefined, 'no journal without either bound')
    assert.deepEqual(line.getSince(2), [], 'head is still answerable with no journal')
    assert.equal(line.journalWindow().entries, 0)
    console.log('ok  no journal without a bound')
}

// =====================================================================
// keepMs: a window expressed in time
// =====================================================================

function keepMsEvictsByAge() {
    const [emit, line] = replayListen<[number]>({keepMs: 1_000, now})
    emit(1)
    tick(400)
    emit(2)
    tick(400)
    emit(3)

    // All three are younger than 1000 ms.
    assert.deepEqual(line.getSince(0)?.map(event => event.event[0]), [1, 2, 3])

    // Push the first two past the window without emitting anything new: eviction
    // is lazy, so the read itself must apply it.
    tick(700)
    assert.equal(line.getSince(0), undefined, 'entry 1 aged out')
    assert.deepEqual(line.getSince(2)?.map(event => event.event[0]), [3])
    const window = line.journalWindow()
    assert.equal(window.entries, 1)
    assert.equal(window.oldestSeq, 3)
    assert.equal(window.cappedByCount, false, 'time evicted these, not a count cap')
    console.log('ok  keepMs evicts by age, lazily')
}

function keepMsCountIsUnboundedByDefault() {
    const [emit, line] = replayListen<[number]>({keepMs: 10_000, now})
    for (let value = 1; value <= 5_000; value++) emit(value)
    // No count cap was asked for, so the whole burst is still inside the window.
    assert.equal(line.journalWindow().entries, 5_000)
    assert.deepEqual(line.getSince(4_998)?.map(event => event.event[0]), [4_999, 5_000])
    console.log('ok  keepMs alone keeps the whole in-window burst')
}

function countCapWinsOverKeepMs() {
    const [emit, line] = replayListen<[number]>({history: 10, keepMs: 60_000, now})
    for (let value = 1; value <= 100; value++) emit(value)

    const window = line.journalWindow()
    assert.equal(window.entries, 10, 'the hard cap bounds a burst even inside the time window')
    assert.equal(window.cappedByCount, true, 'and says so instead of silently shortening the window')
    assert.equal(line.getSince(89), undefined)
    assert.deepEqual(line.getSince(90)?.map(event => event.event[0]).slice(0, 2), [91, 92])
    console.log('ok  count cap wins over keepMs and is reported')
}

// THE REGRESSION THIS FEATURE COULD EASILY INTRODUCE:
// a line quiet for longer than keepMs must still answer an up-to-date consumer
// cheaply, instead of forcing a keyframe for a store that did not change.
function quietLineStillAnswersHead() {
    const [emit, line] = replayListen<[number]>({keepMs: 500, now})
    emit(1)
    emit(2)
    tick(10_000)

    assert.deepEqual(line.getSince(2), [], 'up-to-date consumer needs no journal at all')
    assert.equal(line.journalWindow().entries, 0, 'and the aged-out memory is released')
    assert.equal(line.getSince(1), undefined, 'a genuinely behind consumer still takes a keyframe')
    console.log('ok  quiet line does not regress into a keyframe')
}

function reconnectInsideWindowCostsATail() {
    const [emit, line] = replayListen<[number]>({keepMs: 30_000, now})
    emit(1)
    emit(2)
    const cursor = line.head()
    emit(3)
    emit(4)

    // The client was away for 20 s, inside the retention window.
    tick(20_000)
    const tail = line.getSince(cursor)
    assert.ok(tail, 'reconnect inside the window is served from the journal')
    assert.deepEqual(tail.map(event => event.event[0]), [3, 4])

    // Away for longer than the window: keyframe, as designed.
    tick(20_000)
    assert.equal(line.getSince(cursor), undefined)
    console.log('ok  reconnect inside the window costs a tail, outside it a keyframe')
}

// =====================================================================
// Store layer
// =====================================================================

async function storeReplayAcceptsKeepMs() {
    const store = createStore<Record<string, number>>({})
    const exposed = exposeStoreReplay(store, {history: 0, keepMs: 5_000, now})
    store.state['a'] = 1
    await flushReactive(store.state)
    const afterFirst = exposed.replay.head()
    store.state['b'] = 2
    await flushReactive(store.state)
    assert.ok(exposed.replay.head() > afterFirst, 'the second write produced its own envelope')

    assert.ok(exposed.replay.getSince(afterFirst), 'inside the window: tail')
    assert.equal(exposed.replay.journalWindow().keepMs, 5_000)

    tick(6_000)
    assert.equal(exposed.replay.getSince(afterFirst), undefined, 'outside the window: keyframe')
    assert.deepEqual(exposed.replay.getSince(exposed.replay.head()), [], 'head stays cheap')
    exposed.close?.()
    console.log('ok  exposeStoreReplay accepts keepMs')
}

async function main() {
    countOnlyRetentionIsUnchanged()
    historyZeroKeepsNoJournal()
    keepMsEvictsByAge()
    keepMsCountIsUnboundedByDefault()
    countCapWinsOverKeepMs()
    quietLineStillAnswersHead()
    reconnectInsideWindowCostsATail()
    await storeReplayAcceptsKeepMs()
    console.log('\nreplay journal retention: all checks passed')
}

void main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
