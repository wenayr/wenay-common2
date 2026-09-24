"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCoreDetach = registerCoreDetach;
exports.coreDetachOf = coreDetachOf;
exports.setRpcCallbackId = setRpcCallbackId;
exports.rpcCallbackId = rpcCallbackId;
const coreDetachRegistry = new WeakMap();
function registerCoreDetach(server, detach) {
    coreDetachRegistry.set(server, detach);
}
function coreDetachOf(server) {
    return coreDetachRegistry.get(server);
}
const cbIdRegistry = new WeakMap();
function setRpcCallbackId(fn, id) {
    cbIdRegistry.set(fn, id);
}
function rpcCallbackId(fn) {
    return cbIdRegistry.get(fn);
}
