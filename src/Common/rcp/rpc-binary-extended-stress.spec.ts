// ===========================================================================
// Universal binary RPC — extended deterministic throughput/soak oracle
//
// This is intentionally separate from the regular stress gate. It models the
// small/random/large block mix used by storage benchmarks while staying above
// the private byte layout and keeping large values bounded to one in flight.
// ===========================================================================

import * as assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {createRpcClient} from './rpc-client'
import {createInProcSocketPair} from './rpc-inproc'
import {Pkt, type SocketTmpl} from './rpc-protocol'
import {createRpcServer} from './rpc-server'
import {rpcEndCallback} from './rpc-walk'
import type {RpcOpt} from './rpc-caps'

const SHAPE_LAYOUTS = 1_300
const TINY_CALLS = 24_000
const TINY_IN_FLIGHT = 128
const MEDIUM_BATCHES = 96
const MEDIUM_ITEMS = 512
const CALLBACK_BURSTS = 48
const CALLBACK_ITEMS = 1_000
const VARIABLE_BINARY_ROUNDS = 20
const VARIABLE_BINARY_SIZES = [
    1,
    31,
    127,
    1 * 1024,
    8 * 1024,
    64 * 1024,
    256 * 1024,
    512 * 1024,
] as const
const LARGE_BINARY_BLOCKS = 64
const LARGE_BINARY_BYTES = 4 * 1024 * 1024
const PHASE_TIMEOUT_MS = 120_000
const CHECKSUM_OFFSET = 0x811c9dc5

const APPLICATION_OPCODES = new Set<number>([
    Pkt.CALL,
    Pkt.RESP,
    Pkt.CB,
    Pkt.CB_END,
    Pkt.PIPE,
    Pkt.SHAPE,
    Pkt.CBV,
    Pkt.CB_BATCH,
])

type tWireStats = {
    arrays: number
    applicationArrays: number
    binaryFrames: number
    binaryBytes: number
    largestBinaryFrame: number
}

type tRunMetrics = {
    shapeValues: number
    tinyCalls: number
    mediumRecords: number
    callbacks: number
    binaryBlocks: number
    logicalBinaryBytes: number
    checksum: number
    maxPending: number
}

function delay(ms = 0) {
    return new Promise<void>(function waitDelay(resolve) {
        setTimeout(resolve, ms)
    })
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await delay(2)
    }
    throw new Error('timeout waiting for ' + label)
}

async function within<T>(label: string, value: Promise<T>, timeoutMs = PHASE_TIMEOUT_MS) {
    let timer: ReturnType<typeof setTimeout> | undefined
    return new Promise<T>(function waitForValue(resolve, reject) {
        timer = setTimeout(function operationTimeout() {
            reject(new Error('timeout during ' + label))
        }, timeoutMs)
        value.then(
            function operationResolved(result) {
                if (timer) clearTimeout(timer)
                resolve(result)
            },
            function operationRejected(error) {
                if (timer) clearTimeout(timer)
                reject(error)
            },
        )
    })
}

async function runPhase<T>(label: string, run: () => Promise<T>) {
    const startedAt = Date.now()
    const value = await within(label, run())
    console.log('      ' + label + ': ' + (Date.now() - startedAt) + ' ms')
    return value
}

function activeBytes(value: ArrayBuffer | ArrayBufferView) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function wireBytes(value: unknown) {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return activeBytes(value)
    }
    return undefined
}

function createWireStats(): tWireStats {
    return {
        arrays: 0,
        applicationArrays: 0,
        binaryFrames: 0,
        binaryBytes: 0,
        largestBinaryFrame: 0,
    }
}

function observeSocket(socket: SocketTmpl) {
    const stats = createWireStats()
    const originalEmit = socket.emit.bind(socket)
    socket.emit = function observeWire(event, data) {
        if (Array.isArray(data)) {
            stats.arrays++
            if (typeof data[0] == 'number' && APPLICATION_OPCODES.has(data[0])) {
                stats.applicationArrays++
            }
        } else {
            const bytes = wireBytes(data)
            if (bytes) {
                stats.binaryFrames++
                stats.binaryBytes += bytes.byteLength
                stats.largestBinaryFrame = Math.max(stats.largestBinaryFrame, bytes.byteLength)
            }
        }
        originalEmit(event, data)
    }

    function reset() {
        Object.assign(stats, createWireStats())
    }

    return {socket, stats, reset}
}

