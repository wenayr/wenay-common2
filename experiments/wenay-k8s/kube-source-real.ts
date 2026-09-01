// =====================================================================
// Kube endpoint source (REAL) — the same port over @kubernetes/client-node
// =====================================================================
// Drop-in peer of createFakeKubeApi: implements KubeEndpointsSource against a
// live Kubernetes API. Kubeconfig comes from the default loading rules
// (KUBECONFIG env / ~/.kube/config / in-cluster service account) unless a
// loaded KubeConfig is injected. The feeder must not tell fake from real, so
// the watch protocol maps exactly onto the port's event shape:
//
//   ADDED / MODIFIED      -> {type: 'update', pods: [pod]}
//   DELETED               -> {type: 'delete', pods: [pod]}
//   BOOKMARK              -> resourceVersion bookkeeping only, no event
//   drop / 410 Gone       -> backoff -> relist -> {type: 'sync', pods: ALL}
//
// list() records the list's resourceVersion so the FIRST watch resumes exactly
// after the listed truth (informer discipline — no gap between list and watch).
// A healthy periodic server-side close resumes from the last observed RV
// without a relist; only a lost RV (410) or a failed list degrades to the
// full 'sync', which the feeder already treats as the reconcile point.

import {CoreV1Api, KubeConfig, Watch} from '@kubernetes/client-node'
import type {V1Pod} from '@kubernetes/client-node'
import type {KubeEndpointsEvent, KubeEndpointsSource, KubePod} from './kube-source'

export type KubeSourceRealDeps = {
    namespace: string
    /** K8s label selector the stand's pods carry, e.g. 'app=wenay-mini-node'. */
    labelSelector?: string
    /** Client-reachable origin of a pod; default http://<podIP>:<port> ('' until the IP exists). */
    urlOf?: (pod: V1Pod) => string
    /** Port used by the default urlOf; default 3100. */
    port?: number
    /** Watch reconnect backoff bounds; defaults 500 ms .. 15 s. */
    backoff?: {minMs?: number, maxMs?: number}
    /** Injectable, already-loaded config (cluster-check reuses its probe config); default: default rules. */
    kubeconfig?: KubeConfig
    log?: (line: string) => void
}

