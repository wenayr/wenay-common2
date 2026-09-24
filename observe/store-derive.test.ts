// ============================================================
//  observe/store-derive.test.ts
//
//  The read-policy primitive: deriveStore projects one store into another
//  and emits the DIFFERENCE, so a replay line over the projection carries
//  path-level patches (a follower stays gap-free) and secrets that the
//  projection drops never reach that line. Proven with counted patches on
//  the derived store, a live follower over the exposed line, the `keys`
//  skip, and a negative control (a root-replacing projection line WOULD
//  emit root patches — the primitive does not).
//  Run: npx tsx observe/store-derive.test.ts
// ============================================================

import {applyStorePatches, createStore, listenStorePatches, type StorePatch} from '../src/Common/Observe/store'
import {deriveStore, storeDiffPatches} from '../src/Common/Observe/store-derive'
import {exposeStoreReplay} from '../src/Common/Observe/store-replay'
import {createStoreFollower} from '../src/Common/Observe/store-follower'
import {runOracle} from '../oracle/run-oracle'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
async function waitFor(message: string, check: () => boolean, timeoutMs = 3000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (check()) { ok(true, message); return }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    ok(false, message + ' (timed out)')
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

type Order = {id: string, customer: string, phone: string, state: string, lines: string[]}
type State = {
    accounts: Record<string, {account: string, secret: string, roles: string[]}>
    orders: Record<string, Order>
    counter: number
}

async function runChecks() {
    // ============== the diff, as a pure function ==============
    {
        const a = {orders: {o1: {state: 'placed', lines: ['a', 'b']}, o2: {state: 'ready'}}, n: 1}
        const b = {orders: {o1: {state: 'cooking', lines: ['a', 'b']}, o3: {state: 'placed'}}, n: 1, extra: true}
        const patches = storeDiffPatches(a, b)
        const paths = patches.map(p => p.path.join('.') + (p.exists ? '=' + JSON.stringify(p.value) : ' (removed)')).sort()
        ok(JSON.stringify(paths) == JSON.stringify([
            'extra=true', 'orders.o1.state="cooking"', 'orders.o2 (removed)', 'orders.o3={"state":"placed"}',
        ]), `the diff names exactly the changed leaves: ${paths.join(' | ')}`)
        const arrays = storeDiffPatches({list: [1, 2, 3]}, {list: [1, 3]})
        ok(arrays.length == 1 && arrays[0].path.join('.') == 'list' && JSON.stringify(arrays[0].value) == '[1,3]',
            'an array is replaced whole (order is part of its value)')
        ok(storeDiffPatches(undefined, {x: 1}).length == 1 && storeDiffPatches(undefined, {x: 1})[0].path.length == 0,
            'no previous snapshot = one root replacement')
        ok(storeDiffPatches({x: {y: 1}}, {x: {y: 1}}).length == 0, 'equal snapshots diff to nothing')
    }

    // ============== the derived store: minimal patches, secrets dropped ==============
    const source = createStore<State>({
        accounts: {alice: {account: 'alice', secret: 'hash-1', roles: ['customer']}},
        orders: {
            o1: {id: 'o1', customer: 'alice', phone: '+1', state: 'placed', lines: ['pizza']},
        },
        counter: 0,
    })
    // the kitchen projection: orders without contacts, no accounts at all
    const kitchen = deriveStore(source, function projectKitchen(state) {
        const orders: Record<string, {id: string, state: string, lines: string[]}> = {}
        for (const order of Object.values(state.orders)) {
            if (order.state == 'delivered') continue
            orders[order.id] = {id: order.id, state: order.state, lines: order.lines}
        }
        return {orders}
    }, {keys: ['orders']})
    const derivedPatches: StorePatch[] = []
    listenStorePatches(kitchen.store).on(function record(patches: readonly StorePatch[]) { derivedPatches.push(...patches) })

    ok(JSON.stringify(kitchen.store.snapshot()) == '{"orders":{"o1":{"id":"o1","state":"placed","lines":["pizza"]}}}',
        'the derived store starts as the projection of the initial snapshot')
    ok(!JSON.stringify(kitchen.store.snapshot()).includes('hash-1') && !JSON.stringify(kitchen.store.snapshot()).includes('+1'),
        'secrets and contacts are absent from the projection')

    source.state.orders.o1.state = 'cooking'
    await waitFor('a source change reaches the derived store', () => kitchen.store.state.orders.o1?.state == 'cooking')
    await waitFor('the derived store drained its patch batch', () => derivedPatches.length > 0)
    ok(derivedPatches.length == 1 && derivedPatches[0].path.join('.') == 'orders.o1.state' && derivedPatches[0].value == 'cooking',
        `ONE path-level patch, not a root keyframe (${derivedPatches.map(p => p.path.join('.')).join(',')})`)

    // the keys skip: a batch that touches only `counter` and `accounts` is not recomputed
    const before = kitchen.stats()
    source.state.counter = 5
    source.state.accounts.alice.secret = 'hash-2'
    await tick()
    const after = kitchen.stats()
    ok(after.recomputes == before.recomputes && after.skipped > before.skipped,
        `a batch outside the projection's keys is skipped (recomputes ${before.recomputes}→${after.recomputes}, skipped ${before.skipped}→${after.skipped})`)

    // an add and a remove in one batch
    source.state.orders.o2 = {id: 'o2', customer: 'bob', phone: '+2', state: 'placed', lines: ['salad']}
    delete source.state.orders.o1
    await waitFor('the add + remove batch drained', () => derivedPatches.length >= 3)
    const names = derivedPatches.slice(1).map(p => p.path.join('.') + (p.exists ? '' : '-')).sort()
    ok(JSON.stringify(names) == '["orders.o1-","orders.o2"]', `add + remove land as two path patches (${names.join(',')})`)
    ok(!('o1' in kitchen.store.state.orders) && kitchen.store.state.orders.o2.lines[0] == 'salad', 'the derived state matches')

    // a change the projection FILTERS OUT produces no patch at all
    const countBefore = derivedPatches.length
    source.state.orders.o2.phone = '+3'
    await tick()
    await tick()
    ok(derivedPatches.length == countBefore, 'a change to a dropped field emits nothing on the derived store')

    // ============== the exposed line: a follower stays in sync, gap-free ==============
    const exposed = exposeStoreReplay(kitchen.store, {describe: {view: 'kitchen'}})
    const follower = createStoreFollower<{orders: Record<string, {id: string, state: string, lines: string[]}>}>({remote: exposed.api.replay})
    await follower.ready
    ok(JSON.stringify(follower.store.snapshot()) == JSON.stringify(kitchen.store.snapshot()), 'a follower of the derived line receives the projection')
    const seqAtStart = follower.status.state.seq
    source.state.orders.o2.state = 'ready'
    source.state.orders.o3 = {id: 'o3', customer: 'carol', phone: '+4', state: 'placed', lines: ['soup']}
    await waitFor('the follower sees both changes through the line', () => follower.store.state.orders.o2?.state == 'ready' && follower.store.state.orders.o3?.lines[0] == 'soup')
    ok(follower.status.state.seq > seqAtStart && follower.status.state.upstream == 'live', `the line advanced by seq (${seqAtStart} → ${follower.status.state.seq}), upstream live`)
    ok(!JSON.stringify(follower.store.snapshot()).includes('+4'), 'the phone number never rode the derived line')

    // ============== negative control: a root-replacing projection WOULD send root patches ==============
    {
        const naive = createStore<{orders: Record<string, unknown>}>({orders: {}})
        const rootPatches: StorePatch[] = []
        listenStorePatches(naive).on(function record(patches: readonly StorePatch[]) { rootPatches.push(...patches) })
        // the naive line: project and publish the WHOLE projection as one root patch per change
        applyStorePatches(naive, [{path: [], exists: true, value: {orders: {o9: {state: 'placed'}}}}])
        await tick()
        applyStorePatches(naive, [{path: [], exists: true, value: {orders: {o9: {state: 'ready'}}}}])
        await tick()
        // the Store splits a root replacement into ONE patch per top-level key, each
        // carrying its WHOLE section — coarse, and what the leaf-level diff avoids
        const shapes = rootPatches.map(p => p.path.join('.'))
        ok(rootPatches.length >= 2 && rootPatches.every(p => p.path.length == 1 && p.path[0] == 'orders'),
            `control: publishing the projection whole re-sends the whole section per change (${shapes.join(',')}) — the diff above emits leaves`)
    }

    // ============== close: the derived store stops following ==============
    kitchen.close()
    source.state.orders.o3.state = 'cooking'
    await tick()
    await tick()
    ok(kitchen.store.state.orders.o3.state == 'placed', 'after close the derived store no longer follows the source')

    follower.close()
    exposed.close()
    console.log(fails ? `\nFAIL store-derive: ${fails} check(s)` : '\nPASS store-derive')
    process.exit(fails ? 1 : 0)
}

async function main() {
    await runChecks().catch(function fatal(error) {
        console.error(error)
        process.exit(2)
    })
}

runOracle(main)
