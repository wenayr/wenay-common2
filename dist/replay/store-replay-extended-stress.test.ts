// ============================================================================
// Extended Store Replay soak: many small writes, large blocks and mixed shapes.
// ============================================================================

import {performance} from 'node:perf_hooks'
import {isDeepStrictEqual} from 'node:util'
import {createStore, Store} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {
    exposeStoreReplay,
    StoreReplayBatchV6Remote,
    StoreReplayRemote,
    syncStoreReplay,
} from '../src/Common/Observe/store-replay'
import {
    decodeStoreReplayBatch,
    decodeStoreReplayBatchV2,
    decodeStoreReplayBatchV3,
    decodeStoreReplayBatchV4,
    decodeStoreReplayBatchV5,
} from '../src/Common/Observe/store-replay-codec'

const RECORD_COUNT = 15_000
const MAX_BATCH_ITEMS = 2048
const MAX_BATCH_BYTES = 8 * 1024 * 1024

type tState = Record<string, any>
type tCodec = 'v1' | 'v2' | 'v3' | 'v4' | 'v5' | 'v6'

type tWork = {
    drains: number
    writes: number
    patches: number
}

type tDeliveryMetrics = {
    frames: number
    patches: number
    bytes: number
    firstSeq: number
    lastSeq: number
    gaps: number
    minBatch: number
    maxBatch: number
}

type tReadCounts = {
    line: number
    since: number
    keyframe: number
    frame: number
}

let fails = 0
let sampledPeakRss = 0
const timings: Array<{
    name: string
    ms: number
    writes: number
    patches: number
    drains: number
    bytes?: number
}> = []

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

async function settle(store: Store<any>) {
    await flushReactive(store.state)
    await Promise.resolve()
    await flushReactive(store.state)
}

function sampleRss() {
    sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss)
}

async function measured(
    name: string,
    work: tWork,
    run: () => Promise<{bytes?: number} | void>,
) {
    const started = performance.now()
    const result = await run()
    const ms = performance.now() - started
    sampleRss()
    timings.push({name, ms, ...work, bytes: result?.bytes})
}

function keyFor(index: number) {
    return 'Q' + String(index).padStart(5, '0')
}

function createInitialState() {
    const state: tState = {}
    for (let index = 0; index < RECORD_COUNT; index++) {
        state[keyFor(index)] = {
            revision: 0,
            price: index + 0.125,
            amount: index % 997,
            active: index % 2 == 0,
            side: index % 3 == 0 ? 'buy' : 'sell',
            venue: 'seed-' + index % 17,
            note: index % 5 == 0 ? null : 'initial-' + index % 101,
            flags: [index % 2 == 0, index % 3 == 0, index % 31],
            meta: {shard: index % 64, source: 'extended-seed'},
        }
    }
    return state
}

function createWriter(store: Store<tState>) {
    let revision = 1

    function sameShapeValue(index: number) {
        const current = revision++
        return {
            revision: current,
            price: (current * 17 + index * 13) % 900_000 / 10,
            amount: (current * 29 + index) % 1_000_000 / 100,
            active: current % 2 == 0,
            side: current % 3 == 0 ? 'buy' : 'sell',
            venue: 'venue-' + index % 17,
            note: current % 7 == 0 ? null : 'same-shape-' + current % 257,
            flags: [current % 2 == 0, current % 5 == 0, index % 31],
            meta: {
                shard: index % 64,
                source: 'same-shape',
                epoch: Math.floor(current / 10_000),
            },
        }
    }

    function differentShapeValue(index: number) {
        const current = revision++
        switch (current % 8) {
            case 0:
                return {revision: current, kind: 'short', value: current % 2 == 0}
            case 1:
                return {
                    revision: current,
                    kind: 'nested',
                    value: {symbol: keyFor(index), levels: [{n: current}, {n: current + 1}]},
                }
            case 2:
                return {revision: current, kind: 'array', value: [current, 'Ж-' + index, false, null]}
            case 3:
                return {revision: current, kind: 'nullable', value: null, optional: false}
            case 4:
                return {
                    revision: current,
                    kind: 'wide',
                    a: current,
                    b: current + 1,
                    c: current + 2,
                    d: 'wide-' + index,
                    e: [index % 7, index % 11],
                }
            case 5:
                return {revision: current, kind: 'text', value: 'данные-' + current + '-' + index}
            case 6:
                return {revision: current, kind: 'number', integer: current, float: current / 17}
            default:
                return {revision: current, kind: 'empty-branches', object: {}, array: []}
        }
    }

    async function write(
        count: number,
        indexAt: (offset: number) => number,
        valueAt: (index: number, offset: number) => any = sameShapeValue,
    ) {
        for (let offset = 0; offset < count; offset++) {
            const index = indexAt(offset) % RECORD_COUNT
            store.state[keyFor(index)] = valueAt(index, offset)
        }
        await flushReactive(store.state)
    }

    return {write, sameShapeValue, differentShapeValue}
}

