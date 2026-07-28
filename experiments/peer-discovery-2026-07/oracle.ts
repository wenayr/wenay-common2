import {listen} from '../../src/Common/events/Listen'
import {createPeerNeighborPortfolio} from '../../src/Common/peer/peer-neighbor-portfolio'
import {PeerPacketWire} from '../../src/Common/peer/peer-packet-mesh'
import {createDiscoveryCandidateCatalog} from './candidate-catalog'
import {createDiscoverySourceRegistry} from './discovery-source'
import {DiscoveryAdvertisement} from './discovery-types'
import {createPollingDiscovery} from './polling-discovery'
import {createDiscoveryPortfolioBridge} from './portfolio-bridge'
import {createScannerDiscovery, PlatformScannerHandlers} from './scanner-discovery'
import {createDiscoveredPeerPacketMesh} from './mesh-assembly'
import {createUdpLanDiscovery, UdpLanDiscovery} from './udp-lan-discovery'

type Payload = {value: string}

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function waitFor(label: string, check: () => boolean) {
    for (let i = 0; i < 200; i++) {
        if (check()) return
        await delay(10)
    }
    throw new Error('timeout: ' + label)
}

function advertisement(
    peerId: string,
    source: string,
    opts: Partial<DiscoveryAdvertisement> = {},
): DiscoveryAdvertisement {
    return {
        protocol: 1,
        networkId: 'factory',
        peerId,
        instanceId: source + '-' + peerId,
        revision: 1,
        ttlMs: 5000,
        endpoints: [{id: source, kind: source, url: source + '://' + peerId}],
        ...opts,
    }
}

async function catalogOracle() {
    console.log('\n[discovery catalog] multiple sources, trust and expiry')
    let time = 1000
    const now = () => time
    const wifi = createDiscoverySourceRegistry({
        descriptor: {id: 'wifi', kind: 'wifi-lan', trust: 0.4},
        now,
    })
    const serverRows = [
        advertisement('peer-a', 'server', {degree: 4, quality: {rttMs: 80, loss: 0.01}}),
        advertisement('remote-server', 'server', {degree: 8}),
    ]
    const server = createPollingDiscovery({
        descriptor: {id: 'directory', kind: 'server', trust: 0.9},
        load: () => serverRows,
        intervalMs: 0,
        now,
    })
    await server.ready
    wifi.control.upsert(advertisement('peer-a', 'wifi', {
        degree: 0,
        quality: {rttMs: 5, loss: 0},
        ttlMs: 1000,
    }))
    const catalog = createDiscoveryCandidateCatalog({
        networkId: 'factory',
        nodeId: 'local',
        sweepIntervalMs: 0,
        now,
    })
    catalog.control.attach(wifi.api)
    catalog.control.attach(server.source)

    const peerA = catalog.view.get('peer-a')
    ok(peerA?.primarySourceId == 'directory' && peerA.degree == 4,
        'higher-trust server metadata wins over an unauthenticated LAN claim')
    ok(peerA?.endpoints.length == 2 && peerA.evidence.length == 2,
        'LAN and server endpoints/evidence coexist for one peer identity')
    ok(catalog.view.get('remote-server')?.primarySourceId == 'directory',
        'remote candidates use the same passive catalog without pretending to be nearby')

    wifi.control.clear()
    ok(!!catalog.view.get('peer-a') && catalog.view.get('peer-a')?.endpoints.length == 1,
        'losing one discovery source removes only its observation')

    time += 6000
    catalog.control.sweep()
    ok(catalog.view.list().length == 0, 'expired source observations leave the passive catalog')

    catalog.close()
    wifi.close()
    server.close()
}

async function portfolioOracle() {
    console.log('\n[discovery portfolio bridge] large passive list -> ten active offers')
    const source = createDiscoverySourceRegistry({
        descriptor: {id: 'directory', kind: 'server', trust: 0.9},
    })
    const catalog = createDiscoveryCandidateCatalog({
        networkId: 'factory',
        nodeId: 'local',
        sweepIntervalMs: 0,
    })
    catalog.control.attach(source.api)
    for (let index = 0; index < 24; index++) {
        source.control.upsert(advertisement('peer-' + index, 'server', {
            revision: index,
            degree: index == 23 ? 0 : 5,
            minDegree: 3,
            quality: {rttMs: index == 23 ? 1000 : 10 + index, loss: 0},
            diversityKeys: ['sector:' + index, 'anchor:' + index],
            reachable: ['target-' + index],
            paths: [['peer-' + index, 'branch-' + index]],
        }))
    }
    const portfolio = createPeerNeighborPortfolio<Payload>({
        nodeId: 'local',
        budget: 10,
        qualityLinks: 3,
        rescueLinks: 1,
    })
    const [, messages] = listen<[PeerPacketWire<Payload>]>()
    const bridge = createDiscoveryPortfolioBridge<Payload>({
        catalog,
        portfolio,
        connect(candidate) {
            return {
                peerId: candidate.peerId,
                messages,
                send() { return true },
                close() {},
            }
        },
    })

    ok(catalog.view.list().length == 24 && portfolio.offers.list().length == 10,
        'twenty-four passive candidates produce exactly ten active connection offers')
    ok(portfolio.view.selected().some(row => row.peerId == 'peer-23' && row.role == 'rescue'),
        'the zero-degree remote peer receives the bounded rescue slot')
    ok(new Set(portfolio.view.selected().map(row => row.peerId)).size == 10,
        'one peer identity cannot consume multiple active slots')

    source.control.removePeer('peer-0')
    ok(portfolio.offers.list().length == 10 && !portfolio.view.selected().some(row => row.peerId == 'peer-0'),
        'candidate loss immediately promotes a passive replacement')

    bridge.close()
    portfolio.close()
    catalog.close()
    source.close()
}

