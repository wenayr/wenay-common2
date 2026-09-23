"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resourceBudgets = resourceBudgets;
exports.resourceError = resourceError;
exports.resourceWithin = resourceWithin;
const myThrow_1 = require("../toError/myThrow");
const rpc_deadline_1 = require("../Common/rcp/rpc-deadline");
function resourceBudgets(options) {
    const open = options?.openTimeoutMs ?? 10_000;
    const close = options?.closeTimeoutMs ?? 2000;
    if (![open, close].every(value => Number.isFinite(value) && value >= 0))
        throw new Error('Invalid resource timeout');
    return { open, close };
}
function resourceError(code) {
    const messages = {
        E_RESOURCE_CLOSED: 'Resource generation is closed',
        E_RESOURCE_DENIED: 'Resource access denied',
        E_RESOURCE_OPEN: 'Resource could not be opened',
        E_RESOURCE_TIMEOUT: 'Resource operation timed out',
        E_RESOURCE_CLEANUP: 'Resource cleanup could not be confirmed',
        E_RESOURCE_UNSUPPORTED: 'Resource is not supported',
    };
    return new myThrow_1.MyError(messages[code] ?? messages['E_RESOURCE_OPEN'], code);
}
async function resourceWithin(work, ms, code, signal) {
    let timer;
    let off = () => { };
    try {
        return await Promise.race([work, new Promise(function budget(_resolve, reject) {
                function aborted() { reject(resourceError('E_RESOURCE_CLOSED')); }
                off = () => signal?.removeEventListener('abort', aborted);
                signal?.addEventListener('abort', aborted, { once: true });
                if (signal?.aborted)
                    aborted();
                timer = (0, rpc_deadline_1.createRpcDeadline)({ at: Date.now() + ms, fire() { reject(resourceError(code)); } });
            })]);
    }
    finally {
        timer?.cancel();
        off();
    }
}
