import type express from 'express'
import path from 'node:path'
import {mkdirSync} from 'node:fs'
import {listen} from '../Common/events/Listen'
import {createRpcServerAuto} from '../Common/rcp/rpc-server-auto'
import type {ScaleDurableLine} from '../Common/scale/scale-authority'
import {openFsReplayStorage} from '../server/fsReplayStorage'
import {createServiceLeader, type ServiceLeader} from './leader'
import type {tServiceDefinition} from './definition'
import type {ServiceResourceOptions} from './resource-definition'
import {corsOrigins, leaderEnv, servicePublicUrl, type tEnv} from './config'
import {createServiceRest} from './rest'
import {createHostResource} from './http-resource'
import {createHostLifecycle, installServiceSignals, type ServiceHostOptions, type tServiceDisposer} from './host-lifecycle'

export type LeaderProcessDeps<D extends tServiceDefinition<any, any>> = ServiceHostOptions & {
    definition: D
    /** Defaults to process.env: SERVICE_PORT, the corridor secrets, CORS, SERVICE_PRINT_JOIN_ENV. */
    env?: tEnv
    /** Mount the REST/OpenAPI/panel surface (default true); SERVICE_REST=0 disables it too. */
    rest?: boolean
    resourceOptions?: ServiceResourceOptions
    /** The durable line; defaults to SERVICE_DATA_DIR (one JSONL archive per service) when that env is set. */
    durable?: ScaleDurableLine
    /** The control line's archive; defaults to SERVICE_DATA_DIR too (`<name>.control.jsonl`). */
    durableControl?: ScaleDurableLine
    /** Extra host wiring over the express app and the leader (a product's own pages, webhooks). */
    mount?: (host: {app: express.Express, leader: ServiceLeader<D>, url: () => string, signal: AbortSignal}) => void | tServiceDisposer | Promise<void | tServiceDisposer>
}

/** Owned service host. No process handlers or process.exit; mount returns its disposer. */
export async function createServiceLeaderHost<D extends tServiceDefinition<any, any>>(deps: LeaderProcessDeps<D>) {
    const serviceDefinition = deps.definition
    const processEnv = deps.env ?? process.env
    const env = leaderEnv(processEnv)
    const advertised = servicePublicUrl(deps.publicUrl ?? env.publicUrl)
    const name = serviceDefinition.name
    const lifecycle = createHostLifecycle(deps)
    return lifecycle.start(async function startLeaderHost() {
        let url = ''
        const host = createHostResource({host: deps.host ?? env.host, port: env.port ?? 0, closeTimeoutMs: deps.closeTimeoutMs,
            origins: () => deps.origins ?? corsOrigins(processEnv, url ? [url] : []),
        })
        lifecycle.own(host.close)
        const {app, io: ioServer, server: httpServer} = host.resource

        // day N: SERVICE_DATA_DIR turns the line AND the control line durable — nothing else changes
        let durable = deps.durable
        let durableControl = deps.durableControl
        if (env.dataDir) {
            mkdirSync(env.dataDir, {recursive: true})
            durable ??= {storage: openFsReplayStorage(path.join(env.dataDir, name + '.jsonl'))}
            durableControl ??= {storage: openFsReplayStorage(path.join(env.dataDir, name + '.control.jsonl'))}
        }
        const leader = createServiceLeader<D>({
            definition: serviceDefinition, selfUrl: () => advertised ?? url, secrets: env.secrets,
            resourceOptions: deps.resourceOptions,
            ...(durable ? {durable} : {}), ...(durableControl ? {durableControl} : {}),
        })

        lifecycle.own(leader.control.close)

        // the HTTP face: views, commands, login, OpenAPI, Swagger UI and the generic role panel —
        // every service gets it from the definition, a product mounts its own pages beside it
        const rest = deps.rest != false && processEnv['SERVICE_REST'] != '0'
            ? createServiceRest<D>({app, leader, definition: serviceDefinition})
            : null
        const unmount = await deps.mount?.({app, leader, url: () => url, signal: lifecycle.signal})
        if (unmount) lifecycle.own(unmount)
        if (lifecycle.signal.aborted) throw lifecycle.signal.reason

        ioServer.on('connection', function onLeaderConnection(socket) {
            const auth = socket.handshake.auth as Record<string, unknown> | undefined
            const [gone, goneListen] = listen<[]>()

            // the node link: only for connections that presented the node token, bound to the claimed id
            if (auth?.['role'] == 'service-node') {
                const nodeId = String(auth?.['node'] ?? '')
                if (!nodeId || auth?.['token'] != leader.secrets.nodeToken) {
                    socket.disconnect(true)
                    return
                }
                socket.on('disconnect', function nodeLinkGone() { gone() })
                createRpcServerAuto({
                    socket,
                    socketKey: 'node-link',
                    object: {[name]: leader.serve.nodeLinkFragment(nodeId)},
                    disconnectListen: goneListen,
                })
                console.log(`[${name}] node ${nodeId} linked`)
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

            if (serviceDefinition.resources) {
                const resources = leader.serve.resourceConnection()
                socket.on('disconnect', function resourcesGone() { void resources.close().catch(function observed() {}) })
                const resourceServer = createRpcServerAuto({socket, socketKey: 'resources', object: resources.object,
                    auth: resources.auth, hooks: resources.hooks, disconnectListen: goneListen})
                resources.attach(resourceServer.control)
            }

            // ungated participant surface: the line, the roster projection, identity, the read view
            createRpcServerAuto({
                socket,
                socketKey: 'app',
                object: {[name]: leader.serve.browserFragment(String(auth?.['account'] ?? 'anonymous'))},
                disconnectListen: goneListen,
            })
        })

        await host.control.listen()
        url = host.view.url()
        const publicUrl = advertised ?? url
        leader.control.start()
        const restored = leader.view.restored()
        if (restored) console.log(`[${name}] durable line at seq ${restored.seq}${restored.fromArchive ? ', restored from the archive' : ', fresh archive'}`)
        if (restored?.control) console.log(`[${name}] control line (receipts, deny list) at seq ${restored.control.seq}${restored.control.fromArchive ? ', restored from the archive' : ', fresh archive'}`)
        console.log(`[${name}] leader listening on ${url}`)
        if (publicUrl != url) console.log(`[${name}] advertised at ${publicUrl}`)
        if (rest) console.log(`[${name}]   panel: ${url}/panel   docs: ${url}/docs   openapi: ${url}/openapi.json`)
        console.log(`[${name}] a node joins with: SERVICE_UPSTREAM=${url} SERVICE_NODE_ID=<id> and the two corridor secrets of this run`)
        // the secrets are printed ONLY on request: a log line is not a secret store
        if (processEnv['SERVICE_PRINT_JOIN_ENV'] == '1') {
            console.log(`SERVICE_NODE_TOKEN=${leader.secrets.nodeToken}`)
            console.log(`SERVICE_TOKEN_SECRET=${leader.secrets.tokenSecret}`)
        }

        return {leader, url, publicUrl, rest, app, httpServer, close: lifecycle.close, shutdown: lifecycle.close}
    })
}

export async function runLeaderProcess<D extends tServiceDefinition<any, any>>(deps: LeaderProcessDeps<D>) {
    const host = await createServiceLeaderHost(deps)
    const signals = installServiceSignals({close: host.close})
    host.httpServer.once('close', function hostClosed() { void signals.close().catch(function failed() {}) })
    function shutdown(_reason?: string) { return signals.close() }
    return {...host, close: signals.close, shutdown}
}
