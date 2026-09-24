// =====================================================================
//  A follower must not re-read the descriptor and re-ping on every leader write.
//
//  A leader's descriptor changes with every write (headSeq/authoritySeq) and `changed`
//  pushes the new descriptor. The follower ignored that payload: each push re-read
//  descriptor() and sampled ping(), two round trips per follower per leader write.
//  A push that only advances the sequence coordinates carries no new identity, proof,
//  path or cost, so the follower can adopt it; anything else still takes the full read.
//
//  The bound counts round trips, not time. The equivalence runs the same writes through
//  a payload-less legacy `changed`, which always takes the full read, and compares what
//  the follower exposes after every write: state, route and status coordinates, its own
//  descriptor, route events and the host accept() policy, which must still see every
//  advanced descriptor. A fixed clock makes every rtt sample 0 on both paths.
// =====================================================================
import assert from 'node:assert/strict'
import {flushReactive} from '../../src/Common/Observe/reactive'
import {
    createStoreReplicaOffers, createStoreReplicaSet,
    type StoreReplicaDescriptor, type StoreReplicaRouteEvent,
} from '../../src/Common/Observe/store-replica-set'
import {runOracle} from '../run-oracle'

type tState = Record<string, number>
type tPush = 'descriptor' | 'legacy'
type tRewrite = (descriptor: StoreReplicaDescriptor) => StoreReplicaDescriptor

const WRITES = 200
const ROUND_TRIP_BOUND = 2

function fixedClock() { return 1000 }
function unchanged(descriptor: StoreReplicaDescriptor) { return descriptor }

async function settle() {
    for (let i = 0; i < 5; i++) await new Promise(function nextTurn(resolve) { setImmediate(resolve) })
}

/** Leader A and follower B over one in-process route that counts B's round trips to A. */
async function openPair(push: tPush, accept?: (descriptor: StoreReplicaDescriptor) => boolean) {
    const coords = {storeId: 'seq-push', originId: 'seq-push-origin'}
    const leader = createStoreReplicaSet<tState>({...coords, nodeId: 'A', lineId: 'A-line', initial: {}, now: fixedClock})
    const calls = {descriptor: 0, ping: 0}
    let rewrite: tRewrite = unchanged
    const fragment = leader.api.fragment
    const remote = {
        replay: fragment.replay,
        descriptor() {
            calls.descriptor++
            return fragment.descriptor()
        },
        ping() {
            calls.ping++
            return fragment.ping()
        },
        changed: {
            on(cb: (descriptor?: StoreReplicaDescriptor) => void) {
                return fragment.changed.on(function forwardPush(descriptor) {
                    cb(push == 'legacy' ? undefined : rewrite(descriptor))
                })
            },
        },
    }
    const offers = createStoreReplicaOffers<tState>([{id: 'A', connect: () => ({remote, close() {}})}])
    const follower = createStoreReplicaSet<tState>({
        ...coords, nodeId: 'B', lineId: 'B-line', now: fixedClock, offers: offers.api,
        leadership: {initialRole: 'follower', ...(accept ? {accept} : {})},
    })
    const routes: StoreReplicaRouteEvent[] = []
    follower.api.routes.on(function recordRoute(event) { routes.push(event) })
    await follower.api.ready
    await settle()

    async function write(key: string, value: number, pushRewrite: tRewrite = unchanged) {
        rewrite = pushRewrite
        const before = {...calls}
        leader.control.store.state[key] = value
        await flushReactive(leader.control.store.state)
        await settle()
        rewrite = unchanged
        return {descriptor: calls.descriptor - before.descriptor, ping: calls.ping - before.ping}
    }

    /** Everything B exposes about A and itself after a write. */
    function observe() {
        const status = follower.api.status.snapshot()
        return JSON.stringify({state: follower.api.store.snapshot(), status, descriptor: follower.api.descriptor()})
    }

    function close() {
        follower.close()
        leader.close()
    }

    return {leader, follower, calls, routes, write, observe, close}
}

// ============================================================
//  cost and equivalence over the same writes
// ============================================================

async function writeRun(push: tPush) {
    const pair = await openPair(push)
    const opened = {...pair.calls}
    const observed: string[] = []
    for (let i = 0; i < WRITES; i++) {
        await pair.write('k' + (i % 10), i)
        const route = pair.follower.api.status.state.routes['A']!
        assert.deepEqual(pair.follower.api.store.snapshot(), pair.leader.api.store.snapshot(), push + ': state after write ' + i)
        assert.equal(route.authoritySeq, pair.leader.api.descriptor().authoritySeq, push + ': route seq after write ' + i)
        assert.equal(route.state, 'open')
        observed.push(pair.observe())
    }
    const cost = {descriptor: pair.calls.descriptor - opened.descriptor, ping: pair.calls.ping - opened.ping}
    const routes = JSON.stringify(pair.routes)
    pair.close()
    return {opened, cost, observed, routes}
}

