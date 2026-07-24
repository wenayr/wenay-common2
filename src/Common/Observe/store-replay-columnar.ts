// =====================================================================
// Store Replay v4 — envelope-local column plan and exact JSON values
// =====================================================================

import type {ReplayEvent} from '../events/replay-listen'
import type {RpcLimits} from '../rcp/rpc-limits'
import type {StorePatch} from './store'
import {decodeStoreReplayBinary, encodeStoreReplayBinary} from './store-replay-binary'

export const STORE_REPLAY_BATCH_V4_VERSION = 4 as const
export type tStoreReplayWireBatchV5 = Uint8Array

const STORE_REPLAY_VALUE_TAG = '$_sr'
const RPC_WIRE_VALUE_TAG_NAMES = ['$_f', '$_d', '$_m', '$_s', '$_r', '$_b'] as const
const RPC_WIRE_VALUE_TAGS = new Set<string>(RPC_WIRE_VALUE_TAG_NAMES)
const MAX_PLAN_ROWS = 10_000
const MAX_ROOT_ENTRIES = 20_000
const MAX_VALUE_DEPTH = 64
const MAX_VALUE_KEYS = 1_000

type tStoreReplayPlanKey = string | number
type tStoreReplayPlanTarget = tStoreReplayPlanKey | tStoreReplayPlanKey[]
type tStoreReplayPlanRawPatch =
    | [target: tStoreReplayPlanTarget]
    | [target: tStoreReplayPlanTarget, value: unknown]

export type tStoreReplayBatchPlanRun =
    | [op: 0, patches: tStoreReplayPlanRawPatch[]]
    | [op: 1, targets: tStoreReplayPlanTarget[]]
    | [
        op: 2,
        fields: string[],
        derivedField: number,
        targets: tStoreReplayPlanTarget[],
        columns: unknown[][],
    ]
    | [op: 3, entries: tStoreReplayBatchPlanRun[]]
    | [op: 4, entries: tStoreReplayBatchPlanRun[]]

export type tStoreReplayBatchPlan = tStoreReplayBatchPlanRun[]

export type tStoreReplayWireBatchV4 = [
    version: typeof STORE_REPLAY_BATCH_V4_VERSION,
    seq: number,
    ts: number,
    plan: tStoreReplayBatchPlan,
]

type tShapeCandidate = {
    target: tStoreReplayPlanTarget
    fields: string[]
    values: unknown[]
}

type tPlanBudget = {
    remaining: number
    rootRemaining: number
}

// ============================================================
// exact JSON value codec
// ============================================================

function owns(value: object, key: PropertyKey) {
    return Object.prototype.hasOwnProperty.call(value, key)
}

function isReservedWireKey(key: string) {
    return key == '__proto__' || key == 'constructor' || key == 'prototype'
}

function isOpaqueBinaryValue(value: object) {
    return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

function defineValue(target: Record<string, unknown>, key: string, value: unknown) {
    if (Object.getPrototypeOf(target) == null) {
        target[key] = value
        return
    }
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, key)
    if (!inherited || owns(inherited, 'value') && inherited.writable == true) {
        target[key] = value
        return
    }
    // Preserve an own data property for __proto__ and for runtime-polluted
    // Object.prototype accessors/non-writable fields.
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    })
}

function assertNoEnumerableSymbols(value: object) {
    for (const symbol of Object.getOwnPropertySymbols(value)) {
        if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
            throw new TypeError('store replay batch v4: enumerable symbol properties are not supported')
        }
    }
}

function exactNumberTag(value: number) {
    if (Number.isNaN(value)) return {[STORE_REPLAY_VALUE_TAG]: 2}
    if (value == Infinity) return {[STORE_REPLAY_VALUE_TAG]: 3}
    if (value == -Infinity) return {[STORE_REPLAY_VALUE_TAG]: 4}
    if (Object.is(value, -0)) return {[STORE_REPLAY_VALUE_TAG]: 5}
    return value
}

