import {
    CancelablePromise,
    MapExt,
    StructMap,
    StructSet,
    clone,
    deepEqual,
} from '../../src/Common/core/common'

let fails = 0

function assert(cond: any, msg: string) {
    if (cond) console.log('  ok  :', msg)
    else { fails++; console.log('  FAIL:', msg) }
}

async function assertRejects(promise: Promise<any>, expected: any, msg: string) {
    try {
        await promise
        assert(false, msg + ' (resolved)')
    }
    catch (e) {
        assert(e === expected, msg)
    }
}

async function main() {
    // clone: cycles are preserved without reusing original objects.
    {
        const src: any = { name: 'root' }
        src.self = src
        src.child = { parent: src }

        const copy = clone(src) as any

        assert(copy !== src, 'clone creates a new root object')
        assert(copy.self === copy, 'clone preserves direct object cycle')
        assert(copy.child !== src.child, 'clone creates a new nested object')
        assert(copy.child.parent === copy, 'clone rewires nested cycle to cloned root')
    }

    // clone: Map and Set entries are deeply cloned.
    {
        const key = { id: 1 }
        const val = { nested: { n: 2 } }
        const setItem = { tag: 'set-item' }
        const src = {
            map: new Map<any, any>([[key, val]]),
            set: new Set<any>([setItem]),
        }

        const copy = clone(src)
        const [[copyKey, copyVal]] = copy.map.entries()
        const [copySetItem] = copy.set.values()

        assert(copy.map !== src.map, 'clone creates a new Map')
        assert(copy.set !== src.set, 'clone creates a new Set')
        assert(copyKey !== key && copyKey.id === key.id, 'clone deep-clones Map keys')
        assert(copyVal !== val && copyVal.nested !== val.nested && copyVal.nested.n === 2, 'clone deep-clones Map values')
        assert(copySetItem !== setItem && copySetItem.tag === setItem.tag, 'clone deep-clones Set values')
    }

    // deepEqual: null, Date, Map, and Set equality.
    {
        assert(deepEqual(null, null), 'deepEqual treats null values as equal')
        assert(deepEqual(null, undefined), 'deepEqual preserves historical loose top-level null equality')
        assert(deepEqual(1, '1'), 'deepEqual preserves historical loose top-level primitive equality')
        assert(deepEqual(0, -0), 'deepEqual preserves historical signed-zero equality')
        assert(!deepEqual(null, {}), 'deepEqual treats null and object as different')
        assert(deepEqual(new Date('2024-01-02T03:04:05.000Z'), new Date('2024-01-02T03:04:05.000Z')), 'deepEqual compares Date time values')
        assert(!deepEqual(new Date('2024-01-02T03:04:05.000Z'), new Date('2024-01-02T03:04:06.000Z')), 'deepEqual rejects different Date time values')
        assert(deepEqual(new Map([['a', { n: 1 }]]), new Map([['a', { n: 1 }]])), 'deepEqual compares Map values structurally')
        assert(deepEqual(new Map([['a', 1]]), new Map([['a', '1']])),
            'deepEqual preserves historical loose primitive comparison for Map values')
        assert(!deepEqual(new Map([['a', { n: 1 }]]), new Map([['a', { n: 2 }]])), 'deepEqual rejects different Map values')
        assert(deepEqual(new Set(['a', 'b']), new Set(['b', 'a'])), 'deepEqual compares Set membership')
        assert(!deepEqual(new Set(['a', 'b']), new Set(['a', 'c'])), 'deepEqual rejects different Set membership')
        assert(deepEqual(/quote/gi, /quote/gi), 'deepEqual compares RegExp source and flags')
        assert(!deepEqual(/quote/g, /other/g), 'deepEqual rejects different RegExp source')
        assert(deepEqual(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer),
            'deepEqual compares ArrayBuffer bytes')
        assert(!deepEqual(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 3]).buffer),
            'deepEqual rejects different ArrayBuffer bytes')
        assert(!deepEqual(new DataView(new Uint8Array([1]).buffer), new DataView(new Uint8Array([2]).buffer)),
            'deepEqual compares DataView bytes')
        const cycleA: any = {value: 1}
        const cycleB: any = {value: 1}
        cycleA.self = cycleA
        cycleB.self = cycleB
        assert(deepEqual(cycleA, cycleB), 'deepEqual handles equivalent cyclic graphs')
        const twoCycleA: any = {value: 1}
        const twoCycleB: any = {value: 1}
        twoCycleA.self = twoCycleB
        twoCycleB.self = twoCycleA
        assert(!deepEqual(cycleA, twoCycleA), 'deepEqual rejects different cyclic graph topology')
        const shared = {value: 1}
        assert(deepEqual({a: shared, b: shared}, {a: {value: 1}, b: {value: 1}}),
            'deepEqual keeps historical sharing-insensitive plain DAG comparison')
    }

    // StructMap/StructSet: missing composite lookup over null/primitive leaves stays safe.
    {
        const map = new StructMap<readonly number[], null>()
        map.set([1], null)

        const set = new StructSet<readonly number[]>()
        set.add([1])

        assert(map.has([1]), 'StructMap.has finds a null leaf value')
        assert(!map.has([1, 2]), 'StructMap.has returns false when a null leaf is used as a prefix')
        assert(set.has([1]), 'StructSet.has finds an entry stored as a null value')
        assert(!set.has([1, 2]), 'StructSet.has returns false when its null value is used as a prefix')
    }

    // MapExt: clear invalidates valuesArrayImmutable cache.
    {
        const map = new MapExt<string, number>([['a', 1], ['b', 2]])
        const before = map.valuesArrayImmutable()
        map.clear()
        map.set('c', 3)
        const after = map.valuesArrayImmutable()

        assert(before !== after, 'MapExt.clear invalidates valuesArrayImmutable cache')
        assert(after.length === 1 && after[0] === 3, 'MapExt valuesArrayImmutable reflects entries after clear')
    }

    // JSON.stringify patch: array replacer keeps native allow-list semantics.
    {
        const text = JSON.stringify({ a: 1, b: 2, nested: { a: 3, b: 4 } }, ['a', 'nested'])
        assert(text === '{"a":1,"nested":{"a":3}}', 'JSON.stringify supports array replacer allow-list')
    }

    // CancelablePromise: nested cancel can cascade through the onCancel hook.
    {
        let innerCancelled = false
        const inner = new CancelablePromise<string>(() => {}, () => { innerCancelled = true })
        const outer = new CancelablePromise<string>((resolve) => resolve(inner), () => inner.cancel('inner-cancelled'))

        const rejection = assertRejects(outer, 'inner-cancelled', 'CancelablePromise nested cancel rejects the outer promise through the inner promise')
        outer.cancel('outer-cancelled')
        await rejection
        await assertRejects(inner, 'inner-cancelled', 'CancelablePromise nested cancel rejects the inner promise')
        assert(innerCancelled, 'CancelablePromise nested cancel runs the inner onCancel hook')
    }

    console.log(`\n${fails === 0 ? 'ALL GREEN' : fails + ' FAILURE(S)'}`)
    process.exit(fails === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
