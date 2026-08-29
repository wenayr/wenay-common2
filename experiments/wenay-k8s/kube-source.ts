// =====================================================================
// Kube endpoint source — the port between the K8s API and the feeder
// =====================================================================
// The feeder never talks to Kubernetes directly; it consumes this minimal
// port: list() for the initial truth, watch() for changes after it. The shape
// deliberately mirrors the real watch protocol (ADDED/MODIFIED -> 'update',
// DELETED -> 'delete', periodic relist -> 'sync') so the real client drops in
// without touching the feeder.
//
// TODO(real client): implement KubeEndpointsSource over @kubernetes/client-node
// (an informer on EndpointSlices or pods of the StatefulSet: list+watch with
// resourceVersion resume; pod.metadata.deletionTimestamp -> deleting,
// readiness condition -> ready). It is NOT a dependency of this skeleton —
// the fake below is the only implementation until the kind/minikube stand.

// ============== port contract ==============

export type KubePod = {
    /** Stable pod name — becomes the directory nodeId. */
    name: string
    /** Client-reachable origin for this pod. */
    url: string
    ready: boolean
    /** Set once deletionTimestamp appears; never reverses in K8s. */
    deleting?: boolean
    labels?: Record<string, string>
}

export type KubeEndpointsEvent = {
    /** 'sync' carries the FULL pod list; 'update'/'delete' carry only the affected pods. */
    type: 'sync' | 'update' | 'delete'
    pods: KubePod[]
}

export type KubeEndpointsSource = {
    list(): Promise<KubePod[]>
    /** Streams changes AFTER list(); the caller lists first (informer discipline). */
    watch(cb: (ev: KubeEndpointsEvent) => void): () => void
}

// ============== in-memory fake for the self-check ==============

export function createFakeKubeApi(initial: KubePod[] = []) {
    const pods = new Map<string, KubePod>()
    for (const pod of initial) pods.set(pod.name, {...pod})
    const watchers = new Set<(ev: KubeEndpointsEvent) => void>()

    function emit(ev: KubeEndpointsEvent) {
        for (const cb of [...watchers]) cb(ev)
    }

    function snapshot() {
        return [...pods.values()].map(function copyPod(pod) { return {...pod} })
    }

    const source: KubeEndpointsSource = {
        async list() { return snapshot() },
        watch(cb) {
            watchers.add(cb)
            return function offWatch() { watchers.delete(cb) }
        },
    }

    function mutate(name: string, patch: Partial<KubePod>) {
        const pod = pods.get(name)
        if (!pod) return false
        const next = {...pod, ...patch, name}
        pods.set(name, next)
        emit({type: 'update', pods: [{...next}]})
        return true
    }

    return {
        source,
        control: {
            addPod(pod: KubePod) {
                pods.set(pod.name, {...pod})
                emit({type: 'update', pods: [{...pod}]})
            },
            setReady(name: string, ready: boolean) { return mutate(name, {ready}) },
            markDeleting(name: string) { return mutate(name, {deleting: true}) },
            deletePod(name: string) {
                const pod = pods.get(name)
                if (!pod) return false
                pods.delete(name)
                emit({type: 'delete', pods: [{...pod}]})
                return true
            },
            /** Remove WITHOUT an event — models a watch gap; only a later resync reconciles it. */
            dropPod(name: string) { return pods.delete(name) },
            /** Full-list resync, as a real informer relist would deliver. */
            resync() { emit({type: 'sync', pods: snapshot()}) },
        },
    }
}
export type FakeKubeApi = ReturnType<typeof createFakeKubeApi>
