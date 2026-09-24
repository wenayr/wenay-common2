// =====================================================================
//  A drain must not re-read every primitive leaf subscribed under a written parent.
//
//  A subscription on a primitive leaf watches its nearest object ancestor, so a write
//  to one key woke every leaf subscribed under the same parent, and each of them walked
//  its path twice through the proxy to find it unchanged: 10,000 leaves under one
//  parent cost about 30 ms per drain for one changed key. A leaf of plain data changes
//  only when its own path or a prefix of it is written; the Store stamps those writes,
//  so an unstamped leaf skips the walk. The subscriptions, and therefore the callback
//  order, stay exactly where they were.
//
//  The bound counts reads of the parent's own properties through a transparent Proxy
//  standing in as the raw parent object, not time. The equivalence is an ordered log
//  (not a multiset) recorded from the Store before this change: interleaved leaf,
//  object, raw-listen and root subscribers on one parent, writes and a nested synchronous
//  flush from inside a drain, numeric array keys, detach-and-recreate, deep missing
//  chains, opaque values and own accessors, which compute a leaf without a write to it.
// =====================================================================
import assert from 'node:assert/strict'
import {createStore} from '../../src/Common/Observe/store'
import {flushReactive, flushReactiveNow} from '../../src/Common/Observe/reactive'
import {runOracle} from '../run-oracle'

const SIBLINGS = 2000
const DRAINS = 50

// ============================================================
//  cost: path reads per drain
// ============================================================

async function drainReadsOnlyTheWrittenLeaf() {
    const plain: Record<string, number> = {}
    for (let i = 0; i < SIBLINGS; i++) plain['S' + i] = i
    let reads = 0
    const parent = new Proxy(plain, {
        getOwnPropertyDescriptor(target, key) {
            reads++
            return Reflect.getOwnPropertyDescriptor(target, key)
        },
    })
    const store = createStore<{prices: Record<string, number>}>({prices: parent}, {drain: 'micro'})
    const seen: string[] = []
    for (let i = 0; i < SIBLINGS; i++) {
        const key = 'S' + i
        store.node.prices.at(key).on(function leaf(value: number) { seen.push(key + '=' + value) })
    }
    reads = 0
    for (let w = 0; w < DRAINS; w++) {
        store.state.prices['S' + (w * 37 % SIBLINGS)] = -1 - w
        await flushReactive(store.state)
    }
    const perDrain = reads / DRAINS
    const detail = `${SIBLINGS} leaf subscriptions under one parent: ${perDrain.toFixed(1)} parent property reads`
        + ` per drain with one written key (bound 20)`
    assert.deepEqual(seen, Array.from({length: DRAINS}, (_, w) => 'S' + (w * 37 % SIBLINGS) + '=' + (-1 - w)),
        'exactly the written leaf is delivered, once, with its value')
    assert.ok(perDrain <= 20, detail)
    console.log('      ' + detail)
}

// ============================================================
//  equivalence: ordered notifications, recorded before the change
// ============================================================

function tag(value: unknown) {
    if (value instanceof Date) return 'date:' + value.getTime()
    if (value != null && typeof value == 'object') return Array.isArray(value) ? 'arr' : 'obj'
    return String(value)
}

