"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORE_REPLAY_BATCH_V3_VERSION = exports.STORE_REPLAY_BATCH_V2_VERSION = exports.STORE_REPLAY_BATCH_VERSION = exports.decodeStoreReplayBatchV5 = exports.encodeStoreReplayBatchV5 = exports.decodeStoreReplayBatchV4 = exports.encodeStoreReplayBatchV4 = exports.decodeStoreReplayBatchPlan = exports.prepareStoreReplayBatchPlan = exports.STORE_REPLAY_BATCH_V4_VERSION = void 0;
exports.encodeStoreReplayPatch = encodeStoreReplayPatch;
exports.decodeStoreReplayPatch = decodeStoreReplayPatch;
exports.encodeStoreReplayPatchV2 = encodeStoreReplayPatchV2;
exports.decodeStoreReplayPatchV2 = decodeStoreReplayPatchV2;
exports.encodeStoreReplayPatchV3 = encodeStoreReplayPatchV3;
exports.decodeStoreReplayPatchV3 = decodeStoreReplayPatchV3;
exports.encodeStoreReplayBatch = encodeStoreReplayBatch;
exports.decodeStoreReplayBatch = decodeStoreReplayBatch;
exports.encodeStoreReplayBatchV2 = encodeStoreReplayBatchV2;
exports.decodeStoreReplayBatchV2 = decodeStoreReplayBatchV2;
exports.encodeStoreReplayBatchV3 = encodeStoreReplayBatchV3;
exports.decodeStoreReplayBatchV3 = decodeStoreReplayBatchV3;
exports.storeReplayBatchJsonBytes = storeReplayBatchJsonBytes;
exports.storeReplayBatchV2JsonBytes = storeReplayBatchV2JsonBytes;
exports.storeReplayBatchV3JsonBytes = storeReplayBatchV3JsonBytes;
exports.storeReplayBatchV4WireBytes = storeReplayBatchV4WireBytes;
exports.storeReplayBatchV5WireBytes = storeReplayBatchV5WireBytes;
exports.storeReplayPatchJsonBytes = storeReplayPatchJsonBytes;
exports.storeReplayPatchMaxWireMetrics = storeReplayPatchMaxWireMetrics;
exports.storeReplayPatchMaxWireBytes = storeReplayPatchMaxWireBytes;
exports.storeReplayBatchMaxWireMetrics = storeReplayBatchMaxWireMetrics;
const rpc_wire_size_1 = require("../rcp/rpc-wire-size");
const store_replay_columnar_1 = require("./store-replay-columnar");
var store_replay_columnar_2 = require("./store-replay-columnar");
Object.defineProperty(exports, "STORE_REPLAY_BATCH_V4_VERSION", { enumerable: true, get: function () { return store_replay_columnar_2.STORE_REPLAY_BATCH_V4_VERSION; } });
Object.defineProperty(exports, "prepareStoreReplayBatchPlan", { enumerable: true, get: function () { return store_replay_columnar_2.prepareStoreReplayBatchPlan; } });
Object.defineProperty(exports, "decodeStoreReplayBatchPlan", { enumerable: true, get: function () { return store_replay_columnar_2.decodeStoreReplayBatchPlan; } });
Object.defineProperty(exports, "encodeStoreReplayBatchV4", { enumerable: true, get: function () { return store_replay_columnar_2.encodeStoreReplayBatchV4; } });
Object.defineProperty(exports, "decodeStoreReplayBatchV4", { enumerable: true, get: function () { return store_replay_columnar_2.decodeStoreReplayBatchV4; } });
Object.defineProperty(exports, "encodeStoreReplayBatchV5", { enumerable: true, get: function () { return store_replay_columnar_2.encodeStoreReplayBatchV5; } });
Object.defineProperty(exports, "decodeStoreReplayBatchV5", { enumerable: true, get: function () { return store_replay_columnar_2.decodeStoreReplayBatchV5; } });
exports.STORE_REPLAY_BATCH_VERSION = 1;
exports.STORE_REPLAY_BATCH_V2_VERSION = 2;
exports.STORE_REPLAY_BATCH_V3_VERSION = 3;
const STORE_REPLAY_VALUE_TAG = '$_sr';
const RPC_WIRE_VALUE_TAG_NAMES = ['$_f', '$_d', '$_m', '$_s', '$_r', '$_b'];
const RPC_WIRE_VALUE_TAGS = new Set(RPC_WIRE_VALUE_TAG_NAMES);
const utf8Encoder = new TextEncoder();
function owns(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function isReservedWireKey(key) {
    return key == '__proto__' || key == 'constructor' || key == 'prototype';
}
function isOpaqueWireValue(value) {
    return value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer
        || ArrayBuffer.isView(value);
}
function isPlainWireObject(value) {
    return Object.getPrototypeOf(value) == Object.prototype;
}
function needsWireObjectEscape(value, keys) {
    const record = value;
    return owns(value, STORE_REPLAY_VALUE_TAG)
        || keys.some(isReservedWireKey)
        || (keys.length == 1 && RPC_WIRE_VALUE_TAGS.has(keys[0]))
        || Object.is(record['_placeholder'], true);
}
function isDirectWireLeaf(value) {
    return value !== undefined
        && (value == null || typeof value != 'object' || isOpaqueWireValue(value));
}
function copyObjectPrefix(source, keys, end) {
    const copied = {};
    for (let index = 0; index < end; index++) {
        const key = keys[index];
        defineDecodedValue(copied, key, source[key]);
    }
    return copied;
}
function copyMapPrefix(source, end) {
    const copied = new Map();
    let index = 0;
    for (const [key, item] of source) {
        if (index == end)
            break;
        copied.set(key, item);
        index++;
    }
    return copied;
}
function copySetPrefix(source, end) {
    const copied = new Set();
    let index = 0;
    for (const item of source) {
        if (index == end)
            break;
        copied.add(item);
        index++;
    }
    return copied;
}
function encodeStoreReplayValue(value, seen) {
    if (value === undefined)
        return { [STORE_REPLAY_VALUE_TAG]: 0 };
    if (value == null || typeof value != 'object' || isOpaqueWireValue(value))
        return value;
    let knownKeys;
    if (Array.isArray(value)) {
        let direct = true;
        for (let index = 0; index < value.length; index++) {
            if (index in value && !isDirectWireLeaf(value[index])) {
                direct = false;
                break;
            }
        }
        if (direct)
            return value;
    }
    else if (value instanceof Map) {
        let direct = true;
        for (const [key, item] of value) {
            if (!isDirectWireLeaf(key) || !isDirectWireLeaf(item)) {
                direct = false;
                break;
            }
        }
        if (direct)
            return value;
    }
    else if (value instanceof Set) {
        let direct = true;
        for (const item of value) {
            if (!isDirectWireLeaf(item)) {
                direct = false;
                break;
            }
        }
        if (direct)
            return value;
    }
    else if (isPlainWireObject(value)) {
        knownKeys = Object.keys(value);
        const record = value;
        if (!needsWireObjectEscape(value, knownKeys)
            && knownKeys.every(function hasDirectWireValue(key) {
                return isDirectWireLeaf(record[key]);
            })) {
            return value;
        }
    }
    const active = seen ?? new WeakSet();
    if (active.has(value))
        throw new TypeError('store replay batch v3: cyclic values are not supported');
    active.add(value);
    try {
        if (Array.isArray(value)) {
            let encoded;
            for (let index = 0; index < value.length; index++) {
                if (!(index in value))
                    continue;
                const item = value[index];
                const encodedItem = encodeStoreReplayValue(item, active);
                if (!encoded && !Object.is(encodedItem, item))
                    encoded = value.slice();
                if (encoded)
                    encoded[index] = encodedItem;
            }
            return encoded ?? value;
        }
        if (value instanceof Map) {
            let encoded;
            let index = 0;
            for (const [key, item] of value) {
                const encodedKey = encodeStoreReplayValue(key, active);
                const encodedItem = encodeStoreReplayValue(item, active);
                if (!encoded && (!Object.is(encodedKey, key) || !Object.is(encodedItem, item))) {
                    encoded = copyMapPrefix(value, index);
                }
                if (encoded)
                    encoded.set(encodedKey, encodedItem);
                index++;
            }
            return encoded ?? value;
        }
        if (value instanceof Set) {
            let encoded;
            let index = 0;
            for (const item of value) {
                const encodedItem = encodeStoreReplayValue(item, active);
                if (!encoded && !Object.is(encodedItem, item))
                    encoded = copySetPrefix(value, index);
                if (encoded)
                    encoded.add(encodedItem);
                index++;
            }
            return encoded ?? value;
        }
        const keys = knownKeys ?? Object.keys(value);
        if (needsWireObjectEscape(value, keys)) {
            return {
                [STORE_REPLAY_VALUE_TAG]: 1,
                entries: keys.map(function encodeStoreReplayObjectEntry(key) {
                    return [key, encodeStoreReplayValue(value[key], active)];
                }),
            };
        }
        const record = value;
        let encoded = isPlainWireObject(value) ? undefined : {};
        for (let index = 0; index < keys.length; index++) {
            const key = keys[index];
            const item = record[key];
            const encodedItem = encodeStoreReplayValue(item, active);
            if (!encoded && !Object.is(encodedItem, item))
                encoded = copyObjectPrefix(record, keys, index);
            if (encoded)
                defineDecodedValue(encoded, key, encodedItem);
        }
        return encoded ?? value;
    }
    finally {
        active.delete(value);
    }
}
function defineDecodedValue(target, key, value) {
    Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value });
}
function decodeStoreReplayValue(value) {
    if (value == null || typeof value != 'object' || isOpaqueWireValue(value))
        return value;
    if (Array.isArray(value)) {
        let direct = true;
        for (let index = 0; index < value.length; index++) {
            if (index in value && !isDirectWireLeaf(value[index])) {
                direct = false;
                break;
            }
        }
        if (direct)
            return value;
        let decoded;
        for (let index = 0; index < value.length; index++) {
            if (!(index in value))
                continue;
            const item = value[index];
            const decodedItem = decodeStoreReplayValue(item);
            if (!decoded && !Object.is(decodedItem, item))
                decoded = value.slice();
            if (decoded)
                decoded[index] = decodedItem;
        }
        return decoded ?? value;
    }
    if (value instanceof Map) {
        let direct = true;
        for (const [key, item] of value) {
            if (!isDirectWireLeaf(key) || !isDirectWireLeaf(item)) {
                direct = false;
                break;
            }
        }
        if (direct)
            return value;
        let decoded;
        let index = 0;
        for (const [key, item] of value) {
            const decodedKey = decodeStoreReplayValue(key);
            const decodedItem = decodeStoreReplayValue(item);
            if (!decoded && (!Object.is(decodedKey, key) || !Object.is(decodedItem, item))) {
                decoded = copyMapPrefix(value, index);
            }
            if (decoded)
                decoded.set(decodedKey, decodedItem);
            index++;
        }
        return decoded ?? value;
    }
    if (value instanceof Set) {
        let direct = true;
        for (const item of value) {
            if (!isDirectWireLeaf(item)) {
                direct = false;
                break;
            }
        }
        if (direct)
            return value;
        let decoded;
        let index = 0;
        for (const item of value) {
            const decodedItem = decodeStoreReplayValue(item);
            if (!decoded && !Object.is(decodedItem, item))
                decoded = copySetPrefix(value, index);
            if (decoded)
                decoded.add(decodedItem);
            index++;
        }
        return decoded ?? value;
    }
    const record = value;
    const keys = Object.keys(record);
    if (keys.length == 1 && keys[0] == STORE_REPLAY_VALUE_TAG && record[STORE_REPLAY_VALUE_TAG] == 0) {
        return undefined;
    }
    if (keys.length == 2 && keys.includes(STORE_REPLAY_VALUE_TAG) && keys.includes('entries')
        && record[STORE_REPLAY_VALUE_TAG] == 1 && Array.isArray(record['entries'])) {
        const decoded = {};
        for (const entry of record['entries']) {
            if (!Array.isArray(entry) || entry.length != 2 || typeof entry[0] != 'string') {
                throw new TypeError('store replay batch v3: invalid escaped object entry');
            }
            defineDecodedValue(decoded, entry[0], decodeStoreReplayValue(entry[1]));
        }
        return decoded;
    }
    const shareable = isPlainWireObject(value) && !needsWireObjectEscape(value, keys);
    if (shareable && keys.every(function hasDirectDecodedValue(key) {
        return isDirectWireLeaf(record[key]);
    }))
        return value;
    let decoded = shareable
        ? undefined
        : {};
    for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        const item = record[key];
        const decodedItem = decodeStoreReplayValue(item);
        if (!decoded && !Object.is(decodedItem, item))
            decoded = copyObjectPrefix(record, keys, index);
        if (decoded)
            defineDecodedValue(decoded, key, decodedItem);
    }
    return decoded ?? value;
}
function encodeStoreReplayPatch(patch) {
    const path = [...patch.path];
    if (!patch.exists)
        return [path, 0];
    return patch.value === undefined ? [path, 2] : [path, 1, patch.value];
}
function decodeStoreReplayPatch(wire) {
    if (!Array.isArray(wire) || !Array.isArray(wire[0]))
        throw new TypeError('store replay batch: invalid patch tuple');
    if (wire[1] == 0 && wire.length == 2)
        return { path: [...wire[0]], exists: false, value: undefined };
    if (wire[1] == 2 && wire.length == 2)
        return { path: [...wire[0]], exists: true, value: undefined };
    if (wire[1] == 1 && wire.length == 3)
        return { path: [...wire[0]], exists: true, value: wire[2] };
    throw new TypeError('store replay batch: unknown patch operation');
}
function v2Path(value) {
    if (Array.isArray(value))
        return [...value];
    if (typeof value == 'string' || typeof value == 'number' || typeof value == 'symbol')
        return [value];
    throw new TypeError('store replay batch v2: invalid path');
}
function encodeStoreReplayPatchV2(patch) {
    const target = patch.path.length == 1 ? patch.path[0] : [...patch.path];
    if (patch.exists && patch.value === undefined)
        return [target, 2, 0];
    if (patch.path.length == 1) {
        const key = patch.path[0];
        return patch.exists ? [key, patch.value] : [key];
    }
    const path = [...patch.path];
    return patch.exists ? [path, patch.value] : [path];
}
function decodeStoreReplayPatchV2(wire) {
    if (!Array.isArray(wire) || (wire.length != 1 && wire.length != 2 && wire.length != 3)) {
        throw new TypeError('store replay batch v2: invalid patch tuple');
    }
    const path = v2Path(wire[0]);
    if (wire.length == 3) {
        if (wire[1] == 2 && wire[2] == 0)
            return { path, exists: true, value: undefined };
        throw new TypeError('store replay batch v2: unknown patch operation');
    }
    return wire.length == 2
        ? { path, exists: true, value: wire[1] }
        : { path, exists: false, value: undefined };
}
function encodeStoreReplayPatchV3(patch) {
    if (patch.exists && patch.value === undefined) {
        const target = patch.path.length == 1 ? patch.path[0] : [...patch.path];
        return [target, 2, 0];
    }
    if (patch.path.length == 1) {
        const key = patch.path[0];
        if (!patch.exists)
            return [key];
        const encoded = encodeStoreReplayValue(patch.value);
        return Object.is(encoded, patch.value) ? [key, patch.value] : [key, 3, encoded];
    }
    const path = [...patch.path];
    if (!patch.exists)
        return [path];
    const encoded = encodeStoreReplayValue(patch.value);
    return Object.is(encoded, patch.value) ? [path, patch.value] : [path, 3, encoded];
}
function decodeStoreReplayPatchV3(wire) {
    if (Array.isArray(wire) && wire.length == 3 && wire[1] == 3) {
        return { path: v2Path(wire[0]), exists: true, value: decodeStoreReplayValue(wire[2]) };
    }
    return decodeStoreReplayPatchV2(wire);
}
function encodeStoreReplayBatch(event) {
    return [exports.STORE_REPLAY_BATCH_VERSION, event.seq, event.ts, event.event[0].map(encodeStoreReplayPatch)];
}
function decodeStoreReplayBatch(wire) {
    if (!Array.isArray(wire) || wire.length != 4 || wire[0] != exports.STORE_REPLAY_BATCH_VERSION
        || typeof wire[1] != 'number' || typeof wire[2] != 'number' || !Array.isArray(wire[3])) {
        throw new TypeError('store replay batch: unsupported envelope');
    }
    return {
        seq: wire[1],
        ts: wire[2],
        event: [wire[3].map(decodeStoreReplayPatch)],
    };
}
function encodeStoreReplayBatchV2(event) {
    return [exports.STORE_REPLAY_BATCH_V2_VERSION, event.seq, event.ts, event.event[0].map(encodeStoreReplayPatchV2)];
}
function decodeStoreReplayBatchV2(wire) {
    if (!Array.isArray(wire) || wire.length != 4 || wire[0] != exports.STORE_REPLAY_BATCH_V2_VERSION
        || typeof wire[1] != 'number' || typeof wire[2] != 'number' || !Array.isArray(wire[3])) {
        throw new TypeError('store replay batch v2: unsupported envelope');
    }
    return {
        seq: wire[1],
        ts: wire[2],
        event: [wire[3].map(decodeStoreReplayPatchV2)],
    };
}
function encodeStoreReplayBatchV3(event) {
    return [exports.STORE_REPLAY_BATCH_V3_VERSION, event.seq, event.ts, event.event[0].map(encodeStoreReplayPatchV3)];
}
function decodeStoreReplayBatchV3(wire) {
    if (!Array.isArray(wire) || wire.length != 4 || wire[0] != exports.STORE_REPLAY_BATCH_V3_VERSION
        || typeof wire[1] != 'number' || typeof wire[2] != 'number' || !Array.isArray(wire[3])) {
        throw new TypeError('store replay batch v3: unsupported envelope');
    }
    return {
        seq: wire[1],
        ts: wire[2],
        event: [wire[3].map(decodeStoreReplayPatchV3)],
    };
}
function storeReplayBatchJsonBytes(wire) {
    const tuple = Array.isArray(wire) ? wire : encodeStoreReplayBatch(wire);
    return utf8Encoder.encode(JSON.stringify(tuple)).byteLength;
}
function storeReplayBatchV2JsonBytes(wire) {
    const tuple = Array.isArray(wire) ? wire : encodeStoreReplayBatchV2(wire);
    return utf8Encoder.encode(JSON.stringify(tuple)).byteLength;
}
function storeReplayBatchV3JsonBytes(wire) {
    const tuple = Array.isArray(wire) ? wire : encodeStoreReplayBatchV3(wire);
    return utf8Encoder.encode(JSON.stringify(tuple)).byteLength;
}
function storeReplayBatchV4WireBytes(wire) {
    const tuple = Array.isArray(wire) ? wire : (0, store_replay_columnar_1.encodeStoreReplayBatchV4)(wire);
    return (0, rpc_wire_size_1.rpcResultWireByteLength)(tuple);
}
function storeReplayBatchV5WireBytes(wire) {
    const binary = wire instanceof Uint8Array ? wire : (0, store_replay_columnar_1.encodeStoreReplayBatchV5)(wire);
    return binary.byteLength;
}
function storeReplayPatchJsonBytes(patch) {
    return (0, rpc_wire_size_1.rpcResultWireByteLength)(encodeStoreReplayPatch(patch));
}
function storeReplayPatchMaxWireMetrics(patch, firstBinaryIndex = 0) {
    if (!patch.exists)
        return (0, rpc_wire_size_1.rpcResultWireMetrics)(encodeStoreReplayPatch(patch), firstBinaryIndex);
    if (patch.value === undefined) {
        const wire = patch.path.length == 1
            ? encodeStoreReplayPatch(patch)
            : encodeStoreReplayPatchV2(patch);
        return (0, rpc_wire_size_1.rpcResultWireMetrics)(wire, firstBinaryIndex);
    }
    const legacy = (0, rpc_wire_size_1.rpcResultWireMetrics)(encodeStoreReplayPatch(patch), firstBinaryIndex);
    const v3Wire = encodeStoreReplayPatchV3(patch);
    if (v3Wire.length != 3 || v3Wire[1] != 3)
        return legacy;
    const v3 = (0, rpc_wire_size_1.rpcResultWireMetrics)(v3Wire, firstBinaryIndex);
    return {
        byteLength: Math.max(legacy.byteLength, v3.byteLength),
        binaryCount: Math.max(legacy.binaryCount, v3.binaryCount),
    };
}
function storeReplayPatchMaxWireBytes(patch) {
    return storeReplayPatchMaxWireMetrics(patch).byteLength;
}
function storeReplayBatchMaxWireMetrics(patches) {
    const event = {
        seq: Number.MAX_SAFE_INTEGER,
        ts: Number.MAX_SAFE_INTEGER,
        event: [patches],
    };
    const metrics = [
        (0, rpc_wire_size_1.rpcResultWireMetrics)(encodeStoreReplayBatch(event)),
        (0, rpc_wire_size_1.rpcResultWireMetrics)(encodeStoreReplayBatchV2(event)),
        (0, rpc_wire_size_1.rpcResultWireMetrics)(encodeStoreReplayBatchV3(event)),
        (0, rpc_wire_size_1.rpcResultWireMetrics)((0, store_replay_columnar_1.encodeStoreReplayBatchV4)(event)),
        (0, rpc_wire_size_1.rpcResultWireMetrics)((0, store_replay_columnar_1.encodeStoreReplayBatchV5)(event)),
    ];
    return {
        byteLength: Math.max(...metrics.map(metric => metric.byteLength)),
        binaryCount: Math.max(...metrics.map(metric => metric.binaryCount)),
    };
}
