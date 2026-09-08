// =====================================================================
// Service leader — a thin mapping of the definition onto Scale.createAuthority
// =====================================================================
// TEMPLATE-OWNED: a service author never edits this file. Everything the old
// version of this file hand-wired (~360 lines: replica line, node directory,
// command receipts, end-to-end token verification, replicated deny list,
// gated connection blocks) is the public facade Scale.createAuthority now;
// this factory only maps serviceDefinition + secrets onto its deps and
// retransmits its facets. The DOMAIN arrives as data through deps.definition —
// see ./service.ts, the only author-owned file.
//
// Host boundary (doc/DYNAMIC-RUNTIME.md): this factory owns no env, no
// transports, no process exit. Token CRYPTOGRAPHY stays in THIS host layer —
// the codec is built from the corridor secret and handed down as the
// identity {issue, verify} adapter; the authority owns no crypto and no
// token format. Corridor secrets arrive (or default per-run) as plain
// strings and are returned so the ENTRYPOINT can hand them to node
// processes through env.
//
// TODO(graduation): the '../../../src/...' imports below become the package
// entrypoints ('wenay-common2', 'wenay-common2/server/auth') when this
// template graduates out of the incubator into its own package.

import {randomBytes} from 'crypto'
import express from 'express'
import {createServer} from 'http'
import {Server as SocketIOServer} from 'socket.io'
import type {CommandCtx} from '../../../src/Common/command/command-host'
import {listen} from '../../../src/Common/events/Listen'
import {createRpcServerAuto} from '../../../src/Common/rcp/rpc-server-auto'
import {createAuthority} from '../../../src/Common/scale/scale-authority'
import type {ScaleDurableLine} from '../../../src/Common/scale/scale-authority'
import {openFsReplayStorage} from '../../../src/server/fsReplayStorage'
import {createRateWindow} from '../../../src/Common/funcTimeWait'
import {cloneStoreValue} from '../../../src/Common/Observe/store'
import path from 'node:path'
import {mkdirSync} from 'node:fs'
import type {StoreReplayRemote} from '../../../src/Common/Observe/store-replay'
import {createTokenCodec} from '../../../src/server/auth-token'
import {createServiceAccess} from './access'
import {corsOrigins, leaderEnv, type tEnv} from './config'
import {buildInputValidate, type tInputSchema} from './input-schema'
import {createServiceRest} from './rest'

// ============================================================
// the definition contract — what the domain module must export
// ============================================================
// The contract lives with its consumer (this host layer); ./service.ts
// validates against it with `satisfies` and stays the source of its own type.

/** A verified principal as the definition sees it: the account plus its roles FROM STATE. */
export type tServicePrincipal = {account: string, roles: readonly string[]}

/**
 * The reserved host principal: commands the LEADER runs itself (signup, a
 * payment webhook, an effect outcome). Its only role is 'system'. It is never
 * minted into a token — every verifier refuses a token claiming it.
 */
export const SYSTEM_ACCOUNT = 'system'

/** What a command sees: the verified account and ITS ROLES, the request identity, and the STORE. */
export type ServiceCommandCtx<S> = CommandCtx & {state: S, roles: readonly string[]}

export type tServiceCommand<S> = {
    /**
     * Declarative input shape (./input-schema): validated automatically BEFORE
     * validate(), the source of the inferred input type (via schemaCommand) and
     * of the JSON Schema body in the OpenAPI document. Absent = no schema step.
     */
    input?: tInputSchema
    /**
     * Cross-field/domain rules; shape rules belong in `input`. Throw on bad
     * input BEFORE any effect; a throw commits nothing. Optional because a
     * command whose whole stateless contract IS the schema has nothing left
     * to check here (state-dependent guards stay at the top of apply).
     */
    validate?: (input: any) => void
    /** Mutate ctx.state; the returned value becomes the client's receipt. */
    apply: (ctx: ServiceCommandCtx<S>, input: any) => unknown
    /**
     * Roles that may call this command; absent = any verified account. Enforced
     * TWICE: pruned from every served facade (RPC-AUTH rule 3) and refused by
     * the authority at execution — a relay asserts nothing. 'system' is the
     * leader's own principal (SYSTEM_ACCOUNT).
     */
    allow?: readonly string[]
    /** This command's own budget per account per rolling minute (on top of the corridor's); system is exempt. */
    limit?: {perMinute: number}
}

