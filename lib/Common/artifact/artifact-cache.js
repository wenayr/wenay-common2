"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createArtifactByteCache = createArtifactByteCache;
const artifact_hash_1 = require("./artifact-hash");
function requireContentHash(artifact) {
    const version = artifact.descriptor.version;
    if (typeof version != 'string' || version.length < 16) {
        throw new Error('artifact transfer: descriptor.version must carry the content hash');
    }
    return version;
}
function createArtifactByteCache(deps) {
    const { fetch, maxBytes = 64 * 1024 * 1024, onEvict, hash = artifact_hash_1.sha256Hex } = deps;
    const entries = new Map();
    const inflight = new Map();
    let totalBytes = 0;
    let hits = 0;
    let misses = 0;
    let generation = 0;
    function sizeOf(bytes) {
        return (0, artifact_hash_1.artifactBytesOf)(bytes).byteLength;
    }
    function ownBytes(bytes) {
        if (typeof bytes == 'string')
            return bytes;
        const owned = new Uint8Array(bytes.byteLength);
        owned.set(bytes);
        return owned;
    }
    function touch(key, entry) {
        entries.delete(key);
        entries.set(key, entry);
    }
    function evictOverBudget() {
        while (totalBytes > maxBytes && entries.size > 1) {
            const oldest = entries.keys().next().value;
            const entry = entries.get(oldest);
            entries.delete(oldest);
            totalBytes -= entry.size;
            onEvict?.(oldest, entry.bytes);
        }
    }
    async function fetchVerified(artifact, expected, fetchGeneration) {
        const bytes = ownBytes(await fetch(artifact));
        const actual = await hash(bytes);
        if (actual != expected) {
            throw new Error(`artifact transfer: integrity check failed for ${artifact.id} (content does not match its hash)`);
        }
        if (fetchGeneration != generation)
            return bytes;
        const size = sizeOf(bytes);
        entries.set(expected, { bytes, size });
        totalBytes += size;
        evictOverBudget();
        return bytes;
    }
    async function get(artifact) {
        const key = requireContentHash(artifact);
        const cached = entries.get(key);
        if (cached !== undefined) {
            hits++;
            touch(key, cached);
            return { hash: key, bytes: ownBytes(cached.bytes) };
        }
        misses++;
        let pending = inflight.get(key);
        if (!pending) {
            pending = fetchVerified(artifact, key, generation);
            inflight.set(key, pending);
            const ownedPending = pending;
            pending.catch(function dropFailedFetch() { }).then(function clearInflight() {
                if (inflight.get(key) == ownedPending)
                    inflight.delete(key);
            });
        }
        const bytes = await pending;
        return { hash: key, bytes: ownBytes(bytes) };
    }
    return {
        get,
        has: (hashKey) => entries.has(hashKey),
        peek: (hashKey) => {
            const entry = entries.get(hashKey);
            return entry == undefined ? undefined : ownBytes(entry.bytes);
        },
        stats: () => ({ entries: entries.size, totalBytes, hits, misses }),
        clear() {
            generation++;
            entries.clear();
            inflight.clear();
            totalBytes = 0;
        },
    };
}
