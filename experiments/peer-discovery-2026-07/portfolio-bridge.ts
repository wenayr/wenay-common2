import {
    PeerNeighborCandidate,
    PeerNeighborPortfolio,
} from '../../src/Common/peer/peer-neighbor-portfolio'
import {
    PeerPacketOffer,
    PeerPacketSession,
} from '../../src/Common/peer/peer-packet-mesh'
import {DiscoveryCandidate, DiscoveryQuality} from './discovery-types'

export type DiscoveryCatalogView = {
    view: {
        list: () => readonly DiscoveryCandidate[]
    }
    events: {
        changes: {
            on: (cb: (candidates: readonly DiscoveryCandidate[]) => void) => any
        }
    }
}

export type DiscoveryPortfolioBridgeDeps<T> = {
    catalog: DiscoveryCatalogView
    portfolio: PeerNeighborPortfolio<T>
    connect: (candidate: DiscoveryCandidate) => PeerPacketSession<T> | Promise<PeerPacketSession<T>>
    priority?: (candidate: DiscoveryCandidate) => number
}

function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

function defaultPriority(candidate: DiscoveryCandidate) {
    if (!candidate.endpoints.length) return Number.POSITIVE_INFINITY
    return Math.min(...candidate.endpoints.map(endpoint => endpoint.priority ?? 0))
}

export function createDiscoveryPortfolioBridge<T>(deps: DiscoveryPortfolioBridgeDeps<T>) {
    const entries = new Map<string, {
        current: DiscoveryCandidate
        connect: () => PeerPacketSession<T> | Promise<PeerPacketSession<T>>
    }>()
    const qualityOverrides = new Map<string, DiscoveryQuality>()
    let closed = false

    function update(candidates: readonly DiscoveryCandidate[]) {
        if (closed) return
        const activeIds = new Set(candidates.map(candidate => candidate.peerId))
        for (const peerId of entries.keys()) {
            if (activeIds.has(peerId)) continue
            entries.delete(peerId)
            qualityOverrides.delete(peerId)
        }
        const next: PeerNeighborCandidate<T>[] = []
        for (const candidate of candidates) {
            if (!candidate.endpoints.length) continue
            let entry = entries.get(candidate.peerId)
            if (!entry) {
                entry = {
                    current: candidate,
                    connect() {
                        return deps.connect(entry!.current)
                    },
                }
                entries.set(candidate.peerId, entry)
            }
            entry.current = candidate
            const priority = (deps.priority ?? defaultPriority)(candidate)
            if (!Number.isFinite(priority) || priority < 0) continue
            const offer: PeerPacketOffer<T> = {
                id: 'discovery:' + candidate.peerId,
                peerId: candidate.peerId,
                priority,
                connect: entry.connect,
            }
            const sourceKeys = candidate.evidence.map(item => 'source:' + item.kind)
            next.push({
                offer,
                quality: {...candidate.quality, ...qualityOverrides.get(candidate.peerId)},
                degree: candidate.degree,
                minDegree: candidate.minDegree,
                diversityKeys: Array.from(new Set([...candidate.diversityKeys, ...sourceKeys])),
                reachable: candidate.reachable,
                paths: candidate.paths,
            })
        }
        deps.portfolio.control.replace(next)
    }

    const off = deps.catalog.events.changes.on(function updateDiscoveryPortfolio(candidates) { update(candidates) })
    update(deps.catalog.view.list())

    return {
        control: {
            sample(peerId: string, quality: DiscoveryQuality) {
                if (closed || !entries.has(peerId)) return false
                qualityOverrides.set(peerId, {...qualityOverrides.get(peerId), ...quality})
                update(deps.catalog.view.list())
                return true
            },
        },
        view: {
            candidates: () => Array.from(entries.values(), entry => entry.current),
        },
        close() {
            if (closed) return
            closed = true
            unsubscribeHandle(off)
            entries.clear()
            qualityOverrides.clear()
            deps.portfolio.control.replace([])
        },
    }
}

export type DiscoveryPortfolioBridge<T> = ReturnType<typeof createDiscoveryPortfolioBridge<T>>