async function orderedLog() {
    const log: string[] = []
    const store = createStore<any>({
        quotes: {A: 1, B: 1, C: 1, D: 1},
        rows: [{id: 0}, {id: 1}, {id: 2}],
        deep: {x: {y: {z: 1}}},
        when: new Date(1000),
        a: 1, b: 2,
        get sum() { return this.a + this.b },
        flip: 1,
    }, {drain: 'micro'})
    async function flush(label: string) {
        await flushReactive(store.state)
        await flushReactive(store.state)
        log.push('--- ' + label)
    }
    const offs: (() => void)[] = []
    function on(label: string, subject: any) {
        offs.push(subject.on(function record(value: unknown, ctx: {exists: boolean}) {
            log.push(label + '=' + tag(value) + (ctx.exists ? '' : ' (absent)'))
        }))
    }
    // An untyped Store's node facade is typed StoreNode<any>, which has no named children.
    const node: any = store.node
    offs.push(node.quotes.A.on(function quoteA(value: number) {
        log.push('A=' + value)
        if (value == 2) store.state.quotes.B = 20
    }))
    on('quotes', node.quotes)
    on('B', node.quotes.B)
    offs.push(store.listen().on(function rawRoot() { log.push('listen') }))
    offs.push(node.quotes.C.on(function quoteC(value: number) {
        log.push('C=' + value)
        if (value == 3) {
            store.state.quotes.D = 30
            flushReactiveNow(store.state)
        }
    }))
    on('D', node.quotes.D)
    on('rows.1.id', node.rows.at(1).at('id'))
    on('rows.1', node.rows.at(1))
    on('z', node.deep.x.y.z)
    on('ghost', node.ghost.a.b)
    on('when', node.when)
    on('sum', node.sum)
    on('flip', node.flip)
    offs.push(store.on(function root() { log.push('root') }))

    store.state.quotes.A = 2; await flush('A writes B inside the drain')
    store.state.quotes.C = 3; await flush('C flushes D synchronously inside the drain')
    store.state.quotes.C = 4; store.state.quotes.A = 5; await flush('two siblings')
    store.state.rows[1].id = 10; await flush('numeric array key')
    store.state.rows.splice(0, 1); await flush('array shift')
    delete store.state.deep.x; store.state.deep.x = {y: {z: 1}}; await flush('detach and recreate an equal leaf')
    store.state.deep.x.y.z = 2; await flush('leaf after recreate')
    store.state.ghost = {a: {b: 1}}; await flush('missing chain appears')
    store.state.when = new Date(1000); await flush('equal time, new Date')
    store.state.a = 10; await flush('accessor input written')
    store.state.flip = {x: 1}; await flush('leaf becomes object')
    store.state.flip.x = 2; await flush('inside the object')
    store.state.flip = 3; await flush('object becomes leaf')
    store.state.quotes.B = 2; await flush('leaf after the transitions')
    for (const off of offs) off()
    return log
}

// Recorded from the Store before this change (one drain window per line).
const EXPECTED = [
    'A=2', 'quotes=obj', 'B=20', 'listen', 'root', 'quotes=obj', 'listen', 'root', '--- A writes B inside the drain',
    'quotes=obj', 'C=3', 'quotes=obj', 'D=30', 'listen', 'root', 'listen', 'root', '--- C flushes D synchronously inside the drain',
    'A=5', 'quotes=obj', 'C=4', 'listen', 'root', '--- two siblings',
    'rows.1.id=10', 'rows.1=obj', 'listen', 'root', '--- numeric array key',
    'listen', 'root', 'rows.1.id=2', 'rows.1=obj', '--- array shift',
    'listen', 'root', '--- detach and recreate an equal leaf',
    'z=2', 'listen', 'root', '--- leaf after recreate',
    'listen', 'ghost=1', 'root', '--- missing chain appears',
    'listen', 'when=date:1000', 'root', '--- equal time, new Date',
    'listen', 'sum=12', 'root', '--- accessor input written',
    'listen', 'flip=obj', 'root', '--- leaf becomes object',
    'flip=obj', 'listen', 'root', '--- inside the object',
    'flip=3', 'listen', 'root', '--- object becomes leaf',
    'quotes=obj', 'B=2', 'listen', 'root', '--- leaf after the transitions',
]

async function notificationsKeepTheirOrder() {
    const log = await orderedLog()
    if (process.argv.includes('--print')) console.log(JSON.stringify(log, null, 4))
    assert.deepEqual(log, EXPECTED)
}

async function main() {
    const checks = [notificationsKeepTheirOrder, drainReadsOnlyTheWrittenLeaf]
    for (const check of checks) {
        try { await check(); console.log('PASS ' + check.name) }
        catch (error) { console.error('FAIL ' + check.name, error); process.exitCode = 1 }
    }
}

runOracle(main)
