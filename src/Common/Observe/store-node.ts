// =====================================================================
// Store node — a serving node built from one config object
// =====================================================================
// The factory owns what makes a node a node: the replica line with its
// to-upstream offer, local token verification with the replicated deny list,
// per-connection RPC serving (an ungated read surface and an optionally gated
// write surface), self-registration + heartbeat in the roster, and the
// watch-own-row leave rule. Drain is DATA: the node leaves on the same roster
// fact every client sees — no control channel exists.
//
// The node follows the authority's ONE control line: its own roster row and
// the deny list arrive together, in one subscription. When the host resolves
// a DIFFERENT upstream link (failover, hub rotation) the node re-homes: it
// registers there and follows THAT control line.
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
import {bindCommandNames} from '../command/command-fragment'
import type {CommandFragment, tCommandMap} from '../command/command-host'
import {createStoreReplicaSet, type StoreLineCoordinates, type StoreReplicaRemote, type StoreReplicaSession} from './store-replica-set'
import {createStoreFollower, type StoreFollower} from './store-follower'
import type {StoreReplayRemote} from './store-replay'
import type {Store} from './store'
import type {NodeDirectoryEntry, NodeDirectoryState} from './node-directory'

// ============================================================
// public contract
// ============================================================

/** One replicated deny-list fact: this account's tokens are dead everywhere. */
export type StoreNodeRevocation = {account: string, ts: number}

/** A verified principal; expiresAt bounds the RPC grant (one clock, one exit). */
export type StoreNodePrincipal = {account: string, expiresAt?: number}

/** The sections of the authority's control line a node reads. */
export type StoreNodeControlState = NodeDirectoryState & {revoked: Record<string, StoreNodeRevocation>}

/** The already-resolved authority link; the host owns the transport under it. */
export type StoreNodeUpstream<T extends object = any, Cmds extends tCommandMap = tCommandMap> = {
    /** The authority's replica-line fragment (replica-set session remote). */
    replica: StoreReplicaSession<T>['remote']
    /** The authority's control line: roster + deny list (+ receipts, which a node ignores). */
    control: StoreReplayRemote<StoreNodeControlState>
    /** The authority's verifyCommands fragment (token-envelope entries). */
    commandsByToken?: CommandTokenFragment<Cmds>
    /** The node reports its OWN facts here: readers resets a dead predecessor's
     *  count on the row, pid makes the process visible on panels. */
    register: (entry: {nodeId: string, url: string, weight: number, pid?: number, readers?: number}) => unknown
    heartbeat: (nodeId: string, facts?: {readers?: number}) => unknown
    goodbye: (nodeId: string) => unknown
    /** Additive link-failure subscription (usually the hub's disconnectListen). */
    onFail: {on: (cb: () => void) => () => void}
}

/** What the ungated read key serves by default: the replica line and this node's id. */
export type StoreNodeReaderDefaults<T extends object = any> = {
    replica: StoreReplicaRemote<T>
    node: () => string
    /** This node's local mirror of the line — the source of any projection. */
    store: Store<T>
}

/** What the gated write key serves a verified principal by default. */
export type StoreNodePrincipalDefaults<T extends object = any, Cmds extends tCommandMap = tCommandMap> = {
    whoami: () => string
    /** The token-envelope hop to the authority; absent on a read-only node. */
    commands?: CommandFragment<Cmds>
    store: Store<T>
}

/** One gated connection as the shaping hook sees it: stable per socket, gone once. */
export type StoreNodeSession = {
    nodeId: string
    /** Fires ONCE when the connection is gone — release per-session lines here. */
    onGone: (cb: () => void) => () => void
}

export type StoreNodeAudience<T extends Record<string, any>, Cmds extends tCommandMap = tCommandMap> = {
    /** The ungated read fragment; `null` serves nothing on the read key. Called per connection. */
    reader?: (defaults: StoreNodeReaderDefaults<T>) => Record<string, unknown> | null
    /** The gated fragment for one verified principal; called on every successful HELLO. */
    principal?: (principal: StoreNodePrincipal, defaults: StoreNodePrincipalDefaults<T, Cmds>, session: StoreNodeSession) => Record<string, unknown>
}

