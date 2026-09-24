// =====================================================================
//  A followed Replicated Map must not pay per subscriber or per proxy for its key feed.
//
//  Fan-out: onKey(key) subscribed to the all-keys stream with a filter, so every changed
//  key visited every onKey subscriber. A full update of 10,000 keys with one onKey per
//  key made 100 million filter calls. Memory: the follower's changed-key feed was the
//  public store.each(), which reads each changed key through the reactive proxy; a
//  follower with no key consumers still grew one reactive node per mirrored entry.
//
//  Bounds are relative, so a slow machine moves both sides: 10,000 per-key subscribers
//  against one all-keys subscriber (the same deliveries), and the follower's heap per
//  entry against a plain Store holding the same rows. Equivalence: every onKey stream
//  equals the all-keys stream filtered to its key, through keyframe resets, coalesced
//  writes and deletes; duplicate registrations, idempotent off(), isolated consumer
//  errors, {current: true}, registration after ready and close() behave as before.
//  Runs under --expose-gc (self-respawns if needed).
// =====================================================================
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
import type {FollowedReplicatedMap} from '../../src/Common/Observe/replicated-map'

if (typeof (globalThis as {gc?: unknown}).gc != 'function') {
    const res = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', __filename], {stdio: 'inherit'})
    process.exit(res.status ?? 1)
}

// dynamic import so the respawn path above pays nothing before it has --expose-gc
async function load() {
    const map = await import('../../src/Common/Observe/replicated-map')
    const store = await import('../../src/Common/Observe/store')
    const reactive = await import('../../src/Common/Observe/reactive')
    return {...map, ...store, ...reactive}
}

type tObserve = Awaited<ReturnType<typeof load>>
type tRow = {id: string, n: number}
type tFollower = FollowedReplicatedMap<tRow>

const FANOUT_KEYS = 10_000
const HEAP_KEYS = 50_000

function heap() {
    const gc = (globalThis as unknown as {gc: () => void}).gc
    for (let i = 0; i < 4; i++) gc()
    return process.memoryUsage().heapUsed
}

function catchAsyncErrors() {
    const errors: unknown[] = []
    function collect(error: unknown) { errors.push(error) }
    process.on('uncaughtException', collect)
    return {errors, stop: () => process.off('uncaughtException', collect)}
}

// ============================================================
//  cost: per-key subscribers against one all-keys subscriber
// ============================================================

async function fullUpdateMs(O: tObserve, subscribe: (follower: tFollower, delivered: () => void) => void) {
    const rows: tRow[] = Array.from({length: FANOUT_KEYS}, (_, i) => ({id: 'k' + i, n: i}))
    const producer = O.createReplicatedMap<tRow>({keyOf: row => row.id, delivery: 'latest', initial: rows})
    const follower = O.followReplicatedMap<tRow>(producer.api)
    await follower.ready
    await settle(O, follower)
    let delivered = 0
    subscribe(follower, () => { delivered++ })
    let best = Infinity
    for (let round = 1; round <= 3; round++) {
        delivered = 0
        const t0 = performance.now()
        producer.control.setMany(rows.map(row => ({id: row.id, n: row.n + round * 1e6})))
        await settle(O, follower)
        best = Math.min(best, performance.now() - t0)
        assert.equal(delivered, FANOUT_KEYS, 'every changed key reaches its subscriber once')
    }
    follower.close()
    producer.control.close()
    return best
}

async function settle(O: tObserve, follower: tFollower) {
    await O.flushReactive(follower.debug.store.state)
    await new Promise(function nextTurn(resolve) { setImmediate(resolve) })
}

async function perKeySubscribersCostOneStream(O: tObserve) {
    const keysMs = await fullUpdateMs(O, function allKeys(follower, delivered) {
        follower.keys.on(function everyKey() { delivered() })
    })
    const onKeyMs = await fullUpdateMs(O, function perKey(follower, delivered) {
        for (let i = 0; i < FANOUT_KEYS; i++) follower.onKey('k' + i, function oneKey() { delivered() })
    })
    const budget = 3 * keysMs + 100
    const detail = `full update of ${FANOUT_KEYS} keys: ${FANOUT_KEYS} onKey subscribers ${onKeyMs.toFixed(0)} ms,`
        + ` one keys.on subscriber ${keysMs.toFixed(0)} ms (budget ${budget.toFixed(0)} ms)`
    assert.ok(onKeyMs <= budget, detail)
    console.log('      ' + detail)
}

// ============================================================
//  memory: a follower without key consumers
// ============================================================

async function followerHeapStaysNearData(O: tObserve) {
    const rows = Array.from({length: HEAP_KEYS}, (_, i) => ({id: 'k' + i, n: i}))
    const producer = O.createReplicatedMap<tRow>({keyOf: row => row.id, delivery: 'latest', initial: rows})
    const h0 = heap()
    const follower = O.followReplicatedMap<tRow>(producer.api)
    await follower.ready
    await settle(O, follower)
    const h1 = heap()
    const plain = O.createStore(follower.snapshot())
    const h2 = heap()
    const followerBytes = (h1 - h0) / HEAP_KEYS
    const plainBytes = (h2 - h1) / HEAP_KEYS
    const detail = `follower over ${HEAP_KEYS} entries without key consumers: ${followerBytes.toFixed(0)} B/entry;`
        + ` a plain Store with the same rows: ${plainBytes.toFixed(0)} B/entry (budget 4x)`
    assert.equal(Object.keys(plain.state).length, HEAP_KEYS)
    follower.close()
    producer.control.close()
    assert.ok(followerBytes <= 4 * plainBytes, detail)
    console.log('      ' + detail)
}