async function scannerOracle() {
    console.log('\n[platform scanner discovery] Bluetooth/Wi-Fi Direct adapter boundary')
    let handlers: PlatformScannerHandlers | null = null
    let stopped = false
    const scanner = await createScannerDiscovery({
        descriptor: {id: 'bluetooth', kind: 'bluetooth', trust: 0.3},
        scanner: {
            start(next) {
                handlers = next
                return function stopScanner() { stopped = true }
            },
        },
    })
    handlers!.found(advertisement('bluetooth-peer', 'bluetooth', {
        endpoints: [{id: 'gatt', kind: 'bluetooth-gatt', address: 'device-17'}],
    }))
    ok(scanner.source.list()[0]?.advertisement.peerId == 'bluetooth-peer',
        'an injected platform scanner feeds the same source contract')
    handlers!.lost('bluetooth-peer')
    ok(scanner.source.list().length == 0, 'platform loss withdraws the Bluetooth observation')
    await scanner.close()
    ok(stopped, 'closing discovery releases the injected native scanner')
}

async function assemblyOracle() {
    console.log('\n[discovered mesh assembly] measured transport RTT feeds active selection')
    const source = createDiscoverySourceRegistry({
        descriptor: {id: 'directory', kind: 'server', trust: 0.9},
    })
    for (const peerId of ['a-slow', 'b-fast', 'c-fast', 'd-passive']) {
        source.control.upsert(advertisement(peerId, 'server', {
            endpoints: [{id: 'session', kind: 'session', url: 'test://' + peerId}],
            degree: 5,
        }))
    }
    const catalog = createDiscoveryCandidateCatalog({
        networkId: 'factory',
        nodeId: 'local',
        sweepIntervalMs: 0,
    })
    catalog.control.attach(source.api)
    const assembly = createDiscoveredPeerPacketMesh<Payload>({
        nodeId: 'local',
        meshId: 'factory',
        catalog,
        portfolio: {
            budget: 3,
            qualityLinks: 3,
            rescueLinks: 0,
        },
        mesh: {
            probeIntervalMs: 0,
            reconnectMs: 1000,
        },
        connect(candidate) {
            const [, messages] = listen<[PeerPacketWire<Payload>]>()
            return {
                peerId: candidate.peerId,
                messages,
                send() { return true },
                async ping() {
                    await delay(candidate.peerId == 'a-slow' ? 500 : 5)
                },
                close() {},
            }
        },
    })
    await waitFor('measured candidate replacement', () =>
        !assembly.discovery.portfolio.view.selected().some(row => row.peerId == 'a-slow') &&
        assembly.discovery.portfolio.view.selected().some(row => row.peerId == 'd-passive'))
    ok(true, 'a measured slow active link is replaced from the passive catalog')

    assembly.close()
    catalog.close()
    source.close()
}

async function udpOracle() {
    console.log('\n[UDP LAN discovery] two real local sockets announce and withdraw')
    let a: UdpLanDiscovery | null = null
    let b: UdpLanDiscovery | null = null
    try {
        a = await createUdpLanDiscovery({
            networkId: 'factory',
            peerId: 'udp-a',
            instanceId: 'instance-a',
            local: () => ({
                endpoints: [{id: 'rpc', kind: 'rpc', url: 'tcp://udp-a'}],
                degree: 2,
            }),
            bindAddress: '127.0.0.1',
            bindPort: 0,
            multicast: false,
            announceIntervalMs: 50,
            ttlMs: 500,
            sweepIntervalMs: 25,
        })
        b = await createUdpLanDiscovery({
            networkId: 'factory',
            peerId: 'udp-b',
            instanceId: 'instance-b',
            local: () => ({
                endpoints: [{id: 'rpc', kind: 'rpc', url: 'tcp://udp-b'}],
                degree: 1,
            }),
            bindAddress: '127.0.0.1',
            bindPort: 0,
            multicast: false,
            announceIntervalMs: 50,
            ttlMs: 500,
            sweepIntervalMs: 25,
        })
        const addressA = a.view.address()
        const addressB = b.view.address()
        if (typeof addressA == 'string' || typeof addressB == 'string') throw new Error('expected UDP address objects')
        a.control.setTargets([{address: '127.0.0.1', port: addressB.port}])
        b.control.setTargets([{address: '127.0.0.1', port: addressA.port}])
        await Promise.all([a.control.announce(), b.control.announce()])
        await waitFor('mutual UDP discovery', () =>
            a!.source.list().some(item => item.advertisement.peerId == 'udp-b') &&
            b!.source.list().some(item => item.advertisement.peerId == 'udp-a'))
        ok(true, 'real UDP datagrams discover both local peers')

        await b.close()
        b = null
        await waitFor('UDP bye', () => !a!.source.list().some(item => item.advertisement.peerId == 'udp-b'))
        ok(true, 'graceful UDP bye withdraws the candidate before TTL expiry')
    } finally {
        await b?.close()
        await a?.close()
    }
}

async function main() {
    await catalogOracle()
    await portfolioOracle()
    await scannerOracle()
    await assemblyOracle()
    await udpOracle()
    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
