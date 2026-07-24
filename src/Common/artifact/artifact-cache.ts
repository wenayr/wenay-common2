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
    const entries = new Map<string, {bytes: tArtifactBytes, size: number}>()
    const inflight = new Map<string, Promise<tArtifactBytes>>()
    let totalBytes = 0
    let hits = 0
    let misses = 0
    let generation = 0

    function sizeOf(bytes: tArtifactBytes) {
        return artifactBytesOf(bytes).byteLength
    }

    function ownBytes(bytes: tArtifactBytes) {
        if (typeof bytes == 'string') return bytes
        const owned = new Uint8Array(bytes.byteLength)
        owned.set(bytes)
        return owned
    }

    function touch(key: string, entry: {bytes: tArtifactBytes, size: number}) {
        entries.delete(key)
        entries.set(key, entry)
    }

    function evictOverBudget() {
        while (totalBytes > maxBytes && entries.size > 1) {
            const oldest = entries.keys().next().value as string
            const entry = entries.get(oldest)!
            entries.delete(oldest)
            totalBytes -= entry.size
            onEvict?.(oldest, entry.bytes)
        }
    }

    async function fetchVerified(artifact: ArtifactRecord, expected: string, fetchGeneration: number) {
        // Own the immutable verified copy; provider mutations cannot alter it later.
        const bytes = ownBytes(await fetch(artifact))
        const actual = await hash(bytes)
        if (actual != expected) {
            throw new Error(`artifact transfer: integrity check failed for ${artifact.id} (content does not match its hash)`)
        }
        if (fetchGeneration != generation) return bytes
        const size = sizeOf(bytes)
        entries.set(expected, {bytes, size})
        totalBytes += size
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
            return {hash: key, bytes: ownBytes(cached.bytes)}
        }
        misses++
        // Parallel opens of the same artifact fold into ONE trip to the source.
        let pending = inflight.get(key)
        if (!pending) {
            pending = fetchVerified(artifact, key, generation)
            inflight.set(key, pending)
            const ownedPending = pending
            pending.catch(function dropFailedFetch() {}).then(function clearInflight() {
                if (inflight.get(key) == ownedPending) inflight.delete(key)
            })
        }
        const bytes = await pending
        return {hash: key, bytes: ownBytes(bytes)}
    }

    return {
        get,
        has: (hashKey: string) => entries.has(hashKey),
        /** Direct read of already cached (for local seeding), no network trip. */
        peek: (hashKey: string) => {
            const entry = entries.get(hashKey)
            return entry == undefined ? undefined : ownBytes(entry.bytes)
        },
        stats: () => ({entries: entries.size, totalBytes, hits, misses}),
        clear() {
            generation++
            entries.clear()
            inflight.clear()
            totalBytes = 0
        },
    }
}

export type ArtifactByteCache = ReturnType<typeof createArtifactByteCache>
