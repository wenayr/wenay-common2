// =====================================================================
// Call session — messenger-grade calls over Peer.createCallManager
// =====================================================================
// A call is a set of participants. 1:1 is the common case; "＋ Add" rings one
// more, host-centric: the host holds one pairwise call handle per invited
// account (the library's ring/accept/decline/busy/timeout all still apply per
// leg), the media watch ACL is already per-pair, so no server change is needed.
// The session owns the participant set, media attach/detach on each active edge,
// tones, auto-media and history. DOM + view modes live in call-ui.ts.

import {listen} from '../src/Common/events/Listen'
import {CallHandle, CallManager, tCallEnd} from '../src/Common/peer/peer-index'
import {CallTones} from './call-tones'

export type tCallPhase = 'idle' | 'incoming' | 'outgoing' | 'active'
export type tCallOutcome = 'answered' | 'declined' | 'busy' | 'no-answer' | 'missed' | 'canceled' | 'offline' | 'dropped' | 'failed'

export type CallHistoryEntry = {
    at: number
    direction: 'in' | 'out'
    peer: string
    outcome: tCallOutcome
    durationMs: number
}

type Leg = {handle: CallHandle, wasActive: boolean}

type CallSessionDeps = {
    calls: CallManager
    tones: CallTones
    /** Per-participant media boundary: the session decides WHEN, media owns HOW. */
    media: {attach: (account: string) => void, detach: (account: string) => void}
    /** A call going active auto-starts mic+cam; its end auto-stops what it started. */
    capture?: {state: (kind: 'cam' | 'mic') => string, ensure: (kind: 'cam' | 'mic', on: boolean) => Promise<unknown>}
    /** Own socket lifecycle: an active call shows 'reconnecting', then ends as dropped. */
    transport?: {
        connectListen: (cb: () => void) => unknown
        disconnectListen: (cb: (reason?: string) => void) => unknown
    }
    /** Presence edges: a participant vanishing ends that leg on this side too. */
    presence?: {on: (cb: (edge: {account: string, online: boolean}) => void) => unknown}
    log: (line: string) => void
}

