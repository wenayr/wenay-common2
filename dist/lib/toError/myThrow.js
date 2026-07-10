"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toError = exports.MyError = void 0;
class MyError extends Error {
    code;
    data;
    name = 'MyError';
    constructor(message, code = 'ERR', data = {}, cause) {
        super(message);
        this.code = code;
        this.data = data;
        if (cause != undefined)
            this.cause = cause;
    }
    toJSON() {
        const { name, message, code, data, stack } = this;
        return { name, message, code, data, stack };
    }
    static wrap(e) {
        return e instanceof Error ? e : new MyError(typeof e == 'string' ? e : JSON.stringify(e), 'ERR', { value: e });
    }
    static fromWire(w) {
        return Object.assign(new MyError(w.message, w.code, w.data), { name: w.name, stack: w.stack });
    }
}
exports.MyError = MyError;
const legacyThrow = (e) => {
    if (e instanceof Error)
        throw e;
    throw new Error(JSON.stringify(e));
};
exports.toError = {
    set convert(e) { legacyThrow(e); },
    throw(e) { legacyThrow(e); },
    convertToMsg(e) { return e; },
};
