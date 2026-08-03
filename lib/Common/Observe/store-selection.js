"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeStoreSelectionKeys = normalizeStoreSelectionKeys;
exports.storeSelectionId = storeSelectionId;
function normalizeStoreSelectionKeys(keys, label) {
    if (!Array.isArray(keys))
        throw new TypeError(label + ': keys must be an array');
    const unique = new Set();
    for (const key of keys) {
        if (typeof key != 'string') {
            throw new TypeError(label + ': keys must contain only strings');
        }
        unique.add(key);
    }
    return Object.freeze([...unique].sort());
}
function storeSelectionId(keys) {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (const key of keys) {
        const text = key.length + ':' + key + ';';
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            first = Math.imul(first ^ code, 0x01000193);
            second = Math.imul(second ^ code, 0x85ebca6b);
        }
    }
    const hex = (value) => (value >>> 0).toString(16).padStart(8, '0');
    return 'keys-v1:' + keys.length + ':' + hex(first) + hex(second);
}
