// =====================================================================
// Store Replay batch wire codec — compact, versioned tuples
// =====================================================================

import type {ReplayEvent} from '../events/replay-listen'
import type {StorePatch} from './store'
import {rpcResultWireByteLength, rpcResultWireMetrics} from '../rcp/rpc-wire-size'
import {
    encodeStoreReplayBatchV4 as encodeStoreReplayBatchV4ForMetrics,
    encodeStoreReplayBatchV5 as encodeStoreReplayBatchV5ForMetrics,
} from './store-replay-columnar'
import type {
    tStoreReplayWireBatchV4 as tStoreReplayWireBatchV4ForMetrics,
    tStoreReplayWireBatchV5 as tStoreReplayWireBatchV5ForMetrics,
} from './store-replay-columnar'
export {
    STORE_REPLAY_BATCH_V4_VERSION,
    prepareStoreReplayBatchPlan,
    decodeStoreReplayBatchPlan,
    encodeStoreReplayBatchV4,
    decodeStoreReplayBatchV4,
    encodeStoreReplayBatchV5,
    decodeStoreReplayBatchV5,
} from './store-replay-columnar'
export type {
    tStoreReplayBatchPlan,
    tStoreReplayBatchPlanRun,
    tStoreReplayWireBatchV4,
    tStoreReplayWireBatchV5,
} from './store-replay-columnar'

export const STORE_REPLAY_BATCH_VERSION = 1 as const
export const STORE_REPLAY_BATCH_V2_VERSION = 2 as const
export const STORE_REPLAY_BATCH_V3_VERSION = 3 as const
const STORE_REPLAY_VALUE_TAG = '$_sr'
const RPC_WIRE_VALUE_TAG_NAMES = ['$_f', '$_d', '$_m', '$_s', '$_r', '$_b'] as const
const RPC_WIRE_VALUE_TAGS = new Set<string>(RPC_WIRE_VALUE_TAG_NAMES)
const utf8Encoder = new TextEncoder()

// ============================================================
// wire contracts
// ============================================================

export type tStoreReplayWirePatch =
    | [path: PropertyKey[], op: 1, value: unknown]
    | [path: PropertyKey[], op: 0]
    | [path: PropertyKey[], op: 2]

export type tStoreReplayWireBatch = [
    version: typeof STORE_REPLAY_BATCH_VERSION,
    seq: number,
    ts: number,
    patches: tStoreReplayWirePatch[],
]

export type tStoreReplayWirePatchV2 =
    | [key: PropertyKey, value: unknown]
    | [key: PropertyKey]
    | [path: PropertyKey[], value: unknown]
    | [path: PropertyKey[]]
    | [target: PropertyKey | PropertyKey[], op: 2, marker: 0]

export type tStoreReplayWireBatchV2 = [
    version: typeof STORE_REPLAY_BATCH_V2_VERSION,
    seq: number,
    ts: number,
    patches: tStoreReplayWirePatchV2[],
]

export type tStoreReplayWirePatchV3 =
    | tStoreReplayWirePatchV2
    | [target: PropertyKey | PropertyKey[], op: 3, value: unknown]

export type tStoreReplayWireBatchV3 = [
    version: typeof STORE_REPLAY_BATCH_V3_VERSION,
    seq: number,
    ts: number,
    patches: tStoreReplayWirePatchV3[],
]

// ============================================================
// v3 value escaping
// ============================================================

function owns(value: object, key: PropertyKey) {
    return Object.prototype.hasOwnProperty.call(value, key)
}

function isReservedWireKey(key: string) {
    return key == '__proto__' || key == 'constructor' || key == 'prototype'
}

function isOpaqueWireValue(value: object) {
    return value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer
        || ArrayBuffer.isView(value)
}

function isPlainWireObject(value: object) {
    return Object.getPrototypeOf(value) == Object.prototype
}

