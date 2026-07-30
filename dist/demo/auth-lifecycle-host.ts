// =====================================================================
// Auth lifecycle stand — server half
// =====================================================================
// A real `createTokenCodec` plus the one thing the codec deliberately does not own:
// a revocation list. Login is NOT on this RPC surface — with `gate: true` nothing is
// callable before a HELLO succeeds, so the identity port stays exactly where the
// codec's own header puts it (the application), here behind the stand's HTTP endpoint.
//
// The server distinguishes revocation from an ordinary failed re-auth by ONE thing:
// the thrown value carries `revoke === true`. Everything else thrown keeps the live
// session, so a swept/unknown session below is a plain rejection on purpose.

import {randomUUID} from 'crypto'
import {listen} from '../src/Common/events/Listen'
import {createTokenCodec, type TokenClaims} from '../src/server/auth-token'
import {authLifecycleTimings, type AuthTick} from './auth-lifecycle-contract'

type AuthLifecycleDeps = {
    ttlMs?: number
    renewBeforeMs?: number
    tickMs?: number
    /** Public-stand bounds: demo sessions are cheap, but not free. */
    maxSessions?: number
    sessionTtlMs?: number
}

type DemoSession = {sid: string, createdAt: number, revoked: boolean}

type LoginResult =
    | {ok: true, sid: string, token: string, expiresAt: number}
    | {ok: false, status: number, error: string}

export function createAuthLifecycleHost(deps: AuthLifecycleDeps = {}) {
    const ttlMs = deps.ttlMs ?? authLifecycleTimings.ttlMs
    const renewBeforeMs = deps.renewBeforeMs ?? authLifecycleTimings.renewBeforeMs
    const tickMs = deps.tickMs ?? authLifecycleTimings.tickMs
    const maxSessions = deps.maxSessions ?? 500
    const sessionTtlMs = deps.sessionTtlMs ?? 30 * 60_000
    // One secret per process: this stand mints and verifies its own tokens, nothing else does.
    const codec = createTokenCodec({secret: randomUUID(), ttlMs})
    const sessions = new Map<string, DemoSession>()
    let issuedSessions = 0

    // ============== login: the application's own identity port ==============

    function sweepSessions() {
        const now = Date.now()
        for (const [sid, session] of sessions) {
            if (now - session.createdAt > sessionTtlMs) sessions.delete(sid)
        }
    }

    function mint(session: DemoSession): LoginResult {
        const token = codec.issue({sub: 'demo-member', sid: session.sid})
        // Read the deadline back out of the token instead of recomputing it: the grant
        // handed to RPC must be the token's own `exp`, not a second, drifting clock.
        const verdict = codec.verify(token)
        if (!verdict.ok) return {ok: false, status: 500, error: 'freshly issued token did not verify'}
        return {ok: true, sid: session.sid, token, expiresAt: verdict.claims.exp}
    }

    /** Fresh session when `requestedSid` is empty; renewal of an existing one otherwise. */
    function login(requestedSid: unknown): LoginResult {
        sweepSessions()
        if (typeof requestedSid == 'string' && requestedSid) {
            const existing = sessions.get(requestedSid)
            if (!existing) return {ok: false, status: 404, error: 'demo session is unknown or expired'}
            if (existing.revoked) return {ok: false, status: 403, error: 'demo session was revoked — log in again'}
            return mint(existing)
        }
        if (sessions.size >= maxSessions) return {ok: false, status: 429, error: 'demo auth stand is full — try again later'}
        const session = {sid: 'auth-session-' + (++issuedSessions), createdAt: Date.now(), revoked: false}
        sessions.set(session.sid, session)
        return mint(session)
    }

    // ============== per-connection principals ==============

    function connection() {
        // ONE Listen identity for the whole connection: every principal build exposes this
        // same node, so a renewal keeps the subscription and only a DOWNGRADE ends it.
        const [emitTick, ticks] = listen<[AuthTick]>()
        let ticker: ReturnType<typeof setInterval> | null = null
        let tick = 0
        let reads = 0

        // The stream costs a timer, so it starts at the first successful grant rather
        // than at connect: a tab that never logs in never pays for it.
        function ensureTicker() {
            if (ticker) return
            ticker = setInterval(function emitAuthTick() { emitTick({n: ++tick, at: Date.now()}) }, tickMs)
            ticker.unref?.()
        }

        function verifyPresented(token: unknown) {
            const verdict = codec.verify(token)
            // Malformed / bad signature / expired: a transient rejection. The live session
            // survives it, exactly as an ordinary failed re-auth always has.
            if (!verdict.ok) throw new Error('token rejected: ' + verdict.reason)
            // `sid` is an application claim, so it arrives through the codec's open map.
            const claimed = verdict.claims['sid']
            const sid = typeof claimed == 'string' ? claimed : ''
            const session = sessions.get(sid)
            if (!session) throw new Error('demo session is unknown or expired')
            // The ONE rejection that kills a live session — and the only one the server
            // reports as 'revoked'.
            if (session.revoked) throw Object.assign(new Error('session revoked by its owner'), {revoke: true})
            return {claims: verdict.claims, sid}
        }

        function principal(claims: TokenClaims, sid: string) {
            return {
                whoami: () => claims.sub + ' · ' + sid,
                ticks,
                secret: () => 'privileged payload #' + (++reads) + ' for ' + claims.sub,
                revoke() {
                    const session = sessions.get(sid)
                    if (session) session.revoked = true
                    return {revoked: true as const, sid}
                },
            }
        }

        function vault(claims: TokenClaims) {
            return {
                read: () => ({
                    entries: ['ledger-1 · ' + claims.sub, 'ledger-2 · sealed', 'ledger-3 · sealed'],
                    readAt: Date.now(),
                }),
            }
        }

        function grantFor<T>(token: unknown, build: (claims: TokenClaims, sid: string) => T) {
            const {claims, sid} = verifyPresented(token)
            ensureTicker()
            return {
                object: build(claims, sid),
                ack: {ok: true, who: claims.sub, sid, expiresAt: claims.exp},
                // The RPC deadline IS the token deadline: one clock, one exit.
                expiresAt: claims.exp,
                renewBeforeMs,
            }
        }

        function close() {
            if (ticker) clearInterval(ticker)
            ticker = null
            ticks.close()
        }

        // Ready-made createRpcServerAuto blocks: anonymous starting object + gated resolveAuth.
        return {
            session: {
                // Anonymous facade: no stream, no privileged call, no revocation.
                object: {whoami: () => 'anonymous'},
                auth: {resolveAuth: (token: unknown) => grantFor(token, principal), gate: true},
            },
            vault: {
                object: {},
                auth: {resolveAuth: (token: unknown) => grantFor(token, vault), gate: true},
            },
            close,
        }
    }

    return {
        /** Commands inward: the stand's HTTP login endpoint is the only caller. */
        control: {login},
        connection,
        close() { sessions.clear() },
    }
}

export type AuthLifecycleHost = ReturnType<typeof createAuthLifecycleHost>
