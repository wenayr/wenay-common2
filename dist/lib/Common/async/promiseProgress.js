"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.promiseProgress = promiseProgress;
const Listen_1 = require("../events/Listen");
function promiseProgress(array) {
    let ok = 0, errorCount = 0;
    const count = array.length;
    const okEvents = (0, Listen_1.listen)();
    const errorEvents = (0, Listen_1.listen)();
    const emitOk = (data, i) => {
        ++ok;
        okEvents[0](data, i, ok, errorCount, count);
    };
    const emitError = (error, i) => {
        ++errorCount;
        errorEvents[0](error, i, ok, errorCount, count);
    };
    const wrap = (promise, i) => promise.then(r => { emitOk(r, i); return r; }).catch((er) => { emitError(er, i); throw er; });
    const arr = array.map((e, i) => e instanceof Promise ? wrap(e, i) : () => wrap((async () => e())(), i));
    const started = [];
    const startAll = () => arr.map((x, i) => started[i] ??= (typeof x === "function" ? x() : x));
    const onOk = (cb) => okEvents[1].on(cb);
    const onError = (cb) => errorEvents[1].on(cb);
    const all = () => Promise.all(startAll());
    const allSettled = () => Promise.allSettled(startAll());
    const items = () => startAll();
    const stats = () => ({ ok, error: errorCount, count });
    return { onOk, onError, all, allSettled, items, stats };
}
