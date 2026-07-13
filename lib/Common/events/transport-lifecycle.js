"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RPC_MEMBER_LOOKUP = exports.RPC_TRANSPORT_CONTROL = exports.RPC_TRANSPORT_LIFECYCLE = void 0;
exports.getRpcMemberState = getRpcMemberState;
exports.getRpcTransportLifecycle = getRpcTransportLifecycle;
exports.createTransportLifecycle = createTransportLifecycle;
exports.RPC_TRANSPORT_LIFECYCLE = Symbol.for('wenay-common2.rpc.transportLifecycle');
exports.RPC_TRANSPORT_CONTROL = Symbol.for('wenay-common2.rpc.transportControl');
exports.RPC_MEMBER_LOOKUP = Symbol.for('wenay-common2.rpc.memberLookup');
function getRpcMemberState(remote, member) {
    let lookup;
    try {
        const candidate = remote?.[exports.RPC_MEMBER_LOOKUP];
        if (typeof candidate != 'function')
            return undefined;
        if (Object.getOwnPropertyDescriptor(candidate, exports.RPC_MEMBER_LOOKUP)?.value != true)
            return undefined;
        lookup = candidate;
    }
    catch {
        return undefined;
    }
    return lookup(member);
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
