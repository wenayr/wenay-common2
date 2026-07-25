// ============================================================
// Capability negotiation — the single extension point for wire features
// ============================================================
// EVERY negotiable wire optimization registers ONE bit here. Both peers advertise their
// supported bitset via [Pkt.CAPS, bits, optional session/generation correlation]; the
// EFFECTIVE feature set per side is
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
    CB_BATCH: 1 << 1,  // lossless ordered batching of live callback packets (Pkt.CB_BATCH)
} as const

export type tCaps = number

/** Everything this build can negotiate. */
export const CAPS_ALL: tCaps = Caps.COMPACT
    | Caps.CB_BATCH

/** Whether capability c is in negotiated bitset. */
export const hasCap = (caps: tCaps, c: number) => (caps & c) === c

/** Intent for connection optimizations on the JSON-array wire. */
export type RpcOpt = {
    /** Adaptive compression of ticks (Pkt.SHAPE/CBV). Enabled by default; false = force plain Pkt.CB. */
    compact?: boolean
    /** Lossless callback packet batching. Enabled by default; false = one physical packet per tick. */
    callbackBatch?: boolean | {
        /** Maximum callback packets in one physical batch. */
        maxItems?: number
        /** Approximate JSON wire ceiling for one physical batch. */
        maxBytes?: number
    }
}

/** Intent → bitset we advertise. JSON wire features default on. */
export function optToCaps(opt?: RpcOpt): tCaps {
    let c: tCaps = Caps.COMPACT | Caps.CB_BATCH
    if (opt?.compact === false) c &= ~Caps.COMPACT
    if (opt?.callbackBatch === false) c &= ~Caps.CB_BATCH
    return c
}