function createDeliveryMetrics(): tDeliveryMetrics {
    return {
        frames: 0,
        patches: 0,
        bytes: 0,
        firstSeq: -1,
        lastSeq: -1,
        gaps: 0,
        minBatch: Number.POSITIVE_INFINITY,
        maxBatch: 0,
    }
}

function recordDelivery(metrics: tDeliveryMetrics, seq: number, patches: number, bytes = 0) {
    if (metrics.frames == 0) metrics.firstSeq = seq
    else if (seq != metrics.lastSeq + 1) metrics.gaps++
    metrics.frames++
    metrics.patches += patches
    metrics.bytes += bytes
    metrics.lastSeq = seq
    metrics.minBatch = Math.min(metrics.minBatch, patches)
    metrics.maxBatch = Math.max(metrics.maxBatch, patches)
}

function wireRemoteFor(codec: tCodec, remote: StoreReplayRemote) {
    const source = remote.batch!
    const batch: any = {
        line: source.line,
        since: source.since,
        keyframe: source.keyframe,
        frame: source.frame,
        frameLine: source.frameLine,
    }
    if (codec != 'v1') batch.v2 = source.v2
    if (codec == 'v3' || codec == 'v4' || codec == 'v5' || codec == 'v6') batch.v3 = source.v3
    if (codec == 'v4' || codec == 'v5' || codec == 'v6') batch.v4 = source.v4
    if (codec == 'v5' || codec == 'v6') batch.v5 = source.v5
    if (codec == 'v6') batch.v6 = source.v6
    return {...remote, batch} as StoreReplayRemote
}

function physicalRemoteFor(codec: tCodec, remote: StoreReplayRemote) {
    const batch = remote.batch!
    if (codec == 'v1') return batch
    if (codec == 'v2') return batch.v2!
    if (codec == 'v3') return batch.v3!
    if (codec == 'v4') return batch.v4!
    if (codec == 'v5') return batch.v5!
    return batch.v6!
}

function decodeWire(codec: tCodec, wire: any) {
    if (codec == 'v1') return decodeStoreReplayBatch(wire)
    if (codec == 'v2') return decodeStoreReplayBatchV2(wire)
    if (codec == 'v3') return decodeStoreReplayBatchV3(wire)
    if (codec == 'v4') return decodeStoreReplayBatchV4(wire)
    if (codec == 'v5') return decodeStoreReplayBatchV5(wire)
    return wire
}

function wireBytes(codec: tCodec, wire: any) {
    if (codec == 'v5') return wire.byteLength
    return Buffer.byteLength(JSON.stringify(wire))
}

function observePhysicalWire(
    codec: tCodec,
    remote: StoreReplayRemote,
    metrics: tDeliveryMetrics,
) {
    return physicalRemoteFor(codec, remote).line.on(function collectPhysicalWire(wire: any) {
        const event = decodeWire(codec, wire)
        recordDelivery(metrics, event.seq, event.event[0].length, wireBytes(codec, wire))
    })
}

function stateMatches(source: Store<tState>, mirror: Store<tState>) {
    return isDeepStrictEqual(source.snapshot(), mirror.snapshot())
}

function firstStateDifference(source: Store<tState>, mirror: Store<tState>) {
    const expected = source.snapshot()
    const actual = mirror.snapshot()
    const keys = new Set([...Reflect.ownKeys(expected), ...Reflect.ownKeys(actual)])
    for (const key of keys) {
        if (!isDeepStrictEqual(expected[key as any], actual[key as any])) {
            return {
                key: String(key),
                expected: describeValue(expected[key as any]),
                actual: describeValue(actual[key as any]),
            }
        }
    }
    return null
}

function describeValue(value: any) {
    if (typeof value == 'string') return `string(${value.length}) ${value.slice(0, 32)}`
    if (value instanceof Uint8Array) return `Uint8Array(${value.byteLength})`
    if (value instanceof Map) return `Map(${value.size})`
    if (value instanceof Set) return `Set(${value.size})`
    if (Array.isArray(value)) return `Array(${value.length})`
    if (value && typeof value == 'object') {
        return `${value.constructor?.name ?? 'Object'}(${Reflect.ownKeys(value).slice(0, 8).join(',')})`
    }
    return `${typeof value}(${String(value)})`
}

function addWork(total: tWork, drains: number, writes: number, patches = writes) {
    total.drains += drains
    total.writes += writes
    total.patches += patches
}

