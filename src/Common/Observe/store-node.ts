// =====================================================================
// Store node — a serving node built from one config object
// =====================================================================
// The factory owns what makes a node a node: the replica line with its
// to-upstream offer, local token verification with a replicated deny list,
// per-connection RPC serving (an ungated read surface and an optionally gated
// write surface), self-registration + heartbeat in the node directory, and the
// watch-own-row leave rule. Drain is DATA: the node leaves on the same
// directory fact every client sees — no control channel exists.
//
// The HOST keeps what only a process can own (doc/DYNAMIC-RUNTIME.md
// boundary): env, transports (the socket server and the upstream connection),
// token cryptography (pass a verifier — this file owns no crypto and no token
// format), and process exit. They all arrive as adapters through deps.
//
// Trust layers served here (the same boundaries as the authority):
//   transport auth — this node verifies client tokens LOCALLY via deps.auth;
//                    the gated write key serves a per-principal facade
//   command hop   — writes forward with the END client's token (end-to-end
//                   mode); this node asserts nothing, the authority re-verifies
//   revocation    — the node follows the authority's replicated deny list and
//                   cuts its OWN sessions on the fact — no restart needed

import {listen} from '../events/Listen'
import {createRpcServerAuto} from '../rcp/rpc-server-auto'
import type {RpcServerControl} from '../rcp/rpc-server'
import type {RpcOpt} from '../rcp/rpc-caps'
import type {SocketTmpl} from '../rcp/rpc-protocol'
import {forwardCommandsByToken, type CommandTokenFragment} from '../command/command-token'
import type {tCommandMap} from '../command/command-host'
import {createStoreReplicaSet, type StoreReplicaSession} from './store-replica-set'
import {followReplicatedMap, type ReplicatedMapRemote} from './replicated-map'
import {followNodeDirectory, type NodeDirectoryEntry} from './node-directory'

// ============================================================
// public contract
// ============================================================

/** One replicated deny-list fact: this account's tokens are dead everywhere. */
export type StoreNodeRevocation = {account: string, ts: number}

/** A verified principal; expiresAt bounds the RPC grant (one clock, one exit). */
export type StoreNodePrincipal = {account: string, expiresAt?: number}

/** The already-resolved authority link; the host owns the transport under it. */
export type StoreNodeUpstream = {
    /** The authority's replica-line fragment (replica-set session remote). */
    replica: StoreReplicaSession['remote']
    /** The authority's node-directory line. */
    directory: ReplicatedMapRemote<NodeDirectoryEntry>
    /** Replicated deny list; required only when a gated write surface is served. */
    revoked?: ReplicatedMapRemote<StoreNodeRevocation>
    /** The authority's verifyCommands fragment (token-envelope entries). */
    commandsByToken?: CommandTokenFragment<tCommandMap>
    register: (entry: {nodeId: string, url: string, weight: number}) => unknown
    heartbeat: (nodeId: string, facts?: {readers?: number}) => unknown
    goodbye: (nodeId: string) => unknown
    /** Additive link-failure subscription (usually the hub's disconnectListen). */
    onFail: {on: (cb: () => void) => () => void}
}

export type StoreNodeDeps<T extends Record<string, any>> = {
    nodeId: string
    /** Replica-line coordinates; they must match the authority's line. */
    storeId: string
    originId: string
    lineId?: string
    initial?: T
    /** Directory placement share; default 4. */
    weight?: number
    heartbeatMs?: number
    /** Grace between seeing the leave fact and saying goodbye; clients move first. */
    graceMs?: number
    /**
     * Gated write surface: verify a presented token or throw to reject —
     * a throw carrying `revoke: true` kills the live session (RPC-AUTH rule 6).
     * Omit auth to serve a read-only node. Cryptography stays with the host.
     */
    auth?: {
        verify: (token: unknown) => StoreNodePrincipal
        renewBeforeMs?: number
    }
    /** Forwarded command names; an RPC proxy cannot be enumerated, so they are explicit. */
    commands?: readonly string[]
    /** Resolve the authority link; the host owns connection and link auth. */
    upstream: () => Promise<StoreNodeUpstream> | StoreNodeUpstream
    /** The host's socket-server hook; the factory serves every accepted connection. */
    serve: {onConnection(handler: (socket: SocketTmpl) => void): void}
    /** Client-reachable origin of THIS node; read lazily (the port binds late). */
    selfUrl: () => string
    /** The host owns the actual shutdown/process.exit; called ONCE, after the grace. */
    onLeave: (reason: string) => void
    /** Application RPC shape around the served fragments (e.g. f => ({miniScale: f})). */
    wrap?: (fragment: Record<string, unknown>) => object
    socketKeys?: {read?: string, write?: string}
    opt?: RpcOpt
    log?: (line: string) => void
}

