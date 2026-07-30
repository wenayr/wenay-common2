"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORE_REPLAY_BATCH_V2_VERSION = void 0;
exports.encodeStoreReplayPatchV2 = encodeStoreReplayPatchV2;
exports.decodeStoreReplayPatchV2 = decodeStoreReplayPatchV2;
exports.encodeStoreReplayBatchV2 = encodeStoreReplayBatchV2;
exports.decodeStoreReplayBatchV2 = decodeStoreReplayBatchV2;
exports.storeReplayBatchV2JsonBytes = storeReplayBatchV2JsonBytes;
exports.storeReplayPatchV2WireMetrics = storeReplayPatchV2WireMetrics;
exports.storeReplayPatchV2WireBytes = storeReplayPatchV2WireBytes;
exports.storeReplayBatchV2WireMetrics = storeReplayBatchV2WireMetrics;
const rpc_wire_size_1 = require("../rcp/rpc-wire-size");
exports.STORE_REPLAY_BATCH_V2_VERSION = 2;
const utf8Encoder = new TextEncoder();
function v2Path(value) {
    if (Array.isArray(value))
        return [...value];
    if (typeof value == 'string' || typeof value == 'number' || typeof value == 'symbol')
        return [value];
    throw new TypeError('store replay batch v2: invalid path');
}
function encodeStoreReplayPatchV2(patch) {
    if (patch.exists && patch.value === undefined) {
        const target = patch.path.length == 1 ? patch.path[0] : [...patch.path];
        return [target, 2, 0];
    }
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
function storeReplayBatchV2JsonBytes(wire) {
    const tuple = Array.isArray(wire) ? wire : encodeStoreReplayBatchV2(wire);
    return utf8Encoder.encode(JSON.stringify(tuple)).byteLength;
}
function storeReplayPatchV2WireMetrics(patch, firstBinaryIndex = 0) {
    return (0, rpc_wire_size_1.rpcResultWireMetricsFast)(encodeStoreReplayPatchV2(patch), firstBinaryIndex);
}
function storeReplayPatchV2WireBytes(patch) {
    return storeReplayPatchV2WireMetrics(patch).byteLength;
}
function storeReplayBatchV2WireMetrics(patches) {
    return (0, rpc_wire_size_1.rpcResultWireMetrics)(encodeStoreReplayBatchV2({
        seq: Number.MAX_SAFE_INTEGER,
        ts: Number.MAX_SAFE_INTEGER,
        event: [patches],
    }));
}
