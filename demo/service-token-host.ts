// =====================================================================
// Service tokens stand — server half
// =====================================================================
// Two REAL service leaders (createServiceLeader) per visitor sandbox, mounted on the stand's own
// Socket.IO server the way the shipped leader host mounts them: 'app' ungated (roster, identity,
// public views), 'scale' gated (resolveAuth builds the principal's facade). What the library
// leaves to the application lives here and nowhere else:
//   - the application's own login: an HTTP route checks the demo credentials in constant time,
//     THEN asks the leader to issue (leader.identity.login) — the ungated identity never mints
//     from a name (3.0.1), so a server-side issuer is the only way a token-only service gets one;
//   - the operator's console: revoke goes through the leader's control, never through a client;
//   - public-stand bounds: sandbox caps, one budget per sandbox, an idle sweep.
// Isolation is structural: a sandbox owns its leaders, hence its state, its deny list and its
// per-run token secret. A revoke in one sandbox cannot name an account of another.

import {randomBytes} from 'crypto'
import express, {type NextFunction, type Request, type Response} from 'express'
import type {Socket} from 'socket.io'
import {listen} from '../src/Common/events/Listen'
import {createRateWindow} from '../src/Common/funcTimeWait'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import {sameSecret} from '../src/server/secret-equal'
import {createServiceLeader, schemaCommand, type ServiceCommandCtx, type tServiceDefinition} from '../src/service/server'
import {
    serviceTokenCredentials,
    serviceTokenKeys,
    serviceTokenLimits,
    serviceTokenRoutes,
    serviceTokenServices,
    type ServiceTokenLoginReply,
    type ServiceTokenRefusal,
    type ServiceTokenRevokeReply,
    type ServiceTokenSandboxReply,
    type tServiceTokenAccount,
    type tServiceTokenLimits,
    type tServiceTokenService,
} from './service-token-contract'

// ============================================================
// the demo's credential check — the application's identity port
// ============================================================

// matches nothing: an unknown account still pays one full compare
const noAccountPassword = randomBytes(24).toString('base64url')

function accountOf(raw: unknown) {
    return typeof raw == 'string' && Object.hasOwn(serviceTokenCredentials, raw) ? raw as tServiceTokenAccount : null
}

function serviceOf(raw: unknown) {
    return typeof raw == 'string' && Object.hasOwn(serviceTokenServices, raw) ? raw as tServiceTokenService : null
}

/** Constant time over the password, and the same cost whether or not the account exists. */
function checkDemoCredentials(rawAccount: unknown, password: unknown) {
    const account = accountOf(rawAccount)
    const matches = sameSecret(password, account ? serviceTokenCredentials[account] : noAccountPassword)
    return matches && account ? account : null
}

// ============================================================
// the two services: one board, two ways to obtain a token
// ============================================================
// board — no access.login: tokens come only from a server-side issuer (here, the stand's login).
// desk  — access.login: the leader itself is the identity provider, credentials ride RPC.
// Both keep roles in their state and declare a role view, so the raw line is never served.

type BoardNote = {text: string, by: string, at: number}
export type BoardState = {notes: BoardNote[], roles: Record<string, string[]>}

const boardInitial: BoardState = {notes: [], roles: {owner: ['owner'], member: ['member']}}

function boardRolesOf(state: BoardState, account: string): readonly string[] {
    return Object.hasOwn(state.roles, account) ? state.roles[account] : []
}

const boardCommands = {
    note: schemaCommand({text: 'string'}, {
        allow: ['member', 'owner'],
        limit: {perMinute: 20},
        validate(input) {
            const text = input.text.trim()
            if (!text || text.length > serviceTokenLimits.noteChars) {
                throw new Error(`a note is 1..${serviceTokenLimits.noteChars} characters`)
            }
        },
        apply(ctx: ServiceCommandCtx<BoardState>, input) {
            // the cap guards apply before the first mutation, so a refusal commits nothing
            if (ctx.state.notes.length >= serviceTokenLimits.maxNotes) {
                throw new Error(`the board is full (${serviceTokenLimits.maxNotes} notes): the owner may clear it`)
            }
            ctx.state.notes.push({text: input.text.trim(), by: ctx.account, at: Date.now()})
            return {notes: ctx.state.notes.map(note => ({...note}))}
        },
    }),
    clear: schemaCommand({}, {
        allow: ['owner'],
        apply(ctx: ServiceCommandCtx<BoardState>) {
            const cleared = ctx.state.notes.length
            ctx.state.notes.splice(0)
            return {cleared, notes: [] as BoardNote[]}
        },
    }),
}

