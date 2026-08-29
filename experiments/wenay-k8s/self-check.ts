// ============================================================
//  experiments/wenay-k8s/self-check.ts
//
//  Self-verifying slice of the wenay-k8s skeleton: a fake kube api feeds a
//  REAL createNodeDirectory through the feeder (pod facts -> directory verbs,
//  staleness under an injected clock), probes answer from a real
//  createNodeHealth, and one integration proof shows the feeder composing
//  with the real balancing path: marking the serving pod deleting moves a
//  replica-set client to another node with identical snapshots (zero loss).
//  Run: npx tsx experiments/wenay-k8s/self-check.ts
// ============================================================

import {
    createNodeDirectory, directoryReplicaOffers, followNodeDirectory, nodeDirectoryViews,
} from '../../src/Common/Observe/node-directory'
import {createNodeHealth} from '../../src/Common/Observe/node-health'
import {flushReactive} from '../../src/Common/Observe/reactive'
import {createStoreReplicaSet} from '../../src/Common/Observe/store-replica-set'
import {createK8sDirectoryFeeder} from './k8s-directory-feeder'
import {createFakeKubeApi, KubePod} from './kube-source'
import {createK8sProbes, ProbeResponse} from './k8s-probes'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const json = (v: any) => JSON.stringify(v)

async function waitFor(label: string, condition: () => boolean, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    fails++
    console.log('  FAIL timeout waiting for ' + label)
}

function labeledRole(pod: KubePod) {
    return pod.labels?.role == 'leader' ? 'leader' as const : 'mirror' as const
}

// ============== feeder: pod facts -> directory verbs (fake clock) ==============
async function feederPart() {
    console.log('feeder: pod facts -> directory verbs')
    let t = 1000
    const dir = createNodeDirectory({now: () => t})
    const kube = createFakeKubeApi([
        {name: 'pod-a', url: 'http://10.0.0.1:3100', ready: true, labels: {role: 'leader'}},
        {name: 'pod-b', url: 'http://10.0.0.2:3100', ready: true},
    ])
    const feeder = createK8sDirectoryFeeder({
        source: kube.source,
        directory: dir.control,
        role: labeledRole,
        heartbeatMs: 20,
    })
    const viewOpts = {staleMs: 5000, now: () => t}
    const views = () => nodeDirectoryViews(dir.control.snapshot(), viewOpts)
    const row = (name: string) => views().find(v => v.nodeId == name)

    await feeder.start()
    ok(views().length == 2 && views().every(v => v.eligible), 'sync populates the directory with eligible rows')
    ok(row('pod-a')?.role == 'leader' && row('pod-b')?.role == 'mirror', 'role fn maps pod labels, default is mirror')
    ok(row('pod-b')?.weight == 4, 'default ready weight is 4')
    ok(row('pod-a')?.url == 'http://10.0.0.1:3100', 'pod url lands in the row')
    ok((row('pod-a')?.meta as any)?.labels?.role == 'leader', 'pod labels ride along in meta')

    kube.control.addPod({name: 'pod-c', url: 'http://10.0.0.3:3100', ready: false})
    ok(row('pod-c')?.weight == 0 && row('pod-c')?.eligible == false, 'a not-ready pod registers closed (weight 0)')
    kube.control.setReady('pod-c', true)
    ok(row('pod-c')?.weight == 4 && row('pod-c')?.eligible == true, 'readiness opens the node')

    kube.control.setReady('pod-b', false)
    ok(row('pod-b')?.weight == 0 && row('pod-b')?.eligible == false, 'ready=false closes the row via weight 0')
    kube.control.markDeleting('pod-b')
    ok(row('pod-b')?.draining == true, 'deleting pod drains its row')
    kube.control.deletePod('pod-b')
    ok(row('pod-b') == undefined, 'deleted pod removes its row')

    // rows were stamped at the old clock; the jump makes them stale until the
    // periodic heartbeat (real timer, fake clock) re-stamps ts with the new now
    t += 20_000
    ok(views().every(v => v.stale), 'clock jump past staleMs marks silent rows stale')
    await waitFor('heartbeats re-stamp the rows fresh', () => views().length == 2 && views().every(v => !v.stale))
    ok(feeder.view.counts().heartbeats > 0, 'the periodic heartbeat drove the freshness')

    // a watch gap loses the delete event; only the next full sync reconciles it
    kube.control.dropPod('pod-c')
    ok(row('pod-c') != undefined, 'a missed delete leaves the row behind (the gap)')
    kube.control.resync()
    ok(row('pod-c') == undefined, 'resync reconciles the gap away')
    ok(feeder.view.counts().pods == 1, 'feeder tracks exactly the surviving pod')

    feeder.close()
    dir.control.close()
}