function exact(actual: unknown, expected: unknown, label: string) {
    assert.ok(isDeepStrictEqual(actual, expected), label)
}

function mixChecksum(checksum: number, value: number) {
    return Math.imul(checksum ^ value, 0x01000193) >>> 0
}

function binaryDigest(value: ArrayBuffer | ArrayBufferView) {
    return createHash('sha256').update(activeBytes(value)).digest('hex')
}

function createBytes(byteLength: number, seed: number) {
    const value = new Uint8Array(byteLength)
    let state = seed >>> 0
    for (let index = 0; index < value.length; index++) {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        value[index] = state & 0xff
    }
    return value
}

function createWarmRecord(sequence: number) {
    return {
        sequence,
        symbol: 'PAIR-' + String(sequence % 64).padStart(2, '0'),
        side: sequence % 2 == 0 ? 'buy' : 'sell',
        price: 10_000 + sequence / 100,
        quantity: (sequence % 997) + 0.25,
        active: sequence % 5 != 0,
        nested: {
            revision: sequence * 7,
            source: 'extended-stress',
            stale: sequence % 29 == 0,
        },
        flags: [sequence % 2 == 0, null, 'lane-' + (sequence % 8)],
    }
}

function createSparseValue(sequence: number) {
    const value = new Array<unknown>(6)
    value[0] = sequence
    value[2] = undefined
    value[4] = false
    value[5] = 'tail'
    return value
}

function createNullPrototypeValue(sequence: number) {
    const value = Object.create(null) as Record<string, unknown>
    value['sequence'] = sequence
    value['enabled'] = false
    value['missing'] = undefined
    return value
}

function createTinyValue(sequence: number) {
    switch (sequence % 64) {
        case 0: return undefined
        case 1: return null
        case 2: return false
        case 3: return true
        case 4: return 0
        case 5: return -0
        case 6: return Number.NaN
        case 7: return Number.POSITIVE_INFINITY
        case 8: return Number.NEGATIVE_INFINITY
        case 9: return ''
        case 10: return 'строка-' + sequence
        case 11: return -9_007_199_254_740_993n + BigInt(sequence)
        case 12: return new Date(1_700_000_000_000 + sequence)
        case 13: return new Date(Number.NaN)
        case 14: return /quote-(?<symbol>[A-Z]+)\s+/giu
        case 15: return new Map<unknown, unknown>([
            ['sequence', sequence],
            [false, new Set<unknown>([undefined, -0, 'map-set'])],
        ])
        case 16: return new Set<unknown>([false, true, sequence, 'set'])
        case 17: return new Uint8Array([0, sequence & 0xff, 255])
        case 18: return new Float64Array([-0, Number.NaN, sequence / 3])
        case 19: return Uint8Array.from([sequence & 0xff, 7, 8, 9]).buffer
        case 20: {
            const bytes = Uint8Array.from([0xa5, sequence & 0xff, 7, 8, 0xa5])
            return new DataView(bytes.buffer, 1, 3)
        }
        case 21: return createSparseValue(sequence)
        case 22: return createNullPrototypeValue(sequence)
        default: return createWarmRecord(sequence)
    }
}

function createTinyResponse(sequence: number, value: unknown) {
    return {
        sequence,
        lane: sequence % 17,
        accepted: sequence % 5 != 0,
        value,
        meta: {
            epoch: 7,
            source: 'tiny-rpc',
        },
    }
}

function createMediumRecord(sequence: number) {
    const record = createWarmRecord(sequence) as ReturnType<typeof createWarmRecord> & {
        payload: unknown
    }
    switch (sequence % 8) {
        case 0:
            record.payload = false
            break
        case 1:
            record.payload = 0
            break
        case 2:
            record.payload = ''
            break
        case 3:
            record.payload = 'value-' + sequence
            break
        case 4:
            record.payload = sequence / 7
            break
        case 5:
            record.payload = null
            break
        case 6:
            record.payload = {code: sequence % 13, valid: true}
            break
        default: record.payload = [sequence, false, 'array']
    }
    return record
}

