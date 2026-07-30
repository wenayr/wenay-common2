// =====================================================================
// Session token codec — the runnable default behind `resolveAuth` (node-only)
// =====================================================================
// THIS IS NOT A JWT, and the following are non-goals on purpose:
//   - no `alg` header and no algorithm negotiation — that is the `alg:none`
//     family of bugs; the algorithm is pinned by the `v1` format tag alone;
//   - no key rotation registry, no revocation/deny list, no refresh flow;
//   - no identity provider — passwords, OAuth/OIDC and user stores stay in the
//     application layer, which is the only place that knows who a `sub` is.
// It exists so that RPC in-band auth (Pkt.HELLO -> auth.resolveAuth(token)) has
// one honest working default for docs, demo and tests: one secret, one
// algorithm, one expiry. Anything richer is an application decision.

import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto'

/** Verified payload. Codec-owned fields are typed; caller claims stay open. */
export type TokenClaims = {sub: string, exp: number, jti: string} & {[claim: string]: unknown}

/** Caller input: `sub` plus any application claims. `exp`/`jti` are minted, never accepted. */
export type IssueClaims = {sub: string}

export type tTokenFailure = 'malformed' | 'signature' | 'expired'

export type tTokenVerdict =
    | {ok: true, claims: TokenClaims}
    | {ok: false, reason: tTokenFailure}

// Structural, so `node:crypto` stays a default rather than a requirement
// (same DI spirit as createSignatureFunction, which never imports its hmac).
type tHmacCreator = (algorithm: string, key: string) => {
    update: (data: string) => {digest: (encoding: 'hex') => string}
}

export type TokenCodecDeps = {
    secret: string
    /** Default lifetime handed to `issue`; overridable per call. */
    ttlMs?: number
    hmac?: tHmacCreator
    now?: () => number
}

const VERSION = 'v1'
const MAC_ALGORITHM = 'sha256'
// Short by default: this codec has no revocation, so expiry is the only exit.
const DEFAULT_TTL_MS = 15 * 60 * 1000
const NONCE_BYTES = 16
const SEGMENT_CHARSET = /^[A-Za-z0-9_-]+$/

// =====================================================================
// base64url — padless, dependency-free
// =====================================================================

function encodeSegment(bytes: Buffer) {
    return bytes.toString('base64url')
}

function decodeSegment(segment: string) {
    // Buffer's base64url decoder silently drops invalid characters instead of
    // failing, so the shape is asserted here rather than trusted to a decode
    // that cannot report an error.
    if (!SEGMENT_CHARSET.test(segment)) return null
    return Buffer.from(segment, 'base64url')
}

// =====================================================================
// payload contract
// =====================================================================

function readClaims(payloadBytes: Buffer) {
    let parsed: unknown
    try { parsed = JSON.parse(payloadBytes.toString('utf8')) }
    catch { return null }
    if (parsed == null || typeof parsed != 'object') return null
    const claims = parsed as TokenClaims
    if (typeof claims.sub != 'string') return null
    if (typeof claims.jti != 'string') return null
    if (typeof claims.exp != 'number' || !Number.isFinite(claims.exp)) return null
    return claims
}

// =====================================================================
// codec
// =====================================================================

export function createTokenCodec(deps: TokenCodecDeps) {
    const {secret, ttlMs = DEFAULT_TTL_MS, hmac = createHmac, now = Date.now} = deps
    // Fail at construction: a missing secret is a deployment mistake, and every
    // token minted before it is noticed would have to be treated as forged.
    if (typeof secret != 'string' || secret.length == 0) {
        throw new Error('createTokenCodec requires a non-empty secret')
    }

    function macOf(signingInput: string) {
        return Buffer.from(hmac(MAC_ALGORITHM, secret).update(signingInput).digest('hex'), 'hex')
    }

    /** Mints `v1.<base64url(payload)>.<base64url(mac)>`. Throws only on caller error. */
    // Generic, not an index-signature parameter: the caller's own declared claims
    // interface must pass, and an interface has no implicit index signature.
    function issue<T extends IssueClaims>(claims: T, options: {ttlMs?: number} = {}) {
        if (!claims || typeof claims.sub != 'string' || claims.sub.length == 0) {
            throw new Error('createTokenCodec.issue requires a non-empty `sub` claim')
        }
        // Spread first: `exp` and `jti` are the codec's to mint, never the
        // caller's to forge, whatever the caller happened to pass under them.
        const payload = {
            ...claims,
            exp: now() + (options.ttlMs ?? ttlMs),
            jti: encodeSegment(randomBytes(NONCE_BYTES)),
        }
        // The version tag is inside the signed input, so a future `v2` mac can
        // never be replayed as `v1` (and vice versa).
        const body = `${VERSION}.${encodeSegment(Buffer.from(JSON.stringify(payload), 'utf8'))}`
        return `${body}.${encodeSegment(macOf(body))}`
    }

    /** Never throws: garbage arriving from the network is traffic, not an exception. */
    function verify(token: unknown): tTokenVerdict {
        if (typeof token != 'string') return {ok: false, reason: 'malformed'}
        const parts = token.split('.')
        if (parts.length != 3) return {ok: false, reason: 'malformed'}
        const [version, payloadSegment, macSegment] = parts
        if (version != VERSION) return {ok: false, reason: 'malformed'}

        const given = decodeSegment(macSegment)
        // Decoded for shape only — the bytes stay untrusted until the mac holds.
        const payloadBytes = decodeSegment(payloadSegment)
        if (given == null || payloadBytes == null) return {ok: false, reason: 'malformed'}

        const expected = macOf(`${version}.${payloadSegment}`)
        // A sha256 tag is always 32 bytes, so tag length is a public constant of
        // the format and never a function of the secret: returning early on a
        // length mismatch leaks nothing an attacker did not already supply.
        // timingSafeEqual then handles the one comparison that could leak, and
        // it requires equal lengths anyway (it throws otherwise).
        if (given.length != expected.length) return {ok: false, reason: 'signature'}
        if (!timingSafeEqual(given, expected)) return {ok: false, reason: 'signature'}

        // Only past the mac are the bytes ours. Parsing stays defensive: a signed
        // payload that will not parse means our own issuer broke, not an attacker.
        const claims = readClaims(payloadBytes)
        if (claims == null) return {ok: false, reason: 'malformed'}
        if (now() >= claims.exp) return {ok: false, reason: 'expired'}
        return {ok: true, claims}
    }

    return {issue, verify}
}

export type TokenCodec = ReturnType<typeof createTokenCodec>
