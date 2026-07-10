"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IS_RPC_LISTEN = exports.RPC_STOP = exports.Pkt = void 0;
exports.Pkt = { CALL: 0, RESP: 1, CB: 2, MAP: 3, STRICT: 4, CB_END: 5, PIPE: 6, HELLO: 7, SHAPE: 8, CBV: 9, CAPS: 10 };
exports.RPC_STOP = "___STOP";
exports.IS_RPC_LISTEN = Symbol.for("isRpcListen");