function createCallbackValue(sequence: number) {
    switch (sequence % 16) {
        case 0: return false
        case 1: return null
        case 2: return undefined
        case 3: return 0
        case 4: return ''
        case 5: return 'callback-' + sequence
        case 6: return new Uint16Array([sequence & 0xffff, 0xffff])
        case 7: return new Map<unknown, unknown>([['sequence', sequence], [false, null]])
        default: return createWarmRecord(sequence)
    }
}

function createDiverseValue(sequence: number) {
    const value: Record<string, unknown> = {}
    value['layout_' + String(sequence).padStart(4, '0')] = {
        sequence,
        enabled: sequence % 3 != 0,
    }
    return value
}

function binaryKind(value: ArrayBuffer | ArrayBufferView) {
    if (value instanceof ArrayBuffer) return 'ArrayBuffer'
    if (value instanceof DataView) return 'DataView'
    return value.constructor.name
}

function makeBinaryValue(bytes: Uint8Array, kind: number): ArrayBuffer | ArrayBufferView {
    if (kind % 3 == 0) return bytes
    if (kind % 3 == 1) return bytes.buffer as ArrayBuffer
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function createExtendedApi() {
    async function tiny(sequence: number, value: unknown) {
        if (sequence % 11 == 0) await Promise.resolve()
        if (sequence % 37 == 0) await Promise.resolve()
        return createTinyResponse(sequence, value)
    }

    function echoValues(values: unknown[]) {
        return values
    }

    function echoBatch(batchId: number, records: unknown[]) {
        return {batchId, records}
    }

    function wrapBatch(batchId: number, records: unknown[]) {
        return {
            payload: {batchId, records},
        }
    }

    function callbackBurst(
        start: number,
        count: number,
        callback: (sequence: number, value: unknown) => void,
    ) {
        for (let offset = 0; offset < count; offset++) {
            const sequence = start + offset
            callback(sequence, createCallbackValue(sequence))
        }
        rpcEndCallback(callback)
        return {
            start,
            count,
            last: start + count - 1,
        }
    }

    function binaryEcho(sequence: number, value: ArrayBuffer | ArrayBufferView) {
        return {
            sequence,
            kind: binaryKind(value),
            value,
        }
    }

    return {
        tiny,
        echoValues,
        echoBatch,
        wrapBatch,
        callbackBurst,
        binaryEcho,
    }
}

type tExtendedApi = ReturnType<typeof createExtendedApi>

function createFixture(socketKey: string, promotionThreshold?: number) {
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const clientWire = observeSocket(rawClientSocket)
    const serverWire = observeSocket(rawServerSocket)
    const opt: RpcOpt = {
        binary: {maxShapes: 1_000, promotionThreshold},
        callbackBatch: {
            maxItems: 512,
            maxBytes: 1 * 1024 * 1024,
        },
    }
    const client = createRpcClient<tExtendedApi>({
        socket: clientWire.socket,
        socketKey,
        opt,
    })
    createRpcServer({
        socket: serverWire.socket,
        socketKey,
        object: createExtendedApi(),
        opt,
    })

    function close() {
        client.close('RPC binary extended stress fixture complete', {socketAlive: false})
    }

    return {client, clientWire, serverWire, close}
}

async function negotiateBinary(fixture: ReturnType<typeof createFixture>) {
    await within('RPC map/binary readiness', fixture.client.ready(), 10_000)
    await waitFor('binary probe and acknowledgement', function binaryRoundTripReady() {
        return fixture.clientWire.stats.binaryFrames > 0
            && fixture.serverWire.stats.binaryFrames > 0
    })
    await delay(5)
    fixture.clientWire.reset()
    fixture.serverWire.reset()
}

function assertBinaryOnlyApplication(
    fixture: ReturnType<typeof createFixture>,
    label: string,
) {
    assert.equal(
        fixture.clientWire.stats.applicationArrays,
        0,
        label + ' client application packets stay binary',
    )
    assert.equal(
        fixture.serverWire.stats.applicationArrays,
        0,
        label + ' server application packets stay binary',
    )
    assert.ok(fixture.clientWire.stats.binaryFrames > 0, label + ' has client binary frames')
    assert.ok(fixture.serverWire.stats.binaryFrames > 0, label + ' has server binary frames')
}

function assertClean(fixture: ReturnType<typeof createFixture>, label: string) {
    assert.equal(fixture.client.api.pending(), 0, label + ' leaves no pending calls')
    assert.equal(fixture.client.api.callbacks(), 0, label + ' leaves no callbacks')
}

async function exerciseShapeSaturation(metrics: tRunMetrics) {
    // Every distinct layout must consume a schema slot in this phase. The
    // regular workload retains the production default that filters one-offs.
    const fixture = createFixture('rpc-binary-extended-shapes', 1)
    try {
        await negotiateBinary(fixture)
        const values = Array.from({length: SHAPE_LAYOUTS}, function createShape(_, sequence) {
            return createDiverseValue(sequence)
        })
        const echoed = await fixture.client.func.echoValues(values)
        exact(echoed, values, '1300 distinct layouts survive the 1000-entry shape budget')
        const cachedHead = values.slice(0, 64)
        exact(
            await fixture.client.func.echoValues(cachedHead),
            cachedHead,
            'early cached layouts remain usable after saturation',
        )
        const rawTail = values.slice(-64)
        exact(
            await fixture.client.func.echoValues(rawTail),
            rawTail,
            'overflow layouts remain exact through raw-shape fallback',
        )
        // Cache state is asserted directly by the focused codec oracle. Bytes are
        // deliberately not an invariant: a better generic encoder may narrow or
        // eliminate the size difference without changing the bounded protocol.
        assert.equal(
            fixture.clientWire.stats.binaryFrames,
            3,
            'three saturation calls use one client binary frame each',
        )
        assert.equal(
            fixture.serverWire.stats.binaryFrames,
            3,
            'three saturation responses use one server binary frame each',
        )

        metrics.shapeValues += values.length + cachedHead.length + rawTail.length
        for (let sequence = 0; sequence < values.length; sequence++) {
            metrics.checksum = mixChecksum(metrics.checksum, sequence)
        }
        assertClean(fixture, 'shape saturation')
        assertBinaryOnlyApplication(fixture, 'shape saturation')
        return {
            clientWire: {...fixture.clientWire.stats},
            serverWire: {...fixture.serverWire.stats},
        }
    } finally {
        fixture.close()
    }
}

async function exerciseTinyCalls(
    fixture: ReturnType<typeof createFixture>,
    metrics: tRunMetrics,
) {
    for (let base = 0; base < TINY_CALLS; base += TINY_IN_FLIGHT) {
        const count = Math.min(TINY_IN_FLIGHT, TINY_CALLS - base)
        const pending: Promise<unknown>[] = []
        for (let offset = 0; offset < count; offset++) {
            const sequence = base + offset
            pending.push(fixture.client.func.tiny(sequence, createTinyValue(sequence)))
        }
        metrics.maxPending = Math.max(metrics.maxPending, fixture.client.api.pending())
        assert.ok(
            fixture.client.api.pending() <= TINY_IN_FLIGHT,
            'tiny call wave stays within the in-flight bound',
        )
        const responses = await Promise.all(pending)
        for (let offset = 0; offset < responses.length; offset++) {
            const sequence = base + offset
            exact(
                responses[offset],
                createTinyResponse(sequence, createTinyValue(sequence)),
                'tiny response #' + sequence,
            )
            metrics.checksum = mixChecksum(metrics.checksum, sequence)
        }
        assert.equal(fixture.client.api.pending(), 0, 'tiny call wave drains pending requests')
    }
    metrics.tinyCalls += TINY_CALLS
}

async function exerciseMediumBatches(
    fixture: ReturnType<typeof createFixture>,
    metrics: tRunMetrics,
) {
    let expectedChecksum = CHECKSUM_OFFSET
    let actualChecksum = CHECKSUM_OFFSET
    for (let batchId = 0; batchId < MEDIUM_BATCHES; batchId++) {
        const first = batchId * MEDIUM_ITEMS
        const records = Array.from({length: MEDIUM_ITEMS}, function createRecord(_, offset) {
            const record = createMediumRecord(first + offset)
            expectedChecksum = mixChecksum(expectedChecksum, record.sequence)
            return record
        })
        const response = batchId % 4 == 0
            ? await (fixture.client.pipe as any).wrapBatch(batchId, records).payload
            : await fixture.client.func.echoBatch(batchId, records)
        exact(
            response,
            {batchId, records},
            'medium batch #' + batchId + ' remains exact',
        )
        for (const record of (response as any).records) {
            actualChecksum = mixChecksum(actualChecksum, record.sequence)
        }
        assert.equal(fixture.client.api.pending(), 0, 'medium batch drains before the next batch')
    }
    assert.equal(actualChecksum, expectedChecksum, 'medium batch checksum')
    metrics.mediumRecords += MEDIUM_BATCHES * MEDIUM_ITEMS
    metrics.checksum = mixChecksum(metrics.checksum, actualChecksum)
}

async function exerciseCallbackBursts(
    fixture: ReturnType<typeof createFixture>,
    metrics: tRunMetrics,
) {
    let expectedSequence = 0
    let expectedChecksum = CHECKSUM_OFFSET
    let actualChecksum = CHECKSUM_OFFSET
    let failure: string | undefined
    const framesBefore = fixture.serverWire.stats.binaryFrames

    for (let burst = 0; burst < CALLBACK_BURSTS; burst++) {
        const start = burst * CALLBACK_ITEMS
        const result = await fixture.client.func.callbackBurst(
            start,
            CALLBACK_ITEMS,
            function receiveStressCallback(sequence, value) {
                if (failure) return
                if (sequence != expectedSequence) {
                    failure = 'callback sequence: expected '
                        + expectedSequence + ', received ' + sequence
                    return
                }
                const expected = createCallbackValue(sequence)
                if (!isDeepStrictEqual(value, expected)) {
                    failure = 'callback value mismatch at sequence ' + sequence
                    return
                }
                actualChecksum = mixChecksum(actualChecksum, sequence)
                expectedSequence++
            },
        )
        exact(result, {
            start,
            count: CALLBACK_ITEMS,
            last: start + CALLBACK_ITEMS - 1,
        }, 'callback burst result #' + burst)
        for (let offset = 0; offset < CALLBACK_ITEMS; offset++) {
            expectedChecksum = mixChecksum(expectedChecksum, start + offset)
        }
    }

    await waitFor('extended callback cleanup', () => fixture.client.api.callbacks() == 0)
    assert.equal(failure, undefined, failure)
    assert.equal(expectedSequence, CALLBACK_BURSTS * CALLBACK_ITEMS, 'callback count and order')
    assert.equal(actualChecksum, expectedChecksum, 'callback checksum')
    const physicalFrames = fixture.serverWire.stats.binaryFrames - framesBefore
    assert.ok(
        physicalFrames < CALLBACK_BURSTS * CALLBACK_ITEMS / 8,
        'callback batching keeps the physical frame count bounded',
    )
    metrics.callbacks += expectedSequence
    metrics.checksum = mixChecksum(metrics.checksum, actualChecksum)
}

async function echoAndCheckBinary(
    fixture: ReturnType<typeof createFixture>,
    sequence: number,
    value: ArrayBuffer | ArrayBufferView,
) {
    const expectedKind = binaryKind(value)
    const expectedDigest = binaryDigest(value)
    const response = await fixture.client.func.binaryEcho(sequence, value)
    assert.equal(response.sequence, sequence, 'binary response sequence #' + sequence)
    assert.equal(response.kind, expectedKind, 'binary response kind #' + sequence)
    assert.equal(binaryKind(response.value), expectedKind, 'binary value kind #' + sequence)
    assert.equal(binaryDigest(response.value), expectedDigest, 'binary digest #' + sequence)
    return expectedDigest
}

async function exerciseVariableBinary(
    fixture: ReturnType<typeof createFixture>,
    metrics: tRunMetrics,
) {
    let sequence = 0
    for (let round = 0; round < VARIABLE_BINARY_ROUNDS; round++) {
        for (const byteLength of VARIABLE_BINARY_SIZES) {
            const bytes = createBytes(byteLength, 0x1000 + sequence)
            const value = makeBinaryValue(bytes, sequence)
            await echoAndCheckBinary(fixture, sequence, value)
            metrics.binaryBlocks++
            metrics.logicalBinaryBytes += byteLength * 2
            metrics.checksum = mixChecksum(metrics.checksum, byteLength ^ sequence)
            sequence++
            assert.equal(
                fixture.client.api.pending(),
                0,
                'variable binary block drains before the next block',
            )
        }
    }
}

async function exerciseLargeBinary(
    fixture: ReturnType<typeof createFixture>,
    metrics: tRunMetrics,
) {
    const sources = Array.from({length: 4}, function createLargeSource(_, index) {
        const bytes = createBytes(LARGE_BINARY_BYTES, 0x5a17 + index * 101)
        return {
            value: makeBinaryValue(bytes, index),
            digest: binaryDigest(bytes),
        }
    })
    const expectedDigestChain = createHash('sha256')
    const actualDigestChain = createHash('sha256')

    for (let sequence = 0; sequence < LARGE_BINARY_BLOCKS; sequence++) {
        const source = sources[sequence % sources.length]
        const digest = await echoAndCheckBinary(
            fixture,
            1_000_000 + sequence,
            source.value,
        )
        expectedDigestChain.update(source.digest)
        actualDigestChain.update(digest)
        metrics.binaryBlocks++
        metrics.logicalBinaryBytes += LARGE_BINARY_BYTES * 2
        metrics.checksum = mixChecksum(metrics.checksum, sequence ^ 0x400000)
        assert.equal(
            fixture.client.api.pending(),
            0,
            'large binary block drains before the next block',
        )
    }
    assert.equal(
        actualDigestChain.digest('hex'),
        expectedDigestChain.digest('hex'),
        'large binary digest chain',
    )
}

function mergeWireStats(target: tWireStats, source: tWireStats) {
    target.arrays += source.arrays
    target.applicationArrays += source.applicationArrays
    target.binaryFrames += source.binaryFrames
    target.binaryBytes += source.binaryBytes
    target.largestBinaryFrame = Math.max(
        target.largestBinaryFrame,
        source.largestBinaryFrame,
    )
}

function formatMiB(bytes: number) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MiB'
}

