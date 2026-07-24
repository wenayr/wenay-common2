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
    BINARY: 1 << 2,    // exact binary application packets after a correlated byte probe
    // Universal typed schemas. BINARY remains advertised as the compatible v1 fallback.
    BINARY_SCHEMA: 1 << 3,
    // Complete RPC packet encoded by msgpackr; v2/v1 remain compatibility fallbacks.
    BINARY_MSGPACK: 1 << 4,
} as const

export type tCaps = number

/** Everything this build can negotiate. */
export const CAPS_ALL: tCaps = Caps.COMPACT
    | Caps.CB_BATCH
    | Caps.BINARY
    | Caps.BINARY_SCHEMA
    | Caps.BINARY_MSGPACK
export const RPC_BINARY_MAX_SHAPES = 1_000
export const RPC_BINARY_MAX_SCHEMAS = 1_000
export const RPC_BINARY_DEFAULT_PROMOTION_THRESHOLD = 3

/** Whether capability c is in negotiated bitset. */
export const hasCap = (caps: tCaps, c: number) => (caps & c) === c

/** Intent for connection optimizations. Binary is opt-in; the JSON lane stays the default. */
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
    /** Exact binary CALL/RESP/callback/PIPE frames. Opt-in; absent/false keeps JSON arrays. */
    binary?: boolean | {
        /** Universal typed-schema protocol v2. False keeps compatible binary v1. */
        schema?: boolean
        /** Universal msgpackr protocol v3. False keeps schema-v2 as the newest candidate. */
        msgpack?: boolean
        /** Maximum compound layouts emitted by this peer. Receiver hard maximum stays 1,000. */
        maxShapes?: number
        /** Maximum typed schemas emitted by this peer. Receiver hard maximum stays 1,000. */
        maxSchemas?: number
        /** Repetitions before a dynamically observed layout becomes a wire schema. */
        promotionThreshold?: number
        /**
         * Representative runtime values whose layouts and physical field types are sent
         * during the binary handshake, before application packets.
         */
        predeclared?: readonly unknown[]
    }
}

/** Intent → bitset we advertise. Stable JSON features default on; binary requires explicit opt-in. */
export function optToCaps(opt?: RpcOpt): tCaps {
    let c: tCaps = Caps.COMPACT | Caps.CB_BATCH
    if (opt?.compact === false) c &= ~Caps.COMPACT
    if (opt?.callbackBatch === false) c &= ~Caps.CB_BATCH
    if (opt?.binary === true || (opt?.binary && typeof opt.binary == 'object')) {
        c |= Caps.BINARY | Caps.BINARY_SCHEMA | Caps.BINARY_MSGPACK
        if (typeof opt.binary == 'object' && opt.binary.schema === false) {
            c &= ~(Caps.BINARY_SCHEMA | Caps.BINARY_MSGPACK)
        }
        if (typeof opt.binary == 'object' && opt.binary.msgpack === false) {
            c &= ~Caps.BINARY_MSGPACK
        }
    }
    return c
}

export function rpcBinarySchemaOptions(opt?: RpcOpt) {
    const value = opt?.binary && typeof opt.binary == 'object'
        ? opt.binary
        : undefined
    const maxSchemas = value?.maxSchemas ?? value?.maxShapes
    const promotionThreshold = value?.promotionThreshold
    if (maxSchemas != undefined && !Number.isFinite(maxSchemas)) {
        throw new RangeError('RPC binary maxSchemas must be finite')
    }
    if (promotionThreshold != undefined && !Number.isFinite(promotionThreshold)) {
        throw new RangeError('RPC binary promotionThreshold must be finite')
    }
    return {
        maxSchemas: maxSchemas == undefined
            ? RPC_BINARY_MAX_SCHEMAS
            : Math.max(0, Math.min(RPC_BINARY_MAX_SCHEMAS, Math.floor(maxSchemas))),
        promotionThreshold: promotionThreshold == undefined
            ? RPC_BINARY_DEFAULT_PROMOTION_THRESHOLD
            : Math.max(1, Math.floor(promotionThreshold)),
        predeclared: value?.predeclared ?? [],
    }
}

export function rpcBinaryMaxShapes(opt?: RpcOpt) {
    const value = opt?.binary && typeof opt.binary == 'object'
        ? opt.binary.maxShapes
        : undefined
    if (value == undefined) return RPC_BINARY_MAX_SHAPES
    if (!Number.isFinite(value)) throw new RangeError('RPC binary maxShapes must be finite')
    return Math.max(0, Math.min(RPC_BINARY_MAX_SHAPES, Math.floor(value)))
}
