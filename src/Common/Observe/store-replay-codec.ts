// =====================================================================
// Store Replay V2 batch wire codec
// =====================================================================

import type {ReplayEvent} from '../events/replay-listen'
import {rpcResultWireMetrics} from '../rcp/rpc-wire-size'
import type {StorePatch} from './store'

export const STORE_REPLAY_BATCH_V2_VERSION = 2 as const

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

const utf8Encoder = new TextEncoder()

function v2Path(value: unknown) {
    if (Array.isArray(value)) return [...value]
    if (typeof value == 'string' || typeof value == 'number' || typeof value == 'symbol') return [value]
    throw new TypeError('store replay batch v2: invalid path')
}

export function encodeStoreReplayPatchV2(patch: StorePatch): tStoreReplayWirePatchV2 {
    if (patch.exists && patch.value === undefined) {
        const target = patch.path.length == 1 ? patch.path[0] : [...patch.path]
        return [target, 2, 0]
    }
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

export function storeReplayBatchV2JsonBytes(
    wire: tStoreReplayWireBatchV2 | ReplayEvent<[readonly StorePatch[]]>,
) {
    const tuple = Array.isArray(wire) ? wire : encodeStoreReplayBatchV2(wire)
    return utf8Encoder.encode(JSON.stringify(tuple)).byteLength
}

export function storeReplayPatchV2WireMetrics(patch: StorePatch, firstBinaryIndex = 0) {
    return rpcResultWireMetrics(encodeStoreReplayPatchV2(patch), firstBinaryIndex)
}

export function storeReplayPatchV2WireBytes(patch: StorePatch) {
    return storeReplayPatchV2WireMetrics(patch).byteLength
}

export function storeReplayBatchV2WireMetrics(patches: readonly StorePatch[]) {
    return rpcResultWireMetrics(encodeStoreReplayBatchV2({
        seq: Number.MAX_SAFE_INTEGER,
        ts: Number.MAX_SAFE_INTEGER,
        event: [patches],
    }))
}
