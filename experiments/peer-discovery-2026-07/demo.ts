import {createDiscoveryCandidateCatalog} from './candidate-catalog'
import {createUdpLanDiscovery} from './udp-lan-discovery'

async function main() {
    const peerId = process.argv[2] || 'robot-' + process.pid
    const endpointUrl = process.argv[3] || 'demo://' + peerId
    const udp = await createUdpLanDiscovery({
        networkId: 'factory-demo',
        peerId,
        local: () => ({
            endpoints: [{id: 'demo', kind: 'demo', url: endpointUrl}],
            degree: 0,
            minDegree: 3,
            diversityKeys: ['process:' + process.pid],
        }),
    })
    const catalog = createDiscoveryCandidateCatalog({
        networkId: 'factory-demo',
        nodeId: peerId,
    })
    catalog.control.attach(udp.source)
    catalog.events.changes.on(function printCandidates(candidates) {
        console.log(new Date().toISOString(), peerId, 'sees',
            candidates.map(candidate => `${candidate.peerId}[${candidate.primarySourceId}]`).join(', ') || 'nobody')
    })

    console.log(peerId, 'listening at', udp.view.address(), 'advertising', endpointUrl)
    console.log('Start this command in another terminal with a different peer id. Ctrl+C to stop.')

    let stopping = false
    async function stop() {
        if (stopping) return
        stopping = true
        catalog.close()
        await udp.close()
        process.exit(0)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