function needsObjectEscape(value: object, keys: readonly string[]) {
    const record = value as Record<string, unknown>
    return owns(value, STORE_REPLAY_VALUE_TAG)
        || keys.some(isReservedWireKey)
        || (keys.length == 1 && RPC_WIRE_VALUE_TAGS.has(keys[0]))
        || Object.is(record['_placeholder'], true)
}

function arrayIndex(key: string, length: number) {
    const index = Number(key)
    return Number.isInteger(index) && index >= 0 && index < length && String(index) == key
}

function encodeStoreReplayJsonValue(
    value: unknown,
    active = new WeakSet<object>(),
    depth = 0,
): unknown {
    if (depth > MAX_VALUE_DEPTH) throw new TypeError('store replay batch v4: value nesting is too deep')
    if (value === undefined) return {[STORE_REPLAY_VALUE_TAG]: 0}
    if (typeof value == 'number') return exactNumberTag(value)
    if (typeof value == 'function' || typeof value == 'symbol') {
        throw new TypeError(`store replay batch v4: ${typeof value} values are not supported`)
    }
    if (value == null || typeof value != 'object') return value
    if (active.has(value)) throw new TypeError('store replay batch v4: cyclic values are not supported')
    if (isOpaqueBinaryValue(value) || value instanceof RegExp) return value
    if (value instanceof Date) {
        return {
            [STORE_REPLAY_VALUE_TAG]: 7,
            value: exactNumberTag(value.valueOf()),
        }
    }

    active.add(value)
    try {
        assertNoEnumerableSymbols(value)
        if (Array.isArray(value)) {
            if (value.length > MAX_PLAN_ROWS) throw new TypeError('store replay batch v4: array is too long')
            const keys = Object.keys(value)
            for (const key of keys) {
                if (!arrayIndex(key, value.length)) {
                    throw new TypeError('store replay batch v4: custom array properties are not supported')
                }
            }
            const sparse = keys.length != value.length
            if (sparse) {
                const entries: [number, unknown][] = []
                for (const key of keys) {
                    const descriptor = Object.getOwnPropertyDescriptor(value, key)
                    if (!descriptor || !('value' in descriptor)) {
                        throw new TypeError('store replay batch v4: array accessors are not supported')
                    }
                    entries.push([
                        Number(key),
                        encodeStoreReplayJsonValue(descriptor.value, active, depth + 1),
                    ])
                }
                return {
                    [STORE_REPLAY_VALUE_TAG]: 6,
                    length: value.length,
                    entries,
                }
            }
            const encoded = new Array<unknown>(value.length)
            for (let index = 0; index < value.length; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
                if (!descriptor || !('value' in descriptor)) {
                    throw new TypeError('store replay batch v4: array accessors are not supported')
                }
                encoded[index] = encodeStoreReplayJsonValue(descriptor.value, active, depth + 1)
            }
            return encoded
        }
        if (value instanceof Map) {
            if (value.size > MAX_PLAN_ROWS) throw new TypeError('store replay batch v4: Map is too large')
            const encoded = new Map<unknown, unknown>()
            for (const [key, item] of value) {
                encoded.set(
                    encodeStoreReplayJsonValue(key, active, depth + 1),
                    encodeStoreReplayJsonValue(item, active, depth + 1),
                )
            }
            return encoded
        }
        if (value instanceof Set) {
            if (value.size > MAX_PLAN_ROWS) throw new TypeError('store replay batch v4: Set is too large')
            const encoded = new Set<unknown>()
            for (const item of value) {
                encoded.add(encodeStoreReplayJsonValue(item, active, depth + 1))
            }
            return encoded
        }

        const prototype = Object.getPrototypeOf(value)
        if (prototype != Object.prototype && prototype != null) {
            throw new TypeError('store replay batch v4: class instances are not supported')
        }
        const keys = Object.keys(value)
        if (keys.length > MAX_VALUE_KEYS) throw new TypeError('store replay batch v4: too many object keys')
        const entries: [string, unknown][] = []
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (!descriptor || !('value' in descriptor)) {
                throw new TypeError('store replay batch v4: object accessors are not supported')
            }
            entries.push([
                key,
                encodeStoreReplayJsonValue(descriptor.value, active, depth + 1),
            ])
        }
        if (prototype == null || needsObjectEscape(value, keys)) {
            return {
                [STORE_REPLAY_VALUE_TAG]: prototype == null ? 8 : 1,
                entries,
            }
        }
        const encoded: Record<string, unknown> = {}
        for (const [key, item] of entries) defineValue(encoded, key, item)
        return encoded
    } finally {
        active.delete(value)
    }
}

