import {listen} from '../src/Common/events/Listen'
import {
    createPeerPacketMesh,
    createPeerPacketOffers,
    PeerPacketOffer,
    PeerPacketRoute,
    PeerPacketRouteStatus,
    PeerPacketWire,
} from '../src/Common/peer/peer-index'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function waitFor(label: string, condition: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (condition()) return
        await delay(5)
    }
    throw new Error('timeout: ' + label)
}

type Payload = {value: string}

async function main() {
    console.log('\n[peer-packet-mesh-bulk] one discovery replacement, one visible mesh round')

    const registry = createPeerPacketOffers<Payload>()
    const routePackets = new Map<string, number>()
    const closes = new Map<string, number>()

    function offer(id: string): PeerPacketOffer<Payload> {
        const [, messages] = listen<[PeerPacketWire<Payload>]>()
        return {
            id,
            peerId: 'peer-' + id,
            connect() {
                return {
                    peerId: 'peer-' + id,
                    messages,
                    send(message) {
                        if (message.kind == 'routes') routePackets.set(id, (routePackets.get(id) ?? 0) + 1)
                        return true
                    },
                    close() { closes.set(id, (closes.get(id) ?? 0) + 1) },
                }
            },
        }
    }

    const offers = ['a', 'b', 'c', 'd'].map(offer)
    registry.control.replace(offers)
    const mesh = createPeerPacketMesh<Payload>({
        meshId: 'bulk', nodeId: 'local', offers: registry.api,
        reconnectMs: 0, probeIntervalMs: 0,
    })
    await waitFor('all routes open', () => mesh.status().every(status => status.state == 'open') && mesh.status().length == 4)
    await delay(0)
    routePackets.clear()

    const statusEvents: Array<readonly PeerPacketRouteStatus[]> = []
    const routeEvents: Array<readonly PeerPacketRoute[]> = []
    mesh.statusChanges.on(status => statusEvents.push(status))
    mesh.routeChanges.on(routes => routeEvents.push(routes))

    registry.control.replace([offers[0]])

    ok(statusEvents.length == 1 && statusEvents[0].length == 1 && statusEvents[0][0].id == 'a',
        'removing three offers publishes one final status snapshot')
    ok(routeEvents.length == 1 && routeEvents[0].length == 1 && routeEvents[0][0].offerId == 'a',
        'route table is recomputed and published once for the bulk replacement')
    ok(routePackets.get('a') == 1, 'the surviving session receives one route advertisement, not one per removal')
    ok((closes.get('b') ?? 0) == 1 && (closes.get('c') ?? 0) == 1 && (closes.get('d') ?? 0) == 1,
        'every removed session is still closed exactly once')
    ok(mesh.routes().length == 1 && mesh.status().length == 1, 'final route and status state stay correct')

    mesh.close()
    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
