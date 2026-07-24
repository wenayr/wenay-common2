"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RpcBinaryFrame = exports.RPC_BINARY_MAX_FRAME_BYTES = exports.RPC_BINARY_MSGPACK_PROTOCOL_VERSION = exports.RPC_BINARY_SCHEMA_PROTOCOL_VERSION = exports.RPC_BINARY_PROTOCOL_VERSION = void 0;
exports.isRpcBinaryEnvelope = isRpcBinaryEnvelope;
exports.inspectRpcBinaryEnvelope = inspectRpcBinaryEnvelope;
exports.encodeRpcBinaryControl = encodeRpcBinaryControl;
exports.wrapRpcBinaryPacket = wrapRpcBinaryPacket;
const RPC_BINARY_MAGIC = [0x52, 0x50, 0x42];
exports.RPC_BINARY_PROTOCOL_VERSION = 1;
exports.RPC_BINARY_SCHEMA_PROTOCOL_VERSION = 2;
exports.RPC_BINARY_MSGPACK_PROTOCOL_VERSION = 3;
exports.RPC_BINARY_MAX_FRAME_BYTES = 32_000_000;
exports.RpcBinaryFrame = {
    PROBE: 0,
    PROBE_ACK: 1,
    PACKET: 2,
};
const MAX_SESSION_ID = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SESSION_VARUINT_BYTES = 8;
function binaryEnvelopeError(message) {
    throw new TypeError('RPC binary envelope: ' + message);
}
function wireBytes(wire) {
    if (wire instanceof ArrayBuffer)
        return new Uint8Array(wire);
    if (ArrayBuffer.isView(wire)) {
        return new Uint8Array(wire.buffer, wire.byteOffset, wire.byteLength);
    }
    return undefined;
}
function isMagic(bytes) {
    return bytes.byteLength >= RPC_BINARY_MAGIC.length
        && RPC_BINARY_MAGIC.every((expected, index) => bytes[index] == expected);
}
function writeVarUint(target, value) {
    let remaining = value;
    do {
        const payload = Number(remaining & 0x7fn);
        remaining >>= 7n;
        target.push(remaining == 0n ? payload : payload | 0x80);
    } while (remaining != 0n);
}
function readSessionId(bytes, start) {
    let value = 0n;
    let shift = 0n;
    let position = start;
    for (let count = 0; count < MAX_SESSION_VARUINT_BYTES; count++) {
        if (position >= bytes.byteLength)
            binaryEnvelopeError('truncated session id');
        const byte = bytes[position++];
        const payload = byte & 0x7f;
        value |= BigInt(payload) << shift;
        if ((byte & 0x80) == 0) {
            if (count > 0 && payload == 0)
                binaryEnvelopeError('non-canonical session id');
            if (value <= 0n || value > MAX_SESSION_ID)
                binaryEnvelopeError('invalid session id');
            return { sessionId: Number(value), position };
        }
        shift += 7n;
    }
    return binaryEnvelopeError('session id exceeds limit');
}
function supportedVersion(version) {
    return version == exports.RPC_BINARY_PROTOCOL_VERSION
        || version == exports.RPC_BINARY_SCHEMA_PROTOCOL_VERSION
        || version == exports.RPC_BINARY_MSGPACK_PROTOCOL_VERSION;
}
function frameHeader(kind, sessionId, version) {
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        binaryEnvelopeError('invalid session id');
    }
    const bytes = [...RPC_BINARY_MAGIC, version, kind];
    writeVarUint(bytes, BigInt(sessionId));
    return Uint8Array.from(bytes);
}
function isRpcBinaryEnvelope(wire) {
    const bytes = wireBytes(wire);
    return bytes != undefined && isMagic(bytes);
}
function inspectRpcBinaryEnvelope(wire) {
    const bytes = wireBytes(wire);
    if (!bytes || !isMagic(bytes))
        return undefined;
    if (bytes.byteLength > exports.RPC_BINARY_MAX_FRAME_BYTES) {
        throw new RangeError('RPC binary envelope: frame exceeds binary limit');
    }
    if (bytes.byteLength < RPC_BINARY_MAGIC.length + 3) {
        return binaryEnvelopeError('truncated frame');
    }
    const version = bytes[3];
    if (!supportedVersion(version))
        binaryEnvelopeError('unsupported version');
    const kind = bytes[4];
    if (kind != exports.RpcBinaryFrame.PROBE && kind != exports.RpcBinaryFrame.PROBE_ACK
        && kind != exports.RpcBinaryFrame.PACKET) {
        binaryEnvelopeError('unknown frame kind');
    }
    const session = readSessionId(bytes, 5);
    const payload = bytes.subarray(session.position);
    if (version == exports.RPC_BINARY_PROTOCOL_VERSION
        && kind != exports.RpcBinaryFrame.PACKET
        && payload.byteLength != 0) {
        binaryEnvelopeError('control frame has trailing bytes');
    }
    if (kind == exports.RpcBinaryFrame.PACKET && payload.byteLength == 0) {
        binaryEnvelopeError('packet frame has no payload');
    }
    return {
        kind: kind,
        version,
        sessionId: session.sessionId,
        payload,
    };
}
function encodeRpcBinaryControl(kind, sessionId, version = exports.RPC_BINARY_PROTOCOL_VERSION, payload) {
    const header = frameHeader(kind, sessionId, version);
    if (!payload || payload.byteLength == 0)
        return header;
    if (version == exports.RPC_BINARY_PROTOCOL_VERSION) {
        binaryEnvelopeError('v1 control frame cannot carry a payload');
    }
    const byteLength = header.byteLength + payload.byteLength;
    if (byteLength > exports.RPC_BINARY_MAX_FRAME_BYTES) {
        throw new RangeError('RPC binary envelope: frame exceeds binary limit');
    }
    const frame = new Uint8Array(byteLength);
    frame.set(header);
    frame.set(payload, header.byteLength);
    return frame;
}
function wrapRpcBinaryPacket(sessionId, payload, version = exports.RPC_BINARY_PROTOCOL_VERSION) {
    const header = frameHeader(exports.RpcBinaryFrame.PACKET, sessionId, version);
    const byteLength = header.byteLength + payload.byteLength;
    if (byteLength > exports.RPC_BINARY_MAX_FRAME_BYTES) {
        throw new RangeError('RPC binary envelope: frame exceeds binary limit');
    }
    const frame = new Uint8Array(byteLength);
    frame.set(header);
    frame.set(payload, header.byteLength);
    return frame;
}
