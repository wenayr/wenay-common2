// =====================================================================
// Store value semantics — the reactivity contract, pinned
// =====================================================================
// Plain objects and arrays are reactive at ANY depth: mutate them normally.
// Rich values (Map/Set/Date/TypedArray/class instances) are VALUES:
// replacing one is visible, mutating one in place is invisible by design
// (the reactive proxy wraps only plain objects and arrays — reactive.ts
// isReactiveObj). This spec is the executable form of that table, so a
// future change to either half fails here first.

import * as assert from 'node:assert/strict'
import {createStore} from './store'

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

class Model { constructor(public title: string) {} }

async function run() {
    type State = {
        deep: {a: {b: {c: number}}}
        list: number[]
        dict: Record<string, {n: number}>
        index: Map<string, number>
        tags: Set<string>
        when: Date
        buf: Uint8Array
        model: Model
    }
    const store = createStore<State>({
        deep: {a: {b: {c: 0}}},
        list: [1, 2, 3],
        dict: {},
        index: new Map(),
        tags: new Set(),
        when: new Date(0),
        buf: new Uint8Array([1, 2]),
        model: new Model('one'),
    }, {drain: 'micro'})

    const seen: string[] = []
    store.each().on(function collectChangedKey(key) { seen.push(String(key)) })
    const drainKeys = () => seen.splice(0)

    // ============== reactive: plain objects and arrays, any depth ==============

    store.state.deep.a.b.c = 15
    await wait()
    assert.deepEqual(drainKeys(), ['deep'], 'deep nested write on plain objects is reactive')

    store.state.deep.a.b.c = 8
    store.state.deep.a.b.c = 9
    await wait()
    assert.deepEqual(drainKeys(), ['deep'], 'two writes in one drain window coalesce to ONE fact')
    assert.equal(store.node.deep.a.b.c.get(), 9, 'the coalesced fact reads the LAST value')

    store.state.list.push(4)
    await wait()
    assert.deepEqual(drainKeys(), ['list'], 'array in-place mutation (push) is reactive')

    store.state.dict['k'] = {n: 1}
    await wait()
    assert.deepEqual(drainKeys(), ['dict'], 'adding a dict key is reactive')

    delete store.state.dict['k']
    await wait()
    assert.deepEqual(drainKeys(), ['dict'], 'deleting a dict key is reactive')

    // ============== rich values: replacement is visible ==============

    store.state.index = new Map([['b', 2]])
    store.state.tags = new Set(['y'])
    store.state.when = new Date(5000)
    store.state.model = new Model('two')
    await wait()
    assert.deepEqual([...drainKeys()].sort(), ['index', 'model', 'tags', 'when'],
        'replacing a rich value wholesale is reactive')

    // ============== rich values: in-place mutation is invisible BY DESIGN ==============

    store.state.index.set('a', 1)
    store.state.tags.add('x')
    store.state.when.setTime(9000)
    store.state.buf[0] = 9
    store.state.model.title = 'three'
    await wait()
    assert.deepEqual(drainKeys(), [],
        'in-place mutation of Map/Set/Date/TypedArray/class instances emits NOTHING — value semantics: replace, do not mutate')

    // the values themselves did mutate (they are opaque, not frozen) — only the FACT is absent
    assert.equal(store.state.index.get('a'), 1)
    assert.equal(store.state.model.title, 'three')

    // prototypes are preserved: rich values are opaque leaves, not converted to plain data
    assert.ok(store.state.model instanceof Model, 'class instance keeps its prototype')
    assert.ok(store.state.index instanceof Map, 'Map stays a Map')

    // snapshots still deep-clone rich values with full semantics
    const snap = store.node.index.snapshot()
    assert.ok(snap instanceof Map && snap.get('a') == 1 && snap != store.state.index,
        'snapshot() deep-clones rich values (detached copy, same content)')

    console.log('store-value-semantics: OK')
}

run().catch(function fail(error) {
    console.error(error)
    process.exit(1)
})
