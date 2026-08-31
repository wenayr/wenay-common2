// =====================================================================
// Store external — the useSyncExternalStore contract, pinned
// =====================================================================
// React's exact mount sequence is the contract: render reads getSnapshot,
// the effect subscribes, then React RE-READS getSnapshot to catch a change
// that landed in the render→subscribe gap. The tuple must see that change
// (subscribe invalidates the cache), keep snapshot identity stable between
// changes (an unstable identity is an infinite re-render loop), and one
// subscriber leaving must not disturb the others' cached identity.

import * as assert from 'node:assert/strict'
import {createStore} from './store'
import {storeExternal} from './store-external'

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function run() {
    // ============== the render→subscribe gap: subscribe must invalidate ==============
    {
        const store = createStore({n: 1}, {drain: 'micro'})
        const ext = storeExternal(store.node.n)
        assert.equal(ext.getSnapshot(), 1, 'render reads the initial value')

        // the gap: the store changes BEFORE anyone subscribed — no change fact reaches the tuple
        store.state.n = 2
        await wait()

        let notified = 0
        const off = ext.subscribe(function onChange() { notified++ })
        assert.equal(ext.getSnapshot(), 2, 'the post-subscribe re-read must see the gap change')
        assert.equal(notified, 0, 'no retroactive notification — the re-read alone carries the gap')
        off()
    }

    // ============== identity stable between changes, recomputed after a change fact ==============
    {
        const store = createStore({box: {n: 1}}, {drain: 'micro'})
        const ext = storeExternal(store.node.box)
        let changes = 0
        const off = ext.subscribe(function onChange() { changes++ })

        const first = ext.getSnapshot()
        assert.equal(ext.getSnapshot(), first, 'unchanged store → the SAME snapshot identity')

        store.state.box.n = 2
        await wait()
        assert.equal(changes, 1, 'the change fact notified the subscriber')
        const second = ext.getSnapshot()
        assert.notEqual(second, first, 'a change fact → a NEW snapshot identity')
        assert.equal(second.n, 2, 'the new snapshot carries the new value')
        assert.equal(ext.getSnapshot(), second, 'identity stable again until the next change')
        off()
    }

    // ============== one subscriber leaving must not disturb the others ==============
    {
        const store = createStore({n: 7}, {drain: 'micro'})
        const ext = storeExternal(store.node.n)
        const offA = ext.subscribe(function subscriberA() {})
        const offB = ext.subscribe(function subscriberB() {})
        const beforeLeave = ext.getSnapshot()
        offA()
        assert.equal(ext.getSnapshot(), beforeLeave,
            'a peer unsubscribing must not invalidate the shared cached identity')
        offB()
    }

    console.log('store-external.spec: OK')
}

run().catch(function specFailed(error) {
    console.error('store-external.spec FAILED:', error?.message ?? error)
    process.exit(1)
})
