import {listen} from '../src/Common/events/Listen'
import {
    createPeerPacketMesh,
    createPeerPacketOffers,
    PeerPacketOffer,
    PeerPacketWire,
} from '../src/Common/peer/peer-index'

type tElement = (id: string) => HTMLElement
type Packet = {type: 'package' | 'group', name: string, bytes: number}
type Offers = ReturnType<typeof createPeerPacketOffers<Packet>>

type PacketMeshDemoDeps = {
    element: tElement
    log: (line: string) => void
}

const NODES = {
    client: 'Client',
    'edge-a': 'Edge A',
    'edge-b': 'Edge B',
    server: 'Server',
} as const

function createDemoLink(from: keyof typeof NODES, to: keyof typeof NODES, cost: number, offers: Record<keyof typeof NODES, Offers>) {
    const [emitFrom, messagesFrom] = listen<[PeerPacketWire<Packet>]>()
    const [emitTo, messagesTo] = listen<[PeerPacketWire<Packet>]>()
    let active = false
    let removeFrom: (() => void) | null = null
    let removeTo: (() => void) | null = null

    function offer(self: keyof typeof NODES, peer: keyof typeof NODES, messages: typeof messagesFrom, emitPeer: typeof emitFrom): PeerPacketOffer<Packet> {
        return {
            id: self + '->' + peer,
            peerId: peer,
            priority: cost,
            connect() {
                return {
                    peerId: peer,
                    messages,
                    send(message) {
                        if (!active) return false
                        setTimeout(function deliverMeshMessage() { if (active) emitPeer(message) }, 0)
                        return true
                    },
                    close() {},
                }
            },
        }
    }

    function install() {
        if (active) return
        active = true
        removeFrom = offers[from].control.upsert(offer(from, to, messagesFrom, emitTo))
        removeTo = offers[to].control.upsert(offer(to, from, messagesTo, emitFrom))
    }

    function cut() {
        if (!active) return
        active = false
        removeFrom?.()
        removeTo?.()
        removeFrom = null
        removeTo = null
    }

    return {from, to, cost, active: () => active, install, cut}
}

