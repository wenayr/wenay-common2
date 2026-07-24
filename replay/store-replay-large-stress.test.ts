// =====================================================================
// Large deterministic Store Replay stress: 15k rows, codecs and recovery.
// =====================================================================

import {performance} from 'node:perf_hooks'
import {isDeepStrictEqual} from 'node:util'
import {createStore, Store, StorePatch} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {
    exposeStoreReplay, StoreReplayBatchRemote, StoreReplayRemote,
    syncStoreReplay, syncStoreReplayBatch,
} from '../src/Common/Observe/store-replay'
import {
    decodeStoreReplayBatch, decodeStoreReplayBatchV2, decodeStoreReplayBatchV3,
    decodeStoreReplayBatchV4, decodeStoreReplayBatchV5,
} from '../src/Common/Observe/store-replay-codec'

const RECORD_COUNT = 15_000
const UPDATE_SIZE = 250
const LARGE_BATCH_BYTES = 8 * 1024 * 1024

let fails = 0
const timings: Array<{name: string, ms: number}> = []

function ok(condition: any, message: string) {
    if (!condition) {
        fails++
        console.log('  FAIL', message)
    } else {
        console.log('  OK  ', message)
    }
}

function delay(ms: number) {
    return new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })
}

async function measured(name: string, run: () => Promise<void>) {
    const started = performance.now()
    await run()
    const ms = performance.now() - started
    timings.push({name, ms})
    console.log(`  TIME ${name}: ${ms.toFixed(1)} ms`)
}

type Quote = {
    revision: number
    price: number
    amount: number
    active: boolean
    side: 'buy' | 'sell'
    venue: string
    note: string | null
    flags: [boolean, boolean, number]
    meta: {
        shard: number
        source: string
        optional: string | undefined
    }
}

type QuoteState = Record<string, Quote>
type tCodec = 'v1' | 'v2' | 'v3' | 'v4' | 'v5' | 'v6'
type CodecCounts = Record<tCodec, {line: number, since: number, keyframe: number, frame: number}>

function createRandom(seed: number) {
    let state = seed >>> 0
    return function seededRandom() {
        state += 0x6d2b79f5
        let value = state
        value = Math.imul(value ^ value >>> 15, value | 1)
        value ^= value + Math.imul(value ^ value >>> 7, value | 61)
        return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
    }
}

function keyFor(index: number) {
    return 'Q' + String(index).padStart(5, '0')
}

function quoteValue(index: number, revision: number, random: () => number): Quote {
    return {
        revision,
        price: Math.round((10 + random() * 90_000) * 100) / 100,
        amount: Math.round(random() * 1_000_000) / 1000,
        active: random() >= 0.5,
        side: random() >= 0.5 ? 'buy' : 'sell',
        venue: 'venue-' + (index % 17),
        note: revision % 7 == 0 ? null : 'update-' + revision + '-' + (index % 101),
        flags: [random() >= 0.5, random() >= 0.5, index % 31],
        meta: {
            shard: index % 64,
            source: revision == 0 ? 'seed' : 'seeded-stress',
            optional: revision % 3 == 0 ? undefined : 'present-' + (index % 13),
        },
    }
}

function createInitialState() {
    const random = createRandom(0x15_000)
    const state: QuoteState = {}
    for (let index = 0; index < RECORD_COUNT; index++) {
        state[keyFor(index)] = quoteValue(index, 0, random)
    }
    return state
}

function chooseIndices(random: () => number, count: number, excluded?: Set<number>) {
    const selected = new Set<number>()
    while (selected.size < count) {
        const index = Math.floor(random() * RECORD_COUNT)
        if (excluded?.has(index)) continue
        selected.add(index)
    }
    if (excluded) for (const index of selected) excluded.add(index)
    return [...selected]
}

async function applyRandomUpdates(
    store: Store<QuoteState>,
    random: () => number,
    revision: number,
    count = UPDATE_SIZE,
    excluded?: Set<number>,
) {
    const patches: StorePatch[] = []
    for (const index of chooseIndices(random, count, excluded)) {
        const key = keyFor(index)
        const value = quoteValue(index, revision, random)
        store.state[key] = value
        patches.push({path: [key], exists: true, value})
    }
    await flushReactive(store.state)
    return patches
}

async function settle(store: Store<any>) {
    await flushReactive(store.state)
    await Promise.resolve()
    await flushReactive(store.state)
}

