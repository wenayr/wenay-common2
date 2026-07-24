// =====================================================================
// Store Replay binary value codec — stable v5 wrapper
// =====================================================================

import {resolveLimits, type RpcLimits} from '../rcp/rpc-limits'
import {createBinaryValueCodec} from '../rcp/rpc-binary-value'

const STORE_REPLAY_BINARY_MAGIC = [0x53, 0x52, 0x42] as const
const STORE_REPLAY_BINARY_VERSION = 5
const STORE_REPLAY_BINARY_MAX_VALUE_BYTES = 8_000_000

// A full envelope needs room around one maximum-sized binary business value.
export const STORE_REPLAY_BINARY_MAX_WIRE_BYTES = 16_000_000

const codec = createBinaryValueCodec({
    magic: STORE_REPLAY_BINARY_MAGIC,
    version: STORE_REPLAY_BINARY_VERSION,
    label: 'store replay binary',
    maxBinaryBytes: STORE_REPLAY_BINARY_MAX_VALUE_BYTES,
    maxWireBytes: STORE_REPLAY_BINARY_MAX_WIRE_BYTES,
})

export function encodeStoreReplayBinary(value: unknown) {
    return codec.encode(value)
}

export function decodeStoreReplayBinary(wire: unknown, requestedLimits?: RpcLimits) {
    // Preserve the v5 rule: once caller limits are supplied, maxBinaryLen also
    // constrains the complete attachment accepted from RPC.
    const maxWireBytes = requestedLimits
        ? resolveLimits(requestedLimits).maxBinaryLen
        : STORE_REPLAY_BINARY_MAX_WIRE_BYTES
    return codec.decodeTrusted(wire, requestedLimits, {maxWireBytes})
}
