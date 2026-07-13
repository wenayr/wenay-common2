// Acceptance oracle for step 9 (webrtc-route-coordinator-tasks): signaling
// adapter (offer/answer/ICE/session/revoke) over the existing control channel +
// WebRTC direct connector under createRouteCoordinator. RTCPeerConnection is
// faked in-process (the runtime factory is injected by design); the second
// section drives the SAME signaling over a real Socket.IO/RPC wire.
import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {
    acceptWebRtcDirect, createRouteCoordinator, createSignalHub, createWebRtcConnector,
    exposeReplay, replayListen, RouteConnector, RtcDataChannel, RtcPeerConnection,
    SignalPort, tConnectorState,
} from '../src/Common/events/replay-index'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import {decodeMediaFrame, encodeMediaFrame} from '../src/Common/media/media-source'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const json = (v: any) => JSON.stringify(v)

async function waitFor(label: string, cond: () => boolean) {
    for (let i = 0; i < 200; i++) {
        if (cond()) return
        await delay(15)
    }
    throw new Error(`timeout: ${label}`)
}

// =====================================================================
// Fake in-process WebRTC runtime: SDP = pc id, ICE trickle simulated,
// datachannel = paired in-proc endpoints. Injected exactly like a browser
// would inject () => new RTCPeerConnection(cfg).
// =====================================================================

function createFakeRtcNet() {
    let n = 0
    const pcs = new Map<string, any>()
    const stats = {ice: 0, channels: 0}

    function makeDcPair(): [RtcDataChannel, RtcDataChannel] {
        let closed = false
        function side(other: () => any): any {
            const me: any = {onopen: null, onmessage: null, onclose: null, onerror: null}
            me.send = (data: string) => {
                if (closed) return
                setTimeout(function deliverDc() { if (!closed2()) other().onmessage?.({data}) }, 0)
            }
            me.close = () => {
                if (closed) return
                closed = true
                setTimeout(function closeDc() { me.onclose?.(); other().onclose?.() }, 0)
            }
            return me
        }
        const closed2 = () => closed
        let a: any, b: any
        a = side(() => b)
        b = side(() => a)
        return [a, b]
    }

    function tryConnect(me: any) {
        if (!me.local || !me.remote) return
        const other = pcs.get(me.remote.sdp)
        if (!other || !other.local || !other.remote || other.remote.sdp != me.id) return
        const initiator = me.pendingDcs.length ? me : other
        const responder = initiator == me ? other : me
        if (!initiator.pendingDcs.length || initiator.linked) return
        initiator.linked = responder.linked = true
        for (const dc of initiator.pendingDcs) {
            const [a, b] = makeDcPair()
            // связываем заранее созданный локальный конец с новорождённым твином
            dc.attach(a)
            stats.channels++
            setTimeout(function announceChannel() {
                responder.pc.ondatachannel?.({channel: b})
                dc.fireOpen()
            }, 0)
        }
        initiator.pendingDcs = []
    }

    function pc(): RtcPeerConnection {
        const id = 'sdp-' + (++n)
        const me: any = {id, local: null, remote: null, pendingDcs: [], linked: false}
        const api: RtcPeerConnection = {
            createDataChannel() {
                // локальный конец создаётся ДО соединения: методы делегируются после attach
                let real: any = null
                const shell: any = {onopen: null, onmessage: null, onclose: null, onerror: null}
                shell.send = (data: string) => real?.send(data)
                shell.close = () => real?.close()
                me.pendingDcs.push({
                    attach(a: any) {
                        real = a
                        if (!a) return
                        a.onmessage = (ev: any) => shell.onmessage?.(ev)
                        a.onclose = () => shell.onclose?.()
                    },
                    fireOpen() { shell.onopen?.() },
                })
                return shell
            },
            createOffer: async () => ({type: 'offer', sdp: id}),
            createAnswer: async () => ({type: 'answer', sdp: id}),
            setLocalDescription(d) {
                me.local = d
                setTimeout(function trickleIce() { api.onicecandidate?.({candidate: {via: id}}) }, 0)
            },
            setRemoteDescription(d) {
                me.remote = d
                tryConnect(me)
            },
            addIceCandidate() { stats.ice++ },
            close() {
                for (const dc of me.pendingDcs) dc.attach?.(null)
                me.pendingDcs = []
            },
            onicecandidate: null,
            ondatachannel: null,
        }
        me.pc = api
        pcs.set(id, me)
        return api
    }

    return {pc, stats}
}