export type StoreNodeDeps<T extends Record<string, any>, Cmds extends tCommandMap = tCommandMap> = {
    /** Replica-line coordinates (must match the authority's line) and the state before the first keyframe. */
    line: StoreLineCoordinates & {initial?: T}
    /** This node's roster row: client-reachable origin (read lazily — the port binds late), share, cadence. */
    roster: {
        url: () => string
        /** Placement share; default 4. */
        weight?: number
        heartbeatMs?: number
        /** Grace between seeing the leave fact and saying goodbye; clients move first. */
        graceMs?: number
    }
    /** Resolve the authority link; the host owns connection and link auth.
     *  Called again on every replica reconnect — return the CURRENT link, so a
     *  hard hub rotation or a failover hands the node the live authority. */
    upstream: () => Promise<StoreNodeUpstream<NoInfer<T>, Cmds>> | StoreNodeUpstream<NoInfer<T>, Cmds>
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
    commands?: readonly (keyof NoInfer<Cmds> & string)[]
    /** How this node serves: the host's socket-server hook plus the RPC shape around the fragments. */
    serve: {
        onConnection(handler: (socket: SocketTmpl) => void): void
        /** Application RPC shape around the served fragments (e.g. f => ({miniScale: f})). */
        wrap?: (fragment: Record<string, unknown>) => object
        keys?: {read?: string, write?: string}
        opt?: RpcOpt
        /**
         * Audience shaping — what each connection is SERVED, decided by the host from
         * this node's local mirror (`store`). Defaults keep today's shapes: the whole
         * replica line ungated, `{whoami, commands}` per principal. A host with read
         * policy replaces the ungated line by public projections (`null` serves nothing
         * on the read key) and shapes the gated facade per role/account (RPC-AUTH
         * rule 3: prune with `null`, never check inside). The authority re-verifies
         * every forwarded command regardless — shaping here is visibility, not trust.
         */
        audience?: StoreNodeAudience<T, Cmds>
    }
    /** The host owns the actual shutdown/process.exit; called ONCE, after the grace. */
    onLeave: (reason: string) => void
    log?: (line: string) => void
}