async function runStandardWorkload(writer: ReturnType<typeof createWriter>, salt: number) {
    const work = {drains: 0, writes: 0, patches: 0}

    for (let round = 0; round < 400; round++) {
        await writer.write(1, function tinyHotIndex() {
            return (salt * 97 + round) % 64
        })
    }
    addWork(work, 400, 400)

    for (let round = 0; round < 24; round++) {
        await writer.write(250, function uniformIndex(offset) {
            return (salt * 313 + round * 811 + offset * 37) % RECORD_COUNT
        })
    }
    addWork(work, 24, 6000)

    for (let round = 0; round < 24; round++) {
        await writer.write(250, function repeatedHotIndex(offset) {
            return (salt * 29 + offset) % 32
        })
    }
    addWork(work, 24, 6000, 24 * 32)

    for (let round = 0; round < 12; round++) {
        await writer.write(
            250,
            function variedIndex(offset) {
                return (salt * 419 + round * 617 + offset * 41) % RECORD_COUNT
            },
            writer.differentShapeValue,
        )
    }
    addWork(work, 12, 3000)

    for (let round = 0; round < 8; round++) {
        const start = (salt * 1237 + round * 2000) % RECORD_COUNT
        await writer.write(2000, function sequentialIndex(offset) {
            return (start + offset) % RECORD_COUNT
        })
    }
    addWork(work, 8, 16_000)

    return work
}

async function runCodecMatrix(
    source: Store<tState>,
    mirror: Store<tState>,
    writer: ReturnType<typeof createWriter>,
) {
    console.log('\n[extended-store] v1-v6 sustained mixed-size matrix')
    const exposed = exposeStoreReplay(source, {
        batch: {
            history: 8,
            maxItems: MAX_BATCH_ITEMS,
            maxBytes: MAX_BATCH_BYTES,
        },
    })
    const remote = exposed.api.replay as StoreReplayRemote
    const codecs: tCodec[] = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']

    try {
        for (let codecIndex = 0; codecIndex < codecs.length; codecIndex++) {
            const codec = codecs[codecIndex]
            const selected = wireRemoteFor(codec, remote)
            const errors: unknown[] = []
            let collecting = false
            const applied = createDeliveryMetrics()
            const sync = syncStoreReplay(mirror, selected, {
                batch: true,
                onBatch(patches) {
                    if (collecting) {
                        applied.frames++
                        applied.patches += patches.length
                        applied.minBatch = Math.min(applied.minBatch, patches.length)
                        applied.maxBatch = Math.max(applied.maxBatch, patches.length)
                    }
                },
                onSeq(seq) {
                    if (!collecting) return
                    if (applied.firstSeq == -1) applied.firstSeq = seq
                    else if (seq != applied.lastSeq + 1) applied.gaps++
                    applied.lastSeq = seq
                },
                onError(error) { errors.push(error) },
            })

            await sync.ready
            await settle(mirror)
            ok(errors.length == 0 && stateMatches(source, mirror),
                `${codec} starts from an exact reused-mirror 15k keyframe`)

            const startSeq = sync.seq()
            const before = exposed.batchStats!()
            const physical = createDeliveryMetrics()
            const offPhysical = observePhysicalWire(codec, remote, physical)
            collecting = true
            let work = {drains: 0, writes: 0, patches: 0}
            const started = performance.now()

            try {
                work = await runStandardWorkload(writer, codecIndex + 1)
                await settle(mirror)
            } finally {
                collecting = false
                offPhysical()
            }

            const elapsed = performance.now() - started
            const after = exposed.batchStats!()
            timings.push({
                name: codec + ' mixed live',
                ms: elapsed,
                writes: work.writes,
                patches: work.patches,
                drains: work.drains,
                bytes: physical.bytes,
            })
            sampleRss()

            ok(physical.frames == work.drains && physical.patches == work.patches
                && physical.firstSeq == startSeq + 1 && physical.lastSeq == startSeq + work.drains
                && physical.gaps == 0,
            `${codec} physical wire carries ${work.patches} patches from ${work.writes} writes in ${work.drains} frames`)
            ok(applied.frames == work.drains && applied.patches == work.patches
                && applied.firstSeq == startSeq + 1 && applied.lastSeq == startSeq + work.drains
                && applied.gaps == 0,
            `${codec} consumer observes the same exact frame and seq boundaries`)
            ok(applied.minBatch == 1 && applied.maxBatch == 2000
                && physical.minBatch == 1 && physical.maxBatch == 2000,
            `${codec} covers one-patch writes through 2000-patch sequential blocks`)
            ok(work.writes - work.patches == 24 * (250 - 32),
                `${codec} explicitly accounts for latest-per-path coalescing in hot-key drains`)
            ok(after.sourceBatches - before.sourceBatches == work.drains
                && after.sourcePatches - before.sourcePatches == work.patches
                && after.emittedBatches - before.emittedBatches == work.drains
                && after.emittedPatches - before.emittedPatches == work.patches,
            `${codec} producer accounting has no hidden amplification or loss`)
            ok(physical.bytes > work.patches && sync.seq() == exposed.replayBatch!.head(),
                `${codec} records non-empty wire bytes and finishes at the producer head`)
            ok(errors.length == 0 && stateMatches(source, mirror),
                `${codec} final snapshot is exact after hot, uniform, varied and sequential writes`)
            sync()
        }

        return exposed
    } catch (error) {
        exposed.close()
        throw error
    }
}

