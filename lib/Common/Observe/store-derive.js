"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storeDiffPatches = storeDiffPatches;
exports.deriveStore = deriveStore;
const deep_equal_1 = require("../core/deep-equal");
const store_1 = require("./store");
function isPlainRecord(value) {
    if (value == null || typeof value != 'object' || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto == null || proto == Object.prototype;
}
function diffInto(prev, next, path, out) {
    if (Object.is(prev, next))
        return;
    if (isPlainRecord(prev) && isPlainRecord(next)) {
        for (const key of Object.keys(prev)) {
            if (!Object.hasOwn(next, key))
                out.push({ path: [...path, key], exists: false, value: undefined });
        }
        for (const key of Object.keys(next)) {
            if (!Object.hasOwn(prev, key))
                out.push({ path: [...path, key], exists: true, value: next[key] });
            else
                diffInto(prev[key], next[key], [...path, key], out);
        }
        return;
    }
    if ((0, deep_equal_1.compareDeepValues)(prev, next))
        return;
    out.push({ path, exists: true, value: next });
}
function storeDiffPatches(prev, next) {
    const out = [];
    if (prev === undefined)
        out.push({ path: [], exists: true, value: next });
    else
        diffInto(prev, next, [], out);
    return out;
}
function deriveStore(source, project, opts = {}) {
    const keys = opts.keys ? new Set(opts.keys) : null;
    let current = project(source.snapshot());
    const store = (0, store_1.createStore)(current);
    let recomputes = 0;
    let emitted = 0;
    let skipped = 0;
    function touches(patches) {
        if (!keys)
            return true;
        for (const patch of patches) {
            if (patch.path.length == 0 || keys.has(patch.path[0]))
                return true;
        }
        return false;
    }
    const off = (0, store_1.listenStorePatches)(source).on(function recompute(patches) {
        if (!touches(patches)) {
            skipped++;
            return;
        }
        recomputes++;
        const next = project(source.snapshot());
        const diff = storeDiffPatches(current, next);
        current = next;
        if (diff.length == 0)
            return;
        emitted += diff.length;
        (0, store_1.applyStorePatches)(store, diff);
    });
    return {
        store,
        stats: () => ({ recomputes, emitted, skipped }),
        close: off,
    };
}
