// =====================================================================
// Call UI — DOM binding only; rules in createCallSession, tiles in media-demo
// =====================================================================
// The overlay is the call surface: a tile grid (Speaker / Grid views), an
// active-speaker header, a control tray (mic / camera / screen / add / sound /
// end) and an add-participant menu. The banner is the reachability surface —
// an incoming ring shows over ANY view. Minimize drops to a floating pill.

import {CallSession, tCallOutcome} from './call-app'
import {CallTones} from './call-tones'
import {tMediaKind} from './media-demo'

export type tPeerAvFlags = {camOn?: boolean, micOn?: boolean, screenOn?: boolean}

type CallUiDeps = {
    session: CallSession
    tones: CallTones
    /** Shared capture facade — the tray drives the SAME sources as the room stage. */
    capture: {
        toggle: (kind: tMediaKind) => Promise<unknown>
        state: (kind: tMediaKind) => string
        changes: {on: (cb: (kind: tMediaKind) => void) => unknown}
    }
    /** Call media grid: layout view, global sound, current active speaker. */
    media: {
        setView: (view: 'speaker' | 'grid') => void
        setSound: (on: boolean) => void
        activeSpeaker: () => string
    }
    peerColor: (account: string) => string | undefined
    /** Online accounts (excluding self) for the add-participant menu. */
    onlinePeers: () => string[]
    element: (id: string) => HTMLElement
    participantName: (account: string) => string
    selectedPeer: () => string
    reveal: () => void
    log: (line: string) => void
}

const outcomeLabels: Record<tCallOutcome, string> = {
    answered: 'Call finished',
    declined: 'Call declined',
    busy: 'Participant is busy',
    'no-answer': 'No answer',
    missed: 'Missed call',
    canceled: 'Call canceled',
    offline: 'Participant is offline',
    dropped: 'Connection lost',
    failed: 'Call failed',
}