/**
 * One read projection of the state, served as its own replay line. 'public'
 * views are derived once per process and served ungated — and then the RAW
 * line is not: a browser sees exactly what the projections show. Role views
 * ride inside the gated facade of matching principals; `project` receives the
 * principal, so "my orders" is one view, one line per session (or `shared`
 * for a projection that ignores the principal: one line per process).
 */
export type tServiceView<S> = {
    allow: 'public' | readonly string[]
    shared?: boolean
    /** Static top-level keys the projection reads; a batch touching none of them is skipped. */
    keys?: readonly string[]
    project: (state: S, principal: tServicePrincipal | null) => object
}

export type tServiceDefinition<
    S extends Record<string, any> = Record<string, any>,
    Cmds extends Record<string, tServiceCommand<S>> = Record<string, tServiceCommand<S>>,
> = {
    /** Wire identity: every surface is served wrapped under this key. */
    name: string
    /** Replica-line coordinates; nodes must match them to join the line. */
    storeId: string
    originId: string
    initial: S
    commands: Cmds
    /** Legacy read policy: ONE anonymous projection served as a plain `view()` call (see `views`). */
    readerFacet?: (state: S) => unknown
    /** Identity above the library: roles from state, credentials → account (the leader is the IdP). */
    access?: {
        /** Roles of an account, from state; absent = no roles, every verified account equal. */
        rolesOf?: (state: S, account: string) => readonly string[]
        /** Credential check served by the LEADER only: the schema documents the form, resolve returns the account or null. */
        login?: {input: tInputSchema, resolve: (state: S, input: any) => string | null}
        /** Self-registration served by the LEADER only: the named command runs as the system principal with the caller's requestId. */
        signup?: {input: tInputSchema, command: string}
    }
    /** Read policy by audience: named projections with allow lists (./access.ts serves them on both corners). */
    views?: Record<string, tServiceView<S>>
    /**
     * Schema version of the state (default 1), written into the archive as `$version`. Bump it
     * together with `migrate`; a restore from an older archive without a migrate() refuses to boot.
     */
    version?: number
    /** Runs ONCE on a restore whose archived version is older: returns the state for THIS version. */
    migrate?: (state: any, fromVersion: number) => S
    /** The corridor budget per account per rolling minute (default 60); the system principal is unlimited. */
    limits?: {perMinute?: number}
}

/** The library command map derived from the definition: validate, then apply on the store. */
type tDomainCommandMap<Cmds extends Record<string, tServiceCommand<any>>> = {
    [K in keyof Cmds & string]: (ctx: CommandCtx, input: Parameters<Cmds[K]['apply']>[1]) => ReturnType<Cmds[K]['apply']>
}

// ============================================================
// shape facts of a definition — what the served fragments look like, at type level
// ============================================================
// The definition is the source of its own type (satisfies keeps the literals),
// so a consumer derives EXACT wire types from it: whether the raw line or the
// public view lines are served ungated, whether login takes credentials, and
// which view lines a principal may follow — no handwritten client interface.

export type tDefinitionState<D> = D extends {initial: infer S extends Record<string, any>} ? S : never
export type tDefinitionCommands<D> = D extends {commands: infer C extends Record<string, tServiceCommand<any>>} ? C : never
export type tHasViews<D> = D extends {views: Record<string, any>} ? true : false
export type tHasLogin<D> = D extends {access: {login: {input: any}}} ? true : false
export type tHasSignup<D> = D extends {access: {signup: {input: any}}} ? true : false
type tViewLine<V> = V extends {project: (...args: any[]) => infer P extends object} ? StoreReplayRemote<P> : never
/** The public view lines (allow 'public'), typed by their projections. */
export type tPublicViewLines<D> = D extends {views: infer V extends Record<string, tServiceView<any>>}
    ? {[K in keyof V as V[K]['allow'] extends 'public' ? K : never]: tViewLine<V[K]>} : {}
