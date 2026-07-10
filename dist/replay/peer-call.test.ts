// Acceptance oracle for the call system (ROADMAP "Call system" candidate):
// presence + ring/accept/decline/hangup over the EXISTING signal hub, media
// frames over the relay lines while the call is active — all on a real
// Socket.IO/RPC wire, next to the peer fragment, with zero new server routes
// beyond the fragment keys (presence) and the media relay object.
import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {createSignalHub, SignalEnvelope} from '../src/Common/events/route-signal-webrtc'
import {createPeerHost} from '../src/Common/peer/peer-host'
import {callPortOf, createCallManager} from '../src/Common/peer/peer-call'
import {createMediaRelay} from '../src/Common/peer/peer-media-relay'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function waitFor(label: string, cond: () => boolean) {
    for (let i = 0; i < 200; i++) {
        if (cond()) return
        await delay(20)
    }
    throw new Error(`timeout: ${label}`)
}

async function main() {
    console.log('\n[peer-call] presence + ring/accept/decline + media over the relay')

    // ================= lifecycle regressions (in-process, deterministic) =================
    const signalHub = createSignalHub()
    const firstA = signalHub.register('same')
    const newestA = signalHub.register('same')
    const sender = signalHub.register('sender')
    let firstHits = 0
    let newestHits = 0
    firstA.signals.on(() => firstHits++)
    newestA.signals.on(() => newestHits++)
    await sender.send({type: 'ring', pair: 'multi:1', from: 'sender', to: 'same'})
    newestA.close()
    const fallbackSent = await sender.send({type: 'ring', pair: 'multi:2', from: 'sender', to: 'same'})
    ok(newestHits == 1 && firstHits == 1 && fallbackSent == true,
        'closing the newest same-account signal port restores the previous live port')
    signalHub.close()

    const [emitLocalSignal, localSignals] = createListenPair<[SignalEnvelope]>()
    const localSends: SignalEnvelope[] = []
    const localCalls = createCallManager({
        self: 'callee',
        port: {
            signals: localSignals,
            send: function captureLocalSend(env) { localSends.push(env); return true },
        },
    })
    let localRings = 0
    localCalls.rings.on(() => localRings++)
    emitLocalSignal({type: 'ring', pair: 'call:x:1', from: 'x', to: 'callee'})
    emitLocalSignal({type: 'ring', pair: 'call:y:1', from: 'y', to: 'callee'})
    await delay(0)
    ok(localRings == 1 && localSends.some(env => env.type == 'decline' && env.reason == 'busy'),
        'back-to-back incoming rings reserve admission: one rings, one is busy')
    localCalls.close()

    // ================= SERVER: peer fragment + media relay, no call-specific code =================
    // Watch ACL as APP code: media access follows call state — the policy set is
    // maintained by the clients below on 'active'/'ended' (via a legacy-style rpc key).
    const allowedWatch = new Set<string>()
    const host = createPeerHost()
    const media = createMediaRelay({
        lines: {cam: 'video', mic: 'audio'},
        canWatch: (watcher, owner) => allowedWatch.has(watcher + '|' + owner),
    })
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
                peer: peer.fragment,
                media: {publish: media.publishOf(account), watch: media.watchOf(account)},
                // app-level grant hook (a real app would derive this from its own call registry)
                grantWatch: (a: string, b: string, on: boolean) => {
                    if (on) { allowedWatch.add(a + '|' + b); allowedWatch.add(b + '|' + a) }
                    else { allowedWatch.delete(a + '|' + b); allowedWatch.delete(b + '|' + a) }
                },
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

    const connA = await connect('a')
    const connB = await connect('b')

    // ================= presence =================
    const presenceLog: any[] = []
    connA.func.peer.presence.changes.on((ch: any) => presenceLog.push(ch))
    const online = await connA.func.peer.presence.list()
    ok(online.includes('a') && online.includes('b'), `presence list sees both accounts: ${JSON.stringify(online)}`)

    // ================= happy path: ring -> accept -> active =================
    const callsA = createCallManager({port: callPortOf(connA.func.peer), self: 'a'})
    const callsB = createCallManager({port: callPortOf(connB.func.peer), self: 'b'})
    await Promise.all([callsA.ready, callsB.ready])
    let ringAtB: any = null
    callsB.rings.on((h: any) => { ringAtB = h })

    const out = callsA.call('b', {kinds: ['cam', 'mic']})
    await waitFor('ring reaches b', () => ringAtB != null)
    ok(ringAtB.peer == 'a' && ringAtB.direction == 'in', 'incoming handle points back at the caller')
    ok(JSON.stringify(ringAtB.meta) == JSON.stringify({kinds: ['cam', 'mic']}), 'caller meta rides the ring envelope opaquely')
    ok(out.state() == 'ringing' && ringAtB.state() == 'ringing', 'both sides are ringing')

    // ================= watch ACL: denied OUTSIDE a call =================
    let deniedBefore = false
    try { await connB.func.media.watch.a.cam.keyframe() } catch { deniedBefore = true }
    ok(deniedBefore, 'watch is DENIED outside a call (canWatch gates path resolution)')

    ringAtB.accept()
    await waitFor('caller sees accept', () => out.state() == 'active')
    ok(callsB.active() == ringAtB && callsA.active() == out, 'both sides report the active call')

    // ================= media while active: grant -> publish -> relay line -> watcher =================
    await connA.func.grantWatch('a', 'b', true) // app code: access follows the call
    const got: any[] = []
    connB.func.media.watch.a.cam.on((frame: any, sentAt: number) => got.push([frame, sentAt]))
    await connA.func.media.publish('cam', new Uint8Array([1, 2, 3]), 12345)
    await waitFor('cam frame lands at b', () => got.length > 0)
    ok(got[0][1] == 12345, 'sentAt stamp rides along the media frame')
    const kf = await connB.func.media.watch.a.cam.keyframe()
    ok(kf != null && kf.event[1] == 12345, 'video line is keep-latest: a late joiner pulls the last frame via keyframe()')

    // ================= busy gate: third account calls into an active call =================
    const connC = await connect('c')
    const callsC = createCallManager({port: callPortOf(connC.func.peer), self: 'c'})
    await callsC.ready
    const cToB = callsC.call('b')
    ok(await cToB.ended == 'busy', 'default gate auto-declines with busy while b is on a call')
    let deniedThird = false
    try { await connC.func.media.watch.a.cam.keyframe() } catch { deniedThird = true }
    ok(deniedThird, 'a third account is still denied while a<->b are on a call')

    // ================= hangup: media access is revoked with the call =================
    out.hangup()
    await waitFor('callee sees hangup', () => ringAtB.state() == 'ended')
    ok(ringAtB.reason() == 'hangup' && await out.ended == 'hangup', 'hangup ends both sides with the reason')
    await connA.func.grantWatch('a', 'b', false) // app code: revoke with the call
    const framesBeforeRevoke = got.length
    await connA.func.media.publish('cam', new Uint8Array([9]), 54321)
    await delay(50)
    ok(got.length == framesBeforeRevoke, 'ACL revocation blocks frames on an already-open media subscription')
    let deniedAfter = false
    try { await connB.func.media.watch.a.cam.keyframe() } catch { deniedAfter = true }
    ok(deniedAfter, 'watch is denied again after the call ends (new resolutions blocked)')
    media.dropAccount('c')
    ok(!media.accounts().includes('c') && media.accounts().includes('a'), 'dropAccount retires the account keyspace (server-side cleanup hook)')

    // ================= decline =================
    let ringAtA: any = null
    callsA.rings.on((h: any) => { ringAtA = h })
    const bToA = callsB.call('a')
    await waitFor('ring reaches a', () => ringAtA != null)
    ringAtA.decline()
    ok(await bToA.ended == 'declined', 'decline propagates to the caller')

    // ================= offline callee: fails fast, no timeout wait =================
    const t0 = Date.now()
    const toGhost = callsA.call('ghost')
    ok(await toGhost.ended == 'offline' && Date.now() - t0 < 2000, 'calling an offline account fails fast with offline')

    // ================= ring timeout =================
    const callsA2 = createCallManager({port: callPortOf(connA.func.peer), self: 'a', ringTimeoutMs: 300})
    await callsA2.ready
    let unanswered: any = null
    const offRings = callsB.rings.on((h: any) => { unanswered = h })
    const timedOut = callsA2.call('b')
    ok(await timedOut.ended == 'timeout', 'unanswered ring times out on the caller')
    await waitFor('callee ring cleaned up', () => unanswered != null && unanswered.state() == 'ended')
    ok(unanswered.reason() == 'canceled', 'the callee ring is canceled by the caller timeout')
    if (typeof offRings == 'function') offRings()

    // ================= presence offline edge =================
    connC.closeSocket()
    await waitFor('presence offline edge', () => presenceLog.some(ch => ch.account == 'c' && ch.online == false))
    ok(true, 'presence emits the offline edge on disconnect')

    // ================= teardown =================
    callsA.close(); callsA2.close(); callsB.close(); callsC.close()
    connA.closeSocket(); connB.closeSocket()
    media.close()
    host.close()
    ioServer.close()
    await new Promise<void>(resolve => httpServer.close(() => resolve()))

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
