// Demo stand client: shared cursors over the Peer SDK — relay by default,
// "Go direct" promotes to a real RTCPeerConnection datachannel, "Back to relay"
// re-interposes. The route hand-off is gap-free by seq; the cursor never jumps.
// Plus live media: camera / mic / screen share captured with the Media sources and
// streamed to the watching tab through the demo server's media relay.
import {io} from 'socket.io-client'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createPeerClient} from '../src/Common/peer/peer-index'
import {attachAudioPlayer, attachVideoCanvas, createAudioSource, createVideoSource, pipeMediaPublish} from '../src/Common/media/media-index'

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

function setupMedia(media: any) {
    // -------- publish own frames through the demo relay (fire-and-forget) --------
    function pipePublish(kind: tMediaKind, src: any) {
        pipeMediaPublish(src[1], (frame, sentAt) => media.publish(kind, frame, sentAt), {
            onError: e => log(`media publish ${kind} failed: ${e}`),
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

    // -------- watch the peer's lines (one call per channel) --------
    function watchVideo(line: any, canvasId: string, caption: string) {
        const canvas = el(canvasId) as HTMLCanvasElement
        const captionEl = el(canvasId + 'Cap')
        canvas.addEventListener('click', function goFullscreen() {
            void (document.fullscreenElement == canvas ? document.exitFullscreen() : canvas.requestFullscreen?.())
        })
        const view = attachVideoCanvas(line, canvas, {onError: e => log('video frame render failed: ' + e)})
        return {view, captionEl, caption}
    }
    const peerCam = watchVideo(media.peer.cam, 'peerCam', 'peer camera')
    const peerScreen = watchVideo(media.peer.screen, 'peerScreen', 'peer screen')

    const player = attachAudioPlayer(media.peer.mic, {onError: e => log('audio frame failed: ' + e)})
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

    // -------- stats line: own capture + helper-provided rx metrics --------
    const statsEl = el('mediaStats')
    let prevTx = {cam: 0, mic: 0, screen: 0}
    setInterval(function renderMediaStats() {
        const parts: string[] = []
        const nextTx = {cam: 0, mic: 0, screen: 0}
        for (const kind of ['cam', 'mic', 'screen'] as const) {
            const s = sources[kind].getStats()
            nextTx[kind] = s.frames
            if (s.state != 'idle') parts.push(`${kind}: ${s.state} ${s.frames}f ${s.frames - prevTx[kind]}/s${s.rms != null ? ` rms=${s.rms.toFixed(3)}` : ''}`)
        }
        prevTx = nextTx
        const cam = peerCam.view.stats()
        const screen = peerScreen.view.stats()
        const mic = player.stats()
        for (const v of [peerCam, peerScreen]) {
            const s = v.view.stats()
            if (s.width) v.captionEl.textContent = `${v.caption} · ${s.width}×${s.height} · click = fullscreen`
        }
        if (cam.frames || screen.frames || mic.frames) parts.push(
            `rx: cam ${cam.frames}f/${cam.drawn}d ${cam.perSec}/s ~${cam.ageMs}ms` +
            ` · screen ${screen.frames}f/${screen.drawn}d ${screen.perSec}/s ~${screen.ageMs}ms` +
            ` · mic ${mic.frames}f ${mic.perSec}/s ~${mic.ageMs}ms`)
        statsEl.textContent = parts.join('  ·  ')
    }, 1000)
}

main().catch(e => { console.error(e); log('FATAL: ' + e) })