const boardViews = {
    board: {allow: ['member', 'owner'], shared: true, project: (state: BoardState) => ({notes: state.notes})},
}

/** Credential login served by the desk's leader: the account out, or null. */
function resolveDemoLogin(state: BoardState, input: {account: string, password: string}) {
    const account = checkDemoCredentials(input.account, input.password)
    return account && boardRolesOf(state, account).length ? account : null
}

export const boardDefinition = {
    name: serviceTokenServices.board, storeId: 'service-token-board', originId: 'service-token-board',
    initial: boardInitial,
    commands: boardCommands,
    views: boardViews,
    access: {rolesOf: boardRolesOf},
    limits: {perMinute: 30},
} satisfies tServiceDefinition<BoardState>

export const deskDefinition = {
    name: serviceTokenServices.desk, storeId: 'service-token-desk', originId: 'service-token-desk',
    initial: boardInitial,
    commands: boardCommands,
    views: boardViews,
    access: {
        rolesOf: boardRolesOf,
        login: {input: {account: 'string', password: 'string'}, resolve: resolveDemoLogin},
    },
    limits: {perMinute: 30},
} satisfies tServiceDefinition<BoardState>

/** One sandbox's leaders. Never started: no roster row, no heartbeat timer, no node may join.
 *  Their internal chatter stays quiet; the host logs the sandbox facts itself. */
function openLeaders() {
    function unpublished() { return '' }
    function quietLeader() {}
    return {
        board: createServiceLeader({definition: boardDefinition, selfUrl: unpublished, log: quietLeader}),
        desk: createServiceLeader({definition: deskDefinition, selfUrl: unpublished, log: quietLeader}),
    }
}

type Sandbox = {
    /** The visitor's capability: sent only to the visitor, never logged. */
    id: string
    /** What logs name instead of the id. */
    serial: number
    openedAt: number
    touchedAt: number
    leaders: ReturnType<typeof openLeaders>
    sockets: Set<Socket>
}

type tHostResult<T> = {ok: true, value: T} | {ok: false, status: number, error: string}

export type ServiceTokenHostDeps = {
    log?: (line: string) => void
    /** Override the public-stand bounds (tests shrink them). */
    limits?: Partial<tServiceTokenLimits>
    /** Sweep cadence; 0 disables the timer and the caller sweeps through control.sweep. */
    sweepMs?: number
}

const OPENED = 'sandbox-opened'

