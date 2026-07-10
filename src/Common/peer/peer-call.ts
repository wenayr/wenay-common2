// =====================================================================
// Call system — messenger-style ring/accept/decline over the signal hub
// =====================================================================
// One account calls another. The envelopes (ring/accept/decline/hangup) ride
// the EXISTING per-account signal port — no new server surface: the hub routes
// by `to`, and the host's `authorize` hook sees call envelopes too (that is the
// server-side call policy point). Media is NOT owned by the call layer: on
// 'active' the app publishes/attaches lines itself (createMediaRelay +
// Media.attach* viewers) — relay-first is the privacy default, promoteDirect
// stays the opt-in for the data path. Call envelopes use pair 'call:<id>', so
// they never collide with route pair keys ('a|b') used by WebRTC connectors.

import {listen} from '../events/Listen'
import {SignalEnvelope, SignalPort} from '../events/route-signal-webrtc'

export type tCallState = 'ringing' | 'active' | 'ended'
export type tCallEnd = 'declined' | 'busy' | 'offline' | 'timeout' | 'hangup' | 'canceled' | 'closed'

export type CallManagerDeps = {
    /** The account's signal port (callPortOf(remote) over the peer fragment proxy). */
    port: SignalPort
    self: string
    /** Unanswered ring lifetime, both sides. */
    ringTimeoutMs?: number
    /**
     * Incoming-call gate: false = auto-decline ('busy'). Default gate declines
     * while ANY call is ringing or active — which also resolves glare (both
     * sides calling each other simultaneously) as mutual busy.
     */
    incoming?: (info: {peer: string, meta?: unknown}) => boolean | Promise<boolean>
}

/** Flat SignalPort over the host peer fragment as seen through the rpc deep proxy. */
export function callPortOf(remote: {signal: {send: (env: SignalEnvelope) => any, signals: {on: (cb: (env: SignalEnvelope) => void) => any}}}): SignalPort {
    return {
        send: env => remote.signal.send(env),
        signals: {on: cb => remote.signal.signals.on(cb)},
    }
}

