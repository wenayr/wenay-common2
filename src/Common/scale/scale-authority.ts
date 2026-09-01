// =====================================================================
// Scale authority — the cluster's single point of order from one config object
// =====================================================================
// The authority side of the deployment triangle (authority / store node /
// cluster client): one replica line, the node directory, the command corridor
// with receipts and end-to-end token verification, and the identity lifecycle
// over a replicated deny list. Every host used to hand-wire these ~300 lines
// (demo mini-scale host, the scaffold template leader); this factory collapses
// them into deliberate facades by audience and rewrites none of the layers —
// it only composes the shipped primitives.
//
// Succession: the same factory runs as the LEADER or as a STANDBY. A standby
// follows the leader's replica line and its three control lines (directory,
// deny list, receipts) and takes them over when the ONE leadership decision —
// the replica set's fork choice / autoPromote / injected lease — makes it the
// leader: control lines are re-owned from the followed snapshots, the command
// host adopts the receipts line (at-most-once survives the process), the
// directory row flips from 'standby' to 'leader'. A leader that loses fork
// choice demotes: writes are refused, and with an upstream it follows the
// winner. Hosts learn every transition through events.role and rewire sockets.
//
// The HOST keeps what only a process can own (doc/DYNAMIC-RUNTIME.md
// boundary): env, transports (socket servers, who gets which fragment, the
// link to the CURRENT leader), token CRYPTOGRAPHY (identity.issue/verify are
// adapters — this file owns no crypto and no token format; precedent:
// store-node deps.auth.verify), process supervision and exit.
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
import {createCommandReceipts, type CommandReceiptRecord, type CommandReceiptsRemote} from '../command/command-receipts'
import {verifyCommands} from '../command/command-token'
import {createNodeDirectory, nodeDirectoryViews, type NodeDirectoryEntry} from '../Observe/node-directory'
import {createReplicatedMap, type ReplicatedMapRemote} from '../Observe/replicated-map'
import {createStoreReplicaSet, type StoreReplicaLeadership, type StoreReplicaSession} from '../Observe/store-replica-set'
import type {StoreNodePrincipal, StoreNodeRevocation} from '../Observe/store-node'
import {createLineSuccession} from './scale-succession'

// ============================================================
// public contract
// ============================================================

/** Token mint/verify adapters; cryptography stays with the host. */
export type ScaleIdentityAdapter = {
    /** Mint a token for an account; the string IS the credential. */
    issue: (account: string) => string
    /** Verified principal or THROW; expiresAt bounds the RPC grant. */
    verify: (presented: unknown) => StoreNodePrincipal
}

export type tScaleAuthorityRole = 'leader' | 'standby'

