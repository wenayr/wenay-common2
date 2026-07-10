"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PayloadLimitError = exports.resolveLimits = exports.isSafeKey = void 0;
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isSafeKey = (k) => !BANNED_KEYS.has(k);
exports.isSafeKey = isSafeKey;
const DEFAULT_LIMITS = {
    maxDepth: 32,
    maxKeys: 1000,
    maxArgs: 64,
    maxArrayLen: 10_000,
    maxStringLen: 1_000_000,
    maxCallbacks: 100,
    maxPathLen: 16,
    maxBinaryLen: 8_000_000,
};
const resolveLimits = (opts) => opts ? { ...DEFAULT_LIMITS, ...opts } : DEFAULT_LIMITS;
exports.resolveLimits = resolveLimits;
class PayloadLimitError extends Error {
    constructor(reason) {
        super(`Payload limit exceeded: ${reason}`);
        this.name = "PayloadLimitError";
    }
}
exports.PayloadLimitError = PayloadLimitError;