/** Every view line a principal MAY be served; which ones are present is decided by roles at runtime. */
export type tPrincipalViewLines<D> = D extends {views: infer V extends Record<string, tServiceView<any>>}
    ? {[K in keyof V]: tViewLine<V[K]>} : {}
type tLegacyView<D> = D extends {readerFacet: (state: any) => infer R} ? {view: () => R} : {}
type tMinted = {token: string, account: string, expiresAt?: number}
/** The identity port of the ungated surface: credentials in when the definition declares a login. */
export type tIdentityFragment<D, Base extends {renew: (...args: any[]) => any}> = tHasLogin<D> extends true
    ? {login: (credentials: unknown) => tMinted, renew: Base['renew']} & (tHasSignup<D> extends true ? {signup: (requestId: string, input: unknown) => Promise<unknown>} : {})
    : Base
/** The gated facade of one principal: pruned commands, roles, the allowed view lines. */
export type tPrincipalFacade<D, C, R> = {whoami: () => string, me: () => tServicePrincipal, commands: C}
    & (R extends () => unknown ? {revoke: R} : {})
    & (tHasViews<D> extends true ? {views: tPrincipalViewLines<D>} : {})

// ============================================================
// the leader factory
// ============================================================

export type ServiceLeaderDeps<D extends tServiceDefinition<any, any>> = {
    definition: D
    /** Client-reachable origin of the leader process; read lazily (the port binds late). */
    selfUrl: () => string
    /**
     * Corridor secrets; per-run random by default. The ENTRYPOINT pins them
     * from env when node processes must join across leader restarts —
     * cryptography stays a host concern, this layer only consumes the strings.
     */
    secrets?: {nodeToken?: string, tokenSecret?: string}
    /**
     * The storage seam of the authority line (ROADMAP §6.3): present = the state
     * survives a restart and the seq space continues; the archive is the host's
     * (fs, memory, a DB adapter of the ReplayStorage port). Receipts and the
     * roster are NOT on it — they survive through a standby, not through storage.
     */
    durable?: ScaleDurableLine
    /**
     * The CONTROL line's archive (receipts + deny list): with it a solo restart answers an
     * acknowledged requestId with its receipt instead of executing again; the roster is wiped
     * on restore (nodes re-register). Same port as `durable`, a separate archive.
     */
    durableControl?: ScaleDurableLine
    log?: (line: string) => void
}

// these keys gate the write corridor (HMAC signing secret, node-link trust):
// they must come from the CSPRNG, never from the predictable Math.random()
function randomKey(prefix: string) {
    return prefix + '-' + randomBytes(32).toString('base64url')
}

