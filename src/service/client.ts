// =====================================================================
// client — a service client from the definition: login, placement, views, commands
// =====================================================================
// Shared service runtime. What every front end, device or job needs from a service,
// derived from the SAME definition the leader runs, so the types are exact:
//   - identity: a token, or credentials the leader turns into one, renewed
//     through the leader's identity port before it expires (RPC-AUTH rule 4);
//   - placement: the leader's roster line picks WHERE to attach (a serving
//     node by weight, the leader alone on day 1), sticky until that endpoint
//     dies, then a new pick — the view lines hand off underneath;
//   - views: one replica set per view line the principal may read (public
//     views ungated, role views inside the gated facade), each a live Store;
//   - commands: typed calls through the CURRENT endpoint, forwarded by a node
//     or executed by the leader, never silently retried.
// The library primitives underneath: createRpcClientHub (token lifecycle),
// followNodeDirectory + pickDirectoryNode (placement), and one STABLE mirror
// Store per view over syncStoreReplayRoute — a view line is a plain replay
// line (no replica descriptor, so no replica-set fork choice): on re-placement
// the route resets to the new projection's keyframe and the mirror object a UI is
// bound to never changes. A product's UI binds to `views.<name>.store`.

import {io} from 'socket.io-client'
import {createRpcClientHub, type RpcHubAuthEvent} from '../Common/rcp/rpc-clientHub'
import {followNodeDirectory, pickDirectoryNode, type NodeDirectoryView} from '../Common/Observe/node-directory'
import {createStore, type Store} from '../Common/Observe/store'
import {syncStoreReplayRoute} from '../Common/Observe/store-replay'
import {listen} from '../Common/events/Listen'
import {createServiceResources} from './resource-client'
export type {ServiceResourceController} from './resource-client'
import type {ServiceResourceOptions} from './resource-definition'
import type {ServiceClientDefinition} from './descriptor'
export {describeService, type ServiceClientDefinition} from './descriptor'
import type {ServicePermissions, tServiceCommand, tServiceDefinition, tServiceView} from './definition'

export type tServiceAuth =
    | {token: string}
    /** The definition's login form; the leader mints the token (and renews it). */
    | {credentials: unknown}
    /** A product's own identity provider: called whenever a token is needed. */
    | {login: () => Promise<string>}

export type ServiceClientDeps<D extends tServiceDefinition<any, any>> = {
    definition: D | ServiceClientDefinition<D>
    /** The leader's origin: identity and the roster live there. */
    url: string
    /** Absent = anonymous: public views only, no commands. */
    auth?: tServiceAuth
    /** Persist a newly acquired token; also available through identity.onToken. */
    onToken?: (token: string) => void
    placement?: {
        /** 'nodes' (default): the leader is used only when no serving node is eligible; 'any': weighted over every row. */
        prefer?: 'nodes' | 'any'
        rng?: () => number
    }
    /** Stable identity of this client's lines (default: random). */
    clientId?: string
    /** Socket handshake auth for a custom host; the service hosts bind no identity from it. */
    handshake?: Record<string, unknown>
    log?: (line: string) => void
    resourceOptions?: ServiceResourceOptions
}

// ============================================================
// types derived from the definition
// ============================================================

type tViewsOf<D> = D extends {views: infer V extends Record<string, tServiceView<any>>} ? V : {}
type tProjectionOf<V> = V extends {project: (...args: any[]) => infer P extends object} ? P : never
type tCommandsOf<D> = D extends {commands: infer C extends Record<string, tServiceCommand<any>>} ? C : {}
export type tClientCommands<D> = tCommandsOf<D> extends infer C extends Record<string, tServiceCommand<any>>
    ? {[K in keyof C & string]: (requestId: string, input: Parameters<C[K]['apply']>[1]) => Promise<Awaited<ReturnType<C[K]['apply']>>>}
    : {}
export type tClientViews<D> = {
    [K in keyof tViewsOf<D> & string]: ServiceClientView<tProjectionOf<tViewsOf<D>[K]>>
}
export type ServiceClientView<P extends object> = {
    /** The live projection; bind a UI to it — the object survives re-placement. */
    store: Store<P>
    /** Resolves on the first permitted keyframe; waits while this view is denied. */
    ready: Promise<void>
    /** The line's seq on the current endpoint (-1 before the first keyframe). */
    seq: () => number
    close: () => void
}

// ============================================================
// the client
// ============================================================

