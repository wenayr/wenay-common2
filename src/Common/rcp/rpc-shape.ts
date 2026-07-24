// rpc-shape.ts

import {isSafeKey} from './rpc-limits'
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
