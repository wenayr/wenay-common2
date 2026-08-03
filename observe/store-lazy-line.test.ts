// =====================================================================
// Lazy Store line: convergence, suppression and resume
// =====================================================================
// Run: npx tsx observe/store-lazy-line.test.ts

import assert from 'node:assert/strict'

import {createStore} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {
    exposeStoreLazyLine,
    syncStoreLazyLine,
    type StoreLazyChunkV1,
    type StoreLazyCursor,
} from '../src/Common/Observe/store-lazy-line'

type Quote = {bid: number}

let clock = 1_000
const now = () => clock

function makeStore(keys: number) {
    const store = createStore<Record<string, Quote>>({})
    // Fixed width so sort order matches numeric order and assertions stay readable.
    for (let index = 0; index < keys; index++) store.state[keyOf(index)] = {bid: index}
    return store
}

function keyOf(index: number) {
    return 'sym-' + String(index).padStart(5, '0')
}

/** Drive the host by hand so every step of a slow transfer is observable. */
function manualReader(host: ReturnType<typeof exposeStoreLazyLine<Record<string, Quote>>>) {
    const chunks: StoreLazyChunkV1[] = []
    let cursor: StoreLazyCursor | null = null
    return {
        chunks,
        get cursor() { return cursor },
        set cursor(value: StoreLazyCursor | null) { cursor = value },
        read(maxBytes: number) {
            const result = host.api.read({cursor, maxBytes}, function collect(chunk) {
                chunks.push(chunk)
            }) as Extract<ReturnType<typeof host.api.read>, {cursor: StoreLazyCursor}>
            cursor = result.stale ? null : result.cursor
            return result
        },
        drain(maxBytes = 4_000) {
            for (let guard = 0; guard < 200; guard++) {
                if (this.read(maxBytes).filled) return true
            }
            return false
        },
        keysDelivered() {
            const seen = new Map<string, Quote | undefined>()
            for (const chunk of chunks) {
                for (const key of Object.keys(chunk.values)) seen.set(key, chunk.values[key] as Quote)
                for (const key of chunk.deleted) seen.set(key, undefined)
            }
            return seen
        },
        deliveries() {
            return chunks.reduce((total, chunk) =>
                total + Object.keys(chunk.values).length + chunk.deleted.length, 0)
        },
    }
}

// =====================================================================
// The saving: a key overwritten before its turn costs nothing extra
// =====================================================================

async function changeBeforeSendIsSuppressed() {
    const store = makeStore(50)
    const host = exposeStoreLazyLine(store, {chunkBytes: 200, windowBytes: 200, now})
    const reader = manualReader(host)

    reader.read(200)
    const afterFirst = reader.deliveries()
    assert.ok(afterFirst > 0 && afterFirst < 50, 'the first read is partial')

    // Rewrite keys beyond the cursor, many times over.
    for (let round = 0; round < 5; round++) {
        for (let index = 40; index < 50; index++) store.state[keyOf(index)] = {bid: 900 + round}
        await flushReactive(store.state)
    }

    assert.ok(reader.drain(), 'the fill completes')
    const delivered = reader.keysDelivered()
    assert.equal(delivered.size, 50, 'every key delivered')
    assert.equal(reader.deliveries(), 50, 'five rewrites beyond the cursor cost zero extra deliveries')
    for (let index = 40; index < 50; index++) {
        assert.equal(delivered.get(keyOf(index))?.bid, 904, 'and the value sent is the newest one')
    }
    host.close()
    console.log('ok  a change beyond the cursor costs nothing and still lands newest')
}

// =====================================================================
// Convergence: a key changed behind the cursor is re-sent
// =====================================================================

