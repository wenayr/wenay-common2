"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rpcResultWireMetrics = rpcResultWireMetrics;
exports.rpcResultWireByteLength = rpcResultWireByteLength;
const wire_size_1 = require("../wire-size");
const rpc_walk_1 = require("./rpc-walk");
function binaryByteLength(value) {
    if (ArrayBuffer.isView(value))
        return value.byteLength;
    if (value instanceof ArrayBuffer)
        return value.byteLength;
    return null;
}
function rpcResultWireMetrics(value, firstBinaryIndex = 0) {
    let binaryBytes = 0;
    let binaryIndex = firstBinaryIndex;
    function replaceBinary(next) {
        const bytes = binaryByteLength(next);
        if (bytes != null) {
            binaryBytes += bytes;
            return { _placeholder: true, num: binaryIndex++ };
        }
        if (next == null || typeof next != 'object')
            return next;
        if (Array.isArray(next))
            return next.map(replaceBinary);
        const out = {};
        for (const key of Object.keys(next))
            out[key] = replaceBinary(next[key]);
        return out;
    }
    const jsonBytes = (0, wire_size_1.jsonUtf8ByteLength)(replaceBinary((0, rpc_walk_1.packResult)(value)));
    return {
        byteLength: Number.isFinite(jsonBytes) ? jsonBytes + binaryBytes : jsonBytes,
        binaryCount: binaryIndex - firstBinaryIndex,
    };
}
function rpcResultWireByteLength(value) {
    return rpcResultWireMetrics(value).byteLength;
}
