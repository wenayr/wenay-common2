// =====================================================================
// RPC result wire sizing — rich-value packing + binary attachments
// =====================================================================

import {jsonUtf8ByteLength} from '../wire-size'
import {packResult} from './rpc-walk'

function binaryByteLength(value: unknown) {
    if (ArrayBuffer.isView(value)) return value.byteLength
    if (value instanceof ArrayBuffer) return value.byteLength
    return null
}

/**
 * Size target for the representation RPC actually gives Socket.IO. Rich values
 * are packed first; binary payload bytes are counted beside their JSON placeholders.
 */
export function rpcResultWireMetrics(value: unknown, firstBinaryIndex = 0) {
    let binaryBytes = 0
    let binaryIndex = firstBinaryIndex

    function replaceBinary(next: any): any {
        const bytes = binaryByteLength(next)
        if (bytes != null) {
            binaryBytes += bytes
            return {_placeholder: true, num: binaryIndex++}
        }
        if (next == null || typeof next != 'object') return next
        if (Array.isArray(next)) return next.map(replaceBinary)
        const out: Record<string, unknown> = {}
        for (const key of Object.keys(next)) out[key] = replaceBinary(next[key])
        return out
    }

    const jsonBytes = jsonUtf8ByteLength(replaceBinary(packResult(value)))
    return {
        byteLength: Number.isFinite(jsonBytes) ? jsonBytes + binaryBytes : jsonBytes,
        binaryCount: binaryIndex - firstBinaryIndex,
    }
}

export function rpcResultWireByteLength(value: unknown) {
    return rpcResultWireMetrics(value).byteLength
}
