// =====================================================================
// Scale authority — the cluster's single point of order from one config object
// =====================================================================
// The authority side of the deployment triangle (authority / store node /
// cluster client): one replica line, ONE control line (roster + deny list +
// receipts as sections of one store), the command corridor with receipts and
// end-to-end token verification, and the identity lifecycle over the deny
// list. Every host used to hand-wire these ~300 lines; this factory collapses
// them into deliberate facades by audience and rewrites none of the layers —
// it only composes the shipped primitives.
//
// Succession: the same factory runs as the LEADER or as a STANDBY. A standby
// follows the leader's replica line and its control line and takes them over
// when the ONE leadership decision — the replica set's fork choice /
// autoPromote / injected lease — makes it the leader: the control store
// continues as the owned line (the follower's own promote), the command host
// adopts the receipts section, the roster row flips from 'standby' to
// 'leader'. A leader that loses fork choice demotes: writes are refused, and
// with an upstream it follows the winner. Hosts learn every transition through
// events.role and rewire sockets.
//
// Liveness is published here: the roster owner keeps the beats and flips
// `alive`; readers judge nothing by their own clocks.
//
// The HOST keeps what only a process can own (doc/DYNAMIC-RUNTIME.md
// boundary): env, transports (socket servers, who gets which fragment, the
// link to the CURRENT leader), token CRYPTOGRAPHY (identity.issue/verify are
// adapters — this file owns no crypto and no token format), process
// supervision and exit.
//
// Trust layers owned here (RPC-AUTH.md is the canonical auth page):
//   identity   — mint through the host adapter; login lifts the ban, renew
//                refuses a revoked account, revocation is a REPLICATED fact
//   connection — serve.connection() is the gated per-socket block: empty
//                anonymous surface + gate (rule 1), a facade per principal
//                (rule 3), revoked throws {revoke: true} (rule 6), live
//                sessions are cut through the control registry (rule 7)
//   corridor   — the authority re-verifies EVERY token-carried command; a
//                relay asserts nothing (end-to-end mode of command-token.ts)

import type {RpcServerControl} from '../rcp/rpc-server'
import {createSessionRegistry} from '../rcp/rpc-session-registry'
import {listen} from '../events/Listen'
import {createCommandHost, type CommandFragment, type CommandHostDeps, type tCommandMap} from '../command/command-host'
import {bindCommandNames} from '../command/command-fragment'
import {createCommandReceipts} from '../command/command-receipts'
import {verifyCommands} from '../command/command-token'
import {createNodeDirectory, nodeDirectoryViews, type NodeDirectory, type NodeDirectoryRow} from '../Observe/node-directory'
import type {StoreReplayRemote} from '../Observe/store-replay'
import {createStoreReplicaSet, type StoreLineCoordinates, type StoreReplicaLeadership, type StoreReplicaSession} from '../Observe/store-replica-set'
import type {StoreNodePrincipal} from '../Observe/store-node'
import {createControlLine, emptyControlState, projectStoreSection, type ScaleControlState} from './scale-control'

// ============================================================
// public contract
// ============================================================

/** Token mint/verify adapters; cryptography stays with the host. */
export type ScaleIdentityAdapter = {
    /** Mint a token for an account; the string IS the credential. */
    issue: (account: string) => string
    /** Verified principal or THROW; expiresAt bounds the RPC grant. */
    verify: (presented: unknown) => StoreNodePrincipal
    /** 'expiring' lead time of the RPC grants served here; default 15s. */
    renewBeforeMs?: number
}

export type tScaleAuthorityRole = 'leader' | 'standby'

/** The CURRENT leader's node link as a standby sees it — serve.nodeLink(standbyId) on the leader. */
export type AuthorityUpstream = {
    replica: StoreReplicaSession['remote']
    /** The leader's control line: roster + deny list + receipts. */
    control: StoreReplayRemote
    register: (entry: {nodeId: string, url: string, weight: number, role?: 'mirror' | 'standby', pid?: number}) => unknown
    heartbeat: (nodeId: string, facts?: Record<string, unknown>) => unknown
    goodbye: (nodeId: string) => unknown
    /** Link-failure subscription (usually the hub's disconnectListen). */
    onFail: {on: (cb: () => void) => () => void}
}

