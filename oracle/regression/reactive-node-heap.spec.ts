// =====================================================================
//  A reactive node must not cost more than a few hundred bytes.
//
//  Every branch read through a Store proxy leaves one engine node behind for as long as its slot
//  lives. A node that allocates its own ProxyHandler (eight closures and their context), two Sets
//  and a Map up front, a `{}` dummy and a path array (whose spread leaves a 17-slot backing store)
//  costs 1,765 B per key on a flat 100,000-key map, against ~190 B for the state a node needs: the
//  node record, a 3-word dummy, the JSProxy and its share of the parent's kids Map.
//
//  The bound is absolute: V8 object layout is deterministic for a Node version and drifts by
//  tens of bytes between versions, so 2x the slim engine's cost is a wide margin. Runs under
//  --expose-gc (self-respawns if needed, as store-replicated-map-keys.spec.ts does).
// =====================================================================
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
import {runOracle} from '../run-oracle'

if (typeof (globalThis as {gc?: unknown}).gc != 'function') {
    const res = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', __filename], {stdio: 'inherit'})
    process.exit(res.status ?? 1)
}

// dynamic import so the respawn path above pays nothing before it has --expose-gc
async function load() {
    const store = await import('../../src/Common/Observe/store')
    const reactive = await import('../../src/Common/Observe/reactive')
    return {...store, ...reactive}
}

type tObserve = Awaited<ReturnType<typeof load>>

const KEYS = 100_000
const BYTES_PER_NODE = 384

function heap() {
    const gc = (globalThis as unknown as {gc: () => void}).gc
    for (let i = 0; i < 4; i++) gc()
    return process.memoryUsage().heapUsed
}

async function proxyReadLeavesASlimNode(O: tObserve) {
    // keys are built up front: the kids Map keeps the key string, and that is not the node's cost
    const keys = Array.from({length: KEYS}, (_, i) => 'k' + i)
    const init: Record<string, {id: string, px: number, qty: number}> = {}
    for (let i = 0; i < KEYS; i++) init[keys[i]] = {id: keys[i], px: i, qty: i * 2}
    const store = O.createStore(init)
    const h0 = heap()
    let sum = 0
    for (let i = 0; i < KEYS; i++) sum += store.state[keys[i]].px
    const h1 = heap()
    const perNode = (h1 - h0) / KEYS
    assert.ok(O.isReactive(store.state[keys[KEYS - 1]]), 'every read left a live node behind')
    assert.equal(sum, (KEYS - 1) * KEYS / 2)
    const detail = `${KEYS} rows read once through the proxy: ${perNode.toFixed(0)} B per reactive node (budget ${BYTES_PER_NODE})`
    assert.ok(perNode <= BYTES_PER_NODE, detail)
    console.log('      ' + detail)
}

async function main() {
    const O = await load()
    for (const check of [proxyReadLeavesASlimNode]) {
        try { await check(O); console.log('PASS ' + check.name) }
        catch (error) { console.error('FAIL ' + check.name, error); process.exitCode = 1 }
    }
}

runOracle(main)