export function createKubeSourceReal(deps: KubeSourceRealDeps) {
    const namespace = deps.namespace
    const minMs = deps.backoff?.minMs ?? 500
    const maxMs = deps.backoff?.maxMs ?? 15_000
    const port = deps.port ?? 3100
    const log = deps.log ?? function logKubeSource(line: string) { console.log('[kube-source] ' + line) }
    const urlOf = deps.urlOf ?? function defaultUrlOf(pod: V1Pod) {
        // no IP yet (Pending) = honestly unreachable; a MODIFIED event fixes the row once the IP lands
        const ip = pod.status?.podIP
        return ip ? 'http://' + ip + ':' + port : ''
    }

    const kc = deps.kubeconfig ?? function loadDefaultKubeconfig() {
        const fresh = new KubeConfig()
        fresh.loadFromDefault()
        return fresh
    }()
    const core = kc.makeApiClient(CoreV1Api)
    const watcher = new Watch(kc)
    const watchPath = '/api/v1/namespaces/' + encodeURIComponent(namespace) + '/pods'

    // ============== pod mapping: V1Pod -> the port's KubePod ==============

    function mapPod(pod: V1Pod): KubePod {
        const conditions = pod.status?.conditions ?? []
        const ready = conditions.some(function isReadyTrue(c) { return c.type == 'Ready' && c.status == 'True' })
        return {
            name: pod.metadata?.name ?? '',
            url: urlOf(pod),
            ready,
            // deletionTimestamp never reverses in K8s — exactly the port's one-way `deleting`
            ...(pod.metadata?.deletionTimestamp != null ? {deleting: true} : {}),
            ...(pod.metadata?.labels ? {labels: {...pod.metadata.labels}} : {}),
        }
    }

    // ============== list + watch with resume and bounded backoff ==============

    const watchers = new Set<(ev: KubeEndpointsEvent) => void>()
    // resume point of the watch; '' means the truth is lost and the next round must relist
    let resourceVersion = ''
    let abort: AbortController | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let wakeRetry: (() => void) | null = null
    let backoffMs = minMs
    let running = false
    let closed = false

    function emit(ev: KubeEndpointsEvent) {
        for (const cb of [...watchers]) cb(ev)
    }

    async function list() {
        const result = await core.listNamespacedPod({
            namespace,
            ...(deps.labelSelector ? {labelSelector: deps.labelSelector} : {}),
        })
        // remember where the listed truth ends: the next watch resumes there, gap-free
        resourceVersion = result.metadata?.resourceVersion ?? ''
        return result.items.map(mapPod)
    }

    function onWatchEvent(phase: string, apiObj: unknown) {
        if (closed) return
        if (phase == 'ERROR') {
            // e.g. 410 Gone — the RV is too old; drop the stream and force a relist.
            // The ladder keeps climbing: an ERROR storm must not relist at minMs
            resourceVersion = ''
            abort?.abort()
            return
        }
        // a delivered NON-error event proves the link is healthy: reset the backoff ladder
        backoffMs = minMs
        const pod = apiObj as V1Pod
        const rv = pod.metadata?.resourceVersion
        if (rv) resourceVersion = rv
        if (phase == 'BOOKMARK') return
        if (phase == 'DELETED') emit({type: 'delete', pods: [mapPod(pod)]})
        else if (phase == 'ADDED' || phase == 'MODIFIED') emit({type: 'update', pods: [mapPod(pod)]})
    }

    /** One list(if needed)+watch round; resolves when the stream drops for any reason. */
    async function runWatchOnce() {
        if (resourceVersion == '') {
            // fresh start or lost RV: the relist IS the reconcile — deliver it as 'sync'
            emit({type: 'sync', pods: await list()})
        }
        await new Promise<void>(function watchUntilDrop(resolve) {
            watcher.watch(
                watchPath,
                {
                    allowWatchBookmarks: true,
                    resourceVersion,
                    ...(deps.labelSelector ? {labelSelector: deps.labelSelector} : {}),
                },
                onWatchEvent,
                // clean server close and stream error look the same from here: reconnect
                function watchDone() { resolve() },
            ).then(function keepAbortHandle(controller) {
                if (closed || watchers.size == 0) controller.abort()
                else abort = controller
            }, function watchFailedToStart() { resolve() })
        })
        abort = null
    }

    function sleepBackoff(ms: number) {
        return new Promise<void>(function armRetry(resolve) {
            wakeRetry = resolve
            retryTimer = setTimeout(function retryNow() {
                retryTimer = null
                wakeRetry = null
                resolve()
            }, ms)
        })
    }

    async function watchLoop() {
        running = true
        while (!closed && watchers.size > 0) {
            try {
                await runWatchOnce()
            } catch (error) {
                // list() failed (API briefly unreachable): keep trying, backoff bounds the pressure
                log('list/watch failed, retrying: ' + (error instanceof Error ? error.message : String(error)))
                resourceVersion = ''
            }
            if (closed || watchers.size == 0) break
            await sleepBackoff(backoffMs)
            backoffMs = Math.min(maxMs, backoffMs * 2)
        }
        running = false
    }

    // ============== the port ==============

    const source: KubeEndpointsSource = {
        list,
        watch(cb) {
            watchers.add(cb)
            // one shared list+watch loop serves every subscriber, like one informer
            if (!running && !closed) void watchLoop()
            return function offWatch() {
                watchers.delete(cb)
                if (watchers.size == 0) abort?.abort()
            }
        },
    }

    function close() {
        if (closed) return
        closed = true
        abort?.abort()
        abort = null
        if (retryTimer) {
            clearTimeout(retryTimer)
            retryTimer = null
        }
        // release a sleeping loop so it observes `closed` and finishes
        wakeRetry?.()
        wakeRetry = null
        watchers.clear()
    }

    return {source, close}
}
export type KubeSourceReal = ReturnType<typeof createKubeSourceReal>