// простой relay-коннектор: прямой доступ к журналу с лагом (как в route-coordinator оракуле)
function makeRelayConnector<Z extends any[]>(replay: any, lag = 5): RouteConnector<Z> {
    let state: tConnectorState = 'idle'
    return {
        info: {label: 'relay', kind: 'relay', ordered: true, reliable: true},
        open: async () => {
            state = 'opening'
            await delay(lag)
            state = 'open'
            return {
                line: {on: (cb: any) => replay.line.on(cb)},
                since: async (s: number) => { await delay(lag); return replay.getSince(s) ?? null },
                keyframe: async () => { await delay(lag); return replay.keyframe() ?? null },
                frame: async (s: number, hint?: unknown) => { await delay(lag); return replay.frame(s, hint) },
            }
        },
        close: () => { state = 'closed' },
        state: () => state,
    }
}

async function main() {
    console.log('\n[route-webrtc] in-proc signaling hub: offer/answer/ICE/session/revoke')
    {
        let state = 0
        const [emit, replay] = replayListen<[number]>({current: () => [state], history: 100})
        const envLog: string[] = []
        let allowDirect = true
        const hub = createSignalHub({authorize: env => { envLog.push(env.type); return allowDirect }})
        const portA = hub.register('a')
        const portB = hub.register('b')
        const rtcNet = createFakeRtcNet()
        const sess = {token: 'good'}
        const stopAccept = acceptWebRtcDirect<[number]>({
            port: portB,
            rtc: rtcNet.pc,
            self: 'b',
            serve: () => exposeReplay(replay),
            accept: env => (env.session as any)?.token == 'good',
        })

        const coord = createRouteCoordinator<[number]>({
            connect: (ref, kind) => kind == 'relay'
                ? makeRelayConnector<[number]>(replay)
                : createWebRtcConnector<[number]>({
                    port: portA, rtc: rtcNet.pc, self: 'a', peer: 'b',
                    pair: ref.key, session: sess, openTimeoutMs: 1500,
                }),
        })
        const link = coord.pair('a', 'b')
        const got: number[] = []
        const sub = link.subscribe(v => got.push(v))
        await sub.ready
        ok(json(got) == json([0]), 'relay baseline delivers the keyframe')

        state = 1; emit(state)
        const res = await link.promoteDirect()
        ok(res.ok && link.state() == 'direct', 'promotion over webrtc signaling lands in direct')
        ok(envLog.includes('offer') && envLog.includes('answer') && envLog.includes('ice'), `hub authorized offer/answer/ice (${json(envLog)})`)
        ok(rtcNet.stats.ice > 0 && rtcNet.stats.channels == 1, 'ICE exchanged and exactly one datachannel established')
        state = 2; emit(state)
        state = 3; emit(state)
        await waitFor('datachannel live events', () => got.length >= 4)
        ok(json(got) == json([0, 1, 2, 3]), 'replay wire over the datachannel is gap-free and dup-free')

        // A direct media route uses the same replay wire. Binary frames must stay
        // Uint8Array end-to-end — JSON's default numeric-key object is unusable by Media.
        const mediaFrame = encodeMediaFrame({
            kind: 'video-frame', codec: 'jpeg', seq: 4, tMono: 40, width: 2, height: 2,
        }, new Uint8Array([77, 101, 100, 105, 97]))
        emit(mediaFrame as any)
        await waitFor('binary frame over datachannel', () => got.length >= 5)
        const deliveredFrame = got[4] as any
        const decodedFrame = deliveredFrame instanceof Uint8Array ? decodeMediaFrame(deliveredFrame) : null
        ok(decodedFrame?.kind == 'video-frame' && json([...decodedFrame.payload]) == json([77, 101, 100, 105, 97]),
            'direct replay preserves an encoded Media Uint8Array frame byte-for-byte')

        // server-side revoke: policy изменилась — direct закрывается, relay продолжает с seq
        hub.revoke(link.ref.key, ['a', 'b'], 'policy change')
        await waitFor('revoke fallback', () => link.state() == 'fallback')
        state = 4; emit(state)
        await waitFor('relay after revoke', () => got.includes(4))
        ok(json(got.filter(v => typeof v == 'number')) == json([0, 1, 2, 3, 4]), 'server revoke: relay resumes from seq, no gap')

        // сервер не раскрывает endpoint: offer отклонён ДО транспорта
        allowDirect = false
        const denied = await link.promoteDirect()
        ok(!denied.ok && String(denied.reason).includes('endpoint'), 'hub authorize=false: offer rejected, direct not established')
        ok(link.state() == 'fallback', 'denied endpoint leaves the pair on relay (fallback)')

        // приёмная сторона бракует session-материал: revoke вместо таймаута
        allowDirect = true
        sess.token = 'bad'
        const badSession = await link.promoteDirect()
        ok(!badSession.ok && String(badSession.reason).includes('revoke'), `bad session material is rejected loudly by the peer (${String(badSession.reason)})`)

        // и после всех отказов пара всё ещё может подняться в direct
        sess.token = 'good'
        const retry = await link.promoteDirect()
        state = 5; emit(state)
        await waitFor('direct again', () => got.includes(5))
        ok(retry.ok && link.state() == 'direct' && json(got.filter(v => typeof v == 'number')) == json([0, 1, 2, 3, 4, 5]), 'pair recovers into direct after denials, still gap-free')

        coord.close()
        stopAccept()
        hub.close()
    }

    console.log('\n[route-webrtc] signaling over the EXISTING socket/RPC control channel')
    {
        let state = 0
        const [emit, replay] = replayListen<[number]>({current: () => [state], history: 100})
        const hub = createSignalHub()
        const rtcNet = createFakeRtcNet()

        // сервер: обычный createRpcServerAuto; сигнальный порт = {send, signals} на соединение
        const app = express()
        const httpServer = createServer(app)
        const ioServer = new SocketIOServer(httpServer)
        ioServer.on('connection', socket => {
            const account = String(socket.handshake.auth?.account)
            const port = hub.register(account)
            const [disconnect, disconnectListen] = createListenPair<[]>()
            socket.on('disconnect', () => { disconnect(); port.close() })
            createRpcServerAuto({
                socket: {emit: (key, data) => socket.emit(key, data), on: (key, cb) => socket.on(key, cb)},
                socketKey: 'signal',
                object: {send: port.send, signals: port.signals},
                disconnectListen,
            })
        })
        await new Promise<void>((resolve, reject) => {
            httpServer.once('error', reject)
            httpServer.listen(0, '127.0.0.1', resolve)
        })
        const port = (httpServer.address() as AddressInfo).port

        async function connectSignalPort(account: string): Promise<SignalPort & {closeSocket: () => void}> {
            const clientHub = createRpcClientHub(
                () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true, auth: {account}}),
                r => ({api: r<any>('signal')}) as const,
            )
            const clients = await clientHub.setToken(null)
            await clients.api.readyStrict()
            const deep = clients.api.func
            return {
                send: (env: any) => deep.send(env),
                signals: {on: (cb: any) => deep.signals.callback(cb)},
                closeSocket: () => clientHub.socket?.disconnect?.(),
            }
        }

        const portA = await connectSignalPort('a')
        const portB = await connectSignalPort('b')
        const stopAccept = acceptWebRtcDirect<[number]>({
            port: portB, rtc: rtcNet.pc, self: 'b', serve: () => exposeReplay(replay),
        })
        const coord = createRouteCoordinator<[number]>({
            connect: (ref, kind) => kind == 'relay'
                ? makeRelayConnector<[number]>(replay)
                : createWebRtcConnector<[number]>({
                    port: portA, rtc: rtcNet.pc, self: 'a', peer: 'b',
                    pair: ref.key, openTimeoutMs: 4000,
                }),
        })
        const link = coord.pair('a', 'b')
        const got: number[] = []
        const sub = link.subscribe(v => got.push(v))
        await sub.ready

        const res = await link.promoteDirect()
        ok(res.ok && link.state() == 'direct', 'promotion negotiated over a real Socket.IO/RPC signaling channel')
        state = 1; emit(state)
        state = 2; emit(state)
        await waitFor('live over datachannel (rpc-signaled)', () => got.length >= 3)
        ok(json(got) == json([0, 1, 2]), 'payload rides the direct channel, signaling rode the rpc wire')

        hub.revoke(link.ref.key, ['a', 'b'], 'server policy')
        await waitFor('revoke over rpc wire', () => link.state() == 'fallback')
        state = 3; emit(state)
        await waitFor('relay resume (rpc-signaled)', () => got.includes(3))
        ok(json(got) == json([0, 1, 2, 3]), 'revoke over the rpc wire falls back to relay with no gap')

        coord.close()
        stopAccept()
        portA.closeSocket()
        portB.closeSocket()
        hub.close()
        ioServer.close()
        await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
