// =====================================================================
//  A write must not re-check every cached sibling node entry.
//
//  The Store node cache releases an entry once its path is gone and unsubscribed. After
//  pruning the written path, the pruner re-walked each ancestor with every child of that
//  ancestor. On a flat map whose keys have node entries (store.node.prices[k] read or
//  subscribed) each write therefore cost O(cached siblings): 20,000 writes took seconds
//  with a few thousand keys, against milliseconds without node entries.
//
//  The cost bound is relative to the same writes on a Store without node entries, so a
//  slow machine moves both sides. The checkpoints pin what the cache holds and releases,
//  including entries read on a missing path, which a write to a cached sibling releases;
//  a cheaper walk must not change either, nor what subscribers receive.
// =====================================================================
import assert from 'node:assert/strict'
import {createStore, flushReactive, type StoreCtx} from '../../src/Common/Observe'

type tPrices = {prices: Record<string, number>}

const KEYS = 2000
const WRITES = 20_000

function pricesStore(keys: number) {
    const prices: Record<string, number> = {}
    for (let i = 0; i < keys; i++) prices['S' + i] = i
    return createStore<tPrices>({prices})
}

/** Internal node cache as sorted dotted paths; '' is the root entry. */
function cachedPaths(store: object) {
    const cache = (store as {_nodeCache: Map<string, {path: PropertyKey[]}>})._nodeCache
    return [...cache.values()].map(entry => entry.path.map(String).join('.')).sort()
}

async function settle(state: object) {
    await flushReactive(state)
    await new Promise(function nextTurn(resolve) { setImmediate(resolve) })
}

// ============================================================
//  cost
// ============================================================

/** Timed write loop; stops early once past the budget so a slow pruner fails fast. */
function timeWrites(store: ReturnType<typeof pricesStore>, writes: number, offset: number, budgetMs = Infinity) {
    const t0 = performance.now()
    for (let i = 0; i < writes; i++) {
        store.state.prices['S' + (i % KEYS)] = offset + i
        if ((i & 1023) == 1023 && performance.now() - t0 > budgetMs) {
            return {ms: performance.now() - t0, writes: i + 1}
        }
    }
    return {ms: performance.now() - t0, writes}
}

/** Best of three full runs after a warm-up; a run over budget is returned at once. */
async function bestOf(store: ReturnType<typeof pricesStore>, budgetMs = Infinity) {
    const warm = timeWrites(store, 2048, -WRITES, budgetMs)
    await flushReactive(store.state)
    if (warm.writes < 2048) return warm
    let best = {ms: Infinity, writes: 0}
    for (let round = 1; round <= 3; round++) {
        const run = timeWrites(store, WRITES, round * WRITES, budgetMs)
        await flushReactive(store.state)
        if (run.writes < WRITES) return run
        if (run.ms < best.ms) best = run
    }
    return best
}

async function assertWriteCost(label: string, withEntries: (store: ReturnType<typeof pricesStore>) => void) {
    const plain = await bestOf(pricesStore(KEYS))
    const budgetMs = 300 + 10 * plain.ms
    const store = pricesStore(KEYS)
    withEntries(store)
    const run = await bestOf(store, budgetMs)
    const detail = `${label}: ${run.writes} of ${WRITES} writes in ${run.ms.toFixed(1)} ms with ${KEYS} cached keys`
        + ` (no node entries: ${plain.ms.toFixed(1)} ms; budget ${budgetMs.toFixed(0)} ms)`
    assert.ok(run.writes == WRITES && run.ms <= budgetMs, detail)
    console.log('      ' + detail)
}

async function writesWithReadEntries() {
    await assertWriteCost('read node entries', function readEntries(store) {
        for (let i = 0; i < KEYS; i++) void store.node.prices.at('S' + i)
    })
}

async function writesWithLeafSubscriptions() {
    await assertWriteCost('leaf subscriptions', function subscribeLeaves(store) {
        for (let i = 0; i < KEYS; i++) store.node.prices.at('S' + i).on(function priceChanged() {})
    })
}

// ============================================================
//  equivalence: cache contents and notifications
// ============================================================

const BASE = ['', 'prices', ...Array.from({length: 10}, (_, i) => 'prices.S' + i)].sort()

