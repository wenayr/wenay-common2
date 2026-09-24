// =====================================================================
//  Concurrent chunked keyframes must share one retained snapshot.
//
//  chunks.begin() snapshotted and split the Store for every attempt and retained each
//  encoded set under an LRU cap of four ATTEMPTS. Clients joining together took one
//  snapshot each, and the cap evicted the sets of clients still pulling: their next pull
//  answered null and they fell back to a monolithic keyframe, another full snapshot each.
//  Attempts that begin at one journal head with one budget can share the split; the cap
//  then bounds distinct snapshots, and end() releases one reader's share.
//
//  The bound counts Store snapshots and monolithic fallbacks, not time. Equivalence:
//  every mirror equals the source and keeps following it; a shared begin answers the
//  seq and chunks of a fresh split and its own keyframe time; end(), the TTL and the cap
//  still release sets, and a changed head or budget still takes a new snapshot.
// =====================================================================
import assert from 'node:assert/strict'
import {createStore, type Store} from '../../src/Common/Observe/store'
import {flushReactive} from '../../src/Common/Observe/reactive'
import {
    exposeStoreReplay, syncStoreReplay,
    STORE_REPLAY_CHUNK_BUDGET_MIN, STORE_REPLAY_CHUNK_TTL_MS,
} from '../../src/Common/Observe/store-replay'
import {decodeStoreReplayBatchV2} from '../../src/Common/Observe/store-replay-codec'
import {runOracle} from '../run-oracle'

type tRow = {id: number, name: string, tags: string[], px: number}
type tChunks = {
    begin(opts?: {budgetBytes?: number}): {snapshotId: string, seq: number, ts: number, total: number, chunk0: unknown} | null
    pull(snapshotId: string, index: number): unknown
    end(snapshotId: string): boolean
}

const CLIENTS = 20
const KEYS = 4000
const LINK_MS = 2

const delay = (ms: number) => new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })

function rows(keys: number) {
    const state: Record<string, tRow> = {}
    for (let i = 0; i < keys; i++) state['k' + i] = {id: i, name: 'item-' + i, tags: ['a', 'b', 'c'], px: i * 1.5}
    return state
}

/** Counts full Store snapshots: a keyframe, chunked or monolithic, takes one. */
function countSnapshots(store: Store<any>) {
    const counter = {count: 0}
    const snapshot = store.snapshot
    ;(store as {snapshot: () => unknown}).snapshot = function countedSnapshot() {
        counter.count++
        return snapshot()
    }
    return counter
}

function partValue(wire: unknown) {
    const patch = decodeStoreReplayBatchV2(wire).event[0][0]!
    assert.ok(patch.path.length == 0 && patch.exists, 'a chunk is a partial root snapshot')
    return patch.value as Record<string, unknown>
}

function allParts(chunks: tChunks, begin: NonNullable<ReturnType<tChunks['begin']>>) {
    const parts = [partValue(begin.chunk0)]
    for (let index = 1; index < begin.total; index++) parts.push(partValue(chunks.pull(begin.snapshotId, index)))
    return parts
}

function payloadOf(parts: Record<string, unknown>[], key: string) {
    const part = parts.find(candidate => key in candidate)
    return (part?.[key] as {payload: string} | undefined)?.payload
}

// ============================================================
//  cost: concurrent clients over slow links
// ============================================================

async function concurrentClientsShareOneSnapshot() {
    const source = createStore<Record<string, tRow>>(rows(KEYS))
    const snapshots = countSnapshots(source)
    const exposed = exposeStoreReplay(source)
    const wire = exposed.api.replay as unknown as {chunks: tChunks} & Record<string, unknown>
    let fallbacks = 0
    let nullPulls = 0
    function slowRemote() {
        return {
            line: wire['line'],
            since: wire['since'],
            frame: wire['frame'],
            async keyframe() {
                fallbacks++
                await delay(LINK_MS)
                return (wire['keyframe'] as () => unknown)()
            },
            chunks: {
                async begin(opts?: {budgetBytes?: number}) {
                    await delay(LINK_MS)
                    return wire.chunks.begin(opts)
                },
                async pull(snapshotId: string, index: number) {
                    await delay(LINK_MS)
                    const chunk = wire.chunks.pull(snapshotId, index)
                    if (chunk == null) nullPulls++
                    return chunk
                },
                end: (snapshotId: string) => wire.chunks.end(snapshotId),
            },
        }
    }
    const mirrors = Array.from({length: CLIENTS}, function mirrorOf() {
        const mirror = createStore<Record<string, tRow>>({})
        const sub = syncStoreReplay(mirror, slowRemote() as never, {chunkedKeyframe: {budgetBytes: STORE_REPLAY_CHUNK_BUDGET_MIN}})
        return {mirror, sub}
    })
    await Promise.all(mirrors.map(entry => entry.sub.ready))
    const detail = `${CLIENTS} concurrent chunked keyframes took ${snapshots.count} full snapshots and`
        + ` ${fallbacks} monolithic fallbacks (${nullPulls} null pulls); bound: 2 snapshots, 0 fallbacks`
    const expected = JSON.stringify(source.snapshot())
    for (const entry of mirrors) assert.equal(JSON.stringify(entry.mirror.snapshot()), expected, 'every mirror equals the source')

    source.state['k7'] = {id: 7, name: 'after-bootstrap', tags: [], px: -1}
    await flushReactive(source.state)
    await delay(LINK_MS * 5)
    for (const entry of mirrors) {
        assert.equal(entry.mirror.state['k7']?.name, 'after-bootstrap', 'the tail continues after the shared keyframe')
        entry.sub()
    }
    exposed.close()
    assert.ok(snapshots.count <= 2 && fallbacks == 0, detail)
    console.log('      ' + detail)
}

