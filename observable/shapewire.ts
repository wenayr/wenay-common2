// ============================================================
//  shapewire.ts — MECHANISM 2: adaptive wire encoding.
//
//  A record stream whose encoding SPECIALIZES as its shape
//  stabilizes, then DEOPTS to self-describing on a shape break
//  and re-learns. "Measure, then specialize, then deopt" — the
//  same loop V8 runs on object shapes and FIX/FAST run on
//  market-data frames.
//
//  Split by layer (CLAUDE.md):
//   • protocol — numeric frame KIND / op codes (gRPC-friendly:
//                small ints, no string tags, like wire.ts CMD/OP).
//   • util     — key-set signature + bit helpers (pure).
//   • business — the state machine (LEARNING -> STABLE -> DEOPT).
//
//  Industry techniques (named where they fire):
//   - presence BITMASK of changed fields = FIX/FAST pmap,
//     protobuf has-bits, SBE/FlatBuffers vtable positional encode.
//   - SNAPSHOT vs INCREMENTAL = FIX Market Data Full Refresh (W)
//     vs Incremental Refresh (X): snapshot = authoritative full
//     set (delete-missing); incremental = only changed fields.
//   - learn -> specialize -> DEOPT = V8 hidden classes / inline
//     caches / JIT speculation.
//   - shapeId codebook = Arrow/Parquet dictionary encoding.
//
//  Rich leaf VALUES (Date/BigInt/Map/Set/RegExp/binary) ride
//  codec.ts encodeValue/decodeValue — shapewire owns STRUCTURE
//  and specialization, codec owns rich leaf TYPES.
// ============================================================

import { encodeValue, decodeValue } from './codec'

// ===== protocol — numeric frame KIND + op codes =====
// Small ints on the wire (like wire.ts CMD/OP), so a later move to
// protobuf/gRPC is a field-tag mapping, not a reshape.
const KIND = {
    self: 0,   // self-describing  [0, isSnap, keys[], encodedVals[]]
    pos: 1,    // positional       [1, isSnap, shapeId, bitmask, ...changedEncodedVals]
    dict: 2,   // keyed dictionary [2, isSnap, ops[]]
} as const

// per-key dictionary ops
const OP = {
    set: 1,    // [1, key, subframe]  — key's record changed
    del: 2,    // [2, key]            — key removed (incremental only)
} as const

type tKind = typeof KIND[keyof typeof KIND]
type tOp = typeof OP[keyof typeof OP]

// snapshot vs incremental rides as a 0/1 flag inside each frame head.
const SNAP = 1
const INCR = 0

// ===== frame types =====
// Numeric/binary-friendly: every head is an int; payloads are
// codec-encoded values. `any` for encoded values because codec
// markers are intentionally structural.
export type tSelfFrame = [kind: 0, isSnap: number, keys: string[], vals: any[]]
export type tPosFrame = [kind: 1, isSnap: number, shapeId: number, bitmask: number, ...changed: any[]]
export type tDictOp =
    | [op: 1, key: string, sub: tShapeFrame]   // set
    | [op: 2, key: string]                      // del
export type tDictFrame = [kind: 2, isSnap: number, ops: tDictOp[]]
export type tShapeFrame = tSelfFrame | tPosFrame | tDictFrame

// ===== util — key-set signature + bit helpers (pure) =====