function needsWireObjectEscape(value: object, keys: readonly string[]) {
    const record = value as Record<string, unknown>
    return owns(value, STORE_REPLAY_VALUE_TAG)
        || keys.some(isReservedWireKey)
        || (keys.length == 1 && RPC_WIRE_VALUE_TAGS.has(keys[0]))
        || Object.is(record['_placeholder'], true)
}

function isDirectWireLeaf(value: unknown) {
    return value !== undefined
        && (value == null || typeof value != 'object' || isOpaqueWireValue(value))
}

function copyObjectPrefix(source: Record<string, unknown>, keys: readonly string[], end: number) {
    const copied: Record<string, unknown> = {}
    for (let index = 0; index < end; index++) {
        const key = keys[index]
        defineDecodedValue(copied, key, source[key])
    }
    return copied
}

function copyMapPrefix(source: Map<unknown, unknown>, end: number) {
    const copied = new Map<unknown, unknown>()
    let index = 0
    for (const [key, item] of source) {
        if (index == end) break
        copied.set(key, item)
        index++
    }
    return copied
}

function copySetPrefix(source: Set<unknown>, end: number) {
    const copied = new Set<unknown>()
    let index = 0
    for (const item of source) {
        if (index == end) break
        copied.add(item)
        index++
    }
    return copied
}

function encodeStoreReplayValue(value: unknown, seen?: WeakSet<object>): unknown {
    if (value === undefined) return {[STORE_REPLAY_VALUE_TAG]: 0}
    if (value == null || typeof value != 'object' || isOpaqueWireValue(value)) return value
    let knownKeys: string[] | undefined
    if (Array.isArray(value)) {
        let direct = true
        for (let index = 0; index < value.length; index++) {
            if (index in value && !isDirectWireLeaf(value[index])) {
                direct = false
                break
            }
        }
        if (direct) return value
    } else if (value instanceof Map) {
        let direct = true
        for (const [key, item] of value) {
            if (!isDirectWireLeaf(key) || !isDirectWireLeaf(item)) {
                direct = false
                break
            }
        }
        if (direct) return value
    } else if (value instanceof Set) {
        let direct = true
        for (const item of value) {
            if (!isDirectWireLeaf(item)) {
                direct = false
                break
            }
        }
        if (direct) return value
    } else if (isPlainWireObject(value)) {
        knownKeys = Object.keys(value)
        const record = value as Record<string, unknown>
        if (!needsWireObjectEscape(value, knownKeys)
            && knownKeys.every(function hasDirectWireValue(key) {
                return isDirectWireLeaf(record[key])
            })) {
            return value
        }
    }
    const active = seen ?? new WeakSet<object>()
    if (active.has(value)) throw new TypeError('store replay batch v3: cyclic values are not supported')
    active.add(value)
    try {
        if (Array.isArray(value)) {
            let encoded: unknown[] | undefined
            for (let index = 0; index < value.length; index++) {
                if (!(index in value)) continue
                const item = value[index]
                const encodedItem = encodeStoreReplayValue(item, active)
                if (!encoded && !Object.is(encodedItem, item)) encoded = value.slice()
                if (encoded) encoded[index] = encodedItem
            }
            return encoded ?? value
        }
        if (value instanceof Map) {
            let encoded: Map<unknown, unknown> | undefined
            let index = 0
            for (const [key, item] of value) {
                const encodedKey = encodeStoreReplayValue(key, active)
                const encodedItem = encodeStoreReplayValue(item, active)
                if (!encoded && (!Object.is(encodedKey, key) || !Object.is(encodedItem, item))) {
                    encoded = copyMapPrefix(value, index)
                }
                if (encoded) encoded.set(encodedKey, encodedItem)
                index++
            }
            return encoded ?? value
        }
        if (value instanceof Set) {
            let encoded: Set<unknown> | undefined
            let index = 0
            for (const item of value) {
                const encodedItem = encodeStoreReplayValue(item, active)
                if (!encoded && !Object.is(encodedItem, item)) encoded = copySetPrefix(value, index)
                if (encoded) encoded.add(encodedItem)
                index++
            }
            return encoded ?? value
        }
        const keys = knownKeys ?? Object.keys(value)
        if (needsWireObjectEscape(value, keys)) {
            return {
                [STORE_REPLAY_VALUE_TAG]: 1,
                entries: keys.map(function encodeStoreReplayObjectEntry(key) {
                    return [key, encodeStoreReplayValue((value as Record<string, unknown>)[key], active)]
                }),
            }
        }
        const record = value as Record<string, unknown>
        let encoded: Record<string, unknown> | undefined = isPlainWireObject(value) ? undefined : {}
        for (let index = 0; index < keys.length; index++) {
            const key = keys[index]
            const item = record[key]
            const encodedItem = encodeStoreReplayValue(item, active)
            if (!encoded && !Object.is(encodedItem, item)) encoded = copyObjectPrefix(record, keys, index)
            if (encoded) defineDecodedValue(encoded, key, encodedItem)
        }
        return encoded ?? value
    } finally {
        active.delete(value)
    }
}

