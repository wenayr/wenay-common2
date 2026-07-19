// =====================================================================
// Call tones — tiny WebAudio utility; no assets, no call rules inside
// =====================================================================
// Generated beep patterns keep the stand dependency-free. The AudioContext
// starts lazily and may stay suspended until the browser sees a user gesture;
// every entry point degrades to silence instead of throwing, so an incoming
// ring in a fresh background tab simply rings visually.

export type tCallBlip = 'connected' | 'ended'

export function createCallTones() {
    let context: AudioContext | null = null
    let ringing: ReturnType<typeof setInterval> | null = null
    let muted = false

    function audioContext() {
        const Ctor = (window as any).AudioContext ?? (window as any).webkitAudioContext
        if (!Ctor) return null
        if (!context) context = new Ctor() as AudioContext
        if (context.state == 'suspended') void context.resume().catch(function ignoreResumeDenial() {})
        return context
    }

    function beep(freq: number, atMs: number, lengthMs: number, volume = 0.05) {
        const ctx = audioContext()
        if (!ctx || muted) return
        const from = ctx.currentTime + atMs / 1000
        const to = from + lengthMs / 1000
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        // short attack/release ramps remove speaker clicks
        gain.gain.setValueAtTime(0, from)
        gain.gain.linearRampToValueAtTime(volume, from + 0.02)
        gain.gain.setValueAtTime(volume, Math.max(from + 0.02, to - 0.04))
        gain.gain.linearRampToValueAtTime(0, to)
        osc.connect(gain).connect(ctx.destination)
        osc.start(from)
        osc.stop(to + 0.02)
    }

    function startRing(play: () => void, periodMs: number) {
        stopRinging()
        play()
        ringing = setInterval(play, periodMs)
    }

    function stopRinging() {
        if (ringing != null) clearInterval(ringing)
        ringing = null
    }

    return {
        /** Incoming ring: a double beep every two seconds. */
        ringIncoming() {
            startRing(function incomingRingPattern() {
                beep(880, 0, 250)
                beep(880, 400, 250)
            }, 2000)
        },
        /** Outgoing ringback: one long low tone, long pause (phone-style). */
        ringOutgoing() {
            startRing(function outgoingRingPattern() { beep(425, 0, 900, 0.035) }, 3600)
        },
        stopRinging,
        blip(kind: tCallBlip) {
            if (kind == 'connected') { beep(520, 0, 90); beep(780, 110, 120) }
            else { beep(620, 0, 110); beep(390, 130, 160) }
        },
        // Muting keeps a live ring pattern ticking silently, so unmuting
        // mid-ring becomes audible again without extra state.
        setMuted(next: boolean) { muted = next },
        muted: () => muted,
    }
}

export type CallTones = ReturnType<typeof createCallTones>
