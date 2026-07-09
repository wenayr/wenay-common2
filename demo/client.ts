// Demo stand client: shared cursors over the Peer SDK — relay by default,
// "Go direct" promotes to a real RTCPeerConnection datachannel, "Back to relay"
// re-interposes. The route hand-off is gap-free by seq; the cursor never jumps.
import {io} from 'socket.io-client'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createPeerClient} from '../src/Common/peer/peer-index'

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
        () => io({transports: ['websocket'], auth: {account: me}}),
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
}

main().catch(e => { console.error(e); log('FATAL: ' + e) })
