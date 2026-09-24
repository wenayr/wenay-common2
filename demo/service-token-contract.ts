// =====================================================================
// Service tokens stand — the vocabulary shared by the host, the client module and the panel
// =====================================================================
// The host owns behavior; this file owns the names both halves agree on: the socket role and
// keys, the stand's HTTP routes, the demo credentials the panel shows, the public-stand bounds,
// and the wire types — derived from the definitions and the leader, never handwritten.

import type {ServiceLeader} from '../src/service/leader'
import type {boardDefinition, deskDefinition} from './service-token-host'

/** Handshake role the stand routes to a sandbox's service leaders. */
export const serviceTokenRole = 'service-token'

/** Service names: each is the wrap key of everything its leader serves. */
export const serviceTokenServices = {board: 'board', desk: 'desk'} as const
export type tServiceTokenService = keyof typeof serviceTokenServices

/** Socket keys, as the shipped leader host binds them: ungated participant surface, gated write surface. */
export const serviceTokenKeys = {app: 'app', scale: 'scale'} as const

/** The stand's own HTTP port: sandbox, the application's login, the operator's revoke. */
export const serviceTokenRoutes = {base: '/service-tokens', sandbox: '/sandbox', login: '/login', revoke: '/revoke'} as const

/** Demo credentials, shown on the panel on purpose: they open only the visitor's own sandbox. */
export const serviceTokenCredentials = {owner: 'owner-pass', member: 'member-pass'} as const
export type tServiceTokenAccount = keyof typeof serviceTokenCredentials

/** Public-stand bounds; the panel shows them to the human. */
export const serviceTokenLimits = {
    /** Live sandboxes; when full, the least recently used one without sockets is evicted. */
    maxSandboxes: 24,
    /** Sandbox openings per minute, across all visitors. */
    opensPerMinute: 30,
    /** A sandbox without sockets closes after this long without a call. */
    sandboxIdleMs: 10 * 60_000,
    /** Hard lifetime of a sandbox, busy or not. */
    sandboxMaxAgeMs: 30 * 60_000,
    socketsPerSandbox: 6,
    /** Per sandbox: HTTP calls, identity calls and token presentations share one budget. */
    callsPerMinute: 60,
    maxNotes: 12,
    noteChars: 80,
} as const
export type tServiceTokenLimits = {[K in keyof typeof serviceTokenLimits]: number}

// ============== wire types: derived from the leader and the definitions ==============

type tLeaderOf<S extends tServiceTokenService> = S extends 'board'
    ? ServiceLeader<typeof boardDefinition>
    : ServiceLeader<typeof deskDefinition>
type tPrincipalOf<L extends {serve: {scaleConnection: () => {auth: {resolveAuth: (token: unknown) => {object: unknown}}}}}> =
    ReturnType<ReturnType<L['serve']['scaleConnection']>['auth']['resolveAuth']>['object']

/** What each socket key serves, wrapped by the service name like the leader host wraps it. */
export type ServiceTokenWire<S extends tServiceTokenService> = {
    /** Ungated: roster, identity ({renew} or {login, renew}) and the public views. */
    app: {[K in S]: ReturnType<tLeaderOf<S>['serve']['browserFragment']>}
    /** Gated: {} until a verified HELLO, then the principal's facade (me, pruned commands, views). */
    scale: {[K in S]: tPrincipalOf<tLeaderOf<S>>}
}

/** Reply of the stand's sandbox route: the id is the visitor's capability, sent to nobody else. */
export type ServiceTokenSandboxReply = {sandbox: string, expiresAt: number, idleMs: number}

/** Reply of the stand's login: the leader's own issuance, plus whether it lifted a revocation. */
export type ServiceTokenLoginReply = ReturnType<tLeaderOf<'board'>['identity']['login']> & {liftedRevocation: boolean}

/** Reply of the operator's revoke: the leader's own answer. */
export type ServiceTokenRevokeReply = ReturnType<tLeaderOf<'board'>['control']['revoke']>

/** Every refused stand route answers this body with its HTTP status. */
export type ServiceTokenRefusal = {error: string}
