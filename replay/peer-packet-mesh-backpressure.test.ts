import {listen} from '../src/Common/events/Listen'
import {
    createPeerPacketMesh,
    createPeerPacketOffers,
    PeerPacketEnvelope,
    PeerPacketWire,
} from '../src/Common/peer/peer-index'

let fails = 0
function ok(condition: unknown, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

function delay(ms: number) {
    return new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })
}

async function waitFor(label: string, condition: () => boolean) {
    for (let i = 0; i < 200; i++) {
        if (condition()) return
        await delay(5)
    }
    throw new Error('timeout: ' + label)
}

async function main() {
    console.log('\n[peer-packet-mesh-backpressure] bounded ordered async intake')

    type Payload = {index: number}
    const [emitMessage, messages] = listen<[PeerPacketWire<Payload>]>()
    const offers = createPeerPacketOffers<Payload>()
    offers.control.upsert({
        id: 'source-route',
        peerId: 'source',
        connect() {
            return {
                peerId: 'source',
                messages,
                send: () => true,
                close() {},
            }
        },
    })

    let releaseFirst!: () => void
    const firstGate = new Promise<void>(function wait(resolve) { releaseFirst = resolve })
    let active = 0
    let maxActive = 0
    let accepts = 0
    const delivered: number[] = []
    const mesh = createPeerPacketMesh<Payload>({
        meshId: 'bounded',
        nodeId: 'target',
        offers: offers.api,
        reconnectMs: 0,
        probeIntervalMs: 0,
        async accept() {
            active++
            maxActive = Math.max(maxActive, active)
            accepts++
            if (accepts == 1) await firstGate
            active--
            return true
        },
    })
    mesh.packets.on(function rememberPacket(payload) { delivered.push(payload.index) })
    await waitFor('source route opens', () => mesh.status()[0]?.state == 'open')

    for (let i = 0; i < 2000; i++) {
        const packet: PeerPacketEnvelope<Payload> = {
            protocol: 1,
            kind: 'packet',
            meshId: 'bounded',
            packetId: 'packet-' + i,
            originId: 'source',
            targetId: 'target',
            sequence: i,
            ttl: 4,
            path: ['source'],
            payload: {index: i},
        }
        emitMessage(packet)
    }
    await delay(10)
    ok(maxActive == 1 && accepts == 1, 'a blocked policy creates one async handler, not one per packet')
    ok(mesh.stats().rejected == 1935, 'the fixed per-route high-water rejects excess retained work')

    releaseFirst()
    await waitFor('bounded queue drains', () => delivered.length == 65)
    ok(maxActive == 1, 'per-route policy checks stay serialized while draining')
    ok(delivered.every((value, index) => value == index), 'accepted packets preserve source arrival order')

    mesh.close()
    offers.control.clear()

    console.log('\n[peer-packet-mesh-backpressure] replacement session bypasses a dead hung policy')
    const sessions: Array<{
        emitMessage: (message: PeerPacketWire<Payload>) => void
        emitFail: (reason?: unknown) => void
    }> = []
    const replacementOffers = createPeerPacketOffers<Payload>()
    replacementOffers.control.upsert({
        id: 'replacement-route',
        peerId: 'source',
        connect() {
            const [emitSessionMessage, sessionMessages] = listen<[PeerPacketWire<Payload>]>()
            const [emitFail, onFail] = listen<[unknown?]>()
            sessions.push({emitMessage: emitSessionMessage, emitFail})
            return {
                peerId: 'source',
                messages: sessionMessages,
                onFail,
                send: () => true,
                close() {},
            }
        },
    })
    let releaseDead!: () => void
    const deadGate = new Promise<void>(function wait(resolve) { releaseDead = resolve })
    const replacementDelivered: number[] = []
    const replacement = createPeerPacketMesh<Payload>({
        meshId: 'replacement',
        nodeId: 'target',
        offers: replacementOffers.api,
        reconnectMs: 0,
        probeIntervalMs: 0,
        async accept(packet) {
            if (packet.payload.index == 1) await deadGate
            return true
        },
    })
    replacement.packets.on(function rememberReplacement(payload) {
        replacementDelivered.push(payload.index)
    })
    await waitFor('first replacement route opens', () => sessions.length == 1
        && replacement.status()[0]?.state == 'open')
    function packet(index: number): PeerPacketEnvelope<Payload> {
        return {
            protocol: 1,
            kind: 'packet',
            meshId: 'replacement',
            packetId: 'replacement-' + index,
            originId: 'source',
            targetId: 'target',
            sequence: index,
            ttl: 4,
            path: ['source'],
            payload: {index},
        }
    }
    sessions[0].emitMessage(packet(1))
    await delay(5)
    sessions[0].emitFail(new Error('dead route'))
    await waitFor('replacement route opens', () => sessions.length == 2
        && replacement.status()[0]?.state == 'open')
    sessions[1].emitMessage(packet(2))
    await waitFor('replacement packet bypasses old policy', () => replacementDelivered.length == 1)
    ok(replacementDelivered[0] == 2,
        'a never-settled old-session policy does not lock the replacement session intake')
    releaseDead()
    await delay(5)
    ok(replacementDelivered.length == 1,
        'the released old-session packet remains invalidated by its transport generation')
    replacement.close()
    replacementOffers.control.clear()

    console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function reportFailure(error) { console.error(error); process.exit(1) })
