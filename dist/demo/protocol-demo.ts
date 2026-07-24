// =====================================================================
// Demo-only wire observability — no diagnostic surface leaks into RPC API
// =====================================================================

import type {Socket} from 'socket.io-client'
import {rpcMemberAvailable} from '../src/Common/events/transport-lifecycle'
import {inspectRpcBinaryEnvelope, RpcBinaryFrame} from '../src/Common/rcp/rpc-binary-envelope'
import {Caps} from '../src/Common/rcp/rpc-caps'
import {Pkt} from '../src/Common/rcp/rpc-protocol'
import type {tStoreReplayMode} from '../src/Common/Observe/store-replay'
import type {WorkboardRemote} from './workboard-contract'

type ProtocolDemoDeps = {
    element: (id: string) => HTMLElement
    log: (line: string) => void
    legacyServer: boolean
}

type tWireDirection = 'client' | 'server'

const applicationOpcodes = new Set<number>([
    Pkt.CALL,
    Pkt.RESP,
    Pkt.CB,
    Pkt.CB_END,
    Pkt.PIPE,
    Pkt.SHAPE,
    Pkt.CBV,
    Pkt.CB_BATCH,
])

function capNames(caps: number) {
    const names: string[] = []
    if ((caps & Caps.BINARY_SCHEMA) == Caps.BINARY_SCHEMA) names.push('BINARY_SCHEMA')
    if ((caps & Caps.BINARY) == Caps.BINARY) names.push('BINARY')
    if ((caps & Caps.CB_BATCH) == Caps.CB_BATCH) names.push('CB_BATCH')
    if ((caps & Caps.COMPACT) == Caps.COMPACT) names.push('COMPACT')
    return names.length > 0 ? names.join(' + ') : 'legacy only'
}

function selectedStoreCodec(remote: WorkboardRemote['state'], mode: tStoreReplayMode) {
    if (mode != 'batch' || !rpcMemberAvailable(remote, 'batch')) return 'per-patch legacy'
    const batch = (remote as any).batch
    for (const version of ['v6', 'v5', 'v4', 'v3', 'v2']) {
        if (rpcMemberAvailable(batch, version)) return version
    }
    return 'v1'
}

function wireByteLength(value: unknown) {
    if (value instanceof ArrayBuffer) return value.byteLength
    if (ArrayBuffer.isView(value)) return value.byteLength
    return 0
}

