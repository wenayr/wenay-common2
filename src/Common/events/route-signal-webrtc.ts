// =====================================================================
// WebRTC signaling adapter over the existing socket/RPC control channel
// =====================================================================
// Step 9 of route-coordinator: signaling (offer/answer/ICE/session/revoke) flows
// over the ALREADY-EXISTING relay channel — hub port is {send, signals}, i.e.
// function + Listen, exactly what createRpcServerAuto exposes without modification.
// RTCPeerConnection itself is NOT in the library: connector takes a factory
// `rtc: () => RtcPeerConnection` (structural type, no lib.dom) — browser supplies
// `() => new RTCPeerConnection(cfg)`, Node uses werift/node-datachannel,
// tests use in-proc fake. Privacy: endpoint/session material is exposed
// only via authorize hook of HUB (server-side canExposeEndpoint point) — client-side
// coordinator policy remains advisory layer; server decides finally.

import {listen} from './Listen'
import {ReplayRemote} from './replay-wire'
import {RouteConnector, tConnectorState} from './route-coordinator'
import {channelReplayRemote, ReplayMessageChannel, serveReplayChannel} from './replay-channel'

// =====================================================================
// Signaling protocol
// =====================================================================

// call types travel over the SAME hub (peer-call): routing by `to` does not distinguish them,
// webrtc connectors filter by pair+type — no interference; server-side authorize
// sees them too (single point of server policy: endpoint material AND calls)
export type tSignalType = 'offer' | 'answer' | 'ice' | 'revoke' | 'close'
    | 'ring' | 'accept' | 'decline' | 'hangup'

export type SignalEnvelope = {
    type: tSignalType
    /** Symmetric pair key (RoutePairRef.key). */
    pair: string
    from: string
    to: string
    sdp?: string
    candidate?: unknown
    /** Opaque auth/session material: wire doesn't inspect, validates policy/accept. */
    session?: unknown
    reason?: string
}

/** Client view of signal port — what comes through rpc-projection. */
export type SignalPort = {
    /** false = server rejected (authorize/no peer) — direct doesn't even try. */
    send: (env: SignalEnvelope) => Promise<boolean | void> | boolean | void
    signals: {on: (cb: (env: SignalEnvelope) => void) => any}
}

/**
 * Server-side signal hub: routes envelopes between accounts.
 * register(account) -> port for this account; its {send, signals} form ready
 * for export via createRpcServerAuto (send = function, signals = Listen).
 * authorize — only point where endpoint/session material is allowed
 * to be exposed (canExposeEndpoint of server policy); from spoofing impossible.
 */
export function createSignalHub(deps: {authorize?: (env: SignalEnvelope) => boolean | Promise<boolean>} = {}) {
    const {authorize} = deps
    // Several browser tabs may share one account. Keep registration order and route
    // to the newest live port; when it closes, the previous port becomes active again.
    const ports = new Map<string, Array<(env: SignalEnvelope) => void>>()

    function register(account: string) {
        const [emit, signals] = listen<[SignalEnvelope]>()
        const accountPorts = ports.get(account) ?? []
        accountPorts.push(emit)
        ports.set(account, accountPorts)

        async function send(env: SignalEnvelope) {
            if (env == null || env.from != account) return false // spoofing cut off at entry
            if (authorize && !(await authorize(env))) return false
            const targets = ports.get(env.to)
            const target = targets?.[targets.length - 1]
            if (!target) return false
            target(env)
            return true
        }

        function close() {
            const accountPorts = ports.get(account)
            if (accountPorts) {
                const i = accountPorts.indexOf(emit)
                if (i >= 0) accountPorts.splice(i, 1)
                if (!accountPorts.length) ports.delete(account)
            }
            signals.close()
        }

        return {account, send, signals, close}
    }

    /** Server-side route revoke (policy changed): revoke to both sides of pair. */
    function revoke(pair: string, accounts: string[], reason?: string) {
        for (const account of accounts) {
            const accountPorts = ports.get(account)
            accountPorts?.[accountPorts.length - 1]?.({type: 'revoke', pair, from: '', to: account, reason})
        }
    }

    return {
        register,
        revoke,
        accounts: () => Array.from(ports.keys()),
        close() {
            ports.clear()
        },
    }
}

export type SignalHub = ReturnType<typeof createSignalHub>

