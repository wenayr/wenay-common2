// =====================================================================
// RPC result wire sizing — rich-value packing + binary attachments
// =====================================================================

import {jsonUtf8ByteLength} from '../wire-size'
import {isSafeKey} from './rpc-limits'
import {packResult, RESERVED_MARKER_KEYS} from './rpc-walk'

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

const plainWireFallback = Symbol('plainWireFallback')
const simpleJsonAscii = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/

function jsonStringWireBytes(value: string) {
    if (simpleJsonAscii.test(value)) return value.length + 2
    let bytes = 2
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        if (code == 0x22 || code == 0x5c
            || code == 0x08 || code == 0x09 || code == 0x0a || code == 0x0c || code == 0x0d) {
            bytes += 2
        } else if (code < 0x20) {
            bytes += 6
        } else if (code < 0x80) {
            bytes++
        } else if (code < 0x800) {
            bytes += 2
        } else if (code >= 0xd800 && code <= 0xdbff) {
            const low = value.charCodeAt(index + 1)
            if (low >= 0xdc00 && low <= 0xdfff) {
                bytes += 4
                index++
            } else {
                bytes += 6
            }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            bytes += 6
        } else {
            bytes += 3
        }
    }
    return bytes
}

function jsonNumberWireBytes(value: number) {
    if (!Number.isFinite(value)) return 4
    if (Object.is(value, -0)) return 1
    return String(value).length
}

function jsonOmitsValue(value: unknown) {
    const type = typeof value
    return value === undefined || type == 'function' || type == 'symbol'
}

type PlainWireCounter = {
    binaryBytes: number
    binaryIndex: number
    ancestors: WeakSet<object>
}

/**
 * Exact no-materialization counter for ordinary JSON + binary leaves. Rich,
 * reserved-marker and custom-toJSON values fall back to the canonical packer.
 */
function plainJsonWireBytes(value: unknown, counter: PlainWireCounter): number | typeof plainWireFallback {
    if (value === null) return 4
    if (typeof value == 'string') return jsonStringWireBytes(value)
    if (typeof value == 'number') return jsonNumberWireBytes(value)
    if (typeof value == 'boolean') return value ? 4 : 5
    if (jsonOmitsValue(value)) return plainWireFallback
    if (typeof value != 'object' || typeof value == 'bigint') return plainWireFallback

    const binaryBytes = binaryByteLength(value)
    if (binaryBytes != null) {
        const indexBytes = String(counter.binaryIndex++).length
        counter.binaryBytes += binaryBytes
        return 28 + indexBytes
    }

    if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof RegExp) {
        return plainWireFallback
    }
    if (counter.ancestors.has(value)) return plainWireFallback
    counter.ancestors.add(value)
    try {
        if (Array.isArray(value)) {
            let bytes = 2
            for (let index = 0; index < value.length; index++) {
                if (index) bytes++
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
                if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                    return plainWireFallback
                }
                const item = descriptor?.value
                if (jsonOmitsValue(item)) {
                    bytes += 4
                    continue
                }
                const itemBytes = plainJsonWireBytes(item, counter)
                if (itemBytes === plainWireFallback) return plainWireFallback
                bytes += itemBytes
            }
            return bytes
        }

        const keys = Object.keys(value)
        if (keys.length == 1 && RESERVED_MARKER_KEYS.has(keys[0])) return plainWireFallback
        let bytes = 2
        let emitted = 0
        for (const key of keys) {
            if (!isSafeKey(key)) continue
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                return plainWireFallback
            }
            const item = descriptor.value
            if (key == 'toJSON' && typeof item == 'function') return plainWireFallback
            if (jsonOmitsValue(item)) continue
            const itemBytes = plainJsonWireBytes(item, counter)
            if (itemBytes === plainWireFallback) return plainWireFallback
            if (emitted++) bytes++
            bytes += jsonStringWireBytes(key) + 1 + itemBytes
        }
        return bytes
    } finally {
        counter.ancestors.delete(value)
    }
}

/**
 * Same result as rpcResultWireMetrics. Plain Store payloads avoid allocating a
 * packed mirror, a JSON string and a UTF-8 buffer merely to choose a batch.
 */
export function rpcResultWireMetricsFast(value: unknown, firstBinaryIndex = 0) {
    if (!Number.isSafeInteger(firstBinaryIndex) || firstBinaryIndex < 0) {
        return rpcResultWireMetrics(value, firstBinaryIndex)
    }
    const counter: PlainWireCounter = {
        binaryBytes: 0,
        binaryIndex: firstBinaryIndex,
        ancestors: new WeakSet(),
    }
    const jsonBytes = plainJsonWireBytes(value, counter)
    if (jsonBytes === plainWireFallback) return rpcResultWireMetrics(value, firstBinaryIndex)
    return {
        byteLength: jsonBytes + counter.binaryBytes,
        binaryCount: counter.binaryIndex - firstBinaryIndex,
    }
}

export function rpcResultWireByteLength(value: unknown) {
    return rpcResultWireMetrics(value).byteLength
}