function defineDecodedValue(target: Record<string, unknown>, key: string, value: unknown) {
    Object.defineProperty(target, key, {configurable: true, enumerable: true, writable: true, value})
}

function decodeStoreReplayValue(value: unknown): unknown {
    if (value == null || typeof value != 'object' || isOpaqueWireValue(value)) return value
    if (Array.isArray(value)) {
        let direct = true
        for (let index = 0; index < value.length; index++) {
            if (index in value && !isDirectWireLeaf(value[index])) {
                direct = false
                break
            }
        }
        if (direct) return value
        let decoded: unknown[] | undefined
        for (let index = 0; index < value.length; index++) {
            if (!(index in value)) continue
            const item = value[index]
            const decodedItem = decodeStoreReplayValue(item)
            if (!decoded && !Object.is(decodedItem, item)) decoded = value.slice()
            if (decoded) decoded[index] = decodedItem
        }
        return decoded ?? value
    }
    if (value instanceof Map) {
        let direct = true
        for (const [key, item] of value) {
            if (!isDirectWireLeaf(key) || !isDirectWireLeaf(item)) {
                direct = false
                break
            }
        }
        if (direct) return value
        let decoded: Map<unknown, unknown> | undefined
        let index = 0
        for (const [key, item] of value) {
            const decodedKey = decodeStoreReplayValue(key)
            const decodedItem = decodeStoreReplayValue(item)
            if (!decoded && (!Object.is(decodedKey, key) || !Object.is(decodedItem, item))) {
                decoded = copyMapPrefix(value, index)
            }
            if (decoded) decoded.set(decodedKey, decodedItem)
            index++
        }
        return decoded ?? value
    }
    if (value instanceof Set) {
        let direct = true
        for (const item of value) {
            if (!isDirectWireLeaf(item)) {
                direct = false
                break
            }
        }
        if (direct) return value
        let decoded: Set<unknown> | undefined
        let index = 0
        for (const item of value) {
            const decodedItem = decodeStoreReplayValue(item)
            if (!decoded && !Object.is(decodedItem, item)) decoded = copySetPrefix(value, index)
            if (decoded) decoded.add(decodedItem)
            index++
        }
        return decoded ?? value
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length == 1 && keys[0] == STORE_REPLAY_VALUE_TAG && record[STORE_REPLAY_VALUE_TAG] == 0) {
        return undefined
    }
    if (keys.length == 2 && keys.includes(STORE_REPLAY_VALUE_TAG) && keys.includes('entries')
        && record[STORE_REPLAY_VALUE_TAG] == 1 && Array.isArray(record['entries'])) {
        const decoded: Record<string, unknown> = {}
        for (const entry of record['entries']) {
            if (!Array.isArray(entry) || entry.length != 2 || typeof entry[0] != 'string') {
                throw new TypeError('store replay batch v3: invalid escaped object entry')
            }
            defineDecodedValue(decoded, entry[0], decodeStoreReplayValue(entry[1]))
        }
        return decoded
    }
    const shareable = isPlainWireObject(value) && !needsWireObjectEscape(value, keys)
    if (shareable && keys.every(function hasDirectDecodedValue(key) {
        return isDirectWireLeaf(record[key])
    })) return value
    let decoded: Record<string, unknown> | undefined = shareable
        ? undefined
        : {}
    for (let index = 0; index < keys.length; index++) {
        const key = keys[index]
        const item = record[key]
        const decodedItem = decodeStoreReplayValue(item)
        if (!decoded && !Object.is(decodedItem, item)) decoded = copyObjectPrefix(record, keys, index)
        if (decoded) defineDecodedValue(decoded, key, decodedItem)
    }
    return decoded ?? value
}