function exactTag(record: Record<string, unknown>, keys: readonly string[], tag: number) {
    return keys.length == 1 && keys[0] == STORE_REPLAY_VALUE_TAG && record[STORE_REPLAY_VALUE_TAG] === tag
}

function decodeStoreReplayJsonValue(
    value: unknown,
    active = new WeakSet<object>(),
    depth = 0,
): unknown {
    if (depth > MAX_VALUE_DEPTH) throw new TypeError('store replay batch v4: value nesting is too deep')
    if (typeof value == 'function' || typeof value == 'symbol') {
        throw new TypeError(`store replay batch v4: ${typeof value} wire values are not supported`)
    }
    if (value == null || typeof value != 'object' || isOpaqueBinaryValue(value) || value instanceof RegExp) {
        return value
    }
    if (value instanceof Date) return value
    if (active.has(value)) throw new TypeError('store replay batch v4: cyclic wire value')
    active.add(value)
    try {
        if (Array.isArray(value)) {
            if (value.length > MAX_PLAN_ROWS) throw new TypeError('store replay batch v4: array is too long')
            const decoded = new Array<unknown>(value.length)
            for (let index = 0; index < value.length; index++) {
                if (!(index in value)) throw new TypeError('store replay batch v4: untagged sparse array')
                decoded[index] = decodeStoreReplayJsonValue(value[index], active, depth + 1)
            }
            return decoded
        }
        if (value instanceof Map) {
            if (value.size > MAX_PLAN_ROWS) throw new TypeError('store replay batch v4: Map is too large')
            const decoded = new Map<unknown, unknown>()
            for (const [key, item] of value) {
                decoded.set(
                    decodeStoreReplayJsonValue(key, active, depth + 1),
                    decodeStoreReplayJsonValue(item, active, depth + 1),
                )
            }
            return decoded
        }
        if (value instanceof Set) {
            if (value.size > MAX_PLAN_ROWS) throw new TypeError('store replay batch v4: Set is too large')
            const decoded = new Set<unknown>()
            for (const item of value) {
                decoded.add(decodeStoreReplayJsonValue(item, active, depth + 1))
            }
            return decoded
        }

        const record = value as Record<string, unknown>
        const keys = Object.keys(record)
        if (keys.length > MAX_VALUE_KEYS) throw new TypeError('store replay batch v4: too many object keys')
        if (exactTag(record, keys, 0)) return undefined
        if (exactTag(record, keys, 2)) return NaN
        if (exactTag(record, keys, 3)) return Infinity
        if (exactTag(record, keys, 4)) return -Infinity
        if (exactTag(record, keys, 5)) return -0
        if (keys.length == 2 && owns(record, STORE_REPLAY_VALUE_TAG) && owns(record, 'entries')
            && (record[STORE_REPLAY_VALUE_TAG] === 1 || record[STORE_REPLAY_VALUE_TAG] === 8)) {
            if (!Array.isArray(record['entries'])) {
                throw new TypeError('store replay batch v4: invalid escaped object')
            }
            const decoded: Record<string, unknown> = record[STORE_REPLAY_VALUE_TAG] === 8
                ? Object.create(null)
                : {}
            const seen = new Set<string>()
            for (const entry of record['entries']) {
                if (!Array.isArray(entry) || entry.length != 2 || typeof entry[0] != 'string'
                    || seen.has(entry[0])) {
                    throw new TypeError('store replay batch v4: invalid escaped object entry')
                }
                seen.add(entry[0])
                defineValue(decoded, entry[0], decodeStoreReplayJsonValue(entry[1], active, depth + 1))
            }
            return decoded
        }
        if (keys.length == 3 && owns(record, STORE_REPLAY_VALUE_TAG)
            && owns(record, 'length') && owns(record, 'entries')
            && record[STORE_REPLAY_VALUE_TAG] === 6) {
            const length = record['length']
            const entries = record['entries']
            if (!Number.isSafeInteger(length) || (length as number) < 0
                || (length as number) > MAX_PLAN_ROWS || !Array.isArray(entries)) {
                throw new TypeError('store replay batch v4: invalid sparse array')
            }
            const arrayLength = length as number
            const decoded = new Array<unknown>(arrayLength)
            const seen = new Set<number>()
            for (const entry of entries) {
                if (!Array.isArray(entry) || entry.length != 2 || !Number.isSafeInteger(entry[0])
                    || entry[0] < 0 || entry[0] >= arrayLength || seen.has(entry[0])) {
                    throw new TypeError('store replay batch v4: invalid sparse array entry')
                }
                seen.add(entry[0])
                decoded[entry[0]] = decodeStoreReplayJsonValue(entry[1], active, depth + 1)
            }
            return decoded
        }
        if (keys.length == 2 && owns(record, STORE_REPLAY_VALUE_TAG) && owns(record, 'value')
            && record[STORE_REPLAY_VALUE_TAG] === 7) {
            const timestamp = decodeStoreReplayJsonValue(record['value'], active, depth + 1)
            if (typeof timestamp != 'number') throw new TypeError('store replay batch v4: invalid Date')
            return new Date(timestamp)
        }
        if (owns(record, STORE_REPLAY_VALUE_TAG)) {
            throw new TypeError('store replay batch v4: unknown value tag')
        }

        const decoded: Record<string, unknown> = {}
        for (const key of keys) {
            defineValue(decoded, key, decodeStoreReplayJsonValue(record[key], active, depth + 1))
        }
        return decoded
    } finally {
        active.delete(value)
    }
}

