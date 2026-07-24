"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RPC_SCHEMA_READY = exports.RPC_MEMBER_LOOKUP = exports.RPC_TRANSPORT_CONTROL = exports.RPC_TRANSPORT_LIFECYCLE = void 0;
exports.hasRpcMemberLookup = hasRpcMemberLookup;
exports.getRpcMemberState = getRpcMemberState;
exports.rpcMemberAvailable = rpcMemberAvailable;
exports.rpcMemberMayBeAvailable = rpcMemberMayBeAvailable;
exports.getRpcSchemaReady = getRpcSchemaReady;
exports.getRpcTransportLifecycle = getRpcTransportLifecycle;
exports.createTransportLifecycle = createTransportLifecycle;
exports.RPC_TRANSPORT_LIFECYCLE = Symbol.for('wenay-common2.rpc.transportLifecycle');
exports.RPC_TRANSPORT_CONTROL = Symbol.for('wenay-common2.rpc.transportControl');
exports.RPC_MEMBER_LOOKUP = Symbol.for('wenay-common2.rpc.memberLookup');
exports.RPC_SCHEMA_READY = Symbol.for('wenay-common2.rpc.schemaReady');
function getRpcMemberLookup(remote) {
    try {
        const candidate = remote?.[exports.RPC_MEMBER_LOOKUP];
        if (typeof candidate != 'function')
            return undefined;
        if (Object.getOwnPropertyDescriptor(candidate, exports.RPC_MEMBER_LOOKUP)?.value != true)
            return undefined;
        return candidate;
    }
    catch {
        return undefined;
    }
}
function hasRpcMemberLookup(remote) {
    return getRpcMemberLookup(remote) != undefined;
}
function getRpcMemberState(remote, member) {
    return getRpcMemberLookup(remote)?.(member);
}
function rpcMemberAvailable(remote, member) {
    const lookup = getRpcMemberLookup(remote);
    if (lookup) {
        try {
            return lookup(member) == true;
        }
        catch {
            return false;
        }
    }
    try {
        return remote != null
            && (typeof remote == 'object' || typeof remote == 'function')
            && member in remote
            && remote[member] != null;
    }
    catch {
        return false;
    }
}
function rpcMemberMayBeAvailable(remote, member) {
    const lookup = getRpcMemberLookup(remote);
    if (lookup) {
        try {
            const state = lookup(member);
            if (state != undefined)
                return state;
            return remote?.[member] != null;
        }
        catch {
            return false;
        }
    }
    try {
        return remote != null
            && (typeof remote == 'object' || typeof remote == 'function')
            && member in remote
            && remote[member] != null;
    }
    catch {
        return false;
    }
}
function getRpcSchemaReady(remote) {
    try {
        const candidate = remote?.[exports.RPC_SCHEMA_READY];
        if (typeof candidate != 'function')
            return undefined;
        if (Object.getOwnPropertyDescriptor(candidate, exports.RPC_SCHEMA_READY)?.value != true)
            return undefined;
        return candidate;
    }
    catch {
        return undefined;
    }
}
function getRpcTransportLifecycle(remote) {
    try {
        const candidate = remote?.[exports.RPC_TRANSPORT_LIFECYCLE];
        if (candidate == null || (typeof candidate != 'object' && typeof candidate != 'function'))
            return undefined;
        if (Object.getOwnPropertyDescriptor(candidate, exports.RPC_TRANSPORT_LIFECYCLE)?.value != true)
            return undefined;
        return candidate;
    }
    catch {
        return undefined;
    }
}
function createTransportLifecycle(initialConnected = true) {
    let online = initialConnected;
    let terminal = false;
    let generation = initialConnected ? 1 : 0;
    const connectCbs = new Set();
    const disconnectCbs = new Set();
    const closeCbs = new Set();
    function onConnect(cb) {
        connectCbs.add(cb);
        return function offConnect() { connectCbs.delete(cb); };
    }
    function onDisconnect(cb) {
        disconnectCbs.add(cb);
        return function offDisconnect() { disconnectCbs.delete(cb); };
    }
    function onClose(cb) {
        closeCbs.add(cb);
        return function offClose() { closeCbs.delete(cb); };
    }
    function connect() {
        if (terminal || online)
            return;
        online = true;
        generation++;
        for (const cb of [...connectCbs])
            cb(generation);
    }
    function disconnect(reason) {
        if (terminal || !online)
            return;
        online = false;
        for (const cb of [...disconnectCbs])
            cb(reason, generation);
    }
    function close(reason) {
        if (terminal)
            return;
        terminal = true;
        online = false;
        for (const cb of [...closeCbs])
            cb(reason);
        connectCbs.clear();
        disconnectCbs.clear();
        closeCbs.clear();
    }
    const api = {
        connected: () => online,
        closed: () => terminal,
        generation: () => generation,
        onConnect,
        onDisconnect,
        onClose,
    };
    Object.defineProperty(api, exports.RPC_TRANSPORT_LIFECYCLE, { value: true });
    const control = { connect, disconnect, close };
    return { api, control };
}