function converged(source: Store<QuoteState>, mirror: Store<QuoteState>) {
    return isDeepStrictEqual(mirror.snapshot(), source.snapshot())
}

function storeKeyCount(store: Store<QuoteState>) {
    return Object.keys(store.snapshot()).length
}

function createCodecCounts(): CodecCounts {
    return {
        v1: {line: 0, since: 0, keyframe: 0, frame: 0},
        v2: {line: 0, since: 0, keyframe: 0, frame: 0},
        v3: {line: 0, since: 0, keyframe: 0, frame: 0},
        v4: {line: 0, since: 0, keyframe: 0, frame: 0},
        v5: {line: 0, since: 0, keyframe: 0, frame: 0},
        v6: {line: 0, since: 0, keyframe: 0, frame: 0},
    }
}

function observeWireRemote(remote: any, codec: tCodec, counts: CodecCounts) {
    const observed: any = {
        line: {
            on(cb: (wire: any) => void) {
                counts[codec].line++
                return remote.line.on(cb)
            },
        },
        since(seq: number) {
            counts[codec].since++
            return remote.since(seq)
        },
        keyframe() {
            counts[codec].keyframe++
            return remote.keyframe()
        },
    }
    if (remote.frame) {
        observed.frame = function observedFrame(seq: number, hint?: unknown) {
            counts[codec].frame++
            return remote.frame(seq, hint)
        }
    }
    if (remote.frameLine) {
        observed.frameLine = {
            on(cb: (wire: any) => void) {
                counts[codec].line++
                return remote.frameLine.on(cb)
            },
        }
    }
    return observed
}

function codecRemote(remote: StoreReplayRemote, selected: tCodec, counts: CodecCounts) {
    const source = remote.batch!
    const batch: any = observeWireRemote(source, 'v1', counts)
    // Each historical codec is tested through an intentionally isolated
    // capability surface. A complete new surface correctly selects V2 first.
    if (selected != 'v1') {
        batch[selected] = observeWireRemote(source[selected]!, selected, counts)
    }
    return {...remote, batch} as StoreReplayRemote
}

function onlyCodecUsed(counts: CodecCounts, selected: tCodec) {
    return (Object.keys(counts) as tCodec[]).every(function codecCountMatches(codec) {
        const value = counts[codec]
        if (codec == selected) return value.line == 1 && value.keyframe == 1
        return value.line == 0 && value.since == 0 && value.keyframe == 0 && value.frame == 0
    })
}

async function testPhysicalWires(source: Store<QuoteState>) {
    console.log('\n[large-store] one 250-patch drain is identical on physical v1-v6 wires')
    const exposed = exposeStoreReplay(source, {
        batch: {history: 16, maxItems: 1000, maxBytes: LARGE_BATCH_BYTES},
    })
    const batch = (exposed.api.replay as StoreReplayRemote).batch!
    const events: Record<tCodec, any[]> = {v1: [], v2: [], v3: [], v4: [], v5: [], v6: []}
    const rawV5: Uint8Array[] = []
    const offs = [
        batch.line.on(function collectV1(wire) { events.v1.push(decodeStoreReplayBatch(wire)) }),
        batch.v2!.line.on(function collectV2(wire) { events.v2.push(decodeStoreReplayBatchV2(wire)) }),
        batch.v3!.line.on(function collectV3(wire) { events.v3.push(decodeStoreReplayBatchV3(wire)) }),
        batch.v4!.line.on(function collectV4(wire) { events.v4.push(decodeStoreReplayBatchV4(wire)) }),
        batch.v5!.line.on(function collectV5(wire) {
            rawV5.push(wire)
            events.v5.push(decodeStoreReplayBatchV5(wire))
        }),
        batch.v6!.line.on(function collectV6(event) {
            events.v6.push(event)
        }),
    ]

    try {
        const expected = await applyRandomUpdates(source, createRandom(0x501), 1)
        const reference = events.v1[0]
        ok((Object.keys(events) as tCodec[]).every(function gotOnePhysicalEnvelope(codec) {
            return events[codec].length == 1
        }), 'v1-v6 each publish exactly one physical envelope')
        ok((Object.keys(events) as tCodec[]).every(function sharesCoordinates(codec) {
            return events[codec][0].seq == 1 && events[codec][0].ts == reference.ts
        }), 'v1-v6 share one seq/timestamp coordinate')
        ok((Object.keys(events) as tCodec[]).every(function preservesPatches(codec) {
            return isDeepStrictEqual(events[codec][0].event[0], expected)
        }), 'v1-v6 decode to the same ordered 250 patches without loss')
        ok(rawV5.length == 1 && rawV5[0][0] == 0x53 && rawV5[0][1] == 0x52
            && rawV5[0][2] == 0x42 && rawV5[0][3] == 5,
        'v5 is a real SRB binary byte frame')
        ok(!(events.v6[0] instanceof Uint8Array)
            && Array.isArray(events.v6[0]?.event?.[0]),
        'v6 exposes the logical ReplayEvent and adds no inner Store Uint8Array')
        const stats = exposed.batchStats!()
        ok(stats.sourceBatches == 1 && stats.sourcePatches == UPDATE_SIZE
            && stats.emittedBatches == 1 && stats.emittedPatches == UPDATE_SIZE,
        'batch accounting reports one 250-patch source drain and one wire envelope')
    } finally {
        for (const off of offs) off()
        exposed.close()
    }
}