// ============================================================
//  equivalence: onKey streams are the all-keys stream per key
// ============================================================

async function onKeyEqualsFilteredKeys(O: tObserve) {
    const producer = O.createReplicatedMap<tRow>({
        keyOf: row => row.id, delivery: 'latest', initial: [{id: 'A', n: 0}, {id: 'B', n: 0}],
    })
    // Z exists only locally: the first keyframe deletes it through the root replace.
    const follower = O.followReplicatedMap<tRow>(producer.api, {initial: {Z: {id: 'Z', n: -1}}})
    const all: string[] = []
    const perKey: Record<string, string[]> = {A: [], B: [], C: [], Z: []}
    const entry = (value: tRow | undefined, ctx: {key: string, exists: boolean}) => JSON.stringify([ctx.key, value ?? null, ctx.exists])
    follower.keys.on(function everyKey(_key, value, ctx) { all.push(entry(value, ctx)) })
    for (const key of Object.keys(perKey)) {
        follower.onKey(key, function oneKey(value, ctx) { perKey[key]!.push(entry(value, ctx)) })
    }
    const twice: number[] = []
    function repeated(value: tRow | undefined) { twice.push(value?.n ?? -99) }
    const offFirst = follower.onKey('A', repeated)
    follower.onKey('A', repeated)
    const async = catchAsyncErrors()
    const offBoom = follower.onKey('B', function boom() { throw new Error('boom') })
    const afterBoom: number[] = []
    follower.onKey('B', function besideBoom(value) { afterBoom.push(value?.n ?? -99) })

    await follower.ready
    await settle(O, follower)
    producer.control.setMany([{id: 'A', n: 1}, {id: 'A', n: 2}, {id: 'C', n: 1}])
    producer.control.set({id: 'B', n: 5})
    await settle(O, follower)
    producer.control.delete('B')
    await settle(O, follower)
    offFirst()
    offFirst()
    offBoom()
    producer.control.replaceAll([{id: 'A', n: 3}, {id: 'B', n: 6}])
    await settle(O, follower)
    await new Promise(function afterRethrow(resolve) { setTimeout(resolve, 5) })
    async.stop()

    for (const [key, log] of Object.entries(perKey)) {
        const filtered = all.filter(line => JSON.parse(line)[0] == key)
        assert.ok(log.length > 0, key + ' saw changes')
        assert.deepEqual(log, filtered, 'onKey(' + key + ') equals the keys stream filtered to it')
    }
    assert.deepEqual(perKey['Z'], [JSON.stringify(['Z', null, false])], 'the keyframe root replace deletes a local-only key')
    assert.deepEqual(twice, [0, 0, 2, 2, 3], 'a callback registered twice runs twice; one off() removes one registration')
    assert.deepEqual(afterBoom, [0, 5, -99, 6], 'a throwing sibling does not stop the others')
    assert.equal(async.errors.length, 3, 'each throw is reported asynchronously')

    const current: string[] = []
    const offCurrent = follower.onKey('A', function now(value, ctx) { current.push(entry(value, ctx)) }, {current: true})
    assert.deepEqual(current, [JSON.stringify(['A', {id: 'A', n: 3}, true])], '{current: true} delivers synchronously')
    offCurrent()
    follower.close()
    assert.throws(() => follower.onKey('A', () => {}), /closed/)
    producer.control.close()
}

async function registrationAfterReadySeesPendingKeyframe(O: tObserve) {
    const producer = O.createReplicatedMap<tRow>({keyOf: row => row.id, delivery: 'latest', initial: [{id: 'A', n: 1}]})
    const follower = O.followReplicatedMap<tRow>(producer.api)
    await follower.ready
    // The keyframe is applied, its drain is still pending: consumers registered now see it.
    const onKeySeen: unknown[] = []
    const keysSeen: unknown[] = []
    follower.onKey('A', function seeA(value) { onKeySeen.push(value) })
    follower.keys.on(function seeKey(key, value) { keysSeen.push([key, value]) })
    await settle(O, follower)
    assert.deepEqual(onKeySeen, [{id: 'A', n: 1}])
    assert.deepEqual(keysSeen, [['A', {id: 'A', n: 1}]])

    const late: unknown[] = []
    follower.onKey('A', function afterDrain(value) { late.push(value) })
    await settle(O, follower)
    assert.deepEqual(late, [], 'a consumer registered after the drain gets no historical notification')
    follower.close()
    producer.control.close()
}

async function publicEachStaysLive(O: tObserve) {
    const store = O.createStore<Record<string, {n: number}>>({a: {n: 1}}, {drain: 'micro'})
    const seen: boolean[] = []
    const off = store.each().on(function key(_key, value) { seen.push(O.isReactive(value)) })
    store.state['a'] = {n: 2}
    store.state['b'] = {n: 3}
    await O.flushReactive(store.state)
    off()
    assert.deepEqual(seen, [true, true], 'store.each() still emits live proxies')
}

async function main() {
    const O = await load()
    const checks = [
        onKeyEqualsFilteredKeys, registrationAfterReadySeesPendingKeyframe, publicEachStaysLive,
        followerHeapStaysNearData, perKeySubscribersCostOneStream,
    ]
    for (const check of checks) {
        try { await check(O); console.log('PASS ' + check.name) }
        catch (error) { console.error('FAIL ' + check.name, error); process.exitCode = 1 }
    }
}

main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
