// Demo stand client: shared cursors over the Peer SDK — relay by default,
// "Go direct" promotes to a real RTCPeerConnection datachannel, "Back to relay"
// re-interposes. The route hand-off is gap-free by seq; the cursor never jumps.
// Plus live media: camera / mic / screen share captured with the Media sources and
// streamed to the watching tab through the demo server's media relay.
import {io} from 'socket.io-client'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createPeerClient} from '../src/Common/peer/peer-index'
import {createAudioSource, createVideoSource, decodeMediaFrame} from '../src/Common/media/media-index'

type World = {cursor: {x: number, y: number}, color: string, name: string}

const params = new URLSearchParams(location.search)
const me = params.get('me') ?? 'a'
const other = params.get('peer') ?? (me == 'a' ? 'b' : 'a')

const el = (id: string) => document.getElementById(id)!
const logBox = () => el('log') as HTMLDivElement

function log(line: string) {
    const box = logBox()
    const row = document.createElement('div')
    row.textContent = `${new Date().toLocaleTimeString()}  ${line}`
    box.prepend(row)
    while (box.children.length > 30) box.lastChild?.remove()
}

async function main() {
    document.title = `peer ${me}`
    el('who').textContent = `me: ${me}  ·  watching: ${other}`

    const hub = createRpcClientHub(
        () => io({transports: ['websocket'], auth: {account: me, watch: other}}),
        r => ({app: r<any>('app')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.app.readyStrict()
    log('rpc connected; legacy serverTime() = ' + await clients.app.func.serverTime())

    // debug tap: every signaling envelope this account receives
    ;(clients.app.func.peer.signal.signals as any).on((env: any) => {
        log(`sig<- ${env.type} ${env.from}->${env.to}` +
            (env.sdp ? ` sdp.len=${String(env.sdp).length}` : '') +
            (env.candidate ? ` cand=${JSON.stringify(env.candidate).slice(0, 70)}` : ''))
    })

    const client = createPeerClient<World>({
        remote: clients.app.func.peer,
        account: me,
        initial: {
            cursor: {x: 160, y: 120},
            color: me == 'a' ? '#4f8ef7' : '#f7a44f',
            name: me,
        },
        rtc: () => new RTCPeerConnection(),
        drain: 'micro',
    })
    const peer = client.peer(other)
    client.onRoute(ev => log(`route ${ev.key}: ${ev.from} -> ${ev.to}${ev.reason ? ` (${String(ev.reason)})` : ''}`))
    peer.ready.then(() => log('peer mirror ready (keyframe landed)')).catch(e => log('mirror error: ' + e))

    // ============== input: own cursor -> own store ==============
    const canvas = el('canvas') as HTMLCanvasElement
    canvas.addEventListener('mousemove', function onMove(e) {
        const r = canvas.getBoundingClientRect()
        client.store.state.cursor = {x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top)}
    })

    // ============== render loop: own + mirrored cursor ==============
    const ctx = canvas.getContext('2d')!
    function drawCursor(c: {x: number, y: number}, color: string, name: string) {
        ctx.beginPath()
        ctx.arc(c.x, c.y, 8, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
        ctx.fillStyle = '#333'
        ctx.font = '12px sans-serif'
        ctx.fillText(name, c.x + 12, c.y + 4)
    }
    function frame() {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        const mine = client.store.state
        drawCursor(mine.cursor, mine.color, mine.name + ' (me)')
        const theirs = peer.store.state
        if (theirs?.cursor) drawCursor(theirs.cursor, theirs.color ?? '#999', (theirs.name ?? other) + ` [${peer.route()}]`)
        el('route').textContent = `route: ${peer.route()}  ·  state: ${peer.state()}  ·  seq: ${peer.seq()}`
        requestAnimationFrame(frame)
    }
    frame()

    // ============== route controls ==============
    el('direct').addEventListener('click', async function goDirect() {
        log('promoteDirect...')
        const res = await peer.promoteDirect({timeoutMs: 8000})
        log(res.ok ? `direct: ok (${res.state})` : `direct failed: ${String(res.reason)}`)
    })
    el('relay').addEventListener('click', async function backToRelay() {
        const res = await peer.reinterposeRelay('manual')
        log(res.ok ? 'back on relay' : `re-interpose failed: ${String(res.reason)}`)
    })

    setupMedia(clients.app.func.media)
}

// ============== media: capture own cam/mic/screen, watch the peer's ==============
type tMediaKind = 'cam' | 'mic' | 'screen'

function asBytes(v: any): Uint8Array {
    if (v instanceof Uint8Array) return v
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    return new Uint8Array(v)
}

function mimeOf(codec: string) {
    if (codec == 'png') return 'image/png'
    if (codec == 'webp') return 'image/webp'
    return 'image/jpeg'
}

// sequential-playhead PCM player: each frame is scheduled right after the previous one
function createPcmPlayer() {
    let audioCtx: AudioContext | null = null
    let playhead = 0
    function push(raw: Uint8Array) {
        if (!audioCtx) return
        const f = decodeMediaFrame(raw)
        if (f.kind != 'audio-pcm') return
        const channels = f.channels || 1
        const sampleRate = f.sampleRate || 48000
        const copy = f.payload.slice()             // own buffer: RPC views may be unaligned
        let samples: Float32Array
        if (f.codec == 'float32') samples = new Float32Array(copy.buffer)
        else {
            const pcm = new Int16Array(copy.buffer)
            samples = new Float32Array(pcm.length)
            for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000
        }
        const frames = Math.floor(samples.length / channels)
        if (!frames) return
        const buf = audioCtx.createBuffer(channels, frames, sampleRate)
        for (let ch = 0; ch < channels; ch++) {
            const chan = buf.getChannelData(ch)
            for (let i = 0; i < frames; i++) chan[i] = samples[i * channels + ch]
        }
        // live policy: if the queue crept more than ~350ms ahead, drop the backlog and
        // rebase near "now" — a lagging demo call should skip, not drift ever further behind
        if (playhead - audioCtx.currentTime > 0.35) playhead = audioCtx.currentTime + 0.05
        const node = audioCtx.createBufferSource()
        node.buffer = buf
        node.connect(audioCtx.destination)
        const at = Math.max(audioCtx.currentTime + 0.05, playhead)
        node.start(at)
        playhead = at + frames / sampleRate
    }
    return {
        get enabled() { return !!audioCtx },
        enable() {
            audioCtx = audioCtx ?? new AudioContext()
            playhead = 0
            void audioCtx.resume()
        },
        disable() {
            void audioCtx?.close()
            audioCtx = null
        },
        push,
    }
}

function setupMedia(media: any) {
    // -------- publish own frames through the demo relay (fire-and-forget) --------
    function pipePublish(kind: tMediaKind, src: any) {
        src[1].on(function publishFrame(frame: Uint8Array) {
            Promise.resolve(media.publish(kind, frame, Date.now())).catch(function onPublishFail(e: any) {
                log(`media publish ${kind} failed: ${e}`)
            })
        })
        return src
    }

    const camResEl = el('camRes') as HTMLSelectElement
    function makeCam() {
        // library fps default (3) targets machine vision; a live stand wants motion
        return pipePublish('cam', createVideoSource({sourceId: 'cam', fps: 60, width: Number(camResEl.value) || 640, codec: 'jpeg'}))
    }

    const sources = {
        cam: makeCam(),
        screen: pipePublish('screen', createVideoSource({
            sourceId: 'screen',
            fps: 10,
            codec: 'jpeg',
            quality: 0.5,            // full-screen JPEGs get large fast; favor latency
            // the documented `stream` injection point: skip getUserMedia, bring getDisplayMedia
            stream: () => (navigator.mediaDevices as any).getDisplayMedia({video: true}),
        })),
        // big buffers on purpose: the worklet's 128-sample chunks would be ~375 socket
        // messages per second and drown the shared connection (lag for everything)
        mic: pipePublish('mic', createAudioSource({sourceId: 'mic', worklet: false, bufferSize: 4096})),
    }

    // resolution stress test: swap the camera source on the fly, keep it live if it was
    camResEl.addEventListener('change', async function onCamResChange() {
        const wasLive = sources.cam.state == 'live'
        sources.cam.stop()
        sources.cam = makeCam()
        if (wasLive) {
            const state = await sources.cam.start()
            log(`cam @${camResEl.value}p: ${state}`)
        }
    })

    // -------- capture toggles --------
    function bindToggle(id: string, kind: tMediaKind, label: string) {
        const btn = el(id) as HTMLButtonElement
        btn.addEventListener('click', async function toggleCapture() {
            const src = sources[kind]
            if (src.state == 'live') {
                src.stop()
                btn.textContent = label
                log(`${kind}: stopped`)
                return
            }
            btn.textContent = `${label} …`
            const state = await src.start()
            btn.textContent = state == 'live' ? `${label} ⏹` : label
            log(`${kind}: ${state}${state != 'live' && src.getStats().error ? ' — ' + src.getStats().error : ''}`)
        })
    }
    bindToggle('cam', 'cam', '📷 camera')
    bindToggle('mic', 'mic', '🎙 mic')
    bindToggle('screen', 'screen', '🖥 screen')

    // -------- watch the peer's lines --------
    const rx = {cam: 0, screen: 0, mic: 0}
    const drawn = {cam: 0, screen: 0}                // frames actually rendered (vs received)
    const rxAge = {cam: 0, screen: 0, mic: 0}        // smoothed publish->render latency, ms
    function noteAge(kind: tMediaKind, sentAt: any) {
        if (typeof sentAt != 'number') return
        const age = Date.now() - sentAt
        rxAge[kind] = rxAge[kind] ? Math.round(rxAge[kind] * 0.8 + age * 0.2) : age
    }
    function watchVideo(line: any, canvasId: string, kind: 'cam' | 'screen', caption: string) {
        const canvas = el(canvasId) as HTMLCanvasElement
        const captionEl = el(canvasId + 'Cap')
        const ctx = canvas.getContext('2d')!
        canvas.addEventListener('click', function goFullscreen() {
            void (document.fullscreenElement == canvas ? document.exitFullscreen() : canvas.requestFullscreen?.())
        })
        let busy = false
        line.on(async function onVideoFrame(raw: any, sentAt?: number) {
            rx[kind]++
            noteAge(kind, sentAt)
            if (busy) return
            busy = true
            try {
                const f = decodeMediaFrame(asBytes(raw))
                if (f.kind != 'video-frame' || !f.width || !f.height) return
                const bmp = await createImageBitmap(new Blob([f.payload.slice()], {type: mimeOf(f.codec)}))
                if (canvas.width != f.width) canvas.width = f.width
                if (canvas.height != f.height) canvas.height = f.height
                captionEl.textContent = `${caption} · ${f.width}×${f.height} · click = fullscreen`
                ctx.drawImage(bmp, 0, 0)
                bmp.close()
                drawn[kind]++
            } catch (e) {
                log('video frame render failed: ' + e)
            } finally {
                busy = false
            }
        })
    }
    watchVideo(media.peer.cam, 'peerCam', 'cam', 'peer camera')
    watchVideo(media.peer.screen, 'peerScreen', 'screen', 'peer screen')

    const player = createPcmPlayer()
    media.peer.mic.on(function onAudioFrame(raw: any, sentAt?: number) {
        rx.mic++
        noteAge('mic', sentAt)
        if (!player.enabled) return
        try { player.push(asBytes(raw)) } catch (e) { log('audio frame failed: ' + e) }
    })
    const audioBtn = el('audio') as HTMLButtonElement
    audioBtn.addEventListener('click', function togglePeerAudio() {
        if (player.enabled) {
            player.disable()
            audioBtn.textContent = '🔊 peer audio'
        } else {
            player.enable()
            audioBtn.textContent = '🔊 peer audio ⏹'
        }
    })

    // -------- own capture stats --------
    const statsEl = el('mediaStats')
    // rolling per-second rates: previous counter snapshot -> delta over the 1s tick
    let prev = {tx: {cam: 0, mic: 0, screen: 0}, rx: {cam: 0, mic: 0, screen: 0}}
    setInterval(function renderMediaStats() {
        const parts: string[] = []
        const next = {tx: {cam: 0, mic: 0, screen: 0}, rx: {...rx}}
        for (const kind of ['cam', 'mic', 'screen'] as const) {
            const s = sources[kind].getStats()
            next.tx[kind] = s.frames
            if (s.state != 'idle') parts.push(`${kind}: ${s.state} ${s.frames}f ${s.frames - prev.tx[kind]}/s${s.rms != null ? ` rms=${s.rms.toFixed(3)}` : ''}`)
        }
        if (rx.cam || rx.screen || rx.mic) parts.push(
            `rx: cam ${rx.cam}f/${drawn.cam}d ${rx.cam - prev.rx.cam}/s ~${rxAge.cam}ms` +
            ` · screen ${rx.screen}f/${drawn.screen}d ${rx.screen - prev.rx.screen}/s ~${rxAge.screen}ms` +
            ` · mic ${rx.mic}f ${rx.mic - prev.rx.mic}/s ~${rxAge.mic}ms`)
        prev = next
        statsEl.textContent = parts.join('  ·  ')
    }, 1000)
}

main().catch(e => { console.error(e); log('FATAL: ' + e) })