// ============================================================
//  facet semantics under a fixed clock
// ============================================================

function openFacet() {
    const clock = {now: 1_000_000}
    const store = createStore<Record<string, {id: string, payload: string}>>({})
    for (let i = 0; i < 40; i++) store.state['key-' + i] = {id: 'key-' + i, payload: 'x'.repeat(2000)}
    const snapshots = countSnapshots(store)
    const exposed = exposeStoreReplay(store, {history: 64, now: () => clock.now})
    const chunks = (exposed.api.replay as unknown as {chunks: tChunks}).chunks
    async function write(key: string, payload: string) {
        store.state[key] = {id: key, payload}
        await flushReactive(store.state)
    }
    return {clock, store, snapshots, exposed, chunks, write}
}

async function sharedBeginMatchesFreshSplit() {
    const {clock, store, snapshots, exposed, chunks} = openFacet()
    const first = chunks.begin({budgetBytes: 1})!
    clock.now += 1000
    const second = chunks.begin({budgetBytes: 1})!
    assert.equal(snapshots.count, 1, 'a second begin at the same head and budget takes no snapshot')
    assert.equal(second.seq, first.seq)
    assert.equal(second.total, first.total)
    assert.equal(second.ts, first.ts + 1000, 'each attempt answers its own keyframe time')
    assert.equal(decodeStoreReplayBatchV2(second.chunk0).ts, second.ts, 'chunk 0 carries that time')

    const fresh = exposeStoreReplay(store, {history: 64, now: () => clock.now})
    const freshChunks = (fresh.api.replay as unknown as {chunks: tChunks}).chunks
    const freshBegin = freshChunks.begin({budgetBytes: 1})!
    assert.deepEqual(allParts(chunks, second), allParts(freshChunks, freshBegin), 'the shared split equals a fresh one')
    fresh.close()
    exposed.close()
}

async function newHeadOrBudgetTakesNewSnapshot() {
    const {snapshots, exposed, chunks, write} = openFacet()
    const first = chunks.begin({budgetBytes: 1})!
    const wider = chunks.begin({budgetBytes: 40_000})!
    assert.equal(snapshots.count, 2, 'another budget is another split')
    assert.ok(wider.total < first.total)
    await write('key-3', 'changed')
    const next = chunks.begin({budgetBytes: 1})!
    assert.equal(snapshots.count, 3, 'a new journal head is a new snapshot')
    assert.equal(next.seq, first.seq + 1)
    assert.equal(payloadOf(allParts(chunks, next), 'key-3'), 'changed')
    assert.equal(payloadOf(allParts(chunks, first), 'key-3'), 'x'.repeat(2000), 'the older snapshot keeps its own state')
    exposed.close()
}

async function endReleasesOneReader() {
    const {exposed, chunks} = openFacet()
    const first = chunks.begin({budgetBytes: 1})!
    const second = chunks.begin({budgetBytes: 1})!
    assert.equal(chunks.end(first.snapshotId), true)
    assert.notEqual(chunks.pull(second.snapshotId, 1), null, 'the other reader still pulls after one end()')
    assert.equal(chunks.end(second.snapshotId), true)
    assert.equal(chunks.pull(second.snapshotId, 1), null, 'the last end() releases the set')
    assert.equal(chunks.end(second.snapshotId), false, 'a released set is gone')
    exposed.close()
}

async function ttlAndCapBoundSharedSets() {
    const {clock, exposed, chunks, write} = openFacet()
    const abandoned = chunks.begin({budgetBytes: 1})!
    chunks.begin({budgetBytes: 1})
    clock.now += STORE_REPLAY_CHUNK_TTL_MS + 1
    assert.equal(chunks.pull(abandoned.snapshotId, 1), null, 'readers that never end() cost only the retention window')

    const crowd = Array.from({length: CLIENTS}, () => chunks.begin({budgetBytes: 1})!)
    assert.notEqual(chunks.pull(crowd[0]!.snapshotId, 1), null, 'readers of one snapshot never evict each other')

    const heads = [crowd[0]!]
    for (let i = 1; i < 5; i++) {
        await write('key-0', 'rev-' + i)
        heads.push(chunks.begin({budgetBytes: 1})!)
    }
    assert.equal(chunks.pull(heads[0]!.snapshotId, 1), null, 'the least recently used of five snapshots is evicted')
    for (const head of heads.slice(1)) assert.notEqual(chunks.pull(head.snapshotId, 1), null)
    exposed.close()
}

async function main() {
    const checks = [
        sharedBeginMatchesFreshSplit, newHeadOrBudgetTakesNewSnapshot, endReleasesOneReader,
        ttlAndCapBoundSharedSets, concurrentClientsShareOneSnapshot,
    ]
    for (const check of checks) {
        try { await check(); console.log('PASS ' + check.name) }
        catch (error) { console.error('FAIL ' + check.name, error); process.exitCode = 1 }
    }
}

runOracle(main)
