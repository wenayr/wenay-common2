// rpc-shape.ts

import {isSafeKey, PayloadLimitError, type RpcLimits} from './rpc-limits'
import type {tRowCodec} from './rpc-walk'
//
// ============================================================
// Adaptive compression of SUBSCRIPTION TICKS (dynamic, not static)
// ============================================================
// Subscription emits objects of DYNAMIC shape. Server counts shape frequency per-cbId;
// shape repeated THRESHOLD times gets shapeId — then tick sent compactly
// (values only, keys once in Pkt.SHAPE). Keep up to MAX_SHAPES shapes simultaneously
// (may be 2-3 standards); counters NOT reset. Compress ONLY objects and ONLY frequent —
// rare/polymorphic/non-objects sent as full Pkt.CB. No pairwise shape comparison: signature
// built from keys, then lookup by it (cheap relative to serialization itself).

const THRESHOLD = 5  // how many times shape must appear before we standardize it
const MAX_SHAPES = 5 // max shapes tracked simultaneously per cbId

// only plain object-record: array/Date/Map/Set/RegExp/class — don't compress
export function isPlainObject(v: any) {
    if (v == null || typeof v != "object") return false
    if (Array.isArray(v) || v instanceof Date || v instanceof Map || v instanceof Set || v instanceof RegExp) return false
    const p = Object.getPrototypeOf(v)
    return p == null || p == Object.prototype
}

type tShape = { sig: string; keys: string[]; count: number; shapeId: number }

export function createCbShapeServer(threshold = THRESHOLD, maxShapes = MAX_SHAPES) {
    const byCb = new Map<number, { shapes: tShape[]; nextId: number }>()

    // offer returns DECISION (we expose keys, caller packs values):
    //   full     — send as usual Pkt.CB
    //   register — standardize first time: Pkt.SHAPE(keys) first, then Pkt.CBV(values)
    //   compact  — already standardized: Pkt.CBV(values) only
    function offer(cbId: number, obj: any) {
        const keys = Object.keys(obj)
        // Unsafe keys are already stripped by the regular packer. Compacting them would
        // make SHAPE a second object-construction path with different safety semantics.
        if (!keys.every(isSafeKey)) return { mode: 'full' as const }
        // Escaping keeps the signature injective even when a key contains NUL or a delimiter.
        const sig = JSON.stringify(keys.slice().sort())
        let st = byCb.get(cbId)
        if (!st) { st = { shapes: [], nextId: 0 }; byCb.set(cbId, st) }
        const sh = st.shapes.find(s => s.sig == sig)
        if (sh) {
            sh.count++
            if (sh.shapeId >= 0) return { mode: "compact" as const, shapeId: sh.shapeId, keys: sh.keys }
            if (sh.count >= threshold) { sh.shapeId = st.nextId++; return { mode: "register" as const, shapeId: sh.shapeId, keys: sh.keys } }
            return { mode: "full" as const }
        }
        // take new shape as candidate while slots available; beyond MAX_SHAPES — just full object
        if (st.shapes.length < maxShapes) st.shapes.push({ sig, keys, count: 1, shapeId: -1 })
        return { mode: "full" as const }
    }

    function drop(cbId: number) { byCb.delete(cbId) }
    return { offer, drop }
}