// ============================================================
// ordered column plan
// ============================================================

function planKey(value: PropertyKey): tStoreReplayPlanKey {
    if (typeof value == 'string') return value
    if (typeof value == 'number' && Number.isFinite(value)) return value
    throw new TypeError('store replay batch v4: only finite number and string paths are supported')
}

function planTarget(path: readonly PropertyKey[]): tStoreReplayPlanTarget {
    if (path.length == 1) return planKey(path[0])
    return path.map(planKey)
}

function sameFields(left: readonly string[], right: readonly string[]) {
    if (left.length != right.length) return false
    for (let index = 0; index < left.length; index++) {
        if (left[index] != right[index]) return false
    }
    return true
}

function captureDataObject(
    value: unknown,
    maxFields = MAX_VALUE_KEYS,
    allowNullPrototype = false,
) {
    if (value == null || typeof value != 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype != Object.prototype && (!allowNullPrototype || prototype != null)) return null
    assertNoEnumerableSymbols(value)
    const fields = Object.keys(value)
    if (fields.length > maxFields) throw new TypeError('store replay batch v4: too many shape fields')
    const values: unknown[] = []
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field)
        if (!descriptor || !('value' in descriptor)) return null
        values.push(descriptor.value)
    }
    return {fields, values, nullPrototype: prototype == null}
}

