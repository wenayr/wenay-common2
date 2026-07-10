"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompareKeys = CompareKeys;
exports.CompareKeys2 = CompareKeys2;
exports.DeepCompareKeys2 = DeepCompareKeys2;
exports.DeepCompareKeys = DeepCompareKeys;
const isProxy_1 = require("../isProxy");
function isLeafValue(value) {
    return (value == null ||
        typeof value === "function" ||
        value instanceof Function ||
        typeof value !== "object" ||
        (0, isProxy_1.isProxy)(value));
}
function CompareKeys(obj1, obj2) {
    return CompareKeys2(obj1, Object.keys(obj2));
}
function CompareKeys2(obj1, keys) {
    const k1 = Object.keys(obj1);
    return k1.length === keys.length && new Set([...k1, ...keys]).size === keys.length;
}
function DeepCompareKeys2(obj1, keys, func) {
    if (isLeafValue(obj1))
        return obj1;
    if (CompareKeys2(obj1, keys))
        return func(obj1);
    if (Array.isArray(obj1))
        return obj1.map((v) => DeepCompareKeys2(v, keys, func));
    return Object.fromEntries(Object.entries(obj1).map(([k, v]) => [k, DeepCompareKeys2(v, keys, func)]));
}
function DeepCompareKeys(obj1, obj2, func) {
    if (isLeafValue(obj1))
        return obj1;
    const keys = Object.keys(obj2);
    if (CompareKeys2(obj1, keys))
        return func(obj1);
    if (Array.isArray(obj1))
        return obj1.map((v) => DeepCompareKeys2(v, keys, func));
    return Object.fromEntries(Object.entries(obj1).map(([k, v]) => [k, DeepCompareKeys2(v, keys, func)]));
}
