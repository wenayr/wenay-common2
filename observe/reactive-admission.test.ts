import assert from 'node:assert/strict'
import {reactive, toRaw, isReactive, onUpdate, flushReactive} from '../src/Common/Observe'
import {runOracle} from '../oracle/run-oracle'

async function main() {
    for (const eager of [false, true]) {
        const state = reactive({article: {title: 'first', history: [{title: 'previous', detail: {n: 1}}]}}, {eager})
        const article = state.article
        const history = state.article.history
        const first = history[0]
        const detail = first.detail
        const rawFirst = toRaw(first)
        let notifications = 0
        const off = onUpdate(detail, function changed() { notifications++ })
        state.article = {title: 'second', history: [...history, {title: 'first', detail: {n: 2}}]}
        assert.equal(state.article, article, 'parent proxy identity is tied to its path')
        assert.equal(state.article.history, history)
        assert.equal(history[0], first)
        assert.equal(toRaw(first), rawFirst, 'the retained slot targets its original raw value, never its proxy')
        assert.equal(toRaw(history)[0], rawFirst)
        assert.equal(first.title, 'previous')
        assert.equal(Object.keys(first).includes('detail'), true)
        assert.equal(detail.n, 1)
        await flushReactive(state)
        notifications = 0
        detail.n = 3
        await flushReactive(state)
        assert.equal(state.article.history[0].detail.n, 3)
        assert.equal(notifications, 1)
        off()
    }

    const source = reactive({item: {id: 1}, other: {id: 2}})
    const key = Symbol('retained')
    const sparse = new Array(4)
    sparse[2] = source.item
    const nullPrototype = Object.create(null)
    Object.defineProperty(nullPrototype, key, {value: source.other, enumerable: false, configurable: true})
    Object.defineProperty(nullPrototype, '__proto__', {value: source.item, enumerable: true, writable: true, configurable: true})
    const input = {sparse, nullPrototype, again: source.item}
    const admitted = reactive(input)
    assert.equal(toRaw(admitted), input, 'ordinary input containers remain Store-owned, not wholesale cloned')
    assert.equal(toRaw(admitted.sparse).length, 4)
    assert.equal(0 in toRaw(admitted.sparse), false)
    assert.equal(toRaw(admitted.sparse)[2], toRaw(source.item))
    assert.equal(toRaw(admitted.nullPrototype)[key], toRaw(source.other))
    assert.equal(Object.getPrototypeOf(toRaw(admitted.nullPrototype)), null)
    assert.equal(toRaw(admitted.nullPrototype).__proto__, toRaw(source.item))
    assert.equal(toRaw(admitted.again), toRaw(source.item))
    assert.equal(Object.getOwnPropertyDescriptor(toRaw(admitted.nullPrototype), key)!.enumerable, false)

    const deep: {child?: unknown} = {}
    let tail = deep
    for (let i = 0; i < 10_000; i++) { const next = {}; tail.child = next; tail = next }
    tail.child = source.item
    const holder = reactive<{value: unknown}>({value: null})
    holder.value = deep
    assert.equal(tail.child, toRaw(source.item), 'admission uses an iterative graph walk')

    const shared = {n: 1}
    const cycle: {a: typeof shared, b: typeof shared, self?: unknown} = {a: shared, b: shared}
    cycle.self = cycle
    const cyclic = reactive({value: cycle}, {eager: true})
    assert.equal(toRaw(cyclic.value).self, cycle, 'local cycles do not recurse during eager admission')
    assert.equal(toRaw(cyclic.value.a), toRaw(cyclic.value.b))
    cyclic.value = {...cyclic.value, a: cyclic.value.a}
    assert.equal(cyclic.value.a.n, 1)
    assert.equal(isReactive(cyclic.value.a), true)

    const before = {value: {list: [{id: 0}]}}
    const guarded = reactive(before)
    const mutable = {saved: source.item}
    const frozen = Object.freeze([source.other])
    assert.throws(function cannotUnwrapFrozenSlot() {
        guarded.value = {list: [{id: 4}], mutable, frozen} as typeof guarded.value
    }, function clearFailure(error) {
        return error instanceof TypeError && /Observe.*non-writable, non-configurable/.test(error.message)
    })
    assert.equal(mutable.saved, source.item, 'failed preflight leaves the submitted graph untouched')
    assert.equal(guarded.value.list[0].id, 0, 'failure does not replace the destination')
    assert.equal(guarded.value, guarded.value)

    const defined = reactive<{box?: {nested: {item: {id: number}}}}>({})
    Object.defineProperty(defined, 'box', {value: {nested: {item: source.item}}, configurable: true, enumerable: true, writable: true})
    assert.equal(toRaw(defined.box!.nested).item, toRaw(source.item))
    const accessor = reactive({get item() { return source.item }})
    assert.equal(accessor.item.id, 1)
    assert.equal(toRaw(accessor.item), toRaw(source.item), 'accessor results never become proxy targets')
    console.log('PASS reactive admission: retained identities, initial/descriptor input, deep/cyclic/shared graphs, immutable-slot refusal')
}

runOracle(main)
