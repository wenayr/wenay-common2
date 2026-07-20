// Acceptance oracle: arbitrary packets choose the cheapest path, traverse an
// intermediate client, fall back when a connection offer disappears and keep
// packet identity / TTL protection independent from the payload type.

import {listen} from '../src/Common/events/Listen'
import {
    createPeerPacketMesh,
    createPeerPacketOffers,
    PeerPacketOffer,
    PeerPacketWire,
} from '../src/Common/peer/peer-index'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const json = (value: unknown) => JSON.stringify(value)

type Payload = {kind: 'module-chunk' | 'control', value: string}
type Offers = ReturnType<typeof createPeerPacketOffers<Payload>>

async function waitFor(label: string, check: () => boolean) {
    for (let i = 0; i < 200; i++) {
        if (check()) return
        await delay(10)
    }
    throw new Error('timeout: ' + label)
}

function createFakeLink(a: string, b: string, cost: number, registries: Record<string, Offers>) {
    const [emitA, messagesA] = listen<[PeerPacketWire<Payload>]>()
    const [emitB, messagesB] = listen<[PeerPacketWire<Payload>]>()
    let active = false
    let removeA: (() => void) | null = null
    let removeB: (() => void) | null = null

    function offer(self: string, peer: string, messages: typeof messagesA, emitPeer: typeof emitA): PeerPacketOffer<Payload> {
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
                        queueMicrotask(function deliverPacket() { if (active) emitPeer(message) })
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
        removeA = registries[a].control.upsert(offer(a, b, messagesA, emitB))
        removeB = registries[b].control.upsert(offer(b, a, messagesB, emitA))
    }

    function cut() {
        if (!active) return
        active = false
        removeA?.()
        removeB?.()
        removeA = null
        removeB = null
    }

    return {a, b, cost, install, cut, active: () => active}
}

