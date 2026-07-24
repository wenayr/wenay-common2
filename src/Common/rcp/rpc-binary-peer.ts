// =====================================================================
// Stateful RPC binary peer — exact values plus per-direction shape caches
// =====================================================================

import {createBinaryValueCodec} from './rpc-binary-value'
import {createRpcBinarySchemaCodec} from './rpc-binary-schema'
import {
    encodeRpcBinaryControl,
    RPC_BINARY_MAX_FRAME_BYTES,
    RPC_BINARY_PROTOCOL_VERSION,
    RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
    RpcBinaryFrame,
    type RpcBinaryProtocolVersion,
    wrapRpcBinaryPacket,
} from './rpc-binary-envelope'
import {
    RPC_BINARY_DEFAULT_PROMOTION_THRESHOLD,
    RPC_BINARY_MAX_SCHEMAS,
    RPC_BINARY_MAX_SHAPES,
} from './rpc-caps'
import {Pkt} from './rpc-protocol'

const RPC_BINARY_VALUE_MAGIC = [0x52, 0x56, 0x42] as const
const RPC_BINARY_SCHEMA_VALUE_MAGIC = [0x52, 0x56, 0x53] as const
const RPC_BINARY_MAX_VALUE_BYTES = 16_000_000
const RPC_BINARY_MAX_VALUE_FRAME_BYTES = RPC_BINARY_MAX_FRAME_BYTES - 32
// CB_BATCH and PIPE add at most four collection layers before the first
// application value. RpcLimits still validates that value at its own depth 0.
const RPC_BINARY_PACKET_DEPTH = 32 + 4