// Stable signature of a record's OWN key-set, order-independent (a
// reshuffled-but-same key-set is the SAME shape). Field order for a
// shape is fixed at registration time (sorted) so encoder/decoder
// agree positionally without out-of-band sync.
function keysOf(record: any) {
    return Object.keys(record).sort()
}
function sigOf(keys: string[]) {
    //  cannot appear in a normal JS identifier path we care about;
    // a plain join is enough for a codebook key.
    return keys.join('')
}
function sameKeys(a: string[], b: string[]) {
    if (a.length != b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false
    return true
}

// ============================================================
//  business — createShapeCodec (closure factory, 0 deps)
//
//  SEPARATE encoder + decoder codebooks that stay in lockstep BY
//  CONSTRUCTION: the decoder learns the same shapeIds in the same
//  order from the self-describing frames the encoder emits, so no
//  out-of-band sync is ever needed.
// ============================================================
export function createShapeCodec(opts: { stableAfter?: number } = {}) {
    const stableAfter = opts.stableAfter == null ? 3 : opts.stableAfter

    // ---- encoder codebook (shapeId <- keySetSig) ----
    // closure state on the ENCODE side only.
    const encShapes = new Map<string, { id: number, fields: string[] }>()
    let encNextId = 0

    // learning tracker: last key-set seen + how many times in a row.
    let learnKeys: string[] | null = null
    let learnRepeats = 0

    // prev record for omit-unchanged on positional incrementals (flat).
    let encPrev: any = null

    // ---- decoder codebook (shapeId -> fields) ----
    // SEPARATE map; filled when the decoder sees a self-describing
    // frame that the encoder also used to register the same id. Both
    // sides count ids from 0 in frame arrival order -> lockstep.
    const decShapes = new Map<number, string[]>()
    let decNextId = 0
    let decLearnKeys: string[] | null = null
    let decLearnRepeats = 0

    // keyed-dictionary mode keeps a per-key flat codec on BOTH sides so
    // a dictionary of uniform records still specializes per value. Built
    // lazily on first keyed use.
    let keyedEnc: Map<string, ReturnType<typeof createShapeCodec>> | null = null
    let keyedDec: Map<string, ReturnType<typeof createShapeCodec>> | null = null
    let keyedEncPrev: any = null   // prev dictionary (which keys existed)

    // ===== flat encode =====
    function encodeFlat(record: any, isSnap: number) {
        const keys = keysOf(record)
        const sig = sigOf(keys)
        const known = encShapes.get(sig)

        // already STABLE for this shape -> positional frame.
        if (known != null) {
            return emitPositional(record, known, isSnap)
        }

        // LEARNING. Did this key-set repeat?
        if (learnKeys != null && sameKeys(learnKeys, keys)) {
            learnRepeats++
        } else {
            // a new / different key-set: (re)start learning. If we had a
            // half-learned different shape this is a natural deopt edge.
            learnKeys = keys
            learnRepeats = 1
        }

        // crossed the threshold -> register a shapeId now, but STILL emit
        // this frame self-describing (the decoder registers the id from
        // THIS very frame, keeping both codebooks in lockstep).
        // GUARD: the positional bitmask is a 32-bit JS int (`1 << i` wraps at
        // i==32), so a record wider than 32 fields can NEVER go positional —
        // it stays self-describing forever (a natural deopt for wide shapes).
        if (learnRepeats >= stableAfter && !encShapes.has(sig) && keys.length <= 32) {
            encShapes.set(sig, { id: encNextId++, fields: keys })
        }

        // self-describing frame carries every field's encoded value.
        encPrev = record
        return emitSelf(record, keys, isSnap)
    }

    function emitSelf(record: any, keys: string[], isSnap: number) {
        const vals = keys.map(k => encodeValue(record[k]))
        return [KIND.self, isSnap, keys, vals] as tSelfFrame
    }

    // positional frame: bitmask marks which fields are PRESENT (changed
    // for incremental, all-present for snapshot); only set bits carry a
    // value. Unchanged fields are OMITTED and rebuilt from prev on decode.
    function emitPositional(record: any, shape: { id: number, fields: string[] }, isSnap: number) {
        const fields = shape.fields
        let bitmask = 0
        const changed: any[] = []
        for (let i = 0; i < fields.length; i++) {
            const k = fields[i]
            const v = record[k]
            // snapshot = authoritative full set: every field present.
            // incremental = only fields that differ from prev.
            const present = isSnap == SNAP || encPrev == null || !leafEq(encPrev[k], v)
            if (present) {
                bitmask |= (1 << i)
                changed.push(encodeValue(v))
            }
        }
        encPrev = record
        return [KIND.pos, isSnap, shape.id, bitmask, ...changed] as tPosFrame
    }

    // ===== flat decode =====
    function decodeFlat(frame: tShapeFrame, prev: any) {
        const kind = frame[0] as tKind
        if (kind == KIND.self) {
            return decodeSelf(frame as tSelfFrame)
        }
        if (kind == KIND.pos) {
            return decodePositional(frame as tPosFrame, prev)
        }
        throw new Error('shapewire: flat decode got non-flat frame kind ' + kind)
    }

    function decodeSelf(frame: tSelfFrame) {
        const isSnap = frame[1]
        const keys = frame[2]
        const vals = frame[3]
        const out: any = {}
        for (let i = 0; i < keys.length; i++) out[keys[i]] = decodeValue(vals[i])

        // mirror the encoder's learning so the decoder registers the SAME
        // shapeId at the SAME moment -> codebooks stay in lockstep.
        decLearn(keys)
        // self-describing IS the full field-set: snapshot or incremental,
        // an explicit self frame replaces prev wholesale for those keys.
        // (omitted-field semantics only apply to positional frames.)
        void isSnap
        return out
    }

    function decLearn(keys: string[]) {
        const sig = sigOf(keys)
        // already registered? nothing to do.
        for (const fields of decShapes.values()) {
            if (sameKeys(fields, keys)) return
        }
        if (decLearnKeys != null && sameKeys(decLearnKeys, keys)) {
            decLearnRepeats++
        } else {
            decLearnKeys = keys
            decLearnRepeats = 1
        }
        // mirror the encoder's >32-field guard exactly, or the decoder would
        // mint a shapeId the encoder never assigned and the codebooks drift.
        if (decLearnRepeats >= stableAfter && keys.length <= 32) {
            decShapes.set(decNextId++, keys)
        }
    }

    function decodePositional(frame: tPosFrame, prev: any) {
        const isSnap = frame[1]
        const shapeId = frame[2]
        const bitmask = frame[3]
        const fields = decShapes.get(shapeId)
        if (fields == null) throw new Error('shapewire: unknown shapeId ' + shapeId)

        const out: any = {}
        let vi = 4   // first changed value index in the frame tuple
        for (let i = 0; i < fields.length; i++) {
            const k = fields[i]
            if (bitmask & (1 << i)) {
                out[k] = decodeValue((frame as any[])[vi++])
            } else {
                // clear bit: field unchanged. Snapshot still lists every
                // field (bit set), so a clear bit only happens on an
                // incremental -> copy from prev. If prev lacks it (shouldn't
                // for a stable shape) leave undefined.
                if (prev != null && k in prev) out[k] = prev[k]
            }
        }
        void isSnap
        return out
    }

    // leaf equality for omit-unchanged. Cheap structural eq that knows the
    // rich types codec carries; falls back to Object.is for primitives.
    function leafEq(a: any, b: any): boolean {
        // Object.is, NOT == (which would fold 0=='' / null==undefined / 0==false and
        // omit a real change) and NOT === (NaN!==NaN would report a phantom change).
        // This is the change-detection identity, same as reactive.ts/store.ts.
        if (Object.is(a, b)) return true
        if (a instanceof Uint8Array || b instanceof Uint8Array) {
            if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false
            if (a.length != b.length) return false
            for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false
            return true
        }
        if (typeof a == 'bigint' || typeof b == 'bigint') return a == b
        if (a instanceof Date || b instanceof Date) {
            return a instanceof Date && b instanceof Date && a.valueOf() == b.valueOf()
        }
        if (a instanceof Map || b instanceof Map) {
            if (!(a instanceof Map) || !(b instanceof Map) || a.size != b.size) return false
            for (const [k, v] of a) { if (!b.has(k)) return false; if (!leafEq(v, b.get(k))) return false }
            return true
        }
        if (a instanceof Set || b instanceof Set) {
            if (!(a instanceof Set) || !(b instanceof Set) || a.size != b.size) return false
            const bv = [...b]
            return [...a].every(x => bv.some(y => leafEq(x, y)))
        }
        if (a != null && b != null && typeof a == 'object' && typeof b == 'object') {
            const ka = Object.keys(a), kb = Object.keys(b)
            if (ka.length != kb.length) return false
            return ka.every(k => leafEq(a[k], b[k]))
        }
        return Object.is(a, b)
    }

    // ===== keyed-dictionary encode =====
    // {sym1:{...}, sym2:{...}} where keys appear/disappear. Reconcile per
    // key with explicit set/del ops; a snapshot means "this IS the full
    // set — delete keys not present" (FIX W). Each per-key value reuses a
    // dedicated flat sub-codec so a dictionary of uniform records still
    // specializes per value.
    function encodeDict(record: any, isSnap: number) {
        if (keyedEnc == null) keyedEnc = new Map()
        const ops: tDictOp[] = []
        const presentKeys = Object.keys(record)

        for (const key of presentKeys) {
            // INCREMENTAL del is EXPLICIT: a key set to `undefined`/null means
            // "remove this key" (FIX X never auto-deletes merely-absent keys —
            // absent = unchanged, not removed). Snapshot ignores this; its
            // delete-missing comes from the full set below.
            if (isSnap == INCR && record[key] == null) {
                ops.push([OP.del, key])
                keyedEnc.delete(key)
                continue
            }
            let sub = keyedEnc.get(key)
            if (sub == null) { sub = createShapeCodec({ stableAfter }); keyedEnc.set(key, sub) }
            // a key's value is itself a record -> shape-coded sub-frame.
            const subFrame = sub.encode(record[key], { kind: isSnap == SNAP ? 'snapshot' : 'incremental' })
            ops.push([OP.set, key, subFrame])
        }

        // snapshot = authoritative full set: delete-missing (FIX W). The op
        // list below IS the complete key-set; prune any stale sub-codec for a
        // key not present now. (Incremental NEVER auto-deletes absent keys.)
        if (isSnap == SNAP) {
            for (const key of [...keyedEnc.keys()]) {
                if (!(key in record) || record[key] == null) keyedEnc.delete(key)
            }
        }

        keyedEncPrev = record
        return [KIND.dict, isSnap, ops] as tDictFrame
    }

    // ===== keyed-dictionary decode =====
    function decodeDict(frame: tDictFrame, prev: any) {
        if (keyedDec == null) keyedDec = new Map()
        const isSnap = frame[1]
        const ops = frame[2]

        // incremental starts from prev; snapshot starts empty (delete-rest).
        const out: any = isSnap == SNAP ? {} : { ...(prev || {}) }
        const seen = new Set<string>()

        for (const op of ops) {
            if (op[0] == OP.set) {
                const key = op[1]
                const subFrame = op[2]
                seen.add(key)
                let sub = keyedDec.get(key)
                if (sub == null) { sub = createShapeCodec({ stableAfter }); keyedDec.set(key, sub) }
                const subPrev = prev != null ? prev[key] : undefined
                out[key] = sub.decode(subFrame, subPrev)
            } else if (op[0] == OP.del) {
                const key = op[1]
                delete out[key]
                keyedDec.delete(key)
            }
        }

        // snapshot: keys not listed are deleted (FIX W). Since we started
        // `out` empty, that's automatic; also prune stale sub-codecs.
        if (isSnap == SNAP) {
            for (const key of [...keyedDec.keys()]) {
                if (!seen.has(key)) keyedDec.delete(key)
            }
        }
        return out
    }

    // ===== public surface =====
    // Default kind = 'snapshot' (authoritative whole-object) — safe by
    // default for a subscriber that did NOT declare a diff strategy.
    // Field-level incremental is the opt-in optimization.
    function encode(record: any, o: { kind?: 'snapshot' | 'incremental' } = {}) {
        const isSnap = o.kind == 'incremental' ? INCR : SNAP
        // dictionary vs flat: a dictionary's values are all plain objects.
        if (isDictRecord(record)) return encodeDict(record, isSnap)
        return encodeFlat(record, isSnap)
    }

    function decode(frame: tShapeFrame, prev?: any) {
        const kind = frame[0] as tKind
        if (kind == KIND.dict) return decodeDict(frame as tDictFrame, prev)
        return decodeFlat(frame, prev)
    }

    return {
        // single audience here: encode/decode are the codec; debug is a
        // small inspector. Two-facet split (api / debug).
        encode,
        decode,
        debug: {
            shapeIds: () => encNextId,
            isStable: () => encShapes.size > 0,
        },
    }
}

// A keyed-DICTIONARY record is one whose values are ALL plain objects
// (each value is itself a record). A flat record has at least one
// non-object (or rich) leaf. Empty object -> treat as flat.
function isDictRecord(record: any) {
    if (record == null || typeof record != 'object' || Array.isArray(record)) return false
    const keys = Object.keys(record)
    if (keys.length == 0) return false
    let sawSub = false
    for (const k of keys) {
        const v = record[k]
        // null/undefined are del markers in incremental dict mode — skip them,
        // they don't disqualify a record from being a dictionary.
        if (v == null) continue
        if (typeof v != 'object' || Array.isArray(v)) return false
        // rich leaves are NOT dictionary sub-records.
        if (v instanceof Date || v instanceof Map || v instanceof Set
            || v instanceof RegExp || v instanceof Uint8Array) return false
        sawSub = true
    }
    return sawSub
}

// ===== public types =====
export type ShapeCodec = ReturnType<typeof createShapeCodec>

// ============================================================
//  runnable oracle
// ============================================================
if (require.main === module) {
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }

    // rich-aware deep eq (mirrors codec oracle's eq).
    function eq(a: any, b: any): boolean {
        if (a instanceof Uint8Array || b instanceof Uint8Array) {
            if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false
            if (a.length != b.length) return false
            for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false
            return true
        }
        if (typeof a == 'bigint' || typeof b == 'bigint') return a == b
        if (a instanceof Date || b instanceof Date) {
            return a instanceof Date && b instanceof Date && a.valueOf() == b.valueOf()
        }
        if (a instanceof Map || b instanceof Map) {
            if (!(a instanceof Map) || !(b instanceof Map) || a.size != b.size) return false
            for (const [k, v] of a) { if (!b.has(k)) return false; if (!eq(v, b.get(k))) return false }
            return true
        }
        if (a instanceof Set || b instanceof Set) {
            if (!(a instanceof Set) || !(b instanceof Set) || a.size != b.size) return false
            const bv = [...b]
            return [...a].every(x => bv.some(y => eq(x, y)))
        }
        if (a != null && b != null && typeof a == 'object' && typeof b == 'object') {
            const ka = Object.keys(a), kb = Object.keys(b)
            if (ka.length != kb.length) return false
            return ka.every(k => eq(a[k], b[k]))
        }
        return Object.is(a, b)
    }

    // ---- (a) first frames self-describing, post-stabilization positional ----
    console.log('\n[shapewire] (a) learn -> specialize: self-describing then positional')
    {
        const enc = createShapeCodec({ stableAfter: 3 })
        const recs = [
            { bid: 100, ask: 101, last: 100 },
            { bid: 100, ask: 101, last: 100 },
            { bid: 102, ask: 103, last: 102 },
            { bid: 104, ask: 105, last: 104 },
        ]
        const frames = recs.map(r => enc.encode(r, { kind: 'incremental' }))
        assert(frames[0][0] == KIND.self, 'frame 0 is self-describing (k:0)')
        assert(frames[1][0] == KIND.self, 'frame 1 is self-describing (k:0)')
        // 3rd repeat of the same key-set registers the shape; this frame is
        // STILL self-describing (decoder learns the id from it). 4th is positional.
        assert(frames[2][0] == KIND.self, 'frame 2 (threshold repeat) still self-describing')
        assert(frames[3][0] == KIND.pos, 'frame 3 is positional (k:1) after stabilization')
        assert(enc.debug.isStable(), 'codec reports stable')
    }

    // ---- (b) only changed fields travel; decode rebuilds full from prev ----
    console.log('\n[shapewire] (b) bitmask carries ONLY changed fields, decode reconstructs from prev')
    {
        const enc = createShapeCodec({ stableAfter: 2 })
        const dec = createShapeCodec({ stableAfter: 2 })
        const seq = [
            { a: 1, b: 2, c: 3 },
            { a: 1, b: 2, c: 3 },   // stabilizes here (2nd repeat)
            { a: 1, b: 20, c: 3 },  // only b changed
        ]
        let prevD: any = null
        let lastFrame: tShapeFrame | null = null
        for (const r of seq) {
            const f = enc.encode(r, { kind: 'incremental' })
            prevD = dec.decode(f, prevD)
            lastFrame = f
        }
        // last frame: positional, only b present -> bitmask has exactly one bit,
        // tuple has exactly one changed value (length 5: kind,isSnap,id,mask,val).
        assert(lastFrame![0] == KIND.pos, 'change frame is positional')
        assert((lastFrame as tPosFrame).length == 5, 'positional frame carries exactly ONE changed value')
        const mask = (lastFrame as tPosFrame)[3]
        // fields sorted: a,b,c -> b is bit 1.
        assert(mask == (1 << 1), 'bitmask marks ONLY field b (bit 1): ' + mask.toString(2))
        assert(eq(prevD, { a: 1, b: 20, c: 3 }), 'decode reconstructed full record from prev: ' + JSON.stringify(prevD))
    }

    // ---- (c) shape break deopts then re-learns ----
    console.log('\n[shapewire] (c) shape break -> deopt to self-describing -> re-learn')
    {
        const enc = createShapeCodec({ stableAfter: 2 })
        const dec = createShapeCodec({ stableAfter: 2 })
        let prevD: any = null
        const run = (r: any) => { const f = enc.encode(r, { kind: 'incremental' }); prevD = dec.decode(f, prevD); return f }

        run({ x: 1, y: 2 })
        run({ x: 1, y: 2 })                       // stable
        const fStable = run({ x: 5, y: 2 })       // positional
        assert(fStable[0] == KIND.pos, 'pre-break frame is positional')
        const fBreak = run({ x: 1, y: 2, z: 9 })  // NEW key z -> deopt
        assert(fBreak[0] == KIND.self, 'shape break (new key z) deopts to self-describing')
        run({ x: 1, y: 2, z: 9 })                 // re-learn the new shape
        const fRelearn = run({ x: 2, y: 2, z: 9 })
        assert(fRelearn[0] == KIND.pos, 're-learned new shape -> positional again')
        assert(eq(prevD, { x: 2, y: 2, z: 9 }), 'decode tracked through deopt+relearn: ' + JSON.stringify(prevD))
    }

    // ---- (d) snapshot deletes missing keys; incremental does not ----
    console.log('\n[shapewire] (d) snapshot deletes missing keys, incremental keeps them (keyed dict)')
    {
        const encS = createShapeCodec()
        const decS = createShapeCodec()
        // start with two symbols
        let prev = decS.decode(encS.encode({ A: { p: 1 }, B: { p: 2 } }, { kind: 'snapshot' }), null)
        assert(eq(prev, { A: { p: 1 }, B: { p: 2 } }), 'initial snapshot has A and B')
        // INCREMENTAL with only A present -> B must REMAIN.
        prev = decS.decode(encS.encode({ A: { p: 9 } }, { kind: 'incremental' }), prev)
        assert('B' in prev && prev.B.p == 2, 'incremental keeps missing key B')
        assert(prev.A.p == 9, 'incremental updated A')
        // SNAPSHOT with only A present -> B must be DELETED.
        prev = decS.decode(encS.encode({ A: { p: 10 } }, { kind: 'snapshot' }), prev)
        assert(!('B' in prev), 'snapshot DELETED missing key B')
        assert(prev.A.p == 10, 'snapshot kept/updated A')
    }

    // ---- (e) round-trip fidelity incl. Date / BigInt / Map via codec ----
    console.log('\n[shapewire] (e) round-trip fidelity with rich values (Date/BigInt/Map)')
    {
        const enc = createShapeCodec({ stableAfter: 1 })
        const dec = createShapeCodec({ stableAfter: 1 })
        let prevD: any = null
        const rich = {
            when: new Date('2026-06-18T00:00:00.000Z'),
            nonce: 9007199254740993n,
            book: new Map<any, any>([['bid', 100], ['ask', 101]]),
            px: 42,
        }
        // run twice so we also exercise the positional path with rich leaves.
        let last: any
        for (const r of [rich, { ...rich, px: 43 }]) {
            const f = enc.encode(r, { kind: 'incremental' })
            prevD = dec.decode(f, prevD)
            last = r
        }
        assert(prevD.when instanceof Date && eq(prevD.when, last.when), 'Date survived')
        assert(typeof prevD.nonce == 'bigint' && prevD.nonce == last.nonce, 'BigInt survived exact')
        assert(prevD.book instanceof Map && eq(prevD.book, last.book), 'Map survived')
        assert(prevD.px == 43, 'changed primitive applied via positional incremental')
    }

    // ---- (f) keyed-dictionary add + set + del round-trips ----
    console.log('\n[shapewire] (f) keyed-dictionary add / set / del round-trips (incremental)')
    {
        const enc = createShapeCodec()
        const dec = createShapeCodec()
        let prev: any = null
        const step = (r: any, kind: 'snapshot' | 'incremental') => {
            const f = enc.encode(r, { kind })
            prev = dec.decode(f, prev)
            return f
        }
        // initial snapshot: A, B
        step({ A: { p: 1 }, B: { p: 2 } }, 'snapshot')
        // incremental ADD of C + SET of A (B untouched)
        const fAdd = step({ A: { p: 11 }, C: { p: 3 } }, 'incremental')
        assert(fAdd[0] == KIND.dict, 'keyed frame is k:2 dict')
        assert(eq(prev, { A: { p: 11 }, B: { p: 2 }, C: { p: 3 } }), 'add C + set A, B kept: ' + JSON.stringify(prev))
        // incremental DEL of B (EXPLICIT: value undefined). A merely-absent
        // key would be left untouched, so deletion must be signalled.
        const fDel = step({ A: { p: 11 }, B: undefined }, 'incremental') as tDictFrame
        const hasDel = fDel[2].some(op => op[0] == OP.del && op[1] == 'B')
        assert(hasDel, 'frame carries an explicit del op for B')
        assert(!('B' in prev) && 'C' in prev && 'A' in prev, 'B deleted, A and C remain: ' + JSON.stringify(prev))
    }

    // ── wide record (>32 fields): never goes positional (32-bit bitmask guard) ──
    console.log('\n[shapewire] a >32-field record stays self-describing and round-trips exactly')
    {
        const enc = createShapeCodec({ stableAfter: 2 })
        const dec = createShapeCodec({ stableAfter: 2 })
        const wide = () => { const o: any = {}; for (let i = 0; i < 40; i++) o['f' + i] = i; return o }
        let prev: any = null
        let lastFrame: any = null
        for (let rep = 0; rep < 5; rep++) {           // repeat well past stableAfter
            const r = wide(); r.f35 = 100 + rep        // change a field ABOVE bit 32
            lastFrame = enc.encode(r)
            prev = dec.decode(lastFrame, prev)
        }
        assert(lastFrame[0] == KIND.self, 'wide shape never specialized to positional (stays self-describing)')
        assert(prev.f35 == 104 && prev.f0 == 0 && prev.f39 == 39, 'all 40 fields round-trip incl. f35 above bit 32: f35=' + prev.f35)
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    process.exit(fails == 0 ? 0 : 1)
}