export function createCallManager(deps: CallManagerDeps) {
    const {port, self, ringTimeoutMs = 30_000, incoming} = deps
    const [emitRing, rings] = listen<[CallHandle]>()
    const calls = new Map<string, ReturnType<typeof makeCall>>() // by pair key 'call:<id>'
    let n = 0
    const callScope = Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    let evaluatingIncoming = 0
    let closed = false

    // ============== a single call: tiny state machine in a closure ==============
    function makeCall(pair: string, other: string, direction: 'in' | 'out', meta?: unknown) {
        let state: tCallState = 'ringing'
        let reason: tCallEnd | null = null
        const [emitChange, changed] = listen<[tCallState]>()
        let resolveEnded: (r: tCallEnd) => void
        const ended = new Promise<tCallEnd>(r => { resolveEnded = r })
        const ringTimer = setTimeout(function onRingTimeout() { finish('timeout', direction == 'out') }, ringTimeoutMs)

        function send(type: 'accept' | 'decline' | 'hangup', why?: string) {
            void Promise.resolve(port.send({type, pair, from: self, to: other, reason: why})).catch(swallowSendError)
        }

        function finish(why: tCallEnd, notify: boolean, notifyAs: 'decline' | 'hangup' = 'hangup') {
            if (state == 'ended') return
            state = 'ended'
            reason = why
            clearTimeout(ringTimer)
            calls.delete(pair)
            if (notify) send(notifyAs, why)
            emitChange('ended')
            changed.close()
            resolveEnded(why)
        }

        function activate() {
            if (state != 'ringing') return
            state = 'active'
            clearTimeout(ringTimer)
            emitChange('active')
        }

        const handle = {
            id: pair,
            peer: other,
            direction,
            /** Caller's opaque meta (offered media kinds etc.) — the wire does not look inside. */
            meta,
            state: () => state,
            reason: () => reason,
            /** State edges: 'active' | 'ended'. */
            changed,
            /** Resolves with the end reason — awaiting a call IS the call lifecycle. */
            ended,
            /** Callee: take the call. */
            accept() {
                if (direction != 'in' || state != 'ringing') return
                send('accept')
                activate()
            },
            /** Callee: refuse the call. */
            decline(why: tCallEnd = 'declined') {
                if (direction != 'in' || state != 'ringing') return
                finish(why, true, 'decline')
            },
            /** Either side, any state: ringing-out = cancel, active = hang up. */
            hangup() {
                finish(state == 'ringing' && direction == 'out' ? 'canceled' : 'hangup', true)
            },
        }
        return {handle, activate, finish}
    }

    type CallHandle = ReturnType<typeof makeCall>['handle']

    function swallowSendError() { /* transport hiccup: the ring timeout is the safety net */ }

    function hasLiveCall() {
        for (const c of calls.values()) if (c.handle.state() != 'ended') return true
        return false
    }

    // ============== outgoing ==============
    function call(other: string, meta?: unknown): CallHandle {
        if (closed) throw new Error('call manager is closed')
        // A per-manager scope keeps ids distinct across tabs/restarts for one account.
        const pair = 'call:' + self + ':' + callScope + ':' + (++n)
        const made = makeCall(pair, other, 'out', meta)
        calls.set(pair, made)
        Promise.resolve(port.send({type: 'ring', pair, from: self, to: other, session: meta}))
            .then(function onRingVerdict(accepted) {
                // hub returned false: no such account online / server policy said no
                if (accepted == false) made.finish('offline', false)
            }, function onRingSendError() { made.finish('offline', false) })
        return made.handle
    }

    // ============== incoming ==============
    async function onRing(env: SignalEnvelope) {
        if (calls.has(env.pair)) return // duplicate ring of a live pair
        evaluatingIncoming++
        const gate = incoming ?? function defaultBusyGate() {
            // Reserve the first admission while an async gate yields. Otherwise two
            // back-to-back rings can both observe an empty calls map.
            return evaluatingIncoming == 1 && !hasLiveCall()
        }
        let allowed = false
        try { allowed = !!(await gate({peer: env.from, meta: env.session})) }
        catch { allowed = false }
        finally { evaluatingIncoming-- }
        if (closed) return
        if (!allowed) {
            void Promise.resolve(port.send({type: 'decline', pair: env.pair, from: self, to: env.from, reason: 'busy'})).catch(swallowSendError)
            return
        }
        const made = makeCall(env.pair, env.from, 'in', env.session)
        calls.set(env.pair, made)
        emitRing(made.handle)
    }

    // ============== readiness probe: a self-envelope over the same socket ==============
    // The subscribe message precedes the probe on the SAME ordered connection, so the
    // echo confirms the server-side registration — before `ready`, an incoming ring
    // emitted on the hub could be lost (plain Listen, no replay journal by design).
    const readyProbe = 'call-ready:' + self
    let resolveReady: () => void
    const ready = new Promise<void>(r => { resolveReady = r })

    const offSignals = port.signals.on(function onCallSignal(env: SignalEnvelope) {
        if (closed || env == null || env.to != self) return
        if (env.pair == readyProbe) { resolveReady(); return }
        if (env.type == 'ring') { void onRing(env); return }
        const live = calls.get(env.pair)
        if (!live) return
        if (env.type == 'accept') { live.activate(); return }
        if (env.type == 'decline') { live.finish((env.reason as tCallEnd) ?? 'declined', false); return }
        if (env.type == 'hangup') { live.finish(live.handle.state() == 'ringing' ? 'canceled' : 'hangup', false) }
    })

    // 'close' with a non-route pair is inert for every other consumer of the port
    Promise.resolve(port.send({type: 'close', pair: readyProbe, from: self, to: self}))
        .then(function onProbeVerdict(v) { if (v == false) resolveReady() }, function onProbeError() { resolveReady() })

    return {
        /** Resolves when the signal subscription is confirmed registered server-side. */
        ready,
        /** Start an outgoing call; await handle.ended or watch handle.changed. */
        call,
        /** Incoming calls that passed the gate ring here. */
        rings,
        active: () => Array.from(calls.values()).map(c => c.handle).find(h => h.state() == 'active') ?? null,
        close() {
            if (closed) return
            closed = true
            if (typeof offSignals == 'function') offSignals()
            else (offSignals as any)?.off?.()
            for (const c of Array.from(calls.values())) c.finish('closed', true)
            rings.close()
        },
    }
}

export type CallManager = ReturnType<typeof createCallManager>
export type CallHandle = ReturnType<CallManager['call']>
