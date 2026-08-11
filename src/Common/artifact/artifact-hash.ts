// =====================================================================
// Content-addressing of artifacts: sha256 as version (descriptor.version)
// =====================================================================
// Artifact version = hash of its bytes: content substitution in transit between
// nodes is detected by a single check, without PKI and signatures. Works in both
// Node (>=20) and browser — via WebCrypto (globalThis.crypto.subtle).

const encoder = new TextEncoder()

export function artifactBytesOf(data: string | Uint8Array) {
    return typeof data == 'string' ? encoder.encode(data) : data
}

/** Hex sha256 of string or bytes — canonical content-hash of artifact. */
export async function sha256Hex(data: string | Uint8Array) {
    const bytes = artifactBytesOf(data)
    // WebCrypto types in Node narrow input to BufferSource from DOM-lib; Uint8Array is valid at runtime everywhere
    const digest = await (globalThis as any).crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
    let out = ''
    for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, '0')
    return out
}