async function changeBehindCursorIsResent() {
    const store = makeStore(20)
    const host = exposeStoreLazyLine(store, {chunkBytes: 150, windowBytes: 150, now})
    const reader = manualReader(host)
    reader.read(150)

    const alreadySent = [...reader.keysDelivered().keys()][0]
    store.state[alreadySent] = {bid: 777}
    await flushReactive(store.state)

    reader.read(4_000)
    assert.equal(reader.keysDelivered().get(alreadySent)?.bid, 777, 'converged to the new value')
    host.close()
    console.log('ok  a change behind the cursor is re-sent')
}

// =====================================================================
// Tombstones
// =====================================================================

async function deleteBehindCursorTravels() {
    const store = makeStore(30)
    const host = exposeStoreLazyLine(store, {chunkBytes: 150, windowBytes: 150, now})
    const reader = manualReader(host)
    reader.read(150)
    const sentKey = [...reader.keysDelivered().keys()][0]

    delete store.state[sentKey]
    await flushReactive(store.state)

    reader.drain()
    assert.equal(reader.keysDelivered().get(sentKey), undefined, 'a deleted key clears the mirror copy')
    host.close()
    console.log('ok  a key deleted behind the cursor travels as a tombstone')
}

async function deleteBeyondCursorIsNeverSent() {
    const store = makeStore(30)
    const host = exposeStoreLazyLine(store, {chunkBytes: 150, windowBytes: 150, now})
    const reader = manualReader(host)
    reader.read(150)

    // A key the subscriber has never seen: deleting it costs nothing, because it
    // cannot hold a stale copy of something it was never sent.
    delete store.state[keyOf(29)]
    await flushReactive(store.state)

    reader.drain()
    const delivered = reader.keysDelivered()
    assert.ok(!delivered.has(keyOf(29)), 'a never-sent key is not announced at all')
    host.close()
    console.log('ok  a key deleted beyond the cursor is never announced')
}

// =====================================================================
// THE POINT OF THE CURSOR: a broken transfer resumes instead of restarting
// =====================================================================

async function fillResumesAfterDisconnect() {
    const store = makeStore(400)
    const host = exposeStoreLazyLine(store, {chunkBytes: 1_000, windowBytes: 4_000, now})

    const first = manualReader(host)
    first.read(4_000)
    const partial = first.deliveries()
    assert.ok(partial > 0 && partial < 400, 'the first connection transferred part of the Store')
    const savedCursor = first.cursor
    assert.ok(savedCursor?.key != null, 'and produced a resumable cursor')

    // The connection drops. A new subscriber object resumes from the saved cursor.
    const second = manualReader(host)
    second.cursor = savedCursor
    assert.ok(second.drain(), 'the resumed fill completes')

    const resent = second.deliveries()
    assert.ok(resent < 400, 'resume did NOT restart the whole transfer: ' + resent + ' of 400')
    assert.ok(resent >= 400 - partial - 5, 'and it still delivered the rest')

    const total = new Set([...first.keysDelivered().keys(), ...second.keysDelivered().keys()])
    assert.equal(total.size, 400, 'the two halves together cover every key')
    host.close()
    console.log('ok  a broken fill resumes instead of restarting (' + partial + ' + ' + resent + ' of 400)')
}

async function resumeCatchesUpWhatChangedWhileAway() {
    const store = makeStore(200)
    const host = exposeStoreLazyLine(store, {chunkBytes: 1_000, windowBytes: 4_000, now})
    const reader = manualReader(host)
    reader.read(4_000)
    const cursorKey = reader.cursor!.key!
    const behind = [...reader.keysDelivered().keys()].filter(key => key <= cursorKey)
    assert.ok(behind.length > 1)

    // While the subscriber is away, a key it already holds changes.
    const changed = behind[0]
    store.state[changed] = {bid: 4_242}
    await flushReactive(store.state)

    const resumed = manualReader(host)
    resumed.cursor = reader.cursor
    resumed.drain()
    assert.equal(resumed.keysDelivered().get(changed)?.bid, 4_242,
        'a key that moved while the subscriber was away is caught up on resume')
    host.close()
    console.log('ok  resume catches up what changed while away')
}

