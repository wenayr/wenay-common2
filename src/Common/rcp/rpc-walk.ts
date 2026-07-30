import { idPool } from "../id-pool";
import { isSafeKey, PayloadLimitError, type RpcLimits } from "./rpc-limits";
import { RPC_STOP } from "./rpc-protocol";

const FN_MARKER     = "$_f";
const DATE_MARKER   = "$_d";
const MAP_MARKER    = "$_m";
const SET_MARKER    = "$_s";
const REGEXP_MARKER = "$_r";
const BIGINT_MARKER = "$_b";

const ALL_MARKERS = new Set([FN_MARKER, DATE_MARKER, MAP_MARKER, SET_MARKER, REGEXP_MARKER, BIGINT_MARKER]);

// Row/table wrapper of an array of uniform records: {"$_t": [shapeId, rows, keys]}. The keys
// travel with EVERY table on purpose — rpc-shape.ts says why: a form that only referenced a
// previously declared shape cannot survive a packet the decoder legitimately drops, and it
// would save 63 B out of ~71 000. The shapeId names the sender's registry entry and is not
// what the keys are read from. Deliberately NOT in
// ALL_MARKERS: without a codec the walker must keep treating such an object exactly as it
// does today (ordinary recursion), so a peer that did not negotiate Caps.ROWS sees the wire
// unchanged down to the byte. Reserved key space, like every other $_ marker above: an
// application value that is itself a single-key {"$_t": …} is the library's, not the
// application's — the same contract that already turns {"$_d": 5} into a Date.
export const ROW_MARKER = "$_t";

// ============================================================
// The reserved-key contract
// ============================================================
// These seven keys are the codec's, in ONE position: the SINGLE key of a plain object. An
// object with any other key count is application data and always was — {"$_d": 5, name: "x"}
// round-trips untouched. An object whose only key is one of these is read as the library's
// value by a peer that understands it, so an application must not produce one. The rule is
// about the OBJECT and not about where it sits: burying it deeper does not help, because the
// walker reaches every level and the reserved object is still reserved there. The only
// escapes are a second key on that object, or not using these keys at all.
//
// Two further consequences of stopping the walk at a reserved key, and they are symmetric on
// both sides so identity is preserved for a value the decoder declines: the payload UNDER such
// a key is not walked, so a Date/Map/Set/RegExp/BigInt nested inside it is not marked on the
// way out and does not come back; and the key filter that drops __proto__/constructor is not
// applied inside it either.
export const RESERVED_MARKER_KEYS: ReadonlySet<string> = new Set([...ALL_MARKERS, ROW_MARKER]);

/** The reserved key this value collides with, or undefined. The check an application needs to
 *  answer "is this object of mine going to be read as a library value?" — same test the
 *  encoder makes, exported so a consumer does not have to reimplement the codec to be safe. */
export function reservedMarkerKeyOf(value: any) {
    if (value == null || typeof value != "object" || Array.isArray(value)) return undefined;
    const keys = Object.keys(value);
    return keys.length == 1 && RESERVED_MARKER_KEYS.has(keys[0]) ? keys[0] : undefined;
}

/** Encode-side report that an APPLICATION value occupies a reserved key. Decidable only here:
 *  going OUT, a plain object under a marker key is by construction not one of ours (a real
 *  Date/Map/Set/RegExp is taken by identity before this test), while coming IN the two are
 *  indistinguishable by definition. Wired to the `debug` flag of both factories. */
export type tReservedKeyReport = (key: string, value: any) => void

/** Registry-backed codec for ROW_MARKER. Absent = today's walker, byte for byte. */
export type tRowCodec = {
    /** Encode: the marker payload for an array of uniform records, or null to walk it normally. */
    encode?: (arr: any[], packValue: (v: any) => any) => any[] | null;
    /** Decode: {value} for a real table, or null when the payload is not one. Throws on a
     *  table that disagrees with its shape or with the limits. */
    decode?: (
        payload: any,
        decodeValue: (v: any, depth: number) => any,
        depth: number,
    ) => {value: any} | null;
};

// Nested values inside Map/Set also undergo (de)serialization recursively —
// else Date/Map inside Map pass raw and perish on JSON transport. The reporter travels with
// them: a colliding object inside a Map value corrupts on the far side exactly like one at the
// top level, so it must be visible exactly like one.
const deepSerialize = (v: any, onReserved?: tReservedKeyReport): any =>
    walk(v, l => serializeLeaf(l, onReserved), undefined, 0, undefined, onReserved);