// ============== probes from the real node-health store ==============
async function probesPart() {
    console.log('probes: readiness/liveness from createNodeHealth')
    const health = createNodeHealth({node: 'pod-a'})
    const probes = createK8sProbes({health})
    function hit(handler: (req: unknown, res: ProbeResponse) => void) {
        const res = {
            statusCode: 0,
            body: '',
            end(body?: string) { this.body = body ?? '' },
        }
        handler(undefined, res)
        return res
    }

    health.register('replica', function replicaProbe() { return {role: 'leader', seq: 42} })
    let res = hit(probes.readyz)
    ok(res.statusCode == 200 && res.body == 'ok', 'healthy parts -> readyz 200')
    ok(hit(probes.livez).statusCode == 200, 'livez answers 200 while the loop runs')

    const offBad = health.register('journal', function brokenProbe(): unknown { throw new Error('disk gone') })
    res = hit(probes.readyz)
    ok(res.statusCode == 503 && res.body.includes('journal'), 'a throwing probe -> readyz 503 naming the part')
    ok(hit(probes.livez).statusCode == 200, 'livez stays 200 — dependency failures belong to readiness')

    offBad()
    ok(hit(probes.readyz).statusCode == 200, 'removing the failing part restores readiness')
    health.close()
}

// ============== integration: feeder + REAL balancing path, zero loss ==============
async function balancePart() {
    console.log('integration: deleting pod moves the client losslessly')
    type State = Record<string, {id: string, value: number}>
    const leader = createStoreReplicaSet<State>({
        storeId: 'k8s-balance', originId: 'k8s-origin', nodeId: 'pod-leader', lineId: 'line-a',
        initial: {seed: {id: 'seed', value: 1}},
        leadership: {initialRole: 'leader', epoch: 1},
    })
    const mirror = createStoreReplicaSet<State>({
        storeId: 'k8s-balance', originId: 'k8s-origin', nodeId: 'pod-mirror', lineId: 'line-b',
        initial: {},
        leadership: {initialRole: 'follower', eligible: false},
    })
    mirror.control.addOffer({
        id: 'to-leader',
        connect: () => ({remote: leader.api.fragment, close() {}}),
    })
    await mirror.api.ready

    // the directory is REAL library surface; K8s facts reach it only through the feeder
    const dir = createNodeDirectory()
    const kube = createFakeKubeApi([
        {name: 'pod-leader', url: 'inproc:leader', ready: true, labels: {role: 'leader'}},
        {name: 'pod-mirror', url: 'inproc:mirror', ready: true},
    ])
    const feeder = createK8sDirectoryFeeder({
        source: kube.source,
        directory: dir.control,
        role: labeledRole,
        weightOf: pod => pod.labels?.role == 'leader' ? 1 : 100,
    })
    await feeder.start()

    const followed = followNodeDirectory(dir.api, {staleMs: 0})
    await followed.ready
    await tick()
    const offers = directoryReplicaOffers({
        directory: followed,
        connect: node => ({
            remote: node.nodeId == 'pod-leader' ? leader.api.fragment : mirror.api.fragment,
            close() {},
        }),
    })
    ok(offers.api.list().length == 2, 'feeder-built directory exposes both pods as offers')

    const client = createStoreReplicaSet<State>({
        storeId: 'k8s-balance', originId: 'k8s-origin', nodeId: 'client', lineId: 'line-c',
        initial: {},
        leadership: {initialRole: 'follower', eligible: false},
        offers: offers.api,
    })
    await client.api.ready
    await waitFor('client lands on the heavy mirror pod', () => client.api.status.state.routeId == 'pod-mirror')

    leader.control.store.state.k1 = {id: 'k1', value: 10}
    await flushReactive(leader.control.store.state)
    await waitFor('live write reaches the client through the mirror', () => client.api.store.state.k1?.value == 10)

    // `kubectl delete pod` == markDeleting: the feeder drains the row, the
    // LIBRARY (offers bridge + replica set) does the actual gap-free move
    kube.control.markDeleting('pod-mirror')
    await waitFor('deleting pod moves the client to the leader', () => client.api.status.state.routeId == 'pod-leader')
    leader.control.store.state.k2 = {id: 'k2', value: 20}
    await flushReactive(leader.control.store.state)
    await waitFor('post-move write arrives on the new route', () => client.api.store.state.k2?.value == 20)
    ok(json(client.api.store.snapshot()) == json(leader.api.store.snapshot()), 'zero loss across the pod-deleting hand-off')

    kube.control.deletePod('pod-mirror')
    await waitFor('the deleted pod leaves the offer list', () => offers.api.list().length == 1)

    client.close()
    offers.close()
    followed.close()
    feeder.close()
    dir.control.close()
    mirror.close()
    leader.close()
}

async function main() {
    const watchdog = setTimeout(function selfCheckTimedOut() {
        console.error('wenay-k8s self-check timed out')
        process.exit(3)
    }, 60_000)
    await feederPart()
    await probesPart()
    await balancePart()
    clearTimeout(watchdog)
    console.log(fails ? `wenay-k8s self-check: ${fails} FAILED` : 'wenay-k8s self-check: ALL GREEN')
    process.exit(fails ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
