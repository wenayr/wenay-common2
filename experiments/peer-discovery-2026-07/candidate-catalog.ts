import {listen} from '../../src/Common/events/Listen'
import {
    DiscoveryCandidate,
    DiscoveryCandidateEndpoint,
    DiscoveryObservation,
    DiscoverySource,
    DiscoverySourceDescriptor,
} from './discovery-types'
import {normalizeDiscoveryObservation} from './discovery-validation'

export type DiscoveryCatalogDeps = {
    networkId: string
    nodeId: string
    maxCandidates?: number
    maxObservationsPerSource?: number
    sweepIntervalMs?: number
    now?: () => number
}

function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

function requiredId(value: unknown, label: string) {
    if (typeof value != 'string' || !value.trim()) throw new Error('discovery catalog: ' + label + ' is required')
    return value.trim()
}

function nonNegativeInteger(value: unknown, label: string) {
    if (typeof value != 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error('discovery catalog: ' + label + ' must be a non-negative integer')
    }
    return value
}

function normalizeDescriptor(value: DiscoverySourceDescriptor) {
    const trust = value.trust
    if (typeof trust != 'number' || !Number.isFinite(trust) || trust < 0 || trust > 1) {
        throw new Error('discovery catalog: source trust must be between 0 and 1')
    }
    return {id: requiredId(value.id, 'source id'), kind: value.kind, trust}
}

function endpointKey(endpoint: DiscoveryCandidateEndpoint) {
    return JSON.stringify([endpoint.kind, endpoint.id, endpoint.address, endpoint.port, endpoint.url])
}

function sameCandidate(a: DiscoveryCandidate | undefined, b: DiscoveryCandidate) {
    if (!a) return false
    const visible = (value: DiscoveryCandidate) => JSON.stringify({
        ...value,
        lastSeenAt: 0,
        expiresAt: 0,
        evidence: value.evidence.map(item => ({...item, seenAt: 0, expiresAt: 0})),
    })
    return visible(a) == visible(b)
}

