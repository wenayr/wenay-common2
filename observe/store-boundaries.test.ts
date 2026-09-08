import {strict as assert} from 'node:assert'
import {test} from 'node:test'
import {createStore, cloneStoreValue, createStoreMirror} from '../src/Common/Observe/store'
import {flushReactive, isReactive, onUpdate} from '../src/Common/Observe/reactive'
import {listen} from '../src/Common/events/Listen'

test('snapshots preserve sparse array length and holes', function sparseSnapshot() {
    const values = new Array<number>(5)
    values[1] = 7
    const store = createStore({values})
    const snapshot = store.snapshot()
    assert.equal(snapshot.values.length, 5)
    assert.deepEqual(Object.keys(snapshot.values), ['1'])
    assert.notEqual(snapshot.values, values)
})

test('array-root replacement preserves shape, holes and length', async function arrayRootReplacement() {
    const store = createStore([1, 2, 3])
    const next = new Array<number>(4)
    next[1] = 8
    let notices = 0
    const off = store.on(function count() { notices++ })
    try {
        store.replace(next)
        await flushReactive(store.state)
        assert.deepEqual(store.snapshot(), next)
        assert.equal(notices, 1)
        store.replace([])
        await flushReactive(store.state)
        assert.deepEqual(store.snapshot(), [])
    } finally { off() }
})

test('snapshots preserve shared rich-value identity', function sharedRichValues() {
    const date = new Date(123)
    const bytes = new Uint8Array([1, 2])
    const buffer = bytes.buffer
    const pattern = /x/g
    pattern.lastIndex = 3
    const copy = cloneStoreValue({date, index: new Map([[date, 'value']]), bytes, sameBytes: bytes,
        buffer, sameBuffer: buffer, pattern, samePattern: pattern})
    assert.equal(copy.index.get(copy.date), 'value')
    assert.equal(copy.bytes, copy.sameBytes)
    assert.equal(copy.buffer, copy.sameBuffer)
    assert.equal(copy.pattern, copy.samePattern)
    assert.equal(copy.pattern.lastIndex, 3)
    assert.notEqual(copy.date, date)
    assert.notEqual(copy.bytes, bytes)
})

for (const mode of ['on', 'once', 'selection', 'each'] as const) {
    test('throwing current callback cleans up ' + mode, function failedCurrentSubscription() {
        const store = createStore({a: 1, b: 2})
        function fail() { throw new Error('callback failed') }
        assert.throws(function subscribe() {
            if (mode == 'on') store.node.a.on(fail, {current: true})
            else if (mode == 'once') store.node.a.once(fail, {current: true})
            else if (mode == 'selection') store.update({a: true, b: true}).on(fail, {current: true})
            else store.update({a: true, b: true}).onEach(fail, {current: true})
        }, /callback failed/)
        assert.equal(store.count(), 0, 'failed subscribe must leave no owned subscription')
    })
}

for (const mode of ['set', 'define'] as const) {
    test('array truncation detaches removed element proxies via ' + mode, async function truncateArray() {
        const store = createStore({rows: [{value: 1}]})
        const child = store.state.rows[0]
        let rootNotices = 0
        let childNotices = 0
        const offRoot = store.on(function rootChanged() { rootNotices++ })
        const offChild = onUpdate(child, function childChanged() { childNotices++ })
        try {
            if (mode == 'set') store.state.rows.length = 0
            else Object.defineProperty(store.state.rows, 'length', {value: 0})
            await flushReactive(store.state)
            assert.equal(isReactive(child), false)
            assert.equal(childNotices, 1, 'removed branch gets its final change notice')
            const notices = rootNotices
            child.value = 2
            await flushReactive(store.state)
            assert.equal(rootNotices, notices, 'detached data cannot dirty the live Store')
        } finally { offRoot(); offChild() }
    })
}

test('closed mirror sync neither applies an old pull nor starts queued pulls', async function closeMirrorPull() {
    const [emit, changed] = listen<[]>()
    let resolve!: (value: {count: number}) => void
    let calls = 0
    const remote = {
        changed,
        get() {
            calls++
            return new Promise<{count: number}>(function pendingPull(done) { resolve = done })
        },
    }
    const mirror = createStoreMirror(remote, {count: 0})
    const off = await mirror.sync(true, {current: false})
    emit()
    await Promise.resolve()
    emit()
    off()
    resolve({count: 9})
    await new Promise<void>(function settle(done) { setImmediate(done) })
    assert.equal(mirror.state.count, 0)
    assert.equal(calls, 1)
})

test('array length reflection follows replacement and read-only length', function reflectArrayLength() {
    const store = createStore([1, 2, 3])
    store.replace([8, 9])
    assert.equal(Object.getOwnPropertyDescriptor(store.state, 'length')?.value, 2)
    Object.defineProperty(store.state, 'length', {writable: false})
    assert.equal(Object.getOwnPropertyDescriptor(store.state, 'length')?.writable, false)
    assert.equal(Reflect.set(store.state, 'length', 1), false)
})

for (const mode of ['set', 'define'] as const) {
    test('partial rejected array truncation still publishes its actual change: ' + mode, async function partialTruncation() {
        const rows = [{value: 0}, {value: 1}, {value: 2}]
        Object.defineProperty(rows, '1', {configurable: false})
        const store = createStore({rows})
        const removed = store.state.rows[2]
        let notices = 0
        const off = store.on(function changed() { notices++ })
        try {
            const accepted = mode == 'set'
                ? Reflect.set(store.state.rows, 'length', 0)
                : Reflect.defineProperty(store.state.rows, 'length', {value: 0})
            assert.equal(accepted, false)
            await flushReactive(store.state)
            assert.equal(store.state.rows.length, 2)
            assert.equal(notices, 1)
            assert.equal(isReactive(removed), false)
            removed.value = 3
            await flushReactive(store.state)
            assert.equal(notices, 1)
        } finally { off() }
    })
}

test('current callback writes remain observable by its subscription', async function currentMutation() {
    const store = createStore({value: 0})
    const values: number[] = []
    const off = store.node.value.on(function changed(value) {
        values.push(value)
        if (value == 0) store.state.value = 1
    }, {current: true})
    try {
        await flushReactive(store.state)
        assert.deepEqual(values, [0, 1])
    } finally { off() }
})
