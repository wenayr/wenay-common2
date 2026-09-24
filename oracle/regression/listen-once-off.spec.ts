import assert from 'node:assert/strict'
import {createListen, createListenCore, listenStore} from '../../src/Common/events/Listen'
import {replayListen} from '../../src/Common/events/replay-listen'

// off(cb) removes every registration of cb, once() included: the caller only
// knows the callback it passed, never the wrapper once() stores for it.

type tLine = {
    emit(value: number): void
    once(cb: (value: number) => void): () => void
    on(cb: (value: number) => void): () => void
    off(cb: (value: number) => void): void
    count(): number
}

const layers: Record<string, () => tLine> = {
    'createListenCore fast': () => createListenCore<[number]>({fast: true}),
    'createListenCore slow': () => createListenCore<[number]>({fast: false}),
    'createListen fast': () => createListen<[number]>(function produce() {}, {fast: true}),
    'createListen slow': () => createListen<[number]>(function produce() {}, {fast: false}),
    'listenStore': () => {
        const [emit, store] = listenStore<[number]>({current: () => [0]})
        return {...store, emit}
    },
    'replayListen': () => {
        const [emit, replay] = replayListen<[number]>({history: 4})
        return {...replay, emit}
    },
}

function checkOffCancelsOnce(create: () => tLine) {
    const line = create()
    const received: number[] = []
    function cb(value: number) { received.push(value) }
    line.once(cb)
    line.off(cb)
    assert.equal(line.count(), 0, 'off(cb) removes the once registration')
    line.emit(1)
    assert.deepEqual(received, [], 'a cancelled once is not called')
}

function checkOffRemovesEveryRegistration(create: () => tLine) {
    const line = create()
    const received: string[] = []
    function cb(value: number) { received.push('cb' + value) }
    line.on(cb)
    line.once(cb)
    line.once(function other(value) { received.push('other' + value) })
    line.off(cb)
    line.emit(1)
    assert.deepEqual(received, ['other1'], 'off(cb) removes on(cb) and once(cb), and only those')
    assert.equal(line.count(), 0)
}

let failures = 0
for (const [name, create] of Object.entries(layers)) {
    for (const check of [checkOffCancelsOnce, checkOffRemovesEveryRegistration]) {
        try {
            check(create)
            console.log(`PASS ${check.name} ${name}`)
        } catch (error) {
            failures++
            console.error(`FAIL ${check.name} ${name}: ${(error as Error)?.message ?? error}`)
        }
    }
}
if (failures) {
    console.error(`${failures} once/off checks failed`)
    process.exit(1)
}
console.log('PASS once/off: off(cb) cancels once(cb) on core, full, store and replay lines')