export function createProtocolDemo(deps: ProtocolDemoDeps) {
    const mode = deps.element('protocolMode')
    const clientStage = deps.element('protocolClient')
    const serverStage = deps.element('protocolServer')
    const probeStage = deps.element('protocolProbe')
    const storeStage = deps.element('protocolStore')
    const transportStage = deps.element('protocolTransport')
    const traffic = deps.element('protocolTraffic')
    const compatibility = deps.element('protocolCompatibility') as HTMLAnchorElement

    let socketTransport = 'connecting'
    let clientCaps: number | null = null
    let serverCaps: number | null = null
    let sessionId: number | null = null
    let serverGeneration: number | null = null
    let mapSeen = false
    let probeSent = false
    let probeAcknowledged = false
    let binaryVersion: number | null = null
    let schemaPreludeBytes = 0
    let binaryFrames = 0
    let binaryBytes = 0
    let legacyApplicationPackets = 0
    let controlPackets = 0
    let storeSummary = 'waiting for Store schema'
    let legacyCallSummary = 'existing API call pending'
    let loggedClientCaps = false
    let loggedServerCaps = false
    let loggedProbe = false

    compatibility.href = deps.legacyServer
        ? location.pathname
        : location.pathname + '?rpc=legacy-server'
    compatibility.textContent = deps.legacyServer
        ? 'Open current binary peer'
        : 'Open new client ↔ legacy-server fallback'

    function render() {
        const binaryReady = probeAcknowledged
            && clientCaps != null && serverCaps != null
            && (clientCaps & serverCaps & Caps.BINARY) == Caps.BINARY
        const legacyReady = mapSeen && !binaryReady

        if (binaryReady) {
            mode.textContent = `RPB/${binaryVersion ?? '?'} binary active`
            mode.dataset.state = 'live'
        } else if (legacyReady) {
            mode.textContent = 'legacy arrays · compatible fallback'
            mode.dataset.state = 'fallback'
        } else {
            mode.textContent = 'negotiating…'
            mode.dataset.state = 'connecting'
        }

        clientStage.textContent = clientCaps == null
            ? 'waiting for client CAPS'
            : `CAPS ${clientCaps}: ${capNames(clientCaps)}`
                + (sessionId == null ? '' : ` · session ${sessionId}`)

        serverStage.textContent = serverCaps == null
            ? mapSeen && deps.legacyServer
                ? 'no CAPS · old-server behavior confirmed'
                : 'waiting for server CAPS'
            : `CAPS ${serverCaps}: ${capNames(serverCaps)}`
                + (serverGeneration == null ? '' : ` · generation ${serverGeneration}`)

        probeStage.textContent = probeAcknowledged
            ? `RPB/${binaryVersion ?? '?'} byte probe acknowledged`
                + (binaryVersion == 2 ? ` · schemas ahead: ${schemaPreludeBytes} B` : '')
            : probeSent
                ? 'byte probe sent · waiting for ACK'
                : mapSeen && serverCaps == null
                    ? 'not sent · peer did not advertise BINARY'
                    : 'waiting for intersected capabilities'

        storeStage.textContent = `${storeSummary} · ${legacyCallSummary}`
        transportStage.textContent = `Socket.IO ${socketTransport}`
        traffic.textContent = `Application traffic: ${binaryFrames} binary frame(s), ${binaryBytes.toLocaleString()} bytes`
            + ` · ${legacyApplicationPackets} legacy array packet(s)`
            + ` · ${controlPackets} bootstrap/control array(s)`
    }

    function observeArray(direction: tWireDirection, packet: any[]) {
        const opcode = packet[0]
        if (applicationOpcodes.has(opcode)) {
            legacyApplicationPackets++
            render()
            return
        }
        controlPackets++
        if (opcode == Pkt.MAP && direction == 'server') mapSeen = true
        if (opcode == Pkt.CAPS) {
            const announced = typeof packet[1] == 'number' ? packet[1] : 0
            if (direction == 'client') {
                clientCaps = announced
                if (Number.isSafeInteger(packet[2])) sessionId = packet[2]
                if (!loggedClientCaps) {
                    loggedClientCaps = true
                    deps.log(`handshake: client presents CAPS ${announced} (${capNames(announced)})`)
                }
            } else {
                serverCaps = announced
                if (Number.isSafeInteger(packet[3])) serverGeneration = packet[3]
                if (!loggedServerCaps) {
                    loggedServerCaps = true
                    deps.log(`handshake: server presents CAPS ${announced} (${capNames(announced)})`)
                }
            }
        }
        render()
    }

    function observeBinary(direction: tWireDirection, packet: unknown) {
        try {
            const envelope = inspectRpcBinaryEnvelope(packet)
            if (!envelope) return false
            if (envelope.kind == RpcBinaryFrame.PROBE) {
                probeSent = true
                sessionId = envelope.sessionId
                binaryVersion = envelope.version
                schemaPreludeBytes += envelope.payload.byteLength
            } else if (envelope.kind == RpcBinaryFrame.PROBE_ACK) {
                probeAcknowledged = true
                sessionId = envelope.sessionId
                binaryVersion = envelope.version
                schemaPreludeBytes += envelope.payload.byteLength
                if (!loggedProbe) {
                    loggedProbe = true
                    deps.log(
                        `handshake: RPB/${envelope.version} byte probe acknowledged`
                        + (envelope.version == 2
                            ? `; ${schemaPreludeBytes} schema-prelude bytes exchanged before data`
                            : '')
                        + '; application packets are binary',
                    )
                }
            } else {
                binaryFrames++
                binaryBytes += wireByteLength(packet)
            }
            render()
            return true
        } catch (error) {
            deps.log(`handshake observer ignored malformed ${direction} binary frame: ${String(error)}`)
            return true
        }
    }

    function observe(direction: tWireDirection, packet: unknown) {
        if (observeBinary(direction, packet)) return
        if (Array.isArray(packet)) observeArray(direction, packet)
    }

    function watchEngine(socket: Socket) {
        const engine = (socket.io as any).engine
        if (!engine) return
        socketTransport = engine.transport?.name ?? socketTransport
        engine.on('upgrade', function observeTransportUpgrade(next: {name?: string}) {
            socketTransport = next?.name ?? engine.transport?.name ?? socketTransport
            render()
        })
        render()
    }

    function attach(socket: Socket) {
        socket.onAnyOutgoing(function observeOutgoing(event: string, packet: unknown) {
            if (event == 'app') observe('client', packet)
        })
        socket.onAny(function observeIncoming(event: string, packet: unknown) {
            if (event == 'app') observe('server', packet)
        })
        socket.on('connect', function observeSocketConnect() {
            watchEngine(socket)
        })
        socket.on('disconnect', function observeSocketDisconnect() {
            socketTransport = 'disconnected'
            render()
        })
        watchEngine(socket)
        return socket
    }

    function reportStore(remote: WorkboardRemote['state'], replayMode: tStoreReplayMode) {
        const codec = selectedStoreCodec(remote, replayMode)
        storeSummary = replayMode == 'batch'
            ? `Store Replay batch · ${codec}`
                + (codec == 'v6' ? ' universal schema' : codec == 'v5' ? ' binary' : '')
            : 'Store Replay per-patch legacy'
        render()
    }

    function reportLegacyCall(serverTime: string) {
        legacyCallSummary = `existing serverTime() OK at ${serverTime.slice(11, 19)}`
        render()
    }

    render()
    return {attach, reportStore, reportLegacyCall}
}