async function testCodecSelection(source: Store<QuoteState>) {
    console.log('\n[large-store] 15k keyframe and negotiated v1-v6 selection')
    const exposed = exposeStoreReplay(source, {
        batch: {history: 32, maxItems: 1000, maxBytes: LARGE_BATCH_BYTES},
    })
    const remote = exposed.api.replay as StoreReplayRemote
    const codecs: tCodec[] = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']
    let revision = 10

    try {
        for (const codec of codecs) {
            const counts = createCodecCounts()
            const selectedRemote = codecRemote(remote, codec, counts)
            const mirror = createStore<QuoteState>({}, {drain: 'micro'})
            const sizes: number[] = []
            const errors: unknown[] = []
            const sync = syncStoreReplay(mirror, selectedRemote, {
                batch: true,
                onBatch(patches) { sizes.push(patches.length) },
                onError(error) { errors.push(error) },
            })
            await sync.ready
            await settle(mirror)

            if (errors.length) {
                ok(false, `${codec} 15k keyframe failed: ${String(errors[0])}`)
                sync()
                continue
            }

            ok(sync.mode == 'batch' && storeKeyCount(mirror) == RECORD_COUNT && converged(source, mirror),
                `${codec} initial root keyframe materializes all ${RECORD_COUNT} records`)
            ok(sizes.length == 1 && sizes[0] == 1,
                `${codec} full sync is one root patch instead of 15k live patches`)
            ok(onlyCodecUsed(counts, codec),
                `${codec} is the only physical surface subscribed/read`)

            sizes.length = 0
            const beforeSeq = sync.seq()
            await applyRandomUpdates(source, createRandom(0x700 + revision), revision++, 1)
            await settle(mirror)
            ok(sizes.length == 1 && sizes[0] == 1 && sync.seq() == beforeSeq + 1,
                `${codec} delivers one post-keyframe update at the next seq`)
            ok(converged(source, mirror), `${codec} mirror remains exactly converged after live delivery`)
            sync()
        }
    } finally {
        exposed.close()
    }
}