function createCountedV6Remote(remote: StoreReplayRemote, counts: tReadCounts) {
    const v6 = remote.batch!.v6!
    const counted: StoreReplayBatchV6Remote = {
        line: {
            on(cb) {
                counts.line++
                return v6.line.on(cb)
            },
        },
        async since(seq) {
            counts.since++
            return v6.since(seq)
        },
        async keyframe() {
            counts.keyframe++
            return v6.keyframe()
        },
    }
    if (v6.frame) {
        counted.frame = async function countedFrame(seq, hint) {
            counts.frame++
            return v6.frame!(seq, hint)
        }
    }
    if (v6.frameLine) counted.frameLine = v6.frameLine
    return {
        ...remote,
        batch: {
            ...remote.batch!,
            v6: counted,
        },
    }
}

function createReadCounts(): tReadCounts {
    return {line: 0, since: 0, keyframe: 0, frame: 0}
}

async function reconnect(
    mirror: Store<tState>,
    remote: StoreReplayRemote,
    since: number | undefined,
    catchUp: 'tail' | undefined,
) {
    const counts = createReadCounts()
    const sizes: number[] = []
    const seqs: number[] = []
    const errors: unknown[] = []
    const sync = syncStoreReplay(mirror, createCountedV6Remote(remote, counts), {
        batch: true,
        since,
        catchUp,
        onBatch(patches) { sizes.push(patches.length) },
        onSeq(seq) { seqs.push(seq) },
        onError(error) { errors.push(error) },
    })
    await sync.ready
    await settle(mirror)
    return {sync, counts, sizes, seqs, errors}
}

async function runReconnectCycles(
    source: Store<tState>,
    mirror: Store<tState>,
    writer: ReturnType<typeof createWriter>,
    exposed: ReturnType<typeof exposeStoreReplay>,
) {
    console.log('\n[extended-store] repeated queue, frame and evicted-keyframe reconnects')
    const remote = exposed.api.replay as StoreReplayRemote
    let active = await reconnect(mirror, remote, undefined, undefined)
    ok(active.errors.length == 0 && active.counts.keyframe == 1 && stateMatches(source, mirror),
        'reconnect fixture starts from one exact v6 keyframe')
    let cursor = active.sync.seq()
    active.sync()

    const work = {drains: 0, writes: 0, patches: 0}
    for (let cycle = 0; cycle < 4; cycle++) {
        const queueSizes = [1, 7, 31, 250, 511, 37]
        for (let round = 0; round < queueSizes.length; round++) {
            const size = queueSizes[round]
            await writer.write(size, function queueIndex(offset) {
                return (cycle * 1877 + round * 613 + offset * 43) % RECORD_COUNT
            })
        }
        addWork(work, queueSizes.length, queueSizes.reduce(function sum(total, size) {
            return total + size
        }, 0))

        active = await reconnect(mirror, remote, cursor, 'tail')
        ok(active.errors.length == 0 && active.counts.since == 1
            && active.counts.frame == 0 && active.counts.keyframe == 0,
        `cycle ${cycle + 1}: short reconnect uses the exact queue tail`)
        ok(isDeepStrictEqual(active.sizes, queueSizes)
            && active.seqs.every(function queueSeqIsContiguous(seq, index) {
                return seq == cursor + index + 1
            }),
        `cycle ${cycle + 1}: queue preserves six mixed physical boundaries in order`)
        ok(stateMatches(source, mirror), `cycle ${cycle + 1}: queue snapshot converges exactly`)
        cursor = active.sync.seq()
        active.sync()

        for (let round = 0; round < 6; round++) {
            const start = (cycle * 4000 + round * 250) % RECORD_COUNT
            await writer.write(250, function frameIndex(offset) {
                return (start + offset) % RECORD_COUNT
            })
        }
        addWork(work, 6, 1500)

        active = await reconnect(mirror, remote, cursor, undefined)
        ok(active.errors.length == 0 && active.counts.frame == 1
            && active.counts.since == 0 && active.counts.keyframe == 0,
        `cycle ${cycle + 1}: default reconnect reads one compact frame`)
        ok(isDeepStrictEqual(active.sizes, [1500])
            && isDeepStrictEqual(active.seqs, [cursor + 6]),
        `cycle ${cycle + 1}: frame condenses six disjoint 250-patch drains at the honest seq`)
        ok(stateMatches(source, mirror), `cycle ${cycle + 1}: frame snapshot converges exactly`)
        cursor = active.sync.seq()
        active.sync()

        for (let round = 0; round < 12; round++) {
            await writer.write(1, function evictIndex() {
                return (cycle * 997 + round * 101) % RECORD_COUNT
            })
        }
        addWork(work, 12, 12)

        active = await reconnect(mirror, remote, cursor, 'tail')
        ok(active.errors.length == 0 && active.counts.since == 1
            && active.counts.keyframe == 1 && active.counts.frame == 0,
        `cycle ${cycle + 1}: evicted queue falls back to one fresh keyframe`)
        ok(isDeepStrictEqual(active.sizes, [1])
            && isDeepStrictEqual(active.seqs, [cursor + 12]),
        `cycle ${cycle + 1}: recovery replaces the Store at the current producer head`)
        ok(stateMatches(source, mirror), `cycle ${cycle + 1}: keyframe snapshot converges exactly`)
        cursor = active.sync.seq()
        active.sync()
    }

    ok(cursor == exposed.replayBatch!.head(),
        'all twelve reconnects finish at the exact final batch coordinate')
    ok(isDeepStrictEqual(work, {drains: 96, writes: 9396, patches: 9396}),
        'reconnect workload counters are derived from all completed cycles')
    return work
}

