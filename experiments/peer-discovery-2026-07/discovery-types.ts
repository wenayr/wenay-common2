export type tDiscoveryKind =
    'wifi-lan' | 'wifi-direct' | 'bluetooth' | 'server' | 'peer-exchange' | 'saved' | 'custom'

export type DiscoveryScalar = string | number | boolean | null

export type DiscoveryEndpoint = {
    id: string
    kind: string
    address?: string
    port?: number
    url?: string
    priority?: number
    attributes?: Record<string, DiscoveryScalar>
}

export type DiscoveryQuality = {
    rttMs?: number
    loss?: number
}

export type DiscoveryAdvertisement = {
    protocol: 1
    networkId: string
    peerId: string
    instanceId: string
    revision: number
    ttlMs: number
    endpoints: readonly DiscoveryEndpoint[]
    degree?: number
    minDegree?: number
    capacity?: number
    quality?: DiscoveryQuality
    diversityKeys?: readonly string[]
    reachable?: readonly string[]
    paths?: readonly (readonly string[])[]
}

export type DiscoveryObservation = {
    id: string
    advertisement: DiscoveryAdvertisement
    seenAt: number
    expiresAt: number
    via?: {
        address?: string
        port?: number
    }
}

export type DiscoverySourceDescriptor = {
    id: string
    kind: tDiscoveryKind
    /** Relative confidence in identity and metadata, in the inclusive range 0..1. */
    trust: number
}

export type DiscoverySource = {
    descriptor: DiscoverySourceDescriptor
    list: () => readonly DiscoveryObservation[]
    changes: {
        on: (cb: (observations: readonly DiscoveryObservation[]) => void) => any
    }
}

export type DiscoveryCandidateEndpoint = DiscoveryEndpoint & {
    sourceIds: string[]
    maxTrust: number
}

export type DiscoveryCandidateEvidence = {
    sourceId: string
    kind: tDiscoveryKind
    trust: number
    observationId: string
    instanceId: string
    seenAt: number
    expiresAt: number
}

export type DiscoveryCandidate = {
    peerId: string
    primarySourceId: string
    endpoints: DiscoveryCandidateEndpoint[]
    degree?: number
    minDegree?: number
    capacity?: number
    quality?: DiscoveryQuality
    diversityKeys: string[]
    reachable: string[]
    paths: string[][]
    evidence: DiscoveryCandidateEvidence[]
    lastSeenAt: number
    expiresAt: number
}
