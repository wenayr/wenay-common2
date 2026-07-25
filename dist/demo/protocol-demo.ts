// =====================================================================
// Demo-only wire observability — no diagnostic surface leaks into RPC API
// =====================================================================

import type {Socket} from 'socket.io-client'
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
    if ((caps & Caps.CB_BATCH) == Caps.CB_BATCH) names.push('CB_BATCH')
    if ((caps & Caps.COMPACT) == Caps.COMPACT) names.push('COMPACT')
    return names.length > 0 ? names.join(' + ') : 'plain JSON'
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
    let applicationPackets = 0
    let controlPackets = 0
    let storeSummary = 'waiting for Store schema'
    let legacyCallSummary = 'existing API call pending'
    let loggedClientCaps = false
    let loggedServerCaps = false

    compatibility.href = deps.legacyServer
        ? location.pathname
        : location.pathname + '?rpc=legacy-server'
    compatibility.textContent = deps.legacyServer
        ? 'Open current JSON peer'
        : 'Open current client ↔ legacy-server fallback'

    function render() {
        mode.textContent = mapSeen ? 'JSON-array RPC active' : 'negotiating…'
        mode.dataset.state = mapSeen ? 'live' : 'connecting'

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

        probeStage.textContent = 'No binary probe · application packets use JSON arrays'
        storeStage.textContent = `${storeSummary} · ${legacyCallSummary}`
        transportStage.textContent = `Socket.IO ${socketTransport}`
        traffic.textContent = `Application traffic: ${applicationPackets} JSON-array packet(s)`
            + ` · ${controlPackets} bootstrap/control array(s)`
    }

    function observeArray(direction: tWireDirection, packet: any[]) {
        const opcode = packet[0]
        if (applicationOpcodes.has(opcode)) {
            applicationPackets++
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

    function observe(direction: tWireDirection, packet: unknown) {
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

    function reportStore(_remote: WorkboardRemote['state'], replayMode: tStoreReplayMode) {
        storeSummary = `Store Replay ${replayMode.toUpperCase()} · sole wire`
        render()
    }

    function reportLegacyCall(serverTime: string) {
        legacyCallSummary = `existing serverTime() OK at ${serverTime.slice(11, 19)}`
        render()
    }

    render()
    return {attach, reportStore, reportLegacyCall}
}
