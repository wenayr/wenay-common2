import {createSocket, RemoteInfo} from 'node:dgram'
import {randomBytes} from 'node:crypto'
import {listen} from '../../src/Common/events/Listen'
import {createDiscoverySourceRegistry} from './discovery-source'
import {
    DiscoveryAdvertisement,
    DiscoveryEndpoint,
    DiscoveryQuality,
} from './discovery-types'
import {normalizeDiscoveryAdvertisement} from './discovery-validation'

export type UdpDiscoveryTarget = {
    address: string
    port: number
}

export type UdpLocalAdvertisement = {
    endpoints: readonly DiscoveryEndpoint[]
    degree?: number
    minDegree?: number
    capacity?: number
    quality?: DiscoveryQuality
    diversityKeys?: readonly string[]
    reachable?: readonly string[]
    paths?: readonly (readonly string[])[]
}

export type UdpLanDiscoveryDeps = {
    networkId: string
    peerId: string
    instanceId?: string
    local: () => UdpLocalAdvertisement
    sourceId?: string
    trust?: number
    ttlMs?: number
    announceIntervalMs?: number
    sweepIntervalMs?: number
    maxDatagramBytes?: number
    maxRemoteTtlMs?: number
    bindAddress?: string
    bindPort?: number
    targets?: readonly UdpDiscoveryTarget[]
    multicast?: false | {
        group?: string
        port?: number
        interface?: string
        ttl?: number
    }
    now?: () => number
}

type UdpAnnounceMessage = {
    protocol: 1
    kind: 'announce'
    advertisement: DiscoveryAdvertisement
}

type UdpByeMessage = {
    protocol: 1
    kind: 'bye'
    networkId: string
    peerId: string
    instanceId: string
    revision: number
}

type UdpDiscoveryMessage = UdpAnnounceMessage | UdpByeMessage

const MAX_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000

function requiredId(value: unknown, label: string) {
    if (typeof value != 'string' || !value.trim()) throw new Error('udp discovery: ' + label + ' is required')
    return value.trim()
}

function finiteNonNegative(value: unknown, label: string) {
    if (typeof value != 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error('udp discovery: ' + label + ' must be a non-negative finite number')
    }
    return value
}

function portNumber(value: unknown, label: string, allowZero = false) {
    const numberValue = finiteNonNegative(value, label)
    if (!Number.isInteger(numberValue) || numberValue > 65535 || !allowZero && numberValue < 1) {
        throw new Error('udp discovery: invalid ' + label)
    }
    return numberValue
}

function normalizeTarget(value: UdpDiscoveryTarget) {
    return {
        address: requiredId(value.address, 'target address'),
        port: portNumber(value.port, 'target port'),
    }
}

function encodeMessage(message: UdpDiscoveryMessage, maxBytes: number) {
    const bytes = Buffer.from(JSON.stringify(message))
    if (bytes.length > maxBytes) throw new Error('udp discovery: datagram exceeds ' + maxBytes + ' bytes')
    return bytes
}

function observationKey(peerId: string, instanceId: string) {
    return JSON.stringify([peerId, instanceId])
}