function captureShapeCandidate(patch: StorePatch): tShapeCandidate | null {
    if (!patch.exists || patch.path.length == 0) return null
    const captured = captureDataObject(patch.value)
    if (!captured || captured.fields.length == 0) return null
    return {
        target: planTarget(patch.path),
        fields: captured.fields,
        values: captured.values,
    }
}

function derivedField(candidates: readonly tShapeCandidate[]) {
    const first = candidates[0]
    if (Array.isArray(first.target)) return -1
    for (let field = 0; field < first.fields.length; field++) {
        let matches = true
        for (const candidate of candidates) {
            if (Array.isArray(candidate.target) || !Object.is(candidate.values[field], candidate.target)) {
                matches = false
                break
            }
        }
        if (matches) return field
    }
    return -1
}

function structuralShapeIsSmaller(candidates: readonly tShapeCandidate[], derived: number) {
    const fields = candidates[0].fields
    const rawValues = candidates.map(function rawShapeValue(candidate) {
        const value: Record<string, number | tStoreReplayPlanTarget> = {}
        for (let index = 0; index < fields.length; index++) {
            defineValue(value, fields[index], index == derived ? candidate.target : 0)
        }
        return [candidate.target, value]
    })
    const columns: number[][] = []
    for (let field = 0; field < fields.length; field++) {
        if (field != derived) columns.push(candidates.map(() => 0))
    }
    const shaped = [2, fields, derived, candidates.map(candidate => candidate.target), columns]
    return JSON.stringify(shaped).length < JSON.stringify([0, rawValues]).length
}

function shapeRun(candidates: readonly tShapeCandidate[]): tStoreReplayBatchPlanRun | null {
    const derived = derivedField(candidates)
    if (!structuralShapeIsSmaller(candidates, derived)) return null
    const columns: unknown[][] = []
    for (let field = 0; field < candidates[0].fields.length; field++) {
        if (field == derived) continue
        columns.push(candidates.map(candidate => candidate.values[field]))
    }
    return [
        2,
        [...candidates[0].fields],
        derived,
        candidates.map(candidate => candidate.target),
        columns,
    ]
}

function appendRawRun(runs: tStoreReplayBatchPlanRun[], patch: StorePatch) {
    const target = planTarget(patch.path)
    const raw: tStoreReplayPlanRawPatch = patch.exists ? [target, patch.value] : [target]
    const previous = runs[runs.length - 1]
    if (previous?.[0] == 0 && previous[1].length < MAX_PLAN_ROWS) previous[1].push(raw)
    else runs.push([0, [raw]])
}

function rawOnlyRuns(patches: readonly StorePatch[]) {
    const runs: tStoreReplayBatchPlanRun[] = []
    for (const patch of patches) appendRawRun(runs, patch)
    return runs
}

