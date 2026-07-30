"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTokenCodec = createTokenCodec;
const node_crypto_1 = require("node:crypto");
const VERSION = 'v1';
const MAC_ALGORITHM = 'sha256';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const NONCE_BYTES = 16;
const SEGMENT_CHARSET = /^[A-Za-z0-9_-]+$/;
function encodeSegment(bytes) {
    return bytes.toString('base64url');
}
function decodeSegment(segment) {
    if (!SEGMENT_CHARSET.test(segment))
        return null;
    return Buffer.from(segment, 'base64url');
}
function readClaims(payloadBytes) {
    let parsed;
    try {
        parsed = JSON.parse(payloadBytes.toString('utf8'));
    }
    catch {
        return null;
    }
    if (parsed == null || typeof parsed != 'object')
        return null;
    const claims = parsed;
    if (typeof claims.sub != 'string')
        return null;
    if (typeof claims.jti != 'string')
        return null;
    if (typeof claims.exp != 'number' || !Number.isFinite(claims.exp))
        return null;
    return claims;
}
function createTokenCodec(deps) {
    const { secret, ttlMs = DEFAULT_TTL_MS, hmac = node_crypto_1.createHmac, now = Date.now } = deps;
    if (typeof secret != 'string' || secret.length == 0) {
        throw new Error('createTokenCodec requires a non-empty secret');
    }
    function macOf(signingInput) {
        return Buffer.from(hmac(MAC_ALGORITHM, secret).update(signingInput).digest('hex'), 'hex');
    }
    function issue(claims, options = {}) {
        if (!claims || typeof claims.sub != 'string' || claims.sub.length == 0) {
            throw new Error('createTokenCodec.issue requires a non-empty `sub` claim');
        }
        const payload = {
            ...claims,
            exp: now() + (options.ttlMs ?? ttlMs),
            jti: encodeSegment((0, node_crypto_1.randomBytes)(NONCE_BYTES)),
        };
        const body = `${VERSION}.${encodeSegment(Buffer.from(JSON.stringify(payload), 'utf8'))}`;
        return `${body}.${encodeSegment(macOf(body))}`;
    }
    function verify(token) {
        if (typeof token != 'string')
            return { ok: false, reason: 'malformed' };
        const parts = token.split('.');
        if (parts.length != 3)
            return { ok: false, reason: 'malformed' };
        const [version, payloadSegment, macSegment] = parts;
        if (version != VERSION)
            return { ok: false, reason: 'malformed' };
        const given = decodeSegment(macSegment);
        const payloadBytes = decodeSegment(payloadSegment);
        if (given == null || payloadBytes == null)
            return { ok: false, reason: 'malformed' };
        const expected = macOf(`${version}.${payloadSegment}`);
        if (given.length != expected.length)
            return { ok: false, reason: 'signature' };
        if (!(0, node_crypto_1.timingSafeEqual)(given, expected))
            return { ok: false, reason: 'signature' };
        const claims = readClaims(payloadBytes);
        if (claims == null)
            return { ok: false, reason: 'malformed' };
        if (now() >= claims.exp)
            return { ok: false, reason: 'expired' };
        return { ok: true, claims };
    }
    return { issue, verify };
}