export type ScaleAuthorityLeadership = {
    /** 'leader' (default) owns the lines from birth; 'standby' follows upstream until promoted. */
    role?: tScaleAuthorityRole
    /** Replica epoch this process starts with; default 1 for a leader, 0 for a standby. */
    epoch?: number
    /** Resolve the CURRENT leader's link; required for a standby, optional for a leader that
     *  may lose fork choice and rejoin as standby. Re-resolved on every reconnect. */
    upstream?: () => Promise<AuthorityUpstream> | AuthorityUpstream
    /** Standby takes over this long after losing the leader; omit = manual control.promote(). */
    autoPromoteMs?: number
    /** Lease/quorum seam of the replica set; a standby is only asked after its first follow. */
    elect?: StoreReplicaLeadership['elect']
    accept?: StoreReplicaLeadership['accept']
}

export type ScaleAuthorityDeps<T extends Record<string, any>, Cmds extends tCommandMap = {}> = {
    /** Replica-line coordinates (nodes and clients must match them) and the initial state. nodeId default 'authority'. */
    line: Omit<StoreLineCoordinates, 'nodeId'> & {nodeId?: string, initial: T}
    /** The authority's OWN roster row and the roster's liveness policy. */
    roster: {
        /** Client-reachable origin of THIS authority; read lazily (the port binds late). */
        url: () => string
        /** Placement share of the authority row; default 1 — readers should prefer nodes. */
        weight?: number
        heartbeatMs?: number
        /** Silence after which a node is published dead; default 15 s, 0 disables. */
        staleMs?: number
        /** Node-link register guard; default accepts any non-empty nodeId. */
        acceptNode?: (nodeId: string) => boolean
        /** Extra authority-row facts, merged into the row beside {readers}. */
        meta?: () => Record<string, unknown>
    }
    identity: ScaleIdentityAdapter
    /** The write half: commands behind (account, requestId) receipts. */
    corridor?: {
        commands?: Cmds
        limits?: CommandHostDeps<Cmds>['limits']
        /** Receipt bounds; the line itself is a section of the control store and follows leadership. */
        receipts?: Omit<NonNullable<CommandHostDeps<Cmds>['receipts']>, 'line'>
    }
    leadership?: ScaleAuthorityLeadership
    log?: (line: string) => void
}

/** Wire-reported counts: only a finite positive integer survives — NaN, negatives
 *  AND Infinity (JSON.parse('1e400') is a legal wire value) collapse to 0. */
function finiteCount(value: unknown) {
    const n = Math.floor(Number(value))
    return Number.isFinite(n) && n > 0 ? n : 0
}