const deepDeserialize = (v: any, lim?: Required<RpcLimits>): any =>
    walk(v, l => deserializeLeaf(l, undefined, lim), lim);

// ============================================================
// Marker RECOGNITION — as narrow as the payload its own serializer emits
// ============================================================
// A reserved key alone does NOT make a value ours. Each recognizer accepts exactly what the
// matching serializer below produces and declines everything else with null; a declined payload
// stays the ordinary object the wire carried. This costs no compatibility and needs no
// capability bit: no version of this encoder has ever emitted a payload that fails these tests,
// so every conforming peer — old or new — restores exactly the values it always did, and the
// bytes going OUT are untouched. What it removes is the failure that was neither ours nor
// recoverable: {"$_b":"x"} threw a SyntaxError and {"$_m":5} a TypeError straight out of the
// decoder, rejecting a whole response over an application value that borrowed a key, while
// {"$_r":5} quietly became /(?:)/.
const BIGINT_TEXT = /^-?\d+$/;

const isEntryList = (v: any) => Array.isArray(v) && v.every(e => Array.isArray(e) && e.length == 2);
const isRegExpParts = (v: any) =>
    v != null && typeof v == "object" && typeof v.source == "string" && typeof v.flags == "string";

// Marker → recognizer. {value} = ours; null = not ours, keep the object as it arrived.
const DESERIALIZERS: Record<string, (v: any, lim?: Required<RpcLimits>) => {value: any} | null> = {
    // JSON.stringify writes null for the NaN of an Invalid Date, so null IS this encoder's own
    // output for one and comes back as an Invalid Date — it used to come back as the epoch.
    [DATE_MARKER]:   (v) => typeof v == "number" ? {value: new Date(v)}
        : v === null ? {value: new Date(NaN)} : null,
    [MAP_MARKER]:    (v, lim) => isEntryList(v)
        ? {value: new Map(v.map(([k, val]: [any, any]) => [deepDeserialize(k, lim), deepDeserialize(val, lim)]))}
        : null,
    [SET_MARKER]:    (v, lim) => Array.isArray(v) ? {value: new Set(v.map((x: any) => deepDeserialize(x, lim)))} : null,
    // A RegExp rebuilt from its OWN source/flags cannot throw; a peer's can, and a throw here
    // would reject the packet instead of the value. Unparseable = not ours.
    [REGEXP_MARKER]: (v) => {
        if (!isRegExpParts(v)) return null;
        try { return {value: new RegExp(v.source, v.flags)} } catch { return null }
    },
    [BIGINT_MARKER]: (v) => typeof v == "string" && BIGINT_TEXT.test(v) ? {value: BigInt(v)} : null,
};

// Type → serializer mapping (pairs [marker, value]). The second parameter is the collision
// reporter, needed only by the two that recurse.
type Serializer = (v: any, onReserved?: tReservedKeyReport) => [string, any] | null;

const SERIALIZERS: Serializer[] = [
    (v) => v instanceof Date    ? [DATE_MARKER,   v.valueOf()]                          : null,
    (v, r) => v instanceof Map  ? [MAP_MARKER,    Array.from(v.entries(), ([k, val]: [any, any]) => [deepSerialize(k, r), deepSerialize(val, r)])] : null,
    (v, r) => v instanceof Set  ? [SET_MARKER,    Array.from(v.values(), (x: any) => deepSerialize(x, r))] : null,
    (v) => v instanceof RegExp  ? [REGEXP_MARKER, { source: v.source, flags: v.flags }] : null,
    (v) => typeof v === "bigint" ? [BIGINT_MARKER, v.toString()]                        : null,
];

// Binary leaf: TypedArray/DataView/Buffer (isView) and bare ArrayBuffer.
// null = not binary; number = byteLength (for limit).
function binaryByteLength(v: any): number | null {
    if (ArrayBuffer.isView(v)) return v.byteLength;
    if (v instanceof ArrayBuffer) return v.byteLength;
    return null;
}

