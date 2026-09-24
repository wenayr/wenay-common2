import assert from 'node:assert/strict'
import {
    createStore, flushReactive, onUpdate, toRaw, listenStorePatches, applyStorePatches,
    exposeStoreReplay, syncStoreReplay,
} from '../../src/Common/Observe'
import {runOracle} from '../run-oracle'

function retainedHistory() {
    const store = createStore({article: {title: 'first', history: [{title: 'previous'}]}})
    store.state.article = {
        title: 'second',
        history: [...store.state.article.history, {title: 'first'}],
    }
    assert.deepEqual(store.snapshot(), {
        article: {title: 'second', history: [{title: 'previous'}, {title: 'first'}]},
    })
    store.state.article.history[0].title = 'updated'
    assert.equal(store.snapshot().article.history[0].title, 'updated')
}

function retainedRental() {
    const store = createStore({resource: {revision: 1, weekly: [{day: 1}], exceptions: [{day: 2}]}})
    const old = store.state.resource
    store.state.resource = {...old, revision: 2}
    assert.equal(store.state.resource.weekly[0].day, 1)
    assert.equal(store.state.resource.exceptions[0].day, 2)
    store.state.resource.weekly[0].day = 3
    assert.equal(store.snapshot().resource.weekly[0].day, 3)
}

async function repeatedReplacement() {
    const store = createStore({article: {title: '0', history: [] as {title: string, detail: {n: number}}[]}})
    const expected: {title: string, detail: {n: number}}[] = []
    for (let i = 1; i <= 80; i++) {
        expected.push({title: String(i - 1), detail: {n: i}})
        if (expected.length > 20) expected.shift()
        store.state.article = {
            title: String(i),
            history: [...store.state.article.history, {title: String(i - 1), detail: {n: i}}].slice(-20),
        }
        assert.deepEqual(store.snapshot().article.history, expected)
        assert.equal(store.state.article.history[0].detail.n, expected[0].detail.n)
    }
    store.state.article.history = [...store.state.article.history].reverse()
    assert.deepEqual(store.snapshot().article.history, [...expected].reverse())
    store.state.article.history = store.state.article.history.slice(-3)
    assert.deepEqual(store.snapshot().article.history, [...expected].reverse().slice(-3))
    store.node.article.replace({...store.state.article, title: 'via node'})
    assert.equal(store.state.article.title, 'via node')
}

async function retainedNotifications() {
    const store = createStore({article: {title: 'first', history: [{title: 'previous'}]}})
    const first = store.state.article.history[0]
    const parent = store.state.article
    let rootHits = 0
    let proxyHits = 0
    const titles: string[] = []
    const offRoot = store.on(function rootChanged() { rootHits++ })
    const offProxy = onUpdate(first, function elementChanged() { proxyHits++ })
    const offTitle = store.node.article.history.at(0).title.on(function titleChanged(title) { titles.push(title) })
    try {
        store.state.article = {title: 'second', history: [...store.state.article.history, {title: 'first'}]}
        await flushReactive(store.state)
        assert.equal(store.state.article, parent)
        assert.equal(store.state.article.history[0], first)
        assert.equal(rootHits, 1)
        assert.equal(proxyHits, 1)
        titles.length = 0
        first.title = 'updated'
        await flushReactive(store.state)
        assert.equal(rootHits, 2)
        assert.equal(proxyHits, 2)
        assert.deepEqual(titles, ['updated'])
        assert.equal(store.snapshot().article.history[0].title, 'updated')
    } finally { offRoot(); offProxy(); offTitle() }
}

async function movedAndSwappedBranches() {
    const store = createStore({left: [{id: 1, value: {n: 1}}], right: [{id: 2, value: {n: 2}}]})
    const left = store.state.left
    const right = store.state.right
    // Resolve both input proxies before the first destination path is rebound.
    store.replace({left: right, right: left})
    assert.deepEqual(store.snapshot(), {left: [{id: 2, value: {n: 2}}], right: [{id: 1, value: {n: 1}}]})
    assert.equal(store.state.left, left)
    const moved = store.state.left[0]
    const rawMoved = toRaw(moved)
    store.replace({left: [], right: [moved, ...store.state.right]})
    assert.equal(store.state.right[0].id, 2)
    assert.equal(toRaw(store.state.right[0]), rawMoved)
    assert.equal(store.state.left.length, 0)
    let leftHits = 0
    let rightHits = 0
    const offLeft = store.node.left.on(function changed() { leftHits++ })
    const offRight = store.node.right.on(function changed() { rightHits++ })
    try {
        store.state.right[0].value.n = 7
        await flushReactive(store.state)
        assert.equal(leftHits, 0)
        assert.equal(rightHits, 1)
        assert.equal(store.snapshot().right[0].value.n, 7)
    } finally { offLeft(); offRight() }

    const reused = createStore({copy: {item: store.state.right[0]}})
    store.state.right = [{id: 9, value: {n: 9}}]
    assert.equal(reused.state.copy.item.id, 2, 'initial nested inputs retain values, not foreign path proxies')
}

async function patchesReplayAndRestore() {
    const store = createStore({article: {title: 'first', history: [{title: 'previous'}]}})
    const patched = createStore(store.snapshot())
    const replica = createStore(store.snapshot())
    let patchBatches = 0
    const offPatches = listenStorePatches(store).on(function receive(patches) {
        patchBatches++
        applyStorePatches(patched, JSON.parse(JSON.stringify(patches)))
    })
    const exposed = exposeStoreReplay(store, {history: 16})
    const offReplay = syncStoreReplay(replica, exposed.api.replay, {since: -1})
    try {
        await offReplay.ready
        for (let i = 0; i < 30; i++) {
            store.state.article = {title: String(i), history: [...store.state.article.history, {title: 'old-' + i}].slice(-20)}
            await flushReactive(store.state)
            assert.deepEqual(patched.snapshot(), store.snapshot())
            assert.deepEqual(replica.snapshot(), store.snapshot())
        }
        store.state.article.history[0].title = 'after-replacement'
        await flushReactive(store.state)
        assert.deepEqual(patched.snapshot(), store.snapshot())
        assert.deepEqual(replica.snapshot(), store.snapshot())
        assert.equal(patchBatches, 31)
        const restored = createStore(JSON.parse(JSON.stringify(store.snapshot())) as ReturnType<typeof store.snapshot>)
        restored.state.article = {...restored.state.article, history: [...restored.state.article.history, {title: 'restored'}]}
        restored.state.article.history[0].title = 'restored-update'
        assert.equal(restored.snapshot().article.history[0].title, 'restored-update')
        const lateReplica = createStore({article: {title: '', history: [] as {title: string}[]}})
        const late = syncStoreReplay(lateReplica, exposed.api.replay, {since: -1})
        try { await late.ready; assert.deepEqual(lateReplica.snapshot(), store.snapshot()) }
        finally { late() }
    } finally { offReplay(); offPatches(); exposed.close() }
}

async function main() {
    for (const check of [retainedHistory, retainedRental, repeatedReplacement, retainedNotifications, movedAndSwappedBranches, patchesReplayAndRestore]) {
        try { await check(); console.log('PASS ' + check.name) }
        catch (error) { console.error('FAIL ' + check.name, error); process.exitCode = 1 }
    }
}

runOracle(main)
