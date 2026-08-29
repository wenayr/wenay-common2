// ============================================================
//  experiments/wenay-k8s/cluster-check.ts
//
//  Bounded acceptance check for a REAL cluster (run AFTER minikube is up):
//  a throwaway namespace gets a tiny pause Deployment, the REAL kube source
//  (kube-source-real.ts) feeds the REAL library node directory through the
//  unchanged feeder, and kubectl-style scaling via the API must show up as
//  directory rows appearing, growing and draining. The namespace is deleted
//  at the end, pass or fail.
//
//  No reachable cluster: exits with ONE line, non-zero, and never hangs —
//  the reachability probe is raced against a hard timeout and every path
//  ends in process.exit.
//
//  Run: node node_modules/tsx/dist/cli.mjs experiments/wenay-k8s/cluster-check.ts
// ============================================================

import {AppsV1Api, CoreV1Api, KubeConfig} from '@kubernetes/client-node'
import type {V1Deployment} from '@kubernetes/client-node'
import {createNodeDirectory, nodeDirectoryViews} from '../../src/Common/Observe/node-directory'
import {createK8sDirectoryFeeder} from './k8s-directory-feeder'
import {createKubeSourceReal} from './kube-source-real'

const APP_LABEL = 'wenay-mini-check'
const POD_PORT = 3100
const PROBE_TIMEOUT_MS = 4000

let step = 0
let fails = 0
function ok(condition: any, message: string) {
    step++
    if (!condition) { fails++; console.log(`[${step}] FAIL ${message}`) }
    else console.log(`[${step}] OK   ${message}`)
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return true
        await new Promise<void>(resolve => setTimeout(resolve, 100))
    }
    return false
}

/** True only if the probe settles successfully before the timeout — rejection and silence both count as unreachable. */
async function probeReachable(probe: Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | null = null
    const gate = new Promise<'timeout'>(function armProbeGate(resolve) {
        timer = setTimeout(function probeTimedOut() { resolve('timeout') }, PROBE_TIMEOUT_MS)
    })
    try {
        const outcome = await Promise.race([probe.then(() => 'ok' as const, () => 'down' as const), gate])
        return outcome == 'ok'
    } finally {
        if (timer) clearTimeout(timer)
    }
}

async function main() {
    // ============== reachability: the ONLY output on the no-cluster path ==============
    // loadFromDefault() without any kubeconfig silently falls back to
    // http://localhost:8080, so config loading alone proves nothing — only a
    // bounded live API call does.
    const kc = new KubeConfig()
    try { kc.loadFromDefault() } catch { bailNoCluster() }
    const core = kc.makeApiClient(CoreV1Api)
    const apps = kc.makeApiClient(AppsV1Api)
    if (!await probeReachable(core.getAPIResources())) bailNoCluster()

    const watchdog = setTimeout(function clusterCheckTimedOut() {
        console.error('cluster-check timed out')
        process.exit(3)
    }, 180_000)

    ok(true, `cluster reachable at ${kc.getCurrentCluster()?.server ?? '(unknown)'}`)

    // ============== throwaway namespace + tiny deployment ==============
    const ns = 'wenay-k8s-check-' + Math.random().toString(36).slice(2, 8)
    await core.createNamespace({body: {metadata: {name: ns, labels: {'wenay-k8s': 'cluster-check'}}}})
    ok(true, `throwaway namespace ${ns} created`)

    const deployment: V1Deployment = {
        metadata: {name: APP_LABEL, labels: {app: APP_LABEL}},
        spec: {
            replicas: 2,
            selector: {matchLabels: {app: APP_LABEL}},
            template: {
                metadata: {labels: {app: APP_LABEL}},
                spec: {
                    // pause is the sandbox image every node already has; it goes Ready
                    // immediately and exits promptly on SIGTERM, so drains are fast
                    containers: [{name: 'pause', image: 'registry.k8s.io/pause:3.10'}],
                },
            },
        },
    }

    const dir = createNodeDirectory()
    const kube = createKubeSourceReal({namespace: ns, labelSelector: 'app=' + APP_LABEL, port: POD_PORT, kubeconfig: kc})
    const feeder = createK8sDirectoryFeeder({source: kube.source, directory: dir.control, heartbeatMs: 1000})
    const views = () => nodeDirectoryViews(dir.control.snapshot(), {staleMs: 10_000})
    const eligible = () => views().filter(row => row.eligible)

    try {
        await apps.createNamespacedDeployment({namespace: ns, body: deployment})
        ok(true, `deployment ${APP_LABEL} applied (replicas 2, image registry.k8s.io/pause:3.10)`)

        await feeder.start()
        ok(await waitFor('2 directory rows', () => views().length == 2), 'both pods appear as directory rows through the real source')
        ok(await waitFor('2 eligible rows', () => eligible().length == 2), 'both rows become eligible once the pods are Ready')
        const sample = eligible()[0]
        ok(sample != null && /^http:\/\/[0-9.]+:3100$/.test(sample.url), `row url is the pod IP origin (${sample?.url})`)
        ok((sample?.meta as any)?.labels?.app == APP_LABEL, 'pod labels ride along in row meta')

        // ============== kubectl-style scale via the API: up, then down ==============
        await apps.replaceNamespacedDeploymentScale({
            name: APP_LABEL, namespace: ns,
            body: {metadata: {name: APP_LABEL, namespace: ns}, spec: {replicas: 3}},
        })
        ok(await waitFor('3 eligible rows', () => eligible().length == 3), 'scale 2->3: the new pod appears and becomes eligible')

        await apps.replaceNamespacedDeploymentScale({
            name: APP_LABEL, namespace: ns,
            body: {metadata: {name: APP_LABEL, namespace: ns}, spec: {replicas: 1}},
        })
        // deletionTimestamp reaches the feeder as `deleting` BEFORE the pod is gone:
        // the drain verb must fire, then the rows must settle at one
        ok(await waitFor('a drain observed', () => feeder.view.counts().drains >= 1), 'scale 3->1: deleting pods drain their rows first')
        ok(await waitFor('rows settle at 1', () => views().length == 1), 'scale 3->1: removed pods leave exactly one row')
        ok(eligible().length == 1, 'the surviving row is still eligible')
    } finally {
        // pass or fail, the throwaway namespace goes away
        feeder.close()
        kube.close()
        dir.control.close()
        try {
            await core.deleteNamespace({name: ns})
            ok(true, `namespace ${ns} deleted`)
        } catch (error) {
            ok(false, `namespace ${ns} cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    clearTimeout(watchdog)
    console.log(fails ? `wenay-k8s cluster-check: ${fails} FAILED` : 'wenay-k8s cluster-check: ALL GREEN')
    process.exit(fails ? 1 : 0)
}

function bailNoCluster(): never {
    console.error('no reachable cluster — start minikube first')
    process.exit(1)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