export function createServiceClient<D extends tServiceDefinition<any, any>>(deps: ServiceClientDeps<D>) {
    const definition = deps.definition
    const name = definition.name
    const log = deps.log ?? (() => {})
    const clientId = deps.clientId ?? 'client-' + Math.random().toString(36).slice(2, 10)
    const rng = deps.placement?.rng ?? Math.random
    const prefer = deps.placement?.prefer ?? 'nodes'
    const viewNames = Object.keys(definition.views ?? {})
    const publicViews = new Set(viewNames.filter(view => definition.views![view].allow == 'public'))
    const health = createStore({connected: false, nodeId: '', url: ''})
    const permissions = createStore<{account: string | null, roles: readonly string[], views: string[], commands: string[], resources?: string[]}>({
        account: null, roles: [], views: [...publicViews], commands: [],
    })
    const [emitToken, tokenEvents] = listen<[string]>()
    const [emitAuth, authEvents] = listen<[RpcHubAuthEvent]>()
    if (deps.onToken) tokenEvents.on(deps.onToken)
    let closed = false
    function requireOpen() {
        if (closed) throw new Error(`client ${clientId} is closed`)
    }

    // ============== the leader: identity and the roster ==============
    const leaderHub = createRpcClientHub(
        () => io(deps.url, {transports: ['websocket'], forceNew: true, auth: deps.handshake ?? {}}),
        r => ({app: r<any>('app')}),
    )
    let leaderRead: any = null
    async function leader() {
        requireOpen()
        if (leaderRead) return leaderRead
        const clients = await leaderHub.setToken(null)
        await clients.app.readyStrict()
        requireOpen()
        leaderRead = clients.app.func[name]
        return leaderRead
    }

    // ============== identity: mint, renew ==============
    let token: string | null = null
    let account: string | null = null
    function acceptToken(next: string) {
        requireOpen()
        if (token != next) { token = next; emitToken(next) }
        return next
    }
    async function mint() {
        requireOpen()
        const auth = deps.auth
        if (!auth) return null
        if ('token' in auth) return acceptToken(auth.token)
        if ('login' in auth) {
            const minted = await auth.login()
            requireOpen()
            return acceptToken(minted)
        }
        const minted = await (await leader()).identity.login(auth.credentials) as {token: string, account: string}
        requireOpen()
        account = minted.account
        return acceptToken(minted.token)
    }
    async function renew() {
        if (!token || !deps.auth || 'login' in deps.auth) return mint()
        // A ready token is a seed, not a permanent renewal result. Never lift revocation by logging in.
        const renewed = await (await leader()).identity.renew(token) as {token: string}
        return acceptToken(renewed.token)
    }
    const resources = createServiceResources<D>({definition, url: deps.url, options: deps.resourceOptions,
        token: async function resourceToken(refresh) {
            requireOpen()
            return refresh || (deps.auth && 'login' in deps.auth) ? renew() : token ?? mint()
        },
        tokens: tokenEvents.on,
    })

    // ============== placement: the roster picks the endpoint ==============
    let directory: ReturnType<typeof followNodeDirectory> | null = null
    let stopDirectory: (() => void) | undefined
    const endpointWaitMs = 5000
    const failedEndpoints = new Map<string, {url: string, retryAt: number}>()
    function avoidEndpoint(node: NodeDirectoryView) {
        // Authority remains retryable on the next placement wave, including after restart.
        if (node.role != 'leader') failedEndpoints.set(node.nodeId, {url: node.url, retryAt: Date.now() + 15_000})
    }
    async function pickEndpoint(attempted: Set<string>) {
        if (!directory) {
            const remote = await leader()
            requireOpen()
            directory = followNodeDirectory(remote.roster)
            stopDirectory = directory.onNodes(function routesChanged(rows) {
                function eligible(node: NodeDirectoryView) {
                    return rows.some(row => row.nodeId == node.nodeId && row.url == node.url && row.eligible)
                }
                if (pendingNode && !eligible(pendingNode)) {
                    pendingHub?.close('endpoint withdrawn from roster')
                    stopPendingRights?.()
                }
                if (session && !eligible(session.node)) detach(session)
            })
            await directory.ready
        }
        requireOpen()
        const rows = directory.nodes()
        for (const [id, failed] of failedEndpoints) {
            const row = rows.find(row => row.nodeId == id)
            if (!row?.eligible || row.url != failed.url || Date.now() >= failed.retryAt) failedEndpoints.delete(id)
        }
        const available = rows.filter(row => row.eligible && !attempted.has(row.nodeId) && !failedEndpoints.has(row.nodeId))
        const nodes = available.filter(row => row.role != 'leader')
        const pool = prefer == 'nodes' && nodes.length ? nodes : available
        const picked = pickDirectoryNode(pool, {rng})
        if (!picked) throw new Error(`client ${clientId}: no eligible endpoint in the roster`)
        return picked
    }

    // ============== the session: one hub to the picked endpoint ==============
    type tSession = {
        node: NodeDirectoryView, hub: ReturnType<typeof createSessionHub>, api: {app: any, scale: any | null},
        rights: Store<ServicePermissions>, stopRights: () => void, granted: string, refreshing: Promise<void> | null, authorized: boolean,
        resetRights: () => Promise<void>,
    }
    let session: tSession | null = null
    let opening: Promise<tSession> | null = null
    let pendingHub: ReturnType<typeof createSessionHub> | null = null
    let pendingNode: NodeDirectoryView | null = null
    let stopPendingRights: (() => void) | null = null
    function publishPermissions(opened: tSession) {
        const value = opened.rights.snapshot()
        if (permissions.state.account != null && permissions.state.account != value.account) forgetPermissions()
        account = value.account
        permissions.replace(value)
        for (const [name, view] of openViews) if (!value.views.includes(name)) view.suspend()
    }
    function forgetPermissions() {
        permissions.replace({account: null, roles: [], views: [...publicViews], commands: []})
        for (const [name, view] of openViews) if (!publicViews.has(name)) view.suspend()
    }
    function detach(opened: tSession) {
        if (session != opened) return
        session = null
        health.replace({connected: false, nodeId: '', url: ''})
        opened.stopRights()
        opened.hub.close()
        for (const reattach of reattachers) reattach()
    }
    function refreshPermissions(opened: tSession) {
        if (closed || session != opened || !opened.authorized) return
        publishPermissions(opened)
        if (!opened.refreshing) trackRefresh(opened, refresh())
        async function refresh() {
            try {
                await synchronizeFacade(opened)
                if (!closed && session == opened) for (const reattach of reattachers) reattach()
            } catch (error) {
                if (!closed && session == opened) {
                    log(`client ${clientId}: permission refresh failed (${(error as Error)?.message ?? error})`)
                    forgetPermissions()
                    detach(opened)
                }
            }
        }
    }
    async function synchronizeFacade(opened: tSession) {
        const timeout = setTimeout(function refreshExpired() { opened.hub.close('permission refresh timed out') }, endpointWaitMs)
        try {
            while (!closed && session == opened && opened.authorized) {
                const wanted = JSON.stringify(opened.rights.snapshot())
                if (wanted == opened.granted) return
                const acknowledgements = await opened.hub.reauth(token)
                if (acknowledgements.some(ack => ack?.ok == false)) throw new Error('permission refresh refused')
                opened.granted = wanted
            }
        } finally {
            clearTimeout(timeout)
        }
    }
    function trackRefresh(opened: tSession, work: Promise<void>) {
        const pending = work.finally(function settled() {
            if (opened.refreshing == pending) opened.refreshing = null
        })
        opened.refreshing = pending
    }
    function refreshIdentity(opened: tSession) {
        const previous = opened.refreshing
        trackRefresh(opened, reload())
        async function reload() {
            try {
                await previous
                if (closed || session != opened) return
                opened.authorized = false
                // A renewed token may name a new account and therefore a new permissions sequence.
                await opened.resetRights()
                if (closed || session != opened) return
                // Rights may have changed after the token grant but before its snapshot arrived.
                opened.granted = ''
                opened.authorized = true
                publishPermissions(opened)
                await synchronizeFacade(opened)
                if (closed || session != opened) return
                for (const reattach of reattachers) reattach()
            } catch (error) {
                if (closed || session != opened) return
                log(`client ${clientId}: renewed permissions failed (${(error as Error)?.message ?? error})`)
                forgetPermissions()
                detach(opened)
            }
        }
    }
    function createSessionHub(node: NodeDirectoryView) {
        return createRpcClientHub(
            () => io(node.url, {transports: ['websocket'], forceNew: true, auth: deps.handshake ?? {}}),
            r => ({app: r<any>('app'), scale: r<any>('scale')}),
            deps.auth ? {token: async function supplyToken({reason}: {reason: string}) {
                return (reason == 'connect' && token) ? token : renew()
            }} : {},
        )
    }
    async function connectEndpoint(node: NodeDirectoryView): Promise<tSession> {
        requireOpen()
        const hub = createSessionHub(node)
        pendingHub = hub
        pendingNode = node
        let expired = false
        // Closing the hub also settles a pending token issuer, socket or RPC handshake.
        const timeout = setTimeout(function endpointExpired() {
            expired = true
            hub.close(`endpoint ${node.nodeId} readiness timed out`)
            stopPendingRights?.()
        }, endpointWaitMs)
        let stopRights = function noRightsLine() {}
        try {
            let api: {app: any, scale: any | null}
            if (deps.auth) {
                const clients = await hub.promise
                await clients.app.readyStrict()
                await clients.scale.readyStrict()
                api = {app: clients.app.func[name], scale: clients.scale.func[name]}
            } else {
                const clients = await hub.setToken(null)
                await clients.app.readyStrict()
                api = {app: clients.app.func[name], scale: null}
            }
            requireOpen()
            const rights = createStore<ServicePermissions>({account: '', roles: [], views: [...publicViews], commands: []})
            const opened: tSession = {
                node, hub, api, rights, stopRights, granted: '', refreshing: null, authorized: !!api.scale,
                resetRights: async function noPermissions() {},
            }
            if (api.scale) {
                const line = syncStoreReplayRoute(rights, api.scale.permissions, {
                    timeoutMs: endpointWaitMs,
                    onBatch: function permissionsChanged() { refreshPermissions(opened) },
                })
                stopRights = line
                opened.stopRights = line
                opened.resetRights = function resetPermissions() {
                    return line.switch(api.scale.permissions, {reset: true, since: -1, timeoutMs: endpointWaitMs})
                }
                stopPendingRights = line
                await line.ready
                requireOpen()
                if (expired) throw new Error('endpoint permissions readiness timed out')
            }
            hub.authListen(function authChanged(event) {
                if (event.key != 'scale' || closed || session != opened) return
                if (event.state == 'revoked' || event.state == 'expired') {
                    opened.authorized = false
                    forgetPermissions()
                }
                if (event.state == 'renewed') {
                    refreshIdentity(opened)
                }
                emitAuth(event)
            })
            hub.disconnectListen(function endpointGone() {
                if (closed || session != opened) return
                log(`client ${clientId}: endpoint ${node.nodeId} gone; placing again`)
                avoidEndpoint(node)
                detach(opened)
            })
            log(`client ${clientId}: attached to ${node.nodeId} (${node.url})`)
            return opened
        } catch (error) {
            stopRights()
            hub.close()
            throw error
        } finally {
            clearTimeout(timeout)
            if (pendingHub == hub) { pendingHub = null; pendingNode = null }
            if (stopPendingRights == stopRights) stopPendingRights = null
        }
    }
    async function openSession(): Promise<tSession> {
        const attempted = new Set<string>()
        while (true) {
            const node = await pickEndpoint(attempted)
            attempted.add(node.nodeId)
            try {
                const opened = await connectEndpoint(node)
                if (!directory?.nodes().some(row => row.nodeId == node.nodeId && row.url == node.url && row.eligible)) {
                    opened.stopRights()
                    opened.hub.close()
                    continue
                }
                return opened
            } catch (error) {
                requireOpen()
                avoidEndpoint(node)
                log(`client ${clientId}: endpoint ${node.nodeId} failed (${(error as Error)?.message ?? error}); placing again`)
            }
        }
    }
    async function current() {
        requireOpen()
        if (session) {
            const opened = session
            await opened.refreshing
            requireOpen()
            if (session == opened) return opened
            return current()
        }
        opening ??= openSession().then(async function adopt(opened) {
            if (closed) { opened.hub.close(); requireOpen() }
            session = opened
            if (opened.api.scale) {
                publishPermissions(opened)
                trackRefresh(opened, synchronizeFacade(opened))
                try {
                    await opened.refreshing
                    requireOpen()
                    if (session != opened) throw new Error('endpoint changed during permission refresh')
                } catch (error) {
                    if (!closed && session == opened) { forgetPermissions(); detach(opened) }
                    throw error
                }
            }
            health.replace({connected: true, nodeId: opened.node.nodeId, url: opened.node.url})
            return opened
        }).finally(function settled() { opening = null })
        return opening
    }
    if (!deps.auth && viewNames.length && !publicViews.size) log(`client ${clientId}: anonymous, and every view is role-gated`)

    // ============== views: a stable mirror per line, the route switches on re-placement ==============
    const reattachers = new Set<() => void>()
    const views = {} as tClientViews<D>
    const openViews = new Map<string, {handle: ServiceClientView<any>, close: () => void, suspend: () => void}>()
    for (const view of viewNames) {
        Object.defineProperty(views, view, {
            enumerable: true,
            get() {
                requireOpen()
                const known = openViews.get(view)
                if (known) return known.handle
                const mirror = createStore<any>({})
                let route: ReturnType<typeof syncStoreReplayRoute<any>> | null = null
                let viewClosed = false
                let resolveReady!: () => void
                let rejectReady!: (error: unknown) => void
                const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
                ready.catch(() => {})
                let attempt = 0
                let generation = 0
                let retryTimer: ReturnType<typeof setTimeout> | undefined
                async function attach() {
                    if (closed || viewClosed) return
                    const epoch = ++generation
                    try {
                        const opened = await current()
                        if (closed || viewClosed || epoch != generation) return
                        if (!publicViews.has(view) && !permissions.state.views.includes(view)) {
                            suspend()
                            return
                        }
                        const facade = publicViews.has(view) ? opened.api.app : opened.api.scale
                        const remote = facade?.views?.[view]
                        if (!remote) throw new Error(`view ${view} is not served to this principal`)
                        if (!route) {
                            route = syncStoreReplayRoute(mirror, remote, {label: view})
                            await route.ready
                        } else {
                            // Each endpoint/session owns an independent projection sequence.
                            await route.switch(remote, {label: view, reset: true, since: -1})
                        }
                        if (closed || viewClosed || epoch != generation) return
                        resolveReady()
                        attempt = 0
                    } catch (error) {
                        if (closed || viewClosed || epoch != generation) return
                        attempt++
                        log(`client ${clientId}: view ${view} attach failed (${(error as Error)?.message ?? error})`)
                        if (!route && attempt >= 3) { rejectReady(error); return }
                        clearTimeout(retryTimer)
                        retryTimer = setTimeout(reattach, Math.min(500 * attempt, 5000))
                    }
                }
                function reattach() { clearTimeout(retryTimer); retryTimer = undefined; void attach() }
                function suspend() {
                    generation++
                    clearTimeout(retryTimer)
                    route?.()
                    route = null
                    mirror.replace({})
                }
                reattachers.add(reattach)
                void attach()
                const handle: ServiceClientView<any> = {
                    store: mirror, ready, seq: () => route?.seq() ?? -1,
                    close() {
                        if (viewClosed) return
                        viewClosed = true
                        clearTimeout(retryTimer)
                        rejectReady(new Error(`view ${view} is closed`))
                        reattachers.delete(reattach)
                        openViews.delete(view)
                        route?.()
                    },
                }
                openViews.set(view, {handle, close: handle.close, suspend})
                return handle
            },
        })
    }

    // ============== commands: through the current endpoint, typed from the definition ==============
    const commands = {} as tClientCommands<D>
    for (const command of Object.keys(definition.commands)) {
        Object.defineProperty(commands, command, {
            enumerable: true,
            value: async function callCommand(requestId: string, input: unknown) {
                const opened = await current()
                if (!permissions.state.commands.includes(command)) throw new Error(`forbidden: ${command} is not served to this principal`)
                const fragment = opened.api.scale?.commands
                if (!fragment) throw new Error(`commands need auth (client ${clientId} is anonymous)`)
                if (!fragment[command]) throw new Error(`forbidden: ${command} is not served to this principal`)
                return fragment[command](requestId, input)
            },
        })
    }

    async function me(): Promise<ServicePermissions> {
        const opened = await current()
        if (!opened.api.scale) throw new Error('anonymous client has no principal')
        return opened.api.scale.me()
    }

    function close() {
        if (closed) return
        closed = true
        resources.close()
        for (const handle of [...openViews.values()]) handle.close()
        pendingHub?.close()
        stopPendingRights?.()
        session?.stopRights()
        session?.hub.close()
        session = null
        stopDirectory?.()
        directory?.close()
        leaderHub.close()
        health.replace({connected: false, nodeId: '', url: ''})
        forgetPermissions()
        tokenEvents.close()
        authEvents.close()
    }

    return {
        /** Attach now (otherwise the first view or command does it). */
        ready: () => current().then(() => undefined),
        identity: {account: () => account, token: () => token, me, permissions, onToken: {on: tokenEvents.on}, onAuth: {on: authEvents.on}},
        health,
        views,
        commands,
        resources: resources.resource,
        view: {
            endpoint: () => session?.node ?? null,
            roster: () => directory?.nodes() ?? [],
        },
        control: {
            /** Leave the current endpoint and place again on the next call. */
            repick() {
                if (session) avoidEndpoint(session.node)
                if (session) detach(session)
            },
        },
        close,
    }
}
export type ServiceClient<D extends tServiceDefinition<any, any> = tServiceDefinition<any, any>> = ReturnType<typeof createServiceClient<D>>
