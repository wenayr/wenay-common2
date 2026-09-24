import {createHash, timingSafeEqual} from 'node:crypto'

function digest(value: string) {
    return createHash('sha256').update(value, 'utf8').digest()
}

/** Constant-time check of a presented shared secret (bearer, fleet token). Only a string can match;
 *  both sides are compared as fixed-width digests, so neither the first differing character nor the
 *  secret's length is observable in the timing. */
export function sameSecret(presented: unknown, expected: string) {
    if (typeof presented != 'string') return false
    return timingSafeEqual(digest(presented), digest(expected))
}