export function createStoreNode<T extends Record<string, any>, Cmds extends tCommandMap = tCommandMap>(deps: StoreNodeDeps<T, Cmds>) {
    const {nodeId} = deps.line
    const log = deps.log ?? console.log
    const weight = deps.roster.weight ?? 4
    const heartbeatMs = deps.roster.heartbeatMs ?? 2000
    const graceMs = deps.roster.graceMs ?? 2000
    const commands = deps.commands ?? []
    const wrap = deps.serve.wrap ?? function serveUnwrapped(fragment: Record<string, unknown>) { return fragment }
    const readKey = deps.serve.keys?.read ?? 'app'
    const writeKey = deps.serve.keys?.write ?? 'scale'
    const rpcOpt = deps.serve.opt ? {opt: deps.serve.opt} : {}

    // Lifecycle slots: created in start(), released by leave()/close().
    let started = false
    let leaving = false
    let torndown = false
    let readersOf: (() => number) | null = null
    let upstream: StoreNodeUpstream<T, Cmds> | null = null
    let replica: ReturnType<typeof createStoreReplicaSet<T>> | null = null
    let control: StoreFollower<StoreNodeControlState> | null = null
    let offControl: (() => void)[] = []
    let beat: ReturnType<typeof setInterval> | null = null
    let grace: ReturnType<typeof setTimeout> | null = null
    // set once the first registration + own-row watch are live; re-homing happens only after
    let served = false
    let rehomes = 0
    let rehome: ((fresh: StoreNodeUpstream<T, Cmds>) => Promise<void>) | null = null

    function releaseControl() {
        for (const off of offControl) off()
        offControl = []
        control?.close()
        control = null
    }

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
            releaseControl()
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
        // the first route attempt reuses THIS link: a host whose resolver rotates the hub on every
        // call (demo/scaffold: setToken) would otherwise dispose it before we ever registered
        let firstLink: StoreNodeUpstream<T, Cmds> | null = link

        const {initial, ...coordinates} = deps.line
        const line = createStoreReplicaSet<T>({
            ...coordinates,
            lineId: coordinates.lineId ?? nodeId + '-line',
            initial: initial ?? {} as T,
            leadership: {initialRole: 'follower', eligible: false},
        })
        replica = line
        line.control.addOffer({
            id: 'to-upstream',
            // re-resolved per attempt: after a hard hub rotation the captured
            // link's clients are disposed — only the host knows the CURRENT link
            connect: async function connectUpstream() {
                const fresh = firstLink ?? await deps.upstream()
                firstLink = null
                // a DIFFERENT link = a new authority (failover) or a rotated hub: the
                // node re-homes — registers there and follows ITS control line
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
        function isRevoked(account: string) {
            return control?.store.state.revoked?.[account] != undefined
        }

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
        // Bound to the CURRENT link at call time, not at session time: a session opened
        // before a re-home (leader restart, hub rotation) must not keep forwarding through
        // the link that died with it — observe/store-node-rehome-forward.test.ts.
        const liveByToken = bindCommandNames<CommandTokenFragment<Cmds>>(commands, function bindLiveForward(name) {
            return function forwardThroughCurrentLink(token: unknown, requestId: string, input: any) {
                const link = upstream?.commandsByToken
                if (!link) return Promise.reject(new Error('store node: no upstream link for commands'))
                return link[name as keyof Cmds & string](token, requestId, input)
            }
        })
        function forwardedHop() {
            return auth && upstream?.commandsByToken && commands.length
                ? forwardCommandsByToken<Cmds>({upstream: liveByToken, names: commands})
                : null
        }
        const audience = deps.serve.audience ?? {}
        deps.serve.onConnection(function onNodeConnection(socket) {
            // a stale handler from an abandoned or failed start serves nothing;
            // the host's serve hook has no un-register, so the guard lives here
            if (replica != line || torndown) return
            const [gone, goneListen] = listen<[]>()
            // ungated read surface: the replica line by default — or what the host's
            // read policy projects from the local mirror (nothing at all with `null`)
            const readerDefaults: StoreNodeReaderDefaults<T> = {
                replica: line.api.fragment,
                node: () => nodeId,
                store: line.control.store,
            }
            const readerFragment = audience.reader ? audience.reader(readerDefaults) : {replica: readerDefaults.replica, node: readerDefaults.node}
            if (readerFragment) {
                createRpcServerAuto({
                    socket,
                    socketKey: readKey,
                    object: wrap(readerFragment),
                    disconnectListen: goneListen,
                    ...rpcOpt,
                })
            }
            // one session object per connection: the shaping hook keys per-session lines on it
            const session: StoreNodeSession = {nodeId, onGone: (cb: () => void) => goneListen.on(cb)}
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
                        if (isRevoked(account)) {
                            throw Object.assign(new Error('account revoked at the authority'), {revoke: true})
                        }
                        if (bound != account) {
                            if (bound) scaleSessions.untrack(bound, gated!.control)
                            bound = account
                            scaleSessions.track(account, gated!.control)
                        }
                        // bound per HELLO through the slot: after a re-home the hop reaches the CURRENT authority
                        const forwarded = forwardedHop()
                        const principalDefaults: StoreNodePrincipalDefaults<T, Cmds> = {
                            whoami: () => account + ' @ ' + nodeId,
                            ...(forwarded ? {commands: forwarded.fragment(presented)} : {}),
                            store: line.control.store,
                        }
                        const {store: _store, ...served} = principalDefaults
                        return {
                            object: wrap(audience.principal ? audience.principal(principal, principalDefaults, session) : served),
                            ack: {ok: true, who: account, node: nodeId},
                            ...(principal.expiresAt != undefined ? {expiresAt: principal.expiresAt} : {}),
                            renewBeforeMs: auth.renewBeforeMs ?? 15_000,
                        }
                    },
                },
                disconnectListen: goneListen,
                ...rpcOpt,
            }) : null
            socket.on('disconnect', function nodeClientGone() {
                gone()
                if (bound && gated) scaleSessions.untrack(bound, gated.control)
            })
        })

        const url = deps.roster.url()
        // the node's OWN facts ride the registration: a fresh process resets a
        // dead predecessor's readers count instead of inheriting its load
        function register(at: StoreNodeUpstream<T, Cmds>) {
            return at.register({
                nodeId, url, weight, readers: readers(),
                ...(typeof globalThis.process?.pid == 'number' ? {pid: globalThis.process.pid} : {}),
            })
        }
        // through the SLOT: the route may have re-resolved the link while the line caught up
        await register(upstream ?? link)
        if (abandoned()) {
            // leave()/close() won while we registered: the row must not outlive us
            try { await (upstream ?? link).goodbye(nodeId) } catch {}
            return
        }
        log(`store node ${nodeId}: serving at ${url}`)

        beat = setInterval(function nodeHeartbeat() {
            // through the SLOT: connectUpstream may have re-resolved the link
            // .then, not Promise.resolve(call): an in-process link throws synchronously when its owner is gone
            void Promise.resolve().then(function beatNow() { return upstream?.heartbeat(nodeId, {readers: readers()}) }).catch(function heartbeatLost() {})
        }, heartbeatMs)
        ;(beat as any).unref?.()

        // ============== the control line: own row (leave rule) + deny list (session cuts) ==============
        async function followControl(from: StoreNodeUpstream<T, Cmds>) {
            releaseControl()
            const follower = createStoreFollower<StoreNodeControlState>({remote: from.control, initial: {nodes: {}, revoked: {}}})
            control = follower
            await follower.ready
            if (abandoned() || control != follower) return
            log(`store node ${nodeId}: following the control line (seq ${follower.status.state.seq})`)
            // every account that APPEARS in the deny list loses its live sessions here —
            // including the ones a fresh keyframe brings after a re-home
            let known = new Set(Object.keys(follower.store.snapshot().revoked ?? {}))
            for (const account of known) scaleSessions.cut(account, 'account revoked at the authority')
            offControl.push(follower.store.node.at('revoked').on(function cutRevokedSessions(section) {
                const next = new Set(Object.keys((section as Record<string, unknown>) ?? {}))
                for (const account of next) {
                    if (known.has(account)) continue
                    scaleSessions.cut(account, 'account revoked at the authority')
                    log(`store node ${nodeId}: revocation fact applied — ${account}`)
                }
                known = next
            }))
            // per-ROW watch with `current`: the ready snapshot seeds seenSelf
            // (registration happened BEFORE this follow, so a removal landing as
            // the very first change still reads as "was present, now gone")
            let seenSelf = false
            offControl.push(follower.store.node.at('nodes').at(nodeId).on(function ownRowChanged(value) {
                const entry = value as NodeDirectoryEntry | undefined
                if (entry) {
                    seenSelf = true
                    if (entry.draining) leave('drained by the authority')
                } else if (seenSelf) {
                    leave('removed from the roster')
                }
            }, {current: true}))
        }
        await followControl(upstream ?? link)
        served = true

        /** A new authority link: announce ourselves there and follow ITS control line. */
        rehome = async function rehomeOnto(fresh: StoreNodeUpstream<T, Cmds>) {
            if (abandoned()) return
            log(`store node ${nodeId}: re-homing onto a new authority link`)
            try { await register(fresh) } catch (error) {
                log(`store node ${nodeId}: re-registration failed — ${String((error as any)?.message ?? error)}`)
            }
            await followControl(fresh)
            rehomes++
        }
    }

    // ============================================================
    // leave: withdraw, grace for clients, then the host takes over
    // ============================================================
    function teardown() {
        if (torndown) return
        torndown = true
        if (beat) clearInterval(beat)
        releaseControl()
        replica?.close()
    }

    function leave(reason: string) {
        if (leaving || torndown) return
        leaving = true
        log(`store node ${nodeId}: leaving — ${reason}`)
        if (beat) clearInterval(beat)
        // Withdraw before the grace so local host shutdown also gives readers time to move.
        // The control plane cannot hold the process alive beyond its shutdown budget.
        void Promise.resolve().then(function withdraw() {
            return upstream?.goodbye(nodeId)
        }).catch(function withdrawalFailed() {})
        grace = setTimeout(function finishLeave() {
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
        /** Graceful exit path — signals and roster facts both land here. */
        leave,
        view: {
            nodeId,
            /** rehomes counts completed moves onto a DIFFERENT upstream link (failover, hub rotation). */
            status: () => ({started, leaving, rehomes, readers: readersOf?.() ?? 0, seq: replica?.api.status.state.authoritySeq}),
        },
        close,
    }
}
// `StoreNode`/`StoreNodeApi` are the store TREE node types (store.ts), so the
// factory instance derives under its own unambiguous name.
export type StoreNodeInstance<T extends Record<string, any> = Record<string, any>, Cmds extends tCommandMap = tCommandMap> = ReturnType<typeof createStoreNode<T, Cmds>>