// ============================================================
// CONNECTION-SCOPED shape registry and row encoding (Caps.ROWS)
// ============================================================
// The registry above answers one question per cbId: "has THIS callback repeated this shape
// often enough to standardize it?". Two payload families it cannot serve, both measured in
// experiments/rpc-perf-2026-07:
//   • an ARRAY of uniform records — 49.26 % of a 1000-record result is repeated key names,
//     and not one of those records is a callback tick;
//   • a RESPONSE — sendResult never compacted at all.
// Both need shapes that outlive one cbId, so ids here are assigned per CONNECTION.
//
// What the two halves actually share is ONE id space and ONE uniformity judgement, not a
// decoder state: a shape an ARRAY proved uniform is registered, so the next tick of that shape
// goes straight to Pkt.SHAPE instead of counting to `threshold` first, and a shape a TICK
// registered is recognised by a later array instead of being re-judged. What they deliberately
// do NOT share is the key list on the wire — see offerRows for why a table always carries its
// own keys and why the 63 bytes that would save are not worth what they cost.
//
// LIFETIME AND EVICTION. The previous registry had neither, and the benchmark found the tail
// it leaves: the server drops per-cbId state only on Pkt.CB_END while the client releases the
// id on Pkt.RESP, so a reused cbId inherits a registered shape. This registry cannot inherit
// that: it is keyed by SIGNATURE and not by cbId, it belongs to one server instance and dies
// with it, it holds at most `maxShapes` shapes and evicts the least recently USED one, and
// its ids come from a monotonic counter that is NEVER reused — so an evicted id can not be
// mistaken for a live one by a packet still in flight. Declaration is tracked per SESSION,
// so a session rebuilt on this socket re-declares instead of inheriting a neighbour's table.

// Below this an array is not worth a table: the header costs a shapeId, two brackets and —
// on first use — the key list, while the rows still pay one bracket pair each. Four records
// clears that for every shape we have measured, and keeps a two-element one-off out of the
// registry. See the note on THRESHOLD in offerRows: an array is not a prediction.
const ROW_MIN_ROWS = 4
const REGISTRY_MAX_SHAPES = 64    // live shapes per connection, LRU by last use
const REGISTRY_MAX_CANDIDATES = 64 // shapes still counting toward THRESHOLD (encoder-only)
// Strictly above the encoder bound, and that is the whole proof that a live shape is never
// missing on the decoder: the encoder keeps at most REGISTRY_MAX_SHAPES ids and evicts its
// own LRU, every one of them was declared, and both sides see uses in the same order — so a
// live id is always among the 64 most recent here, far inside 256.
const DECODER_MAX_SHAPES = 256

type tRegistered = {sig: string; keys: string[]; id: number; declared: Set<number>}

/** Least-recently-used eviction on an insertion-ordered Map: re-insert on use, drop the head. */
function evictOldest(m: Map<any, any>, max: number) {
    while (m.size >= max) {
        const oldest = m.keys().next()
        if (oldest.done) return
        m.delete(oldest.value)
    }
}

