"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PEER_PUBLISH_BATCH_MAX_BYTES = exports.PEER_PUBLISH_BATCH_MAX_ITEMS = void 0;
exports.peerPublishBatchBytes = peerPublishBatchBytes;
exports.createMeasuredPeerPublishBatchQueue = createMeasuredPeerPublishBatchQueue;
exports.createPeerPublishBatchQueue = createPeerPublishBatchQueue;
exports.splitMeasuredPeerPublishEnvelopes = splitMeasuredPeerPublishEnvelopes;
exports.splitPeerPublishEnvelopes = splitPeerPublishEnvelopes;
const rpc_wire_size_1 = require("../rcp/rpc-wire-size");
exports.PEER_PUBLISH_BATCH_MAX_ITEMS = 64;
exports.PEER_PUBLISH_BATCH_MAX_BYTES = 64 * 1024;
function peerPublishBatchBytes(envelopes) {
    return (0, rpc_wire_size_1.rpcResultWireByteLength)(envelopes);
}
function createMeasuredPeerPublishBatchQueue(deps) {
    const { emit, schedule } = deps;
    let batch = [];
    let batchBytes = 2;
    let batchBinaryCount = 0;
    let scheduled = false;
    let closed = false;
    function flush() {
        if (batch.length == 0)
            return;
        const ready = {
            items: batch,
            byteLength: batchBytes,
        };
        batch = [];
        batchBytes = 2;
        batchBinaryCount = 0;
        emit(ready);
    }
    function measureItem(item) {
        const metrics = (0, rpc_wire_size_1.rpcResultWireMetrics)([item], batchBinaryCount);
        return {
            byteLength: metrics.byteLength - 2,
            binaryCount: metrics.binaryCount,
        };
    }
    function push(item) {
        if (closed)
            return;
        let itemMetrics = measureItem(item);
        let candidateBytes = batchBytes + (batch.length > 0 ? 1 : 0) + itemMetrics.byteLength;
        if (batch.length > 0 && (batch.length >= exports.PEER_PUBLISH_BATCH_MAX_ITEMS ||
            candidateBytes > exports.PEER_PUBLISH_BATCH_MAX_BYTES)) {
            flush();
            itemMetrics = measureItem(item);
            candidateBytes = batchBytes + itemMetrics.byteLength;
        }
        batch.push(item);
        batchBytes = candidateBytes;
        batchBinaryCount += itemMetrics.binaryCount;
        if (batch.length >= exports.PEER_PUBLISH_BATCH_MAX_ITEMS || candidateBytes >= exports.PEER_PUBLISH_BATCH_MAX_BYTES) {
            flush();
            return;
        }
        if (scheduled || !schedule)
            return;
        scheduled = true;
        schedule(function flushScheduledPeerPublishBatch() {
            scheduled = false;
            flush();
        });
    }
    function close() {
        if (closed)
            return;
        flush();
        closed = true;
    }
    return { push, flush, close };
}
function createPeerPublishBatchQueue(deps) {
    const { emit, schedule } = deps;
    return createMeasuredPeerPublishBatchQueue({
        emit(batch) { emit(batch.items); },
        schedule,
    });
}
function splitMeasuredPeerPublishEnvelopes(envelopes) {
    const batches = [];
    const queue = createMeasuredPeerPublishBatchQueue({
        emit(batch) { batches.push(batch); },
    });
    for (const envelope of envelopes)
        queue.push(envelope);
    queue.close();
    return batches;
}
function splitPeerPublishEnvelopes(envelopes) {
    return splitMeasuredPeerPublishEnvelopes(envelopes).map(batch => batch.items);
}
