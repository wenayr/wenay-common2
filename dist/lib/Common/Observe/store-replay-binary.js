"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORE_REPLAY_BINARY_MAX_WIRE_BYTES = void 0;
exports.encodeStoreReplayBinary = encodeStoreReplayBinary;
exports.decodeStoreReplayBinary = decodeStoreReplayBinary;
const rpc_limits_1 = require("../rcp/rpc-limits");
const rpc_binary_value_1 = require("../rcp/rpc-binary-value");
const STORE_REPLAY_BINARY_MAGIC = [0x53, 0x52, 0x42];
const STORE_REPLAY_BINARY_VERSION = 5;
const STORE_REPLAY_BINARY_MAX_VALUE_BYTES = 8_000_000;
exports.STORE_REPLAY_BINARY_MAX_WIRE_BYTES = 16_000_000;
const codec = (0, rpc_binary_value_1.createBinaryValueCodec)({
    magic: STORE_REPLAY_BINARY_MAGIC,
    version: STORE_REPLAY_BINARY_VERSION,
    label: 'store replay binary',
    maxBinaryBytes: STORE_REPLAY_BINARY_MAX_VALUE_BYTES,
    maxWireBytes: exports.STORE_REPLAY_BINARY_MAX_WIRE_BYTES,
});
function encodeStoreReplayBinary(value) {
    return codec.encode(value);
}
function decodeStoreReplayBinary(wire, requestedLimits) {
    const maxWireBytes = requestedLimits
        ? (0, rpc_limits_1.resolveLimits)(requestedLimits).maxBinaryLen
        : exports.STORE_REPLAY_BINARY_MAX_WIRE_BYTES;
    return codec.decodeTrusted(wire, requestedLimits, { maxWireBytes });
}