export function setupCallUi(deps: CallUiDeps) {
    const {session, tones, capture, media, peerColor, onlinePeers, element, participantName, selectedPeer, reveal, log} = deps
    const el = (id: string) => element(id)
    const callButton = el('call') as HTMLButtonElement
    const acceptButton = el('accept') as HTMLButtonElement
    const declineButton = el('decline') as HTMLButtonElement
    const soundsButton = el('callSounds') as HTMLButtonElement
    const stateLine = el('callState')
    const helpLine = el('callHelp')
    const banner = el('callBanner')
    const bannerAvatar = el('callBannerAvatar')
    const bannerFrom = el('callBannerFrom')
    const bannerAccept = el('callBannerAccept') as HTMLButtonElement
    const bannerDecline = el('callBannerDecline') as HTMLButtonElement
    const historyBox = el('callHistory')
    const controlsBar = el('callControls')
    const micButton = el('callMic') as HTMLButtonElement
    const camButton = el('callCam') as HTMLButtonElement
    const screenButton = el('callScreenShare') as HTMLButtonElement
    const addButton = el('callAdd') as HTMLButtonElement
    const addMenu = el('callAddMenu')
    const soundButton = el('callSound') as HTMLButtonElement
    const overlay = el('callOverlay')
    const overlayAvatar = el('overlayAvatar')
    const overlayName = el('overlayName')
    const overlayState = el('overlayState')
    const overlayRinging = el('overlayRinging')
    const overlayBigAvatar = el('overlayBigAvatar')
    const overlayRingName = el('overlayRingName')
    const overlayCancel = el('overlayCancel') as HTMLButtonElement
    const viewToggle = el('callViewToggle') as HTMLButtonElement
    const minimizeButton = el('callMinimize') as HTMLButtonElement
    const hangupButton = el('callHangup') as HTMLButtonElement
    const pill = el('callPill') as HTMLButtonElement
    const pillText = el('callPillText')

    let timer: ReturnType<typeof setInterval> | null = null
    let minimized = false
    let view: 'speaker' | 'grid' = 'speaker'
    let soundOn = true
    let addOpen = false
    let lastPhase = 'idle'

    function formatDuration(ms: number) {
        const total = Math.floor(ms / 1000)
        return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
    }

    // Title: one name for a 1:1 call, "Group · N" once more than one joins.
    function callTitle() {
        const parts = session.participants()
        if (parts.length <= 1) {
            const account = session.peer() || selectedPeer()
            return account ? participantName(account) : ''
        }
        return `Group · ${parts.length + 1} participants`
    }

    function paintAvatar(target: HTMLElement, name: string) {
        target.textContent = (name[0] ?? '•').toUpperCase()
        target.style.background = peerColor(session.peer()) ?? '#15233c'
    }

    // -------- optional background-tab notification --------
    function requestNotificationsOnce() {
        if (!('Notification' in window) || Notification.permission != 'default') return
        void Notification.requestPermission().catch(function ignoreDenial() {})
    }
    function notifyIncoming(name: string) {
        if (!('Notification' in window) || !document.hidden || Notification.permission != 'granted') return
        try { new Notification('Incoming call', {body: `${name} is calling`, tag: 'wenay-demo-call'}) }
        catch (error) { log('notification failed: ' + error) }
    }

    // -------- tray --------
    function renderControls() {
        const active = session.phase() == 'active'
        controlsBar.hidden = !active
        if (!active) return
        micButton.textContent = capture.state('mic') == 'live' ? '🎙 mute' : '🎙 unmute'
        camButton.textContent = capture.state('cam') == 'live' ? '📷 camera off' : '📷 camera on'
        screenButton.textContent = capture.state('screen') == 'live' ? '🖥 stop sharing' : '🖥 share screen'
        micButton.dataset.off = String(capture.state('mic') != 'live')
        camButton.dataset.off = String(capture.state('cam') != 'live')
        const frozen = session.reconnecting()
        for (const b of [micButton, camButton, screenButton, addButton]) b.disabled = frozen
    }

    function bindCaptureControl(target: HTMLButtonElement, kind: tMediaKind) {
        target.addEventListener('click', async function toggleFromTray() {
            target.disabled = true
            try { await capture.toggle(kind) } finally {
                target.disabled = false
                renderControls()
            }
        })
    }
    bindCaptureControl(micButton, 'mic')
    bindCaptureControl(camButton, 'cam')
    bindCaptureControl(screenButton, 'screen')
    capture.changes.on(function onCapture() { renderControls() })

    // -------- add-participant menu --------
    function renderAddMenu() {
        addMenu.hidden = !addOpen
        if (!addOpen) return
        const inCall = new Set(session.participants())
        const candidates = onlinePeers().filter(account => !inCall.has(account))
        addMenu.replaceChildren()
        if (!candidates.length) {
            const empty = document.createElement('div')
            empty.className = 'callAddEmpty'
            empty.textContent = 'No one else online to add'
            addMenu.append(empty)
            return
        }
        for (const account of candidates) {
            const row = document.createElement('button')
            row.type = 'button'
            row.textContent = '＋ ' + participantName(account)
            row.addEventListener('click', function addThisPeer() {
                session.add(account)
                addOpen = false
                renderAddMenu()
                log(`inviting ${participantName(account)} to the call`)
            })
            addMenu.append(row)
        }
    }
    addButton.addEventListener('click', function toggleAddMenu(event) {
        event.stopPropagation()
        addOpen = !addOpen
        renderAddMenu()
    })
    document.addEventListener('click', function closeAddMenu(event) {
        if (addOpen && !addMenu.contains(event.target as Node) && event.target != addButton) {
            addOpen = false
            renderAddMenu()
        }
    })

    // -------- history --------
    function renderHistory() {
        const entries = session.history()
        historyBox.replaceChildren()
        historyBox.hidden = !entries.length
        for (const entry of entries.slice(0, 6)) {
            const row = document.createElement('div')
            row.className = 'callHistoryRow'
            row.dataset.outcome = entry.outcome
            row.textContent = `${entry.direction == 'in' ? '↙' : '↗'} ${participantName(entry.peer)}` +
                ` · ${outcomeLabels[entry.outcome]}` +
                (entry.durationMs ? ` · ${formatDuration(entry.durationMs)}` : '') +
                ` · ${new Date(entry.at).toLocaleTimeString()}`
            historyBox.append(row)
        }
    }

    // -------- overlay --------
    function renderOverlay(phase: string) {
        const inCall = phase == 'outgoing' || phase == 'active'
        overlay.hidden = !inCall || minimized
        pill.hidden = !inCall || !minimized
        overlay.dataset.phase = phase
        if (!inCall) return
        const title = callTitle()
        paintAvatar(overlayAvatar, title)
        overlayName.textContent = title
        const speaker = media.activeSpeaker()
        const speakingNote = phase == 'active' && speaker
            ? ` · 🎙 ${speaker == 'self' ? 'You' : participantName(speaker)}`
            : ''
        overlayState.textContent = phase == 'outgoing' ? 'ringing…'
            : session.reconnecting() ? 'connection lost — reconnecting…'
            : formatDuration(Date.now() - session.activeSince()) + speakingNote
        overlayRinging.hidden = phase != 'outgoing'
        if (phase == 'outgoing') {
            paintAvatar(overlayBigAvatar, title)
            overlayRingName.textContent = title
        }
        pillText.textContent = phase == 'outgoing' ? `ringing ${title}…`
            : `${title} · ${formatDuration(Date.now() - session.activeSince())}`
    }

    function render() {
        const phase = session.phase()
        const bannerName = phase == 'incoming' ? participantName(session.peer()) : ''
        banner.hidden = phase != 'incoming'
        if (phase == 'incoming') {
            paintAvatar(bannerAvatar, bannerName)
            bannerFrom.textContent = `${bannerName} is calling…`
        }
        renderOverlay(phase)

        acceptButton.hidden = phase != 'incoming'
        declineButton.hidden = phase != 'incoming'
        callButton.hidden = phase == 'incoming'
        callButton.disabled = phase == 'idle' && !selectedPeer()
        const selName = participantName(selectedPeer())
        callButton.textContent = phase == 'active' ? '📞 hang up'
            : phase == 'outgoing' ? '📞 cancel…'
            : selectedPeer() ? `📞 call ${selName}` : '📞 choose a participant'

        const last = session.lastEnd()
        stateLine.textContent = phase == 'incoming' ? `${bannerName} is calling…`
            : phase == 'outgoing' ? `ringing ${callTitle()}…`
            : phase == 'active' && session.reconnecting() ? 'connection lost — reconnecting…'
            : phase == 'active' ? `in call · ${callTitle()} · ${formatDuration(Date.now() - session.activeSince())}`
            : last ? `${outcomeLabels[last.outcome]} · ${participantName(last.peer)}` : ''
        helpLine.textContent = phase == 'idle' && !selectedPeer()
            ? 'Open this page in another tab: every tab becomes a participant.'
            : phase == 'idle'
                ? `Selected ${selName}. Call, then ＋ add others into a group call.`
                : phase == 'incoming' ? `Accept the call from ${bannerName} — the banner follows you on every view.`
                    : phase == 'outgoing' ? 'Waiting for an answer. Unanswered calls end on their own.'
                        : 'Speaker view follows whoever is talking · switch to Grid to see everyone.'

        if (phase == 'active' && timer == null) timer = setInterval(render, 500)
        if (phase != 'active' && timer != null) { clearInterval(timer); timer = null }

        renderControls()
        renderAddMenu()
        renderHistory()
    }

    function renderSounds() {
        soundsButton.textContent = tones.muted() ? '🔕 sounds off' : '🔔 sounds on'
    }

    // -------- controls --------
    callButton.addEventListener('click', function onCallButton() {
        const phase = session.phase()
        if (phase == 'active' || phase == 'outgoing') { session.hangup(); return }
        if (phase != 'idle') return
        requestNotificationsOnce()
        session.place(selectedPeer())
    })
    function acceptCall() { session.accept(); reveal() }
    acceptButton.addEventListener('click', acceptCall)
    bannerAccept.addEventListener('click', acceptCall)
    declineButton.addEventListener('click', function decline() { session.decline() })
    bannerDecline.addEventListener('click', function declineFromBanner() { session.decline() })
    soundsButton.addEventListener('click', function toggleTones() {
        tones.setMuted(!tones.muted())
        renderSounds()
    })

    function endCall() { session.hangup() }
    hangupButton.addEventListener('click', endCall)
    overlayCancel.addEventListener('click', endCall)

    soundButton.addEventListener('click', function toggleSound() {
        soundOn = !soundOn
        media.setSound(soundOn)
        soundButton.textContent = soundOn ? '🔊 sound on' : '🔇 sound off'
    })

    viewToggle.addEventListener('click', function toggleView() {
        view = view == 'speaker' ? 'grid' : 'speaker'
        media.setView(view)
        viewToggle.textContent = view == 'speaker' ? '▦ Grid view' : '▤ Speaker view'
    })
    media.setView(view)

    minimizeButton.addEventListener('click', function minimize() { minimized = true; render() })
    pill.addEventListener('click', function restore() { minimized = false; render() })
    document.addEventListener('keydown', function minimizeOnEscape(event) {
        if (event.key == 'Escape' && !overlay.hidden) { minimized = true; render() }
    })

    session.changed.on(function onCallPhase(phase) {
        if (phase == 'incoming') notifyIncoming(participantName(session.peer()))
        if (lastPhase == 'idle' && phase != 'idle') minimized = false
        lastPhase = phase
        render()
    })
    renderSounds()
    render()

    return {render}
}
