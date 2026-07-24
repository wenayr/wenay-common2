"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rpcResultLimitsProperty = rpcResultLimitsProperty;
exports.getRpcResultLimits = getRpcResultLimits;
const RPC_RESULT_LIMITS = Symbol.for('wenay-common2.rpc.resultLimits');
function rpcResultLimitsProperty(property) {
    return property == RPC_RESULT_LIMITS;
}
function getRpcResultLimits(value) {
    if ((typeof value != 'object' || value == null) && typeof value != 'function')
        return undefined;
    return value[RPC_RESULT_LIMITS];
}