/** The CURRENT leader's node link as a standby sees it — serve.nodeLink(standbyId) on the leader. */
export type AuthorityUpstream = {
    replica: StoreReplicaSession['remote']
    directory: ReplicatedMapRemote<NodeDirectoryEntry>
    revoked: ReplicatedMapRemote<StoreNodeRevocation>
    receipts: CommandReceiptsRemote
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
    /** Replica-line coordinates; nodes and clients must match them to join. */
    storeId: string
    originId: string
    /** Directory identity of the authority row; default 'authority'. */
    nodeId?: string
    lineId?: string
    initial: T
    /** Client-reachable origin of THIS authority; read lazily (the port binds late). */
    selfUrl: () => string
    /** Directory placement share of the authority row; default 1 — readers should prefer nodes. */
    weight?: number
    /** The write half: commands behind (account, requestId) receipts. */
    commands?: Cmds
    limits?: CommandHostDeps<Cmds>['limits']
    /** Receipt bounds; the line itself is owned here and follows leadership. */
    receipts?: Omit<NonNullable<CommandHostDeps<Cmds>['receipts']>, 'line'>
    identity: ScaleIdentityAdapter
    /** 'expiring' lead time of the RPC grants served here; default 15s. */
    renewBeforeMs?: number
    heartbeatMs?: number
    /** Node-link register guard; default accepts any non-empty nodeId. */
    acceptNode?: (nodeId: string) => boolean
    /** Extra authority-row facts, merged into the row and heartbeat beside {readers}. */
    meta?: () => Record<string, unknown>
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
    const nodeId = deps.nodeId ?? 'authority'
    const weight = deps.weight ?? 1
    const heartbeatMs = deps.heartbeatMs ?? 3000
    const renewBeforeMs = deps.renewBeforeMs ?? 15_000
    const acceptNode = deps.acceptNode ?? function acceptAnyNode() { return true }
    const identity = deps.identity
    const leadership = deps.leadership ?? {}
    const bornLeader = (leadership.role ?? 'leader') == 'leader'

    // ============== ONE leadership decision: the replica set's ==============
    // A standby must never promote before it has followed once: two processes
    // booting side by side would otherwise both wake up as epoch-1 leaders.
    let followedOnce = bornLeader
    let forcePromote = false
    const replica = createStoreReplicaSet<T>({
        storeId: deps.storeId, originId: deps.originId, nodeId,
        lineId: deps.lineId ?? nodeId + '-line',
        initial: deps.initial,
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

    // ============== the three control lines: owned by the leader, followed by a standby ==============
    const directory = createLineSuccession<NodeDirectoryEntry, ReturnType<typeof createNodeDirectory>>({
        label: `authority ${nodeId} directory`, log, own: bornLeader,
        produce(initial) { return createNodeDirectory({initial}) },
    })
    const revocations = createLineSuccession<StoreNodeRevocation, ReturnType<typeof createReplicatedMap<StoreNodeRevocation>>>({
        label: `authority ${nodeId} deny list`, log, own: bornLeader,
        produce(initial) {
            return createReplicatedMap<StoreNodeRevocation>({
                keyOf(revocation) { return revocation.account },
                delivery: 'latest',
                initial,
            })
        },
    })
    const receipts = createLineSuccession<CommandReceiptRecord, ReturnType<typeof createCommandReceipts>>({
        label: `authority ${nodeId} receipts`, log, own: bornLeader,
        produce(initial) { return createCommandReceipts({initial}) },
    })

    // ============== the write half: commands with receipts, forwardable by any node ==============
    const commandHost = createCommandHost<Cmds>({
        commands: deps.commands ?? ({} as Cmds),
        ...(deps.limits ? {limits: deps.limits} : {}),
        receipts: {...deps.receipts, ...(receipts.owner() ? {line: receipts.owner()!.control} : {})},
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

    /** Verify a presented token against the adapter AND the deny list; a throw rejects. */
    function isRevoked(account: string) {
        return revocations.snapshot()[account] != undefined
    }
    function requireLiveClaims(presented: unknown) {
        const principal = identity.verify(presented)
        if (isRevoked(principal.account)) {
            // the ONE rejection that kills a live session (RPC-AUTH rule 6)
            throw Object.assign(new Error('account revoked at the authority'), {revoke: true})
        }
        return principal
    }

    // ============== identity lifecycle over the host's mint/verify adapters ==============
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
        revocations.requireOwner('login').control.delete(account)
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
        revocations.requireOwner('revoke').control.set({account, ts: Date.now()})
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
    /** Follow the control lines from this link and announce ourselves as its standby. */
    async function attachUpstream(link: AuthorityUpstream) {
        upstreamLink = link
        offUpstreamFail?.()
        offUpstreamFail = link.onFail.on(function upstreamLinkFailed() {
            // the replica set learns the same failure through its session; the
            // lines simply stop advancing until the next link is resolved
        })
        if (leading()) return
        await Promise.all([
            directory.follow(link.directory),
            revocations.follow(link.revoked),
            receipts.follow(link.receipts),
        ])
        followedOnce = true
        if (started && !leading()) await announceStandby(link)
    }
    async function announceStandby(link: AuthorityUpstream) {
        try {
            await link.register({
                nodeId, url: deps.selfUrl(), weight: 0, role: 'standby',
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
        const roster = directory.promote()
        revocations.promote()
        const receiptsLine = receipts.promote()
        commandHost.adopt(receiptsLine.control)
        // the roster continues: the dead (or demoted) leader's row and our own standby row go
        for (const view of nodeDirectoryViews(roster.control.snapshot())) {
            if (view.nodeId == nodeId || view.role == 'leader') roster.control.remove(view.nodeId)
        }
        if (started) publishOwnRow()
        log(`scale authority ${nodeId}: LEADER (epoch ${replica.api.status.state.epoch})`)
    }

    function becomeStandby() {
        directory.demote()
        revocations.demote()
        receipts.demote()
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

    // ============== the authority's own directory row + heartbeat ==============
    let started = false
    let beat: ReturnType<typeof setInterval> | null = null
    function authorityMeta() {
        // observability IS replication: the readers fact rides the ordinary heartbeat
        return {readers: readers(), ...deps.meta?.()}
    }
    function publishOwnRow() {
        directory.requireOwner('own row').control.upsert({nodeId, url: deps.selfUrl(), role: 'leader', weight, meta: authorityMeta()})
    }
    /** Call once the transport is bound: registers the row (leader or standby) and starts its heartbeat. */
    function start() {
        if (started) return
        started = true
        if (leading()) publishOwnRow()
        else if (upstreamLink) void announceStandby(upstreamLink)
        beat = setInterval(function authorityHeartbeat() {
            if (leading()) directory.owner()?.control.heartbeat(nodeId, {meta: authorityMeta()})
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

    /** Participant surface (ungated): follow the line, read the roster, mint identity. */
    function browser(account: string) {
        return {
            replica: replica.api.fragment,
            directory: directory.requireOwner('serve browser').api,
            identity: identityFor(account),
        }
    }

    /** Lean ungated read surface: the authority AS a node, shape-identical to a mirror's. */
    function reader() {
        return {replica: replica.api.fragment, node: () => nodeId}
    }

    /** Trusted mini-node link; serve it ONLY on connections the host authenticated as nodes.
     *  Pass the authenticated node's id to BIND the link: every verb then refuses foreign
     *  rows, so one node can never overwrite or delist a peer. Unbound links still refuse
     *  the authority's own row — no node may impersonate the single point of order.
     *  A standby serves no node link: it owns no lines (serve reader() there). */
    function nodeLink(linkNodeId?: string) {
        const roster = directory.requireOwner('serve node link')
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
            directory: roster.api,
            /** Revocations are data: nodes follow this line and cut their own sessions. */
            revoked: revocations.requireOwner('serve node link').api,
            /** Receipts are data too: a standby follows them and answers old requestIds after a failover. */
            receipts: receipts.requireOwner('serve node link').api,
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
                // upsert replaces the row wholesale — carry the old facts across a link-flap
                // re-register, but let the facts the fresh process REPORTS win: a node that
                // sends readers at register (store-node does) resets the count a dead
                // predecessor left behind instead of inheriting its load
                const meta = {
                    ...roster.control.get(id)?.meta,
                    ...(pid ? {pid} : {}),
                    ...(entry?.readers != undefined ? {readers: finiteCount(entry.readers)} : {}),
                }
                roster.control.upsert({
                    nodeId: id, url, role, weight: Number.isFinite(nodeWeight) ? nodeWeight : 4,
                    ...(Object.keys(meta).length ? {meta} : {}),
                })
                log(`scale authority ${nodeId}: ${role} ${id} registered at ${url}`)
                return {ok: true}
            },
            heartbeat(id: unknown, facts?: {readers?: unknown}) {
                const key = requireNodeRow(id, 'heartbeat')
                // a node's readers count is a fact it reports about itself; sanitize, never
                // trust shape — the directory merges meta, so the registered pid survives
                const meta = facts?.readers != undefined ? {readers: finiteCount(facts.readers)} : {}
                return {ok: roster.control.heartbeat(key, {meta})}
            },
            goodbye(id: unknown) {
                roster.control.remove(requireNodeRow(id, 'goodbye'))
                return {ok: true}
            },
        }
    }

    /** Ready-made blocks for ONE gated write connection (RPC-AUTH rules 1/3/6/7). */
    function connection() {
        let control: RpcServerControl | null = null
        let bound: {account: string, control: RpcServerControl} | null = null
        function rebind(account: string) {
            if (!control || bound?.account == account) return
            if (bound) sessions.untrack(bound.account, bound.control)
            bound = {account, control}
            sessions.track(account, control)
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
            attach(serverControl: RpcServerControl) { control = serverControl },
            close() {
                if (bound) sessions.untrack(bound.account, bound.control)
                bound = null
                control = null
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
        receipts.close()
        revocations.close()
        directory.close()
        replica.close()
        roleChanges.close()
    }

    // The directory facade delegates to the CURRENT owner: reads answer on a standby
    // from the followed rows, writes exist only on the leader.
    const directoryControl = {
        upsert: (...args: Parameters<ReturnType<typeof createNodeDirectory>['control']['upsert']>) => directory.requireOwner('upsert').control.upsert(...args),
        heartbeat: (...args: Parameters<ReturnType<typeof createNodeDirectory>['control']['heartbeat']>) => directory.requireOwner('heartbeat').control.heartbeat(...args),
        drain: (id: string) => directory.requireOwner('drain').control.drain(id),
        undrain: (id: string, w?: number) => directory.requireOwner('undrain').control.undrain(id, w),
        remove: (id: string) => directory.requireOwner('remove').control.remove(id),
        get: (id: string) => directory.snapshot()[id],
        snapshot: () => directory.snapshot(),
        flush: () => directory.owner()?.control.flush(),
        close: () => directory.owner()?.control.close(),
    }

    return {
        /** The replica line, whole: writes through control.store, wire through api.fragment. */
        line: {control: replica.control, api: replica.api},
        /** The node roster: host verbs through control (leader only), wire line through api. */
        directory: {
            control: directoryControl,
            /** The owned roster line; throws on a standby (serve reader() there). */
            get api() { return directory.requireOwner('serve directory').api },
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
            nodes: () => nodeDirectoryViews(directory.snapshot()),
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
