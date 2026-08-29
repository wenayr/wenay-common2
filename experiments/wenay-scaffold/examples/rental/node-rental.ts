// =====================================================================
// rental node — the PROCESS entrypoint of one serving node
// =====================================================================
// A line-for-line mirror of template/node.ts main() with ONE change: the
// definition is the rental one. The template's main() is module-private and
// bound to its own ./service import, so an example cannot reuse it directly —
// reported as a graduation candidate (export main(definition)). Everything a
// node DOES still comes from the template factory createServiceNode; this
// file owns env, transports, the token codec, and process exit only
// (doc/DYNAMIC-RUNTIME.md boundary).
//
// Env (template/config.ts): SERVICE_NODE_ID, SERVICE_UPSTREAM,
// SERVICE_NODE_TOKEN, SERVICE_TOKEN_SECRET, optional SERVICE_PORT.
//
// TODO(graduation): the '../../../../src' imports become package entrypoints
// when the template graduates out of the incubator.

import express from 'express'
import {createServer} from 'http'
import {Server as SocketIOServer} from 'socket.io'
import {io as ioClient} from 'socket.io-client'
import {createRpcClientHub} from '../../../../src/Common/rcp/rpc-clientHub'
import {createTokenCodec} from '../../../../src/server/auth-token'
import {nodeEnv} from '../../template/config'
import {createServiceNode} from '../../template/node'
import {serviceDefinition} from './service'

async function main() {
    const env = nodeEnv(process.env)
    const app = express()
    const httpServer = createServer(app)
    // browser clients arrive from the leader origin; this node is a second origin
    const ioServer = new SocketIOServer(httpServer, {cors: {origin: true, methods: ['GET', 'POST']}})
    const hub = createRpcClientHub(
        () => ioClient(env.upstream, {
            transports: ['websocket'],
            auth: {role: 'service-node', node: env.nodeId, token: env.nodeToken},
        }),
        r => ({link: r<any>('node-link')}) as const,
    )
    const codec = createTokenCodec({secret: env.tokenSecret})

    let url = ''
    const node = createServiceNode({
        definition: serviceDefinition,
        nodeId: env.nodeId,
        verifyToken: function verifyPresentedToken(presented) {
            const verdict = codec.verify(presented)
            if (!verdict.ok) throw new Error('token rejected: ' + verdict.reason)
            return {account: verdict.claims.sub, expiresAt: verdict.claims.exp}
        },
        upstream: async function resolveLeaderLink() {
            const clients = await hub.setToken(null)
            await clients.link.readyStrict()
            const leader = (clients.link.func as any)[serviceDefinition.name]
            return {
                replica: leader.replica,
                directory: leader.directory,
                revoked: leader.revoked,
                commandsByToken: leader.commandsByToken,
                // pid rides the registration: every node is visible as the OS process it is
                register: (entry: {nodeId: string, url: string, weight: number}) => leader.register({...entry, pid: process.pid}),
                heartbeat: leader.heartbeat,
                goodbye: leader.goodbye,
                onFail: {on: (cb: () => void) => hub.disconnectListen(cb)},
            }
        },
        serve: {onConnection(handler) { ioServer.on('connection', handler) }},
        selfUrl: () => url,
        // the factory has already said goodbye after the drain grace; only the process remains
        onLeave: function shutdownAfterLeave() {
            ioServer.close()
            httpServer.close()
            setTimeout(function exitNow() { process.exit(0) }, 300)
        },
    })

    const port = await new Promise<number>(function listenForClients(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(env.port ?? 0, function bound() { resolve((httpServer.address() as any).port) })
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