// =====================================================================
// Structural WebRTC types — exactly the browser API part we
// touch; no lib.dom, so Node build and fakes work without casting.
// =====================================================================

export type RtcSessionDescription = {type: string, sdp?: string}

export type RtcDataChannel = {
    send: (data: string | ArrayBuffer | ArrayBufferView) => void
    close: () => void
    binaryType?: string
    onopen?: ((ev?: unknown) => void) | null
    onmessage?: ((ev: {data: unknown}) => void) | null
    onclose?: ((ev?: unknown) => void) | null
    onerror?: ((ev?: unknown) => void) | null
}

export type RtcPeerConnection = {
    createDataChannel: (label: string, opts?: unknown) => RtcDataChannel
    createOffer: () => Promise<RtcSessionDescription>
    createAnswer: () => Promise<RtcSessionDescription>
    setLocalDescription: (d: RtcSessionDescription) => Promise<unknown> | unknown
    setRemoteDescription: (d: RtcSessionDescription) => Promise<unknown> | unknown
    addIceCandidate: (c: unknown) => Promise<unknown> | unknown
    close: () => void
    onicecandidate?: ((ev: {candidate?: unknown}) => void) | null
    ondatachannel?: ((ev: {channel: RtcDataChannel}) => void) | null
}

/** ReplayMessageChannel over datachannel: sole owner of its handlers. */
export function channelFromDataChannel(dc: RtcDataChannel): ReplayMessageChannel {
    const msgCbs = new Set<(data: string) => void>()
    const binaryCbs = new Set<(data: Uint8Array) => void>()
    const closeCbs = new Set<() => void>()
    let closed = false
    dc.binaryType = 'arraybuffer'
    function fireClose() {
        if (closed) return
        closed = true
        for (const cb of Array.from(closeCbs)) cb()
    }
    dc.onmessage = function onDcMessage(ev) {
        if (typeof ev.data == 'string') {
            for (const cb of Array.from(msgCbs)) cb(ev.data)
            return
        }
        const data = ev.data instanceof ArrayBuffer
            ? new Uint8Array(ev.data)
            : ArrayBuffer.isView(ev.data)
                ? new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength)
                : null
        if (!data) return
        for (const cb of Array.from(binaryCbs)) cb(data)
    }
    dc.onclose = fireClose
    dc.onerror = fireClose // for replay-wire, channel error == line end, loud via onClose
    return {
        send: data => dc.send(data),
        sendBinary: data => dc.send(data),
        onMessage: cb => { msgCbs.add(cb); return () => msgCbs.delete(cb) },
        onBinaryMessage: cb => { binaryCbs.add(cb); return () => binaryCbs.delete(cb) },
        onClose: cb => { closeCbs.add(cb); return () => closeCbs.delete(cb) },
        close: () => { dc.close(); fireClose() },
    }
}

// =====================================================================
// Initiator: RouteConnector conducting offer/answer/ICE over signal port
// =====================================================================

export type WebRtcConnectorDeps = {
    port: SignalPort
    /** Runtime factory: browser `() => new RTCPeerConnection(cfg)`, Node werift etc. */
    rtc: () => RtcPeerConnection
    self: string
    peer: string
    /** Pair key (RoutePairRef.key) — filters envelopes by it. */
    pair: string
    /** Opaque session material in offer — validated by hub authorize hook and peer accept hook. */
    session?: unknown
    label?: string
    /** How long to wait for datachannel opening, ms. */
    openTimeoutMs?: number
}

/**
 * Direct-connector for coordinator: pure transport, no route logic.
 * open() runs offer/answer/ICE over signal port, waits for datachannel and
 * returns replay-wire over it. revoke/close over signaling and channel death
 * = onFail (coordinator itself falls back to relay).
 */