async function testDelayedBatching(source: Store<QuoteState>) {
    console.log('\n[large-store] deterministic batching windows at 0/1/5 ms')
    const cases = [
        {delayMs: 0, groups: [1, 1, 1], expected: [250, 250, 250]},
        {delayMs: 1, groups: [2, 1], expected: [500, 250]},
        {delayMs: 5, groups: [3], expected: [750]},
    ]
    let revision = 100

    for (const testCase of cases) {
        const exposed = exposeStoreReplay(source, {
            batch: {
                history: 16,
                maxDelayMs: testCase.delayMs,
                maxItems: 1000,
                maxBytes: LARGE_BATCH_BYTES,
            },
        })
        const mirror = createStore<QuoteState>({}, {drain: 'micro'})
        const appliedSizes: number[] = []
        const physicalSizes: number[] = []
        const physicalSeqs: number[] = []
        const errors: unknown[] = []
        const sync = syncStoreReplay(mirror, exposed.api.replay as StoreReplayRemote, {
            batch: true,
            onBatch(patches) { appliedSizes.push(patches.length) },
            onError(error) { errors.push(error) },
        })
        const offPhysical = exposed.replayBatch!.line.on(function collectDelayedBatch(event) {
            physicalSizes.push(event.event[0].length)
            physicalSeqs.push(event.seq)
        })

        try {
            await sync.ready
            if (errors.length) {
                ok(false, `${testCase.delayMs} ms initial 15k keyframe failed: ${String(errors[0])}`)
                continue
            }
            appliedSizes.length = 0
            for (let groupIndex = 0; groupIndex < testCase.groups.length; groupIndex++) {
                const group = testCase.groups[groupIndex]
                for (let round = 0; round < group; round++) {
                    await applyRandomUpdates(
                        source,
                        createRandom(0x9000 + revision),
                        revision++,
                    )
                }
                if (testCase.delayMs > 0) {
                    ok(physicalSizes.length == groupIndex,
                        `${testCase.delayMs} ms window retains its pending Store drains until timer expiry`)
                    await delay(Math.max(15, testCase.delayMs * 3))
                }
            }
            await settle(mirror)

            ok(isDeepStrictEqual(physicalSizes, testCase.expected),
                `${testCase.delayMs} ms physical grouping is ${testCase.expected.join('+')}`)
            ok(isDeepStrictEqual(appliedSizes, testCase.expected),
                `${testCase.delayMs} ms consumer observes the same physical boundaries`)
            ok(physicalSeqs.every(function seqIsContiguous(seq, index) { return seq == index + 1 })
                && sync.seq() == testCase.expected.length
                && exposed.replayBatch!.head() == testCase.expected.length,
            `${testCase.delayMs} ms seq is contiguous and committed once per envelope`)
            ok(physicalSizes.reduce(function sum(total, size) { return total + size }, 0) == UPDATE_SIZE * 3,
                `${testCase.delayMs} ms path delivers all 750 updates`)
            ok(converged(source, mirror), `${testCase.delayMs} ms path converges exactly`)
        } finally {
            offPhysical()
            sync()
            exposed.close()
        }
    }
}

async function testSingleUpdates(source: Store<QuoteState>) {
    console.log('\n[large-store] single-update cadence')
    const exposed = exposeStoreReplay(source, {
        batch: {history: 64, maxItems: 1000, maxBytes: LARGE_BATCH_BYTES},
    })
    const mirror = createStore<QuoteState>({}, {drain: 'micro'})
    const sizes: number[] = []
    const seqs: number[] = []
    const errors: unknown[] = []
    const sync = syncStoreReplay(mirror, exposed.api.replay as StoreReplayRemote, {
        batch: true,
        onBatch(patches) { sizes.push(patches.length) },
        onSeq(seq) { seqs.push(seq) },
        onError(error) { errors.push(error) },
    })

    try {
        await sync.ready
        if (errors.length) {
            ok(false, `single-update initial 15k keyframe failed: ${String(errors[0])}`)
            return
        }
        sizes.length = 0
        seqs.length = 0
        const random = createRandom(0x51_91e)
        const used = new Set<number>()
        for (let index = 0; index < 31; index++) {
            await applyRandomUpdates(source, random, 500 + index, 1, used)
        }
        await settle(mirror)

        ok(sizes.length == 31 && sizes.every(function isSingle(size) { return size == 1 }),
            '31 independent Store drains remain 31 one-patch batches')
        ok(seqs.length == 31 && seqs.every(function seqIsContiguous(seq, index) { return seq == index + 1 }),
            'single-update delivery has no duplicate or skipped seq')
        ok(sync.seq() == 31 && exposed.replayBatch!.head() == 31,
            'single-update consumer and producer finish on seq 31')
        ok(converged(source, mirror), 'single-update mirror converges exactly')
    } finally {
        sync()
        exposed.close()
    }
}

