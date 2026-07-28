import {
    createPeerNeighborPortfolio,
    PeerNeighborPortfolioDeps,
} from '../../src/Common/peer/peer-neighbor-portfolio'
import {
    createPeerPacketMesh,
    PeerPacketMeshDeps,
    PeerPacketRouteStatus,
    PeerPacketSession,
} from '../../src/Common/peer/peer-packet-mesh'
import {DiscoveryCandidate} from './discovery-types'
import {
    createDiscoveryPortfolioBridge,
    DiscoveryCatalogView,
} from './portfolio-bridge'

export type DiscoveredPeerPacketMeshDeps<T> = {
    nodeId: string
    meshId: string
    catalog: DiscoveryCatalogView
    connect: (candidate: DiscoveryCandidate) => PeerPacketSession<T> | Promise<PeerPacketSession<T>>
    portfolio?: Omit<PeerNeighborPortfolioDeps<T>, 'nodeId' | 'initial'>
    mesh?: Omit<PeerPacketMeshDeps<T>, 'nodeId' | 'meshId' | 'offers'>
}

function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

export function createDiscoveredPeerPacketMesh<T>(deps: DiscoveredPeerPacketMeshDeps<T>) {
    const portfolio = createPeerNeighborPortfolio<T>({
        ...deps.portfolio,
        nodeId: deps.nodeId,
    })
    const bridge = createDiscoveryPortfolioBridge<T>({
        catalog: deps.catalog,
        portfolio,
        connect: deps.connect,
    })
    const mesh = createPeerPacketMesh<T>({
        ...deps.mesh,
        nodeId: deps.nodeId,
        meshId: deps.meshId,
        offers: portfolio.offers,
    })

    function applyMeshQuality(statuses: readonly PeerPacketRouteStatus[]) {
        for (const status of statuses) {
            if (status.rtt == null) continue
            bridge.control.sample(status.peerId, {rttMs: status.rtt})
        }
    }

    const offStatus = mesh.statusChanges.on(function updateMeasuredQuality(statuses) { applyMeshQuality(statuses) })
    applyMeshQuality(mesh.status())

    return {
        mesh,
        discovery: {
            portfolio,
            bridge,
        },
        close() {
            unsubscribeHandle(offStatus)
            mesh.close()
            bridge.close()
            portfolio.close()
        },
    }
}

export type DiscoveredPeerPacketMesh<T> = ReturnType<typeof createDiscoveredPeerPacketMesh<T>>