export function createWebRtcConnector<Z extends any[] = any[]>(deps: WebRtcConnectorDeps): RouteConnector<Z> {
    const {port, rtc, self, peer, pair, session, label = 'direct', openTimeoutMs = 10_000} = deps
    let state: tConnectorState = 'idle'
    let pc: RtcPeerConnection | null = null
    let channel: ReplayMessageChannel | null = null
    let offSignals: any = null
    let abortOpen: ((e: unknown) => void) | null = null
    let offerSent = false
    let remoteDescriptionReady = false
    const pendingLocalIce: unknown[] = []
    const pendingRemoteIce: unknown[] = []
    const [emitFail, failListen] = listen<[unknown]>()

    function teardown(next: tConnectorState) {
        state = next
        if (typeof offSignals == 'function') offSignals()
        else offSignals?.off?.()
        offSignals = null
        channel?.close?.()
        channel = null
        pc?.close()
        pc = null
    }

    function fail(reason: unknown) {
        if (state == 'closed' || state == 'failed') return
        // revoke/channel death DURING open must abort the wait loudly and immediately,
        // not leave the initiator waiting out openTimeoutMs
        const abort = abortOpen
        abortOpen = null
        teardown('failed')
        abort?.(reason instanceof Error ? reason : new Error(String(reason)))
        emitFail(reason)
    }

    async function open() {
        state = 'opening'
        const me = rtc()
        pc = me
        const dc = me.createDataChannel('replay')
        let openTimer: any = null
        const opened = new Promise<void>((resolve, reject) => {
            abortOpen = reject
            dc.onopen = () => resolve()
            openTimer = setTimeout(function webRtcOpenTimeout() {
                reject(new Error('webrtc direct open timeout: ' + pair))
            }, openTimeoutMs)
        })
        opened.catch(() => {}) // failure BEFORE await opened shouldn't give unhandled rejection from timer

        function sendLocalIce(candidate: unknown) {
            void port.send({type: 'ice', pair, from: self, to: peer, candidate})
        }

        async function acceptAnswer(sdp: string) {
            await me.setRemoteDescription({type: 'answer', sdp})
            if (pc != me) return
            remoteDescriptionReady = true
            while (pendingRemoteIce.length) {
                await me.addIceCandidate(pendingRemoteIce.shift())
                if (pc != me) return
            }
        }

        function acceptRemoteIce(candidate: unknown) {
            if (!remoteDescriptionReady) {
                pendingRemoteIce.push(candidate)
                return
            }
            void Promise.resolve(me.addIceCandidate(candidate)).catch(fail)
        }

        offSignals = port.signals.on(function onSignal(env: SignalEnvelope) {
            if (env == null || env.pair != pair || env.to != self || pc != me) return
            if (env.type == 'answer' && env.sdp != null) {
                void acceptAnswer(env.sdp).catch(fail)
                return
            }
            if (env.type == 'ice' && env.candidate != null) {
                acceptRemoteIce(env.candidate)
                return
            }
            if (env.type == 'revoke' || env.type == 'close') {
                fail(new Error('direct route ' + env.type + (env.reason ? ': ' + env.reason : '')))
            }
        })

        me.onicecandidate = function onIce(ev) {
            if (ev?.candidate != null) {
                // RTCIceCandidate — class instance: wire carries its JSON init,
                // else transport serialization might return empty object
                const c: any = ev.candidate
                const candidate = c?.toJSON ? c.toJSON() : c
                if (offerSent) sendLocalIce(candidate)
                else pendingLocalIce.push(candidate)
            }
        }

        try {
            const offer = await me.createOffer()
            await me.setLocalDescription(offer)
            const accepted = await port.send({type: 'offer', pair, from: self, to: peer, sdp: offer.sdp, session})
            // server didn't expose endpoint (authorize) or peer doesn't exist — direct fails
            if (accepted == false) throw new Error('signaling rejected offer (endpoint not exposed): ' + pair)
            offerSent = true
            while (pendingLocalIce.length) sendLocalIce(pendingLocalIce.shift())
            await opened
        } catch (e) {
            teardown('failed')
            throw e
        } finally {
            clearTimeout(openTimer)
            abortOpen = null
        }
        state = 'open'
        channel = channelFromDataChannel(dc)
        channel.onClose?.(function onDirectChannelDied() {
            if (state == 'open') fail(new Error('direct channel closed: ' + pair))
        })
        return channelReplayRemote<Z>(channel)
    }

    return {
        info: {label, kind: 'direct', binary: true, ordered: true, reliable: true},
        open,
        close() {
            if (state == 'closed') return
            void port.send({type: 'close', pair, from: self, to: peer})
            teardown('closed')
        },
        state: () => state,
        onFail: {on: cb => failListen.on(cb)},
    }
}

// =====================================================================
// Responder: accepts offers and provides replay-line to incoming datachannel
// =====================================================================

