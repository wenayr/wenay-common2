"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPlainObject = isPlainObject;
exports.createCbShapeServer = createCbShapeServer;
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
