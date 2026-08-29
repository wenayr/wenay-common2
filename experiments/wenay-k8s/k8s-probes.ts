// =====================================================================
// K8s probes — readiness/liveness served from the createNodeHealth store
// =====================================================================
// The health store is the library's single aggregation point (every primitive
// registers a probe there); kubelet probes are just one more reader of it.
// The mapping is deliberately thin and honest:
//   livez  = the event loop answers at all. A failing DEPENDENCY must never
//            restart the pod — that is readiness's job, not liveness's.
//   readyz = refresh() completed and no part recorded the {error: string}
//            shape — which is exactly what createNodeHealth writes for a
//            throwing probe, i.e. the store's own definition of unhealthy.

import type {NodeHealth} from '../../src/Common/Observe/node-health'

/** Minimal (req, res) shape — satisfied by node:http ServerResponse and by test fakes. */
export type ProbeResponse = {statusCode: number, end(body?: string): void}

export type K8sProbesDeps = {
    health: Pick<NodeHealth, 'refresh'>
}

export function createK8sProbes(deps: K8sProbesDeps) {
    function failingParts(parts: Record<string, unknown>) {
        return Object.keys(parts).filter(function partFailed(name) {
            const part = parts[name] as {error?: unknown} | null
            return part != null && typeof part == 'object' && typeof part.error == 'string'
        })
    }

    function readyz(_req: unknown, res: ProbeResponse) {
        const state = deps.health.refresh()
        const failing = failingParts(state.parts)
        if (failing.length == 0) {
            res.statusCode = 200
            res.end('ok')
        } else {
            res.statusCode = 503
            res.end('not ready: ' + failing.join(', '))
        }
    }

    function livez(_req: unknown, res: ProbeResponse) {
        // reaching the closure and refreshing IS the liveness proof; content is ignored
        deps.health.refresh()
        res.statusCode = 200
        res.end('ok')
    }

    return {readyz, livez}
}
export type K8sProbes = ReturnType<typeof createK8sProbes>