export function createRpcBinaryPeer({
    sessionId,
    maxShapes,
    protocolVersion = RPC_BINARY_PROTOCOL_VERSION,
    maxSchemas = RPC_BINARY_MAX_SCHEMAS,
    promotionThreshold = RPC_BINARY_DEFAULT_PROMOTION_THRESHOLD,
    predeclared = [],
}: {
    sessionId: number
    maxShapes: number
    protocolVersion?: RpcBinaryProtocolVersion
    maxSchemas?: number
    promotionThreshold?: number
    predeclared?: readonly unknown[]
}) {
    const schema = protocolVersion == RPC_BINARY_SCHEMA_PROTOCOL_VERSION
    const encoder = schema
        ? createRpcBinarySchemaCodec({
            magic: RPC_BINARY_SCHEMA_VALUE_MAGIC,
            version: RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
            label: 'RPC binary schema value',
            callbackRefs: true,
            maxSchemas,
            promotionThreshold,
            predeclared,
            maxDepth: RPC_BINARY_PACKET_DEPTH,
            maxBinaryBytes: RPC_BINARY_MAX_VALUE_BYTES,
            maxWireBytes: RPC_BINARY_MAX_VALUE_FRAME_BYTES,
        })
        : createBinaryValueCodec({
            magic: RPC_BINARY_VALUE_MAGIC,
            version: RPC_BINARY_PROTOCOL_VERSION,
            label: 'RPC binary value',
            callbackRefs: true,
            shapeCache: {maxEntries: maxShapes},
            maxDepth: RPC_BINARY_PACKET_DEPTH,
            maxBinaryBytes: RPC_BINARY_MAX_VALUE_BYTES,
            maxWireBytes: RPC_BINARY_MAX_VALUE_FRAME_BYTES,
        })
    // The option controls only what this peer emits. A receiver must accept every
    // cache id allowed by the protocol; otherwise unequal local tuning desynchronizes
    // the stream after the first shape outside the smaller budget.
    const decoder = schema
        ? createRpcBinarySchemaCodec({
            magic: RPC_BINARY_SCHEMA_VALUE_MAGIC,
            version: RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
            label: 'RPC binary schema value',
            callbackRefs: true,
            maxSchemas: RPC_BINARY_MAX_SCHEMAS,
            promotionThreshold,
            maxDepth: RPC_BINARY_PACKET_DEPTH,
            maxBinaryBytes: RPC_BINARY_MAX_VALUE_BYTES,
            maxWireBytes: RPC_BINARY_MAX_VALUE_FRAME_BYTES,
        })
        : createBinaryValueCodec({
            magic: RPC_BINARY_VALUE_MAGIC,
            version: RPC_BINARY_PROTOCOL_VERSION,
            label: 'RPC binary value',
            callbackRefs: true,
            shapeCache: {maxEntries: RPC_BINARY_MAX_SHAPES},
            maxDepth: RPC_BINARY_PACKET_DEPTH,
            maxBinaryBytes: RPC_BINARY_MAX_VALUE_BYTES,
            maxWireBytes: RPC_BINARY_MAX_VALUE_FRAME_BYTES,
        })
    let packetHeaderByteLength: number | undefined

    // Schema-v2 counts application depth independently of the fixed RPC wrapper.
    // Bias shallow packets up to the deepest supported wrapper (CB_BATCH/PIPE),
    // so every application root gets the same exact maxDepth boundary without
    // another validation walk over the decoded business value.
    function schemaPacketDepthBias(packet: any[]) {
        if (!schema) return 0
        if (packet[0] == Pkt.CALL) return 2
        if (packet[0] == Pkt.RESP && packet.length == 3) return 3
        if (packet[0] == Pkt.CB) return 2
        return 0
    }

    function prepare(packet: any[]) {
        const encoded = schema
            ? (encoder as ReturnType<typeof createRpcBinarySchemaCodec>)
                .prepareEncodeTrusted(packet, schemaPacketDepthBias(packet))
            : encoder.prepareEncode(packet)
        try {
            const wire = wrapRpcBinaryPacket(sessionId, encoded.wire, protocolVersion)
            return {
                wire,
                commit: encoded.commit,
                rollback: encoded.rollback,
            }
        } catch (error) {
            encoded.rollback()
            throw error
        }
    }

    function measure(packet: any[]) {
        if (packetHeaderByteLength == undefined) {
            packetHeaderByteLength = encodeRpcBinaryControl(
                RpcBinaryFrame.PROBE,
                sessionId,
                protocolVersion,
            ).byteLength
        }
        const valueByteLength = schema
            ? (encoder as ReturnType<typeof createRpcBinarySchemaCodec>)
                .measureEncodeTrusted(packet, schemaPacketDepthBias(packet))
            : encoder.measureEncode(packet)
        const byteLength = packetHeaderByteLength + valueByteLength
        if (byteLength > RPC_BINARY_MAX_FRAME_BYTES) {
            throw new RangeError('RPC binary envelope: frame exceeds binary limit')
        }
        return byteLength
    }

    function decode(payload: Uint8Array) {
        return decoder.decodeTrusted(payload)
    }

    function encodePrelude() {
        return schema
            ? (encoder as ReturnType<typeof createRpcBinarySchemaCodec>).encodePrelude()
            : new Uint8Array()
    }

    function decodePrelude(payload: Uint8Array) {
        if (!schema) {
            if (payload.byteLength != 0) {
                throw new TypeError('RPC binary v1 cannot accept a schema prelude')
            }
            return
        }
        const schemaDecoder = decoder as ReturnType<typeof createRpcBinarySchemaCodec>
        schemaDecoder.decodePrelude(payload)
    }

    function stats() {
        const sent = encoder.stats()
        const received = decoder.stats()
        if (schema) {
            const schemaSent = sent as ReturnType<
                ReturnType<typeof createRpcBinarySchemaCodec>['stats']
            >
            const schemaReceived = received as ReturnType<
                ReturnType<typeof createRpcBinarySchemaCodec>['stats']
            >
            return {
                ...schemaSent,
                decodeSchemas: schemaReceived.decodeSchemas,
                decodeDefinitions: schemaReceived.decodeDefinitions,
                decodeReferences: schemaReceived.decodeReferences,
                decodeRuns: schemaReceived.decodeRuns,
                decodeRows: schemaReceived.decodeRows,
                decodeGeneric: schemaReceived.decodeGeneric,
                decodeTypedFields: schemaReceived.decodeTypedFields,
            }
        }
        const legacyReceived = received as ReturnType<
            ReturnType<typeof createBinaryValueCodec>['stats']
        >
        return {
            ...sent,
            decodeShapes: legacyReceived.decodeShapes,
            decodeFieldRefs: legacyReceived.decodeFieldRefs,
            decodeKeyTextBytes: legacyReceived.decodeKeyTextBytes,
            decodeDefinitions: legacyReceived.decodeDefinitions,
            decodeReferences: legacyReceived.decodeReferences,
        }
    }

    function reset() {
        encoder.reset()
        decoder.reset()
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
    }
}

export type RpcBinaryPeer = ReturnType<typeof createRpcBinaryPeer>
