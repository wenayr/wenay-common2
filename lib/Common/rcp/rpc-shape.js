"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPlainObject = isPlainObject;
exports.createCbShapeServer = createCbShapeServer;
exports.createShapeRegistry = createShapeRegistry;
exports.createShapeDecoder = createShapeDecoder;
exports.createRowEncoder = createRowEncoder;
exports.createRowDecoder = createRowDecoder;
const rpc_limits_1 = require("./rpc-limits");
const THRESHOLD = 5;
const MAX_SHAPES = 5;
function isPlainObject(v) {
    if (v == null || typeof v != "object")
        return false;
    if (Array.isArray(v) || v instanceof Date || v instanceof Map || v instanceof Set || v instanceof RegExp)
        return false;
    const p = Object.getPrototypeOf(v);
    return p == null || p == Object.prototype;
}
function createCbShapeServer(threshold = THRESHOLD, maxShapes = MAX_SHAPES) {
    const byCb = new Map();
    function offer(cbId, obj) {
        const keys = Object.keys(obj);
        if (!keys.every(rpc_limits_1.isSafeKey))
            return { mode: 'full' };
        const sig = JSON.stringify(keys.slice().sort());
        let st = byCb.get(cbId);
        if (!st) {
            st = { shapes: [], nextId: 0 };
            byCb.set(cbId, st);
        }
        const sh = st.shapes.find(s => s.sig == sig);
        if (sh) {
            sh.count++;
            if (sh.shapeId >= 0)
                return { mode: "compact", shapeId: sh.shapeId, keys: sh.keys };
            if (sh.count >= threshold) {
                sh.shapeId = st.nextId++;
                return { mode: "register", shapeId: sh.shapeId, keys: sh.keys };
            }
            return { mode: "full" };
        }
        if (st.shapes.length < maxShapes)
            st.shapes.push({ sig, keys, count: 1, shapeId: -1 });
        return { mode: "full" };
    }
    function drop(cbId) { byCb.delete(cbId); }
    return { offer, drop };
}
const ROW_MIN_ROWS = 4;
const REGISTRY_MAX_SHAPES = 64;
const REGISTRY_MAX_CANDIDATES = 64;
const DECODER_MAX_SHAPES = 256;
function evictOldest(m, max) {
    while (m.size >= max) {
        const oldest = m.keys().next();
        if (oldest.done)
            return;
        m.delete(oldest.value);
    }
}
function createShapeRegistry(threshold = THRESHOLD, maxShapes = REGISTRY_MAX_SHAPES, minRows = ROW_MIN_ROWS) {
    const registered = new Map();
    const candidates = new Map();
    let nextId = 0;
    const signature = (keys) => JSON.stringify(keys.slice().sort());
    function safeKeys(obj) {
        const keys = Object.keys(obj);
        return keys.every(rpc_limits_1.isSafeKey) ? keys : null;
    }
    function touch(sh) {
        registered.delete(sh.sig);
        registered.set(sh.sig, sh);
    }
    let lastKeys = null;
    let lastShape = null;
    function sameKeys(a, b) {
        if (a.length != b.length)
            return false;
        for (let i = 0; i < a.length; i++)
            if (a[i] !== b[i])
                return false;
        return true;
    }
    function register(sig, keys) {
        evictOldest(registered, maxShapes);
        candidates.delete(sig);
        const sh = { sig, keys, id: nextId++, declared: new Set() };
        registered.set(sig, sh);
        return sh;
    }
    function countCandidate(sig) {
        const seen = (candidates.get(sig) ?? 0) + 1;
        candidates.delete(sig);
        evictOldest(candidates, REGISTRY_MAX_CANDIDATES);
        candidates.set(sig, seen);
        return seen;
    }
    function offerTick(sessionId, obj) {
        const raw = Object.keys(obj);
        if (lastShape && lastKeys && sameKeys(raw, lastKeys) && registered.get(lastShape.sig) === lastShape) {
            return declare(lastShape, sessionId);
        }
        const keys = raw.every(rpc_limits_1.isSafeKey) ? raw : null;
        if (!keys)
            return { mode: 'full' };
        const sig = signature(keys);
        let sh = registered.get(sig);
        if (!sh) {
            if (countCandidate(sig) < threshold)
                return { mode: 'full' };
            sh = register(sig, keys);
        }
        lastKeys = keys;
        lastShape = sh;
        return declare(sh, sessionId);
    }
    function declare(sh, sessionId) {
        touch(sh);
        if (sh.declared.has(sessionId))
            return { mode: 'compact', shapeId: sh.id, keys: sh.keys };
        sh.declared.add(sessionId);
        return { mode: 'register', shapeId: sh.id, keys: sh.keys };
    }
    function offerRows(arr) {
        if (arr.length < minRows || !isPlainObject(arr[0]))
            return null;
        const keys = safeKeys(arr[0]);
        if (!keys)
            return null;
        for (let i = 1; i < arr.length; i++) {
            const item = arr[i];
            if (!isPlainObject(item))
                return null;
            const itemKeys = Object.keys(item);
            if (itemKeys.length != keys.length)
                return null;
            for (let k = 0; k < keys.length; k++)
                if (itemKeys[k] != keys[k])
                    return null;
        }
        const sig = signature(keys);
        let sh = registered.get(sig);
        if (sh)
            touch(sh);
        else
            sh = register(sig, keys);
        return { shapeId: sh.id, keys };
    }
    function forgetSession(sessionId) {
        for (const sh of registered.values())
            sh.declared.delete(sessionId);
    }
    return { offerTick, offerRows, forgetSession, size: () => registered.size };
}
function createShapeDecoder(maxShapes = DECODER_MAX_SHAPES) {
    const keysById = new Map();
    function declare(shapeId, keys) {
        keysById.delete(shapeId);
        evictOldest(keysById, maxShapes);
        keysById.set(shapeId, keys);
    }
    function keysOf(shapeId) {
        const keys = keysById.get(shapeId);
        if (!keys)
            return undefined;
        keysById.delete(shapeId);
        keysById.set(shapeId, keys);
        return keys;
    }
    function clear() { keysById.clear(); }
    return { declare, keysOf, clear, size: () => keysById.size };
}
const survivesRowMove = (v) => v !== undefined && typeof v != 'function' && typeof v != 'symbol';
function createRowEncoder(registry) {
    function encode(arr, packValue) {
        const offer = registry.offerRows(arr);
        if (!offer)
            return null;
        const keys = offer.keys;
        const width = keys.length;
        const rows = new Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
            const item = arr[i];
            const row = new Array(width);
            for (let k = 0; k < width; k++) {
                const packed = packValue(item[keys[k]]);
                if (!survivesRowMove(packed))
                    return null;
                row[k] = packed;
            }
            rows[i] = row;
        }
        return [offer.shapeId, rows, keys];
    }
    return { encode };
}
function createRowDecoder(lim) {
    function decode(payload, decodeValue, depth) {
        if (!Array.isArray(payload) || payload.length != 3)
            return null;
        const shapeId = payload[0];
        const rows = payload[1];
        const declared = payload[2];
        if (!Number.isSafeInteger(shapeId) || shapeId < 0 || !Array.isArray(rows) || !Array.isArray(declared))
            return null;
        if (lim && declared.length > lim.maxKeys)
            throw new rpc_limits_1.PayloadLimitError('too many keys in object');
        if (!declared.every((k) => typeof k == 'string' && (0, rpc_limits_1.isSafeKey)(k)))
            throw new rpc_limits_1.PayloadLimitError('unsafe row shape key');
        if (new Set(declared).size != declared.length)
            throw new rpc_limits_1.PayloadLimitError('duplicate row shape key');
        if (lim && rows.length > lim.maxArrayLen)
            throw new rpc_limits_1.PayloadLimitError('array too long');
        const keys = declared;
        const width = keys.length;
        const out = new Array(rows.length);
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!Array.isArray(row) || row.length != width)
                throw new rpc_limits_1.PayloadLimitError('row width does not match its shape');
            const record = {};
            for (let k = 0; k < width; k++)
                record[keys[k]] = decodeValue(row[k], depth + 2);
            out[i] = record;
        }
        return { value: out };
    }
    return { decode };
}
