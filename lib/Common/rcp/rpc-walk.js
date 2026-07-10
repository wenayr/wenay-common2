"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCA = exports.errToObj = void 0;
exports.walk = walk;
exports.pack = pack;
exports.packResult = packResult;
exports.rpcEndCallback = rpcEndCallback;
exports.unpack = unpack;
exports.unpackResult = unpackResult;
const rpc_limits_1 = require("./rpc-limits");
const rpc_protocol_1 = require("./rpc-protocol");
const FN_MARKER = "$_f";
const DATE_MARKER = "$_d";
const MAP_MARKER = "$_m";
const SET_MARKER = "$_s";
const REGEXP_MARKER = "$_r";
const BIGINT_MARKER = "$_b";
const ALL_MARKERS = new Set([FN_MARKER, DATE_MARKER, MAP_MARKER, SET_MARKER, REGEXP_MARKER, BIGINT_MARKER]);
const deepSerialize = (v) => walk(v, serializeLeaf);
const deepDeserialize = (v, lim) => walk(v, l => deserializeLeaf(l, undefined, lim), lim);
const DESERIALIZERS = {
    [DATE_MARKER]: (v) => new Date(v),
    [MAP_MARKER]: (v, lim) => new Map(v.map(([k, val]) => [deepDeserialize(k, lim), deepDeserialize(val, lim)])),
    [SET_MARKER]: (v, lim) => new Set(v.map((x) => deepDeserialize(x, lim))),
    [REGEXP_MARKER]: (v) => new RegExp(v.source, v.flags),
    [BIGINT_MARKER]: (v) => BigInt(v),
};
const SERIALIZERS = [
    (v) => v instanceof Date ? [DATE_MARKER, v.valueOf()] : null,
    (v) => v instanceof Map ? [MAP_MARKER, Array.from(v.entries(), ([k, val]) => [deepSerialize(k), deepSerialize(val)])] : null,
    (v) => v instanceof Set ? [SET_MARKER, Array.from(v.values(), (x) => deepSerialize(x))] : null,
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
function walk(val, onLeaf, lim, depth = 0) {
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
    if (ks0.length === 1 && ALL_MARKERS.has(ks0[0]))
        return onLeaf(val);
    if (Array.isArray(val)) {
        if (lim && val.length > lim.maxArrayLen)
            throw new rpc_limits_1.PayloadLimitError("array too long");
        return val.map(v => walk(v, onLeaf, lim, depth + 1));
    }
    const keys = Object.keys(val);
    if (lim && keys.length > lim.maxKeys)
        throw new rpc_limits_1.PayloadLimitError("too many keys in object");
    const o = {};
    for (const k of keys)
        if ((0, rpc_limits_1.isSafeKey)(k))
            o[k] = walk(val[k], onLeaf, lim, depth + 1);
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
    return deserialize ? deserialize(leaf[key], lim) : leaf;
}
function serializeLeaf(leaf) {
    for (const serializer of SERIALIZERS) {
        const result = serializer(leaf);
        if (result)
            return { [result[0]]: result[1] };
    }
    return leaf;
}
function pack(args, pool, cbStore, cbIds) {
    return args.map(v => walk(v, leaf => {
        if (typeof leaf == "function") {
            const id = pool.next();
            cbStore.set(id, leaf);
            cbIds.push(id);
            return { [FN_MARKER]: id };
        }
        return serializeLeaf(leaf);
    }));
}
function packResult(value) {
    return walk(value, leaf => serializeLeaf(leaf));
}
const _stopRegistry = new WeakMap();
function rpcEndCallback(fn) {
    _stopRegistry.get(fn)?.();
}
function unpack(args, sender, onEnd, lim) {
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
            const wrapper = (...a) => {
                if (a[0] == rpc_protocol_1.RPC_STOP) {
                    onEnd(id);
                    return;
                }
                sender(id, a);
            };
            _stopRegistry.set(wrapper, () => onEnd(id));
            return wrapper;
        }
        return deserializeLeaf(leaf, undefined, lim);
    }, lim));
}
function unpackResult(value, lim) {
    return walk(value, leaf => deserializeLeaf(leaf, undefined, lim), lim);
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
