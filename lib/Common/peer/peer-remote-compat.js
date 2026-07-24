"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readPeerRelaySeq = readPeerRelaySeq;
exports.readPeerRelayFrame = readPeerRelayFrame;
function isMissingRpcMethod(error, member) {
    const message = error?.message;
    if (typeof message != 'string' || !message.startsWith('Not a function: '))
        return false;
    const path = message.slice('Not a function: '.length).split(',');
    return path[path.length - 1]?.trim() == member;
}
async function readPeerRelaySeq(node) {
    if (typeof node?.seq != 'function')
        return -1;
    try {
        const seq = Number(await node.seq());
        return Number.isFinite(seq) ? seq : -1;
    }
    catch (error) {
        if (isMissingRpcMethod(error, 'seq'))
            return -1;
        throw error;
    }
}
async function readPeerRelayFrame(remote, seq, hint) {
    if (typeof remote.frame != 'function')
        return remote.since(seq);
    try {
        return await remote.frame(seq, hint);
    }
    catch (error) {
        if (isMissingRpcMethod(error, 'frame'))
            return remote.since(seq);
        throw error;
    }
}
