"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.socketBuffer = socketBuffer;
exports.listenSnapshot = listenSnapshot;
const Listen_1 = require("./Listen");
function socketBuffer(func, callbackMain, memo = {}) {
    return (a, ...b) => func({
        ...a, callback: (v) => {
            const z = callbackMain(v, memo);
            if (z)
                a.callback(...z);
        }
    }, ...b);
}
function listenSnapshot({ func, memo = {}, callbackSave, snapshot }) {
    let d = null;
    const [callback, listenA] = (0, Listen_1.listen)({
        event: (type, count, api) => {
            if (type == "remove" && count == 0) {
                api.close();
                d?.();
                d = null;
            }
            if (type == "add" && count == 1)
                api.run();
        }
    });
    const connect = () => {
        if (d == null)
            d = socketBuffer(func(), callbackSave, memo)({ callback });
    };
    const run = (...params) => {
        if (!listenA.isRunning()) {
            snapshot?.(memo);
            connect();
        }
        return listenA.on(...params);
    };
    return {
        run, snapshot: () => snapshot?.(memo), memo, listenA, connect, get disconnect() {
            return d;
        }
    };
}
