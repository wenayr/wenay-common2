const utf8Encoder = new TextEncoder()

// `encode()` allocates a Uint8Array the size of the whole message to answer one number, and
// this runs per packet on the batching path. Node counts the same bytes without allocating;
// the browser keeps the encoder, where the allocation is short-lived and the alternative is
// a hand-rolled surrogate-aware loop that would have to match TextEncoder exactly.
//
// Reached through globalThis and typed structurally on purpose: this module is part of the
// CLIENT surface, and naming the Buffer global would demand @types/node from every consumer
// that compiles for the browser — oracle/regression/clientapiall-replay-types.spec.ts checks
// exactly that. The method is called on its own object so it keeps its receiver.
const nodeBuffer = (globalThis as {Buffer?: {byteLength?: (value: string, encoding: string) => number}}).Buffer
const nodeByteLength = typeof nodeBuffer?.byteLength == 'function' ? nodeBuffer : null

/** Exact UTF-8 byte count for an already serialized wire string. */
export function utf8ByteLength(value: string) {
    return nodeByteLength ? nodeByteLength.byteLength!(value, 'utf8') : utf8Encoder.encode(value).byteLength
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
