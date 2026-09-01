// =====================================================================
// {{name}} node — the PROCESS host template
// =====================================================================
// TEMPLATE-OWNED: a service author never edits this file. All node BEHAVIOR
// (replica line with the to-leader offer, local token gate, command
// forwarding with the END client's token, register/heartbeat, the
// watch-own-row leave) is the library factory Observe.createStoreNode; the
// definition only parameterizes it. This file owns what only a process can
// own (doc/DYNAMIC-RUNTIME.md boundary): env, transports (http + Socket.IO
// + the upstream hub), the token CRYPTO (the codec is built HERE from the
// env secret — the factory receives a verifier, never a secret format), and
// process exit. Mirrors demo/mini-scale-node.ts, proven live on the stand.
//
// TODO(graduation): the '../../../src/...' imports below become the package
// entrypoints ('wenay-common2', 'wenay-common2/server/auth') when this
// template graduates out of the incubator into its own package.

import express from 'express'
import {createServer} from 'http'
import {Server as SocketIOServer} from 'socket.io'
import {io as ioClient} from 'socket.io-client'
import {createStoreNode, type StoreNodeDeps, type StoreNodePrincipal} from '../../../src/Common/Observe/store-node'
import {createRpcClientHub} from '../../../src/Common/rcp/rpc-clientHub'
import {createTokenCodec} from '../../../src/server/auth-token'
import {corsOrigins, nodeEnv} from './config'
import type {tServiceDefinition} from './leader'
import {serviceDefinition} from './service'

// ============================================================
// definition-driven node wiring (self-check boots this in-process)
// ============================================================

export type ServiceNodeDeps<S extends Record<string, any>> = {
    definition: tServiceDefinition<S>
    nodeId: string
    /** Token -> principal; a throw rejects. The entrypoint owns codec and secret. */
    verifyToken: (presented: unknown) => StoreNodePrincipal
    /** The resolved leader link; the entrypoint owns the transport under it. */
    upstream: StoreNodeDeps<S>['upstream']
    /** The entrypoint's socket-server hook; the factory serves every connection. */
    serve: Pick<StoreNodeDeps<S>['serve'], 'onConnection'>
    selfUrl: () => string
    /** The entrypoint owns the actual shutdown; called ONCE, after the grace. */
    onLeave: (reason: string) => void
    heartbeatMs?: number
    graceMs?: number
    log?: (line: string) => void
}

export function createServiceNode<S extends Record<string, any>>(deps: ServiceNodeDeps<S>) {
    const {definition} = deps
    return createStoreNode<S>({
        line: {
            nodeId: deps.nodeId,
            storeId: definition.storeId,
            originId: definition.originId,
            lineId: definition.name + '-' + deps.nodeId + '-line',
        },
        roster: {
            url: deps.selfUrl,
            ...(deps.heartbeatMs != undefined ? {heartbeatMs: deps.heartbeatMs} : {}),
            ...(deps.graceMs != undefined ? {graceMs: deps.graceMs} : {}),
        },
        auth: {verify: deps.verifyToken},
        commands: Object.keys(definition.commands),
        upstream: deps.upstream,
        serve: {
            onConnection: deps.serve.onConnection,
            // the service's wire identity: every surface is served under the definition name
            wrap: (fragment: Record<string, unknown>) => ({[definition.name]: fragment}),
        },
        onLeave: deps.onLeave,
        ...(deps.log ? {log: deps.log} : {}),
    })
}

// ============================================================
// process entrypoint: env → transports → factory → signals
// ============================================================

async function main() {
    const env = nodeEnv(process.env)
    const app = express()
    const httpServer = createServer(app)
    // browser clients arrive from the leader origin; this node is a second origin.
    // CORS is pinned to it (config.corsOrigins) so arbitrary websites cannot read
    // the ungated surface through a visitor's browser; Node clients have no Origin
    const ioServer = new SocketIOServer(httpServer, {
        cors: {origin: corsOrigins(process.env, [env.upstream]), methods: ['GET', 'POST']},
    })
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
                control: leader.control,
                commandsByToken: leader.commandsByToken,
                register: leader.register,
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

// Importable module + runnable entrypoint: main() runs only when this file is
// executed directly (self-check imports createServiceNode without a process host).
if (require.main == module) {
    main().catch(function fatal(error) {
        console.error(error)
        process.exit(2)
    })
}
