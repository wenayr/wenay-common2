"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRpcBinaryPeer = createRpcBinaryPeer;
const rpc_binary_value_1 = require("./rpc-binary-value");
const rpc_binary_schema_1 = require("./rpc-binary-schema");
const rpc_binary_envelope_1 = require("./rpc-binary-envelope");
const rpc_caps_1 = require("./rpc-caps");
const rpc_protocol_1 = require("./rpc-protocol");
const RPC_BINARY_VALUE_MAGIC = [0x52, 0x56, 0x42];
const RPC_BINARY_SCHEMA_VALUE_MAGIC = [0x52, 0x56, 0x53];
const RPC_BINARY_MAX_VALUE_BYTES = 16_000_000;
const RPC_BINARY_MAX_VALUE_FRAME_BYTES = rpc_binary_envelope_1.RPC_BINARY_MAX_FRAME_BYTES - 32;
const RPC_BINARY_PACKET_DEPTH = 32 + 4;
function createRpcBinaryPeer({ sessionId, maxShapes, protocolVersion = rpc_binary_envelope_1.RPC_BINARY_PROTOCOL_VERSION, maxSchemas = rpc_caps_1.RPC_BINARY_MAX_SCHEMAS, promotionThreshold = rpc_caps_1.RPC_BINARY_DEFAULT_PROMOTION_THRESHOLD, predeclared = [], }) {
    const schema = protocolVersion == rpc_binary_envelope_1.RPC_BINARY_SCHEMA_PROTOCOL_VERSION;
    const encoder = schema
        ? (0, rpc_binary_schema_1.createRpcBinarySchemaCodec)({
            magic: RPC_BINARY_SCHEMA_VALUE_MAGIC,
            version: rpc_binary_envelope_1.RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
            label: 'RPC binary schema value',
            callbackRefs: true,
            maxSchemas,
            promotionThreshold,
            predeclared,
            maxDepth: RPC_BINARY_PACKET_DEPTH,
            maxBinaryBytes: RPC_BINARY_MAX_VALUE_BYTES,
            maxWireBytes: RPC_BINARY_MAX_VALUE_FRAME_BYTES,
        })
        : (0, rpc_binary_value_1.createBinaryValueCodec)({
            magic: RPC_BINARY_VALUE_MAGIC,
            version: rpc_binary_envelope_1.RPC_BINARY_PROTOCOL_VERSION,
            label: 'RPC binary value',
            callbackRefs: true,
            shapeCache: { maxEntries: maxShapes },
            maxDepth: RPC_BINARY_PACKET_DEPTH,
            maxBinaryBytes: RPC_BINARY_MAX_VALUE_BYTES,
            maxWireBytes: RPC_BINARY_MAX_VALUE_FRAME_BYTES,
        });
    const decoder = schema
        ? (0, rpc_binary_schema_1.createRpcBinarySchemaCodec)({
            magic: RPC_BINARY_SCHEMA_VALUE_MAGIC,
            version: rpc_binary_envelope_1.RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
            label: 'RPC binary schema value',
            callbackRefs: true,
            maxSchemas: rpc_caps_1.RPC_BINARY_MAX_SCHEMAS,
            promotionThreshold,
            maxDepth: RPC_BINARY_PACKET_DEPTH,
            maxBinaryBytes: RPC_BINARY_MAX_VALUE_BYTES,
            maxWireBytes: RPC_BINARY_MAX_VALUE_FRAME_BYTES,
        })
        : (0, rpc_binary_value_1.createBinaryValueCodec)({
            magic: RPC_BINARY_VALUE_MAGIC,
            version: rpc_binary_envelope_1.RPC_BINARY_PROTOCOL_VERSION,
            label: 'RPC binary value',
            callbackRefs: true,
            shapeCache: { maxEntries: rpc_caps_1.RPC_BINARY_MAX_SHAPES },
            maxDepth: RPC_BINARY_PACKET_DEPTH,
            maxBinaryBytes: RPC_BINARY_MAX_VALUE_BYTES,
            maxWireBytes: RPC_BINARY_MAX_VALUE_FRAME_BYTES,
        });
    let packetHeaderByteLength;
    function schemaPacketDepthBias(packet) {
        if (!schema)
            return 0;
        if (packet[0] == rpc_protocol_1.Pkt.CALL)
            return 2;
        if (packet[0] == rpc_protocol_1.Pkt.RESP && packet.length == 3)
            return 3;
        if (packet[0] == rpc_protocol_1.Pkt.CB)
            return 2;
        return 0;
    }
    function prepare(packet) {
        const encoded = schema
            ? encoder
                .prepareEncodeTrusted(packet, schemaPacketDepthBias(packet))
            : encoder.prepareEncode(packet);
        try {
            const wire = (0, rpc_binary_envelope_1.wrapRpcBinaryPacket)(sessionId, encoded.wire, protocolVersion);
            return {
                wire,
                commit: encoded.commit,
                rollback: encoded.rollback,
            };
        }
        catch (error) {
            encoded.rollback();
            throw error;
        }
    }
    function measure(packet) {
        if (packetHeaderByteLength == undefined) {
            packetHeaderByteLength = (0, rpc_binary_envelope_1.encodeRpcBinaryControl)(rpc_binary_envelope_1.RpcBinaryFrame.PROBE, sessionId, protocolVersion).byteLength;
        }
        const valueByteLength = schema
            ? encoder
                .measureEncodeTrusted(packet, schemaPacketDepthBias(packet))
            : encoder.measureEncode(packet);
        const byteLength = packetHeaderByteLength + valueByteLength;
        if (byteLength > rpc_binary_envelope_1.RPC_BINARY_MAX_FRAME_BYTES) {
            throw new RangeError('RPC binary envelope: frame exceeds binary limit');
        }
        return byteLength;
    }
    function decode(payload) {
        return decoder.decodeTrusted(payload);
    }
    function encodePrelude() {
        return schema
            ? encoder.encodePrelude()
            : new Uint8Array();
    }
    function decodePrelude(payload) {
        if (!schema) {
            if (payload.byteLength != 0) {
                throw new TypeError('RPC binary v1 cannot accept a schema prelude');
            }
            return;
        }
        const schemaDecoder = decoder;
        schemaDecoder.decodePrelude(payload);
    }
    function stats() {
        const sent = encoder.stats();
        const received = decoder.stats();
        if (schema) {
            const schemaSent = sent;
            const schemaReceived = received;
            return {
                ...schemaSent,
                decodeSchemas: schemaReceived.decodeSchemas,
                decodeDefinitions: schemaReceived.decodeDefinitions,
                decodeReferences: schemaReceived.decodeReferences,
                decodeRuns: schemaReceived.decodeRuns,
                decodeRows: schemaReceived.decodeRows,
                decodeGeneric: schemaReceived.decodeGeneric,
                decodeTypedFields: schemaReceived.decodeTypedFields,
            };
        }
        const legacyReceived = received;
        return {
            ...sent,
            decodeShapes: legacyReceived.decodeShapes,
            decodeFieldRefs: legacyReceived.decodeFieldRefs,
            decodeKeyTextBytes: legacyReceived.decodeKeyTextBytes,
            decodeDefinitions: legacyReceived.decodeDefinitions,
            decodeReferences: legacyReceived.decodeReferences,
        };
    }
    function reset() {
        encoder.reset();
        decoder.reset();
    }
    return {
        protocolVersion,
        prepare,
        measure,
        decode,
        encodePrelude,
        decodePrelude,
        stats,
        reset,
    };
}
