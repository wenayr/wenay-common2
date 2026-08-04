"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRpcFlowHost = registerRpcFlowHost;
exports.rpcFlowClosedError = rpcFlowClosedError;
exports.flowCallback = flowCallback;
const myThrow_1 = require("../../toError/myThrow");
const flowHosts = new WeakMap();
function registerRpcFlowHost(cb, open) {
    flowHosts.set(cb, open);
}
function rpcFlowClosedError(reason) {
    return new myThrow_1.MyError('RPC flow closed: ' + reason, 'E_FLOW_CLOSED');
}
const RESOLVED = Promise.resolve();
function flowCallback(cb, opts) {
    const open = flowHosts.get(cb);
    if (!open) {
        return {
            push: function pushLocal(...args) {
                try {
                    cb(...args);
                }
                catch (e) {
                    return Promise.reject(e);
                }
                return RESOLVED;
            },
            pending: () => 0,
            closed: () => false,
        };
    }
    const gate = open(opts);
    return {
        push: function push(...args) {
            const reason = gate.closedReason();
            if (reason != null)
                return Promise.reject(rpcFlowClosedError(reason));
            try {
                cb(...args);
            }
            catch (e) {
                return Promise.reject(e);
            }
            return gate.wait();
        },
        pending: gate.pending,
        closed: () => gate.closedReason() != null,
    };
}