async function runTimingWindows(
    source: Store<tState>,
    mirror: Store<tState>,
    writer: ReturnType<typeof createWriter>,
) {
    console.log('\n[extended-store] batching windows at 0/1/5/20 ms')
    const cases = [
        {delayMs: 0, windows: 64, drainsPerWindow: 1, patchesPerDrain: 1},
        {delayMs: 1, windows: 12, drainsPerWindow: 4, patchesPerDrain: 8},
        {delayMs: 5, windows: 8, drainsPerWindow: 8, patchesPerDrain: 16},
        {delayMs: 20, windows: 4, drainsPerWindow: 16, patchesPerDrain: 32},
    ]

    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
        const testCase = cases[caseIndex]
        const exposed = exposeStoreReplay(source, {
            batch: {
                history: 4,
                maxDelayMs: testCase.delayMs,
                maxItems: MAX_BATCH_ITEMS,
                maxBytes: MAX_BATCH_BYTES,
            },
        })
        const remote = exposed.api.replay as StoreReplayRemote
        const errors: unknown[] = []
        const appliedSizes: number[] = []
        const sync = syncStoreReplay(mirror, remote, {
            batch: true,
            onBatch(patches) { appliedSizes.push(patches.length) },
            onError(error) { errors.push(error) },
        })
        await sync.ready
        appliedSizes.length = 0
        const physicalSizes: number[] = []
        const physicalSeqs: number[] = []
        const off = exposed.replayBatch!.line.on(function collectTimedBatch(event) {
            physicalSizes.push(event.event[0].length)
            physicalSeqs.push(event.seq)
        })
        const startSeq = sync.seq()
        const work = {
            drains: testCase.windows * testCase.drainsPerWindow,
            writes: testCase.windows * testCase.drainsPerWindow * testCase.patchesPerDrain,
            patches: testCase.windows * testCase.drainsPerWindow * testCase.patchesPerDrain,
        }
        const started = performance.now()

        try {
            for (let window = 0; window < testCase.windows; window++) {
                for (let drain = 0; drain < testCase.drainsPerWindow; drain++) {
                    await writer.write(testCase.patchesPerDrain, function timedIndex(offset) {
                        return (
                            caseIndex * 3001
                            + window * testCase.drainsPerWindow * testCase.patchesPerDrain
                            + drain * testCase.patchesPerDrain
                            + offset
                        ) % RECORD_COUNT
                    })
                }
                if (testCase.delayMs > 0) {
                    ok(physicalSizes.length == window,
                        `${testCase.delayMs} ms window stays pending until its timer`)
                    await delay(testCase.delayMs + 10)
                }
            }
            await settle(mirror)

            const expectedSize = testCase.drainsPerWindow * testCase.patchesPerDrain
            ok(physicalSizes.length == testCase.windows
                && physicalSizes.every(function timedSizeMatches(size) { return size == expectedSize }),
            `${testCase.delayMs} ms produces ${testCase.windows} exact ${expectedSize}-patch windows`)
            ok(isDeepStrictEqual(appliedSizes, physicalSizes),
                `${testCase.delayMs} ms consumer sees the physical window boundaries unchanged`)
            ok(physicalSeqs.every(function timedSeqIsContiguous(seq, index) {
                return seq == startSeq + index + 1
            }) && sync.seq() == startSeq + testCase.windows,
            `${testCase.delayMs} ms window seq is contiguous`)
            ok(errors.length == 0 && stateMatches(source, mirror),
                `${testCase.delayMs} ms final snapshot converges exactly`)
        } finally {
            off()
            sync()
            exposed.close()
        }

        timings.push({
            name: testCase.delayMs + ' ms timed windows',
            ms: performance.now() - started,
            ...work,
        })
        sampleRss()
    }
}