export function walk(
    val: any,
    onLeaf: (v: any) => any,
    lim?: Required<RpcLimits>,
    depth = 0,
    rows?: tRowCodec,
    onReserved?: tReservedKeyReport,
): any {
    if (lim) {
        if (depth > lim.maxDepth) throw new PayloadLimitError("max depth exceeded");
        if (typeof val == "string" && val.length > lim.maxStringLen) throw new PayloadLimitError("string too long");
    }
    if (val == null || typeof val !== "object") return onLeaf(val);
    // Binary — passthrough BYPASSING onLeaf and BEFORE Object.keys: socket.io carries it natively,
    // no (de)serializer marks binary (identity by design), and Object.keys on a large buffer
    // is an array of millions of string-keys ({0:…,1:…} bloat, which we fix here).
    // Byte ceiling check — that's all we need.
    const bin = binaryByteLength(val);
    if (bin != null) {
        if (lim && bin > lim.maxBinaryLen) throw new PayloadLimitError("binary too long");
        return val;
    }
    // If object already packed with marker — pass as-is to onLeaf
    if (val instanceof Date || val instanceof Map || val instanceof Set || val instanceof RegExp) return onLeaf(val);

    // Packed leaf is ALWAYS an object with one marker key ({ $_d: ... }).
    // Previously checked only first key → regular object whose first key happened to match
    // marker ({ $_d: 5, name: "x" }) was mistaken for leaf and lost other keys.
    // Require exactly one key — multi-key objects go to normal recursion.
    const ks0 = Object.keys(val);
    // A table is unwrapped BEFORE the marker set: it is not in ALL_MARKERS on purpose, so
    // without a codec this object falls through to ordinary recursion exactly as before.
    if (rows?.decode && ks0.length === 1 && ks0[0] === ROW_MARKER) {
        function decodeRowValue(v: any, d: number) { return walk(v, onLeaf, lim, d, rows, onReserved); }
        const table = rows.decode(val[ROW_MARKER], decodeRowValue, depth);
        if (table) return table.value;
    }
    if (ks0.length === 1 && ALL_MARKERS.has(ks0[0])) {
        // ENCODE side only, and exactly here: a real Date/Map/Set/RegExp was taken by identity
        // above, so a PLAIN object reaching this branch on the way out is application data that
        // the peer will read back as a library type. Only a packer passes onReserved, and when
        // nobody listens this is one register test on a branch colliding values alone enter.
        if (onReserved) onReserved(ks0[0], val);
        return onLeaf(val);
    }
    // $_t is deliberately outside ALL_MARKERS (a peer without Caps.ROWS must recurse into such
    // an object), so its collision is not covered by the branch above and is spotted here.
    if (onReserved && ks0.length === 1 && ks0[0] === ROW_MARKER) onReserved(ROW_MARKER, val);
    if (Array.isArray(val)) {
        if (lim && val.length > lim.maxArrayLen) throw new PayloadLimitError("array too long");
        // Records live one level below the array and their values one below that, so a row
        // value keeps the depth it would have had as {…}[] — the limit cannot be dodged by
        // flattening the array into a table.
        function packRowValue(v: any) { return walk(v, onLeaf, lim, depth + 2, rows, onReserved); }
        const table = rows?.encode?.(val, packRowValue);
        if (table) return {[ROW_MARKER]: table};
        return val.map(v => walk(v, onLeaf, lim, depth + 1, rows, onReserved));
    }
    const keys = Object.keys(val);
    if (lim && keys.length > lim.maxKeys) throw new PayloadLimitError("too many keys in object");
    const o: any = {};
    for (const k of keys) if (isSafeKey(k)) o[k] = walk(val[k], onLeaf, lim, depth + 1, rows, onReserved);
    return o;
}

// Common leaf deserialization function (used in unpack and unpackResult)
function deserializeLeaf(leaf: any, onCallback?: (id: number) => any, lim?: Required<RpcLimits>): any {
    if (leaf == null || typeof leaf !== "object") return leaf;
    const key = Object.keys(leaf)[0];
    if (!key) return leaf;

    if (key === FN_MARKER) {
        return onCallback?.(leaf[FN_MARKER]) ?? leaf;
    }

    const deserialize = DESERIALIZERS[key];
    if (!deserialize) return leaf;
    // Declined payload → this was never one of ours: hand back the object the wire carried,
    // which is exactly what a peer that does not know the marker at all would have produced.
    const restored = deserialize(leaf[key], lim);
    return restored ? restored.value : leaf;
}