// ============================================================
// patch codecs
// ============================================================

export function encodeStoreReplayPatch(patch: StorePatch): tStoreReplayWirePatch {
    const path = [...patch.path]
    if (!patch.exists) return [path, 0]
    return patch.value === undefined ? [path, 2] : [path, 1, patch.value]
}

export function decodeStoreReplayPatch(wire: tStoreReplayWirePatch | unknown): StorePatch {
    if (!Array.isArray(wire) || !Array.isArray(wire[0])) throw new TypeError('store replay batch: invalid patch tuple')
    if (wire[1] == 0 && wire.length == 2) return {path: [...wire[0]], exists: false, value: undefined}
    if (wire[1] == 2 && wire.length == 2) return {path: [...wire[0]], exists: true, value: undefined}
    if (wire[1] == 1 && wire.length == 3) return {path: [...wire[0]], exists: true, value: wire[2]}
    throw new TypeError('store replay batch: unknown patch operation')
}

function v2Path(value: unknown) {
    if (Array.isArray(value)) return [...value]
    if (typeof value == 'string' || typeof value == 'number' || typeof value == 'symbol') return [value]
    throw new TypeError('store replay batch v2: invalid path')
}

export function encodeStoreReplayPatchV2(patch: StorePatch): tStoreReplayWirePatchV2 {
    const target = patch.path.length == 1 ? patch.path[0] : [...patch.path]
    if (patch.exists && patch.value === undefined) return [target, 2, 0]
    if (patch.path.length == 1) {
        const key = patch.path[0]
        return patch.exists ? [key, patch.value] : [key]
    }
    const path = [...patch.path]
    return patch.exists ? [path, patch.value] : [path]
}

export function decodeStoreReplayPatchV2(wire: tStoreReplayWirePatchV2 | unknown): StorePatch {
    if (!Array.isArray(wire) || (wire.length != 1 && wire.length != 2 && wire.length != 3)) {
        throw new TypeError('store replay batch v2: invalid patch tuple')
    }
    const path = v2Path(wire[0])
    if (wire.length == 3) {
        if (wire[1] == 2 && wire[2] == 0) return {path, exists: true, value: undefined}
        throw new TypeError('store replay batch v2: unknown patch operation')
    }
    return wire.length == 2
        ? {path, exists: true, value: wire[1]}
        : {path, exists: false, value: undefined}
}

export function encodeStoreReplayPatchV3(patch: StorePatch): tStoreReplayWirePatchV3 {
    if (patch.exists && patch.value === undefined) {
        const target = patch.path.length == 1 ? patch.path[0] : [...patch.path]
        return [target, 2, 0]
    }
    if (patch.path.length == 1) {
        const key = patch.path[0]
        if (!patch.exists) return [key]
        const encoded = encodeStoreReplayValue(patch.value)
        return Object.is(encoded, patch.value) ? [key, patch.value] : [key, 3, encoded]
    }
    const path = [...patch.path]
    if (!patch.exists) return [path]
    const encoded = encodeStoreReplayValue(patch.value)
    return Object.is(encoded, patch.value) ? [path, patch.value] : [path, 3, encoded]
}

