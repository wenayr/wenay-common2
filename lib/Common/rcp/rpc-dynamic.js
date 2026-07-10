"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.noStrict = noStrict;
exports.isNoStrict = isNoStrict;
const dynamicRegistry = new WeakSet();
function noStrict(obj) {
    dynamicRegistry.add(obj);
    return obj;
}
function isNoStrict(obj) {
    return dynamicRegistry.has(obj);
}
