import {listen} from '../../src/Common/events/Listen'
import {createDiscoverySourceRegistry} from './discovery-source'
import {
    DiscoveryAdvertisement,
    DiscoveryObservation,
    DiscoverySourceDescriptor,
} from './discovery-types'
import {normalizeDiscoveryAdvertisement} from './discovery-validation'

export type PlatformScannerHandlers = {
    found: (advertisement: DiscoveryAdvertisement, via?: DiscoveryObservation['via']) => void
    lost: (peerId: string, instanceId?: string) => void
    error: (error: unknown) => void
}

export type PlatformDiscoveryScanner = {
    start: (handlers: PlatformScannerHandlers) =>
        void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
}

export type ScannerDiscoveryDeps = {
    descriptor: DiscoverySourceDescriptor
    scanner: PlatformDiscoveryScanner
    now?: () => number
}

function toError(value: unknown) {
    return value instanceof Error ? value : new Error(String(value))
}

export async function createScannerDiscovery(deps: ScannerDiscoveryDeps) {
    const now = deps.now ?? Date.now
    const registry = createDiscoverySourceRegistry({descriptor: deps.descriptor, now})
    const [emitError, errors] = listen<[Error]>()
    let closed = false
    let stopScanner: void | (() => void | Promise<void>)

    const handlers: PlatformScannerHandlers = {
        found(value, via) {
            if (closed) return
            try {
                registry.control.upsert(normalizeDiscoveryAdvertisement(value), via, now())
            } catch (error) {
                emitError(toError(error))
            }
        },
        lost(peerId, instanceId) {
            if (!closed) registry.control.removePeer(peerId, instanceId)
        },
        error(error) {
            if (!closed) emitError(toError(error))
        },
    }

    try {
        stopScanner = await deps.scanner.start(handlers)
    } catch (error) {
        registry.close()
        errors.close()
        throw error
    }

    return {
        source: registry.api,
        events: {errors},
        async close() {
            if (closed) return
            closed = true
            try {
                await stopScanner?.()
            } finally {
                registry.close()
                errors.close()
            }
        },
    }
}

export type ScannerDiscovery = Awaited<ReturnType<typeof createScannerDiscovery>>
