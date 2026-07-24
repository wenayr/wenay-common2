"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORE_REPLAY_BATCH_V4_VERSION = void 0;
exports.prepareStoreReplayBatchPlan = prepareStoreReplayBatchPlan;
exports.decodeStoreReplayBatchPlan = decodeStoreReplayBatchPlan;
exports.encodeStoreReplayBatchV4 = encodeStoreReplayBatchV4;
exports.decodeStoreReplayBatchV4 = decodeStoreReplayBatchV4;
exports.encodeStoreReplayBatchV5 = encodeStoreReplayBatchV5;
exports.decodeStoreReplayBatchV5 = decodeStoreReplayBatchV5;
const store_replay_binary_1 = require("./store-replay-binary");
exports.STORE_REPLAY_BATCH_V4_VERSION = 4;
const STORE_REPLAY_VALUE_TAG = '$_sr';
const RPC_WIRE_VALUE_TAG_NAMES = ['$_f', '$_d', '$_m', '$_s', '$_r', '$_b'];
const RPC_WIRE_VALUE_TAGS = new Set(RPC_WIRE_VALUE_TAG_NAMES);
const MAX_PLAN_ROWS = 10_000;
const MAX_ROOT_ENTRIES = 20_000;
const MAX_VALUE_DEPTH = 64;
const MAX_VALUE_KEYS = 1_000;
function owns(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function isReservedWireKey(key) {
    return key == '__proto__' || key == 'constructor' || key == 'prototype';
}
function isOpaqueBinaryValue(value) {
    return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}
function defineValue(target, key, value) {
    if (Object.getPrototypeOf(target) == null) {
        target[key] = value;
        return;
    }
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, key);
    if (!inherited || owns(inherited, 'value') && inherited.writable == true) {
        target[key] = value;
        return;
    }
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    });
}
function assertNoEnumerableSymbols(value) {
    for (const symbol of Object.getOwnPropertySymbols(value)) {
        if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
            throw new TypeError('store replay batch v4: enumerable symbol properties are not supported');
        }
    }
}
function exactNumberTag(value) {
    if (Number.isNaN(value))
        return { [STORE_REPLAY_VALUE_TAG]: 2 };
    if (value == Infinity)
        return { [STORE_REPLAY_VALUE_TAG]: 3 };
    if (value == -Infinity)
        return { [STORE_REPLAY_VALUE_TAG]: 4 };
    if (Object.is(value, -0))
        return { [STORE_REPLAY_VALUE_TAG]: 5 };
    return value;
}
function needsObjectEscape(value, keys) {
    const record = value;
    return owns(value, STORE_REPLAY_VALUE_TAG)
        || keys.some(isReservedWireKey)
        || (keys.length == 1 && RPC_WIRE_VALUE_TAGS.has(keys[0]))
        || Object.is(record['_placeholder'], true);
}
function arrayIndex(key, length) {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < length && String(index) == key;
}
function encodeStoreReplayJsonValue(value, active = new WeakSet(), depth = 0) {
    if (depth > MAX_VALUE_DEPTH)
        throw new TypeError('store replay batch v4: value nesting is too deep');
    if (value === undefined)
        return { [STORE_REPLAY_VALUE_TAG]: 0 };
    if (typeof value == 'number')
        return exactNumberTag(value);
    if (typeof value == 'function' || typeof value == 'symbol') {
        throw new TypeError(`store replay batch v4: ${typeof value} values are not supported`);
    }
    if (value == null || typeof value != 'object')
        return value;
    if (active.has(value))
        throw new TypeError('store replay batch v4: cyclic values are not supported');
    if (isOpaqueBinaryValue(value) || value instanceof RegExp)
        return value;
    if (value instanceof Date) {
        return {
            [STORE_REPLAY_VALUE_TAG]: 7,
            value: exactNumberTag(value.valueOf()),
        };
    }
    active.add(value);
    try {
        assertNoEnumerableSymbols(value);
        if (Array.isArray(value)) {
            if (value.length > MAX_PLAN_ROWS)
                throw new TypeError('store replay batch v4: array is too long');
            const keys = Object.keys(value);
            for (const key of keys) {
                if (!arrayIndex(key, value.length)) {
                    throw new TypeError('store replay batch v4: custom array properties are not supported');
                }
            }
            const sparse = keys.length != value.length;
            if (sparse) {
                const entries = [];
                for (const key of keys) {
                    const descriptor = Object.getOwnPropertyDescriptor(value, key);
                    if (!descriptor || !('value' in descriptor)) {
                        throw new TypeError('store replay batch v4: array accessors are not supported');
                    }
                    entries.push([
                        Number(key),
                        encodeStoreReplayJsonValue(descriptor.value, active, depth + 1),
                    ]);
                }
                return {
                    [STORE_REPLAY_VALUE_TAG]: 6,
                    length: value.length,
                    entries,
                };
            }
            const encoded = new Array(value.length);
            for (let index = 0; index < value.length; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor || !('value' in descriptor)) {
                    throw new TypeError('store replay batch v4: array accessors are not supported');
                }
                encoded[index] = encodeStoreReplayJsonValue(descriptor.value, active, depth + 1);
            }
            return encoded;
        }
        if (value instanceof Map) {
            if (value.size > MAX_PLAN_ROWS)
                throw new TypeError('store replay batch v4: Map is too large');
            const encoded = new Map();
            for (const [key, item] of value) {
                encoded.set(encodeStoreReplayJsonValue(key, active, depth + 1), encodeStoreReplayJsonValue(item, active, depth + 1));
            }
            return encoded;
        }
        if (value instanceof Set) {
            if (value.size > MAX_PLAN_ROWS)
                throw new TypeError('store replay batch v4: Set is too large');
            const encoded = new Set();
            for (const item of value) {
                encoded.add(encodeStoreReplayJsonValue(item, active, depth + 1));
            }
            return encoded;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype != Object.prototype && prototype != null) {
            throw new TypeError('store replay batch v4: class instances are not supported');
        }
        const keys = Object.keys(value);
        if (keys.length > MAX_VALUE_KEYS)
            throw new TypeError('store replay batch v4: too many object keys');
        const entries = [];
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !('value' in descriptor)) {
                throw new TypeError('store replay batch v4: object accessors are not supported');
            }
            entries.push([
                key,
                encodeStoreReplayJsonValue(descriptor.value, active, depth + 1),
            ]);
        }
        if (prototype == null || needsObjectEscape(value, keys)) {
            return {
                [STORE_REPLAY_VALUE_TAG]: prototype == null ? 8 : 1,
                entries,
            };
        }
        const encoded = {};
        for (const [key, item] of entries)
            defineValue(encoded, key, item);
        return encoded;
    }
    finally {
        active.delete(value);
    }
}
function exactTag(record, keys, tag) {
    return keys.length == 1 && keys[0] == STORE_REPLAY_VALUE_TAG && record[STORE_REPLAY_VALUE_TAG] === tag;
}
function decodeStoreReplayJsonValue(value, active = new WeakSet(), depth = 0) {
    if (depth > MAX_VALUE_DEPTH)
        throw new TypeError('store replay batch v4: value nesting is too deep');
    if (typeof value == 'function' || typeof value == 'symbol') {
        throw new TypeError(`store replay batch v4: ${typeof value} wire values are not supported`);
    }
    if (value == null || typeof value != 'object' || isOpaqueBinaryValue(value) || value instanceof RegExp) {
        return value;
    }
    if (value instanceof Date)
        return value;
    if (active.has(value))
        throw new TypeError('store replay batch v4: cyclic wire value');
    active.add(value);
    try {
        if (Array.isArray(value)) {
            if (value.length > MAX_PLAN_ROWS)
                throw new TypeError('store replay batch v4: array is too long');
            const decoded = new Array(value.length);
            for (let index = 0; index < value.length; index++) {
                if (!(index in value))
                    throw new TypeError('store replay batch v4: untagged sparse array');
                decoded[index] = decodeStoreReplayJsonValue(value[index], active, depth + 1);
            }
            return decoded;
        }
        if (value instanceof Map) {
            if (value.size > MAX_PLAN_ROWS)
                throw new TypeError('store replay batch v4: Map is too large');
            const decoded = new Map();
            for (const [key, item] of value) {
                decoded.set(decodeStoreReplayJsonValue(key, active, depth + 1), decodeStoreReplayJsonValue(item, active, depth + 1));
            }
            return decoded;
        }
        if (value instanceof Set) {
            if (value.size > MAX_PLAN_ROWS)
                throw new TypeError('store replay batch v4: Set is too large');
            const decoded = new Set();
            for (const item of value) {
                decoded.add(decodeStoreReplayJsonValue(item, active, depth + 1));
            }
            return decoded;
        }
        const record = value;
        const keys = Object.keys(record);
        if (keys.length > MAX_VALUE_KEYS)
            throw new TypeError('store replay batch v4: too many object keys');
        if (exactTag(record, keys, 0))
            return undefined;
        if (exactTag(record, keys, 2))
            return NaN;
        if (exactTag(record, keys, 3))
            return Infinity;
        if (exactTag(record, keys, 4))
            return -Infinity;
        if (exactTag(record, keys, 5))
            return -0;
        if (keys.length == 2 && owns(record, STORE_REPLAY_VALUE_TAG) && owns(record, 'entries')
            && (record[STORE_REPLAY_VALUE_TAG] === 1 || record[STORE_REPLAY_VALUE_TAG] === 8)) {
            if (!Array.isArray(record['entries'])) {
                throw new TypeError('store replay batch v4: invalid escaped object');
            }
            const decoded = record[STORE_REPLAY_VALUE_TAG] === 8
                ? Object.create(null)
                : {};
            const seen = new Set();
            for (const entry of record['entries']) {
                if (!Array.isArray(entry) || entry.length != 2 || typeof entry[0] != 'string'
                    || seen.has(entry[0])) {
                    throw new TypeError('store replay batch v4: invalid escaped object entry');
                }
                seen.add(entry[0]);
                defineValue(decoded, entry[0], decodeStoreReplayJsonValue(entry[1], active, depth + 1));
            }
            return decoded;
        }
        if (keys.length == 3 && owns(record, STORE_REPLAY_VALUE_TAG)
            && owns(record, 'length') && owns(record, 'entries')
            && record[STORE_REPLAY_VALUE_TAG] === 6) {
            const length = record['length'];
            const entries = record['entries'];
            if (!Number.isSafeInteger(length) || length < 0
                || length > MAX_PLAN_ROWS || !Array.isArray(entries)) {
                throw new TypeError('store replay batch v4: invalid sparse array');
            }
            const arrayLength = length;
            const decoded = new Array(arrayLength);
            const seen = new Set();
            for (const entry of entries) {
                if (!Array.isArray(entry) || entry.length != 2 || !Number.isSafeInteger(entry[0])
                    || entry[0] < 0 || entry[0] >= arrayLength || seen.has(entry[0])) {
                    throw new TypeError('store replay batch v4: invalid sparse array entry');
                }
                seen.add(entry[0]);
                decoded[entry[0]] = decodeStoreReplayJsonValue(entry[1], active, depth + 1);
            }
            return decoded;
        }
        if (keys.length == 2 && owns(record, STORE_REPLAY_VALUE_TAG) && owns(record, 'value')
            && record[STORE_REPLAY_VALUE_TAG] === 7) {
            const timestamp = decodeStoreReplayJsonValue(record['value'], active, depth + 1);
            if (typeof timestamp != 'number')
                throw new TypeError('store replay batch v4: invalid Date');
            return new Date(timestamp);
        }
        if (owns(record, STORE_REPLAY_VALUE_TAG)) {
            throw new TypeError('store replay batch v4: unknown value tag');
        }
        const decoded = {};
        for (const key of keys) {
            defineValue(decoded, key, decodeStoreReplayJsonValue(record[key], active, depth + 1));
        }
        return decoded;
    }
    finally {
        active.delete(value);
    }
}
function planKey(value) {
    if (typeof value == 'string')
        return value;
    if (typeof value == 'number' && Number.isFinite(value))
        return value;
    throw new TypeError('store replay batch v4: only finite number and string paths are supported');
}
function planTarget(path) {
    if (path.length == 1)
        return planKey(path[0]);
    return path.map(planKey);
}
function sameFields(left, right) {
    if (left.length != right.length)
        return false;
    for (let index = 0; index < left.length; index++) {
        if (left[index] != right[index])
            return false;
    }
    return true;
}
function captureDataObject(value, maxFields = MAX_VALUE_KEYS, allowNullPrototype = false) {
    if (value == null || typeof value != 'object' || Array.isArray(value))
        return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype != Object.prototype && (!allowNullPrototype || prototype != null))
        return null;
    assertNoEnumerableSymbols(value);
    const fields = Object.keys(value);
    if (fields.length > maxFields)
        throw new TypeError('store replay batch v4: too many shape fields');
    const values = [];
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (!descriptor || !('value' in descriptor))
            return null;
        values.push(descriptor.value);
    }
    return { fields, values, nullPrototype: prototype == null };
}
function captureShapeCandidate(patch) {
    if (!patch.exists || patch.path.length == 0)
        return null;
    const captured = captureDataObject(patch.value);
    if (!captured || captured.fields.length == 0)
        return null;
    return {
        target: planTarget(patch.path),
        fields: captured.fields,
        values: captured.values,
    };
}
function derivedField(candidates) {
    const first = candidates[0];
    if (Array.isArray(first.target))
        return -1;
    for (let field = 0; field < first.fields.length; field++) {
        let matches = true;
        for (const candidate of candidates) {
            if (Array.isArray(candidate.target) || !Object.is(candidate.values[field], candidate.target)) {
                matches = false;
                break;
            }
        }
        if (matches)
            return field;
    }
    return -1;
}
function structuralShapeIsSmaller(candidates, derived) {
    const fields = candidates[0].fields;
    const rawValues = candidates.map(function rawShapeValue(candidate) {
        const value = {};
        for (let index = 0; index < fields.length; index++) {
            defineValue(value, fields[index], index == derived ? candidate.target : 0);
        }
        return [candidate.target, value];
    });
    const columns = [];
    for (let field = 0; field < fields.length; field++) {
        if (field != derived)
            columns.push(candidates.map(() => 0));
    }
    const shaped = [2, fields, derived, candidates.map(candidate => candidate.target), columns];
    return JSON.stringify(shaped).length < JSON.stringify([0, rawValues]).length;
}
function shapeRun(candidates) {
    const derived = derivedField(candidates);
    if (!structuralShapeIsSmaller(candidates, derived))
        return null;
    const columns = [];
    for (let field = 0; field < candidates[0].fields.length; field++) {
        if (field == derived)
            continue;
        columns.push(candidates.map(candidate => candidate.values[field]));
    }
    return [
        2,
        [...candidates[0].fields],
        derived,
        candidates.map(candidate => candidate.target),
        columns,
    ];
}
function appendRawRun(runs, patch) {
    const target = planTarget(patch.path);
    const raw = patch.exists ? [target, patch.value] : [target];
    const previous = runs[runs.length - 1];
    if (previous?.[0] == 0 && previous[1].length < MAX_PLAN_ROWS)
        previous[1].push(raw);
    else
        runs.push([0, [raw]]);
}
function rawOnlyRuns(patches) {
    const runs = [];
    for (const patch of patches)
        appendRawRun(runs, patch);
    return runs;
}
function prepareStoreReplayBatchRuns(patches, allowRoot, budget, maxRows = MAX_PLAN_ROWS) {
    if (patches.length > maxRows)
        throw new TypeError('store replay batch v4: too many patches');
    function consumeRows(count) {
        if (count > budget.remaining) {
            throw new TypeError('store replay batch v4: encoded plan-row limit exceeded');
        }
        budget.remaining -= count;
    }
    const candidates = patches.map(captureShapeCandidate);
    const runs = [];
    let index = 0;
    while (index < patches.length) {
        const patch = patches[index];
        if (allowRoot && patch.exists && patch.path.length == 0) {
            const root = captureDataObject(patch.value, MAX_ROOT_ENTRIES, true);
            if (root) {
                consumeRows(1);
                const entries = root.fields.map(function rootEntry(field, fieldIndex) {
                    return { path: [field], exists: true, value: root.values[fieldIndex] };
                });
                const rootBudget = {
                    remaining: budget.rootRemaining,
                    rootRemaining: 0,
                };
                let rootRuns = prepareStoreReplayBatchRuns(entries, false, rootBudget, MAX_ROOT_ENTRIES);
                if (rootRuns.length > MAX_PLAN_ROWS)
                    rootRuns = rawOnlyRuns(entries);
                budget.rootRemaining = rootBudget.remaining;
                runs.push(root.nullPrototype ? [4, rootRuns] : [3, rootRuns]);
                index++;
                continue;
            }
        }
        if (!patch.exists) {
            const targets = [];
            while (index < patches.length && !patches[index].exists
                && targets.length < MAX_PLAN_ROWS) {
                targets.push(planTarget(patches[index].path));
                index++;
            }
            consumeRows(targets.length);
            runs.push([1, targets]);
            continue;
        }
        const candidate = candidates[index];
        if (candidate) {
            const group = [candidate];
            let next = index + 1;
            while (next < patches.length && candidates[next]
                && sameFields(candidate.fields, candidates[next].fields)
                && group.length < MAX_PLAN_ROWS) {
                group.push(candidates[next]);
                next++;
            }
            const shaped = shapeRun(group);
            if (shaped) {
                consumeRows(group.length);
                runs.push(shaped);
                index = next;
                continue;
            }
        }
        consumeRows(1);
        appendRawRun(runs, patch);
        index++;
    }
    return runs;
}
function prepareStoreReplayBatchPlan(patches) {
    return prepareStoreReplayBatchRuns(patches, true, {
        remaining: MAX_PLAN_ROWS,
        rootRemaining: MAX_ROOT_ENTRIES,
    });
}
function mapPlanValues(plan, mapValue) {
    return plan.map(function mapStoreReplayRun(run) {
        if (run[0] == 0) {
            return [0, run[1].map(function mapRawPatch(patch) {
                    return patch.length == 2 ? [patch[0], mapValue(patch[1])] : [patch[0]];
                })];
        }
        if (run[0] == 1)
            return [1, run[1].map(clonePlanTarget)];
        if (run[0] == 2) {
            return [
                2,
                [...run[1]],
                run[2],
                run[3].map(clonePlanTarget),
                run[4].map(function mapStoreReplayColumn(column) {
                    return column.map(function mapStoreReplayColumnValue(value) {
                        return mapValue(value);
                    });
                }),
            ];
        }
        if (run[0] == 3)
            return [3, mapPlanValues(run[1], mapValue)];
        return [4, mapPlanValues(run[1], mapValue)];
    });
}
function clonePlanTarget(target) {
    return Array.isArray(target) ? [...target] : target;
}
function decodedTarget(value) {
    if (typeof value == 'string' || (typeof value == 'number' && Number.isFinite(value)))
        return value;
    if (!Array.isArray(value))
        throw new TypeError('store replay batch v4: invalid patch target');
    return value.map(function decodePathKey(key) {
        if (typeof key == 'string' || (typeof key == 'number' && Number.isFinite(key)))
            return key;
        throw new TypeError('store replay batch v4: invalid path key');
    });
}
function targetPath(target) {
    return Array.isArray(target) ? [...target] : [target];
}
function decodePlanRuns(value, decodeValue, allowRoot, budget) {
    if (!Array.isArray(value) || value.length > MAX_PLAN_ROWS) {
        throw new TypeError('store replay batch v4: invalid plan');
    }
    const patches = [];
    function consumePatch() {
        if (budget.remaining <= 0) {
            throw new TypeError('store replay batch v4: decoded plan-row limit exceeded');
        }
        budget.remaining--;
    }
    for (const unknownRun of value) {
        if (!Array.isArray(unknownRun) || unknownRun.length != 2 && unknownRun.length != 5) {
            throw new TypeError('store replay batch v4: invalid run');
        }
        if (unknownRun[0] === 0) {
            if (unknownRun.length != 2 || !Array.isArray(unknownRun[1])
                || unknownRun[1].length > MAX_PLAN_ROWS) {
                throw new TypeError('store replay batch v4: invalid raw run');
            }
            for (const unknownPatch of unknownRun[1]) {
                if (!Array.isArray(unknownPatch)
                    || unknownPatch.length != 1 && unknownPatch.length != 2) {
                    throw new TypeError('store replay batch v4: invalid raw patch');
                }
                const target = decodedTarget(unknownPatch[0]);
                consumePatch();
                patches.push(unknownPatch.length == 2
                    ? { path: targetPath(target), exists: true, value: decodeValue(unknownPatch[1]) }
                    : { path: targetPath(target), exists: false, value: undefined });
            }
            continue;
        }
        if (unknownRun[0] === 1) {
            if (unknownRun.length != 2 || !Array.isArray(unknownRun[1])
                || unknownRun[1].length > MAX_PLAN_ROWS) {
                throw new TypeError('store replay batch v4: invalid delete run');
            }
            for (const unknownTarget of unknownRun[1]) {
                const target = decodedTarget(unknownTarget);
                consumePatch();
                patches.push({ path: targetPath(target), exists: false, value: undefined });
            }
            continue;
        }
        if (unknownRun[0] === 2) {
            if (unknownRun.length != 5 || !Array.isArray(unknownRun[1])
                || !Array.isArray(unknownRun[3]) || !Array.isArray(unknownRun[4])
                || unknownRun[3].length > MAX_PLAN_ROWS) {
                throw new TypeError('store replay batch v4: invalid shape run');
            }
            const fields = unknownRun[1];
            if (fields.length > MAX_VALUE_KEYS || fields.some(field => typeof field != 'string')
                || new Set(fields).size != fields.length) {
                throw new TypeError('store replay batch v4: invalid shape fields');
            }
            const derived = unknownRun[2];
            if (!Number.isInteger(derived) || derived < -1 || derived >= fields.length) {
                throw new TypeError('store replay batch v4: invalid derived field');
            }
            const targets = unknownRun[3].map(decodedTarget);
            const columns = unknownRun[4];
            const expectedColumns = fields.length - (derived >= 0 ? 1 : 0);
            if (columns.length != expectedColumns
                || columns.some(column => !Array.isArray(column) || column.length != targets.length)) {
                throw new TypeError('store replay batch v4: invalid shape columns');
            }
            for (let row = 0; row < targets.length; row++) {
                consumePatch();
                const record = {};
                let column = 0;
                for (let field = 0; field < fields.length; field++) {
                    const item = field == derived
                        ? Array.isArray(targets[row])
                            ? undefined
                            : targets[row]
                        : decodeValue(columns[column++][row]);
                    if (field == derived && Array.isArray(targets[row])) {
                        throw new TypeError('store replay batch v4: path cannot supply a derived field');
                    }
                    defineValue(record, fields[field], item);
                }
                patches.push({ path: targetPath(targets[row]), exists: true, value: record });
            }
            continue;
        }
        if (unknownRun[0] === 3 || unknownRun[0] === 4) {
            if (!allowRoot || unknownRun.length != 2) {
                throw new TypeError('store replay batch v4: invalid root run');
            }
            consumePatch();
            const rootBudget = {
                remaining: budget.rootRemaining,
                rootRemaining: 0,
            };
            const entries = decodePlanRuns(unknownRun[1], decodeValue, false, rootBudget);
            budget.rootRemaining = rootBudget.remaining;
            const root = unknownRun[0] === 4 ? Object.create(null) : {};
            const rootKeys = new Set();
            for (const entry of entries) {
                if (!entry.exists || entry.path.length != 1 || typeof entry.path[0] != 'string') {
                    throw new TypeError('store replay batch v4: invalid root entry');
                }
                if (rootKeys.has(entry.path[0])) {
                    throw new TypeError('store replay batch v4: duplicate root entry');
                }
                rootKeys.add(entry.path[0]);
                defineValue(root, entry.path[0], entry.value);
            }
            patches.push({ path: [], exists: true, value: root });
            continue;
        }
        throw new TypeError('store replay batch v4: unknown run operation');
    }
    return patches;
}
function decodeStoreReplayBatchPlan(plan, decodeValue = value => value) {
    return decodePlanRuns(plan, decodeValue, true, {
        remaining: MAX_PLAN_ROWS,
        rootRemaining: MAX_ROOT_ENTRIES,
    });
}
function encodeStoreReplayBatchV4(event) {
    const plan = prepareStoreReplayBatchPlan(event.event[0]);
    return [
        exports.STORE_REPLAY_BATCH_V4_VERSION,
        event.seq,
        event.ts,
        mapPlanValues(plan, encodeStoreReplayJsonValue),
    ];
}
function decodeStoreReplayBatchV4(wire) {
    if (!Array.isArray(wire) || wire.length != 4 || wire[0] !== exports.STORE_REPLAY_BATCH_V4_VERSION
        || typeof wire[1] != 'number' || !Number.isFinite(wire[1])
        || typeof wire[2] != 'number' || !Number.isFinite(wire[2])) {
        throw new TypeError('store replay batch v4: unsupported envelope');
    }
    return {
        seq: wire[1],
        ts: wire[2],
        event: [decodeStoreReplayBatchPlan(wire[3], decodeStoreReplayJsonValue)],
    };
}
function encodeStoreReplayBatchV5(event) {
    return (0, store_replay_binary_1.encodeStoreReplayBinary)([
        event.seq,
        event.ts,
        prepareStoreReplayBatchPlan(event.event[0]),
    ]);
}
function decodeStoreReplayBatchV5(wire, limits) {
    const decoded = (0, store_replay_binary_1.decodeStoreReplayBinary)(wire, limits);
    if (!Array.isArray(decoded) || decoded.length != 3
        || typeof decoded[0] != 'number' || !Number.isFinite(decoded[0])
        || typeof decoded[1] != 'number' || !Number.isFinite(decoded[1])) {
        throw new TypeError('store replay batch v5: unsupported envelope');
    }
    return {
        seq: decoded[0],
        ts: decoded[1],
        event: [decodeStoreReplayBatchPlan(decoded[2])],
    };
}