function prepareStoreReplayBatchRuns(
    patches: readonly StorePatch[],
    allowRoot: boolean,
    budget: tPlanBudget,
    maxRows = MAX_PLAN_ROWS,
): tStoreReplayBatchPlan {
    if (patches.length > maxRows) throw new TypeError('store replay batch v4: too many patches')
    function consumeRows(count: number) {
        if (count > budget.remaining) {
            throw new TypeError('store replay batch v4: encoded plan-row limit exceeded')
        }
        budget.remaining -= count
    }
    const candidates = patches.map(captureShapeCandidate)
    const runs: tStoreReplayBatchPlanRun[] = []
    let index = 0
    while (index < patches.length) {
        const patch = patches[index]
        if (allowRoot && patch.exists && patch.path.length == 0) {
            // A materialized keyed collection may be wider than one ordinary
            // value shape. Count the root as one ordinary patch, then encode its
            // entries under a separate envelope-wide budget.
            const root = captureDataObject(patch.value, MAX_ROOT_ENTRIES, true)
            if (root) {
                consumeRows(1)
                const entries = root.fields.map(function rootEntry(field, fieldIndex): StorePatch {
                    return {path: [field], exists: true, value: root.values[fieldIndex]}
                })
                const rootBudget: tPlanBudget = {
                    remaining: budget.rootRemaining,
                    rootRemaining: 0,
                }
                let rootRuns = prepareStoreReplayBatchRuns(entries, false, rootBudget, MAX_ROOT_ENTRIES)
                // Highly heterogeneous roots can produce more runs than the
                // binary value codec accepts in one array. Raw chunks retain
                // exact values while keeping every physical array bounded.
                if (rootRuns.length > MAX_PLAN_ROWS) rootRuns = rawOnlyRuns(entries)
                budget.rootRemaining = rootBudget.remaining
                runs.push(root.nullPrototype ? [4, rootRuns] : [3, rootRuns])
                index++
                continue
            }
        }
        if (!patch.exists) {
            const targets: tStoreReplayPlanTarget[] = []
            while (index < patches.length && !patches[index].exists
                && targets.length < MAX_PLAN_ROWS) {
                targets.push(planTarget(patches[index].path))
                index++
            }
            consumeRows(targets.length)
            runs.push([1, targets])
            continue
        }
        const candidate = candidates[index]
        if (candidate) {
            const group = [candidate]
            let next = index + 1
            while (next < patches.length && candidates[next]
                && sameFields(candidate.fields, candidates[next]!.fields)
                && group.length < MAX_PLAN_ROWS) {
                group.push(candidates[next]!)
                next++
            }
            const shaped = shapeRun(group)
            if (shaped) {
                consumeRows(group.length)
                runs.push(shaped)
                index = next
                continue
            }
        }
        consumeRows(1)
        appendRawRun(runs, patch)
        index++
    }
    return runs
}

export function prepareStoreReplayBatchPlan(patches: readonly StorePatch[]) {
    return prepareStoreReplayBatchRuns(patches, true, {
        remaining: MAX_PLAN_ROWS,
        rootRemaining: MAX_ROOT_ENTRIES,
    })
}

function mapPlanValues(
    plan: readonly tStoreReplayBatchPlanRun[],
    mapValue: (value: unknown) => unknown,
): tStoreReplayBatchPlan {
    return plan.map(function mapStoreReplayRun(run): tStoreReplayBatchPlanRun {
        if (run[0] == 0) {
            return [0, run[1].map(function mapRawPatch(patch): tStoreReplayPlanRawPatch {
                return patch.length == 2 ? [patch[0], mapValue(patch[1])] : [patch[0]]
            })]
        }
        if (run[0] == 1) return [1, run[1].map(clonePlanTarget)]
        if (run[0] == 2) {
            return [
                2,
                [...run[1]],
                run[2],
                run[3].map(clonePlanTarget),
                run[4].map(function mapStoreReplayColumn(column) {
                    return column.map(function mapStoreReplayColumnValue(value) {
                        return mapValue(value)
                    })
                }),
            ]
        }
        if (run[0] == 3) return [3, mapPlanValues(run[1], mapValue)]
        return [4, mapPlanValues(run[1], mapValue)]
    })
}

function clonePlanTarget(target: tStoreReplayPlanTarget): tStoreReplayPlanTarget {
    return Array.isArray(target) ? [...target] : target
}

function decodedTarget(value: unknown): tStoreReplayPlanTarget {
    if (typeof value == 'string' || (typeof value == 'number' && Number.isFinite(value))) return value
    if (!Array.isArray(value)) throw new TypeError('store replay batch v4: invalid patch target')
    return value.map(function decodePathKey(key) {
        if (typeof key == 'string' || (typeof key == 'number' && Number.isFinite(key))) return key
        throw new TypeError('store replay batch v4: invalid path key')
    })
}

function targetPath(target: tStoreReplayPlanTarget) {
    return Array.isArray(target) ? [...target] : [target]
}