export function createServiceLeader<D extends tServiceDefinition<any, any>>(deps: ServiceLeaderDeps<D>) {
    type S = tDefinitionState<D>
    type Cmds = tDefinitionCommands<D>
    const {definition} = deps
    const commands = definition.commands as Cmds
    // the Store ADOPTS the object it is given (no copy): a module-level definition passed to two
    // leaders in one process would share live state — every leader starts from its own clone
    const initial = cloneStoreValue(definition.initial) as S
    // per-run trust for node links; the entrypoint hands it to node processes through env
    const nodeToken = deps.secrets?.nodeToken ?? randomKey('node')
    // shared secret of the write corridor: every node verifies client tokens itself
    const tokenSecret = deps.secrets?.tokenSecret ?? randomKey('auth')
    const codec = createTokenCodec({secret: tokenSecret})

    // ============== definition + secrets → authority deps: the WHOLE mapping ==============
    // Validation runs before apply so a refused input never touches the store
    // and the corridor remembers nothing for it (honest retry). The schema step
    // (when declared) runs FIRST — shape refusals share the same no-effect
    // guarantee as validate() throws. ctx.state binds LATE to the authority's
    // own replica store: commands only run after createAuthority has returned.
    function rolesOf(account: string): readonly string[] {
        if (account == SYSTEM_ACCOUNT) return ['system']
        return definition.access?.rolesOf?.(authority.line.control.store.snapshot(), account) ?? []
    }
    // per-command budgets: one rolling window per (account, command); the corridor's own
    // per-account budget (definition.limits) is enforced by the command host underneath
    const commandWindows = createRateWindow()
    function domainCommands() {
        const map = {} as tDomainCommandMap<Cmds>
        for (const name of Object.keys(commands) as (keyof Cmds & string)[]) {
            const command = commands[name] as tServiceCommand<S>
            const schemaValidate = command.input ? buildInputValidate(command.input) : null
            map[name] = function runDomainCommand(ctx: CommandCtx, input: any) {
                // the role is refused HERE, at the single point of order, whatever hop the call took
                const roles = rolesOf(ctx.account)
                if (command.allow && !command.allow.some(role => roles.includes(role))) {
                    throw new Error(`forbidden: ${name} needs one of: ${command.allow.join(', ')}`)
                }
                if (command.limit && ctx.account != SYSTEM_ACCOUNT) {
                    const key = ctx.account + ':' + name
                    if (commandWindows.sumWeight(key, 60_000) >= command.limit.perMinute) {
                        throw new Error(`rate limit: ${name} allows ${command.limit.perMinute} per minute — retry later`)
                    }
                    commandWindows.add({type: key, weight: 1})
                }
                schemaValidate?.(input)
                command.validate?.(input)
                return command.apply({...ctx, roles, state: authority.line.control.store.state}, input)
            } as tDomainCommandMap<Cmds>[typeof name]
        }
        return map
    }

    const authority = createAuthority<S, tDomainCommandMap<Cmds>>({
        line: {
            storeId: definition.storeId,
            originId: definition.originId,
            // the old wiring's coordinates, pinned: the row is 'leader' at weight 1 —
            // the leader owns the writes, readers should prefer the nodes
            nodeId: 'leader',
            lineId: definition.name + '-leader',
            initial,
            ...(deps.durable ? {durable: deps.durable} : {}),
        },
        ...(deps.durableControl ? {control: {durable: deps.durableControl}} : {}),
        roster: {url: deps.selfUrl, weight: 1},
        corridor: {
            commands: domainCommands(),
            // visitors share the definition's budget; the host's own principal (webhooks, effect
            // outcomes) is unlimited — replay/command-host-budget.test.ts
            limits: {perMinute: definition.limits?.perMinute ?? 60, budgetOf: account => account == SYSTEM_ACCOUNT ? Infinity : definition.limits?.perMinute ?? 60},
        },
        identity: {
            issue: function issueCodecToken(account: string) {
                return codec.issue({sub: account})
            },
            verify: function verifyCodecToken(presented: unknown) {
                const verdict = codec.verify(presented)
                if (!verdict.ok) throw new Error('token rejected: ' + verdict.reason)
                // the host principal is never a token
                if (verdict.claims.sub == SYSTEM_ACCOUNT) throw new Error('token rejected: reserved account')
                return {account: verdict.claims.sub, expiresAt: verdict.claims.exp}
            },
        },
        ...(deps.log ? {log: deps.log} : {}),
    })

    // ============== the archive's schema version: migrate ONCE on an older restore ==============
    // `$version` rides inside the state (so it is in every keyframe and every archive); views
    // never project it. A newer definition over an older archive runs migrate() before anything
    // is served; without a migrate() the boot refuses — a silent shape mismatch is worse.
    try {
        const store = authority.line.control.store
        const version = definition.version ?? 1
        const restored = authority.view.restored()
        const archived = (store.state as Record<string, unknown>)['$version'] as number | undefined
        if (restored?.fromArchive && (archived ?? 1) < version) {
            if (!definition.migrate) {
                throw new Error(`${definition.name}: the archive is at schema version ${archived ?? 1}, the definition at ${version}, and no migrate() is declared`)
            }
            // Read and detach the whole result before deleting any archived fields.
            const next = cloneStoreValue(definition.migrate(store.snapshot(), archived ?? 1)) as Record<string, unknown>
            const state = store.state as Record<string, unknown>
            for (const key of Object.keys(state)) if (!(key in next) && key != '$version') delete state[key]
            for (const [key, value] of Object.entries(next)) if (key != '$version') state[key] = value
            state['$version'] = version
            deps.log?.(`${definition.name}: migrated the archive from schema version ${archived ?? 1} to ${version}`)
        } else if (archived == undefined) {
            (store.state as Record<string, unknown>)['$version'] = version
        }
    } catch (error) {
        // A failed migration never hands its already allocated authority to a caller.
        try { authority.close() } catch { /* Preserve the startup error. */ }
        throw error
    }

    // ============== the read policy: the ONE piece the authority does not own ==============
    // ./access.ts derives the declared views from the authority's own store and
    // prunes the command facade by role — the same shaper every node runs on
    // its mirror, so a client cannot tell the corners apart
    const access = createServiceAccess<D>({definition, store: authority.line.control.store})
    function readerView() {
        return definition.readerFacet?.(authority.line.control.store.state)
    }
    const legacyView = (definition.readerFacet ? {view: readerView} : {}) as tLegacyView<D>
    type Base = typeof authority

    /** Credential login (the leader is the IdP): the schema validates the form, resolve names the account. */
    function loginWith(credentials: unknown) {
        const login = definition.access?.login
        if (!login) throw new Error('this service has no credential login')
        buildInputValidate(login.input)(credentials)
        const account = login.resolve(authority.line.control.store.snapshot(), credentials)
        if (!account || account == SYSTEM_ACCOUNT) throw new Error('login refused')
        return authority.identity.login(account)
    }

    /** Self-registration (the leader is the IdP): the schema validates the form, the named command creates the account as `system`. */
    function signupWith(requestId: string, input: unknown) {
        const signup = definition.access?.signup
        if (!signup) throw new Error('this service has no signup')
        buildInputValidate(signup.input)(input)
        return authority.corridor.execute(SYSTEM_ACCOUNT, signup.command, requestId, input)
    }

    type BrowserBase = ReturnType<Base['serve']['browser']>
    type ReaderBase = ReturnType<Base['serve']['reader']>
    type Identity = tIdentityFragment<D, BrowserBase['identity']>
    type BrowserFragment = (tHasViews<D> extends true
        ? {roster: BrowserBase['roster'], identity: Identity, views: tPublicViewLines<D>}
        : Omit<BrowserBase, 'identity'> & {identity: Identity}) & tLegacyView<D>
    type ReadFragment = (tHasViews<D> extends true ? {views: tPublicViewLines<D>} : ReaderBase) & tLegacyView<D>

    /** Participant surface (ungated): roster + identity, and the public views — the raw line only without views. */
    function browserFragment(account: string): BrowserFragment {
        const base = authority.serve.browser(account)
        const identity = definition.access?.login
            ? {login: loginWith, renew: base.identity.renew, ...(definition.access.signup ? {signup: signupWith} : {})}
            : base.identity
        const views = access.publicViews()
        if (views) return {roster: base.roster, identity, views, ...legacyView} as unknown as BrowserFragment
        return {...base, identity, ...legacyView} as unknown as BrowserFragment
    }

    /** Lean ungated read surface: the leader AS a node, shape-identical to a node's. */
    function readFragment(): ReadFragment {
        const views = access.publicViews()
        if (views) return {views, ...legacyView} as unknown as ReadFragment
        return {...authority.serve.reader(), ...legacyView} as unknown as ReadFragment
    }

    /** The gated write connection, shaped per principal (roles, pruned commands, view lines). */
    function scaleConnection() {
        return authority.serve.connection({principal: access.principal})
    }

    /** Drain is DATA: the node sees its own row draining and leaves by itself. */
    function drain(nodeId: string) {
        if (nodeId == 'leader') throw new Error('the leader cannot drain itself')
        return {ok: authority.roster.control.drain(nodeId)}
    }

    return {
        /** Per-run corridor secrets; the entrypoint hands them to node processes through env. */
        secrets: {nodeToken, tokenSecret},
        // the authority facets, retransmitted whole — the honest addressing system
        line: authority.line,
        roster: authority.roster,
        identity: authority.identity,
        /** The write corridor; a REST relay serves corridor.byToken() verbatim.
         *  `system` is the leader's own principal: commands the host runs itself (signup, webhooks). */
        corridor: {...authority.corridor, system: authority.corridor.fragment(SYSTEM_ACCOUNT)},
        /** Read policy and rights, the same shaper the nodes run: rights(), snapshot(view, principal), principalOf(). */
        access,
        control: {start: authority.start, drain, revoke: authority.identity.revoke, close() { access.close(); authority.close() }},
        /** Connection surfaces by audience; the entrypoint binds each to its socket key. */
        serve: {
            browserFragment,
            readFragment,
            scaleConnection,
            nodeLinkFragment: authority.serve.nodeLink,
            /** Credential login for a REST relay; throws 'login refused'. */
            login: loginWith,
            /** Self-registration for a REST relay: (requestId, input) → the signup command's receipt. */
            signup: signupWith,
        },
        view: {
            ...authority.view,
            commandNames: authority.corridor.names,
            /** Host-side raw snapshot; wire surfaces serve the projections. */
            state: () => authority.line.control.store.state,
            reader: readerView,
        },
    }
}
export type ServiceLeader<D extends tServiceDefinition<any, any> = tServiceDefinition<any, any>> = ReturnType<typeof createServiceLeader<D>>

