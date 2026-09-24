// =====================================================================
//  A leaf subscription follows its path when an ancestor is detached and
//  recreated inside one drain window while the leaf value stays the same.
//
//  A path subscription watches the deepest reactive ancestor of its path. `delete`,
//  and a define of a non-object (node.replace(null), patch application), detach that
//  ancestor; recreating it in the same window creates a NEW reactive node. The drain
//  then found the leaf unchanged and returned before re-attaching, so the subscription
//  stayed on the detached node and never fired again. A resumed replay mirror hits the
//  same window when its tail carries [delete order] and [recreate order] together.
// =====================================================================
import assert from 'node:assert/strict'
import {
    createStore, flushReactive, applyStorePatches, exposeStoreReplay, syncStoreReplay,
} from '../../src/Common/Observe'
import {runOracle} from '../run-oracle'

type tOrder = {status: string, qty: number, fill?: {price: number}}
type tState = {order?: tOrder}
type tStateStore = ReturnType<typeof createStore<tState>>

async function settle(state: object) {
    await flushReactive(state)
    await new Promise(function nextTurn(resolve) { setImmediate(resolve) })
}

/** Subscribes order.status, runs one same-window recreate, then a real change. */
async function statusSeenAfter(recreate: (store: tStateStore) => void) {
    const store = createStore<tState>({order: {status: 'open', qty: 1}})
    const seen: string[] = []
    const off = store.node.order.status.on(function statusChanged(status) { seen.push(status) })
    try {
        recreate(store)
        await settle(store.state)
        store.state.order!.status = 'filled'
        await settle(store.state)
        assert.deepEqual(store.snapshot().order, {status: 'filled', qty: 2})
        return seen
    } finally { off() }
}

// ============================================================
//  local Store
// ============================================================

async function controlReassignment() {
    const seen = await statusSeenAfter(function reassign(store) {
        store.state.order = {status: 'open', qty: 2}
    })
    assert.deepEqual(seen, ['filled'], 'a plain reassignment keeps the leaf subscription live')
}

async function deleteAndRecreate() {
    const seen = await statusSeenAfter(function deleteThenCreate(store) {
        delete store.state.order
        store.state.order = {status: 'open', qty: 2}
    })
    assert.deepEqual(seen, ['filled'], 'delete + recreate in one window keeps the leaf subscription live')
}

async function replaceNullAndRecreate() {
    const seen = await statusSeenAfter(function replaceThenCreate(store) {
        store.node.order.replace(null as unknown as tOrder)
        store.node.order.replace({status: 'open', qty: 2})
    })
    assert.deepEqual(seen, ['filled'], 'node.replace(null) + recreate keeps the leaf subscription live')
}

async function missingLeafAfterRecreate() {
    const store = createStore<tState>({order: {status: 'open', qty: 1}})
    const prices: number[] = []
    const off = store.node.order.fill.price.on(function priceChanged(price) { prices.push(price) })
    try {
        delete store.state.order
        store.state.order = {status: 'open', qty: 2}
        await settle(store.state)
        store.state.order!.fill = {price: 5}
        await settle(store.state)
        assert.deepEqual(prices, [5], 'a still-missing leaf keeps waiting on the recreated parent')
    } finally { off() }
}

async function selectionAfterRecreate() {
    const store = createStore<tState>({order: {status: 'open', qty: 1}})
    const seen: unknown[] = []
    const off = store.update({order: {status: true}}).on(function selected(value) { seen.push(value) }, {drain: 'micro'})
    try {
        delete store.state.order
        store.state.order = {status: 'open', qty: 2}
        await settle(store.state)
        seen.length = 0
        store.state.order!.status = 'filled'
        await settle(store.state)
        assert.deepEqual(seen, [{order: {status: 'filled'}}], 'a mask selection keeps delivering after recreate')
    } finally { off() }
}

// ============================================================
//  mirrors
// ============================================================

async function mirrorPatchesOneWindow() {
    const mirror = createStore<tState>({order: {status: 'open', qty: 1}})
    const seen: string[] = []
    const off = mirror.node.order.status.on(function mirrorStatus(status) { seen.push(status) })
    try {
        applyStorePatches(mirror, [{path: ['order'], exists: false, value: undefined}])
        applyStorePatches(mirror, [{path: ['order'], exists: true, value: {status: 'open', qty: 2}}])
        await settle(mirror.state)
        applyStorePatches(mirror, [{path: ['order', 'status'], exists: true, value: 'filled'}])
        await settle(mirror.state)
        assert.equal(mirror.state.order!.status, 'filled')
        assert.deepEqual(seen, ['filled'], 'delete + recreate patches in one window keep the mirror subscription live')
    } finally { off() }
}

async function mirrorResumeTail() {
    const source = createStore<tState>({order: {status: 'open', qty: 1}})
    const exposed = exposeStoreReplay(source, {chunks: false})
    const mirror = createStore<tState>({})
    const first = syncStoreReplay(mirror, exposed.api.replay)
    let resumed: ReturnType<typeof syncStoreReplay<tState>> | undefined
    const seen: string[] = []
    let off = function noSubscription() {}
    try {
        await first.ready
        await settle(mirror.state)
        off = mirror.node.order.status.on(function mirrorStatus(status) { seen.push(status) })
        const saved = first.seq()
        first()

        // Two journal events while the mirror is away; the tail replays them together.
        delete source.state.order
        await settle(source.state)
        source.state.order = {status: 'open', qty: 2}
        await settle(source.state)

        resumed = syncStoreReplay(mirror, exposed.api.replay, {since: saved, catchUp: 'tail'})
        await resumed.ready
        await settle(mirror.state)
        assert.ok(resumed.seq() > saved, 'the mirror resumed through the tail')
        source.state.order!.status = 'filled'
        await settle(source.state)
        await settle(mirror.state)
        assert.deepEqual(mirror.snapshot(), {order: {status: 'filled', qty: 2}})
        assert.deepEqual(seen, ['filled'], 'a mirror resumed across delete + recreate keeps its subscriber')
    } finally {
        off()
        first()
        resumed?.()
        exposed.close()
    }
}

async function main() {
    const checks = [
        controlReassignment, deleteAndRecreate, replaceNullAndRecreate, missingLeafAfterRecreate,
        selectionAfterRecreate, mirrorPatchesOneWindow, mirrorResumeTail,
    ]
    for (const check of checks) {
        try { await check(); console.log('PASS ' + check.name) }
        catch (error) { console.error('FAIL ' + check.name, error); process.exitCode = 1 }
    }
}

runOracle(main)
