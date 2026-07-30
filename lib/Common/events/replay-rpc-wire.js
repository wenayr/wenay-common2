"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RPC_REPLAY_WIRE_SOURCE = void 0;
exports.brandRpcReplayWire = brandRpcReplayWire;
exports.getRpcReplayWireSource = getRpcReplayWireSource;
exports.retransmitRpcReplayWire = retransmitRpcReplayWire;
exports.RPC_REPLAY_WIRE_SOURCE = Symbol.for('wenay-common2.rpc.replayWireSource');
function brandRpcReplayWire(facade, source) {
    Object.defineProperty(facade, exports.RPC_REPLAY_WIRE_SOURCE, { value: source });
    return facade;
}
function getRpcReplayWireSource(value) {
    if (value == null || typeof value != 'object')
        return undefined;
    const source = Object.getOwnPropertyDescriptor(value, exports.RPC_REPLAY_WIRE_SOURCE)?.value;
    if (source == null || typeof source != 'object'
        || typeof source.head != 'function' || typeof source.sequenceOf != 'function')
        return undefined;
    return source;
}
function retransmitRpcReplayWire(source, facade) {
    const replaySource = getRpcReplayWireSource(source);
    return replaySource ? brandRpcReplayWire(facade, replaySource) : facade;
}
