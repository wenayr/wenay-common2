"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.restoreAiRunCheckpoint = restoreAiRunCheckpoint;
const store_projection_1 = require("../Observe/store-projection");
const command_receipts_1 = require("../command/command-receipts");
const deep_equal_1 = require("../core/deep-equal");
function restoreAiRunCheckpoint(initial) {
    const copy = initial ? (0, store_projection_1.cloneStoreProjectionValue)(initial) : {
        version: 1, revision: 0, store: { runs: {}, approvals: {}, inputs: {} }, requests: {}, inputValues: {},
    };
    if (copy.version != 1 || !Number.isSafeInteger(copy.revision) || copy.revision < 0
        || !copy.store?.runs || !copy.store.approvals || !copy.store.inputs || !copy.requests || !copy.inputValues) {
        throw new Error('AI checkpoint: invalid version or shape');
    }
    const keys = new Set();
    for (const [id, run] of Object.entries(copy.store.runs)) {
        const request = copy.requests[id];
        const key = (0, command_receipts_1.commandReceiptKey)(run.owner, run.requestId);
        if (run.id != id || !run.owner || !run.requestId || keys.has(key) || !request || request.requestId != run.requestId
            || request.kind != run.kind || !Array.isArray(run.resourceIds) || !Array.isArray(run.artifacts)
            || !(0, deep_equal_1.compareDeepValues)(request.resourceIds ?? [], run.resourceIds)
            || !['queued', 'running', 'waiting_input', 'waiting_approval', 'completed', 'failed', 'cancelled'].includes(run.state)) {
            throw new Error('AI checkpoint: inconsistent run or receipt');
        }
        keys.add(key);
    }
    for (const id of Object.keys(copy.requests))
        if (!copy.store.runs[id])
            throw new Error('AI checkpoint: orphan request');
    for (const [id, approval] of Object.entries(copy.store.approvals)) {
        if (id != approval.id || !copy.store.runs[approval.runId]
            || !['pending', 'approved', 'rejected', 'cancelled'].includes(approval.state))
            throw new Error('AI checkpoint: invalid approval');
    }
    for (const [id, input] of Object.entries(copy.store.inputs)) {
        if (id != input.id || !copy.store.runs[input.runId]
            || !['waiting', 'provided', 'cancelled'].includes(input.state)
            || (input.state == 'provided' && !Object.hasOwn(copy.inputValues, id)))
            throw new Error('AI checkpoint: invalid input');
    }
    for (const id of Object.keys(copy.inputValues))
        if (copy.store.inputs[id]?.state != 'provided')
            throw new Error('AI checkpoint: orphan input value');
    return copy;
}
