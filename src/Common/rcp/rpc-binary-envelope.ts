// =====================================================================
// RPC binary envelope — session routing before stateful value decoding
// =====================================================================

const RPC_BINARY_MAGIC = [0x52, 0x50, 0x42] as const
// This is the version of the complete envelope + value-tag bundle. Any
// value-codec change which can emit new bytes must bump this same byte so the
// probe fails closed and both peers remain on legacy application packets.
export const RPC_BINARY_PROTOCOL_VERSION = 1
export const RPC_BINARY_SCHEMA_PROTOCOL_VERSION = 2
export const RPC_BINARY_MSGPACK_PROTOCOL_VERSION = 3
export const RPC_BINARY_MAX_FRAME_BYTES = 32_000_000

export type RpcBinaryProtocolVersion =
    | typeof RPC_BINARY_PROTOCOL_VERSION
    | typeof RPC_BINARY_SCHEMA_PROTOCOL_VERSION
    | typeof RPC_BINARY_MSGPACK_PROTOCOL_VERSION

export const RpcBinaryFrame = {
    PROBE: 0,
    PROBE_ACK: 1,
    PACKET: 2,
} as const

type tRpcBinaryFrameKind = typeof RpcBinaryFrame[keyof typeof RpcBinaryFrame]

const MAX_SESSION_ID = BigInt(Number.MAX_SAFE_INTEGER)
const MAX_SESSION_VARUINT_BYTES = 8

function binaryEnvelopeError(message: string): never {
    throw new TypeError('RPC binary envelope: ' + message)
}

function wireBytes(wire: unknown) {
    if (wire instanceof ArrayBuffer) return new Uint8Array(wire)
    if (ArrayBuffer.isView(wire)) {
        return new Uint8Array(wire.buffer, wire.byteOffset, wire.byteLength)
    }
    return undefined
}

function isMagic(bytes: Uint8Array) {
    return bytes.byteLength >= RPC_BINARY_MAGIC.length
        && RPC_BINARY_MAGIC.every((expected, index) => bytes[index] == expected)
}

function writeVarUint(target: number[], value: bigint) {
    let remaining = value
    do {
        const payload = Number(remaining & 0x7fn)
        remaining >>= 7n
        target.push(remaining == 0n ? payload : payload | 0x80)
    } while (remaining != 0n)
}

function readSessionId(bytes: Uint8Array, start: number) {
    let value = 0n
    let shift = 0n
    let position = start
    for (let count = 0; count < MAX_SESSION_VARUINT_BYTES; count++) {
        if (position >= bytes.byteLength) binaryEnvelopeError('truncated session id')
        const byte = bytes[position++]
        const payload = byte & 0x7f
        value |= BigInt(payload) << shift
        if ((byte & 0x80) == 0) {
            if (count > 0 && payload == 0) binaryEnvelopeError('non-canonical session id')
            if (value <= 0n || value > MAX_SESSION_ID) binaryEnvelopeError('invalid session id')
            return {sessionId: Number(value), position}
        }
        shift += 7n
    }
    return binaryEnvelopeError('session id exceeds limit')
}

function supportedVersion(version: number): version is RpcBinaryProtocolVersion {
    return version == RPC_BINARY_PROTOCOL_VERSION
        || version == RPC_BINARY_SCHEMA_PROTOCOL_VERSION
        || version == RPC_BINARY_MSGPACK_PROTOCOL_VERSION
}

function frameHeader(
    kind: tRpcBinaryFrameKind,
    sessionId: number,
    version: RpcBinaryProtocolVersion,
) {
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        binaryEnvelopeError('invalid session id')
    }
    const bytes = [...RPC_BINARY_MAGIC, version, kind]
    writeVarUint(bytes, BigInt(sessionId))
    return Uint8Array.from(bytes)
}

export function isRpcBinaryEnvelope(wire: unknown) {
    const bytes = wireBytes(wire)
    return bytes != undefined && isMagic(bytes)
}

export function inspectRpcBinaryEnvelope(wire: unknown) {
    const bytes = wireBytes(wire)
    if (!bytes || !isMagic(bytes)) return undefined
    if (bytes.byteLength > RPC_BINARY_MAX_FRAME_BYTES) {
        throw new RangeError('RPC binary envelope: frame exceeds binary limit')
    }
    if (bytes.byteLength < RPC_BINARY_MAGIC.length + 3) {
        return binaryEnvelopeError('truncated frame')
    }
    const version = bytes[3]
    if (!supportedVersion(version)) binaryEnvelopeError('unsupported version')
    const kind = bytes[4]
    if (kind != RpcBinaryFrame.PROBE && kind != RpcBinaryFrame.PROBE_ACK
        && kind != RpcBinaryFrame.PACKET) {
        binaryEnvelopeError('unknown frame kind')
    }
    const session = readSessionId(bytes, 5)
    const payload = bytes.subarray(session.position)
    // v2 uses PROBE/PROBE_ACK payloads to exchange predeclared schema
    // definitions before any application packet. V1 control frames stay byte-identical;
    // v3 currently has no prelude.
    if (version == RPC_BINARY_PROTOCOL_VERSION
        && kind != RpcBinaryFrame.PACKET
        && payload.byteLength != 0) {
        binaryEnvelopeError('control frame has trailing bytes')
    }
    if (kind == RpcBinaryFrame.PACKET && payload.byteLength == 0) {
        binaryEnvelopeError('packet frame has no payload')
    }
    return {
        kind: kind as tRpcBinaryFrameKind,
        version,
        sessionId: session.sessionId,
        payload,
    }
}

export function encodeRpcBinaryControl(
    kind: typeof RpcBinaryFrame.PROBE | typeof RpcBinaryFrame.PROBE_ACK,
    sessionId: number,
    version: RpcBinaryProtocolVersion = RPC_BINARY_PROTOCOL_VERSION,
    payload?: Uint8Array,
) {
    const header = frameHeader(kind, sessionId, version)
    if (!payload || payload.byteLength == 0) return header
    if (version == RPC_BINARY_PROTOCOL_VERSION) {
        binaryEnvelopeError('v1 control frame cannot carry a payload')
    }
    const byteLength = header.byteLength + payload.byteLength
    if (byteLength > RPC_BINARY_MAX_FRAME_BYTES) {
        throw new RangeError('RPC binary envelope: frame exceeds binary limit')
    }
    const frame = new Uint8Array(byteLength)
    frame.set(header)
    frame.set(payload, header.byteLength)
    return frame
}

export function wrapRpcBinaryPacket(
    sessionId: number,
    payload: Uint8Array,
    version: RpcBinaryProtocolVersion = RPC_BINARY_PROTOCOL_VERSION,
) {
    const header = frameHeader(RpcBinaryFrame.PACKET, sessionId, version)
    const byteLength = header.byteLength + payload.byteLength
    if (byteLength > RPC_BINARY_MAX_FRAME_BYTES) {
        throw new RangeError('RPC binary envelope: frame exceeds binary limit')
    }
    const frame = new Uint8Array(byteLength)
    frame.set(header)
    frame.set(payload, header.byteLength)
    return frame
}
