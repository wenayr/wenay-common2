"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRpcBinaryMsgpackCodec = createRpcBinaryMsgpackCodec;
const msgpackr_1 = require("msgpackr");
const rpc_binary_value_1 = require("./rpc-binary-value");
const RPC_MSGPACK_CALLBACK_REF_EXTENSION = 63;
(0, msgpackr_1.addExtension)({
    Class: rpc_binary_value_1.RpcBinaryCallbackRefValue,
    type: RPC_MSGPACK_CALLBACK_REF_EXTENSION,
    write(value) {
        return (0, rpc_binary_value_1.rpcBinaryCallbackRefId)(value);
    },
    read(id) {
        return (0, rpc_binary_value_1.createRpcBinaryCallbackRef)(id);
    },
});
function createRpcBinaryMsgpackCodec({ maxWireBytes, }) {
    const encoder = new msgpackr_1.Packr({
        useRecords: true,
        moreTypes: true,
        writeFunction() {
            throw new TypeError('function values are not supported');
        },
    });
    const decoder = new msgpackr_1.Unpackr({
        useRecords: true,
        moreTypes: true,
        copyBuffers: true,
    });
    let encodedFrames = 0;
    let decodedFrames = 0;
    let encodedBytes = 0;
    let decodedBytes = 0;
    function encode(value) {
        const wire = encoder.pack(value);
        if (wire.byteLength > maxWireBytes) {
            throw new RangeError('RPC msgpack value: encoded frame exceeds binary limit');
        }
        encodedFrames++;
        encodedBytes += wire.byteLength;
        return wire;
    }
    function decode(wire) {
        if (wire.byteLength > maxWireBytes) {
            throw new RangeError('RPC msgpack value: encoded frame exceeds binary limit');
        }
        const source = Object.isExtensible(wire)
            ? wire
            : new Uint8Array(wire.buffer, wire.byteOffset, wire.byteLength);
        const value = decoder.unpack(source);
        decodedFrames++;
        decodedBytes += wire.byteLength;
        return value;
    }
    function measure(value) {
        return encoder.pack(value).byteLength;
    }
    function stats() {
        return {
            encodedFrames,
            decodedFrames,
            encodedBytes,
            decodedBytes,
        };
    }
    function reset() {
        encodedFrames = 0;
        decodedFrames = 0;
        encodedBytes = 0;
        decodedBytes = 0;
    }
    return {
        encode,
        decode,
        measure,
        stats,
        reset,
    };
}
