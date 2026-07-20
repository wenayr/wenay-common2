// ============================================================
// Capability negotiation — the single extension point for wire features
// ============================================================
// EVERY negotiable wire optimization registers ONE bit here. Both peers advertise their
// supported bitset once via [Pkt.CAPS, bits]; the EFFECTIVE feature set per side is
// (ownCaps & peerCaps). A feature is used ONLY when present in that intersection.
//
// Additive + backward-compatible BY CONSTRUCTION:
//   • old peer never sends CAPS        → peerCaps stays 0 → no feature (plain JSON wire)
//   • old peer gets an unknown Pkt.CAPS → ignores it (opcode not in its switch)
//   • Caps.COMPACT === 1 === legacy [Pkt.CAPS, 1] payload → byte-identical to before
//
// To add a FUTURE wire feature: (1) add a bit below; (2) add an `opt` key in optToCaps;
// (3) gate its send/handle on hasCap(effective, Caps.X). Nothing else negotiates out-of-band.

export const Caps = {
    COMPACT: 1 << 0,   // adaptive compression of subscription ticks (Pkt.SHAPE/CBV)
    // future: BINARY: 1 << 1, ...
} as const

export type tCaps = number

/** Everything this build can negotiate. */
export const CAPS_ALL: tCaps = Caps.COMPACT

/** Whether capability c is in negotiated bitset. */
export const hasCap = (caps: tCaps, c: number) => (caps & c) === c

/** Intent for connection optimizations. Absent/true = enabled; explicit false = refused. */
export type RpcOpt = {
    /** Adaptive compression of ticks (Pkt.SHAPE/CBV). Enabled by default; false = force plain Pkt.CB. */
    compact?: boolean
}

/** Intent → bitset we ADVERTISE (CAPS_ALL minus what config refused). */
export function optToCaps(opt?: RpcOpt): tCaps {
    let c = CAPS_ALL
    if (opt?.compact === false) c &= ~Caps.COMPACT
    return c
}
