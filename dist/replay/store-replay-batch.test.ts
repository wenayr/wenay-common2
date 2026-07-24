// ============================================================
// Batched Store Replay: natural drain windows, compact wire and fallback.
// ============================================================

import {createStore, StorePatch} from '../src/Common/Observe/store'
import {isDeepStrictEqual} from 'node:util'
import {flushReactive} from '../src/Common/Observe/reactive'
import {packResult, unpackResult} from '../src/Common/rcp/rpc-walk'
import {rpcResultWireByteLength} from '../src/Common/rcp/rpc-wire-size'
import {
    exposeStoreReplay, StoreReplayBatchRemote, StoreReplayPatchSource, StoreReplayRemote,
    syncStoreReplay, syncStoreReplayBatch,
} from '../src/Common/Observe/store-replay'
import {
    decodeStoreReplayBatch, decodeStoreReplayBatchV2, decodeStoreReplayBatchV3, decodeStoreReplayBatchV5,
    encodeStoreReplayBatch, encodeStoreReplayBatchV2, encodeStoreReplayBatchV3,
    encodeStoreReplayBatchV4, encodeStoreReplayBatchV5, encodeStoreReplayPatchV2,
    storeReplayBatchJsonBytes, storeReplayBatchV2JsonBytes, storeReplayBatchV3JsonBytes,
    storeReplayPatchMaxWireBytes,
} from '../src/Common/Observe/store-replay-codec'

let fails = 0
function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const json = (value: any) => JSON.stringify(value)

type Quotes = Record<string, {c: number, t: number}>

function createExplicitPatchSource() {
    const listeners = new Set<(patches: readonly StorePatch[]) => void>()

    function on(cb: (patches: readonly StorePatch[]) => void) {
        listeners.add(cb)
        return function offExplicitPatchSource() { listeners.delete(cb) }
    }

    function emit(patches: readonly StorePatch[]) {
        for (const listener of [...listeners]) listener(patches)
    }

    const api: StoreReplayPatchSource = {on}
    return {api, emit}
}

