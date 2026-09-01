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
import {createSessionRegistry} from '../rcp/rpc-session-registry'
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
    /** The node reports its OWN facts here: readers resets a dead predecessor's
     *  count on the row, pid makes the process visible on panels. */
    register: (entry: {nodeId: string, url: string, weight: number, pid?: number, readers?: number}) => unknown
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
    /** Resolve the authority link; the host owns connection and link auth.
     *  Called again on every replica reconnect — return the CURRENT link, so a
     *  hard hub rotation hands the node live clients instead of disposed ones. */
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
    // set once the first registration + own-row watch are live; re-homing happens only after
    let served = false
    let rehome: ((fresh: StoreNodeUpstream) => Promise<void>) | null = null

    // ============================================================
    // start: catch up, serve, register, watch own row
    // ============================================================
    async function start() {
        if (started) return
        started = true
        try {
            await startBody()
        } catch (error) {
            // a failed start stays retryable: release whatever was created and
            // drop the latch, so a host's catch-and-retry is a REAL retry
            started = false
            if (beat) { clearInterval(beat); beat = null }
            roster?.close()
            roster = null
            denyFollower?.close()
            denyFollower = null
            replica?.close()
            replica = null
            readersOf = null
            upstream = null
            throw error
        }
    }

    /** True once leave()/close() began: start() must not resurrect the node. */
    function abandoned() {
        return leaving || torndown
    }

    async function startBody() {
        const link = await deps.upstream()
        if (abandoned()) return
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
            // re-resolved per attempt: after a hard hub rotation the captured
            // link's clients are disposed — only the host knows the CURRENT link
            connect: async function connectUpstream() {
                const fresh = await deps.upstream()
                // a DIFFERENT link = a new authority (failover) or a rotated hub: the
                // node re-homes — registers there and follows ITS roster and deny list
                if (fresh != upstream) {
                    upstream = fresh
                    if (served && rehome) await rehome(fresh)
                }
                return {
                    remote: fresh.replica,
                    onFail: {on: (cb: () => void) => fresh.onFail.on(cb)},
                    close() {},
                }
            },
        })
        await line.api.ready
        if (abandoned()) return
        log(`store node ${nodeId}: line caught up (seq ${line.api.status.state.authoritySeq})`)

        // ============== the token layer: verify locally, revoke by replicated fact ==============
        // A freshly started node may briefly lag the deny list, which is safe: the
        // authority re-verifies every forwarded command anyway (two enforcement layers).
        const auth = deps.auth
        // rule-7 bookkeeping is the SHARED primitive — the authority runs the same one
        const scaleSessions = createSessionRegistry()
        function followDenyList(from: StoreNodeUpstream) {
            denyFollower?.close()
            const denyList = auth && from.revoked ? followReplicatedMap<StoreNodeRevocation>(from.revoked) : null
            denyFollower = denyList
            denyList?.keys.on(function cutRevokedSessions(account, _value, ctx) {
                if (!ctx.exists) return
                scaleSessions.cut(account, 'account revoked at the authority')
                log(`store node ${nodeId}: revocation fact applied — ${account}`)
            })
        }
        followDenyList(link)

        // Who READS here is not "who is connected": every replica-set client keeps
        // sessions to ALL nodes for fork-choice, but only its ACTIVE route
        // subscribes to the replay line — so the line's subscriber count is the
        // honest readers fact this node publishes.
        function readers() {
            return line.api.fragment.replay.line.count()
        }
        readersOf = readers

        // ============== per-connection RPC: the same fragment shapes as the authority ==============
        // Writes forward with the END client's token — this node never asserts an
        // account, and the authority re-verifies every call itself.
        function forwardedHop() {
            return auth && upstream?.commandsByToken && commands.length
                ? forwardCommandsByToken({upstream: upstream.commandsByToken, names: commands})
                : null
        }
        deps.serve.onConnection(function onNodeConnection(socket) {
            // a stale handler from an abandoned or failed start serves nothing;
            // the host's serve hook has no un-register, so the guard lives here
            if (replica != line || torndown) return
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
                        if (denyFollower?.has(account)) {
                            throw Object.assign(new Error('account revoked at the authority'), {revoke: true})
                        }
                        if (bound != account) {
                            if (bound) scaleSessions.untrack(bound, gated!.control)
                            bound = account
                            scaleSessions.track(account, gated!.control)
                        }
                        // bound per HELLO through the slot: after a re-home the hop reaches the CURRENT authority
                        const forwarded = forwardedHop()
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
                if (bound && gated) scaleSessions.untrack(bound, gated.control)
            })
        })

        const url = deps.selfUrl()
        // the node's OWN facts ride the registration: a fresh process resets a
        // dead predecessor's readers count instead of inheriting its load
        function register(at: StoreNodeUpstream) {
            return at.register({
                nodeId, url, weight, readers: readers(),
                ...(typeof globalThis.process?.pid == 'number' ? {pid: globalThis.process.pid} : {}),
            })
        }
        await register(link)
        if (abandoned()) {
            // leave()/close() won while we registered: the row must not outlive us
            try { await link.goodbye(nodeId) } catch {}
            return
        }
        log(`store node ${nodeId}: serving at ${url}`)

        beat = setInterval(function nodeHeartbeat() {
            // through the SLOT: connectUpstream may have re-resolved the link
            // .then, not Promise.resolve(call): an in-process link throws synchronously when its owner is gone
            void Promise.resolve().then(function beat() { return upstream?.heartbeat(nodeId, {readers: readers()}) }).catch(function heartbeatLost() {})
        }, heartbeatMs)
        ;(beat as any).unref?.()

        // ============== leave on my own directory fact ==============
        async function watchOwnRow(from: StoreNodeUpstream) {
            roster?.close()
            const directory = followNodeDirectory(from.directory, {staleMs: 0})
            roster = directory
            await directory.ready
            if (abandoned()) return
            // per-KEY watch with `current`: the ready snapshot seeds seenSelf
            // (registration happened BEFORE this follow, so a removal landing as
            // the very first change still reads as "was present, now gone"), and
            // peers' heartbeats cost no roster re-derivation on this node
            let seenSelf = false
            directory.follow.onKey(nodeId, function ownRowChanged(entry, ctx) {
                if (ctx.exists) {
                    seenSelf = true
                    if (entry?.draining) leave('drained by the authority')
                } else if (seenSelf) {
                    leave('removed from the directory')
                }
            }, {current: true})
        }
        await watchOwnRow(link)
        served = true

        /** A new authority link: announce ourselves there and watch ITS roster and deny list. */
        rehome = async function rehomeOnto(fresh: StoreNodeUpstream) {
            if (abandoned()) return
            log(`store node ${nodeId}: re-homing onto a new authority link`)
            try { await register(fresh) } catch (error) {
                log(`store node ${nodeId}: re-registration failed — ${String((error as any)?.message ?? error)}`)
            }
            followDenyList(fresh)
            await watchOwnRow(fresh)
        }
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