async function runLegacySoak(
    source: Store<tState>,
    mirror: Store<tState>,
    writer: ReturnType<typeof createWriter>,
) {
    console.log('\n[extended-store] new client on the legacy per-patch route')
    const exposed = exposeStoreReplay(source, {history: 8})
    const remote = exposed.api.replay as StoreReplayRemote
    const errors: unknown[] = []
    const applied = createDeliveryMetrics()
    let collecting = false
    const sync = syncStoreReplay(mirror, remote, {
        batch: true,
        onBatch(patches) {
            if (collecting) {
                applied.frames++
                applied.patches += patches.length
                applied.minBatch = Math.min(applied.minBatch, patches.length)
                applied.maxBatch = Math.max(applied.maxBatch, patches.length)
            }
        },
        onSeq(seq) {
            if (!collecting) return
            if (applied.firstSeq == -1) applied.firstSeq = seq
            else if (seq != applied.lastSeq + 1) applied.gaps++
            applied.lastSeq = seq
        },
        onError(error) { errors.push(error) },
    })
    await sync.ready
    await settle(mirror)
    const startSeq = sync.seq()
    const physical = createDeliveryMetrics()
    const off = exposed.replay.line.on(function collectLegacyEvent(event) {
        recordDelivery(
            physical,
            event.seq,
            1,
            Buffer.byteLength(JSON.stringify(event)),
        )
    })
    collecting = true
    const work = {drains: 0, writes: 0, patches: 0}
    const started = performance.now()

    try {
        for (let round = 0; round < 1000; round++) {
            await writer.write(1, function legacyTinyIndex() { return round % 64 })
        }
        addWork(work, 1000, 1000)

        for (let round = 0; round < 40; round++) {
            await writer.write(250, function legacyMediumIndex(offset) {
                return (round * 521 + offset * 43) % RECORD_COUNT
            })
        }
        addWork(work, 40, 10_000)

        for (let round = 0; round < 5; round++) {
            const start = round * 2777
            await writer.write(2000, function legacyLargeIndex(offset) {
                return (start + offset) % RECORD_COUNT
            })
        }
        addWork(work, 5, 10_000)
        await settle(mirror)

        ok(sync.mode == 'legacy' && physical.frames == work.patches
            && physical.patches == work.patches,
        `legacy route carries all ${work.patches} writes as per-patch events`)
        ok(physical.firstSeq == startSeq + 1
            && physical.lastSeq == startSeq + work.patches && physical.gaps == 0,
        'legacy physical event coordinates stay contiguous across tiny and large drains')
        ok(applied.frames == work.patches && applied.patches == work.patches
            && applied.minBatch == 1 && applied.maxBatch == 1
            && applied.firstSeq == startSeq + 1
            && applied.lastSeq == startSeq + work.patches && applied.gaps == 0,
        'new consumer preserves the old one-patch callback and seq contract')
        ok(errors.length == 0 && sync.seq() == exposed.replay.head()
            && stateMatches(source, mirror),
        'legacy route finishes at an exact final snapshot')
    } finally {
        collecting = false
        off()
        sync()
        exposed.close()
    }

    timings.push({
        name: 'legacy mixed live',
        ms: performance.now() - started,
        writes: work.writes,
        patches: work.patches,
        drains: work.drains,
        bytes: physical.bytes,
    })
    sampleRss()
}

function richValue(index: number, revision: number) {
    switch (revision % 15) {
        case 0:
            return false
        case 1:
            return true
        case 2:
            return null
        case 3:
            return undefined
        case 4:
            return revision % 2 ? Number.NaN : Number.POSITIVE_INFINITY
        case 5:
            return -0
        case 6:
            return 'rich-Ж-' + revision + '-' + index
        case 7:
            return new Date(1_700_000_000_000 + revision)
        case 8:
            return new Map<any, any>([
                ['revision', revision],
                ['nested', new Set<any>([false, 'map-' + index, index])],
            ])
        case 9:
            return new Set<any>([revision, 'set-' + index, null])
        case 10:
            return new RegExp('quote-' + index, revision % 2 ? 'gi' : 'u')
        case 11:
            return BigInt(revision) * 1_000_000_007n
        case 12:
            return new Uint8Array([
                revision & 255,
                revision >>> 8 & 255,
                index & 255,
                index >>> 8 & 255,
            ])
        case 13:
            return [revision, false, undefined, {index, text: 'nested-rich'}]
        default:
            return {
                revision,
                falseValue: false,
                trueValue: true,
                nullValue: null,
                undefinedValue: undefined,
                nested: {bytes: new Uint8Array([1, 2, 3]), date: new Date(revision)},
            }
    }
}

function createBlockValue(size: number, seed: number) {
    if (seed % 2 == 0) {
        const bytes = new Uint8Array(size)
        for (let index = 0; index < bytes.length; index++) {
            bytes[index] = seed * 31 + index * 17 & 255
        }
        return bytes
    }
    return {
        kind: 'text-block',
        seed,
        payload: String.fromCharCode(65 + seed % 26).repeat(size),
    }
}