// ============================================================
// the leader PROCESS entrypoint — day 1 of a service is THIS process alone
// ============================================================
// An authority with zero nodes is a deployment: it serves the readers itself
// and the cluster client places on the leader row; nodes added later (npm run
// node, with the env this process prints) take readers over by weight, and
// nothing above changes (ROADMAP §6.1). Mirrors node.ts: env, transports, the
// socket keys per audience ('app' ungated read, 'scale' gated write,
// 'node-link' for connections that presented the node token) and exit live
// here — the factory above owns none of them.

export type LeaderProcessDeps<D extends tServiceDefinition<any, any>> = {
    definition: D
    /** Defaults to process.env: SERVICE_PORT, the corridor secrets, CORS, SERVICE_PRINT_JOIN_ENV. */
    env?: tEnv
    /** Mount the REST/OpenAPI/panel surface (default true); SERVICE_REST=0 disables it too. */
    rest?: boolean
    /** The durable line; defaults to SERVICE_DATA_DIR (one JSONL archive per service) when that env is set. */
    durable?: ScaleDurableLine
    /** The control line's archive; defaults to SERVICE_DATA_DIR too (`<name>.control.jsonl`). */
    durableControl?: ScaleDurableLine
    /** Extra host wiring over the express app and the leader (a product's own pages, webhooks). */
    mount?: (host: {app: express.Express, leader: ServiceLeader<D>, url: () => string}) => void
}

