"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.endCallback = void 0;
exports.makeOff = makeOff;
const rpc_walk_1 = require("./rpc-walk");
exports.endCallback = rpc_walk_1.rpcEndCallback;
function makeOff(promise, stop, extra) {
    let done = false;
    function off() {
        if (done)
            return;
        done = true;
        stop();
    }
    const handle = off;
    handle.then = promise.then.bind(promise);
    handle.catch = promise.catch.bind(promise);
    handle.finally = promise.finally.bind(promise);
    if (extra)
        Object.assign(handle, extra);
    return handle;
}
