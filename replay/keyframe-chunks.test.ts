// ============================================================
//  replay/keyframe-chunks.test.ts
//
//  Chunked keyframe (KEYFRAME-CHUNKING.md, decided v1): the pull facet splits
//  ONE snapshot into partial keyframes by byte budget, the client reassembles
//  and applies through the ordinary single-event path, every chunk carries the
//  same seq so the tail resumes from one point, an expired attempt answers
//  null and the client falls back to the monolithic keyframe, and a peer
//  without the facet (or with the option off) behaves exactly as before.
//  Run: npx tsx replay/keyframe-chunks.test.ts
// ============================================================

import {createStore} from '../src/Common/Observe/store'
import {
    exposeStoreReplay, syncStoreReplayBatch,
    STORE_REPLAY_CHUNK_BUDGET_MIN, STORE_REPLAY_CHUNK_TTL_MS,
    type StoreReplayChunkedProgress,
} from '../src/Common/Observe/store-replay'
import {decodeStoreReplayBatchV2} from '../src/Common/Observe/store-replay-codec'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
async function settle(times = 6) { for (let i = 0; i < times; i++) await tick() }

type BigState = Record<string, {id: string, payload: string}>

function bigState(keys: number, payloadBytes: number) {
    const state: BigState = {}
    for (let i = 0; i < keys; i++) {
        const id = 'key-' + String(i).padStart(4, '0')
        state[id] = {id, payload: 'x'.repeat(payloadBytes)}
    }
    return state
}

function partValue(wire: unknown) {
    const event = decodeStoreReplayBatchV2(wire)
    const patch = event.event[0][0]!
    if (patch.path.length != 0 || !patch.exists) throw new Error('chunk is not a partial root snapshot')
    return patch.value as Record<string, unknown>
}