export function decodeStoreReplayPatchV3(wire: tStoreReplayWirePatchV3 | unknown): StorePatch {
    if (Array.isArray(wire) && wire.length == 3 && wire[1] == 3) {
        return {path: v2Path(wire[0]), exists: true, value: decodeStoreReplayValue(wire[2])}
    }
    return decodeStoreReplayPatchV2(wire)
}

// ============================================================
// envelope codecs
// ============================================================

export function encodeStoreReplayBatch(event: ReplayEvent<[readonly StorePatch[]]>): tStoreReplayWireBatch {
    return [STORE_REPLAY_BATCH_VERSION, event.seq, event.ts, event.event[0].map(encodeStoreReplayPatch)]
}

export function decodeStoreReplayBatch(wire: tStoreReplayWireBatch | unknown): ReplayEvent<[StorePatch[]]> {
    if (!Array.isArray(wire) || wire.length != 4 || wire[0] != STORE_REPLAY_BATCH_VERSION
        || typeof wire[1] != 'number' || typeof wire[2] != 'number' || !Array.isArray(wire[3])) {
        throw new TypeError('store replay batch: unsupported envelope')
    }
    return {
        seq: wire[1],
        ts: wire[2],
        event: [wire[3].map(decodeStoreReplayPatch)],
    }
}

export function encodeStoreReplayBatchV2(event: ReplayEvent<[readonly StorePatch[]]>): tStoreReplayWireBatchV2 {
    return [STORE_REPLAY_BATCH_V2_VERSION, event.seq, event.ts, event.event[0].map(encodeStoreReplayPatchV2)]
}

export function decodeStoreReplayBatchV2(wire: tStoreReplayWireBatchV2 | unknown): ReplayEvent<[StorePatch[]]> {
    if (!Array.isArray(wire) || wire.length != 4 || wire[0] != STORE_REPLAY_BATCH_V2_VERSION
        || typeof wire[1] != 'number' || typeof wire[2] != 'number' || !Array.isArray(wire[3])) {
        throw new TypeError('store replay batch v2: unsupported envelope')
    }
    return {
        seq: wire[1],
        ts: wire[2],
        event: [wire[3].map(decodeStoreReplayPatchV2)],
    }
}

export function encodeStoreReplayBatchV3(event: ReplayEvent<[readonly StorePatch[]]>): tStoreReplayWireBatchV3 {
    return [STORE_REPLAY_BATCH_V3_VERSION, event.seq, event.ts, event.event[0].map(encodeStoreReplayPatchV3)]
}

export function decodeStoreReplayBatchV3(wire: tStoreReplayWireBatchV3 | unknown): ReplayEvent<[StorePatch[]]> {
    if (!Array.isArray(wire) || wire.length != 4 || wire[0] != STORE_REPLAY_BATCH_V3_VERSION
        || typeof wire[1] != 'number' || typeof wire[2] != 'number' || !Array.isArray(wire[3])) {
        throw new TypeError('store replay batch v3: unsupported envelope')
    }
    return {
        seq: wire[1],
        ts: wire[2],
        event: [wire[3].map(decodeStoreReplayPatchV3)],
    }
}

// ============================================================
// wire sizing
// ============================================================

export function storeReplayBatchJsonBytes(wire: tStoreReplayWireBatch | ReplayEvent<[readonly StorePatch[]]>) {
    const tuple = Array.isArray(wire) ? wire : encodeStoreReplayBatch(wire)
    return utf8Encoder.encode(JSON.stringify(tuple)).byteLength
}

export function storeReplayBatchV2JsonBytes(wire: tStoreReplayWireBatchV2 | ReplayEvent<[readonly StorePatch[]]>) {
    const tuple = Array.isArray(wire) ? wire : encodeStoreReplayBatchV2(wire)
    return utf8Encoder.encode(JSON.stringify(tuple)).byteLength
}