async function main() {
    console.log('\n[peer-packet-mesh] direct, multi-hop and route fallback')

    const staleRegistry = createPeerPacketOffers<Payload>()
    const stableConnect = function stableConnect() { throw new Error('not opened by the registry test') }
    const removeOld = staleRegistry.control.upsert({id: 'stable', peerId: 'peer', priority: 1, connect: stableConnect})
    staleRegistry.control.upsert({id: 'stable', peerId: 'peer', priority: 2, connect: stableConnect})
    removeOld()
    ok(staleRegistry.api.list()[0]?.priority == 2, 'an old offer handle cannot remove a newer upsert with the same connect function')
    staleRegistry.control.clear()

    const failingOffers = createPeerPacketOffers<Payload>()
    const [, recoveredMessages] = listen<[PeerPacketWire<Payload>]>()
    let connectAttempts = 0
    failingOffers.control.upsert({
        id: 'sync-failure',
        peerId: 'offline',
        connect() {
            connectAttempts++
            if (connectAttempts == 1) throw new Error('sync connect failure')
            return {
                peerId: 'offline',
                messages: recoveredMessages,
                send() { return true },
                close() {},
            }
        },
    })
    const failingMesh = createPeerPacketMesh<Payload>({
        meshId: 'failure-test',
        nodeId: 'local',
        offers: failingOffers.api,
        reconnectMs: 50,
    })
    await waitFor('synchronous connect failure', () => failingMesh.status()[0]?.state == 'failed')
    ok(failingMesh.status()[0]?.error == 'sync connect failure', 'a synchronous connect failure enters the normal failed/reconnect lifecycle')
    await waitFor('synchronous connect recovery', () => failingMesh.status()[0]?.state == 'open')
    ok(connectAttempts == 2, 'the failed synchronous connector is retried and can recover')
    failingMesh.close()

    let invalidConfigRejected = false
    try {
        createPeerPacketMesh<Payload>({meshId: 'invalid', nodeId: 'local', offers: failingOffers.api, seenLimit: -1})
    } catch { invalidConfigRejected = true }
    ok(invalidConfigRejected, 'invalid mesh limits fail fast instead of corrupting dedupe state')

    const registries: Record<string, Offers> = {
        a: createPeerPacketOffers<Payload>(),
        b: createPeerPacketOffers<Payload>(),
        c: createPeerPacketOffers<Payload>(),
    }
    const ab = createFakeLink('a', 'b', 1, registries)
    const bc = createFakeLink('b', 'c', 1, registries)
    const ac = createFakeLink('a', 'c', 20, registries)
    ab.install(); bc.install(); ac.install()

    const a = createPeerPacketMesh<Payload>({meshId: 'packages', nodeId: 'a', offers: registries.a.api, reconnectMs: 10})
    const b = createPeerPacketMesh<Payload>({meshId: 'packages', nodeId: 'b', offers: registries.b.api, reconnectMs: 10})
    const c = createPeerPacketMesh<Payload>({
        meshId: 'packages',
        nodeId: 'c',
        offers: registries.c.api,
        reconnectMs: 10,
        accept(packet) {
            if (packet.payload.value == 'reject-with-error') throw new Error('policy unavailable')
            return true
        },
    })
    const received: Array<{payload: Payload, path: string[]}> = []
    c.packets.on(function receiveAtC(payload, meta) { received.push({payload, path: meta.path}) })

    await waitFor('multi-hop route', () => json(a.routes().find(route => route.targetId == 'c')?.path) == json(['a', 'b', 'c']))
    const multiHop = await a.send('c', {kind: 'module-chunk', value: 'part-1'})
    await waitFor('multi-hop delivery', () => received.length == 1)
    ok(multiHop.ok && multiHop.nextHopId == 'b', 'cheapest next hop is the intermediate client')
    ok(json(received[0].path) == json(['a', 'b', 'c']), 'packet traversed a -> b -> c')

    const groupAtB: string[] = []
    b.packets.on(function receiveGroupAtB(payload) { if (payload.value == 'group') groupAtB.push(payload.value) })
    const group = await a.broadcast(['b', 'c'], {kind: 'control', value: 'group'})
    await waitFor('group delivery', () => groupAtB.length == 1 && received.some(item => item.payload.value == 'group'))
    ok(group.every(result => result.ok), 'one broadcast routes independently to every group member')

    bc.cut()
    await waitFor('direct fallback', () => json(a.routes().find(route => route.targetId == 'c')?.path) == json(['a', 'c']))
    const fallback = await a.send('c', {kind: 'module-chunk', value: 'part-2'})
    await waitFor('fallback delivery', () => received.some(item => item.payload.value == 'part-2'))
    ok(fallback.ok && fallback.nextHopId == 'c', 'lost intermediate connection falls back to the direct offer')

    bc.install()
    await waitFor('short route restored', () => json(a.routes().find(route => route.targetId == 'c')?.path) == json(['a', 'b', 'c']))
    ok(true, 'restored capability is discovered and becomes the cheapest route again')

    const firstId = await a.send('c', {kind: 'control', value: 'dedupe'}, {packetId: 'fixed-id'})
    const duplicateId = await a.send('c', {kind: 'control', value: 'dedupe'}, {packetId: 'fixed-id'})
    ok(firstId.ok && !duplicateId.ok && duplicateId.reason == 'rejected', 'packet identity prevents duplicate origin sends')

    const beforeRejected = received.length
    await a.send('c', {kind: 'control', value: 'reject-with-error'})
    await delay(30)
    ok(received.length == beforeRejected && c.stats().rejected == 1, 'an authorization error rejects the packet without escaping the mesh task')

    const ttlFallback = await a.send('c', {kind: 'control', value: 'ttl'}, {ttl: 1})
    await waitFor('TTL-aware direct delivery', () => received.some(item => item.payload.value == 'ttl'))
    ok(ttlFallback.ok && ttlFallback.nextHopId == 'c', 'TTL budget skips an impossible multi-hop route and uses the direct path')

    ac.cut(); bc.cut()
    await waitFor('no route', () => !a.routes().some(route => route.targetId == 'c'))
    const unavailable = await a.send('c', {kind: 'control', value: 'offline'})
    ok(!unavailable.ok && unavailable.reason == 'no-route', 'missing route is explicit, not a silent send')

    const lateRejectOffers = createPeerPacketOffers<Payload>()
    const [, lateRejectMessages] = listen<[PeerPacketWire<Payload>]>()
    const [failOldSession, oldSessionFailures] = listen<[unknown?]>()
    let lateRejectConnects = 0
    let rejectOldSend = function rejectPendingOldSend(_error: Error) {}
    const oldSend = new Promise<boolean>(function waitForOldSend(_resolve, reject) { rejectOldSend = reject })
    lateRejectOffers.control.upsert({
        id: 'late-reject',
        peerId: 'remote',
        connect() {
            lateRejectConnects++
            const first = lateRejectConnects == 1
            return {
                peerId: 'remote',
                messages: lateRejectMessages,
                onFail: first ? oldSessionFailures : undefined,
                send(message: PeerPacketWire<Payload>) {
                    return first && message.kind == 'packet' ? oldSend : true
                },
                close() {},
            }
        },
    })
    const lateRejectMesh = createPeerPacketMesh<Payload>({
        meshId: 'late-reject',
        nodeId: 'local',
        offers: lateRejectOffers.api,
        reconnectMs: 10,
    })
    await waitFor('old session open', () => lateRejectMesh.status()[0]?.state == 'open')
    const pendingOldSend = lateRejectMesh.send('remote', {kind: 'control', value: 'old-send'})
    await delay(10)
    failOldSession(new Error('old session failed'))
    await waitFor('replacement session open', () => lateRejectConnects == 2 && lateRejectMesh.status()[0]?.state == 'open')
    rejectOldSend(new Error('late old send rejection'))
    await pendingOldSend
    await delay(20)
    ok(lateRejectConnects == 2 && lateRejectMesh.status()[0]?.state == 'open', 'a late rejection from an old send cannot fail the replacement session')
    lateRejectMesh.close()

    const pendingRegistries: Record<string, Offers> = {
        x: createPeerPacketOffers<Payload>(),
        y: createPeerPacketOffers<Payload>(),
    }
    const xy = createFakeLink('x', 'y', 1, pendingRegistries)
    xy.install()
    let acceptStarted = false
    let releaseAccept = function releasePendingAccept() {}
    const acceptWait = new Promise<void>(function waitForAccept(resolve) { releaseAccept = resolve })
    const x = createPeerPacketMesh<Payload>({meshId: 'pending-policy', nodeId: 'x', offers: pendingRegistries.x.api})
    const y = createPeerPacketMesh<Payload>({
        meshId: 'pending-policy',
        nodeId: 'y',
        offers: pendingRegistries.y.api,
        async accept() {
            acceptStarted = true
            await acceptWait
            return true
        },
    })
    let deliveredAfterClose = 0
    y.packets.on(function countLateDelivery() { deliveredAfterClose++ })
    await waitFor('pending-policy route', () => x.routes().some(route => route.targetId == 'y'))
    await x.send('y', {kind: 'control', value: 'pending-policy'})
    await waitFor('pending authorization', () => acceptStarted)
    y.close()
    releaseAccept()
    await delay(20)
    ok(deliveredAfterClose == 0, 'closing a mesh cancels delivery still waiting in asynchronous authorization')
    x.close()
    xy.cut()

    a.close(); b.close(); c.close()
    const deliveredBeforeClosedSend = a.stats().delivered
    const closedSend = await a.send('a', {kind: 'control', value: 'after-close'})
    ok(!closedSend.ok && closedSend.reason == 'rejected' && a.stats().delivered == deliveredBeforeClosedSend, 'send after terminal close is rejected without local delivery')
    ab.cut(); ac.cut(); bc.cut()
    for (const registry of Object.values(registries)) registry.control.clear()

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