export type WebRtcAcceptDeps<Z extends any[]> = {
    port: SignalPort
    rtc: () => RtcPeerConnection
    self: string
    /** What to serve this pair: replay-wire (exposeReplay(...) fits as-is). null = rejection. */
    serve: (env: SignalEnvelope) => ReplayRemote<Z> | null | Promise<ReplayRemote<Z> | null>
    /** Validate session material on receive side (atop server authorize). */
    accept?: (env: SignalEnvelope) => boolean | Promise<boolean>
}

/**
 * Receive side of direct route: on offer creates peer connection,
 * answers with answer/ICE via same signal port and serves replay-wire
 * to incoming datachannel. Returns close() — tear down and stop accepting.
 */
export function acceptWebRtcDirect<Z extends any[] = any[]>(deps: WebRtcAcceptDeps<Z>) {
    const {port, rtc, self, serve, accept} = deps
    type Session = {
        pc: RtcPeerConnection
        stop: (() => void) | null
        remoteDescriptionReady: boolean
        pendingIce: unknown[]
    }
    const sessions = new Map<string, Session>() // `${pair}|${from}` — per session to initiator
    const pendingOffers = new Map<string, unknown[]>()
    let closed = false

    function dropSession(key: string) {
        const s = sessions.get(key)
        if (!s) return
        sessions.delete(key)
        s.stop?.()
        s.pc.close()
    }

    async function onOffer(env: SignalEnvelope) {
        const key = env.pair + '|' + env.from
        const pendingIce: unknown[] = []
        pendingOffers.set(key, pendingIce)
        let session: Session | null = null

        function currentOffer() {
            return pendingOffers.get(key) == pendingIce
        }

        try {
            if (accept && !(await accept(env))) {
                if (currentOffer()) {
                    void port.send({type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'offer rejected'})
                }
                return
            }
            if (!currentOffer()) return
            const source = await serve(env)
            if (!currentOffer()) return
            if (!source) {
                void port.send({type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'nothing to serve'})
                return
            }
            dropSession(key)
            if (!currentOffer()) return
            const pc = rtc()
            session = {pc, stop: null, remoteDescriptionReady: false, pendingIce}
            sessions.set(key, session)
            pendingOffers.delete(key)
            pc.ondatachannel = function onIncomingChannel(ev) {
                session!.stop = serveReplayChannel<Z>(source, channelFromDataChannel(ev.channel))
            }
            pc.onicecandidate = function onIce(ev) {
                if (ev?.candidate != null) {
                    const c: any = ev.candidate
                    void port.send({type: 'ice', pair: env.pair, from: self, to: env.from, candidate: c?.toJSON ? c.toJSON() : c})
                }
            }
            await pc.setRemoteDescription({type: 'offer', sdp: env.sdp})
            if (sessions.get(key) != session) return
            session.remoteDescriptionReady = true
            while (session.pendingIce.length) await pc.addIceCandidate(session.pendingIce.shift())
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            void port.send({type: 'answer', pair: env.pair, from: self, to: env.from, sdp: answer.sdp})
        } catch {
            if (session && sessions.get(key) == session) {
                dropSession(key)
                void port.send({type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'negotiation failed'})
            } else if (!session && currentOffer()) {
                void port.send({type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'negotiation failed'})
            }
        } finally {
            if (currentOffer()) pendingOffers.delete(key)
        }
    }

    const offSignals = port.signals.on(function onAcceptSignal(env: SignalEnvelope) {
        if (closed || env == null || env.to != self) return
        if (env.type == 'offer') { void onOffer(env); return }
        const key = env.pair + '|' + env.from
        if (env.type == 'ice' && env.candidate != null) {
            const session = sessions.get(key)
            if (!session) {
                pendingOffers.get(key)?.push(env.candidate)
                return
            }
            if (!session.remoteDescriptionReady) {
                session.pendingIce.push(env.candidate)
                return
            }
            void Promise.resolve(session.pc.addIceCandidate(env.candidate)).catch(() => dropSession(key))
            return
        }
        if (env.type == 'close' || env.type == 'revoke') {
            pendingOffers.delete(key)
            dropSession(key)
        }
    })

    return function closeAccept() {
        if (closed) return
        closed = true
        if (typeof offSignals == 'function') offSignals()
        else (offSignals as any)?.off?.()
        pendingOffers.clear()
        for (const key of Array.from(sessions.keys())) dropSession(key)
    }
}
