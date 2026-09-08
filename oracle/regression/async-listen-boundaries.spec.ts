import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createAsyncQueue, createReadyGate} from '../../src/Common/async/waitRun'
import {listen} from '../../src/Common/events/Listen'
import {mapListen} from '../../src/Common/events/mapListen'
import {joinListens} from '../../src/Common/events/joinListens'

test('onIdle observes work added after an earlier idle observation', async function () {
    const queue = createAsyncQueue()
    await queue.onIdle()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const task = queue.add(async function task() { await blocked })
    let idle = false
    const waiting = queue.onIdle().then(function becameIdle() { idle = true })
    await Promise.resolve()
    const premature = idle
    release()
    await task
    await waiting
    assert.equal(premature, false)
})

for (const failure of [undefined, null]) {
    test(`ready gate preserves a first ${failure} rejection and continues draining`, async function () {
        const gate = createReadyGate()
        let continued = false
        gate.add(function first() { throw failure })
        gate.add(function second() { continued = true; throw new Error('second') })
        const [result] = await Promise.allSettled([gate.ready()])
        assert.equal(continued, true)
        assert.equal(result.status, 'rejected')
        if (result.status == 'rejected') assert.equal(result.reason, failure)
    })
}

for (const signal of [false, true]) {
    test(`mapped listen releases its source on ${signal ? 'closeOn' : 'close'}`, function () {
        const [emitSource, source] = listen<[number]>()
        const [close, closeOn] = listen<[]>()
        let transforms = 0
        const [, mapped] = mapListen(source, function transform(value) {
            transforms++
            return [value * 2] as [number]
        }, {closeOn})
        mapped.on(function consume() {})
        assert.equal(source.count(), 1)
        if (signal) close()
        else mapped.close()
        emitSource(1)
        assert.equal(source.count(), 0)
        assert.equal(transforms, 0)
        source.close()
        closeOn.close()
    })
}

test('join clear targets the empty-string bucket without clearing other groups', function () {
    const [emit, left] = listen<[string]>()
    const [, right] = listen<[string]>()
    const joined = joinListens([left, right], value => value)
    try {
        emit('')
        emit('keep')
        joined.clear('')
        assert.deepEqual([...joined.pending.keys()], ['keep'])
    } finally { joined.destroy() }
})

test('mapped listen owns only the newest reentrant source subscription', function () {
    const [, source] = listen<[number]>({
        event(type, count, api) { if (type == 'add') api.emit(1) },
    })
    const [, mapped] = mapListen(source, value => [value] as [number])
    try {
        mapped.on(function reopen() {
            mapped.close()
            mapped.run()
            mapped.on(function consume() {})
        })
        assert.equal(source.count(), 1)
        mapped.close()
        assert.equal(source.count(), 0)
        for (let cycle = 0; cycle < 3; cycle++) {
            mapped.run()
            mapped.on(function consume() {})
            assert.equal(source.count(), 1)
            mapped.close()
            assert.equal(source.count(), 0)
        }
    } finally { mapped.close(); source.close() }
})
