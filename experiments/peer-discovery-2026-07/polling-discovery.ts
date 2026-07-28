import {listen} from '../../src/Common/events/Listen'
import {createDiscoverySourceRegistry} from './discovery-source'
import {DiscoveryAdvertisement, DiscoverySourceDescriptor} from './discovery-types'
import {normalizeDiscoveryAdvertisement} from './discovery-validation'

export type PollingDiscoveryDeps = {
    descriptor: DiscoverySourceDescriptor
    load: () => readonly DiscoveryAdvertisement[] | Promise<readonly DiscoveryAdvertisement[]>
    intervalMs?: number
    now?: () => number
}

function errorText(error: unknown) {
    if (typeof (error as any)?.message == 'string') return (error as any).message
    return String(error)
}

export function createPollingDiscovery(deps: PollingDiscoveryDeps) {
    const now = deps.now ?? Date.now
    const intervalMs = deps.intervalMs ?? 30_000
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
        throw new Error('polling discovery: intervalMs must be a non-negative finite number')
    }
    const registry = createDiscoverySourceRegistry({descriptor: deps.descriptor, now})
    const [emitStatus, statusChanges] = listen<[{refreshing: boolean, refreshedAt: number | null, error: string | null}]>()
    let status = {refreshing: false, refreshedAt: null as number | null, error: null as string | null}
    let closed = false
    let generation = 0
    let pending: Promise<boolean> | null = null

    function publishStatus() {
        emitStatus({...status})
    }

    function refresh() {
        if (closed) return Promise.resolve(false)
        if (pending) return pending
        const currentGeneration = generation
        status = {...status, refreshing: true, error: null}
        publishStatus()
        pending = Promise.resolve().then(deps.load).then(function applyDirectory(advertisements) {
            if (closed || currentGeneration != generation) return false
            const seenAt = now()
            const observations = advertisements.map(function toObservation(value) {
                const advertisement = normalizeDiscoveryAdvertisement(value)
                return {
                    id: JSON.stringify([advertisement.peerId, advertisement.instanceId]),
                    advertisement,
                    seenAt,
                    expiresAt: seenAt + advertisement.ttlMs,
                }
            })
            registry.control.replace(observations)
            status = {refreshing: false, refreshedAt: seenAt, error: null}
            publishStatus()
            return true
        }, function directoryFailed(error) {
            if (closed || currentGeneration != generation) return false
            status = {...status, refreshing: false, error: errorText(error)}
            publishStatus()
            return false
        }).finally(function clearPending() {
            if (currentGeneration == generation) pending = null
        })
        return pending
    }

    const timer = intervalMs > 0 ? setInterval(function refreshDiscoveryDirectory() { void refresh() }, intervalMs) : null
    ;(timer as any)?.unref?.()
    const ready = refresh()

    return {
        source: registry.api,
        control: {refresh},
        view: {
            status: () => ({...status}),
        },
        events: {statusChanges},
        ready,
        close() {
            if (closed) return
            closed = true
            generation++
            pending = null
            if (timer) clearInterval(timer)
            registry.close()
            statusChanges.close()
        },
    }
}

export type PollingDiscovery = ReturnType<typeof createPollingDiscovery>