export function createShapeRegistry(
    threshold = THRESHOLD,
    maxShapes = REGISTRY_MAX_SHAPES,
    minRows = ROW_MIN_ROWS,
) {
    const registered = new Map<string, tRegistered>()
    const candidates = new Map<string, number>()
    let nextId = 0

    // Escaping keeps the signature injective even when a key contains NUL or a delimiter.
    const signature = (keys: string[]) => JSON.stringify(keys.slice().sort())

    // Unsafe keys are already stripped by the regular packer. Compacting them would make this
    // a second object-construction path with different safety semantics — the same reason the
    // per-cbId `offer` above refuses them.
    function safeKeys(obj: any) {
        const keys = Object.keys(obj)
        return keys.every(isSafeKey) ? keys : null
    }

    function touch(sh: tRegistered) {
        registered.delete(sh.sig)
        registered.set(sh.sig, sh)
    }

    function register(sig: string, keys: string[]) {
        evictOldest(registered, maxShapes)
        candidates.delete(sig)
        const sh: tRegistered = {sig, keys, id: nextId++, declared: new Set<number>()}
        registered.set(sig, sh)
        return sh
    }

    function countCandidate(sig: string) {
        const seen = (candidates.get(sig) ?? 0) + 1
        candidates.delete(sig)
        evictOldest(candidates, REGISTRY_MAX_CANDIDATES)
        candidates.set(sig, seen)
        return seen
    }

    // One tick. Same DECISION vocabulary as the per-cbId registry ('full' / 'register' /
    // 'compact'), so the caller's packet choice does not change; only the id space does.
    // A tick stream is a PREDICTION about packets not yet emitted, so a shape still has to
    // repeat `threshold` times before it earns an id — but repetitions are counted per
    // CONNECTION now, and a shape an array already registered needs no further evidence.
    function offerTick(sessionId: number, obj: any) {
        const keys = safeKeys(obj)
        if (!keys) return {mode: 'full' as const}
        const sig = signature(keys)
        let sh = registered.get(sig)
        if (sh) touch(sh)
        else {
            if (countCandidate(sig) < threshold) return {mode: 'full' as const}
            sh = register(sig, keys)
        }
        if (sh.declared.has(sessionId)) return {mode: 'compact' as const, shapeId: sh.id, keys: sh.keys}
        sh.declared.add(sessionId)
        return {mode: 'register' as const, shapeId: sh.id, keys: sh.keys}
    }

    // One array. Unlike a tick stream this is NOT a prediction: N elements sharing a key
    // signature are N repetitions already in hand, so the header pays for itself inside this
    // one payload and no threshold applies — only `minRows`, which is where it starts paying.
    // Uniformity is tested on key ORDER, not on a sorted signature: records that deserve a
    // table come from one literal or one constructor and share the order, and comparing
    // strings in place costs no allocation on the 1000-element path this exists for.
    //
    // A table ALWAYS carries its own keys, and that is a safety decision, not an oversight.
    // The tempting version — declare once, then reference the id — desynchronizes the moment
    // the decoder legitimately drops a packet it cannot use: a RESP for an abandoned request,
    // a CB for a dead cbId, or a table rejected by a limit BEFORE its keys were read. The
    // encoder would go on believing the shape was declared and every later array of that shape
    // would fail forever. Self-describing costs the key list once per array (63 B for a CBar
    // against ~71 000 B of table) and cannot desynchronize at all. What the registry still buys
    // here is the SHARED id space and the threshold: a shape an array proved uniform lets the
    // tick path skip straight to Pkt.SHAPE instead of counting to `threshold` first.
    // No sessionId: a table declares itself, so unlike offerTick it has nothing to remember
    // about who has been told what.
    function offerRows(arr: any[]) {
        if (arr.length < minRows || !isPlainObject(arr[0])) return null
        const keys = safeKeys(arr[0])
        if (!keys) return null
        for (let i = 1; i < arr.length; i++) {
            const item = arr[i]
            if (!isPlainObject(item)) return null
            const itemKeys = Object.keys(item)
            if (itemKeys.length != keys.length) return null
            for (let k = 0; k < keys.length; k++) if (itemKeys[k] != keys[k]) return null
        }
        const sig = signature(keys)
        let sh = registered.get(sig)
        if (sh) touch(sh)
        else sh = register(sig, keys)
        // THIS array's key order, not `sh.keys`: a tick may have registered the same key SET in
        // another order, and a record must come back with the key order it left with —
        // Object.keys of the result is observable. Safe precisely because the table carries its
        // own keys and the receiving shape table is never written by a table (see createRowDecoder).
        return {shapeId: sh.id, keys}
    }

    /** A session died: it must re-declare if it comes back, and it holds no table of ours. */
    function forgetSession(sessionId: number) {
        for (const sh of registered.values()) sh.declared.delete(sessionId)
    }

    return {offerTick, offerRows, forgetSession, size: () => registered.size}
}

export type tShapeRegistry = ReturnType<typeof createShapeRegistry>

// The receiving half: shapeId → key order for ONE connection, declared either by Pkt.SHAPE
// (tick path) or inline by the first table that used the shape. Bounded and LRU like the
// encoder, so a hostile peer declaring shapes forever costs a fixed table and nothing more.
export function createShapeDecoder(maxShapes = DECODER_MAX_SHAPES) {
    const keysById = new Map<number, string[]>()

    function declare(shapeId: number, keys: string[]) {
        keysById.delete(shapeId)
        evictOldest(keysById, maxShapes)
        keysById.set(shapeId, keys)
    }

    function keysOf(shapeId: number) {
        const keys = keysById.get(shapeId)
        if (!keys) return undefined
        keysById.delete(shapeId)
        keysById.set(shapeId, keys)
        return keys
    }

    /** A new server generation restarts ids at 0, so the old table must not survive it. */
    function clear() { keysById.clear() }

    return {declare, keysOf, clear, size: () => keysById.size}
}