async function cursorOlderThanTombstoneRetentionIsRefused() {
    const store = makeStore(20)
    const host = exposeStoreLazyLine(store, {chunkBytes: 500, windowBytes: 2_000, tombstoneKeepMs: 1_000, now})
    const reader = manualReader(host)
    reader.drain()
    const oldCursor = reader.cursor

    delete store.state[keyOf(0)]
    await flushReactive(store.state)
    // Push the tombstone past its retention, then let a write trigger the prune.
    clock += 5_000
    store.state[keyOf(19)] = {bid: 1}
    await flushReactive(store.state)

    const stale = host.api.read({cursor: oldCursor}, function ignore() {}) as any
    assert.equal(stale.stale, true, 'a cursor that predates pruned tombstones is refused')
    assert.equal(stale.cursor.key, null, 'and is told to restart from scratch')
    host.close()
    console.log('ok  a cursor older than tombstone retention is refused, not silently served')
}

// =====================================================================
// REGRESSION: a stale cursor must not leave a deleted key alive in the mirror
// =====================================================================
// Reported against 2.6.0: the stale branch reset the cursor but not the mirror,
// so a key whose tombstone had expired stayed in the mirror forever while the
// host no longer held it.

async function staleCursorSweepsKeysTheHostNoLongerHas() {
    const store = createStore<Record<string, Quote>>({})
    store.state['a'] = {bid: 1}
    store.state['b'] = {bid: 2}
    await flushReactive(store.state)

    const host = exposeStoreLazyLine(store, {tombstoneKeepMs: 1_000, now})
    const mirror = createStore<Record<string, Quote>>({})

    // 1. The subscriber syncs fully and persists its cursor.
    let saved: StoreLazyCursor | null = null
    const first = syncStoreLazyLine(mirror, host.api, {
        fillOnly: true,
        onCursor: value => { saved = value },
    })
    await first.filled
    first.close()
    assert.deepEqual(Object.keys(mirror.state).sort(), ['a', 'b'], 'mirror starts in sync')
    assert.ok(saved != null, 'a cursor was persisted')

    // 2. `a` is deleted while the subscriber is away, and its tombstone expires.
    delete store.state['a']
    await flushReactive(store.state)
    clock += 10_000
    store.state['b'] = {bid: 22}
    await flushReactive(store.state)

    // 3. The host can no longer prove the deletion.
    const refused = host.api.read({cursor: saved}, function ignore() {}) as any
    assert.equal(refused.stale, true, 'the host refuses a cursor it cannot prove')

    // 4. The subscriber returns with that stale cursor and must end up correct.
    let sweptReported = 0
    const second = syncStoreLazyLine(mirror, host.api, {
        cursor: saved,
        fillOnly: true,
        onProgress: progress => { sweptReported += progress.swept },
    })
    await second.filled
    second.close()

    assert.deepEqual(Object.keys(mirror.state).sort(), ['b'],
        'the mirror must not keep a key the host no longer has')
    assert.equal((mirror.state as any)['b'].bid, 22, 'and the surviving key is current')
    assert.equal(sweptReported, 1, 'the sweep is reported, not silent')
    host.close()
    console.log('ok  a stale cursor sweeps keys the host no longer has')
}

