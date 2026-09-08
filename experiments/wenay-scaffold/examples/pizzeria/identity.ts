// =====================================================================
// pizzeria identity — password hashing for the accounts section
// =====================================================================
// Identity lives ABOVE the library (doc/INTENT.md): the library verifies
// tokens, the application decides who a `sub` is. This example keeps its
// accounts in the replicated state with a salted scrypt hash — the hash is
// state, so every node can read it, and NO view ever projects it (see the
// `staff` view in service.ts). The helper is example-owned; a product
// swaps it for its identity provider without touching the definition.

import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto'

export type tSecret = {salt: string, hash: string}

export function hashSecret(password: string): tSecret {
    const salt = randomBytes(16).toString('base64url')
    return {salt, hash: scryptSync(password, salt, 32).toString('base64url')}
}

export function verifySecret(secret: tSecret | undefined, password: string) {
    if (!secret || typeof password != 'string') return false
    const given = scryptSync(password, secret.salt, 32)
    const expected = Buffer.from(secret.hash, 'base64url')
    return given.length == expected.length && timingSafeEqual(given, expected)
}
