"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInProcSocketPair = createInProcSocketPair;
exports.createRpcInProc = createRpcInProc;
const rpc_server_1 = require("./rpc-server");
const rpc_server_auto_1 = require("./rpc-server-auto");
const rpc_client_1 = require("./rpc-client");
function activeBinaryBytes(value) {
    return value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
function cloneInProcBinary(value) {
    const source = activeBinaryBytes(value);
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    if (value instanceof ArrayBuffer)
        return bytes.buffer;
    if (value instanceof DataView)
        return new DataView(bytes.buffer);
    const Constructor = value.constructor;
    if (typeof Constructor.from == 'function' && typeof Constructor.isBuffer == 'function'
        && Constructor.isBuffer(value)) {
        return Constructor.from(bytes);
    }
    try {
        return new Constructor(bytes.buffer);
    }
    catch {
        return bytes;
    }
}
function defineInProcWireValue(target, key, value) {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    });
}
function detachInProcBinary(value, attachments, active) {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const num = attachments.length;
        attachments.push(cloneInProcBinary(value));
        return { _placeholder: true, num };
    }
    if (value == null || typeof value != 'object')
        return value;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype != Object.prototype && prototype != null)
        return value;
    if (active.has(value))
        throw new TypeError('createInProcSocketPair: cyclic wire value');
    active.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map(function detachInProcArrayItem(item) {
                return detachInProcBinary(item, attachments, active);
            });
        }
        const detached = {};
        for (const key of Object.keys(value)) {
            defineInProcWireValue(detached, key, detachInProcBinary(value[key], attachments, active));
        }
        return detached;
    }
    finally {
        active.delete(value);
    }
}
function restoreInProcBinary(value, attachments) {
    if (value == null || typeof value != 'object')
        return value;
    const keys = Object.keys(value);
    if (keys.length == 2 && value['_placeholder'] == true && Number.isSafeInteger(value['num'])) {
        const attachment = attachments[value['num']];
        if (attachment == undefined)
            throw new TypeError('createInProcSocketPair: invalid binary placeholder');
        return attachment;
    }
    if (Array.isArray(value)) {
        return value.map(function restoreInProcArrayItem(item) {
            return restoreInProcBinary(item, attachments);
        });
    }
    const restored = {};
    for (const key of keys) {
        defineInProcWireValue(restored, key, restoreInProcBinary(value[key], attachments));
    }
    return restored;
}
function cloneInProcWire(value) {
    if (value === undefined)
        return undefined;
    const attachments = [];
    const detached = detachInProcBinary(value, attachments, new WeakSet());
    return restoreInProcBinary(JSON.parse(JSON.stringify(detached)), attachments);
}
function createInProcSocketPair() {
    const A = {};
    const B = {};
    const make = (mine, theirs) => ({
        on: (e, cb) => { (mine[e] ??= []).push(cb); },
        emit: (e, d) => {
            const wire = cloneInProcWire(d);
            for (const cb of (theirs[e] ?? []))
                queueMicrotask(() => cb(wire));
        },
    });
    return [make(A, B), make(B, A)];
}
function createRpcInProc({ object: target, socketKey = 'rpc', listen = true, debug, hooks, limits, auth, token, throttle, maxPerListen, opt, }) {
    const [clientSocket, serverSocket] = createInProcSocketPair();
    if (listen) {
        (0, rpc_server_auto_1.createRpcServerAuto)({ socket: serverSocket, object: target, socketKey, debug, hooks, limits, auth, throttle, maxPerListen, opt });
    }
    else {
        (0, rpc_server_1.createRpcServer)({ socket: serverSocket, object: target, socketKey, debug, hooks: hooks, limits, auth, opt });
    }
    return (0, rpc_client_1.createRpcClient)({ socket: clientSocket, socketKey, limits, token, opt });
}
