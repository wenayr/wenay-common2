// Demo stand server: the Peer SDK next to a legacy rpc key, static page hosting.
// Run: npm run demo  ->  open the two printed URLs in two tabs.
import express from 'express'
import {createServer} from 'http'
import path from 'path'
import {Server as SocketIOServer} from 'socket.io'
import {listen} from '../src/Common/events/Listen'
import {createPeerHost} from '../src/Common/peer/peer-index'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

const PORT = Number(process.env.PORT ?? 8390)

const host = createPeerHost()
const app = express()
app.use(express.static(path.resolve(__dirname, 'public')))
app.get('/', (_req, res) => res.sendFile(path.resolve(__dirname, 'public', 'index.html')))

const httpServer = createServer(app)
const ioServer = new SocketIOServer(httpServer)

ioServer.on('connection', function onDemoConnection(socket) {
    const account = String(socket.handshake.auth?.account ?? 'anon')
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
        },
        disconnectListen,
    })
    console.log(`[demo] ${account} connected`)
})

httpServer.listen(PORT, function onDemoListen() {
    console.log('[demo] shared-cursor stand is up:')
    console.log(`  tab A: http://localhost:${PORT}/?me=a&peer=b`)
    console.log(`  tab B: http://localhost:${PORT}/?me=b&peer=a`)
})
