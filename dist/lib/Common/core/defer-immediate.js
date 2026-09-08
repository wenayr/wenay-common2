"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deferImmediate = deferImmediate;
const timers = globalThis;
function deferImmediate(callback) {
    if (typeof timers.setImmediate == 'function')
        timers.setImmediate(callback);
    else
        setTimeout(callback, 0);
}
