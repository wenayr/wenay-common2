"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.utf8ByteLength = utf8ByteLength;
exports.jsonUtf8ByteLength = jsonUtf8ByteLength;
const utf8Encoder = new TextEncoder();
function utf8ByteLength(value) {
    return utf8Encoder.encode(value).byteLength;
}
function jsonUtf8ByteLength(value) {
    try {
        const encoded = JSON.stringify(value);
        return encoded == undefined ? Number.POSITIVE_INFINITY : utf8ByteLength(encoded);
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}
