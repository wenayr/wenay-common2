"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchKeys = matchKeys;
exports.matchKeysList = matchKeysList;
exports.deepMapByKeysList = deepMapByKeysList;
exports.deepMapByKeys = deepMapByKeys;
exports.deepListenFirst = deepListenFirst;
exports.deepListenAll = deepListenAll;
exports.deepListenSmart = deepListenSmart;
const Listen_1 = require("../events/Listen");
const listen_socket_1 = require("./listen-socket");
function isLeafValue(value) {
    return (value == null ||
        typeof value === "function" ||
        value instanceof Function ||
        typeof value !== "object");
}
function matchKeys(obj1, obj2) {
    return matchKeysList(obj1, Object.keys(obj2));
}
function matchKeysList(obj1, keys) {
    const k1 = Object.keys(obj1);
    return k1.length === keys.length && new Set([...k1, ...keys]).size === keys.length;
}
function deepMapByKeysList(obj1, keys, func) {
    if (isLeafValue(obj1))
        return obj1;
    if (matchKeysList(obj1, keys))
        return func(obj1);
    return Object.fromEntries(Object.entries(obj1).map(([k, v]) => [k, deepMapByKeysList(v, keys, func)]));
}
function deepMapByKeys(obj1, obj2, func) {
    return deepMapByKeysList(obj1, Object.keys(obj2), func);
}
const NOOP_LISTEN = (0, Listen_1.createListen)((_e) => { });
function deepListenFirst(obj, data) {
    return deepMapByKeys(obj, NOOP_LISTEN, (e) => (0, listen_socket_1.listenSocketFirst)(e, data));
}
function deepListenAll(obj, data) {
    return deepMapByKeys(obj, NOOP_LISTEN, (e) => (0, listen_socket_1.listenSocketAll)(e, data));
}
function deepListenSmart(obj, data) {
    return deepMapByKeys(obj, NOOP_LISTEN, (e) => (0, listen_socket_1.listenSocketSmart)(e, data));
}