/**
 * The leader PROCESS from a definition: env → transports → factory → REST → signals.
 * Exported so an example or a product runs the unchanged process around its own
 * definition; `leader.ts` executed directly runs it around ./service.
 */
export async function runLeaderProcess<D extends tServiceDefinition<any, any>>(deps: LeaderProcessDeps<D>) {
    const serviceDefinition = deps.definition
    const processEnv = deps.env ?? process.env
    const env = leaderEnv(processEnv)
    const name = serviceDefinition.name
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer, {
        // the origins are known only once the port is bound; corsOrigins reads them lazily
        cors: {origin: (origin, decide) => decide(null, allowOrigin(origin)), methods: ['GET', 'POST']},
    })
    let url = ''
    function allowOrigin(origin: string | undefined) {
        const allowed = corsOrigins(processEnv, url ? [url] : [])
        return allowed === true || origin == undefined || allowed.includes(origin)
    }

    // day N: SERVICE_DATA_DIR turns the line AND the control line durable — nothing else changes
    let durable = deps.durable
    let durableControl = deps.durableControl
    if (env.dataDir) {
        mkdirSync(env.dataDir, {recursive: true})
        durable ??= {storage: openFsReplayStorage(path.join(env.dataDir, name + '.jsonl'))}
        durableControl ??= {storage: openFsReplayStorage(path.join(env.dataDir, name + '.control.jsonl'))}
    }
    const leader = createServiceLeader<D>({
        definition: serviceDefinition, selfUrl: () => url, secrets: env.secrets,
        ...(durable ? {durable} : {}), ...(durableControl ? {durableControl} : {}),
    })

    // the HTTP face: views, commands, login, OpenAPI, Swagger UI and the generic role panel —
    // every service gets it from the definition, a product mounts its own pages beside it
    const rest = deps.rest != false && processEnv['SERVICE_REST'] != '0'
        ? createServiceRest<D>({app, leader, definition: serviceDefinition})
        : null
    deps.mount?.({app, leader, url: () => url})

    ioServer.on('connection', function onLeaderConnection(socket) {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const [gone, goneListen] = listen<[]>()

        // the node link: only for connections that presented the node token, bound to the claimed id
        if (auth?.role == 'service-node') {
            const nodeId = String(auth?.node ?? '')
            if (!nodeId || auth?.token != leader.secrets.nodeToken) {
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

        // ungated participant surface: the line, the roster projection, identity, the read view
        createRpcServerAuto({
            socket,
            socketKey: 'app',
            object: {[name]: leader.serve.browserFragment(String(auth?.account ?? 'anonymous'))},
            disconnectListen: goneListen,
        })
    })

    const port = await new Promise<number>(function listenForClients(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(env.port ?? 0, function bound() { resolve((httpServer.address() as any).port) })
    })
    url = 'http://localhost:' + port
    leader.control.start()
    const restored = leader.view.restored()
    if (restored) console.log(`[${name}] durable line at seq ${restored.seq}${restored.fromArchive ? ', restored from the archive' : ', fresh archive'}`)
    if (restored?.control) console.log(`[${name}] control line (receipts, deny list) at seq ${restored.control.seq}${restored.control.fromArchive ? ', restored from the archive' : ', fresh archive'}`)
    console.log(`[${name}] leader listening on ${url}`)
    if (rest) console.log(`[${name}]   panel: ${url}/panel   docs: ${url}/docs   openapi: ${url}/openapi.json`)
    console.log(`[${name}] a node joins with: SERVICE_UPSTREAM=${url} SERVICE_NODE_ID=<id> and the two corridor secrets of this run`)
    // the secrets are printed ONLY on request: a log line is not a secret store
    if (processEnv['SERVICE_PRINT_JOIN_ENV'] == '1') {
        console.log(`SERVICE_NODE_TOKEN=${leader.secrets.nodeToken}`)
        console.log(`SERVICE_TOKEN_SECRET=${leader.secrets.tokenSecret}`)
    }

    function shutdown(signal: string) {
        console.log(`[${name}] ${signal} — closing`)
        leader.control.close()
        ioServer.close()
        httpServer.close()
        setTimeout(function exitNow() { process.exit(0) }, 200)
    }
    process.once('SIGTERM', function onSigterm() { shutdown('SIGTERM') })
    process.once('SIGINT', function onSigint() { shutdown('SIGINT') })
    return {leader, url, rest, app, httpServer, shutdown}
}

// Importable module + runnable entrypoint: the process runs only when this file is
// executed directly (self-check and node.ts import the factory and the contract).
if (require.main == module) {
    import('./service').then(function runAroundService({serviceDefinition}) {
        return runLeaderProcess({definition: serviceDefinition})
    }).catch(function fatal(error) {
        console.error(error)
        process.exit(2)
    })
}
