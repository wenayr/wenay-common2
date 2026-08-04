"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GRANT_FACTS_KEY = exports.IS_RPC_LISTEN = exports.RPC_STOP = exports.Pkt = void 0;
exports.Pkt = {
    CALL: 0,
    RESP: 1,
    CB: 2,
    MAP: 3,
    STRICT: 4,
    CB_END: 5,
    PIPE: 6,
    HELLO: 7,
    SHAPE: 8,
    CBV: 9,
    CAPS: 10,
    CB_BATCH: 11,
    AUTH: 12,
    BATCH: 13,
    CB_FLOW: 14,
    CB_ACK: 15,
};
exports.RPC_STOP = "___STOP";
exports.IS_RPC_LISTEN = Symbol.for("isRpcListen");
exports.GRANT_FACTS_KEY = '$rpc';