export async function createUdpLanDiscovery(deps: UdpLanDiscoveryDeps) {
    const now = deps.now ?? Date.now
    const networkId = requiredId(deps.networkId, 'networkId')
    const peerId = requiredId(deps.peerId, 'peerId')
    const instanceId = deps.instanceId == undefined
        ? peerId + '-' + randomBytes(6).toString('hex')
        : requiredId(deps.instanceId, 'instanceId')
    const ttlMs = finiteNonNegative(deps.ttlMs ?? 7000, 'ttlMs')
    const announceIntervalMs = finiteNonNegative(deps.announceIntervalMs ?? 2000, 'announceIntervalMs')
    const sweepIntervalMs = finiteNonNegative(deps.sweepIntervalMs ?? 500, 'sweepIntervalMs')
    const maxDatagramBytes = portNumber(deps.maxDatagramBytes ?? 8192, 'maxDatagramBytes')
    const maxRemoteTtlMs = finiteNonNegative(deps.maxRemoteTtlMs ?? 30_000, 'maxRemoteTtlMs')
    if (!ttlMs || ttlMs > MAX_DISCOVERY_TTL_MS) throw new Error('udp discovery: ttlMs is out of range')
    if (!maxRemoteTtlMs || maxRemoteTtlMs > MAX_DISCOVERY_TTL_MS) {
        throw new Error('udp discovery: maxRemoteTtlMs is out of range')
    }
    const bindAddress = deps.bindAddress ?? '0.0.0.0'
    const multicast = deps.multicast === false ? null : {
        group: deps.multicast?.group ?? '239.255.42.99',
        port: portNumber(deps.multicast?.port ?? 41299, 'multicast port'),
        interface: deps.multicast?.interface,
        ttl: portNumber(deps.multicast?.ttl ?? 1, 'multicast ttl', true),
    }
    if (multicast && multicast.ttl > 255) throw new Error('udp discovery: multicast ttl cannot exceed 255')
    const bindPort = portNumber(deps.bindPort ?? multicast?.port ?? 0, 'bindPort', true)
    let targets = (deps.targets ?? (multicast ? [{address: multicast.group, port: multicast.port}] : [])).map(normalizeTarget)
    const registry = createDiscoverySourceRegistry({
        descriptor: {
            id: deps.sourceId ?? 'wifi-lan',
            kind: 'wifi-lan',
            trust: deps.trust ?? 0.4,
        },
        now,
    })
    const socket = createSocket({type: 'udp4', reuseAddr: true})
    const [emitError, errors] = listen<[Error]>()
    const revisions = new Map<string, number>()
    let localRevision = 0
    let closed = false
    let lastError: string | null = null

    function localAdvertisement() {
        const local = deps.local()
        return normalizeDiscoveryAdvertisement({
            protocol: 1,
            networkId,
            peerId,
            instanceId,
            revision: ++localRevision,
            ttlMs,
            ...local,
        })
    }

    // Fail before opening a socket if the local advertisement shape is already invalid.
    localAdvertisement()

    function sendBytes(bytes: Uint8Array) {
        if (closed || !targets.length) return Promise.resolve(false)
        return Promise.all(targets.map(target => new Promise<boolean>(function sendTarget(resolve) {
            try {
                socket.send(bytes, target.port, target.address, function sent(error) { resolve(!error) })
            } catch {
                resolve(false)
            }
        }))).then(results => results.some(Boolean))
    }

    function announce() {
        if (closed) return Promise.resolve(false)
        const message: UdpAnnounceMessage = {
            protocol: 1,
            kind: 'announce',
            advertisement: localAdvertisement(),
        }
        return sendBytes(encodeMessage(message, maxDatagramBytes))
    }

    function announceInBackground() {
        try {
            void announce().catch(function reportAnnounceFailure(error) {
                handleSocketError(error instanceof Error ? error : new Error(String(error)))
            })
        } catch (error) {
            handleSocketError(error instanceof Error ? error : new Error(String(error)))
        }
    }

    function handleAnnounce(message: UdpAnnounceMessage, remote: RemoteInfo) {
        const normalized = normalizeDiscoveryAdvertisement(message.advertisement)
        if (normalized.networkId != networkId || normalized.peerId == peerId && normalized.instanceId == instanceId) return
        const key = observationKey(normalized.peerId, normalized.instanceId)
        const previousRevision = revisions.get(key) ?? -1
        if (normalized.revision < previousRevision) return
        revisions.set(key, normalized.revision)
        const advertisement = {
            ...normalized,
            ttlMs: Math.min(normalized.ttlMs, maxRemoteTtlMs),
        }
        registry.control.upsert(advertisement, {address: remote.address, port: remote.port}, now())
    }

    function handleBye(message: UdpByeMessage) {
        if (message.networkId != networkId || typeof message.peerId != 'string' || typeof message.instanceId != 'string' ||
            !Number.isInteger(message.revision) || message.revision < 0) return
        const key = observationKey(message.peerId, message.instanceId)
        if (message.revision < (revisions.get(key) ?? -1)) return
        revisions.set(key, message.revision)
        registry.control.removePeer(message.peerId, message.instanceId)
    }

    function handleMessage(bytes: Buffer, remote: RemoteInfo) {
        if (closed || bytes.length > maxDatagramBytes) return
        try {
            const message = JSON.parse(bytes.toString('utf8')) as UdpDiscoveryMessage
            if (!message || message.protocol != 1) return
            if (message.kind == 'announce') handleAnnounce(message, remote)
            else if (message.kind == 'bye') handleBye(message)
        } catch {}
    }

    function handleSocketError(error: Error) {
        lastError = error.message
        emitError(error)
    }

    socket.on('message', handleMessage)
    try {
        await new Promise<void>(function bindSocket(resolve, reject) {
            function onError(error: Error) {
                socket.off('listening', onListening)
                reject(error)
            }
            function onListening() {
                socket.off('error', onError)
                resolve()
            }
            socket.once('error', onError)
            socket.once('listening', onListening)
            socket.bind(bindPort, bindAddress)
        })
        socket.on('error', handleSocketError)
        if (multicast) {
            socket.setMulticastTTL(multicast.ttl)
            socket.addMembership(multicast.group, multicast.interface)
        }
    } catch (error) {
        socket.removeAllListeners()
        try { socket.close() } catch {}
        registry.close()
        errors.close()
        throw error
    }

    const announceTimer = announceIntervalMs > 0
        ? setInterval(announceInBackground, announceIntervalMs)
        : null
    const sweepTimer = sweepIntervalMs > 0
        ? setInterval(function sweepUdpPeers() { registry.control.sweep() }, sweepIntervalMs)
        : null
    ;(announceTimer as any)?.unref?.()
    ;(sweepTimer as any)?.unref?.()
    await announce()

    return {
        source: registry.api,
        control: {
            announce,
            setTargets(next: readonly UdpDiscoveryTarget[]) {
                targets = next.map(normalizeTarget)
            },
        },
        view: {
            address: () => socket.address(),
            targets: () => targets.map(target => ({...target})),
            instanceId: () => instanceId,
            error: () => lastError,
        },
        events: {errors},
        async close() {
            if (closed) return
            const message: UdpByeMessage = {
                protocol: 1,
                kind: 'bye',
                networkId,
                peerId,
                instanceId,
                revision: ++localRevision,
            }
            await sendBytes(encodeMessage(message, maxDatagramBytes))
            closed = true
            if (announceTimer) clearInterval(announceTimer)
            if (sweepTimer) clearInterval(sweepTimer)
            registry.close()
            errors.close()
            await new Promise<void>(function closeSocket(resolve) { socket.close(function socketClosed() { resolve() }) })
        },
    }
}

export type UdpLanDiscovery = Awaited<ReturnType<typeof createUdpLanDiscovery>>