async function flatMapCheckpoints() {
    const store = pricesStore(10)
    for (let i = 0; i < 10; i++) void store.node.prices.at('S' + i)
    const seen: string[] = []
    const nodes = new Set<unknown>()
    function watch(key: string) {
        const node = store.node.prices.at(key)
        return node.on(function priceChanged(value: number, ctx: StoreCtx<number>) {
            seen.push(key + '=' + value)
            nodes.add(ctx.node == node)
        })
    }
    const offS3 = watch('S3')
    const offS7 = watch('S7')
    assert.deepEqual(cachedPaths(store), BASE, 'every read key is cached')

    for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 10; i++) store.state.prices['S' + i] = 100 * round + i
    }
    await settle(store.state)
    assert.deepEqual(cachedPaths(store), BASE, 'writes to existing keys keep their entries')
    assert.deepEqual(seen.sort(), ['S3=103', 'S7=107'], 'one coalesced notification per written subscribed key')
    assert.deepEqual([...nodes], [true], 'ctx.node is the subscribed node')

    // Read on missing paths: no mutation ever reports them, a cached sibling write releases them.
    void store.node.prices.at('MISSING')
    void store.node.prices.at('S1').at('deep').at('x')
    assert.deepEqual(cachedPaths(store), [...BASE, 'prices.MISSING', 'prices.S1.deep', 'prices.S1.deep.x'].sort())
    store.state.prices['S0'] = 1000
    await settle(store.state)
    assert.deepEqual(cachedPaths(store), BASE, 'a cached sibling write releases entries read on missing paths')

    // A subscribed missing path survives sibling writes and follows its own life cycle.
    const future: number[] = []
    const offFuture = store.node.prices.at('FUTURE').on(function futureChanged(value: number) { future.push(value) })
    store.state.prices['S0'] = 1001
    await settle(store.state)
    assert.deepEqual(cachedPaths(store), [...BASE, 'prices.FUTURE'].sort(), 'a subscription retains its missing path')
    store.state.prices['FUTURE'] = 7
    await settle(store.state)
    assert.deepEqual(future, [7])
    offFuture()
    assert.deepEqual(cachedPaths(store), [...BASE, 'prices.FUTURE'].sort(), 'an existing path stays after off()')
    delete store.state.prices['FUTURE']
    await settle(store.state)
    assert.deepEqual(cachedPaths(store), BASE, 'a deleted unsubscribed path is released')

    // Deleted keys: released at once unless subscribed, then released by the last off().
    seen.length = 0
    delete store.state.prices['S5']
    delete store.state.prices['S7']
    await settle(store.state)
    const withoutS5 = BASE.filter(path => path != 'prices.S5')
    assert.deepEqual(cachedPaths(store), withoutS5, 'the subscribed deleted key keeps its entry')
    assert.deepEqual(seen, ['S7=undefined'])
    offS7()
    assert.deepEqual(cachedPaths(store), withoutS5.filter(path => path != 'prices.S7'), 'the last off() releases it')
    offS3()
}

/** Node by dotted path: `.at` keeps the chain typed on an untyped Store. */
function nodeAt(store: ReturnType<typeof createStore<any>>, dotted: string) {
    let node = store.node
    for (const key of dotted.split('.')) node = node.at(key)
    return node
}

async function nestedCheckpoints() {
    const store = createStore<any>({}, {drain: 'micro'})
    const cached = () => cachedPaths(store)
    for (let i = 0; i < 50; i++) { store.state['o' + i] = {value: i}; store.node.at('o' + i) }
    assert.equal(cached().length, 51)
    for (let i = 0; i < 50; i++) delete store.state['o' + i]
    await flushReactive(store.state)
    assert.deepEqual(cached(), [''], 'deleted dynamic keys leave the cache')

    store.state.a = {b: {c: {d: 1}, e: {f: 2}}, g: [{x: 1}, {x: 2}]}
    const offD = nodeAt(store, 'a.b.c.d').on(function dChanged() {})
    const offE = nodeAt(store, 'a.b.e').on(function eChanged() {})
    void nodeAt(store, 'a.g.1.x')
    const nested = ['', 'a', 'a.b', 'a.b.c', 'a.b.c.d', 'a.b.e', 'a.g', 'a.g.1', 'a.g.1.x']
    assert.deepEqual(cached(), nested)
    store.state.a.b.c.d = 5
    store.state.a.g[1].x = 9
    await flushReactive(store.state)
    assert.deepEqual(cached(), nested, 'nested leaf writes keep entries')
    delete store.state.a.b.e
    await flushReactive(store.state)
    assert.deepEqual(cached(), nested, 'a subscribed deleted branch stays')
    offE()
    assert.deepEqual(cached(), ['', 'a', 'a.b', 'a.b.c', 'a.b.c.d', 'a.g', 'a.g.1', 'a.g.1.x'])
    store.state.a.g.pop()
    await flushReactive(store.state)
    assert.deepEqual(cached(), ['', 'a', 'a.b', 'a.b.c', 'a.b.c.d', 'a.g'], 'a popped element leaves')
    store.state.a.b = 7
    await flushReactive(store.state)
    assert.deepEqual(cached(), ['', 'a', 'a.b', 'a.b.c', 'a.b.c.d', 'a.g'], 'a subscribed leaf keeps its chain')
    offD()
    assert.deepEqual(cached(), ['', 'a', 'a.b', 'a.g'], 'off() releases the missing chain up to an existing ancestor')
    nodeAt(store, 'a').replace({z: {y: 1}})
    void nodeAt(store, 'a.z.y')
    assert.deepEqual(cached(), ['', 'a', 'a.z', 'a.z.y'])
    delete store.state.a
    await flushReactive(store.state)
    assert.deepEqual(cached(), [''])

    void nodeAt(store, 'p.q.r')
    assert.deepEqual(cached(), ['', 'p', 'p.q', 'p.q.r'])
    store.state.p = {q: {s: 1}}
    await flushReactive(store.state)
    assert.deepEqual(cached(), ['', 'p', 'p.q'], 'creating the parent releases the missing leaf')
    void nodeAt(store, 'p.q.t.u')
    void nodeAt(store, 'p.w')
    store.state.p.q.s = 2
    await flushReactive(store.state)
    assert.deepEqual(cached(), ['', 'p', 'p.q', 'p.q.t', 'p.q.t.u', 'p.w'], 'an uncached write releases nothing')
    void nodeAt(store, 'p.q.s')
    store.state.p.q.s = 3
    await flushReactive(store.state)
    assert.deepEqual(cached(), ['', 'p', 'p.q', 'p.q.s', 'p.w'], 'a cached sibling write sweeps only its parent')
}

async function main() {
    const checks = [flatMapCheckpoints, nestedCheckpoints, writesWithReadEntries, writesWithLeafSubscriptions]
    for (const check of checks) {
        try { await check(); console.log('PASS ' + check.name) }
        catch (error) { console.error('FAIL ' + check.name, error); process.exitCode = 1 }
    }
}

main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