export function createStoreNode<T extends Record<string, any>>(deps: StoreNodeDeps<T>) {
    const {nodeId} = deps
    const log = deps.log ?? console.log
    const weight = deps.weight ?? 4
    const heartbeatMs = deps.heartbeatMs ?? 2000
    const graceMs = deps.graceMs ?? 2000
    const commands = deps.commands ?? []
    const wrap = deps.wrap ?? function serveUnwrapped(fragment: Record<string, unknown>) { return fragment }
    const readKey = deps.socketKeys?.read ?? 'app'
    const writeKey = deps.socketKeys?.write ?? 'scale'

    // Lifecycle slots: created in start(), released by leave()/close().
    let started = false
    let leaving = false
    let torndown = false
    let readersOf: (() => number) | null = null
    let upstream: StoreNodeUpstream | null = null
    let replica: ReturnType<typeof createStoreReplicaSet<T>> | null = null
    let denyFollower: ReturnType<typeof followReplicatedMap<StoreNodeRevocation>> | null = null
    let roster: ReturnType<typeof followNodeDirectory> | null = null
    let beat: ReturnType<typeof setInterval> | null = null
    let grace: ReturnType<typeof setTimeout> | null = null

    // ============================================================
    // start: catch up, serve, register, watch own row
    // ============================================================
    async function start() {
        if (started) return
        started = true
        const link = await deps.upstream()
        upstream = link

        const line = createStoreReplicaSet<T>({
            storeId: deps.storeId, originId: deps.originId, nodeId,
            lineId: deps.lineId ?? nodeId + '-line',
            initial: deps.initial ?? {} as T,
            leadership: {initialRole: 'follower', eligible: false},
        })
        replica = line
        line.control.addOffer({
            id: 'to-upstream',
            connect: () => ({
                remote: link.replica,
                onFail: {on: (cb: () => void) => link.onFail.on(cb)},
                close() {},
            }),
        })
        await line.api.ready
        log(`store node ${nodeId}: line caught up (seq ${line.api.status.state.authoritySeq})`)

        // ============== the token layer: verify locally, revoke by replicated fact ==============
        // A freshly started node may briefly lag the deny list, which is safe: the
        // authority re-verifies every forwarded command anyway (two enforcement layers).
        const auth = deps.auth
        const denyList = auth && link.revoked ? followReplicatedMap<StoreNodeRevocation>(link.revoked) : null
        denyFollower = denyList
        const scaleSessions = new Map<string, Set<RpcServerControl>>()
        denyList?.keys.on(function cutRevokedSessions(account, _value, ctx) {
            if (!ctx.exists) return
            for (const control of [...(scaleSessions.get(account) ?? [])]) {
                control.revoke('account revoked at the authority')
            }
            log(`store node ${nodeId}: revocation fact applied — ${account}`)
        })

        // Who READS here is not "who is connected": every replica-set client keeps
        // sessions to ALL nodes for fork-choice, but only its ACTIVE route
        // subscribes to the replay line — so the line's subscriber count is the
        // honest readers fact this node publishes.
        function readers() {
            return Number((line.api.fragment.replay as any)?.line?.count?.() ?? 0)
        }
        readersOf = readers

        // ============== per-connection RPC: the same fragment shapes as the authority ==============
        // Writes forward with the END client's token — this node never asserts an
        // account, and the authority re-verifies every call itself.
        const forwarded = auth && link.commandsByToken && commands.length
            ? forwardCommandsByToken({upstream: link.commandsByToken, names: commands})
            : null
        deps.serve.onConnection(function onNodeConnection(socket) {
            const [gone, goneListen] = listen<[]>()
            // ungated read surface: the replica line is public, like on the authority
            createRpcServerAuto({
                socket,
                socketKey: readKey,
                object: wrap({
                    replica: line.api.fragment,
                    node: () => nodeId,
                }),
                disconnectListen: goneListen,
                ...(deps.opt ? {opt: deps.opt} : {}),
            })
            // gated write surface: THIS node verifies the token, locally
            let bound: string | null = null
            const gated = auth ? createRpcServerAuto({
                socket,
                socketKey: writeKey,
                object: {},   // anonymous surface: nothing before a verified HELLO
                auth: {
                    gate: true,
                    resolveAuth(presented: unknown) {
                        const principal = auth.verify(presented)
                        const account = principal.account
                        if (denyList?.has(account)) {
                            throw Object.assign(new Error('account revoked at the authority'), {revoke: true})
                        }
                        if (bound != account) {
                            if (bound) scaleSessions.get(bound)?.delete(gated!.control)
                            bound = account
                            let sessions = scaleSessions.get(account)
                            if (!sessions) scaleSessions.set(account, sessions = new Set())
                            sessions.add(gated!.control)
                        }
                        return {
                            object: wrap({
                                whoami: () => account + ' @ ' + nodeId,
                                ...(forwarded ? {commands: forwarded.fragment(presented)} : {}),
                            }),
                            ack: {ok: true, who: account, node: nodeId},
                            ...(principal.expiresAt != undefined ? {expiresAt: principal.expiresAt} : {}),
                            renewBeforeMs: auth.renewBeforeMs ?? 15_000,
                        }
                    },
                },
                disconnectListen: goneListen,
                ...(deps.opt ? {opt: deps.opt} : {}),
            }) : null
            socket.on('disconnect', function nodeClientGone() {
                gone()
                if (bound && gated) scaleSessions.get(bound)?.delete(gated.control)
            })
        })

        const url = deps.selfUrl()
        await link.register({nodeId, url, weight})
        log(`store node ${nodeId}: serving at ${url}`)

        beat = setInterval(function nodeHeartbeat() {
            void Promise.resolve(link.heartbeat(nodeId, {readers: readers()})).catch(function heartbeatLost() {})
        }, heartbeatMs)

        // ============== leave on my own directory fact ==============
        const directory = followNodeDirectory(link.directory, {staleMs: 0})
        roster = directory
        await directory.ready
        let seenSelf = false
        directory.onNodes(function watchOwnRow(views) {
            const mine = views.find(view => view.nodeId == nodeId)
            if (mine) seenSelf = true
            if (mine?.draining) leave('drained by the authority')
            else if (!mine && seenSelf) leave('removed from the directory')
        })
    }

    // ============================================================
    // leave: grace for clients, goodbye, then the host takes over
    // ============================================================
    function teardown() {
        if (torndown) return
        torndown = true
        if (beat) clearInterval(beat)
        roster?.close()
        denyFollower?.close()
        replica?.close()
    }

    function leave(reason: string) {
        if (leaving || torndown) return
        leaving = true
        log(`store node ${nodeId}: leaving — ${reason}`)
        if (beat) clearInterval(beat)
        // grace: connected clients see the leave fact and move BEFORE this node goes silent
        grace = setTimeout(async function sayGoodbye() {
            try { await upstream?.goodbye(nodeId) } catch {}
            teardown()
            deps.onLeave(reason)
        }, graceMs)
    }

    /** Immediate non-exiting teardown: no grace, no goodbye, no onLeave. */
    function close() {
        if (grace != null) clearTimeout(grace)
        teardown()
    }

    return {
        start,
        /** Graceful exit path — signals and directory facts both land here. */
        leave,
        view: {
            nodeId,
            status: () => ({started, leaving, readers: readersOf?.() ?? 0, seq: replica?.api.status.state.authoritySeq}),
        },
        close,
    }
}
// `StoreNode`/`StoreNodeApi` are the store TREE node types (store.ts), so the
// factory instance derives under its own unambiguous name.
export type StoreNodeInstance = ReturnType<typeof createStoreNode>
