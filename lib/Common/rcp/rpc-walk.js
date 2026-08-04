"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCA = exports.errToObj = exports.RESERVED_MARKER_KEYS = exports.ROW_MARKER = void 0;
exports.reservedMarkerKeyOf = reservedMarkerKeyOf;
exports.walk = walk;
exports.pack = pack;
exports.packResult = packResult;
exports.createRpcCallbackWrapper = createRpcCallbackWrapper;
exports.rpcEndCallback = rpcEndCallback;
exports.unpack = unpack;
exports.unpackResult = unpackResult;
const rpc_limits_1 = require("./rpc-limits");
const rpc_protocol_1 = require("./rpc-protocol");
const rpc_flow_1 = require("./rpc-flow");
const FN_MARKER = "$_f";
const DATE_MARKER = "$_d";
const MAP_MARKER = "$_m";
const SET_MARKER = "$_s";
const REGEXP_MARKER = "$_r";
const BIGINT_MARKER = "$_b";
const ALL_MARKERS = new Set([FN_MARKER, DATE_MARKER, MAP_MARKER, SET_MARKER, REGEXP_MARKER, BIGINT_MARKER]);
exports.ROW_MARKER = "$_t";
exports.RESERVED_MARKER_KEYS = new Set([...ALL_MARKERS, exports.ROW_MARKER]);
function reservedMarkerKeyOf(value) {
    if (value == null || typeof value != "object" || Array.isArray(value))
        return undefined;
    const keys = Object.keys(value);
    return keys.length == 1 && exports.RESERVED_MARKER_KEYS.has(keys[0]) ? keys[0] : undefined;
}
const deepSerialize = (v, onReserved) => walk(v, l => serializeLeaf(l, onReserved), undefined, 0, undefined, onReserved);
const deepDeserialize = (v, lim) => walk(v, l => deserializeLeaf(l, undefined, lim), lim);
const BIGINT_TEXT = /^-?\d+$/;
const isEntryList = (v) => Array.isArray(v) && v.every(e => Array.isArray(e) && e.length == 2);
const isRegExpParts = (v) => v != null && typeof v == "object" && typeof v.source == "string" && typeof v.flags == "string";
const DESERIALIZERS = {
    [DATE_MARKER]: (v) => typeof v == "number" ? { value: new Date(v) }
        : v === null ? { value: new Date(NaN) } : null,
    [MAP_MARKER]: (v, lim) => isEntryList(v)
        ? { value: new Map(v.map(([k, val]) => [deepDeserialize(k, lim), deepDeserialize(val, lim)])) }
        : null,
    [SET_MARKER]: (v, lim) => Array.isArray(v) ? { value: new Set(v.map((x) => deepDeserialize(x, lim))) } : null,
    [REGEXP_MARKER]: (v) => {
        if (!isRegExpParts(v))
            return null;
        try {
            return { value: new RegExp(v.source, v.flags) };
        }
        catch {
            return null;
        }
    },
    [BIGINT_MARKER]: (v) => typeof v == "string" && BIGINT_TEXT.test(v) ? { value: BigInt(v) } : null,
};
const SERIALIZERS = [
    (v) => v instanceof Date ? [DATE_MARKER, v.valueOf()] : null,
    (v, r) => v instanceof Map ? [MAP_MARKER, Array.from(v.entries(), ([k, val]) => [deepSerialize(k, r), deepSerialize(val, r)])] : null,
    (v, r) => v instanceof Set ? [SET_MARKER, Array.from(v.values(), (x) => deepSerialize(x, r))] : null,
    (v) => v instanceof RegExp ? [REGEXP_MARKER, { source: v.source, flags: v.flags }] : null,
    (v) => typeof v === "bigint" ? [BIGINT_MARKER, v.toString()] : null,
];
function binaryByteLength(v) {
    if (ArrayBuffer.isView(v))
        return v.byteLength;
    if (v instanceof ArrayBuffer)
        return v.byteLength;
    return null;
}
function walk(val, onLeaf, lim, depth = 0, rows, onReserved) {
    if (lim) {
        if (depth > lim.maxDepth)
            throw new rpc_limits_1.PayloadLimitError("max depth exceeded");
        if (typeof val == "string" && val.length > lim.maxStringLen)
            throw new rpc_limits_1.PayloadLimitError("string too long");
    }
    if (val == null || typeof val !== "object")
        return onLeaf(val);
    const bin = binaryByteLength(val);
    if (bin != null) {
        if (lim && bin > lim.maxBinaryLen)
            throw new rpc_limits_1.PayloadLimitError("binary too long");
        return val;
    }
    if (val instanceof Date || val instanceof Map || val instanceof Set || val instanceof RegExp)
        return onLeaf(val);
    const ks0 = Object.keys(val);
    if (rows?.decode && ks0.length === 1 && ks0[0] === exports.ROW_MARKER) {
        function decodeRowValue(v, d) { return walk(v, onLeaf, lim, d, rows, onReserved); }
        const table = rows.decode(val[exports.ROW_MARKER], decodeRowValue, depth);
        if (table)
            return table.value;
    }
    if (ks0.length === 1 && ALL_MARKERS.has(ks0[0])) {
        if (onReserved)
            onReserved(ks0[0], val);
        return onLeaf(val);
    }
    if (onReserved && ks0.length === 1 && ks0[0] === exports.ROW_MARKER)
        onReserved(exports.ROW_MARKER, val);
    if (Array.isArray(val)) {
        if (lim && val.length > lim.maxArrayLen)
            throw new rpc_limits_1.PayloadLimitError("array too long");
        function packRowValue(v) { return walk(v, onLeaf, lim, depth + 2, rows, onReserved); }
        const table = rows?.encode?.(val, packRowValue);
        if (table)
            return { [exports.ROW_MARKER]: table };
        return val.map(v => walk(v, onLeaf, lim, depth + 1, rows, onReserved));
    }
    const keys = Object.keys(val);
    if (lim && keys.length > lim.maxKeys)
        throw new rpc_limits_1.PayloadLimitError("too many keys in object");
    const o = {};
    for (const k of keys)
        if ((0, rpc_limits_1.isSafeKey)(k))
            o[k] = walk(val[k], onLeaf, lim, depth + 1, rows, onReserved);
    return o;
}
function deserializeLeaf(leaf, onCallback, lim) {
    if (leaf == null || typeof leaf !== "object")
        return leaf;
    const key = Object.keys(leaf)[0];
    if (!key)
        return leaf;
    if (key === FN_MARKER) {
        return onCallback?.(leaf[FN_MARKER]) ?? leaf;
    }
    const deserialize = DESERIALIZERS[key];
    if (!deserialize)
        return leaf;
    const restored = deserialize(leaf[key], lim);
    return restored ? restored.value : leaf;
}
function serializeLeaf(leaf, onReserved) {
    for (const serializer of SERIALIZERS) {
        const result = serializer(leaf, onReserved);
        if (result)
            return { [result[0]]: result[1] };
    }
    return leaf;
}
function pack(args, pool, cbStore, cbIds, onReserved) {
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
function packResult(value, rows, onReserved) {
    return walk(value, leaf => serializeLeaf(leaf, onReserved), undefined, 0, rows, onReserved);
}
const _stopRegistry = new WeakMap();
function createRpcCallbackWrapper({ id, sender, onEnd, legacyStopSentinel = false, }) {
    function rpcCallbackWrapper(...args) {
        if (legacyStopSentinel && args[0] === rpc_protocol_1.RPC_STOP) {
            onEnd(id);
            return;
        }
        sender(id, args);
    }
    _stopRegistry.set(rpcCallbackWrapper, function endRpcCallbackWrapper() { onEnd(id); });
    return rpcCallbackWrapper;
}
function rpcEndCallback(fn) {
    _stopRegistry.get(fn)?.();
}
function unpack(args, sender, onEnd, lim, flowHost) {
    if (lim && args.length > lim.maxArgs)
        throw new rpc_limits_1.PayloadLimitError("too many args");
    let cbCount = 0;
    return args.map(v => walk(v, leaf => {
        if (leaf != null && typeof leaf == "object" && leaf[FN_MARKER] !== undefined) {
            if (lim && ++cbCount > lim.maxCallbacks)
                throw new rpc_limits_1.PayloadLimitError("too many callbacks");
            const id = leaf[FN_MARKER];
            if (typeof id !== "number" || !Number.isFinite(id))
                throw new rpc_limits_1.PayloadLimitError("invalid callback id");
            const wrapper = createRpcCallbackWrapper({
                id,
                sender,
                onEnd,
                legacyStopSentinel: true,
            });
            if (flowHost)
                (0, rpc_flow_1.registerRpcFlowHost)(wrapper, flowHost(id));
            return wrapper;
        }
        return deserializeLeaf(leaf, undefined, lim);
    }, lim));
}
function unpackResult(value, lim, rows) {
    return walk(value, leaf => deserializeLeaf(leaf, undefined, lim), lim, 0, rows);
}
const errToObj = (e) => {
    if (!(e instanceof Error))
        return e;
    const o = { name: e.name, message: e.message, stack: e.stack };
    const { code, data, cause } = e;
    if (code !== undefined)
        o.code = code;
    if (data !== undefined)
        o.data = packResult(data);
    if (cause !== undefined)
        o.cause = (0, exports.errToObj)(cause);
    return o;
};
exports.errToObj = errToObj;
const resolveCA = (path, args) => {
    const last = path[path.length - 1];
    if (last == "call")
        return [path.slice(0, -1), args.slice(1)];
    if (last == "apply")
        return [path.slice(0, -1), args[1] ?? []];
    return [path, args];
};
exports.resolveCA = resolveCA;