export function setupPacketMeshDemo(deps: PacketMeshDemoDeps) {
    const {element, log} = deps
    const offers = Object.fromEntries(Object.keys(NODES).map(id => [id, createPeerPacketOffers<Packet>()])) as Record<keyof typeof NODES, Offers>
    const links = [
        createDemoLink('client', 'edge-a', 7, offers),
        createDemoLink('edge-a', 'edge-b', 9, offers),
        createDemoLink('edge-b', 'server', 11, offers),
        createDemoLink('client', 'edge-b', 40, offers),
        createDemoLink('client', 'server', 65, offers),
    ]
    for (const link of links) link.install()

    const meshes = Object.fromEntries(Object.keys(NODES).map(id => [id, createPeerPacketMesh<Packet>({
        meshId: 'package-network',
        nodeId: id,
        offers: offers[id as keyof typeof NODES].api,
        reconnectMs: 100,
        probeIntervalMs: 0,
    })])) as Record<keyof typeof NODES, ReturnType<typeof createPeerPacketMesh<Packet>>>
    const summary = element('packetMeshSummary')
    const routeView = element('packetMeshRoute')
    const nodeView = element('packetMeshNodes')
    const events = element('packetMeshEvents')
    const send = element('packetMeshSend') as HTMLButtonElement
    const group = element('packetMeshGroup') as HTMLButtonElement
    const breakBest = element('packetMeshBreak') as HTMLButtonElement
    const primaryLink = links.find(link => link.from == 'edge-a' && link.to == 'edge-b')!
    let packetNumber = 0

    function label(id: string) {
        return NODES[id as keyof typeof NODES] ?? id
    }

    function writeEvent(text: string) {
        const row = document.createElement('div')
        row.textContent = `${new Date().toLocaleTimeString()} · ${text}`
        events.prepend(row)
        while (events.children.length > 8) events.lastChild?.remove()
    }

    function render() {
        const route = meshes.client.routes().find(item => item.targetId == 'server')
        summary.textContent = route
            ? `live · selected ${route.path.map(label).join(' → ')} · cost ${route.cost}`
            : 'no route to Server'
        summary.dataset.state = route ? 'live' : 'offline'
        routeView.replaceChildren()
        const selectedPath = new Set(route?.path ?? [])
        for (const link of links) {
            const chip = document.createElement('span')
            const selected = route?.path.some((id, index) => id == link.from && route.path[index + 1] == link.to) ||
                route?.path.some((id, index) => id == link.to && route.path[index + 1] == link.from)
            chip.className = 'packetMeshLink' + (selected ? ' selected' : '') + (!link.active() ? ' offline' : '')
            chip.textContent = `${label(link.from)} ⇄ ${label(link.to)} · ${link.cost}`
            routeView.append(chip)
        }
        nodeView.replaceChildren()
        for (const [id, name] of Object.entries(NODES)) {
            const card = document.createElement('article')
            card.className = 'packetMeshNode' + (selectedPath.has(id) ? ' selected' : '')
            const node = meshes[id as keyof typeof NODES]
            const best = node.routes().find(item => item.targetId == 'server')
            const stats = node.stats()
            const title = document.createElement('strong')
            title.textContent = name
            const state = document.createElement('span')
            state.textContent = id == 'server' ? 'destination' : best ? `next ${label(best.nextHopId)}` : 'no route'
            const detail = document.createElement('p')
            detail.textContent = id == 'server' ? `${stats.delivered} packet(s) received`
                : best ? `${best.path.map(label).join(' → ')} · cost ${best.cost}` : 'waiting for offers'
            card.append(title, state, detail)
            nodeView.append(card)
        }
        breakBest.textContent = primaryLink.active() ? 'Break Edge A ⇄ Edge B' : 'Restore Edge A ⇄ Edge B'
        breakBest.classList.toggle('danger', primaryLink.active())
        breakBest.classList.toggle('secondary', !primaryLink.active())
    }

    for (const [id, mesh] of Object.entries(meshes)) {
        mesh.routeChanges.on(render)
        mesh.statusChanges.on(render)
        mesh.packets.on(function receiveDemoPacket(packet, meta) {
            writeEvent(`${label(id)} received ${packet.name} via ${meta.path.map(label).join(' → ')}`)
            render()
        })
    }

    send.addEventListener('click', async function sendPackagePacket() {
        const name = 'package-' + (++packetNumber)
        const result = await meshes.client.send('server', {type: 'package', name, bytes: 64 * 1024})
        writeEvent(result.ok
            ? `Client sent ${name}; first hop ${label(result.nextHopId!)}`
            : `Client could not send ${name}: ${result.reason}`)
        log(`packet mesh: ${name} ${result.ok ? 'accepted by ' + label(result.nextHopId!) : result.reason}`)
        render()
    })

    group.addEventListener('click', async function sendGroupPacket() {
        const name = 'group-' + (++packetNumber)
        const result = await meshes.client.broadcast(['edge-a', 'edge-b', 'server'], {type: 'group', name, bytes: 4096})
        writeEvent(`Client sent ${name} to 3 peers · ${result.filter(item => item.ok).length}/3 routed`)
        render()
    })

    breakBest.addEventListener('click', function toggleBestLink() {
        if (primaryLink.active()) {
            primaryLink.cut()
            writeEvent('Edge A ⇄ Edge B capability disappeared; routes are reconciling')
        } else {
            primaryLink.install()
            writeEvent('Edge A ⇄ Edge B capability returned; shortest route is reconciling')
        }
        render()
    })

    render()
    return {
        close() {
            for (const mesh of Object.values(meshes)) mesh.close()
            for (const link of links) link.cut()
            for (const registry of Object.values(offers)) registry.control.clear()
        },
    }
}
