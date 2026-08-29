// Mini service node — the PROCESS host only. All node behavior (replica line,
// token layer, per-connection RPC, registration, own-row leave) lives in the
// LIBRARY factory Observe.createStoreNode; this file parses env, owns the
// transports (http + Socket.IO + the upstream hub), owns the token CRYPTO
// (the library receives a verifier, never a secret format), and owns exit.
import express from 'express'
import {createServer} from 'http'
import {Server as SocketIOServer} from 'socket.io'
import {io as ioClient} from 'socket.io-client'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createStoreNode} from '../src/Common/Observe/store-node'
import {createTokenCodec} from '../src/server/auth-token'
import {demoRpcOpt} from './protocol-schema'

const nodeId = process.env.MINI_NODE_ID?.trim() ?? ''
const upstream = process.env.MINI_UPSTREAM?.trim() ?? ''
const token = process.env.MINI_TOKEN ?? ''
const secret = process.env.MINI_SECRET ?? ''
if (!nodeId || !upstream || !secret) {
    console.error('mini node needs MINI_NODE_ID, MINI_UPSTREAM and MINI_SECRET')
    process.exit(1)
}

async function main() {
    const app = express()
    const httpServer = createServer(app)
    // The stand page lives on the leader origin; this node is a second origin.
    const ioServer = new SocketIOServer(httpServer, {cors: {origin: true, methods: ['GET', 'POST']}})
    // ghost-hunt instrumentation: engine connections vs the line count is the
    // discriminating fact (ghost subs riding live sessions vs zombie sockets)
    let lastClients = -1
    const clientsWatch = setInterval(function reportEngineClients() {
        const clients = Number((ioServer as any).engine?.clientsCount ?? -1)
        if (clients != lastClients) {
            lastClients = clients
            console.log(`engine clients: ${clients}`)
        }
    }, 3000)
    ;(clientsWatch as any).unref?.()
    const hub = createRpcClientHub(
        () => ioClient(upstream, {
            transports: ['websocket'],
            auth: {tab: 'mini-' + nodeId, role: 'mini-node', token},
        }),
        r => ({app: r<any>('app')}) as const,
        {opt: demoRpcOpt},
    )
    const codec = createTokenCodec({secret})

    let url = ''
    const node = createStoreNode({
        nodeId,
        storeId: 'mini-scale', originId: 'mini-scale-origin', lineId: 'mini-' + nodeId + '-line',
        auth: {
            verify: function verifyMiniToken(presented) {
                const verdict = codec.verify(presented)
                if (!verdict.ok) throw new Error('token rejected: ' + verdict.reason)
                return {account: verdict.claims.sub, expiresAt: verdict.claims.exp}
            },
        },
        commands: ['add'],
        upstream: async function resolveLeaderLink() {
            const clients = await hub.setToken(null)
            await clients.app.readyStrict()
            console.log('leader link ready')
            const leader = (clients.app.func as any).miniScale
            return {
                replica: leader.replica,
                directory: leader.directory,
                revoked: leader.revoked,
                commandsByToken: leader.commandsByToken,
                // pid rides the registration: the panel shows every node as the OS process it is
                register: (entry: {nodeId: string, url: string, weight: number}) => leader.register({...entry, pid: process.pid}),
                heartbeat: leader.heartbeat,
                goodbye: leader.goodbye,
                onFail: {on: (cb: () => void) => hub.disconnectListen(cb)},
            }
        },
        serve: {onConnection(handler) { ioServer.on('connection', handler) }},
        selfUrl: () => url,
        wrap: fragment => ({miniScale: fragment}),
        opt: demoRpcOpt,
        // the factory has already said goodbye after the drain grace; only the process remains
        onLeave: function shutdownAfterLeave() {
            ioServer.close()
            httpServer.close()
            setTimeout(function exitNow() { process.exit(0) }, 300)
        },
    })

    const port = await new Promise<number>(function listenEphemeral(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(0, function bound() { resolve((httpServer.address() as any).port) })
    })
    url = 'http://localhost:' + port
    await node.start()

    process.once('SIGTERM', function onSigterm() { node.leave('SIGTERM') })
    process.once('SIGINT', function onSigint() { node.leave('SIGINT') })
}
main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
