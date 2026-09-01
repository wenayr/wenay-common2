// =====================================================================
// K8s directory feeder — pod facts drive the library node directory
// =====================================================================
// The node directory stays the library contract (clients balance on ITS rows,
// per doc/target/SCALE-DEPLOY-PLAN.md stage 5); Kubernetes is ONE feeder of
// that contract. This adapter translates pod facts into the directory's own
// control verbs and adds nothing else — no second roster, no balancing logic.
//
//   pod fact                          directory verb
//   ------------------------------    ------------------------------------------
//   appears (first sighting)          set {url, role, weight (0 if !ready)}
//   ready=false on a known pod        heartbeat(name, {weight: 0})   -> closed
//   ready=true  on a known pod        heartbeat(name, {weight: weightOf(pod)})
//   deleting (deletionTimestamp)      drain(name)  -> library moves clients losslessly
//   gone (delete event / not in sync) remove(name)
//   still present, every heartbeatMs  heartbeat(name)  -> the owner keeps the row alive; a dead feeder = dead rows

import type {NodeDirectory, tNodeDirectoryRole} from '../../src/Common/Observe/node-directory'
import type {KubeEndpointsEvent, KubeEndpointsSource, KubePod} from './kube-source'

// derived from the library factory, not redeclared
export type NodeDirectoryControl = NodeDirectory['control']

export type K8sDirectoryFeederDeps = {
    source: KubeEndpointsSource
    directory: Pick<NodeDirectoryControl, 'set' | 'heartbeat' | 'drain' | 'remove'>
    /** Directory role of a pod; default everyone is a mirror. */
    role?: (pod: KubePod) => tNodeDirectoryRole
    /** Placement share of a READY pod; default 4 (the demo mini-node share). */
    weightOf?: (pod: KubePod) => number
    heartbeatMs?: number
}

export function createK8sDirectoryFeeder(deps: K8sDirectoryFeederDeps) {
    const {source, directory, heartbeatMs = 5000} = deps
    const roleOf = deps.role ?? function defaultRole() { return 'mirror' as const }
    const weightOf = deps.weightOf ?? function defaultWeight() { return 4 }

    // last pod facts seen, keyed by pod name = nodeId; drives sync reconcile + heartbeats
    const known = new Map<string, KubePod>()
    const counts = {upserts: 0, patches: 0, drains: 0, removes: 0, heartbeats: 0}
    let offWatch: (() => void) | null = null
    let beat: any = null
    let started = false
    let closed = false

    // ============== pod fact -> directory verbs ==============

    function applyPod(pod: KubePod) {
        // not-ready = closed (weight 0): new placements avoid it, existing clients
        // move away — exactly the directory's own weight<=0 semantics.
        const facts = {
            url: pod.url,
            role: roleOf(pod),
            weight: pod.ready ? weightOf(pod) : 0,
            ...(pod.labels ? {meta: {labels: pod.labels}} : {}),
        }
        // heartbeat doubles as the freshness stamp; false = first sighting -> register
        if (directory.heartbeat(pod.name, facts)) {
            counts.patches++
        } else {
            directory.set({nodeId: pod.name, ...facts, ...(pod.deleting ? {draining: true} : {})})
            counts.upserts++
        }
        if (pod.deleting) {
            // one-way on purpose: K8s deletion never reverses, so there is no undrain path
            if (known.get(pod.name)?.deleting != true) counts.drains++
            directory.drain(pod.name)
        }
        known.set(pod.name, {...pod})
    }

    function removePod(name: string) {
        if (!known.delete(name)) return
        directory.remove(name)
        counts.removes++
    }

    function handleEvent(ev: KubeEndpointsEvent) {
        if (closed) return
        if (ev.type == 'delete') {
            for (const pod of ev.pods) removePod(pod.name)
            return
        }
        if (ev.type == 'sync') {
            // reconcile: a pod missing from the full list vanished behind a watch gap
            const present = new Set(ev.pods.map(function nameOf(pod) { return pod.name }))
            for (const name of [...known.keys()]) {
                if (!present.has(name)) removePod(name)
            }
        }
        for (const pod of ev.pods) applyPod(pod)
    }

    // ============== lifecycle ==============

    async function start() {
        if (started || closed) return
        started = true
        handleEvent({type: 'sync', pods: await source.list()})
        offWatch = source.watch(handleEvent)
        beat = setInterval(function beatKnownPods() {
            for (const name of known.keys()) {
                if (directory.heartbeat(name)) counts.heartbeats++
            }
        }, heartbeatMs)
        beat.unref?.()
    }

    function close() {
        if (closed) return
        closed = true
        offWatch?.()
        offWatch = null
        if (beat) { clearInterval(beat); beat = null }
        known.clear()
    }

    return {
        start,
        close,
        view: {
            counts() { return {pods: known.size, ...counts} },
        },
    }
}
export type K8sDirectoryFeeder = ReturnType<typeof createK8sDirectoryFeeder>
