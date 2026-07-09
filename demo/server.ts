// Demo stand server: the Peer SDK next to a legacy rpc key, static page hosting.
// Run: npm run demo  ->  open the two printed URLs in two tabs.
import express from 'express'
import {createServer} from 'http'
import path from 'path'
import {Server as SocketIOServer} from 'socket.io'
import {listen} from '../src/Common/events/Listen'
import {replayListen} from '../src/Common/events/replay-listen'
import {createPeerHost} from '../src/Common/peer/peer-index'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

const PORT = Number(process.env.PORT ?? 8390)

// ============== demo media hub: per-account replay lines ==============
// Browser capture (cam/mic/screen) originates on the CLIENT, so the server side is a
// tiny relay: publish() feeds the publisher's line, watchers get plain Listen surfaces
// exposed through createRpcServerAuto like any other Listen. Video lines are keep-latest
// (a late joiner instantly gets the last frame), audio is a short lossless queue.
type tMediaKind = 'cam' | 'mic' | 'screen'

function createDemoMediaHub() {
    // [frame, sentAt]: wall-clock publish time rides along so viewers can show real latency
    function createLines() {
        return {
            cam: replayListen<[Uint8Array, number]>({history: 8, current: 'last', frame: tail => tail.length ? [tail[tail.length - 1]] : []}),
            screen: replayListen<[Uint8Array, number]>({history: 8, current: 'last', frame: tail => tail.length ? [tail[tail.length - 1]] : []}),
            mic: replayListen<[Uint8Array, number]>({history: 64}),
        }
    }
    const accounts = new Map<string, ReturnType<typeof createLines>>()
    function linesOf(account: string) {
        let lines = accounts.get(account)
        if (!lines) {
            lines = createLines()
            accounts.set(account, lines)
        }
        return lines
    }
    return {
        // what the publishing account calls
        publishOf(account: string) {
            return function publish(kind: tMediaKind, frame: Uint8Array, sentAt: number) {
                const line = linesOf(account)[kind]
                if (line) line[0](frame, sentAt)
            }
        },
        // what a watcher subscribes to
        watchOf(account: string) {
            const lines = linesOf(account)
            return {cam: lines.cam[1], mic: lines.mic[1], screen: lines.screen[1]}
        },
    }
}

const host = createPeerHost()
const mediaHub = createDemoMediaHub()
const app = express()
app.use(express.static(path.resolve(__dirname, 'public')))
app.get('/', (_req, res) => res.sendFile(path.resolve(__dirname, 'public', 'index.html')))

const httpServer = createServer(app)
// screen-share JPEG frames can exceed the 1MB Socket.IO default
const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})

ioServer.on('connection', function onDemoConnection(socket) {
    const account = String(socket.handshake.auth?.account ?? 'anon')
    const watch = String(socket.handshake.auth?.watch ?? (account == 'a' ? 'b' : 'a'))
    const peer = host.connection(account)
    const [disconnect, disconnectListen] = listen<[]>()
    socket.on('disconnect', () => { disconnect(); peer.close() })
    createRpcServerAuto({
        socket: {emit: (key, data) => socket.emit(key, data), on: (key, cb) => socket.on(key, cb)},
        socketKey: 'app',
        object: {
            // legacy key on the SAME connection — the SDK does not displace old code
            serverTime: () => new Date().toISOString(),
            peer: peer.fragment,
            media: {
                publish: mediaHub.publishOf(account),
                // the watched account's live lines, declared at connect time (auth.watch)
                peer: mediaHub.watchOf(watch),
            },
        },
        disconnectListen,
    })
    console.log(`[demo] ${account} connected (watching ${watch})`)
})

httpServer.listen(PORT, function onDemoListen() {
    console.log('[demo] shared-cursor stand is up:')
    console.log(`  tab A: http://localhost:${PORT}/?me=a&peer=b`)
    console.log(`  tab B: http://localhost:${PORT}/?me=b&peer=a`)
})
