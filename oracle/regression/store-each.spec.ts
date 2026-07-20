// Oracle: store.each() (per-changed-key listen) + syncStoreReplayEach (one-call remote fold).
// Prompt: doc/target/wenay-common2-store-ergonomics-prompt.md. Disposable oracle, ts-node --transpile-only.

import {createStore} from '../../src/Common/Observe/store'
import {flushReactive} from '../../src/Common/Observe/reactive'
import {exposeStoreReplay, syncStoreReplayEach} from '../../src/Common/Observe/store-replay'

let failures = 0
const tests: Array<{name: string; run: () => void | Promise<void>}> = []

function test(name: string, run: () => void | Promise<void>) {
    tests.push({name, run})
}

function assert(cond: unknown, message: string) {
    if (!cond) throw new Error(message)
}

function assertDeepEq(actual: unknown, expected: unknown, message: string) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`)
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

type tCall = [string, any]
function collect(calls: tCall[]) {
    return function onEachKey(key: string, value: any) {
        calls.push([key, value === undefined ? undefined : JSON.parse(JSON.stringify(value))])
    }
}

// ============================================================
//  each()
// ============================================================

test('each: N keys written in one window -> N calls with fresh values', async () => {
    const store = createStore<Record<string, {hp: number}>>({}, {drain: 'micro'})
    const calls: tCall[] = []
    const off = store.each().on(collect(calls))
    store.state.a = {hp: 1}
    store.state.b = {hp: 2}
    store.state.c = {hp: 3}
    await flushReactive(store.state); await tick()
    off()
    calls.sort()
    assertDeepEq(calls, [['a', {hp: 1}], ['b', {hp: 2}], ['c', {hp: 3}]], 'one call per changed key')
})

test('each: two writes to one key in a window -> ONE call with the last value', async () => {
    const store = createStore<Record<string, number>>({}, {drain: 'micro'})
    const calls: tCall[] = []
    const off = store.each().on(collect(calls))
    store.state.x = 1
    store.state.x = 2
    await flushReactive(store.state); await tick()
    off()
    assertDeepEq(calls, [['x', 2]], 'coalesced to the last value')
})

test('each: deleted key -> (key, undefined)', async () => {
    const store = createStore<Record<string, number>>({x: 1, y: 2}, {drain: 'micro'})
    const calls: tCall[] = []
    const off = store.each().on(collect(calls))
    delete store.state.x
    await flushReactive(store.state); await tick()
    off()
    assertDeepEq(calls, [['x', undefined]], 'delete reports undefined')
})

test('each: deeper dirt reports the top-level key once (coalesced)', async () => {
    const store = createStore<any>({a: {b: {c: 1}, d: 1}}, {drain: 'micro'})
    const calls: tCall[] = []
    const off = store.each().on(collect(calls))
    store.state.a.b.c = 2
    store.state.a.d = 5
    await flushReactive(store.state); await tick()
    off()
    assertDeepEq(calls, [['a', {b: {c: 2}, d: 5}]], 'one call for the top key with the whole branch')
})

test('each: root replace expands per key of the new state + undefined for gone keys', async () => {
    const store = createStore<Record<string, {v: number}>>({a: {v: 1}, b: {v: 2}}, {drain: 'micro'})
    const calls: tCall[] = []
    const off = store.each().on(collect(calls))
    store.replace({b: {v: 20}, c: {v: 30}})
    await flushReactive(store.state); await tick()
    off()
    calls.sort()
    assertDeepEq(calls, [['a', undefined], ['b', {v: 20}], ['c', {v: 30}]],
        'replace = per-key calls for the new state + (key, undefined) for removed keys')
})

test('each: cold store -> zero cost (no listenPaths subscription until first listener)', () => {
    const store = createStore<Record<string, number>>({x: 1})
    const each = store.each()
    assert(!each.isRunning(), 'no upstream subscription before the first listener')
    const off = each.on(() => {})
    assert(each.isRunning(), 'upstream subscription appears with the first listener')
    off()
    assert(!each.isRunning(), 'upstream subscription is torn down with the last listener')
})

test('each: depth is reserved — only 1 accepted', () => {
    const store = createStore<Record<string, number>>({})
    store.each({depth: 1})
    let threw = false
    try { store.each({depth: 2}) } catch { threw = true }
    assert(threw, 'depth != 1 must throw (reserved)')
})

// ============================================================
//  syncStoreReplayEach (in-proc replay wire)
// ============================================================

test('syncStoreReplayEach: keyframe start expands per key; live per-key; delete -> undefined', async () => {
    const world = createStore<Record<string, {hp: number}>>({a: {hp: 100}, b: {hp: 50}}, {drain: 'micro'})
    const exposed = exposeStoreReplay(world, {history: 64})
    const calls: tCall[] = []
    const sub = syncStoreReplayEach<Record<string, {hp: number}>>(exposed.api.replay, collect(calls), {drain: 'micro'})
    await sub.ready
    await tick()
    const cold = [...calls].sort()
    assertDeepEq(cold, [['a', {hp: 100}], ['b', {hp: 50}]], 'keyframe expands per key')

    calls.length = 0
    world.state.a = {hp: 42}
    await flushReactive(world.state); await tick(); await tick()
    assertDeepEq(calls, [['a', {hp: 42}]], 'live delta arrives per key')

    calls.length = 0
    delete world.state.b
    await flushReactive(world.state); await tick(); await tick()
    assertDeepEq(calls, [['b', undefined]], 'remote delete reports undefined')

    assert(sub.store.state.a.hp == 42, 'mirror store readable directly via off.store')
    assert(sub.seq() >= 0, 'seq() reports the reconnect point')
    sub()
    exposed.close()
})

test('syncStoreReplayEach: reconnect with {since} delivers only changed keys', async () => {
    const world = createStore<Record<string, {hp: number}>>({a: {hp: 1}, b: {hp: 2}}, {drain: 'micro'})
    const exposed = exposeStoreReplay(world, {history: 64})
    let lastSeq = -1
    const first = syncStoreReplayEach<Record<string, {hp: number}>>(exposed.api.replay, () => {},
        {drain: 'micro', onSeq: s => lastSeq = s})
    await first.ready; await tick()
    first()

    // world lives while client is offline — reconnect must arrive via TAIL (only b)
    world.state.b = {hp: 22}
    await flushReactive(world.state); await tick()

    const calls: tCall[] = []
    // reconnect = previous state (initial) + {since}: tail arrives over it
    const second = syncStoreReplayEach<Record<string, {hp: number}>>(exposed.api.replay, collect(calls),
        {drain: 'micro', since: lastSeq, initial: first.store.snapshot()})
    await second.ready
    await tick()
    assertDeepEq(calls, [['b', {hp: 22}]], 'tail reconnect delivers only the changed key')
    assertDeepEq(second.store.snapshot(), world.snapshot(), 'mirror converged')
    second()
    exposed.close()
})

test('syncStoreReplayEach: off() tears down BOTH the store subscription and the wire sub', async () => {
    const world = createStore<Record<string, number>>({x: 1}, {drain: 'micro'})
    const exposed = exposeStoreReplay(world, {history: 64})
    const lineCount = () => exposed.replay.line.count()
    const before = lineCount()
    const calls: tCall[] = []
    const sub = syncStoreReplayEach<Record<string, number>>(exposed.api.replay, collect(calls), {drain: 'micro'})
    await sub.ready; await tick()
    assert(lineCount() > before, 'wire sub is live while subscribed')
    calls.length = 0
    sub()
    assert(lineCount() == before, 'wire sub removed by off()')
    assert(sub.store.count() == 0, 'no store subscriptions left after off()')
    world.state.x = 99
    await flushReactive(world.state); await tick(); await tick()
    assertDeepEq(calls, [], 'no calls after off()')
    exposed.close()
})

// ============================================================
//  runner
// ============================================================

async function main() {
    for (const t of tests) {
        try {
            await t.run()
            console.log(`OK ${t.name}`)
        } catch (e: any) {
            failures++
            console.error(`FAIL ${t.name}`)
            console.error(e?.stack ?? e)
        }
    }
    console.log(failures === 0 ? `ALL GREEN (${tests.length})` : `${failures} FAILURE(S) / ${tests.length}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => {
    console.error(e?.stack ?? e)
    process.exit(1)
})
