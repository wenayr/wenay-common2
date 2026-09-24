// =====================================================================
//  The lazy line hands out detached values, never the host's live objects.
//
//  read() sent `store.state[key]`: a reactive proxy of the host Store. A mirror wired
//  in-process (syncStoreLazyLine(mirror, host.api), no transport clone in between)
//  assigned it, and assignment resolves a proxy to its raw target, so the mirror and the
//  host shared one raw object. A host write then changed the mirror without a mirror
//  notification (and the live re-send was a no-op for the same object); a mirror write
//  changed the host without a host notification or patch. An RPC transport clones the
//  chunk, which is why this showed only in-process.
// =====================================================================
import assert from 'node:assert/strict'
import {
    createStore, flushReactive, isReactive, listenStorePatches, toRaw,
    exposeStoreLazyLine, syncStoreLazyLine, type StoreLazyChunkV1,
} from '../../src/Common/Observe'

type tQuotes = Record<string, {px: number, legs: number[]}>

const INITIAL = {BTC: {px: 1, legs: [1, 2]}, ETH: {px: 2, legs: [3]}}

function quotesStore() {
    return createStore<tQuotes>(structuredClone(INITIAL))
}

async function settle(...states: object[]) {
    for (const state of states) await flushReactive(state)
    await new Promise(function nextTurn(resolve) { setImmediate(resolve) })
}

async function waitFor(condition: () => boolean, label: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (condition()) return
        await new Promise(function pause(resolve) { setTimeout(resolve, 5) })
    }
    throw new Error('timed out: ' + label)
}

/** A mirror filled in-process by one full pass; the line stops after it. */
async function filledMirror() {
    const host = quotesStore()
    const line = exposeStoreLazyLine(host)
    const mirror = createStore<tQuotes>({})
    const sync = syncStoreLazyLine(mirror, line.api, {fillOnly: true})
    await sync.filled
    assert.deepEqual(mirror.snapshot(), INITIAL)
    return {host, mirror, close() { sync.close(); line.close() }}
}

async function chunkValuesAreDetached() {
    const host = quotesStore()
    const line = exposeStoreLazyLine(host)
    try {
        const chunks: StoreLazyChunkV1[] = []
        line.api.read({cursor: null}, function collect(chunk) { chunks.push(chunk) })
        const btc = chunks[0].values['BTC'] as tQuotes[string]
        assert.deepEqual(btc, INITIAL.BTC)
        assert.equal(isReactive(btc), false, 'a chunk value is not a Store proxy')
        assert.notEqual(btc, toRaw(host.state)['BTC'], 'a chunk value is not the host raw object')
        btc.px = 99
        btc.legs.push(3)
        assert.deepEqual(host.snapshot(), INITIAL, 'changing a sent value leaves the host intact')
    } finally { line.close() }
}

async function hostWriteSkipsFilledMirror() {
    const {host, mirror, close} = await filledMirror()
    let mirrorNotified = 0
    const off = mirror.on(function mirrorChanged() { mirrorNotified++ })
    try {
        host.state['BTC'].px = 100
        host.state['ETH'].legs.push(9)
        await settle(host.state, mirror.state)
        assert.deepEqual(mirror.snapshot(), INITIAL, 'a host write does not change the mirror behind its notifications')
        assert.equal(mirrorNotified, 0)
    } finally { off(); close() }
}

async function mirrorWriteSkipsHost() {
    const {host, mirror, close} = await filledMirror()
    let hostPatchBatches = 0
    const off = listenStorePatches(host).on(function hostPatched() { hostPatchBatches++ })
    try {
        mirror.state['BTC'].px = -1
        mirror.state['ETH'].legs.push(9)
        await settle(mirror.state, host.state)
        assert.deepEqual(host.snapshot(), INITIAL, 'a mirror write does not change the host behind its patches')
        assert.equal(hostPatchBatches, 0)
        assert.deepEqual(mirror.snapshot(), {BTC: {px: -1, legs: [1, 2]}, ETH: {px: 2, legs: [3, 9]}})
    } finally { off(); close() }
}

async function liveMirrorNotifiesHostWrites() {
    const host = quotesStore()
    const line = exposeStoreLazyLine(host)
    const mirror = createStore<tQuotes>({})
    const sync = syncStoreLazyLine(mirror, line.api, {liveIntervalMs: 5})
    const seen: number[] = []
    let off = function noSubscription() {}
    try {
        await sync.filled
        off = mirror.node.at('BTC').px.on(function mirrorPx(px) { seen.push(px) })
        host.state['BTC'].px = 100
        await settle(host.state)
        await waitFor(() => seen.length > 0, 'mirror notification for BTC.px')
        assert.deepEqual(seen, [100], 'the live re-send notifies the mirror subscriber')
        assert.equal(mirror.state['BTC'].px, 100)
    } finally {
        off()
        sync.close()
        line.close()
    }
}

async function main() {
    const checks = [chunkValuesAreDetached, hostWriteSkipsFilledMirror, mirrorWriteSkipsHost, liveMirrorNotifiesHostWrites]
    for (const check of checks) {
        try { await check(); console.log('PASS ' + check.name) }
        catch (error) { console.error('FAIL ' + check.name, error); process.exitCode = 1 }
    }
}

main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