async function runV5RichSoak(
    source: Store<tState>,
    mirror: Store<tState>,
    writer: ReturnType<typeof createWriter>,
) {
    console.log('\n[extended-store] v5 long soak with rich types and byte-size steps')
    const exposed = exposeStoreReplay(source, {
        batch: {
            history: 8,
            maxItems: MAX_BATCH_ITEMS,
            maxBytes: MAX_BATCH_BYTES,
        },
    })
    const remote = exposed.api.replay as StoreReplayRemote
    const selected = wireRemoteFor('v5', remote)
    const errors: unknown[] = []
    let collecting = false
    const applied = createDeliveryMetrics()
    const sync = syncStoreReplay(mirror, selected, {
        batch: true,
        onBatch(patches) {
            if (!collecting) return
            applied.frames++
            applied.patches += patches.length
            applied.minBatch = Math.min(applied.minBatch, patches.length)
            applied.maxBatch = Math.max(applied.maxBatch, patches.length)
        },
        onSeq(seq) {
            if (!collecting) return
            if (applied.firstSeq == -1) applied.firstSeq = seq
            else if (seq != applied.lastSeq + 1) applied.gaps++
            applied.lastSeq = seq
        },
        onError(error) { errors.push(error) },
    })
    await sync.ready
    await settle(mirror)
    const startSeq = sync.seq()
    const physical = createDeliveryMetrics()
    const off = observePhysicalWire('v5', remote, physical)
    const before = exposed.batchStats!()
    collecting = true
    const work = {drains: 0, writes: 0, patches: 0}
    const started = performance.now()
    let richRevision = 1
    let blockPayloadBytes = 0

    try {
        for (let round = 0; round < 2500; round++) {
            await writer.write(1, function v5TinyHotIndex() { return round % 64 })
        }
        addWork(work, 2500, 2500)

        for (let round = 0; round < 200; round++) {
            await writer.write(250, function v5UniformIndex(offset) {
                return (round * 811 + offset * 37) % RECORD_COUNT
            })
        }
        addWork(work, 200, 50_000)

        for (let round = 0; round < 50; round++) {
            const start = round * 1543 % RECORD_COUNT
            await writer.write(2000, function v5LargeSequentialIndex(offset) {
                return (start + offset) % RECORD_COUNT
            })
        }
        addWork(work, 50, 100_000)

        for (let round = 0; round < 200; round++) {
            await writer.write(250, function v5RepeatedHotIndex(offset) {
                return offset % 32
            })
        }
        addWork(work, 200, 50_000, 200 * 32)

        for (let round = 0; round < 100; round++) {
            await writer.write(
                250,
                function v5RichIndex(offset) {
                    return (round * 977 + offset * 53) % RECORD_COUNT
                },
                function v5RichValue(index) {
                    const next = richValue(index, richRevision++)
                    const current = source.state[keyFor(index)]
                    return Object.is(current, next)
                        ? {kind: 'forced-change', revision: richRevision, value: next}
                        : next
                },
            )
        }
        addWork(work, 100, 25_000)

        for (let layoutDrain = 0; layoutDrain < 5; layoutDrain++) {
            await writer.write(
                250,
                function layoutIndex(offset) {
                    return (layoutDrain * 250 + offset + 8000) % RECORD_COUNT
                },
                function uniqueLayoutValue(index, offset) {
                    const layout = layoutDrain * 250 + offset
                    return {
                        revision: richRevision++,
                        ['layout_' + layout]: layout,
                        index,
                    }
                },
            )
        }
        addWork(work, 5, 1250)

        const bytesBeforeBlocks = physical.bytes
        const patchesBeforeBlocks = physical.patches
        const blockCases = [
            {count: 128, size: 4 * 1024},
            {count: 32, size: 64 * 1024},
            {count: 8, size: 256 * 1024},
            // String leaves have a deliberate 1,000,000 code-unit safety ceiling.
            {count: 4, size: 900_000},
        ]
        for (let blockCase = 0; blockCase < blockCases.length; blockCase++) {
            const spec = blockCases[blockCase]
            blockPayloadBytes += spec.count * spec.size
            await writer.write(
                spec.count,
                function blockIndex(offset) {
                    return 12_000 + blockCase * 256 + offset
                },
                function blockValue(_index, offset) {
                    return createBlockValue(spec.size, blockCase * 257 + offset)
                },
            )
        }
        addWork(work, blockCases.length, blockCases.reduce(function countBlocks(total, spec) {
            return total + spec.count
        }, 0))

        await settle(mirror)
        const after = exposed.batchStats!()

        ok(physical.patches == work.patches && applied.patches == work.patches
            && physical.frames == applied.frames,
        `v5 soak delivers ${work.patches} patches from ${work.writes} writes on identical boundaries`)
        ok(physical.firstSeq == startSeq + 1 && applied.firstSeq == startSeq + 1
            && physical.lastSeq == sync.seq() && applied.lastSeq == sync.seq()
            && physical.gaps == 0 && applied.gaps == 0,
        'v5 soak stays strictly ordered through thousands of tiny drains and large blocks')
        ok(physical.minBatch == 1 && applied.minBatch == 1
            && physical.maxBatch == 2000 && applied.maxBatch == 2000,
        'v5 soak spans one-patch writes through 2000-patch batches')
        ok(physical.bytes > blockPayloadBytes
            && physical.bytes - bytesBeforeBlocks > blockPayloadBytes
            && physical.patches - patchesBeforeBlocks == 172
            && after.sourceBatches - before.sourceBatches == work.drains
            && after.sourcePatches - before.sourcePatches == work.patches
            && after.emittedBatches - before.emittedBatches == physical.frames
            && after.emittedPatches - before.emittedPatches == work.patches,
        `v5 accounts for all patches, frames and ${(blockPayloadBytes / 1024 / 1024).toFixed(1)} MiB block payload`)
        const difference = firstStateDifference(source, mirror)
        if (errors.length) console.log('  rich-v5 errors:', errors.map(String))
        if (difference) console.log('  rich-v5 first difference:', difference)
        ok(errors.length == 0 && sync.seq() == exposed.replayBatch!.head()
            && difference == null,
        'v5 rich primitives, Date/Map/Set/RegExp/BigInt/bytes and 1250 layouts converge exactly')
    } finally {
        collecting = false
        off()
        sync()
        exposed.close()
    }

    timings.push({
        name: 'v5 rich and block soak',
        ms: performance.now() - started,
        writes: work.writes,
        patches: work.patches,
        drains: work.drains,
        bytes: physical.bytes,
    })
    sampleRss()
}