async function runExtendedWorkload() {
    const metrics: tRunMetrics = {
        shapeValues: 0,
        tinyCalls: 0,
        mediumRecords: 0,
        callbacks: 0,
        binaryBlocks: 0,
        logicalBinaryBytes: 0,
        checksum: CHECKSUM_OFFSET,
        maxPending: 0,
    }
    const clientWire = createWireStats()
    const serverWire = createWireStats()

    const shapeWire = await runPhase(
        '1300-layout saturation and fallback',
        async function shapePhase() {
            return exerciseShapeSaturation(metrics)
        },
    )
    mergeWireStats(clientWire, shapeWire.clientWire)
    mergeWireStats(serverWire, shapeWire.serverWire)

    const fixture = createFixture('rpc-binary-extended-throughput')
    try {
        await negotiateBinary(fixture)
        await runPhase('24000 tiny heterogeneous CALL/RESP', async function tinyPhase() {
            await exerciseTinyCalls(fixture, metrics)
        })
        await runPhase('49152 warm-layout records in medium CALL/PIPE batches',
            async function mediumPhase() {
                await exerciseMediumBatches(fixture, metrics)
            })
        await runPhase('48000 ordered heterogeneous callbacks', async function callbackPhase() {
            await exerciseCallbackBursts(fixture, metrics)
        })
        await runPhase('variable 1 B..512 KiB binary blocks', async function variableBinaryPhase() {
            await exerciseVariableBinary(fixture, metrics)
        })
        await runPhase('64 sequential 4 MiB binary blocks', async function largeBinaryPhase() {
            await exerciseLargeBinary(fixture, metrics)
        })

        assertClean(fixture, 'extended throughput')
        assertBinaryOnlyApplication(fixture, 'extended throughput')
        mergeWireStats(clientWire, fixture.clientWire.stats)
        mergeWireStats(serverWire, fixture.serverWire.stats)
    } finally {
        fixture.close()
    }

    assert.equal(metrics.shapeValues, 1_428, 'shape workload count')
    assert.equal(metrics.tinyCalls, TINY_CALLS, 'tiny call workload count')
    assert.equal(metrics.mediumRecords, MEDIUM_BATCHES * MEDIUM_ITEMS, 'medium record count')
    assert.equal(metrics.callbacks, CALLBACK_BURSTS * CALLBACK_ITEMS, 'callback workload count')
    assert.equal(
        metrics.binaryBlocks,
        VARIABLE_BINARY_ROUNDS * VARIABLE_BINARY_SIZES.length + LARGE_BINARY_BLOCKS,
        'binary block workload count',
    )
    const logicalOperations = metrics.shapeValues
        + metrics.tinyCalls
        + metrics.mediumRecords
        + metrics.callbacks
        + metrics.binaryBlocks
    assert.ok(logicalOperations > 100_000, 'logical workload exceeds 100000 operations')
    assert.ok(metrics.logicalBinaryBytes > 500 * 1024 * 1024, 'logical binary traffic exceeds 500 MiB')
    assert.equal(metrics.checksum, 0xc65e0623, 'combined deterministic workload checksum')
    assert.ok(metrics.maxPending > 1, 'tiny workload exercised concurrent request correlation')
    assert.ok(metrics.maxPending <= TINY_IN_FLIGHT, 'pending calls remained bounded')
    assert.equal(clientWire.applicationArrays, 0, 'aggregate client application wire stays binary')
    assert.equal(serverWire.applicationArrays, 0, 'aggregate server application wire stays binary')

    return {metrics, clientWire, serverWire}
}