async function main() {
    // ============== the facet: split by budget, one seq, disjoint keys ==============
    let clock = 1_000_000
    const store = createStore<BigState>(bigState(40, 2000))
    const exposed = exposeStoreReplay(store, {history: 64, now: () => clock})
    const remote = exposed.api.replay as any
    ok(!!remote.chunks, 'the wire facade advertises the chunks facet')

    const begin = await remote.chunks.begin({budgetBytes: 1})
    ok(begin.budgetBytes == STORE_REPLAY_CHUNK_BUDGET_MIN, 'the requested budget is clamped into the floor')
    ok(begin.total > 1, `a 40x2KB store splits (total ${begin.total})`)
    const seen = new Set<string>()
    let duplicates = 0
    const parts = [begin.chunk0]
    for (let index = 1; index < begin.total; index++) parts.push(await remote.chunks.pull(begin.snapshotId, index))
    for (const wire of parts) {
        for (const key of Object.keys(partValue(wire))) {
            if (seen.has(key)) duplicates++
            seen.add(key)
        }
    }
    ok(seen.size == 40 && duplicates == 0, 'chunks cover ALL top-level keys exactly once (disjoint subsets)')
    const seqs = new Set(parts.map(wire => decodeStoreReplayBatchV2(wire).seq))
    ok(seqs.size == 1 && seqs.has(begin.seq), 'every chunk carries the ONE seq the snapshot was taken at')
    ok(await remote.chunks.pull(begin.snapshotId, begin.total) == null, 'an out-of-range index answers null')
    ok(remote.chunks.end(begin.snapshotId) == true, 'end() releases the retained attempt')
    ok(await remote.chunks.pull(begin.snapshotId, 0) == null, 'a released attempt answers null')

    // ============== oversized single value: indivisible, still exact ==============
    const fat = createStore<BigState>({
        ...bigState(3, 500),
        whale: {id: 'whale', payload: 'y'.repeat(64 * 1024)},
    })
    const fatExposed = exposeStoreReplay(fat, {history: 8})
    const fatBegin = await (fatExposed.api.replay as any).chunks.begin({budgetBytes: STORE_REPLAY_CHUNK_BUDGET_MIN})
    const fatParts = [fatBegin.chunk0]
    for (let index = 1; index < fatBegin.total; index++) {
        fatParts.push(await (fatExposed.api.replay as any).chunks.pull(fatBegin.snapshotId, index))
    }
    const whaleChunks = fatParts.filter(wire => 'whale' in partValue(wire))
    ok(whaleChunks.length == 1 && Object.keys(partValue(whaleChunks[0])).length == 1,
        'a value larger than the budget becomes its OWN oversized chunk, never split')
    fatExposed.close()

    // ============== the client path: assemble, apply atomically, resume the tail ==============
    const mirror = createStore<BigState>({})
    const progress: StoreReplayChunkedProgress[] = []
    const off = syncStoreReplayBatch(mirror, exposed.api.replay, {
        chunkedKeyframe: {budgetBytes: 1, onProgress: p => progress.push(p)},
    })
    await settle()
    ok(JSON.stringify(mirror.snapshot()) == JSON.stringify(store.snapshot()),
        'the assembled mirror equals the source snapshot byte for byte')
    ok(progress.length > 1 && progress[progress.length - 1]!.received == progress[progress.length - 1]!.total,
        `assembly progress was observable (${progress.length} reports)`)
    store.state['key-0000'] = {id: 'key-0000', payload: 'updated-after-keyframe'}
    await settle()
    ok(mirror.snapshot()['key-0000']?.payload == 'updated-after-keyframe',
        'live envelopes keep flowing after a chunked bootstrap (the tail resumed from seq)')
    off()

    // ============== retention: TTL expiry and the LRU cap answer null ==============
    const expired = await remote.chunks.begin({budgetBytes: 1})
    clock += STORE_REPLAY_CHUNK_TTL_MS + 1
    ok(await remote.chunks.pull(expired.snapshotId, 1) == null, 'an attempt older than the TTL answers null')
    const attempts = [] as any[]
    for (let i = 0; i < 5; i++) attempts.push(await remote.chunks.begin({budgetBytes: 1}))
    ok(await remote.chunks.pull(attempts[0].snapshotId, 1) == null,
        'the LRU cap evicts the oldest of five concurrent attempts')
    ok(await remote.chunks.pull(attempts[4].snapshotId, 1) != null, 'the newest attempt still serves')

    // ============== fallback and compatibility ==============
    // expired attempt mid-assembly: the client falls back to the monolithic keyframe
    let monolithicCalls = 0
    const flaky = {
        ...remote,
        keyframe: (...args: unknown[]) => { monolithicCalls++; return remote.keyframe(...args) },
        chunks: {
            begin: (opts?: unknown) => remote.chunks.begin(opts),
            pull: () => null,   // every pull answers "evicted"
            end: (id: string) => remote.chunks.end(id),
        },
    }
    const fallbackMirror = createStore<BigState>({})
    const offFallback = syncStoreReplayBatch(fallbackMirror, flaky, {chunkedKeyframe: {budgetBytes: 1}})
    await settle()
    ok(monolithicCalls == 1 && JSON.stringify(fallbackMirror.snapshot()) == JSON.stringify(store.snapshot()),
        'a dead attempt falls back to the monolithic keyframe and still converges')
    offFallback()

    // chunkedKeyframe: false ignores the facet entirely
    monolithicCalls = 0
    const optOutMirror = createStore<BigState>({})
    const counting = {...remote, keyframe: (...args: unknown[]) => { monolithicCalls++; return remote.keyframe(...args) }}
    const offOptOut = syncStoreReplayBatch(optOutMirror, counting, {chunkedKeyframe: false})
    await settle()
    ok(monolithicCalls == 1 && JSON.stringify(optOutMirror.snapshot()) == JSON.stringify(store.snapshot()),
        'chunkedKeyframe: false uses the monolithic path against a chunk-capable server')
    offOptOut()

    // a server WITHOUT the facet: the default client works exactly as before
    const {chunks: _stripped, ...legacyRemote} = remote
    const legacyMirror = createStore<BigState>({})
    const offLegacy = syncStoreReplayBatch(legacyMirror, legacyRemote, {})
    await settle()
    ok(JSON.stringify(legacyMirror.snapshot()) == JSON.stringify(store.snapshot()),
        'a peer without the facet behaves exactly as today (additive by construction)')
    offLegacy()

    exposed.close()
    console.log(fails == 0 ? '\nkeyframe-chunks: ALL GREEN' : `\nkeyframe-chunks: ${fails} FAILURES`)
    if (fails) process.exitCode = 1
}
void main()