async function testReconnect(source: Store<QuoteState>) {
    console.log('\n[large-store] queue catch-up, compact frame and evicted-keyframe recovery')
    const exposed = exposeStoreReplay(source, {
        batch: {history: 4, maxItems: 1000, maxBytes: LARGE_BATCH_BYTES},
    })
    const rawRemote = exposed.api.replay as StoreReplayRemote
    const firstCounts = createCodecCounts()
    const firstMirror = createStore<QuoteState>({}, {drain: 'micro'})
    const firstErrors: unknown[] = []
    const first = syncStoreReplay(firstMirror, codecRemote(rawRemote, 'v6', firstCounts), {
        batch: true,
        onError(error) { firstErrors.push(error) },
    })
    await first.ready
    if (firstErrors.length) {
        ok(false, `reconnect initial 15k keyframe failed: ${String(firstErrors[0])}`)
        first()
        exposed.close()
        return
    }
    const initialSeq = first.seq()
    first()

    try {
        const used = new Set<number>()
        const random = createRandom(0xc0ffee)
        for (let round = 0; round < 4; round++) {
            await applyRandomUpdates(source, random, 700 + round, UPDATE_SIZE, used)
        }

        const queueCounts = createCodecCounts()
        const queueSizes: number[] = []
        const queueSeqs: number[] = []
        const queueErrors: unknown[] = []
        const queueSync = syncStoreReplay(firstMirror, codecRemote(rawRemote, 'v6', queueCounts), {
            batch: true,
            since: initialSeq,
            catchUp: 'queue',
            onBatch(patches) { queueSizes.push(patches.length) },
            onSeq(seq) { queueSeqs.push(seq) },
            onError(error) { queueErrors.push(error) },
        })
        await queueSync.ready
        await settle(firstMirror)
        ok(queueErrors.length == 0, 'short reconnect completes without recovery errors')
        ok(queueCounts.v6.since == 1 && queueCounts.v6.frame == 0 && queueCounts.v6.keyframe == 0,
            'short reconnect reads the exact v6 queue tail, not a snapshot')
        ok(isDeepStrictEqual(queueSizes, [250, 250, 250, 250])
            && isDeepStrictEqual(queueSeqs, [1, 2, 3, 4]),
        'queue catch-up delivers all four offline batches once and in order')
        ok(queueSizes.reduce(function sum(total, size) { return total + size }, 0) == 1000
            && queueSync.seq() == 4 && converged(source, firstMirror),
        'queue catch-up loses none of 1000 disjoint random updates')
        queueSync()

        for (let round = 0; round < 6; round++) {
            await applyRandomUpdates(source, random, 800 + round, UPDATE_SIZE, used)
        }

        const evictedCounts = createCodecCounts()
        const evictedSizes: number[] = []
        const evictedErrors: unknown[] = []
        const evicted = syncStoreReplay(firstMirror, codecRemote(rawRemote, 'v6', evictedCounts), {
            batch: true,
            since: 4,
            catchUp: 'queue',
            onBatch(patches) { evictedSizes.push(patches.length) },
            onError(error) { evictedErrors.push(error) },
        })
        await evicted.ready
        await settle(firstMirror)
        ok(evictedErrors.length == 0, 'evicted recovery completes without recovery errors')
        ok(evictedCounts.v6.since == 1 && evictedCounts.v6.keyframe == 1
            && evictedCounts.v6.frame == 0,
        'evicted queue tail falls back to one fresh v6 keyframe')
        ok(isDeepStrictEqual(evictedSizes, [1]) && evicted.seq() == 10
            && storeKeyCount(firstMirror) == RECORD_COUNT && converged(source, firstMirror),
        'evicted recovery replaces the complete 15k Store at the honest head')
        evicted()

        const frameSince = 10
        const frameUsed = new Set<number>()
        for (let round = 0; round < 3; round++) {
            await applyRandomUpdates(source, random, 900 + round, UPDATE_SIZE, frameUsed)
        }
        const frameCounts = createCodecCounts()
        const frameSizes: number[] = []
        const frameSeqs: number[] = []
        const frameErrors: unknown[] = []
        const frame = syncStoreReplay(firstMirror, codecRemote(rawRemote, 'v6', frameCounts), {
            batch: true,
            since: frameSince,
            onBatch(patches) { frameSizes.push(patches.length) },
            onSeq(seq) { frameSeqs.push(seq) },
            onError(error) { frameErrors.push(error) },
        })
        await frame.ready
        await settle(firstMirror)
        ok(frameErrors.length == 0, 'frame reconnect completes without recovery errors')
        ok(frameCounts.v6.frame == 1 && frameCounts.v6.since == 0 && frameCounts.v6.keyframe == 0,
            'default reconnect uses the universal-schema v6 frame surface')
        ok(isDeepStrictEqual(frameSizes, [750]) && isDeepStrictEqual(frameSeqs, [13])
            && frame.seq() == 13,
        'frame condenses three disjoint drains into one 750-patch envelope at the final seq')
        ok(converged(source, firstMirror), 'frame catch-up converges exactly without a full snapshot')
        frame()
    } finally {
        exposed.close()
    }
}

