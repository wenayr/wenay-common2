import assert from 'node:assert/strict'
import {createListen, createListenCore, ListenCoreApi} from '../../src/Common/events/Listen'

// fast:false only changes how dispatch is built, never who receives an event:
// the listeners of an emit are the ones present when it started.

const RUNAWAY = 100

function createApi(fast: boolean, full: boolean): ListenCoreApi<[number]> {
    return full
        ? createListen<[number]>(function produce() {}, {fast})
        : createListenCore<[number]>({fast})
}

function checkSelfRearmingOnce(fast: boolean, full: boolean) {
    const api = createApi(fast, full)
    const seen: number[] = []
    function rearm(value: number) {
        seen.push(value)
        if (seen.length > RUNAWAY) throw new Error(`runaway: ${seen.length} deliveries`)
        api.once(rearm)
    }
    api.once(rearm)
    api.emit(1)
    assert.deepEqual(seen, [1], 'a once that re-arms itself fires once per emit')
    api.emit(2)
    assert.deepEqual(seen, [1, 2], 'the re-armed once waits for the next emit')
    assert.equal(api.count(), 1)
    api.close()
}

function checkListenerAddedDuringEmit(fast: boolean, full: boolean) {
    const api = createApi(fast, full)
    const late: number[] = []
    api.on(function addLate(value) {
        if (value == 1) api.on(function lateListener(next) { late.push(next) })
    })
    api.emit(1)
    assert.deepEqual(late, [], 'a listener added during an emit does not receive it')
    api.emit(2)
    assert.deepEqual(late, [2], 'it receives the next one')
    api.close()
}

let failures = 0
for (const fast of [true, false]) {
    for (const full of [false, true]) {
        for (const check of [checkSelfRearmingOnce, checkListenerAddedDuringEmit]) {
            const label = `${check.name} fast=${fast} ${full ? 'createListen' : 'createListenCore'}`
            try {
                check(fast, full)
                console.log(`PASS ${label}`)
            } catch (error) {
                failures++
                console.error(`FAIL ${label}: ${(error as Error)?.message ?? error}`)
            }
        }
    }
}
if (failures) {
    console.error(`${failures} Listen dispatch snapshot checks failed`)
    process.exit(1)
}
console.log('PASS Listen dispatch snapshot: fast and slow modes deliver an emit to the listeners present when it started')
