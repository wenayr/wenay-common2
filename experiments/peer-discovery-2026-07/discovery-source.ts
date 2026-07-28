import {listen} from '../../src/Common/events/Listen'
import {
    DiscoveryAdvertisement,
    DiscoveryObservation,
    DiscoverySourceDescriptor,
} from './discovery-types'

export type DiscoverySourceRegistryDeps = {
    descriptor: DiscoverySourceDescriptor
    now?: () => number
}

function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

function requiredId(value: unknown, label: string) {
    if (typeof value != 'string' || !value.trim()) throw new Error('discovery source: ' + label + ' is required')
    return value.trim()
}

function finiteNonNegative(value: unknown, label: string) {
    if (typeof value != 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error('discovery source: ' + label + ' must be a non-negative finite number')
    }
    return value
}

function observationId(advertisement: DiscoveryAdvertisement) {
    return JSON.stringify([advertisement.peerId, advertisement.instanceId])
}

export function createDiscoverySourceRegistry(deps: DiscoverySourceRegistryDeps) {
    const now = deps.now ?? Date.now
    const descriptor = {
        id: requiredId(deps.descriptor.id, 'descriptor.id'),
        kind: deps.descriptor.kind,
        trust: finiteNonNegative(deps.descriptor.trust, 'descriptor.trust'),
    }
    if (descriptor.trust > 1) throw new Error('discovery source: descriptor.trust cannot exceed 1')
    const observations = new Map<string, DiscoveryObservation>()
    const [emitChanges, changes] = listen<[readonly DiscoveryObservation[]]>()
    let closed = false

    function publish() {
        emitChanges(Array.from(observations.values()))
    }

    function upsert(advertisement: DiscoveryAdvertisement, via?: DiscoveryObservation['via'], seenAt = now()) {
        if (closed) throw new Error('discovery source: closed')
        const id = observationId(advertisement)
        const stored: DiscoveryObservation = {
            id,
            advertisement,
            seenAt,
            expiresAt: seenAt + advertisement.ttlMs,
            via: via ? {...via} : undefined,
        }
        observations.set(id, stored)
        publish()
        return function removeThisObservation() {
            if (observations.get(id) != stored) return
            observations.delete(id)
            publish()
        }
    }

    function replace(next: readonly DiscoveryObservation[]) {
        if (closed) throw new Error('discovery source: closed')
        observations.clear()
        for (const observation of next) observations.set(requiredId(observation.id, 'observation.id'), observation)
        publish()
    }

    function sweep(at = now()) {
        let changed = false
        for (const [id, observation] of observations) {
            if (observation.expiresAt > at) continue
            observations.delete(id)
            changed = true
        }
        if (changed) publish()
        return changed
    }

    return {
        control: {
            upsert,
            replace,
            remove(id: string) {
                if (!observations.delete(id)) return false
                publish()
                return true
            },
            removePeer(peerId: string, instanceId?: string) {
                let changed = false
                for (const [id, observation] of observations) {
                    const advertisement = observation.advertisement
                    if (advertisement.peerId != peerId ||
                        instanceId != undefined && advertisement.instanceId != instanceId) continue
                    observations.delete(id)
                    changed = true
                }
                if (changed) publish()
                return changed
            },
            sweep,
            clear() {
                if (!observations.size) return
                observations.clear()
                publish()
            },
        },
        api: {
            descriptor,
            list: () => Array.from(observations.values()),
            changes,
        },
        close() {
            if (closed) return
            if (observations.size) {
                observations.clear()
                publish()
            }
            closed = true
            changes.close()
        },
    }
}

export type DiscoverySourceRegistry = ReturnType<typeof createDiscoverySourceRegistry>

export function followDiscoverySource(
    source: {list: () => readonly DiscoveryObservation[], changes: {on: (cb: (value: readonly DiscoveryObservation[]) => void) => any}},
    consume: (value: readonly DiscoveryObservation[]) => void,
) {
    const off = source.changes.on(function consumeDiscoveryChanges(value) { consume(value) })
    consume(source.list())
    return function stopFollowingDiscoverySource() { unsubscribeHandle(off) }
}
