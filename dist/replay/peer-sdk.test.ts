// Acceptance oracle for the Peer SDK: the happy
// path "two accounts see each other's store and can promote to direct" in ~10
// user lines, over a real Socket.IO/RPC wire, NEXT TO legacy rpc keys on the
// same connection. Direct = fake WebRTC runtime (injected factory, as designed).
import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {RtcDataChannel, RtcPeerConnection} from '../src/Common/events/replay-index'
import {flushReactive} from '../src/Common/Observe/reactive'
import {createPeerClient, createPeerHost} from '../src/Common/peer/peer-index'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

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
        await delay(20)
    }
    throw new Error(`timeout: ${label}`)
}

// ============ fake in-proc WebRTC runtime (same shape as route-webrtc oracle) ============
function createFakeRtcNet() {
    let n = 0
    const pcs = new Map<string, any>()
    const stats = {ice: 0, channels: 0}
    function makeDcPair(): [RtcDataChannel, RtcDataChannel] {
        let closed = false
        function side(other: () => any): any {
            const me: any = {onopen: null, onmessage: null, onclose: null, onerror: null}
            me.send = (data: string) => { if (!closed) setTimeout(function deliverDc() { if (!closed) other().onmessage?.({data}) }, 0) }
            me.close = () => {
                if (closed) return
                closed = true
                setTimeout(function closeDc() { me.onclose?.(); other().onclose?.() }, 0)
            }
            return me
        }
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
            setRemoteDescription(d) { me.remote = d; tryConnect(me) },
            addIceCandidate() { stats.ice++ },
            close() { me.pendingDcs = [] },
            onicecandidate: null,
            ondatachannel: null,
        }
        me.pc = api
        pcs.set(id, me)
        return api
    }
    return {pc, stats}
}

type World = {cursor: {x: number, y: number}, name?: string}

async function main() {
    console.log('\n[peer-sdk] two accounts, real socket, legacy keys alongside')

    const rtcNet = createFakeRtcNet()

    // ================= SERVER: legacy object + peer fragment =================
    const host = createPeerHost()
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer)
    ioServer.on('connection', socket => {
        const account = String(socket.handshake.auth?.account)
        const peer = host.connection(account)
        const [disconnect, disconnectListen] = createListenPair<[]>()
        socket.on('disconnect', () => { disconnect(); peer.close() })
        createRpcServerAuto({
            socket: {emit: (key, data) => socket.emit(key, data), on: (key, cb) => socket.on(key, cb)},
            socketKey: 'app',
            object: {
                legacyHello: (name: string) => 'hello ' + name, // legacy code coexists, untouched
                peer: peer.fragment,
            },
            disconnectListen,
        })
    })
    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    const port = (httpServer.address() as AddressInfo).port

    async function connect(account: string) {
        const hub = createRpcClientHub(
            () => io(`http://127.0.0.1:${port}`, {transports: ['websocket'], forceNew: true, auth: {account}}),
            r => ({api: r<any>('app')}) as const,
        )
        const clients = await hub.setToken(null)
        await clients.api.readyStrict()
        return {func: clients.api.func, closeSocket: () => hub.socket?.disconnect?.()}
    }

    // ================= CLIENTS: the happy path =================
    const connA = await connect('a')
    const connB = await connect('b')
    const a = createPeerClient<World>({
        remote: connA.func.peer, account: 'a',
        initial: {cursor: {x: 0, y: 0}, name: 'alice'},
        rtc: rtcNet.pc, drain: 'micro',
    })
    const b = createPeerClient<World>({
        remote: connB.func.peer, account: 'b',
        initial: {cursor: {x: 100, y: 100}, name: 'bob'},
        rtc: rtcNet.pc, drain: 'micro',
    })
    const aSeenByB = b.peer('a')
    const bSeenByA = a.peer('b')
    await Promise.all([aSeenByB.ready, bSeenByA.ready])
    // ^^^ entire client-side happy path: connect + createPeerClient + peer()

    ok(await connA.func.legacyHello('world') == 'hello world', 'legacy rpc key works untouched on the same connection')
    await waitFor('initial mirrors', () => json(aSeenByB.store.state) == json(a.store.snapshot())
        && json(bSeenByA.store.state) == json(b.store.snapshot()))
    ok(true, 'b mirrors a via relay, a mirrors b symmetrically')

    a.store.state.cursor.x = 5
    await flushReactive(a.store.state)
    await waitFor('relay live patch', () => aSeenByB.store.state.cursor.x == 5)
    ok(aSeenByB.route() == 'relay', 'live updates flow while the route is relay')

    // ================= direct promotion =================
    const seqBefore = aSeenByB.seq()
    const res = await aSeenByB.promoteDirect()
    ok(res.ok && aSeenByB.route() == 'direct', 'b -> a promoted to direct via webrtc signaling')
    a.store.state.cursor.y = 7
    a.store.state.name = 'alice!'
    await flushReactive(a.store.state)
    await waitFor('direct live patch', () => aSeenByB.store.state.cursor.y == 7 && aSeenByB.store.state.name == 'alice!')
    ok(json(aSeenByB.store.state) == json(a.store.snapshot()), 'mirror converged over the direct channel')
    ok(aSeenByB.seq() > seqBefore, `same seq space across the hand-off: ${seqBefore} -> ${aSeenByB.seq()} (no keyframe reset)`)
    ok(bSeenByA.route() == 'relay', 'the other direction is independent and still on relay')

    // ================= server revoke -> relay fallback =================
    host.revoke('a|b', ['a', 'b'], 'policy change')
    await waitFor('revoke fallback', () => aSeenByB.state() == 'fallback')
    a.store.state.cursor.x = 9
    await flushReactive(a.store.state)
    await waitFor('relay resume after revoke', () => aSeenByB.store.state.cursor.x == 9)
    ok(json(aSeenByB.store.state) == json(a.store.snapshot()), 'server revoke: mirror keeps converging via relay, no gap')

    // ================= late joiner: relay keyframe without the owner republishing =================
    const connC = await connect('c')
    const c = createPeerClient<World>({
        remote: connC.func.peer, account: 'c',
        initial: {cursor: {x: -1, y: -1}}, drain: 'micro', // relay-only: no rtc
    })
    const aSeenByC = c.peer('a')
    await aSeenByC.ready
    ok(json(aSeenByC.store.state) == json(a.store.snapshot()), 'late joiner gets the folded keyframe from the relay journal')
    let directDenied = false
    try { await c.peer('b').promoteDirect() } catch { directDenied = true }
    ok(directDenied, 'relay-only client (no rtc factory) refuses promoteDirect loudly')

    // ================= teardown =================
    a.close(); b.close(); c.close()
    connA.closeSocket(); connB.closeSocket(); connC.closeSocket()
    host.close()
    ioServer.close()
    await new Promise<void>(resolve => httpServer.close(() => resolve()))

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