export async function runRpcBinaryExtendedStressTests() {
    console.log('\n--- universal binary RPC extended deterministic stress ---')
    const startedAt = Date.now()
    try {
        const result = await runExtendedWorkload()
        const elapsedMs = Date.now() - startedAt
        const memory = process.memoryUsage()
        const resource = process.resourceUsage()
        const logicalOperations = result.metrics.shapeValues
            + result.metrics.tinyCalls
            + result.metrics.mediumRecords
            + result.metrics.callbacks
            + result.metrics.binaryBlocks

        console.log('      logical operations: ' + logicalOperations.toLocaleString('en-US'))
        console.log('      logical binary traffic: '
            + formatMiB(result.metrics.logicalBinaryBytes))
        console.log('      client wire: ' + result.clientWire.binaryFrames
            + ' frames / ' + formatMiB(result.clientWire.binaryBytes))
        console.log('      server wire: ' + result.serverWire.binaryFrames
            + ' frames / ' + formatMiB(result.serverWire.binaryBytes))
        console.log('      largest binary frame: '
            + formatMiB(Math.max(
                result.clientWire.largestBinaryFrame,
                result.serverWire.largestBinaryFrame,
            )))
        console.log('      max pending: ' + result.metrics.maxPending
            + ', checksum: 0x' + result.metrics.checksum.toString(16).padStart(8, '0'))
        console.log('      RSS current/max: ' + formatMiB(memory.rss)
            + ' / ' + formatMiB(resource.maxRSS * 1024))
        console.log('RPC binary extended stress: OK in ' + elapsedMs + ' ms')
        return 0
    } catch (error: any) {
        console.log('RPC binary extended stress: FAILED: ' + String(error?.stack ?? error))
        return 1
    }
}

if (require.main == module) {
    runRpcBinaryExtendedStressTests().then(function finish(failures) {
        process.exit(failures == 0 ? 0 : 1)
    })
}
