import assert from 'node:assert/strict'
import {replayListen} from '../../src/Common/events/replay-listen'
import {createMemoryReplayStorage, openHistory} from '../../src/Common/events/replay-history'

// A subscription whose synchronous catch-up throws hands no off() to its caller.
// It must roll itself back like withStoreListen, or its live tap stays in replay
// mode and queues every later envelope for the life of the line.

const failure = new Error('consumer rejected a replayed event')

function assertRolledBack(line: {count(): number}, emit: (value: number) => void, subscribe: () => unknown) {
    assert.throws(subscribe, error => error === failure, 'the catch-up error reaches the caller unchanged')
    assert.equal(line.count(), 0, 'a failed catch-up leaves no live tap behind')
    const received: number[] = []
    const off = (line as any).on(function healthy(value: number) { received.push(value) })
    emit(100)
    off()
    assert.deepEqual(received, [100], 'the line keeps serving later subscribers')
}

function checkSinceConsumerThrows() {
    const [emit, line] = replayListen<[number]>({history: 100})
    emit(1)
    emit(2)
    let calls = 0
    assertRolledBack(line, emit, function subscribeFromZero() {
        line.on(function consumer(value) {
            calls++
            if (value == 1) throw failure
        }, {since: 0})
    })
    assert.equal(calls, 1, 'the rolled-back consumer is never called again')
}

function checkSinceOnSeqThrows() {
    const [emit, line] = replayListen<[number]>({history: 100})
    emit(1)
    assertRolledBack(line, emit, function subscribeWithThrowingSeq() {
        line.on(function consumer() {}, {since: 0, onSeq: function reportSeq() { throw failure }})
    })
}

function checkSinceKeyframeThrows() {
    let broken = false
    const [emit, line] = replayListen<[number]>({history: 1, current: function keyframe() {
        if (broken) throw failure
        return [0]
    }})
    emit(1)
    emit(2)
    emit(3)
    broken = true
    // seq 0 is evicted from a one-entry journal: catch-up needs a fresh keyframe.
    assertRolledBack(line, emit, function subscribeAfterEviction() {
        line.on(function consumer() {}, {since: 0})
    })
}

function checkCurrentConsumerThrows() {
    const [emit, line] = replayListen<[number]>({current: () => [5]})
    assertRolledBack(line, emit, function subscribeWithCurrent() {
        line.on(function consumer(value) { if (value == 5) throw failure }, {current: true})
    })
}

function checkHistoryLiveCatchUpThrows() {
    // openHistory hands its live leg to the same catch-up: the archive is empty,
    // so the throwing delivery happens inside live.on({since}).
    const [emit, line] = replayListen<[number]>({history: 100})
    emit(1)
    emit(2)
    const history = openHistory(createMemoryReplayStorage<[number]>(), line)
    assertRolledBack(line, emit, function subscribeThroughHistory() {
        history.subscribe(function consumer(value) { if (value == 2) throw failure }, {since: 0})
    })
}

let failures = 0
const checks = [
    checkSinceConsumerThrows,
    checkSinceOnSeqThrows,
    checkSinceKeyframeThrows,
    checkCurrentConsumerThrows,
    checkHistoryLiveCatchUpThrows,
]
for (const check of checks) {
    try {
        check()
        console.log(`PASS ${check.name}`)
    } catch (error) {
        failures++
        console.error(`FAIL ${check.name}: ${(error as Error)?.message ?? error}`)
    }
}
if (failures) {
    console.error(`${failures} replay catch-up rollback checks failed`)
    process.exit(1)
}
console.log('PASS replay catch-up rollback: since/current/keyframe/onSeq failures and openHistory release the live tap')
