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
    AUTH_STATE: 1 << 2, // server→client push of authorization state (Pkt.AUTH)
    HELLO_ID: 1 << 3,  // request correlation for in-band auth (Pkt.HELLO id echoed by Pkt.MAP)
    REQ_BATCH: 1 << 4, // the same ordered envelope for CALL/PIPE and RESP too (Pkt.BATCH)
    ROWS: 1 << 5,      // connection-scoped shape registry + row-encoded record arrays ($_t)
    CB_FLOW: 1 << 6,   // flow-paced callbacks: credit window + cumulative acks (Pkt.CB_FLOW/CB_ACK)
} as const

export type tCaps = number

/** Everything this build can negotiate. */
export const CAPS_ALL: tCaps = Caps.COMPACT
    | Caps.CB_BATCH
    | Caps.AUTH_STATE
    | Caps.HELLO_ID
    | Caps.REQ_BATCH
    | Caps.ROWS
    | Caps.CB_FLOW

/** Whether capability c is in negotiated bitset. */
export const hasCap = (caps: tCaps, c: number) => (caps & c) === c

/** Ceilings of ONE physical batch. Shared by every batched envelope: the ceilings bound a
 *  frame, and a frame does not care which opcode wraps it. */
export type RpcBatchOpt = boolean | {
    /** Maximum logical packets in one physical batch. */
    maxItems?: number
    /** Approximate JSON wire ceiling for one physical batch. */
    maxBytes?: number
}

/** Intent for connection optimizations on the JSON-array wire. */
export type RpcOpt = {
    /** Adaptive compression of ticks (Pkt.SHAPE/CBV). Enabled by default; false = force plain Pkt.CB. */
    compact?: boolean
    /** Lossless callback packet batching. Enabled by default; false = one physical packet per tick. */
    callbackBatch?: RpcBatchOpt
    /** The SAME ordered envelope (Pkt.BATCH) for CALL/PIPE and RESP, and for the callbacks a
     *  response follows. OPT-IN, unlike its siblings: it re-frames the request path itself, and
     *  a peer issuing one call at a time has nothing to merge (experiments/rpc-perf-2026-07).
     *  Effective only together with `callbackBatch`: ONE ordered queue per session is what lets
     *  a response ride behind its own callbacks instead of flushing them first. */
    requestBatch?: RpcBatchOpt
    /** Row/table encoding of arrays of uniform records ({"$_t": [...]}), and ONE bounded shape
     *  registry per connection instead of one per cbId. Enabled by default; false = every array
     *  travels as objects, wire as before. It was expected to trade CPU for bytes as `compact`
     *  does, and measurement said otherwise: on a 1000-record result it is −44.5 % bytes AND
     *  −31 % CPU, because ~57 KB of repeated key names never reach JSON.stringify
     *  (experiments/rpc-perf-2026-07). Effective only together with `compact`: the tick half of
     *  the registry IS the Pkt.SHAPE/CBV wire. */
    compactRows?: boolean
    /** Server→client authorization state (Pkt.AUTH: expiring/expired/revoked).
     *  Enabled by default; false = never negotiated, wire as before. */
    authState?: boolean
    /** Correlation of a Pkt.HELLO with the Pkt.MAP that answers it: the client puts an id in the
     *  3rd element of HELLO, the server echoes it in the 6th of the answering MAP. Enabled by
     *  default; false = uncorrelated wire as before, and `reauth()` again settles on whatever
     *  authAck-bearing MAP arrives next. */
    helloId?: boolean
    /** Flow-paced callbacks (`flowCallback`): per-stream credit window with cumulative client
     *  acks (Pkt.CB_FLOW/CB_ACK). Enabled by default; false = never negotiated. Zero wire cost
     *  either way for methods that never wrap their callback. */
    flowCallback?: boolean
}

/** Intent → bitset we advertise. JSON wire features default on. */
export function optToCaps(opt?: RpcOpt): tCaps {
    let c: tCaps = Caps.COMPACT | Caps.CB_BATCH | Caps.AUTH_STATE | Caps.HELLO_ID | Caps.ROWS | Caps.CB_FLOW
    if (opt?.compact === false) c &= ~Caps.COMPACT
    if (opt?.callbackBatch === false) c &= ~Caps.CB_BATCH
    if (opt?.authState === false) c &= ~Caps.AUTH_STATE
    if (opt?.helloId === false) c &= ~Caps.HELLO_ID
    if (opt?.flowCallback === false) c &= ~Caps.CB_FLOW
    // The one bit that is off by default: it changes the framing of the REQUEST path, where the
    // measured win needs genuinely concurrent calls. Asking for it is a claim about the workload.
    if (opt?.requestBatch) c |= Caps.REQ_BATCH
    // ON by default, unlike requestBatch, because the measurement says so rather than because
    // it is the same kind of feature: it does not re-frame anything (same packets, same frame
    // count) and it made its target family faster AND smaller — 127 912 → 70 983 B/call with
    // CPU 3112 → 2150 µs and p50 3.31 → 1.81 ms, non-overlapping over 3 runs. Every other
    // family stayed byte-identical. See the third pass of experiments/rpc-perf-2026-07.
    if (opt?.compactRows === false) c &= ~Caps.ROWS
    return c
}