export function createCallSession(deps: CallSessionDeps) {
    const {calls, tones, media, log} = deps
    const [emitChanged, changed] = listen<[tCallPhase]>()
    const [emitHistory, historyChanged] = listen<[CallHistoryEntry]>()
    const entries: CallHistoryEntry[] = []
    const legs = new Map<string, Leg>() // by peer account
    let incoming: Leg | null = null     // a fresh ring waiting for accept/decline
    let activeSince = 0
    let lastEnd: {peer: string, direction: 'in' | 'out', outcome: tCallOutcome} | null = null
    let reconnecting = false
    let dropTimer: ReturnType<typeof setTimeout> | null = null
    const autoStarted = new Set<'cam' | 'mic'>()
    const forced = new Map<string, tCallOutcome>()

    // ============== phase over the whole participant set ==============
    function anyActive() {
        for (const leg of legs.values()) if (leg.handle.state() == 'active') return true
        return false
    }
    function phase(): tCallPhase {
        if (anyActive()) return 'active'
        for (const leg of legs.values()) if (leg.handle.direction == 'out') return 'outgoing'
        if (incoming) return 'incoming'
        return 'idle'
    }
    function participants() {
        return Array.from(legs.keys())
    }
    function primaryPeer() {
        return incoming?.handle.peer ?? participants()[0] ?? ''
    }

    function classify(direction: 'in' | 'out', reason: tCallEnd | null, wasActive: boolean): tCallOutcome {
        if (wasActive) return 'answered'
        if (reason == 'busy') return 'busy'
        if (reason == 'declined') return 'declined'
        if (reason == 'offline') return 'offline'
        if (reason == 'timeout') return direction == 'out' ? 'no-answer' : 'missed'
        if (reason == 'canceled') return direction == 'out' ? 'canceled' : 'missed'
        return 'failed'
    }

    function record(entry: CallHistoryEntry) {
        entries.unshift(entry)
        if (entries.length > 40) entries.pop()
        emitHistory(entry)
    }

    function startAutoMedia() {
        if (!deps.capture) return
        for (const kind of ['mic', 'cam'] as const) {
            if (deps.capture.state(kind) != 'live') {
                autoStarted.add(kind)
                void deps.capture.ensure(kind, true)
            }
        }
    }
    function stopAutoMedia() {
        if (!deps.capture) return
        for (const kind of autoStarted) void deps.capture.ensure(kind, false)
        autoStarted.clear()
    }

    // ============== one leg's lifecycle ==============
    function bind(handle: CallHandle) {
        const leg: Leg = {handle, wasActive: false}
        const account = handle.peer
        if (handle.direction == 'in') incoming = leg
        else legs.set(account, leg)

        handle.changed.on(function onLegEdge(state) {
            if (state == 'active') {
                const first = !anyActivePeerBesides(account)
                leg.wasActive = true
                if (incoming == leg) { incoming = null; legs.set(account, leg) }
                if (!activeSince) activeSince = Date.now()
                tones.stopRinging()
                tones.blip('connected')
                media.attach(account)
                if (first) startAutoMedia()
            }
            if (state == 'ended') {
                const outcome = forced.get(account) ?? classify(handle.direction, handle.reason(), leg.wasActive)
                forced.delete(account)
                const durationMs = leg.wasActive ? Date.now() - activeSince : 0
                if (leg.wasActive) media.detach(account)
                if (incoming == leg) incoming = null
                legs.delete(account)
                lastEnd = {peer: account, direction: handle.direction, outcome}
                record({at: Date.now(), direction: handle.direction, peer: account, outcome, durationMs})
                log(`call ${outcome}${durationMs ? ` after ${Math.round(durationMs / 1000)}s` : ''} (${handle.direction == 'in' ? 'from' : 'to'} ${account})`)
                // The whole call is over only when no leg remains.
                if (!legs.size && !incoming) {
                    stopAutoMedia()
                    tones.stopRinging()
                    tones.blip('ended')
                    activeSince = 0
                    reconnecting = false
                    if (dropTimer != null) { clearTimeout(dropTimer); dropTimer = null }
                }
            }
            emitChanged(phase())
        })
        if (handle.direction == 'in') tones.ringIncoming()
        else tones.ringOutgoing()
        emitChanged(phase())
    }

    function anyActivePeerBesides(account: string) {
        for (const [acc, leg] of legs) if (acc != account && leg.handle.state() == 'active') return true
        return false
    }

    calls.rings.on(function onIncomingCall(ring) {
        // The manager's default gate auto-declines a ring that overlaps a live
        // call ('busy'), so a ring reaching us means we are free — a fresh call.
        lastEnd = null
        bind(ring)
    })

    // ============== connection loss ==============
    function endLegLocally(account: string, outcome: tCallOutcome) {
        const leg = legs.get(account) ?? (incoming?.handle.peer == account ? incoming : null)
        if (!leg) return
        forced.set(account, outcome)
        leg.handle.hangup()
    }
    function endAllLocally(outcome: tCallOutcome) {
        for (const account of participants()) endLegLocally(account, outcome)
        if (incoming) endLegLocally(incoming.handle.peer, outcome)
    }

    deps.transport?.disconnectListen(function onCallTransportLost() {
        if (phase() == 'idle') return
        if (anyActive()) {
            reconnecting = true
            dropTimer = setTimeout(function dropAfterSilence() { endAllLocally('dropped') }, 20_000)
            emitChanged(phase())
            return
        }
        endAllLocally('dropped')
    })
    deps.transport?.connectListen(function onCallTransportBack() {
        if (dropTimer != null) { clearTimeout(dropTimer); dropTimer = null }
        if (reconnecting) endAllLocally('dropped')
    })
    deps.presence?.on(function onCallPresenceEdge(edge) {
        if (edge.online) return
        if (legs.has(edge.account) || incoming?.handle.peer == edge.account) {
            endLegLocally(edge.account, anyActive() ? 'dropped' : 'offline')
        }
    })

    return {
        changed,
        historyChanged,
        phase,
        participants,
        peer: primaryPeer,
        activeSince: () => activeSince,
        reconnecting: () => reconnecting,
        lastEnd: () => lastEnd,
        history: () => entries.slice(),
        missedFrom(account: string) {
            let count = 0
            for (const entry of entries) {
                if (entry.peer != account) continue
                if (entry.direction == 'in' && entry.outcome == 'missed') { count++; continue }
                break
            }
            return count
        },
        /** Start a call (first participant). */
        place(peer: string) {
            if (!peer || legs.has(peer) || incoming) return
            lastEnd = null
            bind(calls.call(peer, {kinds: ['cam', 'mic', 'screen']}))
        },
        /** Ring one more participant into the current call (host-centric group). */
        add(peer: string) {
            if (!peer || legs.has(peer) || phase() == 'idle') return
            bind(calls.call(peer, {kinds: ['cam', 'mic', 'screen']}))
        },
        accept: () => incoming?.handle.accept(),
        decline: () => incoming?.handle.decline(),
        /** Drop one participant without ending the whole call. */
        hangupOne(account: string) { endLegLocally(account, 'hangup' as tCallOutcome) },
        /** End the entire call. */
        hangup() {
            for (const account of participants()) legs.get(account)?.handle.hangup()
            incoming?.handle.hangup()
        },
    }
}

export type CallSession = ReturnType<typeof createCallSession>
