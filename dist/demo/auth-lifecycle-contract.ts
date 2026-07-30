// =====================================================================
// Auth lifecycle stand — the vocabulary shared by the host and the browser
// =====================================================================
// The host owns behavior; this file owns the names the browser stand is typed
// against and the timings both halves show to the human. Two GATED facades share
// one socket and one token provider: that pair is what makes the hub's
// single-flight renewal (two alarms, one provider call) visible instead of implied.

import type {ListenApi} from '../src/Common/events/Listen'

/** Socket keys of the two gated RPC surfaces on the auth-stand connection. */
export const authSocketKeys = {session: 'auth', vault: 'vault'} as const

/** Deliberately short: a human has to watch the whole cycle without waiting. */
export const authLifecycleTimings = {
    /** Token lifetime; the RPC deadline is the token's own `exp`, not a second clock. */
    ttlMs: 8_000,
    /** Lead time of the server's 'expiring' warning — renewal happens 3s before expiry. */
    renewBeforeMs: 3_000,
    /** Privileged stream cadence. */
    tickMs: 500,
} as const

export type AuthTick = {n: number, at: number}

/** What the server puts in `authAck` — the 5th element of Pkt.MAP. */
export type AuthGrantAck = {
    ok: boolean
    who?: string
    sid?: string
    expiresAt?: number
    /** Present only on a downgrade ack: 'expired' | 'revoked'. */
    state?: string
    reason?: string
}

/** Privileged session facade. The anonymous facade has NONE of these members. */
export type AuthSessionRemote = {
    whoami: () => string
    /** Privileged live stream: ONE node identity per connection, so a renewal keeps it. */
    ticks: ListenApi<[AuthTick]>
    /** Privileged call: the anonymous principal cannot reach it at all. */
    secret: () => string
    /** Revocation is an application decision; the wire only carries its effect. */
    revoke: () => {revoked: true, sid: string}
}

/** Second gated facade on the same socket — same token, separate principal build. */
export type AuthVaultRemote = {
    read: () => {entries: string[], readAt: number}
}

/** Reply of the stand's own login endpoint (the identity provider lives in the app). */
export type AuthLoginGrant = {sid: string, token: string, expiresAt: number}
