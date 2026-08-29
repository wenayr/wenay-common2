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
// The HOST keeps what only a process can own (doc/DYNAMIC-RUNTIME.md
// boundary): env, transports (socket servers, who gets which fragment), token
// CRYPTOGRAPHY (identity.issue/verify are adapters — this file owns no crypto
// and no token format; precedent: store-node deps.auth.verify), process
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
import {createCommandHost, type CommandHostDeps, type tCommandMap} from '../command/command-host'
import {verifyCommands} from '../command/command-token'
import {createNodeDirectory, nodeDirectoryViews} from '../Observe/node-directory'
import {createReplicatedMap} from '../Observe/replicated-map'
import {createStoreReplicaSet} from '../Observe/store-replica-set'
import type {StoreNodePrincipal, StoreNodeRevocation} from '../Observe/store-node'

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
    receipts?: CommandHostDeps<Cmds>['receipts']
    identity: ScaleIdentityAdapter
    /** 'expiring' lead time of the RPC grants served here; default 15s. */
    renewBeforeMs?: number
    heartbeatMs?: number
    /** Node-link register guard; default accepts any non-empty nodeId. */
    acceptNode?: (nodeId: string) => boolean
    /** Extra authority-row facts, merged into the row and heartbeat beside {readers}. */
    meta?: () => Record<string, unknown>
    log?: (line: string) => void
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

    const replica = createStoreReplicaSet<T>({
        storeId: deps.storeId, originId: deps.originId, nodeId,
        lineId: deps.lineId ?? nodeId + '-line',
        initial: deps.initial,
        leadership: {initialRole: 'leader', epoch: 1},
    })
    const directory = createNodeDirectory()

    // ============== the write half: commands with receipts, forwardable by any node ==============
    const commandHost = createCommandHost<Cmds>({
        commands: deps.commands ?? ({} as Cmds),
        ...(deps.limits ? {limits: deps.limits} : {}),
        ...(deps.receipts ? {receipts: deps.receipts} : {}),
    })

    // ============== revocation is DATA: one replicated deny-list line ==============
    const revocations = createReplicatedMap<StoreNodeRevocation>({
        keyOf(revocation) { return revocation.account },
        delivery: 'latest',
    })

    /** Verify a presented token against the adapter AND the deny list; a throw rejects. */
    function requireLiveClaims(presented: unknown) {
        const principal = identity.verify(presented)
        if (revocations.control.has(principal.account)) {
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
        revocations.control.delete(account)
        return mint(account)
    }

    /** Renewal path (token provider): refuses revoked instead of lifting anything. */
    function renew(presented: unknown) {
        return mint(requireLiveClaims(presented).account)
    }

    // ============== live sessions: cut on revoke without waiting for a HELLO ==============
    const sessions = new Map<string, Set<RpcServerControl>>()
    function trackSession(account: string, control: RpcServerControl) {
        let tracked = sessions.get(account)
        if (!tracked) sessions.set(account, tracked = new Set())
        tracked.add(control)
    }
    function untrackSession(account: string, control: RpcServerControl) {
        const tracked = sessions.get(account)
        if (!tracked) return
        tracked.delete(control)
        if (tracked.size == 0) sessions.delete(account)
    }

    function revokeAccount(account: string) {
        revocations.control.set({account, ts: Date.now()})
        let cut = 0
        for (const control of [...(sessions.get(account) ?? [])]) {
            if (control.revoke('account revoked at the authority')) cut++
        }
        log(`scale authority ${nodeId}: revoked ${account} — ${cut} live sessions cut, nodes follow the replicated fact`)
        return {revoked: true as const, account, sessionsCut: cut}
    }

    // ============== per-command verification: the authority NEVER trusts a relay ==============
    const verified = verifyCommands({
        host: commandHost,
        accountOf(presented) { return requireLiveClaims(presented).account },
    })

    // Who READS here is not "who is connected": every replica-set client keeps
    // sessions to ALL nodes for fork-choice, but only its ACTIVE route
    // subscribes to the replay line — the line's subscriber count is the honest
    // readers fact. On the authority it includes the mirror nodes themselves.
    function readers() {
        return replica.api.fragment.replay.line.count()
    }

    // ============== the authority's own directory row + heartbeat ==============
    let started = false
    let beat: ReturnType<typeof setInterval> | null = null
    function authorityMeta() {
        // observability IS replication: the readers fact rides the ordinary heartbeat
        return {readers: readers(), ...deps.meta?.()}
    }
    /** Call once the transport is bound: registers the authority row and starts its heartbeat. */
    function start() {
        if (started) return
        started = true
        directory.control.upsert({nodeId, url: deps.selfUrl(), role: 'leader', weight, meta: authorityMeta()})
        beat = setInterval(function authorityHeartbeat() {
            directory.control.heartbeat(nodeId, {meta: authorityMeta()})
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
            directory: directory.api,
            identity: identityFor(account),
        }
    }

    /** Lean ungated read surface: the authority AS a node, shape-identical to a mirror's. */
    function reader() {
        return {replica: replica.api.fragment, node: () => nodeId}
    }

    /** Trusted mini-node link; serve it ONLY on connections the host authenticated as nodes. */
    function nodeLink() {
        return {
            replica: replica.api.fragment,
            directory: directory.api,
            /** Revocations are data: nodes follow this line and cut their own sessions. */
            revoked: revocations.api,
            /** End-to-end hop: every forwarded command carries the END client's token. */
            commandsByToken: verified.fragment(),
            register(entry: {nodeId?: unknown, url?: unknown, weight?: unknown, pid?: unknown}) {
                const id = String(entry?.nodeId ?? '')
                if (!id) throw new Error('node link register needs a nodeId')
                if (!acceptNode(id)) throw new Error('node link refused: ' + id)
                const url = String(entry?.url ?? '')
                const nodeWeight = Number(entry?.weight ?? 4)
                // pid makes the PROCESS visible on panels — every node is an OS process
                const pid = Math.floor(Number(entry?.pid ?? 0)) || 0
                directory.control.upsert({
                    nodeId: id, url, role: 'mirror', weight: Number.isFinite(nodeWeight) ? nodeWeight : 4,
                    ...(pid ? {meta: {pid}} : {}),
                })
                log(`scale authority ${nodeId}: node ${id} registered at ${url}`)
                return {ok: true}
            },
            heartbeat(id: unknown, facts?: {readers?: unknown}) {
                const key = String(id)
                // a node's readers count is a fact it reports about itself; sanitize, never trust shape
                const reported = Math.max(0, Math.floor(Number(facts?.readers ?? 0))) || 0
                // meta replaces wholesale on heartbeat — merge so the registered pid survives
                const meta = {...directory.control.get(key)?.meta, readers: reported}
                return {ok: directory.control.heartbeat(key, {meta})}
            },
            goodbye(id: unknown) {
                directory.control.remove(String(id))
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
            if (bound) untrackSession(bound.account, bound.control)
            bound = {account, control}
            trackSession(account, control)
        }
        function principalFor(principal: StoreNodePrincipal) {
            return {
                whoami: () => principal.account + ' @ ' + nodeId,
                commands: commandHost.fragment(principal.account),
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
                if (bound) untrackSession(bound.account, bound.control)
                bound = null
                control = null
            },
        }
    }

    function close() {
        if (beat) clearInterval(beat)
        commandHost.close()
        revocations.control.close()
        directory.control.close()
        replica.close()
    }

    return {
        /** The replica line, whole: writes through control.store, wire through api.fragment. */
        line: {control: replica.control, api: replica.api},
        /** The node roster, whole: host verbs through control, wire line through api. */
        directory: {control: directory.control, api: directory.api},
        identity: {login, renew, revoke: revokeAccount, mint},
        /** The write corridor: local execution, per-account fragments, the token hop. */
        corridor: {
            execute: commandHost.execute,
            names: commandHost.names,
            fragment: commandHost.fragment,
            byToken: verified.fragment,
        },
        /** Connection surfaces by audience; the host binds each to its socket/key. */
        serve: {browser, reader, nodeLink, connection},
        view: {
            nodes: () => nodeDirectoryViews(directory.control.snapshot()),
            readers,
            isRevoked: (account: string) => revocations.control.has(account),
        },
        start,
        close,
    }
}
export type ScaleAuthority<
    T extends Record<string, any> = Record<string, any>,
    Cmds extends tCommandMap = {},
> = ReturnType<typeof createAuthority<T, Cmds>>