// Common leaf serialization function (used in pack and packResult)
function serializeLeaf(leaf: any, onReserved?: tReservedKeyReport): any {
    for (const serializer of SERIALIZERS) {
        const result = serializer(leaf, onReserved);
        if (result) return { [result[0]]: result[1] };
    }
    return leaf;
}

export function pack(
    args: any[],
    pool: idPool,
    cbStore: Map<number, Function>,
    cbIds: number[],
    onReserved?: tReservedKeyReport,
): any[] {
    return args.map(v => walk(v, leaf => {
        if (typeof leaf == "function") {
            const id = pool.next();
            cbStore.set(id, leaf);
            cbIds.push(id);
            return { [FN_MARKER]: id };
        }
        return serializeLeaf(leaf, onReserved);
    }, undefined, 0, undefined, onReserved));
}

export function packResult(value: any, rows?: tRowCodec, onReserved?: tReservedKeyReport): any {
    return walk(value, leaf => serializeLeaf(leaf, onReserved), undefined, 0, rows, onReserved);
}

const _stopRegistry = new WeakMap<Function, () => void>();

export function createRpcCallbackWrapper({
    id,
    sender,
    onEnd,
    legacyStopSentinel = false,
}: {
    id: number
    sender: (id: number, args: any[]) => void
    onEnd: (id: number) => void
    legacyStopSentinel?: boolean
}) {
    function rpcCallbackWrapper(...args: any[]) {
        // Only the JSON-compatible path treats the historical string sentinel as
        // control. Binary has an out-of-band CB_END and must carry this string as data.
        if (legacyStopSentinel && args[0] === RPC_STOP) {
            onEnd(id)
            return
        }
        sender(id, args)
    }
    _stopRegistry.set(rpcCallbackWrapper, function endRpcCallbackWrapper() { onEnd(id) })
    return rpcCallbackWrapper
}

export function rpcEndCallback(fn: Function) {
    _stopRegistry.get(fn)?.();
}

export function unpack(
    args: any[],
    sender: (id: number, a: any[]) => void,
    onEnd: (id: number) => void,
    lim?: Required<RpcLimits>,
): any[] {
    if (lim && args.length > lim.maxArgs) throw new PayloadLimitError("too many args");
    let cbCount = 0;
    return args.map(v => walk(v, leaf => {
        if (leaf != null && typeof leaf == "object" && leaf[FN_MARKER] !== undefined) {
            if (lim && ++cbCount > lim.maxCallbacks) throw new PayloadLimitError("too many callbacks");
            const id = leaf[FN_MARKER];
            if (typeof id !== "number" || !Number.isFinite(id)) throw new PayloadLimitError("invalid callback id");
            return createRpcCallbackWrapper({
                id,
                sender,
                onEnd,
                legacyStopSentinel: true,
            });
        }
        return deserializeLeaf(leaf, undefined, lim);
    }, lim));
}

export function unpackResult(value: any, lim?: Required<RpcLimits>, rows?: tRowCodec): any {
    return walk(value, leaf => deserializeLeaf(leaf, undefined, lim), lim, 0, rows);
}

// code/data/cause — additive wire fields: old clients simply ignore them,
// new ones restore MyError (see reviveErr in rpc-client).
export const errToObj = (e: any): any => {
    if (!(e instanceof Error)) return e;
    const o: any = { name: e.name, message: e.message, stack: e.stack };
    const { code, data, cause } = e as any;
    if (code !== undefined) o.code = code;
    // pack data with same rich-walk as normal result: else BigInt/Date/Map/Set
    // inside data go raw to JSON.stringify on error emit → throw INSIDE catch →
    // escapes RPC try/catch → connection killed. Symmetrically unpacked in reviveErr.
    // For plain-JSON data packResult — identity (no markers), old peers byte-for-byte.
    if (data !== undefined) o.data = packResult(data);
    if (cause !== undefined) o.cause = errToObj(cause);
    return o;
};

export const resolveCA = (path: string[], args: any[]): [string[], any[]] => {
    const last = path[path.length - 1];
    if (last == "call") return [path.slice(0, -1), args.slice(1)];
    if (last == "apply") return [path.slice(0, -1), args[1] ?? []];
    return [path, args];
};