async function main() {
    console.log(`\n[store-replay-extended-stress] ${RECORD_COUNT} records, mixed I/O-size profile`)
    const source = createStore<tState>(createInitialState(), {drain: 'micro'})
    const mirror = createStore<tState>({}, {drain: 'micro'})
    const writer = createWriter(source)
    sampleRss()
    ok(Object.keys(source.snapshot()).length == RECORD_COUNT,
        `fixture contains exactly ${RECORD_COUNT} records`)

    const matrixExposure = await runCodecMatrix(source, mirror, writer)
    const reconnectWork = {drains: 0, writes: 0, patches: 0}
    await measured(
        'v6 reconnect matrix',
        reconnectWork,
        async function measuredReconnects() {
            Object.assign(
                reconnectWork,
                await runReconnectCycles(source, mirror, writer, matrixExposure),
            )
        },
    )
    matrixExposure.close()

    await runTimingWindows(source, mirror, writer)
    await runLegacySoak(source, mirror, writer)
    await runV5RichSoak(source, mirror, writer)

    const cleanupKey = keyFor(14_999)
    const mirrorBeforeCleanupProbe = mirror.snapshot()[cleanupKey]
    source.state[cleanupKey] = {cleanupProbe: true}
    await flushReactive(source.state)
    await settle(mirror)
    ok(isDeepStrictEqual(mirror.snapshot()[cleanupKey], mirrorBeforeCleanupProbe),
        'closed replay routes leave no live consumer or delayed timer behind')

    const totalMs = timings.reduce(function sum(total, timing) { return total + timing.ms }, 0)
    const totalPatches = timings.reduce(function sum(total, timing) {
        return total + timing.patches
    }, 0)
    const totalWrites = timings.reduce(function sum(total, timing) {
        return total + timing.writes
    }, 0)
    const totalDrains = timings.reduce(function sum(total, timing) {
        return total + timing.drains
    }, 0)

    console.log('\n[store-replay-extended-stress] measured profiles')
    for (const timing of timings) {
        const rate = timing.ms > 0 ? timing.patches / timing.ms * 1000 : 0
        const bytes = timing.bytes == undefined
            ? ''
            : ` ${(timing.bytes / 1024 / 1024).toFixed(1).padStart(7)} MiB`
        console.log(
            `  ${timing.name.padEnd(27)}`
            + ` ${timing.ms.toFixed(1).padStart(9)} ms`
            + ` ${String(timing.writes).padStart(8)} writes`
            + ` ${String(timing.patches).padStart(8)} patches`
            + ` ${String(timing.drains).padStart(5)} drains`
            + ` ${rate.toFixed(0).padStart(8)} patch/s`
            + bytes,
        )
    }
    console.log(
        `  ${'TOTAL'.padEnd(27)}`
        + ` ${totalMs.toFixed(1).padStart(9)} ms`
        + ` ${String(totalWrites).padStart(8)} writes`
        + ` ${String(totalPatches).padStart(8)} patches`
        + ` ${String(totalDrains).padStart(5)} drains`,
    )
    console.log(
        `  ${'sampled peak RSS'.padEnd(27)}`
        + ` ${(sampledPeakRss / 1024 / 1024).toFixed(1).padStart(9)} MiB`,
    )
    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function extendedStoreStressFailed(error) {
    console.error(error)
    process.exit(1)
})