// A cursor from a PREVIOUS host lifetime must not be trusted: revisions restart at
// zero, so without a line identity the host would find nothing to catch up and
// resume the fill past keys the subscriber only ASSUMES it holds.
async function cursorFromAnotherHostLifetimeIsRefused() {
    const store = createStore<Record<string, Quote>>({})
    store.state['a'] = {bid: 1}
    store.state['b'] = {bid: 2}
    await flushReactive(store.state)

    const before = exposeStoreLazyLine(store, {now})
    const mirror = createStore<Record<string, Quote>>({})
    let saved: StoreLazyCursor | null = null
    const first = syncStoreLazyLine(mirror, before.api, {
        fillOnly: true,
        onCursor: value => { saved = value },
    })
    await first.filled
    first.close()
    before.close()
    assert.ok(saved != null && saved!.key != null, 'a cursor was persisted')

    // The host restarts. Its revision counter begins again from zero, and while it
    // was down `a` was removed.
    delete store.state['a']
    await flushReactive(store.state)
    const after = exposeStoreLazyLine(store, {now})

    const refused = after.api.read({cursor: saved}, function ignore() {}) as any
    assert.equal(refused.stale, true, 'a cursor from a dead lifetime is refused')

    const second = syncStoreLazyLine(mirror, after.api, {cursor: saved, fillOnly: true})
    await second.filled
    second.close()
    assert.deepEqual(Object.keys(mirror.state).sort(), ['b'],
        'and the mirror is reconciled instead of silently diverging')
    after.close()
    console.log('ok  a cursor from another host lifetime is refused')
}

// A pass from scratch must also reconcile a mirror restored from disk.
async function freshPassReconcilesAPrePopulatedMirror() {
    const store = createStore<Record<string, Quote>>({})
    store.state['keep'] = {bid: 1}
    await flushReactive(store.state)
    const host = exposeStoreLazyLine(store, {now})

    // A mirror rehydrated from an old snapshot holds a key the host never had.
    const mirror = createStore<Record<string, Quote>>({})
    mirror.state['ghost'] = {bid: 999}
    mirror.state['keep'] = {bid: 0}

    const sync = syncStoreLazyLine(mirror, host.api, {fillOnly: true})
    await sync.filled
    sync.close()

    assert.deepEqual(Object.keys(mirror.state).sort(), ['keep'], 'the stale key is reconciled away')
    assert.equal((mirror.state as any)['keep'].bid, 1)
    host.close()
    console.log('ok  a pass from scratch reconciles a pre-populated mirror')
}

// REGRESSION (2.6.1): a stale arriving PART-WAY THROUGH a pass that is already
// sweeping must restart the evidence, not extend it. The keys the aborted pass
// delivered say nothing about the restarted one — a key it sent and the fresh pass
// never mentions is precisely the key that has to go.
async function staleDuringAFirstPassRestartsTheSweepEvidence() {
    const store = makeStore(40)
    const before = exposeStoreLazyLine(store, {chunkBytes: 100, windowBytes: 100, now})
    const mirror = createStore<Record<string, Quote>>({})

    // The host dies after the subscriber's first partial read, and the key that read
    // delivered is gone by the time it comes back. `keyOf(0)` sorts first, so the
    // first read is guaranteed to have carried it.
    let after: ReturnType<typeof exposeStoreLazyLine<Record<string, Quote>>> | null = null
    let calls = 0
    const remote = {
        read(request: any, emit: any) {
            calls++
            if (calls == 1) return before.api.read(request, emit)
            if (after == null) {
                delete store.state[keyOf(0)]
                // A fresh lifetime never knew the key, so it cannot announce a tombstone
                // for it — the mirror can only be corrected by the sweep.
                after = exposeStoreLazyLine(store, {chunkBytes: 100, windowBytes: 100, now})
            }
            return after.api.read(request, emit)
        },
    }

    let sweptReported = 0
    const sync = syncStoreLazyLine(mirror, remote, {
        readBytes: 100,
        fillOnly: true,
        onProgress: progress => { sweptReported += progress.swept },
    })
    await sync.filled
    sync.close()

    assert.ok(calls > 2, 'the fill really was part-way through when the host was replaced')
    assert.ok(!(keyOf(0) in mirror.state),
        'a key delivered by the ABORTED pass must not survive the restarted one')
    assert.equal(Object.keys(mirror.state).length, 39, 'and every surviving key is present')
    assert.equal(sweptReported, 1, 'the sweep is reported')
    before.close()
    after!.close()
    console.log('ok  a stale mid-pass restarts the sweep evidence instead of extending it')
}

