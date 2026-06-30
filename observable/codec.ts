// ============================================================
//  codec.ts — L4 value codec for store delta values
//
//  Round-trips rich types through a transport (socket.io) that
//  carries plain JSON-ish structure PLUS native binary blobs.
//
//   • Date / BigInt / Map / Set / RegExp are packed with the SAME
//     single-key markers the RPC layer uses (rpc-walk.ts), so the
//     two codecs stay wire-compatible.
//   • Binary (Buffer / Uint8Array) is the reason this is its own
//     codec: socket.io transmits ArrayBuffer / Buffer NATIVELY as
//     bytes. So binary must stay BYTES on the wire — never base64,
//     never the {0:..,1:..} object the generic walk would produce.
//     We keep the buffer in place and only remember (via a sibling
//     marker object) that a Uint8Array should be revived as a plain
//     Uint8Array vs. left as a Node Buffer.
//
//  Why not reuse rpc-walk.walk directly: its walk has no binary
//  case — a Uint8Array is `typeof object`, not Array/Map/Date, so it
//  falls into the generic-object branch and is copied key-by-key
//  into {"0":..}, destroying the bytes. We mirror its leaf markers
//  but add the binary path it lacks.
// ============================================================

// ===== Wire markers (shared shape with rpc-walk.ts) =====
const DATE_MARKER = '$_d'
const MAP_MARKER = '$_m'
const SET_MARKER = '$_s'
const REGEXP_MARKER = '$_r'
const BIGINT_MARKER = '$_b'
const BIN_MARKER = '$_u8'   // binary that must revive as plain Uint8Array (not Buffer)

const ALL_MARKERS = new Set([DATE_MARKER, MAP_MARKER, SET_MARKER, REGEXP_MARKER, BIGINT_MARKER, BIN_MARKER])

type tMarker = typeof DATE_MARKER | typeof MAP_MARKER | typeof SET_MARKER
    | typeof REGEXP_MARKER | typeof BIGINT_MARKER | typeof BIN_MARKER

// Buffer is a Uint8Array subclass; detect it without depending on @types/node here.
function isBuffer(v: any) {
    return typeof v == 'object' && v != null
        && typeof (globalThis as any).Buffer == 'function'
        && (globalThis as any).Buffer.isBuffer(v)
}
function isBinary(v: any) {
    // A Buffer is-a Uint8Array; treat any Uint8Array (incl. Buffer) as binary.
    return v instanceof Uint8Array
}

