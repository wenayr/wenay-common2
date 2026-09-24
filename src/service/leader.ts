import {randomBytes} from 'crypto'
import type {CommandCtx} from '../Common/command/command-host'
import {createAuthority} from '../Common/scale/scale-authority'
import type {ScaleDurableLine} from '../Common/scale/scale-authority'
import {createRateWindow} from '../Common/funcTimeWait'
import {cloneStoreValue} from '../Common/Observe/store'
import {createTokenCodec} from '../server/auth-token'
import {createServiceAccess} from './access'
import {buildInputValidate} from './input-schema'
import {listen} from '../Common/events/Listen'
import {createResourceSession, type ServiceResourceDiagnostic} from './resource-session'
import type {ServiceResourceOptions} from './resource-definition'
import {resourceBudgets} from './resource-budget'
import {inheritRpcScopes} from '../Common/rcp/rpc-scope'
import type {RpcServerControl} from '../Common/rcp/rpc-server'

import {SYSTEM_ACCOUNT, type tServiceDefinition, type tDefinitionState, type tDefinitionCommands, type tServiceCommand, type tIdentityFragment, type tHasViews, type tPublicViewLines} from './definition'

type tDomainCommandMap<Cmds extends Record<string, tServiceCommand<any>>> = {
    [K in keyof Cmds & string]: (ctx: CommandCtx, input: Parameters<Cmds[K]['apply']>[1]) => ReturnType<Cmds[K]['apply']>
}
type tLegacyView<D> = D extends {readerFacet: (state: any) => infer R} ? {view: () => R} : {}

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
    resourceOptions?: ServiceResourceOptions
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
    resourceBudgets(deps.resourceOptions)
    for (const resource of Object.values(definition.resources ?? {})) {
        if (resource.placement != 'authority') throw new Error('Only authority resource placement is supported')
    }
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
    const [emitResourceError, resourceErrors] = listen<[ServiceResourceDiagnostic]>()
    const resourceConnections = new Set<ReturnType<typeof resourceConnection>>()
    function resourceConnection() {
        const owned = createResourceSession({registry: definition.resources ?? {}, options: deps.resourceOptions,
            principalOf: access.principalOf,
            changes: callback => authority.line.control.store.on(callback), report: emitResourceError,
        })
        const link = authority.serve.connection({principal: owned.update})
        let completion: Promise<void> | undefined
        function close() {
            if (completion) return completion
            completion = owned.close()
            link.close()
            resourceConnections.delete(connection)
            return completion
        }
        const hooks = inheritRpcScopes(owned.hooks, {onDispose() { void close().catch(function observed() {}) }})
        function attach(control: RpcServerControl) {
            link.attach({...control, revoke(...args: Parameters<RpcServerControl['revoke']>) {
                owned.suspend()
                return control.revoke(...args)
            }})
        }
        const connection = {...link, hooks, attach, close}
        resourceConnections.add(connection)
        return connection
    }
    function closeResources() {
        const work = [...resourceConnections].map(connection => connection.close())
        return Promise.allSettled(work).then(function finished(results) {
            const errors = results.filter(result => result.status == 'rejected').map(result => result.reason)
            if (errors.length) throw new AggregateError(errors, 'Service resources cleanup failed')
        })
    }
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

    /** Participant surface (ungated): roster + identity, and the public views — the raw line only without views.
     *  Anyone can reach it, so its identity mints only from credentials (access.login) and otherwise
     *  only renews a live token. `_account` is ignored: an ungated surface has no verified account. */
    function browserFragment(_account?: string): BrowserFragment {
        // the authority's bound login(account) is a host-side verb; it never rides this surface
        const {identity: {renew}, ...base} = authority.serve.browser('anonymous')
        const identity = definition.access?.login
            ? {login: loginWith, renew, ...(definition.access.signup ? {signup: signupWith} : {})}
            : {renew}
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
        resources: {errors: resourceErrors},
        control: {start: authority.start, drain, revoke: authority.identity.revoke, close() {
            const finished = closeResources()
            access.close()
            authority.close()
            void finished.catch(function observed() {})
            return finished
        }},
        /** Connection surfaces by audience; the entrypoint binds each to its socket key. */
        serve: {
            browserFragment,
            readFragment,
            scaleConnection,
            resourceConnection,
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