// A RESUMED pass must NOT sweep: keys that simply did not change were not re-sent.
async function resumeDoesNotSweepUnchangedKeys() {
    const store = makeStore(200)
    const host = exposeStoreLazyLine(store, {chunkBytes: 1_000, windowBytes: 4_000, now})
    const mirror = createStore<Record<string, Quote>>({})

    let saved: StoreLazyCursor | null = null
    const first = syncStoreLazyLine(mirror, host.api, {
        readBytes: 4_000,
        onCursor: value => { saved = value },
    })
    await first.filled
    first.close()
    assert.equal(Object.keys(mirror.state).length, 200)

    const second = syncStoreLazyLine(mirror, host.api, {cursor: saved, fillOnly: true})
    await second.filled
    second.close()
    assert.equal(Object.keys(mirror.state).length, 200,
        'a valid resume must not delete keys merely because they did not change')
    host.close()
    console.log('ok  a valid resume does not sweep unchanged keys')
}

// =====================================================================
// End to end
// =====================================================================

async function mirrorConvergesUnderConstantChurn() {
    const store = makeStore(350)
    const host = exposeStoreLazyLine(store, {chunkBytes: 2_048, windowBytes: 8_192})
    const mirror = createStore<Record<string, Quote>>({})

    let round = 0
    const churn = setInterval(function rewriteHotKeys() {
        round++
        for (let index = 0; index < 120; index++) {
            store.state[keyOf((index + round * 40) % 350)] = {bid: 10_000 + round}
        }
        void flushReactive(store.state)
    }, 5)

    const sync = syncStoreLazyLine(mirror, host.api, {readBytes: 8_192, fillIntervalMs: 1, liveIntervalMs: 5})
    await sync.filled
    clearInterval(churn)
    await flushReactive(store.state)

    for (let guard = 0; guard < 400; guard++) {
        const stale = Object.keys(store.state).filter(key =>
            (mirror.state as any)[key]?.bid != (store.state as any)[key].bid)
        if (stale.length == 0 && Object.keys(mirror.state).length == 350) break
        await new Promise<void>(resolve => setTimeout(resolve, 5))
    }

    assert.equal(Object.keys(mirror.state).length, 350, 'every key present')
    const mismatched = Object.keys(store.state).filter(key =>
        (mirror.state as any)[key]?.bid != (store.state as any)[key].bid)
    assert.deepEqual(mismatched, [], 'mirror converged to the authoritative values')

    sync.close()
    host.close()
    console.log('ok  mirror converges while the store keeps changing')
}

function readBudgetIsRespected() {
    const store = makeStore(200)
    const host = exposeStoreLazyLine(store, {chunkBytes: 512, windowBytes: 100_000, now})
    const reader = manualReader(host)

    reader.read(400)
    const afterSmall = reader.deliveries()
    assert.ok(afterSmall > 0, 'a small budget still makes progress')
    assert.ok(afterSmall < 200, 'and does not drain the whole store in one read')
    assert.ok(reader.read(400).remaining > 0, 'the transfer stays incremental under a small budget')
    host.close()
    console.log('ok  the consumer budget bounds every read')
}

async function main() {
    await changeBeforeSendIsSuppressed()
    await changeBehindCursorIsResent()
    await deleteBehindCursorTravels()
    await deleteBeyondCursorIsNeverSent()
    await fillResumesAfterDisconnect()
    await resumeCatchesUpWhatChangedWhileAway()
    await cursorOlderThanTombstoneRetentionIsRefused()
    await staleCursorSweepsKeysTheHostNoLongerHas()
    await cursorFromAnotherHostLifetimeIsRefused()
    await freshPassReconcilesAPrePopulatedMirror()
    await staleDuringAFirstPassRestartsTheSweepEvidence()
    await resumeDoesNotSweepUnchangedKeys()
    readBudgetIsRespected()
    await mirrorConvergesUnderConstantChurn()
    console.log('\nstore lazy line: all checks passed')
}

void main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
