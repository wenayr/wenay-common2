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
    function sizeOf(bytes) {
        return (0, artifact_hash_1.artifactBytesOf)(bytes).byteLength;
    }
    function touch(key, bytes) {
        entries.delete(key);
        entries.set(key, bytes);
    }
    function evictOverBudget() {
        while (totalBytes > maxBytes && entries.size > 1) {
            const oldest = entries.keys().next().value;
            const bytes = entries.get(oldest);
            entries.delete(oldest);
            totalBytes -= sizeOf(bytes);
            onEvict?.(oldest, bytes);
        }
    }
    async function fetchVerified(artifact, expected) {
        const bytes = await fetch(artifact);
        const actual = await hash(bytes);
        if (actual != expected) {
            throw new Error(`artifact transfer: integrity check failed for ${artifact.id} (content does not match its hash)`);
        }
        entries.set(expected, bytes);
        totalBytes += sizeOf(bytes);
        evictOverBudget();
        return bytes;
    }
    async function get(artifact) {
        const key = requireContentHash(artifact);
        const cached = entries.get(key);
        if (cached !== undefined) {
            hits++;
            touch(key, cached);
            return { hash: key, bytes: cached };
        }
        misses++;
        let pending = inflight.get(key);
        if (!pending) {
            pending = fetchVerified(artifact, key);
            inflight.set(key, pending);
            pending.catch(function dropFailedFetch() { }).then(function clearInflight() { inflight.delete(key); });
        }
        const bytes = await pending;
        return { hash: key, bytes };
    }
    return {
        get,
        has: (hashKey) => entries.has(hashKey),
        peek: (hashKey) => entries.get(hashKey),
        stats: () => ({ entries: entries.size, totalBytes, hits, misses }),
        clear() {
            entries.clear();
            inflight.clear();
            totalBytes = 0;
        },
    };
}
