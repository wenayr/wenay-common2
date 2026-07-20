// =====================================================================
// Node health — one reactive store aggregating stats() of local primitives
// =====================================================================
// Every distributed primitive already reports itself (follower status store,
// archiver stats, mesh path costs, conflate gate stats); this aggregates those
// ad-hoc shapes into ONE store: register(name, probe) + refresh() snapshots
// every probe into state.parts[name]. The store is ordinary — publish it with
// exposeStoreReplay and the ops panel of a cascade is the library's own
// mirroring (monitoring of the replication IS replication). Probes must return
// plain JSON-able data: it crosses the wire as store state.

import {createStore, StoreDrain} from './store'

export type NodeHealthState = {
    node: string
    startedTs: number
    refreshedTs: number
    parts: Record<string, unknown>
}

export type NodeHealthDeps = {
    node: string
    /** Auto-refresh period; omit = manual refresh() only. Timer is unref'ed. */
    intervalMs?: number
    now?: () => number
    drain?: StoreDrain
}

export function createNodeHealth(deps: NodeHealthDeps) {
    const {node, intervalMs, now = Date.now, drain} = deps
    const store = createStore<NodeHealthState>(
        {node, startedTs: now(), refreshedTs: 0, parts: {}},
        drain !== undefined ? {drain} : {},
    )
    const probes = new Map<string, () => unknown>()
    let closed = false
    /** Snapshot one probe (or all) into state.parts; a throwing probe records {error} and never breaks the rest. */
    function refresh(name?: string) {
        if (closed) return store.state
        for (const [key, probe] of probes) {
            if (name != null && key != name) continue
            try { store.state.parts[key] = probe() }
            catch (e) { store.state.parts[key] = {error: String((e as any)?.message ?? e)} }
        }
        store.state.refreshedTs = now()
        return store.state
    }
    /** Register a probe; sampled immediately and on every refresh(). Returns off (removes the part). */
    function register(name: string, probe: () => unknown) {
        probes.set(name, probe)
        refresh(name)
        return function offProbe() {
            if (probes.get(name) != probe) return
            probes.delete(name)
            delete store.state.parts[name]
        }
    }
    let timer: any = null
    if (intervalMs != null) {
        timer = setInterval(function refreshNodeHealth() { refresh() }, intervalMs)
        timer.unref?.()
    }
    return {
        /** The health store — expose with exposeStoreReplay / adopt into any cascade. */
        store,
        register,
        refresh,
        close() {
            closed = true
            if (timer) { clearInterval(timer); timer = null }
            probes.clear()
        },
    }
}
export type NodeHealth = ReturnType<typeof createNodeHealth>
