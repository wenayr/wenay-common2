"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sameSecret = sameSecret;
const node_crypto_1 = require("node:crypto");
function digest(value) {
    return (0, node_crypto_1.createHash)('sha256').update(value, 'utf8').digest();
}
function sameSecret(presented, expected) {
    if (typeof presented != 'string')
        return false;
    return (0, node_crypto_1.timingSafeEqual)(digest(presented), digest(expected));
}
