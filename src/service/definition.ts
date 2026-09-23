import type {CommandCtx} from '../Common/command/command-host'
import type {StoreReplayRemote} from '../Common/Observe/store-replay'
import type {tInputSchema} from './input-schema'
import type {ServiceResourceDefinition} from './resource-definition'

/** A verified principal as the definition sees it: the account plus its roles FROM STATE. */
export type tServicePrincipal = {account: string, roles: readonly string[]}
export type ServicePermissions = tServicePrincipal & {views: string[], commands: string[], resources?: string[]}

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
 * principal, so "my orders" is one view, one line per session. `shared`
 * ignores the principal for content, but retains a per-session access boundary.
 */
export type tServiceView<S> = {
    allow: 'public' | readonly string[]
    shared?: boolean
    /** Public projection optimization. Role views also depend on current access and recheck every batch. */
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
    /** Static, authority-owned factories; opened independently by each authenticated controller. */
    resources?: Record<string, ServiceResourceDefinition>
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
type tMinted = {token: string, account: string, expiresAt?: number}
/** The identity port of the ungated surface: credentials in when the definition declares a login. */
export type tIdentityFragment<D, Base extends {renew: (...args: any[]) => any}> = tHasLogin<D> extends true
    ? {login: (credentials: unknown) => tMinted, renew: Base['renew']} & (tHasSignup<D> extends true ? {signup: (requestId: string, input: unknown) => Promise<unknown>} : {})
    : Base
/** The gated facade of one principal: pruned commands, roles, the allowed view lines. */
export type tPrincipalFacade<D, C, R> = {
    whoami: () => string, me: () => ServicePermissions, commands: C,
    permissions: StoreReplayRemote<ServicePermissions>,
}
    & (R extends () => unknown ? {revoke: R} : {})
    & (tHasViews<D> extends true ? {views: tPrincipalViewLines<D>} : {})
