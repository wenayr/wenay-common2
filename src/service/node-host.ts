import type express from 'express'
import {io as ioClient} from 'socket.io-client'
import {createRpcClientHub} from '../Common/rcp/rpc-clientHub'
import {createTokenCodec} from '../server/auth-token'
import {SYSTEM_ACCOUNT, type tServiceDefinition} from './definition'
import {corsOrigins, nodeEnv, servicePublicUrl, type tEnv} from './config'
import {createHostResource} from './http-resource'
import {createHostLifecycle, installServiceSignals, type ServiceHostOptions, type tServiceDisposer} from './host-lifecycle'
import {createServiceNode} from './node'
export type NodeProcessDeps<S extends Record<string, any>> = ServiceHostOptions & {
    definition: tServiceDefinition<S>
    /** Defaults to process.env: SERVICE_NODE_ID, SERVICE_UPSTREAM, the two corridor secrets, SERVICE_PORT. */
    env?: tEnv
    mount?: (host: {app: express.Express, node: ReturnType<typeof createServiceNode<S>>, url: () => string, signal: AbortSignal}) => void | tServiceDisposer | Promise<void | tServiceDisposer>
    graceMs?: number
}

/** Owned service host. No process handlers or process.exit; mount returns its disposer. */
export async function createServiceNodeHost<S extends Record<string, any>>(deps: NodeProcessDeps<S>) {
    const serviceDefinition = deps.definition
    const processEnv = deps.env ?? process.env
    const env = nodeEnv(processEnv)
    const advertised = servicePublicUrl(deps.publicUrl ?? env.publicUrl)
    const lifecycle = createHostLifecycle(deps)
    return lifecycle.start(async function startNodeHost() {
        const host = createHostResource({host: deps.host ?? env.host, port: env.port ?? 0, closeTimeoutMs: deps.closeTimeoutMs,
            origins: () => deps.origins ?? corsOrigins(processEnv, [env.upstream]),
        })
        lifecycle.own(host.close)
        const {app, io: ioServer, server: httpServer} = host.resource
        const hub = createRpcClientHub(
            () => ioClient(env.upstream, {
                transports: ['websocket'],
                auth: {role: 'service-node', node: env.nodeId, token: env.nodeToken},
            }),
            r => ({link: r<any>('node-link')}) as const,
        )
        lifecycle.own(function closeHub() { hub.close() })
        const codec = createTokenCodec({secret: env.tokenSecret})

        let url = ''
        const node = createServiceNode<S>({
            definition: serviceDefinition,
            nodeId: env.nodeId,
            graceMs: deps.graceMs,
            verifyToken: function verifyPresentedToken(presented) {
                const verdict = codec.verify(presented)
                if (!verdict.ok) throw new Error('token rejected: ' + verdict.reason)
                // the host principal is never a token: a forged `system` claim is refused here too
                if (verdict.claims.sub == SYSTEM_ACCOUNT) throw new Error('token rejected: reserved account')
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
            selfUrl: () => advertised ?? url,
            // the factory has completed the drain grace; only the process remains
            onLeave: function shutdownAfterLeave() {
                void lifecycle.close().catch(function failed(error) { console.error(error) })
            },
        })
        lifecycle.own(node.close)
        const unmount = await deps.mount?.({app, node, url: () => url, signal: lifecycle.signal})
        if (unmount) lifecycle.own(unmount)
        if (lifecycle.signal.aborted) throw lifecycle.signal.reason

        await host.control.listen()
        url = host.view.url()
        const publicUrl = advertised ?? url
        await node.start()
        if (lifecycle.signal.aborted) throw lifecycle.signal.reason
        let stopping: Promise<void> | undefined
        function close() {
            if (stopping) return stopping
            // goodbye removes eligibility before the node's existing drain grace closes sockets.
            node.leave('host closed')
            stopping = new Promise<void>(function waitForLeave(resolve, reject) {
                if (lifecycle.signal.aborted) { lifecycle.close().then(resolve, reject); return }
                lifecycle.signal.addEventListener('abort', function left() { lifecycle.close().then(resolve, reject) }, {once: true})
            })
            return stopping
        }
        return {node, url, publicUrl, app, httpServer, close, shutdown: close}
    })
}

export async function runNodeProcess<S extends Record<string, any>>(deps: NodeProcessDeps<S>) {
    const host = await createServiceNodeHost(deps)
    const signals = installServiceSignals({close: host.close})
    // A roster drain also closes a process adapter and releases its IPC ownership.
    host.httpServer.once('close', function hostClosed() { void signals.close().catch(function failed() {}) })
    return {...host, close: signals.close, shutdown: signals.close}
}