export function createAuthority<T extends Record<string, any>, Cmds extends tCommandMap = {}>(
    deps: ScaleAuthorityDeps<T, Cmds>,
) {
    const log = deps.log ?? console.log
    const nodeId = deps.line.nodeId ?? 'authority'
    const weight = deps.roster.weight ?? 1
    const heartbeatMs = deps.roster.heartbeatMs ?? 3000
    const staleMs = deps.roster.staleMs
    const renewBeforeMs = deps.identity.renewBeforeMs ?? 15_000
    const acceptNode = deps.roster.acceptNode ?? function acceptAnyNode() { return true }
    const identity = deps.identity
    const leadership = deps.leadership ?? {}
    const bornLeader = (leadership.role ?? 'leader') == 'leader'

    // ============== ONE leadership decision: the replica set's ==============
    // A standby must never promote before it has followed once: two processes
    // booting side by side would otherwise both wake up as epoch-1 leaders.
    let followedOnce = bornLeader
    let forcePromote = false
    const replica = createStoreReplicaSet<T>({
        storeId: deps.line.storeId, originId: deps.line.originId, nodeId,
        lineId: deps.line.lineId ?? nodeId + '-line',
        initial: deps.line.initial,
        leadership: {
            initialRole: bornLeader ? 'leader' : 'follower',
            epoch: leadership.epoch ?? (bornLeader ? 1 : 0),
            eligible: true,
            ...(leadership.autoPromoteMs != undefined ? {autoPromoteMs: leadership.autoPromoteMs} : {}),
            ...(leadership.accept ? {accept: leadership.accept} : {}),
            async elect(ctx) {
                if (!followedOnce && !forcePromote) return null
                return leadership.elect ? leadership.elect(ctx) : {epoch: ctx.maxEpoch + 1}
            },
        },
    })
    function leading() {
        return replica.api.status.state.role == 'leader'
    }
    function requireLeading(verb: string) {
        if (!leading()) {
            throw new Error(`authority ${nodeId} is standby: ${verb} refused — the leader is ${replica.api.status.state.leaderId ?? 'unknown'}`)
        }
    }

    // ============== ONE control line: roster + deny list + receipts, owned or followed ==============
    const control = createControlLine<ScaleControlState>({
        initial: emptyControlState(),
        own: bornLeader,
        describe: {scaleControl: {version: 1, authority: nodeId}},
        label: `authority ${nodeId} control line`,
        log,
    })
    // owner-side facets over the control store; rebuilt on every promotion, dropped on demotion
    let roster: NodeDirectory | null = null
    let rosterLine: ReturnType<typeof projectStoreSection<ScaleControlState, 'nodes'>> | null = null
    function buildOwnerFacets() {
        const store = control.store()
        roster = createNodeDirectory({store, ...(staleMs != undefined ? {staleMs} : {})})
        rosterLine = projectStoreSection(store, 'nodes', {nodeDirectory: {version: 2, authority: nodeId}})
        return roster
    }
    function dropOwnerFacets() {
        roster?.close()
        roster = null
        rosterLine?.close()
        rosterLine = null
    }
    function requireRoster(verb: string) {
        if (!roster) throw new Error(`authority ${nodeId} is standby: ${verb} refused — it owns no roster`)
        return roster
    }
    if (bornLeader) buildOwnerFacets()

    // ============== the write half: commands with receipts, forwardable by any node ==============
    const corridorDeps = deps.corridor ?? {}
    const commandHost = createCommandHost<Cmds>({
        commands: corridorDeps.commands ?? ({} as Cmds),
        ...(corridorDeps.limits ? {limits: corridorDeps.limits} : {}),
        receipts: {
            ...corridorDeps.receipts,
            ...(bornLeader ? {line: createCommandReceipts({store: control.store()}).control} : {}),
        },
    })
    /** Admission: a command executes here ONLY while this process is the point of order. */
    async function execute<K extends keyof Cmds & string>(
        account: string, command: K, requestId: string, input: Parameters<Cmds[K]>[1],
    ): Promise<Awaited<ReturnType<Cmds[K]>>> {
        requireLeading('command ' + command)
        return commandHost.execute(account, command, requestId, input)
    }
    const corridorHost = {execute, names: commandHost.names}
    function fragment(account: string) {
        return bindCommandNames<CommandFragment<Cmds>>(commandHost.names, function bindAuthorityCommand(name) {
            return function authorityCommand(requestId: string, input: any) {
                return execute(account, name as keyof Cmds & string, requestId, input)
            }
        })
    }

    // ============== identity: verify against the adapter AND the deny list ==============
    function isRevoked(account: string) {
        return control.store().state.revoked[account] != undefined
    }
    function requireLiveClaims(presented: unknown) {
        const principal = identity.verify(presented)
        if (isRevoked(principal.account)) {
            // the ONE rejection that kills a live session (RPC-AUTH rule 6)
            throw Object.assign(new Error('account revoked at the authority'), {revoke: true})
        }
        return principal
    }

    /** Raw press: issues without touching the deny list; login is the lifecycle verb. */
    function mint(account: string) {
        const token = identity.issue(account)
        // read the deadline back out of the token: one clock, no second drift
        const principal = identity.verify(token)
        return {
            token, account,
            ...(principal.expiresAt != undefined ? {expiresAt: principal.expiresAt} : {}),
        }
    }

    /** Explicit login IS the new session: it lifts this account's revocation. */
    function login(account: string) {
        requireLeading('login')
        const revoked = control.store().state.revoked
        if (revoked[account]) delete revoked[account]
        return mint(account)
    }

    /** Renewal path (token provider): refuses revoked instead of lifting anything. */
    function renew(presented: unknown) {
        return mint(requireLiveClaims(presented).account)
    }

    // ============== live sessions: cut on revoke without waiting for a HELLO ==============
    // rule-7 bookkeeping is the SHARED primitive — the store node runs the same one
    const sessions = createSessionRegistry()

    function revokeAccount(account: string) {
        requireLeading('revoke')
        control.store().state.revoked[account] = {account, ts: Date.now()}
        const cut = sessions.cut(account, 'account revoked at the authority')
        log(`scale authority ${nodeId}: revoked ${account} — ${cut} live sessions cut, nodes follow the replicated fact`)
        return {revoked: true as const, account, sessionsCut: cut}
    }

    // ============== per-command verification: the authority NEVER trusts a relay ==============
    const verified = verifyCommands({
        host: corridorHost,
        accountOf(presented) { return requireLiveClaims(presented).account },
    })

    // Who READS here is not "who is connected": every replica-set client keeps
    // sessions to ALL nodes for fork-choice, but only its ACTIVE route
    // subscribes to the replay line — the line's subscriber count is the honest
    // readers fact. On the authority it includes the mirror nodes themselves.
    function readers() {
        return replica.api.fragment.replay.line.count()
    }

    // ============== the standby side: follow the leader's link ==============
    let upstreamLink: AuthorityUpstream | null = null
    let offUpstreamFail: (() => void) | null = null
    /** Follow the control line from this link and announce ourselves as its standby. */
    async function attachUpstream(link: AuthorityUpstream) {
        upstreamLink = link
        offUpstreamFail?.()
        offUpstreamFail = link.onFail.on(function upstreamLinkFailed() {
            // the replica set learns the same failure through its session; the
            // control line simply stops advancing until the next link is resolved
        })
        if (leading()) return
        await control.follow(link.control)
        followedOnce = true
        if (started && !leading()) await announceStandby(link)
    }
    async function announceStandby(link: AuthorityUpstream) {
        try {
            await link.register({
                nodeId, url: deps.roster.url(), weight: 0, role: 'standby',
                ...(typeof globalThis.process?.pid == 'number' ? {pid: globalThis.process.pid} : {}),
            })
        } catch (error) {
            log(`scale authority ${nodeId}: standby registration failed — ${String((error as any)?.message ?? error)}`)
        }
    }
    if (leadership.upstream) {
        const resolveUpstream = leadership.upstream
        replica.control.addOffer({
            id: 'to-authority',
            // re-resolved per attempt: only the host knows the CURRENT leader
            connect: async function connectAuthorityUpstream() {
                const fresh = await resolveUpstream()
                if (fresh != upstreamLink) await attachUpstream(fresh)
                return {
                    remote: fresh.replica,
                    onFail: {on: (cb: () => void) => fresh.onFail.on(cb)},
                    close() {},
                }
            },
        })
    }

    // ============== role transitions: the replica set decides, the lines follow ==============
    const [emitRole, roleChanges] = listen<[tScaleAuthorityRole, {leaderId: string | null, epoch: number}]>()
    let announcedRole: tScaleAuthorityRole | null = null

    function becomeLeader() {
        control.promote()
        const owned = buildOwnerFacets()
        commandHost.adopt(createCommandReceipts({store: control.store()}).control)
        // the fleet gets staleMs to re-home before anyone is published dead
        owned.control.grace()
        // the roster continues: the dead (or demoted) leader's row and our own standby row go
        for (const view of nodeDirectoryViews(owned.control.snapshot())) {
            if (view.nodeId == nodeId || view.role == 'leader') owned.control.remove(view.nodeId)
        }
        if (started) publishOwnRow()
        log(`scale authority ${nodeId}: LEADER (epoch ${replica.api.status.state.epoch})`)
    }

    function becomeStandby() {
        dropOwnerFacets()
        control.demote()
        commandHost.adopt(null)
        log(`scale authority ${nodeId}: STANDBY — leader is ${replica.api.status.state.leaderId ?? 'unknown'}`)
        if (upstreamLink) {
            void attachUpstream(upstreamLink).catch(function standbyAttachFailed(error) {
                log(`scale authority ${nodeId}: standby follow failed — ${String((error as any)?.message ?? error)}`)
            })
        }
    }

    function syncRole() {
        const next: tScaleAuthorityRole = leading() ? 'leader' : 'standby'
        if (next == announcedRole) return
        const first = announcedRole == null
        announcedRole = next
        // a born leader already owns everything; a born standby already follows
        if (next == 'leader' && (!first || !bornLeader)) becomeLeader()
        if (next == 'standby' && !first) becomeStandby()
        emitRole(next, {leaderId: replica.api.status.state.leaderId, epoch: replica.api.status.state.epoch})
    }
    syncRole()
    const offRole = replica.api.status.node.at('role').on(function replicaRoleChanged() { syncRole() })

    // ============== the authority's own roster row + heartbeat ==============
    let started = false
    let beat: ReturnType<typeof setInterval> | null = null
    function authorityMeta() {
        // observability IS replication: the readers fact rides the ordinary heartbeat
        return {readers: readers(), ...deps.roster.meta?.()}
    }
    function publishOwnRow() {
        requireRoster('own row').control.set({nodeId, url: deps.roster.url(), role: 'leader', weight, meta: authorityMeta()})
    }
    /** Call once the transport is bound: publishes the row (leader or standby) and starts the heartbeat. */
    function start() {
        if (started) return
        started = true
        if (leading()) publishOwnRow()
        else if (upstreamLink) void announceStandby(upstreamLink)
        beat = setInterval(function authorityHeartbeat() {
            if (leading()) roster?.control.heartbeat(nodeId, {meta: authorityMeta()})
            // .then, not Promise.resolve(call): an in-process link throws synchronously when its owner is gone
            else void Promise.resolve().then(function standbyBeat() { return upstreamLink?.heartbeat(nodeId, {}) }).catch(function standbyBeatLost() {})
        }, heartbeatMs)
        ;(beat as any).unref?.()
    }

    // ============== serve: audience-ready RPC blocks ==============
    /** Per-account identity port for a browser connection the host has bound. */
    function identityFor(account: string) {
        return {
            login: function loginBoundAccount() { return login(account) },
            renew,
        }
    }

    /** Participant surface (ungated): follow the line, read the roster projection, mint identity. */
    function browser(account: string) {
        if (!rosterLine) throw new Error(`authority ${nodeId} is standby: serve browser refused — serve reader() there`)
        return {
            replica: replica.api.fragment,
            roster: rosterLine.api,
            identity: identityFor(account),
        }
    }

    /** Lean ungated read surface: the authority AS a node, shape-identical to a mirror's. */
    function reader() {
        return {replica: replica.api.fragment, node: () => nodeId}
    }

    /** Trusted node link; serve it ONLY on connections the host authenticated as nodes.
     *  Pass the authenticated node's id to BIND the link: every verb then refuses foreign
     *  rows, so one node can never overwrite or delist a peer. Unbound links still refuse
     *  the authority's own row — no node may impersonate the single point of order.
     *  A standby serves no node link: it owns no lines (serve reader() there). */
    function nodeLink(linkNodeId?: string) {
        const owned = requireRoster('serve node link')
        const controlApi = control.api('serve node link')
        function requireNodeRow(raw: unknown, verb: string) {
            const id = String(raw ?? '')
            if (!id) throw new Error('node link ' + verb + ' needs a nodeId')
            if (id == nodeId) throw new Error('node link refused: ' + id + ' is the authority row')
            if (linkNodeId != undefined && id != linkNodeId) {
                throw new Error('node link bound to ' + linkNodeId + ' refused row ' + id)
            }
            return id
        }
        return {
            replica: replica.api.fragment,
            /** ONE line: roster + deny list + receipts — nodes cut sessions and standbys succeed on it. */
            control: controlApi,
            /** End-to-end hop: every forwarded command carries the END client's token. */
            commandsByToken: verified.fragment(),
            register(entry: {nodeId?: unknown, url?: unknown, weight?: unknown, role?: unknown, pid?: unknown, readers?: unknown}) {
                const id = requireNodeRow(entry?.nodeId, 'register')
                if (!acceptNode(id)) throw new Error('node link refused: ' + id)
                const url = String(entry?.url ?? '')
                // a standby announces itself with weight 0: discoverable, never placed
                const role = entry?.role == 'standby' ? 'standby' : 'mirror'
                const nodeWeight = role == 'standby' ? 0 : Number(entry?.weight ?? 4)
                // pid makes the PROCESS visible on panels — every node is an OS process
                const pid = finiteCount(entry?.pid)
                // set replaces the row wholesale — carry the old facts across a link-flap
                // re-register, but let the facts the fresh process REPORTS win: a node that
                // sends readers at register (store-node does) resets the count a dead
                // predecessor left behind instead of inheriting its load
                const meta = {
                    ...owned.control.get(id)?.meta,
                    ...(pid ? {pid} : {}),
                    ...(entry?.readers != undefined ? {readers: finiteCount(entry.readers)} : {}),
                }
                owned.control.set({
                    nodeId: id, url, role, weight: Number.isFinite(nodeWeight) ? nodeWeight : 4,
                    ...(Object.keys(meta).length ? {meta} : {}),
                })
                log(`scale authority ${nodeId}: ${role} ${id} registered at ${url}`)
                return {ok: true}
            },
            heartbeat(id: unknown, facts?: {readers?: unknown}) {
                const key = requireNodeRow(id, 'heartbeat')
                // a node's readers count is a fact it reports about itself; sanitize, never
                // trust shape — the roster merges meta, so the registered pid survives
                const meta = facts?.readers != undefined ? {readers: finiteCount(facts.readers)} : {}
                return {ok: owned.control.heartbeat(key, {meta})}
            },
            goodbye(id: unknown) {
                owned.control.remove(requireNodeRow(id, 'goodbye'))
                return {ok: true}
            },
        }
    }

    /** Ready-made blocks for ONE gated write connection (RPC-AUTH rules 1/3/6/7). */
    function connection() {
        let serverControl: RpcServerControl | null = null
        let bound: {account: string, control: RpcServerControl} | null = null
        function rebind(account: string) {
            if (!serverControl || bound?.account == account) return
            if (bound) sessions.untrack(bound.account, bound.control)
            bound = {account, control: serverControl}
            sessions.track(account, serverControl)
        }
        function principalFor(principal: StoreNodePrincipal) {
            return {
                whoami: () => principal.account + ' @ ' + nodeId,
                commands: fragment(principal.account),
                /** Logout-everywhere: the deny fact reaches every node's sessions. */
                revoke: () => revokeAccount(principal.account),
            }
        }
        function resolveAuth(presented: unknown) {
            const principal = requireLiveClaims(presented)
            rebind(principal.account)
            return {
                object: principalFor(principal),
                ack: {ok: true, who: principal.account, node: nodeId},
                ...(principal.expiresAt != undefined ? {expiresAt: principal.expiresAt} : {}),
                renewBeforeMs,
            }
        }
        return {
            object: {},   // anonymous surface: nothing before a verified HELLO
            auth: {gate: true, resolveAuth},
            attach(attached: RpcServerControl) { serverControl = attached },
            close() {
                if (bound) sessions.untrack(bound.account, bound.control)
                bound = null
                serverControl = null
            },
        }
    }

    /** Operator failover: take the line over NOW (the first-follow guard is bypassed on purpose). */
    async function promote(reason = 'manual') {
        forcePromote = true
        try { return await replica.control.promote(reason) } finally { forcePromote = false }
    }

    function close() {
        if (beat) clearInterval(beat)
        offRole()
        offUpstreamFail?.()
        commandHost.close()
        dropOwnerFacets()
        control.close()
        replica.close()
        roleChanges.close()
    }

    // The roster facade delegates to the CURRENT owner: reads answer on a standby
    // from the followed rows, writes exist only on the leader.
    const rosterControl = {
        set: (row: NodeDirectoryRow) => requireRoster('set').control.set(row),
        patch: (id: string, partial: Parameters<NodeDirectory['control']['patch']>[1]) => requireRoster('patch').control.patch(id, partial),
        heartbeat: (id: string, partial?: Parameters<NodeDirectory['control']['heartbeat']>[1]) => requireRoster('heartbeat').control.heartbeat(id, partial),
        drain: (id: string) => requireRoster('drain').control.drain(id),
        undrain: (id: string, w?: number) => requireRoster('undrain').control.undrain(id, w),
        remove: (id: string) => requireRoster('remove').control.remove(id),
        get: (id: string) => control.store().state.nodes[id],
        snapshot: () => control.store().snapshot().nodes,
    }

    return {
        /** The replica line, whole: writes through control.store, wire through api.fragment. */
        line: {control: replica.control, api: replica.api},
        /** The roster: owner verbs through control (leader only), the browser-safe projection line through api. */
        roster: {
            control: rosterControl,
            /** The `nodes` projection line; throws on a standby (serve reader() there). */
            get api() {
                if (!rosterLine) throw new Error(`authority ${nodeId} is standby: serve roster refused`)
                return rosterLine.api
            },
        },
        identity: {login, renew, revoke: revokeAccount, mint},
        /** The write corridor: local execution, per-account fragments, the token hop. */
        corridor: {
            execute,
            names: commandHost.names,
            fragment,
            byToken: verified.fragment,
        },
        /** Connection surfaces by audience; the host binds each to its socket/key. */
        serve: {browser, reader, nodeLink, connection},
        control: {promote},
        /** Outward facts: the role flips here first — hosts rewire sockets on it. */
        events: {role: roleChanges},
        view: {
            role: () => (leading() ? 'leader' : 'standby') as tScaleAuthorityRole,
            leaderId: () => replica.api.status.state.leaderId,
            epoch: () => replica.api.status.state.epoch,
            nodes: () => nodeDirectoryViews(control.store().snapshot().nodes),
            readers,
            isRevoked,
        },
        start,
        close,
    }
}
export type ScaleAuthority<
    T extends Record<string, any> = Record<string, any>,
    Cmds extends tCommandMap = {},
> = ReturnType<typeof createAuthority<T, Cmds>>
