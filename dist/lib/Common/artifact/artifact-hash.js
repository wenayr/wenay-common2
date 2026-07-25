"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.artifactBytesOf = artifactBytesOf;
exports.sha256Hex = sha256Hex;
const encoder = new TextEncoder();
function artifactBytesOf(data) {
    return typeof data == 'string' ? encoder.encode(data) : data;
}
async function sha256Hex(data) {
    const bytes = artifactBytesOf(data);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    let out = '';
    for (const byte of new Uint8Array(digest))
        out += byte.toString(16).padStart(2, '0');
    return out;
}