export function createDiscoveryCandidateCatalog(deps: DiscoveryCatalogDeps) {
    const networkId = requiredId(deps.networkId, 'networkId')
    const nodeId = requiredId(deps.nodeId, 'nodeId')
    const maxCandidates = nonNegativeInteger(deps.maxCandidates ?? 4096, 'maxCandidates')
    const maxObservationsPerSource = nonNegativeInteger(
        deps.maxObservationsPerSource ?? 4096,
        'maxObservationsPerSource',
    )
    const sweepIntervalMs = nonNegativeInteger(deps.sweepIntervalMs ?? 1000, 'sweepIntervalMs')
    const now = deps.now ?? Date.now
    const [emitChanges, changes] = listen<[readonly DiscoveryCandidate[]]>()
    const sources = new Map<string, SourceState>()
    let candidates = new Map<string, DiscoveryCandidate>()
    let closed = false

    function createSourceState(source: DiscoverySource) {
        return {
            source,
            descriptor: normalizeDescriptor(source.descriptor),
            observations: new Map<string, DiscoveryObservation>(),
            off: null as any,
        }
    }

    type SourceState = ReturnType<typeof createSourceState>

    function evidenceSort(a: {descriptor: DiscoverySourceDescriptor, observation: DiscoveryObservation},
                          b: {descriptor: DiscoverySourceDescriptor, observation: DiscoveryObservation}) {
        return b.descriptor.trust - a.descriptor.trust ||
            b.observation.seenAt - a.observation.seenAt ||
            a.descriptor.id.localeCompare(b.descriptor.id)
    }

    function mergePeer(
        peerId: string,
        observations: Array<{descriptor: DiscoverySourceDescriptor, observation: DiscoveryObservation}>,
    ) {
        observations.sort(evidenceSort)
        const primary = observations[0]
        const endpointMap = new Map<string, DiscoveryCandidateEndpoint>()
        for (const item of observations) {
            for (const endpoint of item.observation.advertisement.endpoints) {
                const candidateEndpoint: DiscoveryCandidateEndpoint = {
                    ...endpoint,
                    attributes: endpoint.attributes ? {...endpoint.attributes} : undefined,
                    sourceIds: [item.descriptor.id],
                    maxTrust: item.descriptor.trust,
                }
                const key = endpointKey(candidateEndpoint)
                const existing = endpointMap.get(key)
                if (!existing) {
                    endpointMap.set(key, candidateEndpoint)
                    continue
                }
                if (!existing.sourceIds.includes(item.descriptor.id)) existing.sourceIds.push(item.descriptor.id)
                existing.maxTrust = Math.max(existing.maxTrust, item.descriptor.trust)
            }
        }
        const advertisement = primary.observation.advertisement
        return {
            peerId,
            primarySourceId: primary.descriptor.id,
            endpoints: Array.from(endpointMap.values()).sort(function compareEndpoints(a, b) {
                return b.maxTrust - a.maxTrust || (a.priority ?? 0) - (b.priority ?? 0) ||
                    endpointKey(a).localeCompare(endpointKey(b))
            }),
            degree: advertisement.degree,
            minDegree: advertisement.minDegree,
            capacity: advertisement.capacity,
            quality: advertisement.quality ? {...advertisement.quality} : undefined,
            diversityKeys: [...(advertisement.diversityKeys ?? [])],
            reachable: [...(advertisement.reachable ?? [])],
            paths: (advertisement.paths ?? []).map(path => [...path]),
            evidence: observations.map(item => ({
                sourceId: item.descriptor.id,
                kind: item.descriptor.kind,
                trust: item.descriptor.trust,
                observationId: item.observation.id,
                instanceId: item.observation.advertisement.instanceId,
                seenAt: item.observation.seenAt,
                expiresAt: item.observation.expiresAt,
            })),
            lastSeenAt: Math.max(...observations.map(item => item.observation.seenAt)),
            expiresAt: Math.max(...observations.map(item => item.observation.expiresAt)),
        } satisfies DiscoveryCandidate
    }

    function recompute() {
        const grouped = new Map<string, Array<{descriptor: DiscoverySourceDescriptor, observation: DiscoveryObservation}>>()
        const at = now()
        for (const state of sources.values()) {
            for (const observation of state.observations.values()) {
                const advertisement = observation.advertisement
                if (observation.expiresAt <= at || advertisement.networkId != networkId || advertisement.peerId == nodeId) continue
                const group = grouped.get(advertisement.peerId) ?? []
                group.push({descriptor: state.descriptor, observation})
                grouped.set(advertisement.peerId, group)
            }
        }
        const merged = Array.from(grouped, ([peerId, observations]) => mergePeer(peerId, observations))
        merged.sort(function retainTrustedAndFresh(a, b) {
            const aTrust = Math.max(...a.evidence.map(item => item.trust))
            const bTrust = Math.max(...b.evidence.map(item => item.trust))
            return bTrust - aTrust || b.lastSeenAt - a.lastSeenAt || a.peerId.localeCompare(b.peerId)
        })
        const next = new Map(merged.slice(0, maxCandidates).map(candidate => [candidate.peerId, candidate]))
        let changed = next.size != candidates.size
        if (!changed) {
            for (const [peerId, candidate] of next) {
                if (!sameCandidate(candidates.get(peerId), candidate)) { changed = true; break }
            }
        }
        candidates = next
        if (changed) emitChanges(Array.from(candidates.values()))
        return changed
    }

    function replaceSource(state: SourceState, observations: readonly DiscoveryObservation[]) {
        if (closed || sources.get(state.descriptor.id) != state) return
        if (observations.length > maxObservationsPerSource) {
            throw new Error('discovery catalog: source observation limit exceeded')
        }
        const next = new Map<string, DiscoveryObservation>()
        for (const value of observations) {
            const observation = normalizeDiscoveryObservation(value)
            const advertisement = observation.advertisement
            if (advertisement.networkId != networkId || advertisement.peerId == nodeId) continue
            const previous = next.get(observation.id)
            if (!previous || advertisement.revision > previous.advertisement.revision ||
                advertisement.revision == previous.advertisement.revision && observation.seenAt > previous.seenAt) {
                next.set(observation.id, observation)
            }
        }
        state.observations = next
        recompute()
    }

    function detachState(state: SourceState) {
        if (sources.get(state.descriptor.id) != state) return false
        sources.delete(state.descriptor.id)
        unsubscribeHandle(state.off)
        state.off = null
        recompute()
        return true
    }

    function attach(source: DiscoverySource) {
        if (closed) throw new Error('discovery catalog: closed')
        const state = createSourceState(source)
        const previous = sources.get(state.descriptor.id)
        if (previous) detachState(previous)
        sources.set(state.descriptor.id, state)
        state.off = source.changes.on(function replaceDiscoverySource(next) { replaceSource(state, next) })
        replaceSource(state, source.list())
        return function detachThisDiscoverySource() { detachState(state) }
    }

    function sweep(at = now()) {
        let removed = false
        for (const state of sources.values()) {
            for (const [id, observation] of state.observations) {
                if (observation.expiresAt > at) continue
                state.observations.delete(id)
                removed = true
            }
        }
        if (removed) recompute()
        return removed
    }

    const sweepTimer = sweepIntervalMs > 0 ? setInterval(function sweepDiscoveryCatalog() { sweep() }, sweepIntervalMs) : null
    ;(sweepTimer as any)?.unref?.()

    return {
        control: {
            attach,
            detach(sourceId: string) {
                const state = sources.get(sourceId)
                return state ? detachState(state) : false
            },
            sweep,
        },
        view: {
            list: () => Array.from(candidates.values()),
            get: (peerId: string) => candidates.get(peerId),
            sources: () => Array.from(sources.values(), state => ({
                ...state.descriptor,
                observations: state.observations.size,
            })),
        },
        events: {changes},
        close() {
            if (closed) return
            closed = true
            if (sweepTimer) clearInterval(sweepTimer)
            for (const state of sources.values()) unsubscribeHandle(state.off)
            sources.clear()
            candidates.clear()
            changes.close()
        },
    }
}

export type DiscoveryCandidateCatalog = ReturnType<typeof createDiscoveryCandidateCatalog>