function decodePlanRuns(
    value: unknown,
    decodeValue: (value: unknown) => unknown,
    allowRoot: boolean,
    budget: tPlanBudget,
): StorePatch[] {
    if (!Array.isArray(value) || value.length > MAX_PLAN_ROWS) {
        throw new TypeError('store replay batch v4: invalid plan')
    }
    const patches: StorePatch[] = []
    function consumePatch() {
        if (budget.remaining <= 0) {
            throw new TypeError('store replay batch v4: decoded plan-row limit exceeded')
        }
        budget.remaining--
    }
    for (const unknownRun of value) {
        if (!Array.isArray(unknownRun) || unknownRun.length != 2 && unknownRun.length != 5) {
            throw new TypeError('store replay batch v4: invalid run')
        }
        // Strict identity is required at the untrusted boundary: stringified
        // opcodes must not become alternate encodings of the same wire.
        if (unknownRun[0] === 0) {
            if (unknownRun.length != 2 || !Array.isArray(unknownRun[1])
                || unknownRun[1].length > MAX_PLAN_ROWS) {
                throw new TypeError('store replay batch v4: invalid raw run')
            }
            for (const unknownPatch of unknownRun[1]) {
                if (!Array.isArray(unknownPatch)
                    || unknownPatch.length != 1 && unknownPatch.length != 2) {
                    throw new TypeError('store replay batch v4: invalid raw patch')
                }
                const target = decodedTarget(unknownPatch[0])
                consumePatch()
                patches.push(unknownPatch.length == 2
                    ? {path: targetPath(target), exists: true, value: decodeValue(unknownPatch[1])}
                    : {path: targetPath(target), exists: false, value: undefined})
            }
            continue
        }
        if (unknownRun[0] === 1) {
            if (unknownRun.length != 2 || !Array.isArray(unknownRun[1])
                || unknownRun[1].length > MAX_PLAN_ROWS) {
                throw new TypeError('store replay batch v4: invalid delete run')
            }
            for (const unknownTarget of unknownRun[1]) {
                const target = decodedTarget(unknownTarget)
                consumePatch()
                patches.push({path: targetPath(target), exists: false, value: undefined})
            }
            continue
        }
        if (unknownRun[0] === 2) {
            if (unknownRun.length != 5 || !Array.isArray(unknownRun[1])
                || !Array.isArray(unknownRun[3]) || !Array.isArray(unknownRun[4])
                || unknownRun[3].length > MAX_PLAN_ROWS) {
                throw new TypeError('store replay batch v4: invalid shape run')
            }
            const fields = unknownRun[1]
            if (fields.length > MAX_VALUE_KEYS || fields.some(field => typeof field != 'string')
                || new Set(fields).size != fields.length) {
                throw new TypeError('store replay batch v4: invalid shape fields')
            }
            const derived = unknownRun[2]
            if (!Number.isInteger(derived) || derived < -1 || derived >= fields.length) {
                throw new TypeError('store replay batch v4: invalid derived field')
            }
            const targets = unknownRun[3].map(decodedTarget)
            const columns = unknownRun[4]
            const expectedColumns = fields.length - (derived >= 0 ? 1 : 0)
            if (columns.length != expectedColumns
                || columns.some(column => !Array.isArray(column) || column.length != targets.length)) {
                throw new TypeError('store replay batch v4: invalid shape columns')
            }
            for (let row = 0; row < targets.length; row++) {
                consumePatch()
                const record: Record<string, unknown> = {}
                let column = 0
                for (let field = 0; field < fields.length; field++) {
                    const item = field == derived
                        ? Array.isArray(targets[row])
                            ? undefined
                            : targets[row]
                        : decodeValue(columns[column++][row])
                    if (field == derived && Array.isArray(targets[row])) {
                        throw new TypeError('store replay batch v4: path cannot supply a derived field')
                    }
                    defineValue(record, fields[field], item)
                }
                patches.push({path: targetPath(targets[row]), exists: true, value: record})
            }
            continue
        }
        if (unknownRun[0] === 3 || unknownRun[0] === 4) {
            if (!allowRoot || unknownRun.length != 2) {
                throw new TypeError('store replay batch v4: invalid root run')
            }
            consumePatch()
            const rootBudget: tPlanBudget = {
                remaining: budget.rootRemaining,
                rootRemaining: 0,
            }
            const entries = decodePlanRuns(
                unknownRun[1],
                decodeValue,
                false,
                rootBudget,
            )
            budget.rootRemaining = rootBudget.remaining
            const root: Record<string, unknown> = unknownRun[0] === 4 ? Object.create(null) : {}
            const rootKeys = new Set<string>()
            for (const entry of entries) {
                if (!entry.exists || entry.path.length != 1 || typeof entry.path[0] != 'string') {
                    throw new TypeError('store replay batch v4: invalid root entry')
                }
                if (rootKeys.has(entry.path[0])) {
                    throw new TypeError('store replay batch v4: duplicate root entry')
                }
                rootKeys.add(entry.path[0])
                defineValue(root, entry.path[0], entry.value)
            }
            patches.push({path: [], exists: true, value: root})
            continue
        }
        throw new TypeError('store replay batch v4: unknown run operation')
    }
    return patches
}

