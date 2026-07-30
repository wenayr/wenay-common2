// ============================================================
// Store Replay V2 batch contract
// ============================================================

import {isDeepStrictEqual} from 'node:util'
import {flushReactive} from '../src/Common/Observe/reactive'
import {createStore, listenStorePatches, type StorePatch} from '../src/Common/Observe/store'
import {listen} from '../src/Common/events/Listen'
import {
    exposeStoreReplay,
    type StoreReplayRemote,
    syncStoreReplay,
} from '../src/Common/Observe/store-replay'
import {
    decodeStoreReplayBatchV2,
    decodeStoreReplayPatchV2,
    encodeStoreReplayBatchV2,
    encodeStoreReplayPatchV2,
    storeReplayBatchV2WireMetrics,
} from '../src/Common/Observe/store-replay-codec'

let failures = 0

function ok(condition: unknown, message: string) {
    if (condition) console.log('  OK  ', message)
    else {
        failures++
        console.log('  FAIL', message)
    }
}

async function main() {
    console.log('\n[store-replay-v2] patch tuples')
    const patches: StorePatch[] = [
        {path: ['BTC'], exists: true, value: {c: 1}},
        {path: ['BTC'], exists: false, value: undefined},
        {path: ['BTC', 'c'], exists: true, value: 2},
        {path: ['BTC', 'c'], exists: false, value: undefined},
        {path: [], exists: true, value: {BTC: {c: 3}}},
        {path: [], exists: false, value: undefined},
        {path: ['UNDEF'], exists: true, value: undefined},
    ]
    for (const patch of patches) {
        const decoded = decodeStoreReplayPatchV2(encodeStoreReplayPatchV2(patch))
        ok(isDeepStrictEqual(decoded, patch), 'round-trips ' + JSON.stringify(patch.path))
    }

    const explicitUndefined = encodeStoreReplayBatchV2({
        seq: 7,
        ts: 8,
        event: [[{path: ['UNDEF'], exists: true, value: undefined}]],
    })
    const jsonWire = JSON.parse(JSON.stringify(explicitUndefined))
    const decodedUndefined = decodeStoreReplayBatchV2(jsonWire).event[0][0]
    ok(decodedUndefined.exists && decodedUndefined.value === undefined,
        'preserves an explicit undefined patch through JSON')

    console.log('\n[store-replay-v2] direct facade and mirror')
    type Quotes = Record<string, {c: number, t: number}>
    const source = createStore<Quotes>({}, {drain: 'micro'})
    const exposed = exposeStoreReplay(source, {
        history: 32,
        maxItems: 2,
        maxBytes: 64 * 1024,
    })
    const remote = exposed.api.replay as StoreReplayRemote
    const versionKeys = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7']
        .filter(key => Object.prototype.hasOwnProperty.call(remote, key))
    ok(versionKeys.length == 0, 'exposes one direct V2 batch facade without generation members')

    const live: ReturnType<typeof encodeStoreReplayBatchV2>[] = []
    const offLive = remote.line.on(function collectV2Batch(wire) { live.push(wire) })
    const mirror = createStore<Quotes>({}, {drain: 'micro'})
    const sync = syncStoreReplay(mirror, remote)
    await sync.ready

    for (let index = 0; index < 5; index++) {
        source.state['Q' + index] = {c: index, t: index + 10}
    }
    await flushReactive(source.state)
    await flushReactive(mirror.state)

    ok(live.length == 3 && live.every(wire => wire[0] == 2),
        'maxItems splits one drain into V2 envelopes only')
    ok(live.map(wire => wire[3].length).join(',') == '2,2,1',
        'split envelopes preserve the configured item bound')
    ok(isDeepStrictEqual(mirror.snapshot(), source.snapshot()),
        'V2 mirror converges to the source')

    const since = sync.seq()
    source.state.Q2 = {c: 22, t: 22}
    delete source.state.Q4
    await flushReactive(source.state)
    await flushReactive(mirror.state)
    ok(sync.seq() > since && isDeepStrictEqual(mirror.snapshot(), source.snapshot()),
        'V2 live update and delete advance seq and converge')

    let malformedRejected = false
    try {
        decodeStoreReplayBatchV2([3, 1, 2, []])
    } catch {
        malformedRejected = true
    }
    ok(malformedRejected, 'rejects a non-V2 envelope')

    sync()
    offLive()
    exposed.close()

    console.log('\n[store-replay-v2] sizing traverses each accepted patch only when needed')
    const largeText = 'x'.repeat(80 * 1024)
    const expectedOversizePatch: StorePatch = {
        path: ['LARGE'],
        exists: true,
        value: {text: largeText},
    }
    const expectedOversizeBytes = storeReplayBatchV2WireMetrics([expectedOversizePatch]).byteLength
    let oversizeReads = 0
    const observedOversizeValue = {}
    Object.defineProperty(observedOversizeValue, 'text', {
        enumerable: true,
        get() {
            oversizeReads++
            return largeText
        },
    })
    const [emitOversize, oversizeSource] = listen<[readonly StorePatch[]]>()
    const oversizeExposed = exposeStoreReplay(createStore<Record<string, unknown>>({}), {
        patchSource: oversizeSource,
        maxBytes: 512,
    })
    emitOversize([{
        path: ['LARGE'],
        exists: true,
        value: observedOversizeValue,
    }])
    const oversizeStats = oversizeExposed.batchStats()
    ok(oversizeReads == 1,
        'one indivisible oversized patch reuses its first exact metric instead of walking the value twice')
    ok(oversizeStats.emittedBatches == 1 && oversizeStats.emittedPatches == 1
        && oversizeStats.estimatedBytes == expectedOversizeBytes,
    'the oversized singleton keeps its exact batch byte statistic and one-envelope wire boundary')
    oversizeExposed.close()

    const expectedBinaryPatch: StorePatch = {
        path: ['BINARY'],
        exists: true,
        value: {bytes: new Uint8Array(2 * 1024)},
    }
    const expectedBinaryBytes = storeReplayBatchV2WireMetrics([expectedBinaryPatch]).byteLength
    let binaryReads = 0
    const observedBinaryValue = {}
    Object.defineProperty(observedBinaryValue, 'bytes', {
        enumerable: true,
        get() {
            binaryReads++
            return new Uint8Array(2 * 1024)
        },
    })
    const [emitBinary, binarySource] = listen<[readonly StorePatch[]]>()
    const binaryExposed = exposeStoreReplay(createStore<Record<string, unknown>>({}), {
        patchSource: binarySource,
        maxBytes: 512,
    })
    emitBinary([{path: ['BINARY'], exists: true, value: observedBinaryValue}])
    const binaryStats = binaryExposed.batchStats()
    ok(binaryReads == 1 && binaryStats.estimatedBytes == expectedBinaryBytes,
        'an oversized native-binary singleton reuses its metric without changing attachment bytes')
    binaryExposed.close()

    const firstBoundaryPatch: StorePatch = {
        path: ['FIRST'],
        exists: true,
        value: {bytes: new Uint8Array(300)},
    }
    let boundaryReads = 0
    const observedBoundaryValue = {}
    Object.defineProperty(observedBoundaryValue, 'text', {
        enumerable: true,
        get() {
            boundaryReads++
            return 'b'.repeat(300)
        },
    })
    const [emitBoundary, boundarySource] = listen<[readonly StorePatch[]]>()
    const boundaryExposed = exposeStoreReplay(createStore<Record<string, unknown>>({}), {
        patchSource: boundarySource,
        maxBytes: 500,
    })
    emitBoundary([
        firstBoundaryPatch,
        {path: ['SECOND'], exists: true, value: observedBoundaryValue},
    ])
    const boundaryStats = boundaryExposed.batchStats()
    ok(boundaryReads == 1,
        'a non-binary patch keeps its metric when a preceding binary batch flush resets attachment indices')
    ok(boundaryStats.emittedBatches == 2 && boundaryStats.emittedPatches == 2,
        'the non-binary sizing fast path preserves the existing batch boundary')
    boundaryExposed.close()

    console.log('\n[store-replay-v2] hot array replacements stay record-sized')
    type ArrayState = {rows: {id: number, value: string}[]}
    const arraySource = createStore<ArrayState>({
        rows: Array.from({length: 8}, (_item, id) => ({id, value: 'old'})),
    }, {drain: 'micro'})
    const publicArrayPaths: PropertyKey[][][] = []
    const offPublicArrays = listenStorePatches(arraySource).on(function collectPublicArrayPatches(next) {
        publicArrayPaths.push(next.map(patch => patch.path))
    })
    const arrayExposed = exposeStoreReplay(arraySource, {history: 16, maxItems: 256})
    const arrayRemote = arrayExposed.api.replay as StoreReplayRemote
    const arrayWires: ReturnType<typeof encodeStoreReplayBatchV2>[] = []
    const offArrayWire = arrayRemote.line.on(function collectArrayWire(wire) { arrayWires.push(wire) })
    const arrayMirror = createStore<ArrayState>({rows: []}, {drain: 'micro'})
    const arraySync = syncStoreReplay(arrayMirror, arrayRemote)
    await arraySync.ready

    arraySource.state.rows[2] = {id: 2, value: 'new-2'}
    arraySource.state.rows[6] = {id: 6, value: 'new-6'}
    await flushReactive(arraySource.state)
    await flushReactive(arrayMirror.state)
    const recordPaths = arrayWires.flatMap(wire =>
        decodeStoreReplayBatchV2(wire).event[0].map(patch => patch.path.join('.')))
    ok(recordPaths.join(',') == 'rows.2,rows.6',
        'Store Replay refines array-slot replacements to exact record paths')
    ok(publicArrayPaths.flat().map(path => path.join('.')).join(',') == 'rows',
        'the public Store patch source keeps its existing whole-array boundary')
    ok(isDeepStrictEqual(arrayMirror.snapshot(), arraySource.snapshot()),
        'record-sized array patches converge through the ordinary V2 mirror')

    arrayWires.length = 0
    arraySource.state.rows.push({id: 8, value: 'pushed'})
    await flushReactive(arraySource.state)
    await flushReactive(arrayMirror.state)
    const pushPaths = arrayWires.flatMap(wire =>
        decodeStoreReplayBatchV2(wire).event[0].map(patch => patch.path.join('.')))
    ok(pushPaths.join(',') == 'rows.8' && arrayMirror.state.rows.length == 9,
        'array growth uses its exact new slot and grows the mirror naturally')

    arrayWires.length = 0
    arraySource.state.rows.length = 3
    await flushReactive(arraySource.state)
    await flushReactive(arrayMirror.state)
    const truncatePaths = arrayWires.flatMap(wire =>
        decodeStoreReplayBatchV2(wire).event[0].map(patch => patch.path.join('.')))
    ok(truncatePaths.join(',') == 'rows' && isDeepStrictEqual(arrayMirror.snapshot(), arraySource.snapshot()),
        'array length changes fall back to one whole-array patch')

    arrayWires.length = 0
    arraySource.state.rows = [
        {id: 10, value: 'replacement'},
        {id: 11, value: 'replacement'},
    ]
    arraySource.state.rows[0] = {id: 10, value: 'same-window-update'}
    await flushReactive(arraySource.state)
    await flushReactive(arrayMirror.state)
    const replacementPaths = arrayWires.flatMap(wire =>
        decodeStoreReplayBatchV2(wire).event[0].map(patch => patch.path.join('.')))
    ok(replacementPaths.join(',') == 'rows'
        && isDeepStrictEqual(arrayMirror.snapshot(), arraySource.snapshot()),
        'whole-array replacement wins over exact slot metadata from the same drain')

    arraySync()
    offArrayWire()
    arrayExposed.close()
    offPublicArrays()

    console.log(failures == 0 ? '\nStore Replay V2 tests: OK' : `\nStore Replay V2 tests: ${failures} FAILED`)
    process.exit(failures == 0 ? 0 : 1)
}

main().catch(function fail(error) {
    console.error(error)
    process.exit(1)
})