export function storeReplayBatchV3JsonBytes(wire: tStoreReplayWireBatchV3 | ReplayEvent<[readonly StorePatch[]]>) {
    const tuple = Array.isArray(wire) ? wire : encodeStoreReplayBatchV3(wire)
    return utf8Encoder.encode(JSON.stringify(tuple)).byteLength
}

export function storeReplayBatchV4WireBytes(
    wire: tStoreReplayWireBatchV4ForMetrics | ReplayEvent<[readonly StorePatch[]]>,
) {
    const tuple = Array.isArray(wire) ? wire : encodeStoreReplayBatchV4ForMetrics(wire)
    return rpcResultWireByteLength(tuple)
}

export function storeReplayBatchV5WireBytes(
    wire: tStoreReplayWireBatchV5ForMetrics | ReplayEvent<[readonly StorePatch[]]>,
) {
    const binary = wire instanceof Uint8Array ? wire : encodeStoreReplayBatchV5ForMetrics(wire)
    return binary.byteLength
}

export function storeReplayPatchJsonBytes(patch: StorePatch) {
    return rpcResultWireByteLength(encodeStoreReplayPatch(patch))
}

/** Fast ingestion estimate for the legacy tuple generations. */
export function storeReplayPatchMaxWireMetrics(patch: StorePatch, firstBinaryIndex = 0) {
    // v1 strictly contains the v2 defined/delete tuple. Undefined is the only
    // inverse case: v2 adds ",0", while a one-key v1 path costs the same two bytes.
    if (!patch.exists) return rpcResultWireMetrics(encodeStoreReplayPatch(patch), firstBinaryIndex)
    if (patch.value === undefined) {
        const wire = patch.path.length == 1
            ? encodeStoreReplayPatch(patch)
            : encodeStoreReplayPatchV2(patch)
        return rpcResultWireMetrics(wire, firstBinaryIndex)
    }

    // Measure v1 first to retain its cyclic-value rejection and because it also
    // bounds byte-for-byte v2. Ordinary v3 values reuse the v2 tuple unchanged.
    const legacy = rpcResultWireMetrics(encodeStoreReplayPatch(patch), firstBinaryIndex)
    const v3Wire = encodeStoreReplayPatchV3(patch)
    if (v3Wire.length != 3 || v3Wire[1] != 3) return legacy

    const v3 = rpcResultWireMetrics(v3Wire, firstBinaryIndex)
    return {
        byteLength: Math.max(legacy.byteLength, v3.byteLength),
        binaryCount: Math.max(legacy.binaryCount, v3.binaryCount),
    }
}

export function storeReplayPatchMaxWireBytes(patch: StorePatch) {
    return storeReplayPatchMaxWireMetrics(patch).byteLength
}

/** Exact full-envelope bound across every simultaneously exposed generation. */
export function storeReplayBatchMaxWireMetrics(patches: readonly StorePatch[]) {
    const event: ReplayEvent<[readonly StorePatch[]]> = {
        seq: Number.MAX_SAFE_INTEGER,
        ts: Number.MAX_SAFE_INTEGER,
        event: [patches],
    }
    const metrics = [
        rpcResultWireMetrics(encodeStoreReplayBatch(event)),
        rpcResultWireMetrics(encodeStoreReplayBatchV2(event)),
        rpcResultWireMetrics(encodeStoreReplayBatchV3(event)),
        rpcResultWireMetrics(encodeStoreReplayBatchV4ForMetrics(event)),
        rpcResultWireMetrics(encodeStoreReplayBatchV5ForMetrics(event)),
    ]
    return {
        byteLength: Math.max(...metrics.map(metric => metric.byteLength)),
        binaryCount: Math.max(...metrics.map(metric => metric.binaryCount)),
    }
}
