"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rpcResultWireMetrics = rpcResultWireMetrics;
exports.rpcResultWireMetricsFast = rpcResultWireMetricsFast;
exports.rpcResultWireByteLength = rpcResultWireByteLength;
const wire_size_1 = require("../wire-size");
const rpc_limits_1 = require("./rpc-limits");
const rpc_walk_1 = require("./rpc-walk");
function binaryByteLength(value) {
    if (ArrayBuffer.isView(value))
        return value.byteLength;
    if (value instanceof ArrayBuffer)
        return value.byteLength;
    return null;
}
function rpcResultWireMetrics(value, firstBinaryIndex = 0) {
    let binaryBytes = 0;
    let binaryIndex = firstBinaryIndex;
    function replaceBinary(next) {
        const bytes = binaryByteLength(next);
        if (bytes != null) {
            binaryBytes += bytes;
            return { _placeholder: true, num: binaryIndex++ };
        }
        if (next == null || typeof next != 'object')
            return next;
        if (Array.isArray(next))
            return next.map(replaceBinary);
        const out = {};
        for (const key of Object.keys(next))
            out[key] = replaceBinary(next[key]);
        return out;
    }
    const jsonBytes = (0, wire_size_1.jsonUtf8ByteLength)(replaceBinary((0, rpc_walk_1.packResult)(value)));
    return {
        byteLength: Number.isFinite(jsonBytes) ? jsonBytes + binaryBytes : jsonBytes,
        binaryCount: binaryIndex - firstBinaryIndex,
    };
}
const plainWireFallback = Symbol('plainWireFallback');
const simpleJsonAscii = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/;
function jsonStringWireBytes(value) {
    if (simpleJsonAscii.test(value))
        return value.length + 2;
    let bytes = 2;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code == 0x22 || code == 0x5c
            || code == 0x08 || code == 0x09 || code == 0x0a || code == 0x0c || code == 0x0d) {
            bytes += 2;
        }
        else if (code < 0x20) {
            bytes += 6;
        }
        else if (code < 0x80) {
            bytes++;
        }
        else if (code < 0x800) {
            bytes += 2;
        }
        else if (code >= 0xd800 && code <= 0xdbff) {
            const low = value.charCodeAt(index + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
                bytes += 4;
                index++;
            }
            else {
                bytes += 6;
            }
        }
        else if (code >= 0xdc00 && code <= 0xdfff) {
            bytes += 6;
        }
        else {
            bytes += 3;
        }
    }
    return bytes;
}
function jsonNumberWireBytes(value) {
    if (!Number.isFinite(value))
        return 4;
    if (Object.is(value, -0))
        return 1;
    return String(value).length;
}
function jsonOmitsValue(value) {
    const type = typeof value;
    return value === undefined || type == 'function' || type == 'symbol';
}
function plainJsonWireBytes(value, counter) {
    if (value === null)
        return 4;
    if (typeof value == 'string')
        return jsonStringWireBytes(value);
    if (typeof value == 'number')
        return jsonNumberWireBytes(value);
    if (typeof value == 'boolean')
        return value ? 4 : 5;
    if (jsonOmitsValue(value))
        return plainWireFallback;
    if (typeof value != 'object' || typeof value == 'bigint')
        return plainWireFallback;
    const binaryBytes = binaryByteLength(value);
    if (binaryBytes != null) {
        const indexBytes = String(counter.binaryIndex++).length;
        counter.binaryBytes += binaryBytes;
        return 28 + indexBytes;
    }
    if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof RegExp) {
        return plainWireFallback;
    }
    if (counter.ancestors.has(value))
        return plainWireFallback;
    counter.ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            let bytes = 2;
            for (let index = 0; index < value.length; index++) {
                if (index)
                    bytes++;
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                    return plainWireFallback;
                }
                const item = descriptor?.value;
                if (jsonOmitsValue(item)) {
                    bytes += 4;
                    continue;
                }
                const itemBytes = plainJsonWireBytes(item, counter);
                if (itemBytes === plainWireFallback)
                    return plainWireFallback;
                bytes += itemBytes;
            }
            return bytes;
        }
        const keys = Object.keys(value);
        if (keys.length == 1 && rpc_walk_1.RESERVED_MARKER_KEYS.has(keys[0]))
            return plainWireFallback;
        let bytes = 2;
        let emitted = 0;
        for (const key of keys) {
            if (!(0, rpc_limits_1.isSafeKey)(key))
                continue;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                return plainWireFallback;
            }
            const item = descriptor.value;
            if (key == 'toJSON' && typeof item == 'function')
                return plainWireFallback;
            if (jsonOmitsValue(item))
                continue;
            const itemBytes = plainJsonWireBytes(item, counter);
            if (itemBytes === plainWireFallback)
                return plainWireFallback;
            if (emitted++)
                bytes++;
            bytes += jsonStringWireBytes(key) + 1 + itemBytes;
        }
        return bytes;
    }
    finally {
        counter.ancestors.delete(value);
    }
}
function rpcResultWireMetricsFast(value, firstBinaryIndex = 0) {
    if (!Number.isSafeInteger(firstBinaryIndex) || firstBinaryIndex < 0) {
        return rpcResultWireMetrics(value, firstBinaryIndex);
    }
    const counter = {
        binaryBytes: 0,
        binaryIndex: firstBinaryIndex,
        ancestors: new WeakSet(),
    };
    const jsonBytes = plainJsonWireBytes(value, counter);
    if (jsonBytes === plainWireFallback)
        return rpcResultWireMetrics(value, firstBinaryIndex);
    return {
        byteLength: jsonBytes + counter.binaryBytes,
        binaryCount: counter.binaryIndex - firstBinaryIndex,
    };
}
function rpcResultWireByteLength(value) {
    return rpcResultWireMetrics(value).byteLength;
}
