// =====================================================================
// rental leader — the PROCESS entrypoint of the example stand
// =====================================================================
// Owns what only a process can own (doc/DYNAMIC-RUNTIME.md boundary): env,
// transports (express + Socket.IO), the stand's token CRYPTO, and exit. All
// authority BEHAVIOR is the template factory createServiceLeader driven by
// the rental definition; this file only binds fragments to socket keys
// (applying the {[name]: ...} wire wrap — the serve.* fragments are bodies)
// and mounts the REST/OpenAPI surface from ./rest.
//
// Socket keys mirror the proven stand: ungated read ('app'), gated write
// ('scale'), and the node link ('node-link', served only to connections that
// presented the node token).
//
// TODO(graduation): the '../../../../src' imports become package entrypoints
// when the template graduates out of the incubator.

import express from 'express'
import {createServer} from 'http'
import {Server as SocketIOServer} from 'socket.io'
import {listen} from '../../../../src/Common/events/Listen'
import {createRpcServerAuto} from '../../../../src/Common/rcp/rpc-server-auto'
import {createTokenCodec} from '../../../../src/server/auth-token'
import {leaderEnv, portEnv} from '../../template/config'
import {createServiceLeader} from '../../template/leader'
import {createRentalRest} from './rest'
import {serviceDefinition} from './service'

const DEMO_ACCOUNT = 'demo-renter'
const DEMO_TTL_MS = 12 * 60 * 60 * 1000

async function main() {
    const env = leaderEnv(process.env)
    const port = portEnv(process.env, 'RENTAL_PORT') ?? 3400
    const name = serviceDefinition.name
    const app = express()
    const httpServer = createServer(app)
    // node processes and future browser stands arrive from other origins
    const ioServer = new SocketIOServer(httpServer, {cors: {origin: true, methods: ['GET', 'POST']}})

    let url = ''
    const leader = createServiceLeader({
        definition: serviceDefinition,
        selfUrl: () => url,
        // absent env secrets stay absent: the factory mints per-run ones and
        // run.mjs pins them through env so node processes can join
        secrets: env.secrets,
    })

    // ============== socket surfaces, one per audience ==============
    ioServer.on('connection', function onLeaderConnection(socket) {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const [gone, goneListen] = listen<[]>()

        // the node link: only for connections that presented the node token
        if (auth?.role == 'service-node') {
            if (auth?.token != leader.secrets.nodeToken) {
                socket.disconnect(true)
                return
            }
            socket.on('disconnect', function nodeLinkGone() { gone() })
            createRpcServerAuto({
                socket,
                socketKey: 'node-link',
                object: {[name]: leader.serve.nodeLinkFragment()},
                disconnectListen: goneListen,
            })
            console.log(`[${name}] node link connected`)
            return
        }

        // gated write surface on its own key — the same wire shape as a node's
        const link = leader.serve.scaleConnection()
        socket.on('disconnect', function leaderClientGone() {
            gone()
            link.close()
        })
        const {control} = createRpcServerAuto({
            socket,
            socketKey: 'scale',
            object: link.object,
            auth: {
                gate: true,
                resolveAuth: function wrapResolvedPrincipal(presented: unknown) {
                    // the serve fragments are bodies; the entrypoint applies the wire wrap
                    const resolved = link.auth.resolveAuth(presented)
                    return {...resolved, object: {[name]: resolved.object}}
                },
            },
            disconnectListen: goneListen,
        })
        link.attach(control)

        // ungated read surface: the leader AS a node, shape-identical to one
        createRpcServerAuto({
            socket,
            socketKey: 'app',
            object: {[name]: leader.serve.readFragment()},
            disconnectListen: goneListen,
        })
    })

    // ============== the REST surface (step 7b pieces over the running service) ==============
    createRentalRest({
        app,
        board: leader.view.reader,
        // the corridor facet is the honest address for the token hop; the node
        // link retransmits the same fragment to trusted node connections
        corridor: leader.corridor.byToken(),
    })

    await new Promise<void>(function listenForClients(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(port, function bound() { resolve() })
    })
    url = 'http://localhost:' + port
    leader.control.start()

    // ============== the stand identity: a ready-made bearer ==============
    // Token crypto is a host concern: the entrypoint builds its own codec on the
    // SHARED corridor secret to mint a long-lived stand bearer — the leader's
    // internal 15-minute default would expire mid-demo. Every node and the
    // leader verify it like any login token.
    const standCodec = createTokenCodec({secret: leader.secrets.tokenSecret, ttlMs: DEMO_TTL_MS})
    const bearer = standCodec.issue({sub: DEMO_ACCOUNT})

    console.log(`[${name}] leader listening on ${url}`)
    console.log(`[${name}]   board:   ${url}/board`)
    console.log(`[${name}]   docs:    ${url}/docs`)
    console.log(`[${name}]   openapi: ${url}/openapi.json`)
    console.log(`[${name}] demo bearer (account ${DEMO_ACCOUNT}, 12h) — paste into Swagger "Authorize":`)
    console.log(bearer)
    console.log(`[${name}] ready-made curl:`)
    console.log(`curl -X POST ${url}/api/rental/book -H "Authorization: Bearer ${bearer}"`
        + ` -H "Content-Type: application/json"`
        + ` -d "{\\"args\\":[\\"r-demo-1\\",{\\"itemId\\":\\"kayak\\",\\"from\\":\\"2026-09-01\\",\\"to\\":\\"2026-09-03\\"}]}"`)

    function shutdown(signal: string) {
        console.log(`[${name}] ${signal} — leader closing`)
        leader.control.close()
        ioServer.close()
        httpServer.close()
        setTimeout(function exitNow() { process.exit(0) }, 300)
    }
    process.once('SIGINT', function onSigint() { shutdown('SIGINT') })
    process.once('SIGTERM', function onSigterm() { shutdown('SIGTERM') })
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
