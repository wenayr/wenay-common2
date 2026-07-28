import {
    DiscoveryAdvertisement,
    DiscoveryEndpoint,
    DiscoveryObservation,
    DiscoveryQuality,
    DiscoveryScalar,
} from './discovery-types'

const MAX_ENDPOINTS = 32
const MAX_ATTRIBUTES = 32
const MAX_DIVERSITY_KEYS = 128
const MAX_REACHABLE = 4096
const MAX_PATHS = 128
const MAX_PATH_LENGTH = 32
const MAX_TTL_MS = 24 * 60 * 60 * 1000

function requiredString(value: unknown, label: string, max = 256) {
    if (typeof value != 'string' || !value.trim() || value.length > max) {
        throw new Error('discovery: ' + label + ' must be a non-empty string up to ' + max + ' characters')
    }
    return value.trim()
}

function finiteNonNegative(value: unknown, label: string) {
    if (typeof value != 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error('discovery: ' + label + ' must be a non-negative finite number')
    }
    return value
}

function nonNegativeInteger(value: unknown, label: string) {
    finiteNonNegative(value, label)
    if (!Number.isInteger(value)) throw new Error('discovery: ' + label + ' must be an integer')
    return value as number
}

function optionalInteger(value: unknown, label: string) {
    return value == undefined ? undefined : nonNegativeInteger(value, label)
}

function stringArray(value: unknown, label: string, max: number) {
    if (value == undefined) return []
    if (!Array.isArray(value) || value.length > max) throw new Error('discovery: invalid ' + label)
    return Array.from(new Set(value.map(item => requiredString(item, label + ' item'))))
}

function normalizeQuality(value: unknown): DiscoveryQuality | undefined {
    if (value == undefined) return undefined
    if (!value || typeof value != 'object') throw new Error('discovery: invalid quality')
    const quality = value as DiscoveryQuality
    const rttMs = quality.rttMs == undefined ? undefined : finiteNonNegative(quality.rttMs, 'quality.rttMs')
    const loss = quality.loss
    if (loss != undefined && (typeof loss != 'number' || !Number.isFinite(loss) || loss < 0 || loss > 1)) {
        throw new Error('discovery: quality.loss must be between 0 and 1')
    }
    return {rttMs, loss}
}

function normalizeAttributes(value: unknown) {
    if (value == undefined) return undefined
    if (!value || typeof value != 'object' || Array.isArray(value)) {
        throw new Error('discovery: endpoint.attributes must be an object')
    }
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > MAX_ATTRIBUTES) throw new Error('discovery: too many endpoint attributes')
    const out: Record<string, DiscoveryScalar> = Object.create(null)
    for (const [key, item] of entries) {
        const storedKey = requiredString(key, 'endpoint attribute key', 128)
        if (item != null && typeof item != 'string' && typeof item != 'number' && typeof item != 'boolean') {
            throw new Error('discovery: endpoint attributes must be scalar')
        }
        if (typeof item == 'number' && !Number.isFinite(item)) {
            throw new Error('discovery: endpoint numeric attributes must be finite')
        }
        out[storedKey] = item as DiscoveryScalar
    }
    return out
}

function normalizeEndpoint(value: unknown): DiscoveryEndpoint {
    if (!value || typeof value != 'object') throw new Error('discovery: invalid endpoint')
    const endpoint = value as DiscoveryEndpoint
    const port = endpoint.port == undefined ? undefined : nonNegativeInteger(endpoint.port, 'endpoint.port')
    if (port != undefined && (port < 1 || port > 65535)) throw new Error('discovery: endpoint.port is out of range')
    return {
        id: requiredString(endpoint.id, 'endpoint.id'),
        kind: requiredString(endpoint.kind, 'endpoint.kind'),
        address: endpoint.address == undefined ? undefined : requiredString(endpoint.address, 'endpoint.address', 2048),
        port,
        url: endpoint.url == undefined ? undefined : requiredString(endpoint.url, 'endpoint.url', 4096),
        priority: endpoint.priority == undefined
            ? undefined
            : finiteNonNegative(endpoint.priority, 'endpoint.priority'),
        attributes: normalizeAttributes(endpoint.attributes),
    }
}

export function normalizeDiscoveryAdvertisement(value: unknown): DiscoveryAdvertisement {
    if (!value || typeof value != 'object') throw new Error('discovery: invalid advertisement')
    const advertisement = value as DiscoveryAdvertisement
    if (advertisement.protocol != 1) throw new Error('discovery: unsupported protocol')
    if (!Array.isArray(advertisement.endpoints) || advertisement.endpoints.length > MAX_ENDPOINTS) {
        throw new Error('discovery: invalid endpoints')
    }
    const ttlMs = finiteNonNegative(advertisement.ttlMs, 'ttlMs')
    if (!ttlMs || ttlMs > MAX_TTL_MS) throw new Error('discovery: ttlMs is out of range')
    const pathsValue = advertisement.paths ?? []
    if (!Array.isArray(pathsValue) || pathsValue.length > MAX_PATHS) throw new Error('discovery: invalid paths')
    const paths = pathsValue.map(function normalizePath(path) {
        return stringArray(path, 'path', MAX_PATH_LENGTH)
    })
    return {
        protocol: 1,
        networkId: requiredString(advertisement.networkId, 'networkId'),
        peerId: requiredString(advertisement.peerId, 'peerId'),
        instanceId: requiredString(advertisement.instanceId, 'instanceId'),
        revision: nonNegativeInteger(advertisement.revision, 'revision'),
        ttlMs,
        endpoints: advertisement.endpoints.map(normalizeEndpoint),
        degree: optionalInteger(advertisement.degree, 'degree'),
        minDegree: optionalInteger(advertisement.minDegree, 'minDegree'),
        capacity: optionalInteger(advertisement.capacity, 'capacity'),
        quality: normalizeQuality(advertisement.quality),
        diversityKeys: stringArray(advertisement.diversityKeys, 'diversityKeys', MAX_DIVERSITY_KEYS),
        reachable: stringArray(advertisement.reachable, 'reachable', MAX_REACHABLE),
        paths,
    }
}

export function normalizeDiscoveryObservation(value: DiscoveryObservation) {
    const advertisement = normalizeDiscoveryAdvertisement(value.advertisement)
    const seenAt = finiteNonNegative(value.seenAt, 'observation.seenAt')
    const expiresAt = finiteNonNegative(value.expiresAt, 'observation.expiresAt')
    return {
        id: JSON.stringify([advertisement.peerId, advertisement.instanceId]),
        advertisement,
        seenAt,
        expiresAt: Math.min(expiresAt, seenAt + advertisement.ttlMs),
        via: value.via ? {
            address: value.via.address == undefined
                ? undefined
                : requiredString(value.via.address, 'observation.via.address', 2048),
            port: value.via.port == undefined ? undefined : nonNegativeInteger(value.via.port, 'observation.via.port'),
        } : undefined,
    }
}
