// =====================================================================
// Байт-кэш артефактов: hash-адресация, fetch у источника, проверка целостности
// =====================================================================
// Каталог артефактов реплицируется как store (мелкое и горячее), а байты —
// крупное, холодное и immutable — едут лениво: кэш спрашивает источник ТОЛЬКО
// на промахе, сверяет sha256 с descriptor.version и хранит по hash. Подмена
// содержимого по дороге физически не проходит проверку. Артефакты без
// content-hash версии кэш не обслуживает — это контракт безопасной передачи.

import {ArtifactRecord} from './artifact-host'
import {artifactBytesOf, sha256Hex} from './artifact-hash'

export type tArtifactBytes = string | Uint8Array

export type ArtifactByteCacheDeps = {
    /** Достать байты у источника (лидер / дескриптор маршрута / p2p) — любой транспорт. */
    fetch: (artifact: ArtifactRecord) => Promise<tArtifactBytes> | tArtifactBytes
    /** Бюджет кэша в байтах; старейшие по использованию вытесняются. */
    maxBytes?: number
    /** Хук вытеснения — снять копию из внешних структур (например, карты раздачи). */
    onEvict?: (hash: string, bytes: tArtifactBytes) => void
    /** Подменяемый hash (тесты). По умолчанию sha256Hex. */
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
    // Map сохраняет порядок вставки — re-insert на попадании даёт дешёвый LRU.
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

    /** Байты по записи каталога: кэш → single-flight fetch → sha256-проверка. */
    async function get(artifact: ArtifactRecord) {
        const key = requireContentHash(artifact)
        const cached = entries.get(key)
        if (cached !== undefined) {
            hits++
            touch(key, cached)
            return {hash: key, bytes: cached}
        }
        misses++
        // Параллельные open одного артефакта складываются в ОДИН поход к источнику.
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
        /** Прямое чтение уже закэшированного (для локальной раздачи), без похода в сеть. */
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