async function main() {
    console.log('\n[store-replay-batch] packed v2 patch tuples stay unambiguous')
    {
        const cases: {patch: StorePatch, wire: unknown}[] = [
            {patch: {path: ['BTC'], exists: true, value: {c: 1}}, wire: ['BTC', {c: 1}]},
            {patch: {path: ['BTC'], exists: false, value: undefined}, wire: ['BTC']},
            {patch: {path: ['BTC', 'c'], exists: true, value: 2}, wire: [['BTC', 'c'], 2]},
            {patch: {path: ['BTC', 'c'], exists: false, value: undefined}, wire: [['BTC', 'c']]},
            {patch: {path: [], exists: true, value: {BTC: {c: 3}}}, wire: [[], {BTC: {c: 3}}]},
            {patch: {path: [], exists: false, value: undefined}, wire: [[]]},
            {patch: {path: ['UNDEF'], exists: true, value: undefined}, wire: ['UNDEF', 2, 0]},
        ]
        for (const entry of cases) {
            const wire = encodeStoreReplayPatchV2(entry.patch)
            const decoded = decodeStoreReplayBatchV2([2, 1, 2, [wire]]).event[0][0]
            ok(isDeepStrictEqual(wire, entry.wire) && isDeepStrictEqual(decoded, entry.patch),
                `v2 round-trips ${entry.patch.path.length == 0 ? 'root' : entry.patch.path.join('.')} ${entry.patch.exists ? 'set' : 'delete'}`)
        }
        const undefinedEvent = {
            seq: 7, ts: 8,
            event: [[{path: ['UNDEF'], exists: true, value: undefined}]] as [StorePatch[]],
        }
        const v1Json = JSON.parse(JSON.stringify(encodeStoreReplayBatch(undefinedEvent)))
        const v2Json = JSON.parse(JSON.stringify(encodeStoreReplayBatchV2(undefinedEvent)))
        const v1Patch = decodeStoreReplayBatch(v1Json).event[0][0]
        const v2Patch = decodeStoreReplayBatchV2(v2Json).event[0][0]
        ok(v1Patch.exists && v1Patch.value === undefined, 'v1 preserves explicit undefined through JSON')
        ok(v2Patch.exists && v2Patch.value === undefined, 'v2 preserves explicit undefined through JSON')

        const nestedUndefined = {
            seq: 9, ts: 10,
            event: [[{
                path: [], exists: true,
                value: {row: {explicit: undefined}, collision: {'$_sr': 0, explicit: undefined}},
            }]] as [StorePatch[]],
        }
        const v3Json = JSON.parse(JSON.stringify(encodeStoreReplayBatchV3(nestedUndefined)))
        const v3Value = decodeStoreReplayBatchV3(v3Json).event[0][0].value
        ok(Object.prototype.hasOwnProperty.call(v3Value.row, 'explicit')
            && v3Value.row.explicit === undefined
            && v3Value.collision['$_sr'] == 0
            && Object.prototype.hasOwnProperty.call(v3Value.collision, 'explicit'),
        'v3 recursively preserves explicit undefined and escapes marker-shaped business data')

        const bytes = new Uint8Array([1, 2, 3])
        const pattern = /quote/gi
        const ordinary = {
            row: {c: 1, t: 2},
            list: [{c: 3}],
            map: new Map([['BTC', {c: 4}]]),
            set: new Set([{c: 5}]),
            bytes,
            pattern,
        }
        const ordinaryPatch: StorePatch = {path: ['BTC'], exists: true, value: ordinary}
        const ordinaryEvent = {
            seq: 10, ts: 11,
            event: [[ordinaryPatch]] as [StorePatch[]],
        }
        const ordinaryWire = encodeStoreReplayBatchV3(ordinaryEvent)
        const ordinaryWireValue = (ordinaryWire[3][0] as [PropertyKey, unknown])[1]
        const ordinaryDecoded = decodeStoreReplayBatchV3(ordinaryWire).event[0][0].value
        ok(isDeepStrictEqual(ordinaryWire[3][0], encodeStoreReplayPatchV2(ordinaryPatch))
            && ordinaryWireValue == ordinary && ordinaryDecoded == ordinary
            && ordinaryDecoded.bytes == bytes && ordinaryDecoded.pattern == pattern
            && ordinaryDecoded.map == ordinary.map && ordinaryDecoded.set == ordinary.set,
        'v3 shares ordinary/rich values and keeps their patch tuple byte-for-byte v2')

        const safeSibling = {c: 6}
        const partlyEscaped = {
            safeSibling,
            nested: {explicit: undefined},
            map: new Map([['UNDEF', undefined]]),
            set: new Set([undefined]),
        }
        const escapedEvent = {
            seq: 11, ts: 12,
            event: [[{path: [], exists: true, value: partlyEscaped}]] as [StorePatch[]],
        }
        const escapedWire = encodeStoreReplayBatchV3(escapedEvent)
        const escapedValue = (escapedWire[3][0] as [PropertyKey[], 3, unknown])[2] as typeof partlyEscaped
        const escapedDecoded = decodeStoreReplayBatchV3(escapedWire).event[0][0].value as typeof partlyEscaped
        ok(escapedWire[3][0][1] == 3
            && escapedValue != partlyEscaped && escapedValue.safeSibling == safeSibling
            && escapedValue.nested != partlyEscaped.nested
            && escapedDecoded.safeSibling == safeSibling
            && Object.prototype.hasOwnProperty.call(escapedDecoded.nested, 'explicit')
            && escapedDecoded.map.get('UNDEF') === undefined
            && escapedDecoded.set.has(undefined),
        'v3 clones only branches that need escaping and preserves Map/Set undefined values')

        const cyclic: any = {}
        cyclic.self = cyclic
        let cyclicRejected = false
        try {
            encodeStoreReplayBatchV3({
                seq: 12, ts: 13,
                event: [[{path: [], exists: true, value: cyclic}]],
            })
        } catch (error) {
            cyclicRejected = error instanceof TypeError && String(error).includes('cyclic')
        }
        ok(cyclicRejected, 'v3 fast path keeps deterministic cyclic-value rejection')

        const reserved: any = {}
        for (const key of ['__proto__', 'constructor', 'prototype']) {
            Object.defineProperty(reserved, key, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: key + '-value',
            })
        }
        const reservedDecoded = decodeStoreReplayBatchV3(JSON.parse(JSON.stringify(encodeStoreReplayBatchV3({
            seq: 13, ts: 14,
            event: [[{path: [], exists: true, value: reserved}]],
        })))).event[0][0].value
        ok(['__proto__', 'constructor', 'prototype'].every(function hasReservedBusinessKey(key) {
            return Object.prototype.hasOwnProperty.call(reservedDecoded, key)
                && reservedDecoded[key] == key + '-value'
        }), 'v3 opcode 3 safely preserves reserved business keys')

        const rpcMarkerValues = [
            {label: 'Date', value: {'$_d': 5}},
            {label: 'Map', value: {'$_m': []}},
            {label: 'Set', value: {'$_s': []}},
            {label: 'RegExp', value: {'$_r': {source: 'quote', flags: 'g'}}},
            {label: 'BigInt', value: {'$_b': '5'}},
            {label: 'callback', value: {'$_f': 5}},
        ]
        for (const entry of rpcMarkerValues) {
            const markerEvent = {
                seq: 14, ts: 15,
                event: [[{path: ['MARKER'], exists: true, value: entry.value}]] as [StorePatch[]],
            }
            const transported = unpackResult(packResult(encodeStoreReplayBatchV3(markerEvent)))
            const decoded = decodeStoreReplayBatchV3(transported).event[0][0].value
            ok(isDeepStrictEqual(decoded, entry.value),
                `v3 escapes an exact ${entry.label} RPC marker-shaped business object`)
        }

        let invalidV3OperationRejected = false
        try {
            decodeStoreReplayBatchV3([3, 1, 2, [['BTC', 4, 0]]] as any)
        } catch (error) {
            invalidV3OperationRejected = error instanceof TypeError && String(error).includes('unknown patch operation')
        }
        ok(invalidV3OperationRejected, 'v3 rejects unknown three-slot patch opcodes')
    }

    console.log('\n[store-replay-batch] v5 live and recovery reads share one rich binary envelope')
    {
        const source = createStore<Record<string, any>>({}, {drain: 'micro'})
        const exposed = exposeStoreReplay(source, {history: 8, batch: true})
        const v5 = exposed.api.replay.batch!.v5!
        const liveWires: Uint8Array[] = []
        const off = v5.line.on(function collectV5Live(wire) { liveWires.push(wire) })
        const rich = {
            enabled: false,
            optional: undefined,
            at: new Date(1_700_000_000_123),
            labels: new Map([['desk', new Set(['spot', 'fast'])]]),
            bytes: new Uint8Array([7, 8, 9]),
            exactText: 'tail\ud800',
        }
        source.state.RICH = rich
        await flushReactive(source.state)

        const sinceWires = await v5.since(0) ?? []
        const keyframeWire = await v5.keyframe()
        const v1KeyframeWire = await exposed.api.replay.batch!.keyframe()
        const frameWires = await v5.frame!(0) ?? []
        const allWires = [
            ...liveWires,
            ...sinceWires,
            ...(keyframeWire ? [keyframeWire] : []),
            ...frameWires,
        ]
        const live = decodeStoreReplayBatchV5(liveWires[0]).event[0][0].value
        const since = decodeStoreReplayBatchV5(sinceWires[0]).event[0][0].value
        const keyframe = decodeStoreReplayBatchV5(keyframeWire!).event[0][0].value.RICH
        const mutableV1Keyframe = decodeStoreReplayBatch(v1KeyframeWire!).event[0][0].value
        const frame = decodeStoreReplayBatchV5(frameWires[0]).event[0][0].value

        function richIntact(value: typeof rich) {
            return value.enabled == false
                && Object.prototype.hasOwnProperty.call(value, 'optional') && value.optional === undefined
                && value.at instanceof Date && value.at.valueOf() == rich.at.valueOf()
                && value.labels instanceof Map && value.labels.get('desk') instanceof Set
                && value.labels.get('desk').has('spot')
                && value.bytes instanceof Uint8Array && value.bytes[2] == 9
                && value.exactText == rich.exactText
        }

        ok(allWires.length == 4 && allWires.every(function hasV5Header(wire) {
            return ArrayBuffer.isView(wire) && wire[0] == 0x53 && wire[1] == 0x52
                && wire[2] == 0x42 && wire[3] == 5
        }), 'live, since, keyframe and frame are self-contained SRB v5 byte envelopes')
        ok(richIntact(live) && richIntact(since) && richIntact(keyframe) && richIntact(frame),
            'every v5 Store read preserves representative rich business values')
        mutableV1Keyframe.RICH.enabled = true
        ok(source.state.RICH.enabled == false,
            'fresh keyframe encoding owns its Store snapshot without a second deep clone')

        off()
        exposed.close()
    }

    console.log('\n[store-replay-batch] explicit patch source keeps its mutation facts')
    {
        const store = createStore<Quotes>({}, {drain: 'micro'})
        const source = createExplicitPatchSource()
        const exposed = exposeStoreReplay(store, {batch: true, patchSource: source.api})
        const legacyValues: number[] = []
        const batchValues: number[][] = []
        const offLegacy = exposed.replay.line.on(function collectExplicitLegacyPatch(event) {
            legacyValues.push(event.event[0].value.c)
        })
        const offBatch = exposed.replayBatch!.line.on(function collectExplicitPatchBatch(event) {
            batchValues.push(event.event[0].map(function readExplicitPatchValue(patch) { return patch.value.c }))
        })

        store.state.BTC = {c: 1, t: 1}
        store.state.BTC = {c: 2, t: 2}
        source.emit([
            {path: ['BTC'], exists: true, value: {c: 1, t: 1}},
            {path: ['BTC'], exists: true, value: {c: 2, t: 2}},
        ])
        const keyframe = exposed.replay.keyframe()

        ok(json(legacyValues) == json([1, 2]), 'legacy line receives every explicit repeated top-key patch')
        ok(json(batchValues) == json([[1, 2]]), 'batch line retains repeated top-key patches in one envelope')
        ok(keyframe?.event[0].path.length == 0 && keyframe.event[0].value.BTC.c == 2,
            'keyframe reads the materialized Store instead of reconstructing from source patches')

        offLegacy()
        offBatch()
        exposed.close()
    }

    console.log('\n[store-replay-batch] one Store drain becomes one compact live envelope')
    {
        const source = createStore<Quotes>({}, {drain: 'micro'})
        const exposed = exposeStoreReplay(source, {history: 256, batch: true})
        const remote = exposed.api.replay as StoreReplayRemote
        const mirror = createStore<Quotes>({}, {drain: 'micro'})
        let legacyEvents = 0
        let batchEvents = 0
        let batchItems = 0
        const v1Seqs: number[] = []
        const v2Seqs: number[] = []
        const v3Seqs: number[] = []
        const v4Seqs: number[] = []
        const v5Seqs: number[] = []
        const v6Seqs: number[] = []
        const appliedBatchSizes: number[] = []
        const offLegacy = exposed.replay.line.on(function countLegacy() { legacyEvents++ })
        const offBatch = exposed.replayBatch!.line.on(function countBatch(event) {
            batchEvents++
            batchItems += event.event[0].length
        })
        const offV1Wire = remote.batch!.line.on(function countV1Seq(wire) { v1Seqs.push(wire[1]) })
        const offV2Wire = remote.batch!.v2!.line.on(function countV2Seq(wire) { v2Seqs.push(wire[1]) })
        const offV3Wire = remote.batch!.v3!.line.on(function countV3Seq(wire) { v3Seqs.push(wire[1]) })
        const offV4Wire = remote.batch!.v4!.line.on(function countV4Seq(wire) { v4Seqs.push(wire[1]) })
        const offV5Wire = remote.batch!.v5!.line.on(function countV5Seq(wire) {
            v5Seqs.push(decodeStoreReplayBatchV5(wire).seq)
        })
        const offV6Wire = remote.batch!.v6!.line.on(function countV6Seq(event) {
            v6Seqs.push(event.seq)
        })
        let v1Subscriptions = 0
        let v2Subscriptions = 0
        let v3Subscriptions = 0
        let v4Subscriptions = 0
        let v5Subscriptions = 0
        let v6Subscriptions = 0
        const batchRemote = remote.batch!
        const preferredRemote: StoreReplayRemote = {
            ...remote,
            batch: {
                ...batchRemote,
                line: {on(cb) { v1Subscriptions++; return batchRemote.line.on(cb) }},
                v2: {
                    ...batchRemote.v2!,
                    line: {on(cb) { v2Subscriptions++; return batchRemote.v2!.line.on(cb) }},
                },
                v3: {
                    ...batchRemote.v3!,
                    line: {on(cb) { v3Subscriptions++; return batchRemote.v3!.line.on(cb) }},
                },
                v4: {
                    ...batchRemote.v4!,
                    line: {on(cb) { v4Subscriptions++; return batchRemote.v4!.line.on(cb) }},
                },
                v5: {
                    ...batchRemote.v5!,
                    line: {on(cb) { v5Subscriptions++; return batchRemote.v5!.line.on(cb) }},
                },
                v6: {
                    ...batchRemote.v6!,
                    line: {on(cb) { v6Subscriptions++; return batchRemote.v6!.line.on(cb) }},
                },
            },
        }
        const sync = syncStoreReplay(mirror, preferredRemote, {
            batch: true,
            onBatch(patches, applied) {
                if (patches[0]?.path.length && appliedBatchSizes.length == 0) {
                    appliedBatchSizes.push(patches.length)
                    ok(Object.keys(applied.state).length == 50, 'onBatch observes the fully applied mirror')
                }
            },
        })
        await sync.ready

        for (let i = 0; i < 50; i++) source.state['S' + i] = {c: i + 0.5, t: 1000 + i}
        await flushReactive(source.state)
        await flushReactive(mirror.state)

        ok(legacyEvents == 50, `legacy capability remains one event per patch (${legacyEvents})`)
        ok(batchEvents == 1 && batchItems == 50, `batch capability emits 1 envelope with 50 patches (${batchEvents}/${batchItems})`)
        ok(v6Subscriptions == 1 && v5Subscriptions == 0 && v4Subscriptions == 0 && v3Subscriptions == 0
            && v2Subscriptions == 0 && v1Subscriptions == 0,
        'new batch client prefers universal-schema v6 over every older generation')
        ok([v2Seqs, v3Seqs, v4Seqs, v5Seqs, v6Seqs].every(seqs => json(seqs) == json(v1Seqs))
            && json(v1Seqs) == json([1]),
        'v1-v6 expose the same logical batch seq-space')
        ok(json(appliedBatchSizes) == json([50]), 'batch consumer receives one array callback for the window')
        ok(isDeepStrictEqual(mirror.snapshot(), source.snapshot()), 'batch client converges to the source')
        ok(exposed.batchStats!().emittedBatches == 1, 'local stats expose physical batch amplification')

        delete source.state.S1
        source.state.S2.c = 999
        await flushReactive(source.state)
        await flushReactive(mirror.state)
        ok(isDeepStrictEqual(mirror.snapshot(), source.snapshot()), 'delete and nested replace stay equivalent')

        source.replace({ROOT: {c: 7, t: 8}})
        await flushReactive(source.state)
        await flushReactive(mirror.state)
        ok(isDeepStrictEqual(mirror.snapshot(), source.snapshot()), 'root replacement/keyframe mechanism stays equivalent')

        offLegacy()
        offBatch()
        offV1Wire()
        offV2Wire()
        offV3Wire()
        offV4Wire()
        offV5Wire()
        offV6Wire()
        sync()
        exposed.close()
    }

    console.log('\n[store-replay-batch] bounded split and optional cross-window delay')
    {
        const source = createStore<Quotes>({}, {drain: 'micro'})
        const exposed = exposeStoreReplay(source, {batch: {maxItems: 10, maxBytes: 1_000_000}})
        const sizes: number[] = []
        const off = exposed.replayBatch!.line.on(event => sizes.push(event.event[0].length))
        for (let i = 0; i < 23; i++) source.state['Q' + i] = {c: i, t: i}
        await flushReactive(source.state)
        ok(json(sizes) == json([10, 10, 3]), `maxItems is a hard envelope ceiling (${sizes.join(',')})`)
        off()
        exposed.close()

        const byteSource = createStore<Quotes>({}, {drain: 'micro'})
        const byteBounded = exposeStoreReplay(byteSource, {batch: {maxItems: 100, maxBytes: 220}})
        const wireBytes: number[] = []
        const wireBytesV2: number[] = []
        const offBytes = byteBounded.api.replay.batch!.line.on(function countWireBytes(wire) {
            wireBytes.push(storeReplayBatchJsonBytes(wire))
        })
        const offBytesV2 = byteBounded.api.replay.batch!.v2!.line.on(function countWireBytesV2(wire) {
            wireBytesV2.push(storeReplayBatchV2JsonBytes(wire))
        })
        for (let i = 0; i < 8; i++) byteSource.state['B' + i] = {c: i, t: 100_000 + i}
        await flushReactive(byteSource.state)
        ok(wireBytes.length > 1 && wireBytes.every(bytes => bytes <= 220),
            `maxBytes splits on compact JSON size (${wireBytes.join(',')})`)
        ok(wireBytesV2.length == wireBytes.length && wireBytesV2.every(bytes => bytes <= 220),
            `v1 estimator conservatively bounds v2 (${wireBytesV2.join(',')})`)
        offBytes()
        offBytesV2()
        byteBounded.close()

        const delayedSource = createStore<Quotes>({}, {drain: 'micro'})
        const delayed = exposeStoreReplay(delayedSource, {batch: {maxDelayMs: 20}})
        const delayedSizes: number[] = []
        const offDelayed = delayed.replayBatch!.line.on(event => delayedSizes.push(event.event[0].length))
        delayedSource.state.A = {c: 1, t: 1}
        await flushReactive(delayedSource.state)
        delayedSource.state.B = {c: 2, t: 2}
        await flushReactive(delayedSource.state)
        ok(delayedSizes.length == 0, 'maxDelayMs holds bounded cross-window aggregation')
        await delay(30)
        ok(json(delayedSizes) == json([2]), 'delay expiry flushes both windows as one envelope')
        offDelayed()
        delayed.close()

        const localSource = createStore<Quotes>({}, {drain: 'micro'})
        const localDelayed = exposeStoreReplay(localSource, {batch: {maxDelayMs: 10_000}})
        localSource.state.LOCAL = {c: 3, t: 3}
        await flushReactive(localSource.state)
        const localKeyframe = localDelayed.replayBatch!.keyframe()
        ok(localDelayed.replayBatch!.head() == 1 && localKeyframe?.seq == 1
            && (localKeyframe?.event[0][0].value as Quotes).LOCAL.c == 3,
        'local replayBatch reads flush delayed patches before sampling keyframe/head coordinates')
        localDelayed.close()
    }

    console.log('\n[store-replay-batch] v1-v5 bounds and malformed live envelopes')
    {
        const source = createStore<Record<string, any>>({})
        const explicit = createExplicitPatchSource()
        const exposed = exposeStoreReplay(source, {
            patchSource: explicit.api,
            batch: {maxBytes: 800, now: function fixedV3Clock() { return 1 }},
        })
        const wires: unknown[] = []
        const off = exposed.api.replay.batch!.v3!.line.on(function collectBoundedV3(wire) { wires.push(wire) })
        function undefinedFields(prefix: string) {
            const value: Record<string, undefined> = {}
            for (let index = 0; index < 40; index++) value[prefix + index] = undefined
            return value
        }
        explicit.emit([
            {path: ['A'], exists: true, value: undefinedFields('a')},
            {path: ['B'], exists: true, value: undefinedFields('b')},
        ])
        const boundedBytes = wires.map(function measureV3Wire(wire) {
            return storeReplayBatchV3JsonBytes(wire as any)
        })
        ok(wires.length == 2 && boundedBytes.every(bytes => bytes <= 800),
            `maxBytes bounds recursively escaped v3 values (${boundedBytes.join(',')})`)
        off()
        exposed.close()

        const binaryPatches: StorePatch[] = Array.from({length: 256}, function makeBinaryPatch(_, index) {
            return {path: ['B' + index], exists: true, value: new Uint8Array([index & 255])}
        })
        const independentPatchLimit = 48 + binaryPatches.reduce(function sumIndependentPatchBytes(total, patch) {
            return total + storeReplayPatchMaxWireBytes(patch) + 1
        }, 0)
        const unsplitBinaryBytes = rpcResultWireByteLength(encodeStoreReplayBatch({
            seq: 1, ts: 1, event: [binaryPatches],
        }))
        const binarySource = createStore<Record<string, any>>({})
        const binaryExplicit = createExplicitPatchSource()
        const binaryBounded = exposeStoreReplay(binarySource, {
            patchSource: binaryExplicit.api,
            batch: {maxItems: 256, maxBytes: independentPatchLimit, now: function fixedBinaryClock() { return 1 }},
        })
        const binaryWireBytes: number[][] = [[], [], [], [], []]
        const offBinaryV1 = binaryBounded.api.replay.batch!.line.on(function measureBinaryV1(wire) {
            binaryWireBytes[0].push(rpcResultWireByteLength(wire))
        })
        const offBinaryV2 = binaryBounded.api.replay.batch!.v2!.line.on(function measureBinaryV2(wire) {
            binaryWireBytes[1].push(rpcResultWireByteLength(wire))
        })
        const offBinaryV3 = binaryBounded.api.replay.batch!.v3!.line.on(function measureBinaryV3(wire) {
            binaryWireBytes[2].push(rpcResultWireByteLength(wire))
        })
        const offBinaryV4 = binaryBounded.api.replay.batch!.v4!.line.on(function measureBinaryV4(wire) {
            binaryWireBytes[3].push(rpcResultWireByteLength(wire))
        })
        const offBinaryV5 = binaryBounded.api.replay.batch!.v5!.line.on(function measureBinaryV5(wire) {
            binaryWireBytes[4].push(rpcResultWireByteLength(wire))
        })
        binaryExplicit.emit(binaryPatches)
        ok(unsplitBinaryBytes > independentPatchLimit
            && binaryWireBytes.every(generation => generation.length > 1
                && generation.every(bytes => bytes <= independentPatchLimit)),
        'maxBytes conservatively bounds every simultaneously exposed v1-v5 envelope')
        offBinaryV1()
        offBinaryV2()
        offBinaryV3()
        offBinaryV4()
        offBinaryV5()
        binaryBounded.close()

        const hardSource = createStore<Record<string, any>>({})
        const hardExplicit = createExplicitPatchSource()
        const hardBounded = exposeStoreReplay(hardSource, {
            patchSource: hardExplicit.api,
            batch: {maxItems: 256, maxBytes: 20_000_000},
        })
        const hardWires: Uint8Array[] = []
        const offHard = hardBounded.api.replay.batch!.v5!.line.on(function collectHardSplit(wire) {
            hardWires.push(wire)
        })
        const maxBinaryLeaf = new Uint8Array(8_000_000)
        maxBinaryLeaf[0] = 1
        maxBinaryLeaf[maxBinaryLeaf.length - 1] = 2
        hardExplicit.emit([
            {path: ['A'], exists: true, value: maxBinaryLeaf},
            {path: ['B'], exists: true, value: maxBinaryLeaf},
        ])
        const hardDecoded = hardWires.map(function decodeHardSplit(wire) {
            return decodeStoreReplayBatchV5(wire)
        })
        ok(hardWires.length == 2
            && hardDecoded.every(event => (event.event[0][0].value as Uint8Array).byteLength == 8_000_000),
        'the v5 hard frame ceiling splits two valid 8 MB leaves even when maxBytes is larger')
        offHard()
        hardBounded.close()

        const invalidSource = createStore<Record<string, any>>({})
        const invalidExplicit = createExplicitPatchSource()
        let invalidJournal = 0
        const invalidExposed = exposeStoreReplay(invalidSource, {
            patchSource: invalidExplicit.api,
            batch: {
                maxItems: 1,
                onJournal() { invalidJournal++ },
            },
        })
        let invalidLive = 0
        const offInvalid = invalidExposed.api.replay.batch!.v5!.line.on(function countInvalidLive() {
            invalidLive++
        })
        const cyclic: any = {}
        cyclic.self = cyclic
        const invalidLegacyHead = invalidExposed.replay.head()
        const invalidBatchHead = invalidExposed.replayBatch!.head()
        let invalidRejected = false
        try {
            invalidExplicit.emit([
                {path: ['valid-prefix'], exists: true, value: {ok: true}},
                {path: ['invalid-suffix'], exists: true, value: cyclic},
            ])
        } catch (error) {
            invalidRejected = error instanceof TypeError
        }
        ok(invalidRejected
            && invalidExposed.replay.head() == invalidLegacyHead
            && invalidExposed.replayBatch!.head() == invalidBatchHead
            && invalidJournal == 0
            && invalidLive == 0,
        'an invalid v5 suffix rejects before legacy/batch journal, head or partial live publication')
        offInvalid()
        invalidExposed.close()

        let live: ((wire: any) => void) | null = null
        let active = 0
        const batchRemote = {
            line: {on() { return function offV1Line() {} }},
            since() { return [] },
            keyframe() { return null },
            v3: {
                line: {
                    on(cb: (wire: any) => void) {
                        active++
                        live = cb
                        return function offMalformedV3Line() { active--; live = null }
                    },
                },
                since() { return [] },
                keyframe() { return null },
            },
        } as StoreReplayBatchRemote
        const mirror = createStore<Record<string, any>>({})
        const errors: unknown[] = []
        const sync = syncStoreReplayBatch(mirror, batchRemote, {
            onError(error) { errors.push(error) },
        })
        await sync.ready
        const deliverMalformed = live!
        deliverMalformed([3, 0, 1, [['A', 3, {'$_sr': 1, entries: [[42, 0]]}]]])
        await delay(0)
        deliverMalformed([3, 0, 2, [['A', {ok: true}]]])
        ok(errors.length == 1 && String(errors[0]).includes('invalid escaped object entry')
            && sync.seq() == -1 && active == 0 && json(mirror.snapshot()) == '{}',
        'malformed live v3 rejects through onError, detaches the line and keeps seq/state honest')
        sync()

        let binaryLive: ((wire: Uint8Array) => void) | null = null
        let binaryActive = 0
        const binaryRemote = {
            line: {on() { return function offBinaryFallbackLine() {} }},
            since() { return [] },
            keyframe() { return null },
            v5: {
                line: {
                    on(cb: (wire: Uint8Array) => void) {
                        binaryActive++
                        binaryLive = cb
                        return function offMalformedV5Line() { binaryActive--; binaryLive = null }
                    },
                },
                since() { return [] },
                keyframe() { return null },
            },
        } as StoreReplayBatchRemote
        const binaryMirror = createStore<Record<string, any>>({})
        const binaryErrors: unknown[] = []
        const binarySync = syncStoreReplayBatch(binaryMirror, binaryRemote, {
            onError(error) { binaryErrors.push(error) },
        })
        await binarySync.ready
        const deliverMalformedBinary = binaryLive!
        const malformedBinary = encodeStoreReplayBatchV5({
            seq: 0,
            ts: 1,
            event: [[{path: ['A'], exists: true, value: {ok: false}}]],
        })
        malformedBinary[0] ^= 255
        deliverMalformedBinary(malformedBinary)
        await delay(0)
        deliverMalformedBinary(encodeStoreReplayBatchV5({
            seq: 0,
            ts: 2,
            event: [[{path: ['A'], exists: true, value: {ok: true}}]],
        }))
        ok(binaryErrors.length == 1 && String(binaryErrors[0]).includes('magic mismatch')
            && binarySync.seq() == -1 && binaryActive == 0 && json(binaryMirror.snapshot()) == '{}',
        'malformed live v5 rejects atomically, detaches the byte line and ignores later delivery')
        binarySync()
    }

    console.log('\n[store-replay-batch] failed compact precommit retains the exact batch for retry')
    {
        const source = createStore<Quotes>({}, {drain: 'micro'})
        let rejectBatch = true
        const persisted: number[][] = []
        const exposed = exposeStoreReplay(source, {
            batch: {
                onJournalBatch(events) {
                    if (rejectBatch) throw new Error('batch archive unavailable')
                    persisted.push(events.map(event => event.seq))
                },
            },
        })
        const delivered: number[] = []
        exposed.replayBatch!.line.on(function countRetriedBatch(event) {
            delivered.push(event.event[0].length)
        })
        let failed = false
        function captureBatchPrecommitFailure() { failed = true }
        process.once('uncaughtException', captureBatchPrecommitFailure)
        source.state.A = {c: 1, t: 1}
        source.state.B = {c: 2, t: 2}
        await flushReactive(source.state)
        await delay(5)
        process.removeListener('uncaughtException', captureBatchPrecommitFailure)
        ok(failed && exposed.replay.head() == 2 && exposed.replayBatch!.head() == 0,
            'a failed batch precommit leaves its compact head unpublished without rolling legacy back')

        rejectBatch = false
        exposed.flushPending()
        ok(exposed.replay.head() == 2 && exposed.replayBatch!.head() == 1,
            'explicit retry publishes the retained compact batch without duplicating legacy coordinates')
        ok(json(delivered) == json([2]) && json(persisted) == json([[1]]),
            'retained compact patches persist and fan out exactly once')
        exposed.close()

        const boundedSource = createStore<Quotes>({}, {drain: 'micro'})
        let failuresLeft = 2
        const boundedPersisted: number[] = []
        const bounded = exposeStoreReplay(boundedSource, {
            batch: {
                maxItems: 1,
                onJournalBatch(events) {
                    if (failuresLeft-- > 0) throw new Error('bounded batch archive unavailable')
                    boundedPersisted.push(...events.map(event => event.seq))
                },
            },
        })
        const boundedDelivered: string[] = []
        bounded.replayBatch!.line.on(function countBoundedRetry(event) {
            boundedDelivered.push(String(event.event[0][0].path[0]))
        })
        async function writeWithCapturedFailure(key: string) {
            let surfaced = false
            function captureBoundedFailure() { surfaced = true }
            process.once('uncaughtException', captureBoundedFailure)
            boundedSource.state[key] = {c: 1, t: 1}
            await flushReactive(boundedSource.state)
            await delay(5)
            process.removeListener('uncaughtException', captureBoundedFailure)
            return surfaced
        }
        const failedA = await writeWithCapturedFailure('A')
        const failedB = await writeWithCapturedFailure('B')
        bounded.flushPending()
        ok(failedA && failedB && bounded.replay.head() == 2 && bounded.replayBatch!.head() == 2,
            'a retained boundary failure queues the complete next Store window before retrying')
        ok(json(boundedDelivered) == json(['A', 'B']) && json(boundedPersisted) == json([1, 2]),
            'bounded retry loses neither the old retained chunk nor the new input chunk')
        bounded.close()
    }

    console.log('\n[store-replay-batch] batch inherits the top-level replay clock')
    {
        const source = createStore<Quotes>({}, {drain: 'micro'})
        const exposed = exposeStoreReplay(source, {now: () => 777, batch: true})
        const legacyTs: number[] = []
        const batchTs: number[] = []
        const offLegacy = exposed.replay.line.on(event => legacyTs.push(event.ts))
        const offBatch = exposed.replayBatch!.line.on(event => batchTs.push(event.ts))
        source.state.A = {c: 1, t: 1}
        await flushReactive(source.state)
        ok(json(legacyTs) == json([777]) && json(batchTs) == json([777]),
            'boolean batch and legacy replay use the same injected now()')
        offLegacy()
        offBatch()
        exposed.close()
    }

    console.log('\n[store-replay-batch] negotiated fallback ladder and old-client surface')
    {
        const source = createStore<Quotes>({}, {drain: 'micro'})
        const exposed = exposeStoreReplay(source, {batch: true})
        const remote = exposed.api.replay as StoreReplayRemote
        const {
            v2: _removedV2, v3: _removedV3, v4: _removedV4, v5: _removedV5, v6: _removedV6,
            ...v1Batch
        } = remote.batch!
        const {
            v3: _removedV3FromV2, v4: _removedV4FromV2, v5: _removedV5FromV2,
            v6: _removedV6FromV2,
            ...v2Batch
        } = remote.batch!
        const {
            v4: _removedV4FromV3, v5: _removedV5FromV3, v6: _removedV6FromV3,
            ...v3Batch
        } = remote.batch!
        const {
            v5: _removedV5FromV4, v6: _removedV6FromV4,
            ...v4Batch
        } = remote.batch!
        const {v6: _removedV6FromV5, ...v5Batch} = remote.batch!
        let v5FallbackKeyframes = 0
        const countedV5Batch = {
            ...v5Batch,
            v5: {
                ...v5Batch.v5!,
                keyframe() {
                    v5FallbackKeyframes++
                    return v5Batch.v5!.keyframe()
                },
            },
        }

        const oldMirror = createStore<Quotes>({}, {drain: 'micro'})
        const oldV1Client = syncStoreReplayBatch(oldMirror, v1Batch as StoreReplayBatchRemote)
        await oldV1Client.ready
        const v1Mirror = createStore<Quotes>({}, {drain: 'micro'})
        const v1OnlyServer = syncStoreReplay(v1Mirror, {...remote, batch: v1Batch}, {batch: true})
        await v1OnlyServer.ready
        const v2Mirror = createStore<Quotes>({}, {drain: 'micro'})
        const v2OnlyServer = syncStoreReplay(v2Mirror, {...remote, batch: v2Batch}, {batch: true})
        await v2OnlyServer.ready
        const v3Mirror = createStore<Quotes>({}, {drain: 'micro'})
        const v3OnlyServer = syncStoreReplay(v3Mirror, {...remote, batch: v3Batch}, {batch: true})
        await v3OnlyServer.ready
        const v4Mirror = createStore<Quotes>({}, {drain: 'micro'})
        const v4OnlyServer = syncStoreReplay(v4Mirror, {...remote, batch: v4Batch}, {batch: true})
        await v4OnlyServer.ready
        const v5Mirror = createStore<Quotes>({}, {drain: 'micro'})
        const v5Server = syncStoreReplay(v5Mirror, {...remote, batch: countedV5Batch}, {batch: true})
        await v5Server.ready
        const v6Mirror = createStore<Quotes>({}, {drain: 'micro'})
        const v6Server = syncStoreReplay(v6Mirror, remote, {batch: true})
        await v6Server.ready

        source.state.BTC = {c: 10, t: 1}
        source.state.ETH = {c: 20, t: 1}
        await flushReactive(source.state)
        await flushReactive(oldMirror.state)
        await flushReactive(v1Mirror.state)
        await flushReactive(v2Mirror.state)
        await flushReactive(v3Mirror.state)
        await flushReactive(v4Mirror.state)
        await flushReactive(v5Mirror.state)
        await flushReactive(v6Mirror.state)
        const v1Keyframe = await v1Batch.keyframe()

        ok(v1Keyframe?.[0] == 1 && isDeepStrictEqual(oldMirror.snapshot(), source.snapshot()),
            'old v1 client consumes the unchanged v1 surface of a new server')
        ok(isDeepStrictEqual(v1Mirror.snapshot(), source.snapshot()),
            'new client falls through v5/v4/v3/v2 to batch v1')
        ok(isDeepStrictEqual(v2Mirror.snapshot(), source.snapshot()),
            'new client falls through v5/v4/v3 to batch v2')
        ok(isDeepStrictEqual(v3Mirror.snapshot(), source.snapshot()),
            'new client falls through v5/v4 to batch v3')
        ok(isDeepStrictEqual(v4Mirror.snapshot(), source.snapshot()),
            'new client falls through v5 to JSON-columnar v4')
        ok(v5FallbackKeyframes == 1 && isDeepStrictEqual(v5Mirror.snapshot(), source.snapshot()),
            'missing v6 falls through exactly to Store-specific binary v5')
        ok(isDeepStrictEqual(v6Mirror.snapshot(), source.snapshot()),
            'new client selects universal-schema v6 when the complete surface is present')
        oldV1Client()
        v1OnlyServer()
        v2OnlyServer()
        v3OnlyServer()
        v4OnlyServer()
        v5Server()
        v6Server()
        exposed.close()
    }

    console.log('\n[store-replay-batch] reconnect frame, codec and old-server fallback')
    {
        const source = createStore<Quotes>({}, {drain: 'micro'})
        const exposed = exposeStoreReplay(source, {history: 2, batch: true})
        const remote = exposed.api.replay as StoreReplayRemote
        const mirror = createStore<Quotes>({}, {drain: 'micro'})
        const first = syncStoreReplay(mirror, remote, {batch: true})
        await first.ready
        const since = first.seq()
        first()

        source.state.BTC = {c: 1, t: 1}
        source.state.ETH = {c: 2, t: 1}
        await flushReactive(source.state)
        source.state.BTC = {c: 3, t: 2}
        source.state.SOL = {c: 4, t: 2}
        await flushReactive(source.state)

        const frameWire = await remote.batch!.frame!(since)
        const frame = frameWire!.flatMap(wire => decodeStoreReplayBatch(wire).event[0])
        ok(frame.length == 3, `frame keeps last BTC plus untouched ETH/SOL (${frame.length} patches)`)
        const second = syncStoreReplay(mirror, remote, {batch: true, since})
        await second.ready
        await flushReactive(mirror.state)
        ok(isDeepStrictEqual(mirror.snapshot(), source.snapshot()), 'since/frame reconnect converges')
        second()

        const patches: StorePatch[] = Array.from({length: 200}, (_, i) => ({
            path: ['S' + i], exists: true, value: {c: i + 0.25, t: 10_000 + i},
        }))
        const event = {seq: 123, ts: 456, event: [patches] as [StorePatch[]]}
        const wire = encodeStoreReplayBatch(event)
        const wireV2 = encodeStoreReplayBatchV2(event)
        const wireV3 = encodeStoreReplayBatchV3(event)
        const wireV4 = encodeStoreReplayBatchV4(event)
        const wireV5 = encodeStoreReplayBatchV5(event)
        const legacyBytes = new TextEncoder().encode(JSON.stringify(patches.map((patch, i) => ({
            seq: i + 1, ts: 456, event: [patch],
        })))).byteLength
        const batchBytes = storeReplayBatchJsonBytes(wire)
        const batchV2Bytes = storeReplayBatchV2JsonBytes(wireV2)
        const batchV3Bytes = storeReplayBatchV3JsonBytes(wireV3)
        const batchV4Bytes = rpcResultWireByteLength(wireV4)
        const batchV5Bytes = rpcResultWireByteLength(wireV5)
        ok(batchBytes < legacyBytes * 0.65, `compact tuple batch cuts JSON bytes (${legacyBytes} -> ${batchBytes})`)
        ok(batchV2Bytes < batchBytes * 0.92,
            `packed v2 cuts batch bytes again (${batchBytes} -> ${batchV2Bytes})`)
        ok(batchV3Bytes == batchV2Bytes,
            `v3 adds no bytes when values contain no explicit undefined (${batchV3Bytes})`)
        ok(batchV4Bytes < batchV3Bytes,
            `columnar v4 removes repeated object field names (${batchV3Bytes} -> ${batchV4Bytes})`)
        ok(batchV5Bytes < batchV4Bytes && wireV5[0] == 0x53 && wireV5[3] == 5,
            `binary v5 packs the same column plan into one smaller byte frame (${batchV4Bytes} -> ${batchV5Bytes})`)

        exposed.close()

        const evictedSource = createStore<Quotes>({}, {drain: 'micro'})
        const evicted = exposeStoreReplay(evictedSource, {batch: {history: 1}})
        const evictedMirror = createStore<Quotes>({}, {drain: 'micro'})
        evictedSource.state.A = {c: 1, t: 1}
        await flushReactive(evictedSource.state)
        evictedSource.state.B = {c: 2, t: 2}
        await flushReactive(evictedSource.state)
        const evictedSync = syncStoreReplay(evictedMirror, evicted.api.replay as StoreReplayRemote, {batch: true, since: 0})
        await evictedSync.ready
        await flushReactive(evictedMirror.state)
        ok(isDeepStrictEqual(evictedMirror.snapshot(), evictedSource.snapshot()), 'evicted batch journal falls back to one root keyframe')
        evictedSync()
        evicted.close()

        const oldSource = createStore<Quotes>({}, {drain: 'micro'})
        const old = exposeStoreReplay(oldSource)
        const oldMirror = createStore<Quotes>({}, {drain: 'micro'})
        const fallback = syncStoreReplay(oldMirror, old.api.replay as StoreReplayRemote, {batch: true})
        await fallback.ready
        oldSource.state.BTC = {c: 5, t: 5}
        await flushReactive(oldSource.state)
        await flushReactive(oldMirror.state)
        ok(isDeepStrictEqual(oldMirror.snapshot(), oldSource.snapshot()), 'new client falls back to legacy when batch capability is absent')
        fallback()
        old.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
