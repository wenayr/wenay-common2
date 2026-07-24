const utf8Encoder = new TextEncoder()

/** Exact UTF-8 byte count for an already serialized wire string. */
export function utf8ByteLength(value: string) {
    return utf8Encoder.encode(value).byteLength
}

/** Exact UTF-8 byte count of JSON, or Infinity when the value is not JSON-serializable. */
export function jsonUtf8ByteLength(value: unknown) {
    try {
        const encoded = JSON.stringify(value)
        return encoded == undefined ? Number.POSITIVE_INFINITY : utf8ByteLength(encoded)
    } catch {
        return Number.POSITIVE_INFINITY
    }
}
