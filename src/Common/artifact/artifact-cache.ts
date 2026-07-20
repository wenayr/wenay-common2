// =====================================================================
// Artifact byte cache: hash-addressing, fetch from source, integrity check
// =====================================================================
// The artifact catalog is replicated as a store (small and hot), while bytes —
// large, cold and immutable — arrive lazily: the cache queries the source ONLY
// on miss, verifies sha256 against descriptor.version and stores by hash. Content
// substitution in transit physically fails verification. The cache does not serve
// artifacts without content-hash version — this is the safe transfer contract.

import {ArtifactRecord} from './artifact-host'
import {artifactBytesOf, sha256Hex} from './artifact-hash'

export type tArtifactBytes = string | Uint8Array

export type ArtifactByteCacheDeps = {
    /** Fetch bytes from source (leader / route descriptor / p2p) — any transport. */
    fetch: (artifact: ArtifactRecord) => Promise<tArtifactBytes> | tArtifactBytes
    /** Cache budget in bytes; oldest by usage are evicted. */
    maxBytes?: number
    /** Eviction hook — remove copy from external structures (e.g., seeding map). */
    onEvict?: (hash: string, bytes: tArtifactBytes) => void
    /** Mockable hash (tests). Defaults to sha256Hex. */
    hash?: (bytes: tArtifactBytes) => Promise<string> | string
}

function requireContentHash(artifact: ArtifactRecord) {
    const version = artifact.descriptor.version
    if (typeof version != 'string' || version.length < 16) {
        throw new Error('artifact transfer: descriptor.version must carry the content hash')
    }
    return version
}

export function createArtifactByteCache(deps: ArtifactByteCacheDeps) {
    const {fetch, maxBytes = 64 * 1024 * 1024, onEvict, hash = sha256Hex} = deps
    // Map preserves insertion order — re-insert on hit gives cheap LRU.
    const entries = new Map<string, tArtifactBytes>()
    const inflight = new Map<string, Promise<tArtifactBytes>>()
    let totalBytes = 0
    let hits = 0
    let misses = 0

    function sizeOf(bytes: tArtifactBytes) {
        return artifactBytesOf(bytes).byteLength
    }

    function touch(key: string, bytes: tArtifactBytes) {
        entries.delete(key)
        entries.set(key, bytes)
    }

    function evictOverBudget() {
        while (totalBytes > maxBytes && entries.size > 1) {
            const oldest = entries.keys().next().value as string
            const bytes = entries.get(oldest)!
            entries.delete(oldest)
            totalBytes -= sizeOf(bytes)
            onEvict?.(oldest, bytes)
        }
    }

    async function fetchVerified(artifact: ArtifactRecord, expected: string) {
        const bytes = await fetch(artifact)
        const actual = await hash(bytes)
        if (actual != expected) {
            throw new Error(`artifact transfer: integrity check failed for ${artifact.id} (content does not match its hash)`)
        }
        entries.set(expected, bytes)
        totalBytes += sizeOf(bytes)
        evictOverBudget()
        return bytes
    }

    /** Bytes for catalog record: cache → single-flight fetch → sha256 verification. */
    async function get(artifact: ArtifactRecord) {
        const key = requireContentHash(artifact)
        const cached = entries.get(key)
        if (cached !== undefined) {
            hits++
            touch(key, cached)
            return {hash: key, bytes: cached}
        }
        misses++
        // Parallel opens of the same artifact fold into ONE trip to the source.
        let pending = inflight.get(key)
        if (!pending) {
            pending = fetchVerified(artifact, key)
            inflight.set(key, pending)
            pending.catch(function dropFailedFetch() {}).then(function clearInflight() { inflight.delete(key) })
        }
        const bytes = await pending
        return {hash: key, bytes}
    }

    return {
        get,
        has: (hashKey: string) => entries.has(hashKey),
        /** Direct read of already cached (for local seeding), no network trip. */
        peek: (hashKey: string) => entries.get(hashKey),
        stats: () => ({entries: entries.size, totalBytes, hits, misses}),
        clear() {
            entries.clear()
            inflight.clear()
            totalBytes = 0
        },
    }
}

export type ArtifactByteCache = ReturnType<typeof createArtifactByteCache>