export type tShapeDecoder = ReturnType<typeof createShapeDecoder>

// JSON.stringify DROPS an undefined, a function and a symbol from an object and writes `null`
// for the same value in an array. A table moves values from objects into arrays, so those three
// are the only values whose meaning the encoding could change — `{a: 1, b: undefined}` would
// come back as `{a: 1, b: null}` instead of `{a: 1}`. Cheaper to refuse the table than to be
// subtly lossy: one identity test per cell against a saving measured in tens of kilobytes.
const survivesRowMove = (v: any) => v !== undefined && typeof v != 'function' && typeof v != 'symbol'

/** Sending half of ROW_MARKER. One per connection: a table carries its own keys, so unlike the
 *  Pkt.SHAPE path there is no per-session state to keep. */
export function createRowEncoder(registry: tShapeRegistry): tRowCodec {
    function encode(arr: any[], packValue: (v: any) => any) {
        const offer = registry.offerRows(arr)
        if (!offer) return null
        const keys = offer.keys
        const width = keys.length
        const rows = new Array(arr.length)
        for (let i = 0; i < arr.length; i++) {
            const item = arr[i]
            const row = new Array(width)
            for (let k = 0; k < width; k++) {
                const packed = packValue(item[keys[k]])
                if (!survivesRowMove(packed)) return null
                row[k] = packed
            }
            rows[i] = row
        }
        return [offer.shapeId, rows, keys]
    }
    return {encode}
}

// Receiving half of ROW_MARKER — the ONE attacker-facing surface this feature adds.
// Two outcomes and no third: a payload that is not shaped like a table returns null and the
// walker recurses into it as an ordinary object (so an application value that merely uses the
// reserved key survives), and a payload that CLAIMS to be a table but disagrees with its
// shape or with the limits throws PayloadLimitError. Throwing is what the existing decode
// sites already handle — Pkt.RESP rejects that one request, Pkt.CB/CBV drop that one packet —
// so no hostile field can escape as an unhandled error.
export function createRowDecoder(lim?: Required<RpcLimits>): tRowCodec {
    function decode(payload: any, decodeValue: (v: any, depth: number) => any, depth: number) {
        if (!Array.isArray(payload) || payload.length != 3) return null
        const shapeId = payload[0]
        const rows = payload[1]
        const declared = payload[2]
        // STRUCTURE decides membership, and a structure that does not match is simply NOT a
        // table: the walker then recurses into the object exactly as a peer without the bit
        // would, so an application value that merely borrowed the reserved key survives instead
        // of rejecting the packet. Only a payload whose structure DOES claim a table is held to
        // the contract below, and breaking THAT throws.
        if (!Number.isSafeInteger(shapeId) || shapeId < 0 || !Array.isArray(rows) || !Array.isArray(declared)) return null
        // A table reads its keys from ITSELF and never from the Pkt.SHAPE table, so a shape id
        // can never make a table decode against someone else's key order. The id travels only
        // to say which registry entry the sender used — it is validated and then ignored here.
        if (lim && declared.length > lim.maxKeys) throw new PayloadLimitError('too many keys in object')
        // The same three tests the Pkt.SHAPE path applies, for the same reason: keys arrive
        // from the peer and become property names of an object we construct.
        if (!declared.every((k: any) => typeof k == 'string' && isSafeKey(k))) throw new PayloadLimitError('unsafe row shape key')
        if (new Set(declared).size != declared.length) throw new PayloadLimitError('duplicate row shape key')
        if (lim && rows.length > lim.maxArrayLen) throw new PayloadLimitError('array too long')
        const keys: string[] = declared
        const width = keys.length
        const out = new Array(rows.length)
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]
            // A row whose width disagrees with its shape is REJECTED, never padded: a short
            // row would invent undefined fields and a long one would silently drop data.
            if (!Array.isArray(row) || row.length != width) throw new PayloadLimitError('row width does not match its shape')
            const record: any = {}
            for (let k = 0; k < width; k++) record[keys[k]] = decodeValue(row[k], depth + 2)
            out[i] = record
        }
        return {value: out}
    }
    return {decode}
}