export function decodeStoreReplayBatchPlan(
    plan: unknown,
    decodeValue: (value: unknown) => unknown = value => value,
) {
    return decodePlanRuns(plan, decodeValue, true, {
        remaining: MAX_PLAN_ROWS,
        rootRemaining: MAX_ROOT_ENTRIES,
    })
}

// ============================================================
// v4 envelope
// ============================================================

export function encodeStoreReplayBatchV4(
    event: ReplayEvent<[readonly StorePatch[]]>,
): tStoreReplayWireBatchV4 {
    const plan = prepareStoreReplayBatchPlan(event.event[0])
    return [
        STORE_REPLAY_BATCH_V4_VERSION,
        event.seq,
        event.ts,
        mapPlanValues(plan, encodeStoreReplayJsonValue),
    ]
}

export function decodeStoreReplayBatchV4(
    wire: tStoreReplayWireBatchV4 | unknown,
): ReplayEvent<[StorePatch[]]> {
    if (!Array.isArray(wire) || wire.length != 4 || wire[0] !== STORE_REPLAY_BATCH_V4_VERSION
        || typeof wire[1] != 'number' || !Number.isFinite(wire[1])
        || typeof wire[2] != 'number' || !Number.isFinite(wire[2])) {
        throw new TypeError('store replay batch v4: unsupported envelope')
    }
    return {
        seq: wire[1],
        ts: wire[2],
        event: [decodeStoreReplayBatchPlan(wire[3], decodeStoreReplayJsonValue)],
    }
}

// ============================================================
// v5 binary envelope
// ============================================================

export function encodeStoreReplayBatchV5(
    event: ReplayEvent<[readonly StorePatch[]]>,
): tStoreReplayWireBatchV5 {
    return encodeStoreReplayBinary([
        event.seq,
        event.ts,
        prepareStoreReplayBatchPlan(event.event[0]),
    ])
}

export function decodeStoreReplayBatchV5(
    wire: tStoreReplayWireBatchV5 | unknown,
    limits?: RpcLimits,
): ReplayEvent<[StorePatch[]]> {
    const decoded = decodeStoreReplayBinary(wire, limits)
    if (!Array.isArray(decoded) || decoded.length != 3
        || typeof decoded[0] != 'number' || !Number.isFinite(decoded[0])
        || typeof decoded[1] != 'number' || !Number.isFinite(decoded[1])) {
        throw new TypeError('store replay batch v5: unsupported envelope')
    }
    return {
        seq: decoded[0],
        ts: decoded[1],
        event: [decodeStoreReplayBatchPlan(decoded[2])],
    }
}