async function testLegacyFallback(source: Store<QuoteState>) {
    console.log('\n[large-store] new client against an old Store Replay server')
    const oldServer = exposeStoreReplay(source, {history: 1024})
    const mirror = createStore<QuoteState>({}, {drain: 'micro'})
    const sizes: number[] = []
    const seqs: number[] = []
    const errors: unknown[] = []
    const fallback = syncStoreReplay(mirror, oldServer.api.replay as StoreReplayRemote, {
        batch: true,
        onBatch(patches) { sizes.push(patches.length) },
        onSeq(seq) { seqs.push(seq) },
        onError(error) { errors.push(error) },
    })

    try {
        await fallback.ready
        await settle(mirror)
        ok(errors.length == 0 && fallback.mode == 'legacy'
            && storeKeyCount(mirror) == RECORD_COUNT && converged(source, mirror),
            `missing batch capability selects legacy and receives all ${RECORD_COUNT} initial rows`)
        sizes.length = 0
        seqs.length = 0
        const beforeSeq = fallback.seq()
        await applyRandomUpdates(source, createRandom(0x0dd5e7), 1000)
        await settle(mirror)

        ok(sizes.length == UPDATE_SIZE && sizes.every(function legacyIsPerPatch(size) { return size == 1 }),
            'old server keeps its 250 per-patch callback contract')
        ok(seqs.length == UPDATE_SIZE
            && seqs.every(function legacySeqIsContiguous(seq, index) { return seq == beforeSeq + index + 1 }),
        'legacy fallback receives every patch once in strict seq order')
        ok(fallback.seq() == beforeSeq + UPDATE_SIZE
            && oldServer.replay.head() == UPDATE_SIZE && converged(source, mirror),
        'legacy fallback commits all 250 changes and converges exactly')
    } finally {
        fallback()
        oldServer.close()
    }
}

async function testOldBatchClient(source: Store<QuoteState>) {
    console.log('\n[large-store] old v1 batch client against the new v1-v6 server')
    const exposed = exposeStoreReplay(source, {
        batch: {history: 8, maxItems: 1000, maxBytes: LARGE_BATCH_BYTES},
    })
    const remote = (exposed.api.replay as StoreReplayRemote).batch!
    const {
        v2: _removedV2,
        v3: _removedV3,
        v4: _removedV4,
        v5: _removedV5,
        v6: _removedV6,
        ...v1
    } = remote
    const mirror = createStore<QuoteState>({}, {drain: 'micro'})
    const sizes: number[] = []
    const oldClient = syncStoreReplayBatch(mirror, v1 as StoreReplayBatchRemote, {
        onBatch(patches) { sizes.push(patches.length) },
    })

    try {
        await oldClient.ready
        sizes.length = 0
        await applyRandomUpdates(source, createRandom(0x01dba7c), 1100)
        await settle(mirror)
        ok(isDeepStrictEqual(sizes, [250]) && oldClient.seq() == 1,
            'old v1 batch client consumes one unchanged 250-patch v1 envelope')
        ok(storeKeyCount(mirror) == RECORD_COUNT && converged(source, mirror),
            'old v1 batch client remains exactly converged with the new server')
    } finally {
        oldClient()
        exposed.close()
    }
}

async function main() {
    console.log(`\n[store-replay-large-stress] deterministic ${RECORD_COUNT}-record matrix`)
    const source = createStore<QuoteState>(createInitialState(), {drain: 'micro'})
    ok(storeKeyCount(source) == RECORD_COUNT, `seed contains exactly ${RECORD_COUNT} Store keys`)

    await measured('physical v1-v6 wire equality', function runPhysicalWireTest() {
        return testPhysicalWires(source)
    })
    await measured('15k keyframes and codec selection', function runCodecSelectionTest() {
        return testCodecSelection(source)
    })
    await measured('batch delays 0/1/5 ms', function runDelayedBatchingTest() {
        return testDelayedBatching(source)
    })
    await measured('31 single updates', function runSingleUpdateTest() {
        return testSingleUpdates(source)
    })
    await measured('reconnect and recovery', function runReconnectTest() {
        return testReconnect(source)
    })
    await measured('new client / old server fallback', function runLegacyFallbackTest() {
        return testLegacyFallback(source)
    })
    await measured('old v1 client / new server', function runOldBatchClientTest() {
        return testOldBatchClient(source)
    })

    console.log('\n[store-replay-large-stress] timings')
    for (const timing of timings) {
        console.log(`  ${timing.name.padEnd(38)} ${timing.ms.toFixed(1).padStart(9)} ms`)
    }
    console.log(`  peak-process-rss-now${''.padEnd(18)} ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1).padStart(9)} MiB`)
    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function largeStoreStressFailed(error) {
    console.error(error)
    process.exit(1)
})