async function seqPushSkipsRoundTrips() {
    const legacy = await writeRun('legacy')
    const pushed = await writeRun('descriptor')
    assert.deepEqual(legacy.cost, {descriptor: WRITES, ping: WRITES}, 'every legacy push takes the full read')
    assert.deepEqual(pushed.opened, legacy.opened, 'opening a route still reads the descriptor and pings once')
    const detail = `${WRITES} leader writes cost the follower ${pushed.cost.descriptor} descriptor() and`
        + ` ${pushed.cost.ping} ping() round trips (bound ${ROUND_TRIP_BOUND} each; legacy push: ${legacy.cost.descriptor}/${legacy.cost.ping})`
    assert.ok(pushed.cost.descriptor <= ROUND_TRIP_BOUND && pushed.cost.ping <= ROUND_TRIP_BOUND, detail)
    assert.deepEqual(pushed.observed, legacy.observed, 'the follower exposes the same facts after every write')
    assert.equal(pushed.routes, legacy.routes, 'the same route events')
    console.log('      ' + detail)
}

// ============================================================
//  negative controls: every other push still takes the full read
// ============================================================

async function otherPushesTakeFullRead() {
    const pair = await openPair('descriptor')
    await pair.write('warm', 1)
    const cases: [string, tRewrite][] = [
        ['epoch changed', descriptor => ({...descriptor, epoch: descriptor.epoch + 1})],
        ['proof changed', descriptor => ({...descriptor, proof: 'other'})],
        ['authority path changed', descriptor => ({...descriptor, path: [...descriptor.path, 'X']})],
        ['authoritySeq regressed', descriptor => ({...descriptor, authoritySeq: descriptor.authoritySeq - 2})],
        ['headSeq regressed', descriptor => ({...descriptor, headSeq: descriptor.headSeq - 2})],
    ]
    let value = 0
    for (const [label, rewrite] of cases) {
        const cost = await pair.write('k', ++value, rewrite)
        assert.deepEqual(cost, {descriptor: 1, ping: 1}, label + ': one descriptor read and one ping')
        const route = pair.follower.api.status.state.routes['A']!
        assert.equal(route.state, 'open', label)
        assert.equal(route.epoch, pair.leader.api.descriptor().epoch, label + ': the read descriptor wins over the push')
        assert.equal(route.authoritySeq, pair.leader.api.descriptor().authoritySeq, label)
        assert.deepEqual(pair.follower.api.store.snapshot(), pair.leader.api.store.snapshot(), label)
        assert.deepEqual(await pair.write('k', ++value), {descriptor: 0, ping: 0}, label + ': the next seq push is adopted')
    }
    pair.close()
}

// ============================================================
//  host accept() policy still decides every advanced descriptor
// ============================================================

async function fenceRun(push: tPush) {
    let fenced = false
    let accepts = 0
    const pair = await openPair(push, function fence() {
        accepts++
        return !fenced
    })
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
        await pair.write('k', i)
        seen.push(pair.observe())
    }
    fenced = true
    await pair.write('k', 99)
    seen.push(pair.observe())
    const result = {
        accepts,
        route: pair.follower.api.status.state.routes['A']!.state,
        role: pair.follower.api.status.state.role,
        seen,
        routes: JSON.stringify(pair.routes),
    }
    pair.close()
    return result
}

async function acceptSeesEveryAdvance() {
    const legacy = await fenceRun('legacy')
    const pushed = await fenceRun('descriptor')
    assert.equal(legacy.route, 'rejected', 'a fence closed after five writes rejects the next descriptor')
    assert.equal(pushed.accepts, legacy.accepts, 'accept() sees every advanced descriptor')
    assert.equal(pushed.route, legacy.route)
    assert.equal(pushed.role, legacy.role)
    assert.deepEqual(pushed.seen, legacy.seen)
    assert.equal(pushed.routes, legacy.routes)
}

async function main() {
    const checks = [otherPushesTakeFullRead, acceptSeesEveryAdvance, seqPushSkipsRoundTrips]
    for (const check of checks) {
        try { await check(); console.log('PASS ' + check.name) }
        catch (error) { console.error('FAIL ' + check.name, error); process.exitCode = 1 }
    }
}

runOracle(main)