export function createServiceTokenHost(deps: ServiceTokenHostDeps = {}) {
    const limits: tServiceTokenLimits = {...serviceTokenLimits, ...deps.limits}
    const log = deps.log ?? function quiet() {}
    const sandboxes = new Map<string, Sandbox>()
    const budget = createRateWindow()
    let serial = 0

    // ============== sandboxes: two leaders per visitor, reachable only by an unguessable id ==============

    function closeSandbox(sandbox: Sandbox, reason: string) {
        if (sandboxes.get(sandbox.id) != sandbox) return
        sandboxes.delete(sandbox.id)
        budget.drop(sandbox.id)
        // sockets first: their disconnect handlers release the gated links before the leaders close
        for (const socket of [...sandbox.sockets]) socket.disconnect(true)
        sandbox.sockets.clear()
        for (const leader of Object.values(sandbox.leaders)) {
            void leader.control.close().catch(function leaderCloseFailed(error: unknown) {
                log(`[service-tokens] sandbox #${sandbox.serial} leader close failed: ${String((error as Error)?.message ?? error)}`)
            })
        }
        log(`[service-tokens] sandbox #${sandbox.serial} closed (${reason})`)
    }

    function sweep(now = Date.now()) {
        let closed = 0
        for (const sandbox of [...sandboxes.values()]) {
            const aged = now - sandbox.openedAt > limits.sandboxMaxAgeMs
            const idle = sandbox.sockets.size == 0 && now - sandbox.touchedAt > limits.sandboxIdleMs
            if (!aged && !idle) continue
            closeSandbox(sandbox, aged ? 'max age' : 'idle')
            closed++
        }
        return closed
    }

    /** A full stand makes room from the least recently used sandbox nobody is connected to. */
    function evictIdlest() {
        let idlest: Sandbox | null = null
        for (const sandbox of sandboxes.values()) {
            if (sandbox.sockets.size) continue
            if (!idlest || sandbox.touchedAt < idlest.touchedAt) idlest = sandbox
        }
        if (idlest) closeSandbox(idlest, 'evicted: the stand was full')
        return idlest != null
    }

    function openSandbox(): tHostResult<ServiceTokenSandboxReply> {
        const now = Date.now()
        if (budget.sumWeight(OPENED, 60_000) >= limits.opensPerMinute) {
            return {ok: false, status: 429, error: 'too many sandboxes opened this minute — try again shortly'}
        }
        sweep(now)
        if (sandboxes.size >= limits.maxSandboxes && !evictIdlest()) {
            return {ok: false, status: 503, error: 'the service token stand is full — try again later'}
        }
        budget.add({type: OPENED, weight: 1})
        const id = 'st-' + randomBytes(18).toString('base64url')
        const number = ++serial
        const sandbox: Sandbox = {id, serial: number, openedAt: now, touchedAt: now, sockets: new Set(), leaders: openLeaders()}
        sandboxes.set(id, sandbox)
        log(`[service-tokens] sandbox #${number} opened (${sandboxes.size}/${limits.maxSandboxes})`)
        return {ok: true, value: {sandbox: id, expiresAt: now + limits.sandboxMaxAgeMs, idleMs: limits.sandboxIdleMs}}
    }

    function sandboxFor(raw: unknown) {
        return typeof raw == 'string' ? sandboxes.get(raw) ?? null : null
    }

    /** One budget per sandbox: HTTP calls, identity calls and token presentations all spend it. */
    function spend(sandbox: Sandbox) {
        sandbox.touchedAt = Date.now()
        if (budget.sumWeight(sandbox.id, 60_000) >= limits.callsPerMinute) return false
        budget.add({type: sandbox.id, weight: 1})
        return true
    }

    function begin(raw: unknown): tHostResult<Sandbox> {
        const sandbox = sandboxFor(raw)
        if (!sandbox) return {ok: false, status: 404, error: 'sandbox unknown or expired — open a new one'}
        if (!spend(sandbox)) return {ok: false, status: 429, error: 'demo rate limit — slow down a little'}
        return {ok: true, value: sandbox}
    }

    // ============== the application's login and the operator's console ==============

    /** The stand's own authentication first; only then does the board's leader issue. */
    function login(input: {sandbox?: unknown, account?: unknown, password?: unknown}): tHostResult<ServiceTokenLoginReply> {
        const started = begin(input.sandbox)
        if (!started.ok) return started
        const account = checkDemoCredentials(input.account, input.password)
        if (!account) return {ok: false, status: 401, error: 'wrong demo credentials — nothing was issued'}
        const leader = started.value.leaders.board
        // login is the lifecycle verb: an explicit login starts a new session and lifts a revocation
        const liftedRevocation = leader.view.isRevoked(account)
        return {ok: true, value: {...leader.identity.login(account), liftedRevocation}}
    }

    /** Cut a sandbox account everywhere: deny list plus every live session, via the leader's control. */
    function revoke(input: {sandbox?: unknown, service?: unknown, account?: unknown}): tHostResult<ServiceTokenRevokeReply> {
        const started = begin(input.sandbox)
        if (!started.ok) return started
        const service = serviceOf(input.service)
        const account = accountOf(input.account)
        if (!service || !account) return {ok: false, status: 400, error: 'revoke needs a service (board | desk) and a demo account (owner | member)'}
        const revoked = started.value.leaders[service].control.revoke(account)
        log(`[service-tokens] sandbox #${started.value.serial} ${service}: operator revoked ${account} — ${revoked.sessionsCut} live session(s) cut`)
        return {ok: true, value: revoked}
    }

    // ============== transports: the stand's Express app and Socket.IO server ==============

    function router() {
        const routes = express.Router()
        const body = express.json({limit: '1kb'})
        function reply<T>(res: Response, result: tHostResult<T>) {
            if (result.ok) res.json(result.value)
            else res.status(result.status).json({error: result.error} satisfies ServiceTokenRefusal)
        }
        routes.post(serviceTokenRoutes.sandbox, function openServiceTokenSandbox(_req: Request, res: Response) {
            reply(res, openSandbox())
        })
        routes.post(serviceTokenRoutes.login, body, function serviceTokenLogin(req: Request, res: Response) {
            reply(res, login(req.body ?? {}))
        })
        routes.post(serviceTokenRoutes.revoke, body, function serviceTokenRevoke(req: Request, res: Response) {
            reply(res, revoke(req.body ?? {}))
        })
        // a malformed body answers as data, not as the framework's stack page
        routes.use(function serviceTokenBadRequest(_error: unknown, _req: Request, res: Response, _next: NextFunction) {
            res.status(400).json({error: 'malformed request'} satisfies ServiceTokenRefusal)
        })
        return routes
    }

    /** The identity verbs cost the sandbox's budget; the served members stay exactly the leader's. */
    function budgeted<F extends {identity: object}>(sandbox: Sandbox, fragment: F): F {
        const identity: Record<string, unknown> = {}
        for (const [verb, call] of Object.entries(fragment.identity)) {
            identity[verb] = typeof call != 'function' ? call : function budgetedIdentity(...args: unknown[]) {
                if (!spend(sandbox)) throw new Error('demo rate limit — slow down a little')
                return call(...args)
            }
        }
        return {...fragment, identity}
    }

    function mountSocket(socket: Socket) {
        // the handshake is client-controlled: it ROUTES (sandbox, service) and never names a principal
        const handshake = socket.handshake.auth as Record<string, unknown> | undefined
        const sandbox = sandboxFor(handshake?.['sandbox'])
        const service = serviceOf(handshake?.['service'])
        if (!sandbox || !service || sandbox.sockets.size >= limits.socketsPerSandbox) {
            socket.disconnect(true)
            return
        }
        const leader = sandbox.leaders[service]
        const name = serviceTokenServices[service]
        const [gone, goneListen] = listen<[]>()
        const link = leader.serve.scaleConnection()
        sandbox.sockets.add(socket)
        sandbox.touchedAt = Date.now()
        socket.on('disconnect', function serviceTokenSocketGone() {
            sandbox.sockets.delete(socket)
            sandbox.touchedAt = Date.now()
            gone()
            link.close()
        })
        // gated write surface: {} until a verified HELLO, then the principal's facade
        const {control} = createRpcServerAuto({
            socket,
            socketKey: serviceTokenKeys.scale,
            object: link.object,
            auth: {
                gate: true,
                resolveAuth: function resolveSandboxPrincipal(presented: unknown) {
                    // a HELLO flood must not rebuild principal facades for free
                    if (!spend(sandbox)) throw new Error('demo rate limit — slow down a little')
                    const resolved = link.auth.resolveAuth(presented)
                    // the serve fragments are bodies; the host applies the wire wrap
                    return {...resolved, object: {[name]: resolved.object}}
                },
            },
            disconnectListen: goneListen,
        })
        link.attach(control)
        // ungated participant surface: identity is {renew} ({login, renew} with access.login);
        // nothing on this socket is bound to an account, whatever its handshake says
        createRpcServerAuto({
            socket,
            socketKey: serviceTokenKeys.app,
            object: {[name]: budgeted(sandbox, leader.serve.browserFragment())},
            disconnectListen: goneListen,
        })
    }

    const sweepMs = deps.sweepMs ?? 30_000
    const sweeper = sweepMs > 0 ? setInterval(function sweepServiceTokenSandboxes() { sweep() }, sweepMs) : null
    sweeper?.unref?.()

    function isRevoked(sandbox: string, service: tServiceTokenService, account: string) {
        return sandboxes.get(sandbox)?.leaders[service].view.isRevoked(account) ?? null
    }

    function close() {
        if (sweeper) clearInterval(sweeper)
        for (const sandbox of [...sandboxes.values()]) closeSandbox(sandbox, 'stand closed')
    }

    return {
        /** Commands inward: the stand's HTTP routes call these; tests may too. */
        control: {openSandbox, login, revoke, sweep},
        /** Transports: mounted on the stand's own Express app and Socket.IO server. */
        serve: {router, socket: mountSocket},
        /** Server-side facts for logs and tests; nothing here is served to a browser. */
        view: {
            sandboxes: () => sandboxes.size,
            sockets: (sandbox: string) => sandboxes.get(sandbox)?.sockets.size ?? 0,
            isRevoked,
        },
        close,
    }
}

export type ServiceTokenHost = ReturnType<typeof createServiceTokenHost>