// Revive a $_u8 payload as a PLAIN Uint8Array. Under socket.io a Uint8Array
// arrives as a Node Buffer (Buffer IS instanceof Uint8Array), so returning it
// untouched would defeat the marker — we re-wrap the SAME bytes (no copy) as a
// plain Uint8Array view. An already-plain Uint8Array passes through; an Array
// (e.g. JSON-only transport with no binary channel) is constructed from values.
function decodeBin(payload: any) {
    if (isBuffer(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
    if (payload instanceof Uint8Array) return payload
    return new Uint8Array(payload)
}

// A packed leaf is ALWAYS an object of exactly one marker key ({ $_d: ... }).
function isPacked(v: any) {
    if (v == null || typeof v != 'object') return false
    const ks = Object.keys(v)
    return ks.length == 1 && ALL_MARKERS.has(ks[0])
}

// ===== encode =====
export function encodeValue(v: any): any {
    return encode(v)
}

function encode(v: any): any {
    if (v == null || typeof v != 'object') {
        // BigInt is a primitive (typeof 'bigint') — pack it as a leaf.
        if (typeof v == 'bigint') return { [BIGINT_MARKER]: v.toString() }
        return v
    }

    // Binary stays bytes on the wire. A Buffer round-trips as a Buffer
    // untouched; a plain Uint8Array gets a marker so we don't hand back a
    // Buffer (Buffer !== Uint8Array for strict consumers), preserving the
    // SAME underlying bytes — no copy, no base64.
    if (isBinary(v)) {
        if (isBuffer(v)) return v
        return { [BIN_MARKER]: v }
    }

    if (v instanceof Date) return { [DATE_MARKER]: v.valueOf() }
    if (v instanceof RegExp) return { [REGEXP_MARKER]: { source: v.source, flags: v.flags } }
    if (v instanceof Map) {
        return { [MAP_MARKER]: Array.from(v.entries(), ([k, val]) => [encode(k), encode(val)]) }
    }
    if (v instanceof Set) {
        return { [SET_MARKER]: Array.from(v.values(), x => encode(x)) }
    }
    if (Array.isArray(v)) return v.map(encode)

    const o: any = {}
    for (const k of Object.keys(v)) o[k] = encode(v[k])
    return o
}

// ===== decode =====
export function decodeValue(w: any): any {
    return decode(w)
}

function decode(w: any): any {
    if (w == null || typeof w != 'object') return w

    // Native binary survived as bytes — hand it straight back.
    if (isBinary(w)) return w

    if (isPacked(w)) {
        const key = Object.keys(w)[0] as tMarker
        const payload = (w as any)[key]
        // Each branch validates payload SHAPE first. A genuine user object that
        // happens to have a single marker-named key (e.g. {'$_m': 5}) must NOT
        // crash decode — on shape mismatch we fall through to the plain-object
        // branch below and recurse, treating it as ordinary data.
        switch (key) {
            case DATE_MARKER:
                // Invalid Date encodes to {$_d: NaN}; JSON turns NaN into null.
                // new Date(null) is epoch 0 (a valid date) — wrong. Force NaN so
                // an invalid date round-trips back to an Invalid Date.
                return new Date(payload == null ? NaN : payload)
            case BIGINT_MARKER:
                if (typeof payload == 'string' || typeof payload == 'number') return BigInt(payload)
                break
            case REGEXP_MARKER:
                if (payload != null && typeof payload == 'object' && typeof payload.source == 'string') {
                    return new RegExp(payload.source, payload.flags)
                }
                break
            case MAP_MARKER:
                if (Array.isArray(payload)) {
                    return new Map(payload.map(([k, val]: [any, any]) => [decode(k), decode(val)]))
                }
                break
            case SET_MARKER:
                if (Array.isArray(payload)) return new Set(payload.map((x: any) => decode(x)))
                break
            case BIN_MARKER:
                return decodeBin(payload)
        }
    }

    if (Array.isArray(w)) return w.map(decode)

    const o: any = {}
    for (const k of Object.keys(w)) o[k] = decode(w[k])
    return o
}

// ===== public types =====
export type EncodeValue = typeof encodeValue
export type DecodeValue = typeof decodeValue

// ============================================================
//  runnable oracle
// ============================================================
if (require.main === module) {
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }

    // deep structural eq that knows Date / BigInt / Map / Set / binary
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

    // Honest wire simulation: structure goes through JSON, but native
    // binary is carried OUT-OF-BAND as real bytes (what socket.io does).
    // We pre-walk to pull EVERY Uint8Array (incl. Node Buffer) out into a
    // side channel and leave a placeholder, JSON only the structure, then
    // splice the SAME byte arrays back — proving binary never touched JSON.
    // (A JSON replacer can't see a Buffer as bytes: Node Buffer.toJSON()
    //  fires first and yields {type:'Buffer',data:[...]} — so we extract
    //  before stringify, exactly as socket.io separates binary attachments.)
    function overWire(encoded: any) {
        const bins: Uint8Array[] = []
        function strip(v: any): any {
            if (v instanceof Uint8Array) { bins.push(v); return { __bin: bins.length - 1 } }
            if (v == null || typeof v != 'object') return v
            if (Array.isArray(v)) return v.map(strip)
            const o: any = {}
            for (const k of Object.keys(v)) o[k] = strip(v[k])
            return o
        }
        const json = JSON.stringify(strip(encoded))
        const revived = JSON.parse(json, (_k, val) => {
            if (val != null && typeof val == 'object' && typeof val.__bin == 'number') return bins[val.__bin]
            return val
        })
        return revived
    }

    function roundtrip(v: any) {
        return decodeValue(overWire(encodeValue(v)))
    }

    console.log('\n[codec] primitives')
    for (const v of [42, -0.5, 'hello', '', true, false, null]) {
        assert(eq(roundtrip(v), v), 'primitive round-trip: ' + JSON.stringify(v))
    }

    console.log('\n[codec] Date / BigInt / RegExp')
    const d = new Date('2026-06-17T12:34:56.789Z')
    assert(roundtrip(d) instanceof Date && eq(roundtrip(d), d), 'Date keeps valueOf')
    const big = 9007199254740993n  // > Number.MAX_SAFE_INTEGER, must not lose precision
    assert(typeof roundtrip(big) == 'bigint' && roundtrip(big) == big, 'BigInt exact: ' + roundtrip(big))
    const re = /ab+c/gi
    const re2 = roundtrip(re)
    assert(re2 instanceof RegExp && re2.source == re.source && re2.flags == re.flags, 'RegExp source+flags')

    console.log('\n[codec] Map (incl nested) & Set')
    const m = new Map<any, any>([['a', 1], ['b', new Map([['x', new Date(0)]])], [10n, 'big-key']])
    const m2 = roundtrip(m)
    assert(m2 instanceof Map && eq(m2, m), 'nested Map round-trip (Date inside, BigInt key)')
    const s = new Set([1, 'two', new Date(5)])
    assert(roundtrip(s) instanceof Set && eq(roundtrip(s), s), 'Set with Date member')

    console.log('\n[codec] Array & plain object')
    assert(eq(roundtrip([1, 'a', new Date(1), [2, 3]]), [1, 'a', new Date(1), [2, 3]]), 'array w/ nested array+Date')
    const obj = { n: 1, s: 'x', when: new Date(7), big: 5n, sub: { ok: true } }
    assert(eq(roundtrip(obj), obj), 'plain object w/ rich leaves')

    console.log('\n[codec] BINARY stays bytes (no base64, byte-equal)')
    const buf = Buffer.from([0, 1, 2, 255, 128, 7])
    const bufR = roundtrip(buf)
    assert(bufR instanceof Uint8Array && eq(bufR, new Uint8Array([0, 1, 2, 255, 128, 7])), 'Buffer survives byte-for-byte')
    // and the encoded form must NOT be a stringified/base64 blob
    const enc = encodeValue(buf)
    assert(enc instanceof Uint8Array, 'encoded Buffer is still raw bytes (not stringified)')

    const u8 = new Uint8Array([9, 8, 7, 0, 254])
    const u8R = roundtrip(u8)
    assert(u8R instanceof Uint8Array && eq(u8R, u8), 'Uint8Array survives byte-for-byte')

    console.log('\n[codec] nested MIX: object + Map + Array + binary + Date + BigInt')
    const mix = {
        price: 100,
        when: new Date('2020-01-02T03:04:05.000Z'),
        nonce: 123456789012345678n,
        balances: new Map<any, any>([['BTC', 1], ['ETH', new Map([['free', 10n]])]]),
        tags: new Set(['a', 'b']),
        chunks: [Buffer.from([1, 2, 3]), new Uint8Array([4, 5, 6])],
        meta: { blob: Buffer.from([255, 0, 255]), note: 'x' },
    }
    const mixR = roundtrip(mix)
    assert(eq(mixR, mix), 'whole nested mix round-trips deeply')
    assert(mixR.chunks[0] instanceof Uint8Array && eq(mixR.chunks[0], new Uint8Array([1, 2, 3])), 'binary inside array survives')
    assert(eq(mixR.meta.blob, new Uint8Array([255, 0, 255])), 'binary inside object survives')
    assert(mixR.balances.get('ETH').get('free') == 10n, 'BigInt deep inside nested Map')

    console.log('\n[codec] collision guard: a plain object that LOOKS like a marker is still rich-decodable only when single-key')
    const tricky = { [DATE_MARKER]: 5, name: 'not-a-date' }   // two keys → ordinary object
    const trickyR = roundtrip(tricky)
    assert(trickyR.name == 'not-a-date' && trickyR[DATE_MARKER] == 5, 'multi-key marker-ish object preserved as object')

    // BUG 1: a SINGLE-key user object whose key collides with a marker but whose
    // payload has the wrong shape must decode as plain data, never throw.
    console.log('\n[codec] single-key marker collision (wrong-shape payload) decodes as plain data')
    const collisions: any[] = [
        { [MAP_MARKER]: 5 },                 // map payload not an array
        { [SET_MARKER]: 'x' },               // set payload not an array
        { [REGEXP_MARKER]: 5 },              // regexp payload not an object w/ source
        { [REGEXP_MARKER]: { source: 7 } },  // source not a string
        { [BIGINT_MARKER]: { nope: 1 } },    // bigint payload not string/number
        { [MAP_MARKER]: { a: 1 } },          // map payload an object, not array
    ]
    for (const c of collisions) {
        let r: any, threw = false
        try { r = roundtrip(c) } catch { threw = true }
        assert(!threw && eq(r, c), 'collision decodes as plain object: ' + JSON.stringify(c))
    }

    // BUG 2: an Invalid Date must round-trip back to an Invalid Date,
    // not silently become epoch 0 (a different VALID date).
    console.log('\n[codec] Invalid Date round-trips to an Invalid Date (not epoch 0)')
    const bad = new Date('nope')
    assert(isNaN(bad.valueOf()), 'precondition: source is an Invalid Date')
    const badR = roundtrip(bad)
    assert(badR instanceof Date && isNaN(badR.valueOf()), 'Invalid Date stays Invalid (NaN), not 1970-01-01')

    // BUG 3: a $_u8 payload delivered as a Node Buffer (what socket.io does)
    // must decode to a PLAIN Uint8Array — not a Buffer — with identical bytes.
    console.log('\n[codec] $_u8 payload as Buffer decodes to plain Uint8Array')
    const u8Buf = decodeValue({ [BIN_MARKER]: Buffer.from([3, 1, 4, 1, 5]) })
    assert(u8Buf instanceof Uint8Array && !isBuffer(u8Buf), '$_u8(Buffer) → plain Uint8Array (not Buffer)')
    assert(eq(u8Buf, new Uint8Array([3, 1, 4, 1, 5])), '$_u8(Buffer) keeps identical bytes')

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    process.exit(fails == 0 ? 0 : 1)
}
