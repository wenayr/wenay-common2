"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReplayBinaryCallbackRefValue = ReplayBinaryCallbackRefValue;
exports.createReplayBinaryCallbackRef = createReplayBinaryCallbackRef;
exports.replayBinaryCallbackRefId = replayBinaryCallbackRefId;
exports.trustReplayBinaryLeaf = trustReplayBinaryLeaf;
exports.replayBinaryNativeOwnStateError = replayBinaryNativeOwnStateError;
exports.replayBinaryRegExpError = replayBinaryRegExpError;
exports.createBinaryValueCodec = createBinaryValueCodec;
const rpc_limits_1 = require("../rcp/rpc-limits");
const DEFAULT_MAX_DEPTH = 32;
const MAX_CODEC_DEPTH = 64;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_OBJECT_KEYS = 1_000;
const MAX_STRING_CODE_UNITS = 1_000_000;
const MAX_STRING_BYTES = 1_000_000;
const DEFAULT_MAX_BINARY_BYTES = 8_000_000;
const DEFAULT_MAX_WIRE_BYTES = 16_000_000;
const MAX_BIGINT_BITS = 8_192;
const MAX_BIGINT_VARUINT_BYTES = Math.ceil(MAX_BIGINT_BITS / 7);
const MAX_SHAPE_ENTRIES = 1_000;
const MAX_SHAPE_FIELD_REFS = 64_000;
const MAX_SHAPE_KEY_TEXT_BYTES = 1_000_000;
const MAX_VALUE_WORK_UNITS = 1_000_000;
const MAX_CALLBACK_REFS_PER_VALUE = 1_024;
const BYTE_WRITER_TAIL_RESERVE = 256;
const MAX_TYPED_ARRAY_OWN_KEY_SCAN_ITEMS = 4_096;
const VALUE_TAG = {
    NULL: 0,
    UNDEFINED: 1,
    FALSE: 2,
    TRUE: 3,
    INTEGER: 4,
    FLOAT64: 5,
    STRING_UTF8: 6,
    STRING_UTF16: 7,
    BIGINT: 8,
    ARRAY: 9,
    OBJECT: 10,
    DATE: 11,
    REGEXP: 12,
    MAP: 13,
    SET: 14,
    ARRAY_BUFFER: 15,
    DATA_VIEW: 16,
    TYPED_ARRAY: 17,
    ARRAY_HOLE: 18,
    CALLBACK_REF: 19,
    OBJECT_SHAPE_DEF: 20,
    OBJECT_SHAPE_REF: 21,
};
const REPLAY_BINARY_CALLBACK_REF = Symbol('replay-binary-callback-ref');
function ReplayBinaryCallbackRefValue() { }
function createReplayBinaryCallbackRef(id) {
    if (!Number.isSafeInteger(id) || id < 0) {
        throw new RangeError('rpc binary callback ref: id must be a non-negative safe integer');
    }
    const value = Object.create(ReplayBinaryCallbackRefValue.prototype);
    value[REPLAY_BINARY_CALLBACK_REF] = id;
    return Object.freeze(value);
}
function replayBinaryCallbackRefId(value) {
    if (value == null || typeof value != 'object')
        return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype != Object.prototype
        && prototype != ReplayBinaryCallbackRefValue.prototype)
        return undefined;
    if (!own.call(value, REPLAY_BINARY_CALLBACK_REF))
        return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length != 1 || keys[0] !== REPLAY_BINARY_CALLBACK_REF)
        return undefined;
    const id = value[REPLAY_BINARY_CALLBACK_REF];
    return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}
const TYPED_ARRAY_SPEC = [
    { code: 1, name: 'Int8Array' },
    { code: 2, name: 'Uint8Array' },
    { code: 3, name: 'Uint8ClampedArray' },
    { code: 4, name: 'Int16Array' },
    { code: 5, name: 'Uint16Array' },
    { code: 6, name: 'Int32Array' },
    { code: 7, name: 'Uint32Array' },
    { code: 8, name: 'Float32Array' },
    { code: 9, name: 'Float64Array' },
    { code: 10, name: 'BigInt64Array' },
    { code: 11, name: 'BigUint64Array' },
];
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const trustedUtf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const own = Object.prototype.hasOwnProperty;
const trustedBinaryLeaves = new WeakSet();
const ARRAY_HOLE = Symbol('replay-binary-array-hole');
const MAX_SAFE_INTEGER_VARUINT_BYTES = 8;
const SAFE_INTEGER_ZIGZAG_HIGH_FACTOR = 2 ** 48;
const MAX_BIGINT_MAGNITUDE = (1n << BigInt(MAX_BIGINT_BITS)) - 1n;
const PLATFORM_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([0x0102]).buffer)[0] == 0x02;
const DATE_NATIVE_SHADOW_KEYS = ['valueOf'];
const REGEXP_NATIVE_SHADOW_KEYS = [
    'source',
    'flags',
    'hasIndices',
    'global',
    'ignoreCase',
    'multiline',
    'dotAll',
    'unicode',
    'unicodeSets',
    'sticky',
];
const ARRAY_BUFFER_NATIVE_SHADOW_KEYS = ['byteLength', 'slice'];
const ARRAY_BUFFER_VIEW_NATIVE_SHADOW_KEYS = [
    'buffer',
    'byteOffset',
    'byteLength',
    'constructor',
    'length',
    'BYTES_PER_ELEMENT',
];
const REGEXP_V1_FLAGS = /^d?g?i?m?s?u?y?$/;
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const SharedArrayBufferConstructor = globalThis.SharedArrayBuffer;
const sharedArrayBufferGrowableGetter = typeof SharedArrayBufferConstructor == 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBufferConstructor.prototype, 'growable')?.get
    : undefined;
function trustReplayBinaryLeaf(value) {
    Object.preventExtensions(value);
    trustedBinaryLeaves.add(value);
    return value;
}
const binaryError = function throwBinaryError(message) {
    throw new TypeError(message);
};
const binaryRangeError = function throwBinaryRangeError(message) {
    throw new RangeError(message);
};
function rejectOwnNativeShadows(value, keys, label) {
    for (const key of keys) {
        if (own.call(value, key)) {
            binaryError(label + ' own ' + key + ' shadow is not supported');
        }
    }
}
function replayBinaryNativeOwnStateError(value, kind, typedArrayItems) {
    if (kind == 'RegExp') {
        const keys = Reflect.ownKeys(value);
        if (keys.length != 1 || keys[0] !== 'lastIndex') {
            return 'RegExp custom own properties are not supported';
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, 'lastIndex');
        if (!descriptor
            || own.call(descriptor, 'get') || own.call(descriptor, 'set')
            || descriptor.configurable != false
            || descriptor.enumerable != false
            || descriptor.writable != true
            || !Object.is(descriptor.value, 0)) {
            return 'RegExp lastIndex must be zero with its standard descriptor in protocol v1';
        }
        return undefined;
    }
    if (kind == 'TypedArray') {
        if (!Number.isSafeInteger(typedArrayItems) || typedArrayItems < 0) {
            return 'TypedArray item count is invalid';
        }
        if (trustedBinaryLeaves.has(value))
            return undefined;
        if (typedArrayItems > MAX_TYPED_ARRAY_OWN_KEY_SCAN_ITEMS)
            return undefined;
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key != 'string' || !isArrayIndexKey(key, typedArrayItems)) {
                return 'TypedArray custom own properties are not supported';
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || own.call(descriptor, 'get') || own.call(descriptor, 'set')) {
                return 'TypedArray custom accessors are not supported';
            }
        }
        return undefined;
    }
    if (Reflect.ownKeys(value).length != 0) {
        return kind + ' custom own properties are not supported';
    }
    return undefined;
}
function validateNativeOwnState(value, kind, typedArrayItems) {
    const error = replayBinaryNativeOwnStateError(value, kind, typedArrayItems);
    if (error)
        binaryError(error);
}
function hasRegExpInlineModifiers(source) {
    let inClass = false;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (char == '\\') {
            index++;
            continue;
        }
        if (char == '[') {
            inClass = true;
            continue;
        }
        if (char == ']' && inClass) {
            inClass = false;
            continue;
        }
        if (inClass || char != '(' || source[index + 1] != '?')
            continue;
        let cursor = index + 2;
        let hasFlag = false;
        while (source[cursor] == 'i' || source[cursor] == 'm' || source[cursor] == 's') {
            hasFlag = true;
            cursor++;
        }
        if (source[cursor] == '-') {
            cursor++;
            while (source[cursor] == 'i' || source[cursor] == 'm' || source[cursor] == 's') {
                hasFlag = true;
                cursor++;
            }
        }
        if (hasFlag && source[cursor] == ':')
            return true;
    }
    return false;
}
function hasRegExpDuplicateNamedGroups(source) {
    const names = new Set();
    let inClass = false;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (char == '\\') {
            index++;
            continue;
        }
        if (char == '[') {
            inClass = true;
            continue;
        }
        if (char == ']' && inClass) {
            inClass = false;
            continue;
        }
        if (inClass || char != '(' || source[index + 1] != '?'
            || source[index + 2] != '<'
            || source[index + 3] == '=' || source[index + 3] == '!')
            continue;
        const end = source.indexOf('>', index + 3);
        if (end < 0)
            continue;
        const name = source.slice(index + 3, end);
        if (name.includes('\\') || names.has(name))
            return true;
        names.add(name);
        index = end;
    }
    return false;
}
function replayBinaryRegExpError(source, flags) {
    if (!REGEXP_V1_FLAGS.test(flags)) {
        return 'RegExp flags are unsupported or non-canonical in protocol v1';
    }
    if (hasRegExpInlineModifiers(source) || hasRegExpDuplicateNamedGroups(source)) {
        return 'RegExp source syntax is unsupported in protocol v1';
    }
    return undefined;
}
function validateRegExpV1(source, flags) {
    const error = replayBinaryRegExpError(source, flags);
    if (error)
        binaryError(error);
    return flags;
}
function nativeBufferFlag(getter, value) {
    if (!getter)
        return false;
    try {
        return getter.call(value) == true;
    }
    catch {
        return false;
    }
}
function rejectDynamicBinaryBuffer(value) {
    let dynamic;
    if (value instanceof ArrayBuffer) {
        dynamic = nativeBufferFlag(arrayBufferResizableGetter, value);
    }
    else if (typeof SharedArrayBufferConstructor == 'function'
        && value instanceof SharedArrayBufferConstructor) {
        dynamic = nativeBufferFlag(sharedArrayBufferGrowableGetter, value);
    }
    else {
        dynamic = nativeBufferFlag(arrayBufferResizableGetter, value)
            || nativeBufferFlag(sharedArrayBufferGrowableGetter, value);
    }
    if (dynamic) {
        binaryError('resizable and growable binary buffers are not supported in protocol v1');
    }
}
function boundedDecodeLimit(value, maximum) {
    if (Number.isNaN(value) || value == Infinity)
        return maximum;
    if (!Number.isFinite(value) || value < 0)
        return 0;
    return Math.min(Math.floor(value), maximum);
}
function binaryDecodeLimits(config, limits, wireLimits) {
    const requestedWireBytes = wireLimits?.maxWireBytes;
    const maxWireBytes = requestedWireBytes == undefined
        ? config.maxWireBytes
        : boundedDecodeLimit(requestedWireBytes, config.maxWireBytes);
    if (!limits) {
        return {
            maxDepth: config.maxDepth,
            maxArrayItems: MAX_ARRAY_ITEMS,
            maxObjectKeys: MAX_OBJECT_KEYS,
            maxStringCodeUnits: MAX_STRING_CODE_UNITS,
            maxBinaryBytes: config.maxBinaryBytes,
            maxWireBytes,
        };
    }
    const resolved = (0, rpc_limits_1.resolveLimits)(limits);
    return {
        maxDepth: boundedDecodeLimit(resolved.maxDepth, config.maxDepth),
        maxArrayItems: boundedDecodeLimit(resolved.maxArrayLen, MAX_ARRAY_ITEMS),
        maxObjectKeys: boundedDecodeLimit(resolved.maxKeys, MAX_OBJECT_KEYS),
        maxStringCodeUnits: boundedDecodeLimit(resolved.maxStringLen, MAX_STRING_CODE_UNITS),
        maxBinaryBytes: boundedDecodeLimit(resolved.maxBinaryLen, config.maxBinaryBytes),
        maxWireBytes,
    };
}
function createTypedArrayEntries() {
    const entries = [];
    const globals = globalThis;
    for (const spec of TYPED_ARRAY_SPEC) {
        const Constructor = globals[spec.name];
        if (typeof Constructor != 'function' || !Number.isInteger(Constructor.BYTES_PER_ELEMENT)
            || Constructor.BYTES_PER_ELEMENT <= 0)
            continue;
        entries.push({
            code: spec.code,
            name: spec.name,
            Constructor,
            bytesPerElement: Constructor.BYTES_PER_ELEMENT,
        });
    }
    return entries;
}
const typedArrayEntries = createTypedArrayEntries();
function typedArrayEntryByName(name) {
    return typedArrayEntries.find(entry => entry.name == name);
}
function typedArrayEntryByCode(code) {
    return typedArrayEntries.find(entry => entry.code == code);
}
function isNodeBuffer(value) {
    if (!ArrayBuffer.isView(value))
        return false;
    const Constructor = value.constructor;
    return typeof Constructor?.isBuffer == 'function' && Constructor.isBuffer(value);
}
function typedArrayEntryForValue(value) {
    if (isNodeBuffer(value))
        return typedArrayEntryByName('Uint8Array');
    for (const entry of typedArrayEntries) {
        if (value.constructor == entry.Constructor)
            return entry;
    }
    return undefined;
}
function varUintByteLength(value) {
    let remaining = value;
    let bytes = 1;
    while (remaining >= 0x80n) {
        remaining >>= 7n;
        bytes++;
    }
    return bytes;
}
function varUintNumberByteLength(value) {
    let remaining = value;
    let bytes = 1;
    while (remaining >= 0x80) {
        remaining = Math.floor(remaining / 0x80);
        bytes++;
    }
    return bytes;
}
function createByteWriter(maxWireBytes) {
    let bytes = new Uint8Array(256);
    let view = new DataView(bytes.buffer);
    let position = 0;
    function ensure(extra) {
        const required = position + extra;
        if (!Number.isSafeInteger(extra) || extra < 0 || required > maxWireBytes) {
            binaryRangeError('encoded frame exceeds binary limit');
        }
        if (required <= bytes.byteLength)
            return;
        let capacity = Math.max(required, bytes.byteLength * 2);
        if (capacity == required && required < maxWireBytes) {
            capacity = Math.min(maxWireBytes, required + BYTE_WRITER_TAIL_RESERVE);
        }
        if (capacity > maxWireBytes)
            capacity = maxWireBytes;
        const expanded = new Uint8Array(capacity);
        expanded.set(bytes);
        bytes = expanded;
        view = new DataView(bytes.buffer);
    }
    function writeU8(value) {
        ensure(1);
        bytes[position++] = value;
    }
    function writeU16(value) {
        ensure(2);
        view.setUint16(position, value, true);
        position += 2;
    }
    function writeFloat64(value) {
        ensure(8);
        view.setFloat64(position, value, true);
        position += 8;
    }
    function writeBytes(value) {
        ensure(value.byteLength);
        bytes.set(value, position);
        position += value.byteLength;
    }
    function writeUtf8(value, byteLength) {
        ensure(byteLength);
        const target = bytes.subarray(position, position + byteLength);
        const encoded = utf8Encoder.encodeInto(value, target);
        if (encoded.read != value.length || encoded.written != byteLength) {
            binaryError('UTF-8 encoder length mismatch');
        }
        position += byteLength;
    }
    function writeVarUintNumber(value, maxBytes = 8) {
        if (!Number.isSafeInteger(value) || value < 0) {
            binaryRangeError('number varuint must be a non-negative safe integer');
        }
        let remaining = value;
        let count = 0;
        do {
            if (count >= maxBytes)
                binaryRangeError('number varuint exceeds limit');
            const payload = remaining % 0x80;
            remaining = Math.floor(remaining / 0x80);
            writeU8(remaining == 0 ? payload : payload | 0x80);
            count++;
        } while (remaining != 0);
    }
    function writeVarUint(value, maxBytes = MAX_BIGINT_VARUINT_BYTES) {
        if (value < 0n)
            binaryRangeError('varuint cannot be negative');
        let remaining = value;
        let count = 0;
        do {
            if (count >= maxBytes)
                binaryRangeError('varuint exceeds limit');
            const payload = Number(remaining & 0x7fn);
            remaining >>= 7n;
            writeU8(remaining == 0n ? payload : payload | 0x80);
            count++;
        } while (remaining != 0n);
    }
    function finish() {
        if (position * 2 < bytes.byteLength)
            return bytes.slice(0, position);
        return bytes.subarray(0, position);
    }
    return {
        writeU8,
        writeU16,
        writeFloat64,
        writeBytes,
        writeUtf8,
        writeVarUintNumber,
        writeVarUint,
        finish,
    };
}
function createByteCounter(maxWireBytes) {
    let position = 0;
    function advance(bytes) {
        const required = position + bytes;
        if (!Number.isSafeInteger(bytes) || bytes < 0 || required > maxWireBytes) {
            binaryRangeError('encoded frame exceeds binary limit');
        }
        position = required;
    }
    function writeU8(_value) {
        advance(1);
    }
    function writeU16(_value) {
        advance(2);
    }
    function writeFloat64(_value) {
        advance(8);
    }
    function writeBytes(value) {
        advance(value.byteLength);
    }
    function writeUtf8(_value, byteLength) {
        advance(byteLength);
    }
    function writeVarUintNumber(value, maxBytes = 8) {
        if (!Number.isSafeInteger(value) || value < 0) {
            binaryRangeError('number varuint must be a non-negative safe integer');
        }
        const byteLength = varUintNumberByteLength(value);
        if (byteLength > maxBytes)
            binaryRangeError('number varuint exceeds limit');
        advance(byteLength);
    }
    function writeVarUint(value, maxBytes = MAX_BIGINT_VARUINT_BYTES) {
        if (value < 0n)
            binaryRangeError('varuint cannot be negative');
        const byteLength = varUintByteLength(value);
        if (byteLength > maxBytes)
            binaryRangeError('varuint exceeds limit');
        advance(byteLength);
    }
    function byteLength() {
        return position;
    }
    return {
        writeU8,
        writeU16,
        writeFloat64,
        writeBytes,
        writeUtf8,
        writeVarUintNumber,
        writeVarUint,
        byteLength,
    };
}
function createByteReader(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let position = 0;
    function requireBytes(length) {
        if (!Number.isSafeInteger(length) || length < 0 || length > bytes.byteLength - position) {
            binaryError('truncated frame');
        }
    }
    function readU8() {
        requireBytes(1);
        return bytes[position++];
    }
    function readFloat64() {
        requireBytes(8);
        const value = view.getFloat64(position, true);
        position += 8;
        return value;
    }
    function take(length) {
        requireBytes(length);
        const result = bytes.subarray(position, position + length);
        position += length;
        return result;
    }
    function readVarUint(maxBytes, label, maxValue) {
        let value = 0n;
        let shift = 0n;
        let count = 0;
        while (count < maxBytes) {
            const byte = readU8();
            const payload = byte & 0x7f;
            value |= BigInt(payload) << shift;
            count++;
            if ((byte & 0x80) == 0) {
                if (count > 1 && payload == 0)
                    binaryError(label + ' has non-canonical varuint');
                if (maxValue != undefined && value > maxValue)
                    binaryError(label + ' overflows');
                return value;
            }
            shift += 7n;
        }
        binaryError(label + ' varuint exceeds limit');
    }
    function readVarUintNumber(maxBytes, label, maxValue) {
        let value = 0;
        let factor = 1;
        let count = 0;
        while (count < maxBytes) {
            const byte = readU8();
            const payload = byte & 0x7f;
            value += payload * factor;
            if (!Number.isSafeInteger(value))
                binaryError(label + ' overflows');
            count++;
            if ((byte & 0x80) == 0) {
                if (count > 1 && payload == 0)
                    binaryError(label + ' has non-canonical varuint');
                if (value > maxValue)
                    binaryError(label + ' overflows');
                return value;
            }
            factor *= 0x80;
        }
        binaryError(label + ' varuint exceeds limit');
    }
    function readSafeInteger() {
        let low = 0;
        let factor = 1;
        for (let count = 0; count < MAX_SAFE_INTEGER_VARUINT_BYTES; count++) {
            const byte = readU8();
            const payload = byte & 0x7f;
            if (count < MAX_SAFE_INTEGER_VARUINT_BYTES - 1) {
                low += payload * factor;
            }
            if ((byte & 0x80) == 0) {
                if (count > 0 && payload == 0) {
                    binaryError('integer has non-canonical varuint');
                }
                if (count == MAX_SAFE_INTEGER_VARUINT_BYTES - 1) {
                    const half = payload * SAFE_INTEGER_ZIGZAG_HIGH_FACTOR
                        + Math.floor(low / 2);
                    const magnitude = (low % 2 == 0 ? half : half + 1);
                    if (!Number.isSafeInteger(magnitude))
                        binaryError('integer overflows');
                    return low % 2 == 0 ? magnitude : -magnitude;
                }
                return low % 2 == 0 ? low / 2 : -((low + 1) / 2);
            }
            factor *= 0x80;
        }
        binaryError('integer varuint exceeds limit');
    }
    function readVarUintTrusted(maxBytes = MAX_BIGINT_VARUINT_BYTES) {
        let value = 0n;
        let shift = 0n;
        for (let count = 0; count < maxBytes; count++) {
            const byte = readU8();
            value |= BigInt(byte & 0x7f) << shift;
            if ((byte & 0x80) == 0)
                return value;
            shift += 7n;
        }
        return binaryError('unterminated varuint');
    }
    function readVarUintNumberTrusted(maxBytes = MAX_SAFE_INTEGER_VARUINT_BYTES) {
        let value = 0;
        let factor = 1;
        for (let count = 0; count < maxBytes; count++) {
            const byte = readU8();
            value += (byte & 0x7f) * factor;
            if ((byte & 0x80) == 0)
                return value;
            factor *= 0x80;
        }
        return binaryError('unterminated number varuint');
    }
    function readSafeIntegerTrusted() {
        let low = 0;
        let factor = 1;
        for (let count = 0; count < MAX_SAFE_INTEGER_VARUINT_BYTES; count++) {
            const byte = readU8();
            const payload = byte & 0x7f;
            if (count < MAX_SAFE_INTEGER_VARUINT_BYTES - 1)
                low += payload * factor;
            if ((byte & 0x80) == 0) {
                if (count == MAX_SAFE_INTEGER_VARUINT_BYTES - 1) {
                    const half = payload * SAFE_INTEGER_ZIGZAG_HIGH_FACTOR
                        + Math.floor(low / 2);
                    const magnitude = low % 2 == 0 ? half : half + 1;
                    return low % 2 == 0 ? magnitude : -magnitude;
                }
                return low % 2 == 0 ? low / 2 : -((low + 1) / 2);
            }
            factor *= 0x80;
        }
        return binaryError('unterminated integer varuint');
    }
    function remaining() {
        return bytes.byteLength - position;
    }
    function done() {
        return position == bytes.byteLength;
    }
    return {
        readU8,
        readFloat64,
        take,
        readVarUint,
        readVarUintNumber,
        readSafeInteger,
        readVarUintTrusted,
        readVarUintNumberTrusted,
        readSafeIntegerTrusted,
        remaining,
        done,
    };
}
function writeLength(writer, value) {
    writer.writeVarUintNumber(value, varUintNumberByteLength(value));
}
function readLength(reader, maximum, label) {
    return reader.readVarUintNumber(varUintNumberByteLength(maximum), label, maximum);
}
function hasLoneSurrogate(value) {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
                return true;
            index++;
        }
        else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}
function utf8ByteLength(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code <= 0x7f) {
            bytes++;
            continue;
        }
        if (code <= 0x7ff) {
            bytes += 2;
            continue;
        }
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
                return -1;
            bytes += 4;
            index++;
            continue;
        }
        if (code >= 0xdc00 && code <= 0xdfff)
            return -1;
        bytes += 3;
    }
    return bytes;
}
function writeString(writer, value) {
    if (value.length > MAX_STRING_CODE_UNITS)
        binaryRangeError('string exceeds code-unit limit');
    const byteLength = utf8ByteLength(value);
    if (byteLength < 0) {
        const byteLength = value.length * 2;
        if (byteLength > MAX_STRING_BYTES)
            binaryRangeError('string exceeds byte limit');
        writer.writeU8(VALUE_TAG.STRING_UTF16);
        writeLength(writer, value.length);
        for (let index = 0; index < value.length; index++)
            writer.writeU16(value.charCodeAt(index));
        return;
    }
    if (byteLength > MAX_STRING_BYTES)
        binaryRangeError('string exceeds byte limit');
    writer.writeU8(VALUE_TAG.STRING_UTF8);
    writeLength(writer, byteLength);
    writer.writeUtf8(value, byteLength);
}
function readUtf8String(reader, limits) {
    const maximumBytes = Math.min(MAX_STRING_BYTES, limits.maxStringCodeUnits * 3);
    const byteLength = readLength(reader, maximumBytes, 'UTF-8 string length');
    const encoded = reader.take(byteLength);
    let value;
    try {
        value = utf8Decoder.decode(encoded);
    }
    catch {
        return binaryError('invalid UTF-8 string');
    }
    if (value.length > limits.maxStringCodeUnits)
        binaryError('string exceeds code-unit limit');
    return value;
}
function readUtf16String(reader, limits) {
    const codeUnits = readLength(reader, limits.maxStringCodeUnits, 'UTF-16 string length');
    const byteLength = codeUnits * 2;
    if (byteLength > MAX_STRING_BYTES)
        binaryError('string exceeds byte limit');
    const encoded = reader.take(byteLength);
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const parts = [];
    const chunkSize = 8_192;
    for (let offset = 0; offset < codeUnits; offset += chunkSize) {
        const count = Math.min(chunkSize, codeUnits - offset);
        const chunk = new Array(count);
        for (let index = 0; index < count; index++) {
            chunk[index] = view.getUint16((offset + index) * 2, true);
        }
        parts.push(String.fromCharCode(...chunk));
    }
    const value = parts.join('');
    if (!hasLoneSurrogate(value))
        binaryError('UTF-16 string has no lone surrogate');
    return value;
}
function readString(reader, limits) {
    const tag = reader.readU8();
    if (tag == VALUE_TAG.STRING_UTF8)
        return readUtf8String(reader, limits);
    if (tag == VALUE_TAG.STRING_UTF16)
        return readUtf16String(reader, limits);
    return binaryError('expected string');
}
function beginActive(active, value) {
    if (active.has(value))
        binaryError('cyclic values are not supported');
    active.add(value);
}
function exactPrototype(value, expected, label) {
    if (Object.getPrototypeOf(value) != expected)
        binaryError(label + ' subclasses are not supported');
}
function captureObject(value) {
    const keys = [];
    const values = [];
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key == 'symbol')
            binaryError('symbol object keys are not supported');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor)
            binaryError('object property descriptor disappeared');
        if (own.call(descriptor, 'get') || own.call(descriptor, 'set')) {
            binaryError('accessor properties are not supported');
        }
        if (descriptor.enumerable) {
            keys.push(key);
            values.push(descriptor.value);
        }
    }
    if (keys.length > MAX_OBJECT_KEYS)
        binaryRangeError('object exceeds key limit');
    return { keys, values };
}
function createShapeCacheState() {
    return {
        shapes: [],
        bySignature: new Map(),
        fieldRefs: 0,
        keyTextBytes: 0,
    };
}
function createShapeTransaction(state, limits) {
    return {
        state,
        limits,
        staged: [],
        stagedBySignature: new Map(),
        fieldRefs: state.fieldRefs,
        keyTextBytes: state.keyTextBytes,
        definitions: 0,
        references: 0,
        raw: 0,
    };
}
function encodedStringByteLength(value) {
    const byteLength = utf8ByteLength(value);
    return byteLength < 0 ? value.length * 2 : byteLength;
}
function shapeKeyTextByteLength(keys, maximum = Infinity) {
    let bytes = 0;
    for (const key of keys) {
        bytes += encodedStringByteLength(key);
        if (bytes > maximum)
            break;
    }
    return bytes;
}
function shapeSignature(prototype, keys) {
    return JSON.stringify([prototype, keys]);
}
function transactionShape(transaction, signature) {
    return transaction.stagedBySignature.get(signature)
        ?? transaction.state.bySignature.get(signature);
}
function canStageShape(transaction, keys, keyTextBytes) {
    return transaction.state.shapes.length + transaction.staged.length < transaction.limits.maxEntries
        && transaction.fieldRefs + keys.length <= transaction.limits.maxFieldRefs
        && transaction.keyTextBytes + keyTextBytes <= transaction.limits.maxKeyTextBytes;
}
function stageShape(transaction, prototype, keys, expectedId) {
    const id = transaction.state.shapes.length + transaction.staged.length;
    if (expectedId != undefined && expectedId != id) {
        binaryError('object shape declaration is out of order');
    }
    const keyTextBytes = shapeKeyTextByteLength(keys, transaction.limits.maxKeyTextBytes);
    if (!canStageShape(transaction, keys, keyTextBytes)) {
        binaryError('object shape cache budget exceeded');
    }
    const signature = shapeSignature(prototype, keys);
    if (transactionShape(transaction, signature))
        binaryError('duplicate object shape declaration');
    const shape = { id, prototype, keys, signature, keyTextBytes };
    transaction.staged.push(shape);
    transaction.stagedBySignature.set(signature, shape);
    transaction.fieldRefs += keys.length;
    transaction.keyTextBytes += keyTextBytes;
    transaction.definitions++;
    return shape;
}
function commitShapeTransaction(transaction) {
    for (const shape of transaction.staged) {
        transaction.state.shapes.push(shape);
        transaction.state.bySignature.set(shape.signature, shape);
    }
    transaction.state.fieldRefs = transaction.fieldRefs;
    transaction.state.keyTextBytes = transaction.keyTextBytes;
}
function isArrayIndexKey(key, length) {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < length && String(index) == key;
}
function validateArray(value) {
    exactPrototype(value, Array.prototype, 'Array');
    if (value.length > MAX_ARRAY_ITEMS)
        binaryRangeError('array exceeds item limit');
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key == 'symbol')
            binaryError('symbol array keys are not supported');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor)
            binaryError('array property descriptor disappeared');
        if (own.call(descriptor, 'get') || own.call(descriptor, 'set')) {
            binaryError('accessor properties are not supported');
        }
        if (key != 'length' && !isArrayIndexKey(key, value.length)) {
            binaryError('extra array properties are not supported');
        }
    }
}
function writeBinaryPayload(writer, tag, value, maxBinaryBytes) {
    if (value.byteLength > maxBinaryBytes)
        binaryRangeError('binary value exceeds limit');
    writer.writeU8(tag);
    writeLength(writer, value.byteLength);
    writer.writeBytes(value);
}
const writeValue = function writeBinaryValue(writer, value, depth, active, context) {
    if (++context.workUnits > MAX_VALUE_WORK_UNITS) {
        binaryRangeError('encoded value exceeds work limit');
    }
    if (depth > context.config.maxDepth)
        binaryRangeError('maximum depth exceeded');
    if (typeof value == 'undefined') {
        writer.writeU8(VALUE_TAG.UNDEFINED);
        return;
    }
    if (value == null) {
        writer.writeU8(VALUE_TAG.NULL);
        return;
    }
    if (typeof value == 'boolean') {
        writer.writeU8(value ? VALUE_TAG.TRUE : VALUE_TAG.FALSE);
        return;
    }
    if (typeof value == 'number') {
        if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
            writer.writeU8(VALUE_TAG.INTEGER);
            const zigzag = value < 0 ? (-value * 2) - 1 : value * 2;
            if (Number.isSafeInteger(zigzag)) {
                writer.writeVarUintNumber(zigzag, MAX_SAFE_INTEGER_VARUINT_BYTES);
            }
            else {
                const integer = BigInt(value);
                writer.writeVarUint(integer < 0n ? (-integer * 2n) - 1n : integer * 2n, MAX_SAFE_INTEGER_VARUINT_BYTES);
            }
        }
        else {
            writer.writeU8(VALUE_TAG.FLOAT64);
            writer.writeFloat64(value);
        }
        return;
    }
    if (typeof value == 'string') {
        writeString(writer, value);
        return;
    }
    if (typeof value == 'bigint') {
        const negative = value < 0n;
        const magnitude = negative ? -value : value;
        if (magnitude > MAX_BIGINT_MAGNITUDE)
            binaryRangeError('BigInt exceeds bit limit');
        writer.writeU8(VALUE_TAG.BIGINT);
        writer.writeU8(negative ? 1 : 0);
        writer.writeVarUint(magnitude);
        return;
    }
    const callbackRef = replayBinaryCallbackRefId(value);
    if (callbackRef != undefined) {
        if (!context.config.callbackRefs)
            binaryError('callback references are disabled');
        if (++context.callbackRefs > MAX_CALLBACK_REFS_PER_VALUE) {
            binaryRangeError('callback reference count exceeds protocol limit');
        }
        writer.writeU8(VALUE_TAG.CALLBACK_REF);
        writer.writeVarUintNumber(callbackRef, MAX_SAFE_INTEGER_VARUINT_BYTES);
        return;
    }
    if (typeof value == 'function')
        binaryError('function values are not supported');
    if (typeof value == 'symbol')
        binaryError('symbol values are not supported');
    if (typeof value != 'object')
        binaryError('unsupported value');
    if (Array.isArray(value)) {
        validateArray(value);
        beginActive(active, value);
        try {
            writer.writeU8(VALUE_TAG.ARRAY);
            writeLength(writer, value.length);
            for (let index = 0; index < value.length; index++) {
                if (!own.call(value, index)) {
                    if (++context.workUnits > MAX_VALUE_WORK_UNITS) {
                        binaryRangeError('encoded value exceeds work limit');
                    }
                    writer.writeU8(VALUE_TAG.ARRAY_HOLE);
                }
                else
                    writeValue(writer, value[index], depth + 1, active, context);
            }
        }
        finally {
            active.delete(value);
        }
        return;
    }
    if (value instanceof Date) {
        exactPrototype(value, Date.prototype, 'Date');
        rejectOwnNativeShadows(value, DATE_NATIVE_SHADOW_KEYS, 'Date');
        validateNativeOwnState(value, 'Date');
        writer.writeU8(VALUE_TAG.DATE);
        writer.writeFloat64(value.valueOf());
        return;
    }
    if (value instanceof RegExp) {
        exactPrototype(value, RegExp.prototype, 'RegExp');
        rejectOwnNativeShadows(value, REGEXP_NATIVE_SHADOW_KEYS, 'RegExp');
        validateNativeOwnState(value, 'RegExp');
        const source = value.source;
        const flags = validateRegExpV1(source, value.flags);
        writer.writeU8(VALUE_TAG.REGEXP);
        writeString(writer, source);
        writeString(writer, flags);
        return;
    }
    if (value instanceof Map) {
        exactPrototype(value, Map.prototype, 'Map');
        validateNativeOwnState(value, 'Map');
        if (value.size > MAX_ARRAY_ITEMS)
            binaryRangeError('Map exceeds item limit');
        beginActive(active, value);
        try {
            writer.writeU8(VALUE_TAG.MAP);
            writeLength(writer, value.size);
            for (const [key, item] of value) {
                writeValue(writer, key, depth + 1, active, context);
                writeValue(writer, item, depth + 1, active, context);
            }
        }
        finally {
            active.delete(value);
        }
        return;
    }
    if (value instanceof Set) {
        exactPrototype(value, Set.prototype, 'Set');
        validateNativeOwnState(value, 'Set');
        if (value.size > MAX_ARRAY_ITEMS)
            binaryRangeError('Set exceeds item limit');
        beginActive(active, value);
        try {
            writer.writeU8(VALUE_TAG.SET);
            writeLength(writer, value.size);
            for (const item of value)
                writeValue(writer, item, depth + 1, active, context);
        }
        finally {
            active.delete(value);
        }
        return;
    }
    if (value instanceof ArrayBuffer) {
        exactPrototype(value, ArrayBuffer.prototype, 'ArrayBuffer');
        rejectOwnNativeShadows(value, ARRAY_BUFFER_NATIVE_SHADOW_KEYS, 'ArrayBuffer');
        validateNativeOwnState(value, 'ArrayBuffer');
        rejectDynamicBinaryBuffer(value);
        writeBinaryPayload(writer, VALUE_TAG.ARRAY_BUFFER, new Uint8Array(value), context.config.maxBinaryBytes);
        return;
    }
    if (typeof SharedArrayBufferConstructor == 'function'
        && value instanceof SharedArrayBufferConstructor) {
        rejectDynamicBinaryBuffer(value);
    }
    if (ArrayBuffer.isView(value)) {
        rejectOwnNativeShadows(value, ARRAY_BUFFER_VIEW_NATIVE_SHADOW_KEYS, 'ArrayBuffer view');
        rejectDynamicBinaryBuffer(value.buffer);
        const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (value instanceof DataView) {
            exactPrototype(value, DataView.prototype, 'DataView');
            validateNativeOwnState(value, 'DataView');
            writeBinaryPayload(writer, VALUE_TAG.DATA_VIEW, source, context.config.maxBinaryBytes);
            return;
        }
        const entry = typedArrayEntryForValue(value);
        if (!entry)
            binaryError('non-standard typed arrays are not supported');
        validateNativeOwnState(value, 'TypedArray', source.byteLength / entry.bytesPerElement);
        if (source.byteLength > context.config.maxBinaryBytes)
            binaryRangeError('binary value exceeds limit');
        const payload = PLATFORM_LITTLE_ENDIAN || entry.bytesPerElement == 1
            ? source
            : copyTypedArrayEndianAdjusted(source, entry.bytesPerElement);
        writer.writeU8(VALUE_TAG.TYPED_ARRAY);
        writer.writeU8(entry.code);
        writeLength(writer, payload.byteLength);
        writer.writeBytes(payload);
        return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype != Object.prototype && prototype != null) {
        binaryError('class instances are not supported');
    }
    const captured = captureObject(value);
    const keys = captured.keys;
    const values = captured.values;
    const prototypeCode = prototype == null ? 1 : 0;
    beginActive(active, value);
    try {
        const shapes = context.shapes;
        if (shapes && keys.length <= shapes.limits.maxFieldRefs) {
            const signature = shapeSignature(prototypeCode, keys);
            const known = transactionShape(shapes, signature);
            if (known) {
                writer.writeU8(VALUE_TAG.OBJECT_SHAPE_REF);
                writeLength(writer, known.id);
                shapes.references++;
                for (const item of values) {
                    writeValue(writer, item, depth + 1, active, context);
                }
                return;
            }
            const keyTextBytes = shapeKeyTextByteLength(keys, shapes.limits.maxKeyTextBytes);
            if (keyTextBytes <= shapes.limits.maxKeyTextBytes) {
                if (canStageShape(shapes, keys, keyTextBytes)) {
                    const shape = stageShape(shapes, prototypeCode, keys);
                    writer.writeU8(VALUE_TAG.OBJECT_SHAPE_DEF);
                    writeLength(writer, shape.id);
                    writer.writeU8(shape.prototype);
                    writeLength(writer, shape.keys.length);
                    for (const key of shape.keys)
                        writeString(writer, key);
                    for (const item of values) {
                        writeValue(writer, item, depth + 1, active, context);
                    }
                    return;
                }
            }
            shapes.raw++;
        }
        writer.writeU8(VALUE_TAG.OBJECT);
        writer.writeU8(prototypeCode);
        writeLength(writer, keys.length);
        for (let index = 0; index < keys.length; index++) {
            writeString(writer, keys[index]);
            writeValue(writer, values[index], depth + 1, active, context);
        }
    }
    finally {
        active.delete(value);
    }
};
function copyBinary(value) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy;
}
function copyTypedArrayEndianAdjusted(value, bytesPerElement) {
    const copy = copyBinary(value);
    if (PLATFORM_LITTLE_ENDIAN || bytesPerElement == 1)
        return copy;
    for (let offset = 0; offset < copy.byteLength; offset += bytesPerElement) {
        for (let left = 0, right = bytesPerElement - 1; left < right; left++, right--) {
            const byte = copy[offset + left];
            copy[offset + left] = copy[offset + right];
            copy[offset + right] = byte;
        }
    }
    return copy;
}
function readBinaryPayload(reader, limits) {
    const byteLength = readLength(reader, limits.maxBinaryBytes, 'binary length');
    return reader.take(byteLength);
}
function defineDecodedValue(target, key, value, context, nullPrototype) {
    if (nullPrototype) {
        target[key] = value;
        return;
    }
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, key);
    if (!inherited || own.call(inherited, 'value') && inherited.writable == true) {
        target[key] = value;
        return;
    }
    const property = context.property;
    property.value = value;
    const defined = Reflect.defineProperty(target, key, property);
    property.value = undefined;
    if (!defined)
        binaryError('cannot define decoded object key');
}
function transactionShapeById(transaction, id) {
    if (id < transaction.state.shapes.length)
        return transaction.state.shapes[id];
    return transaction.staged[id - transaction.state.shapes.length];
}
function decodedShapeObject(reader, depth, limits, context, shape) {
    if (shape.keys.length > limits.maxObjectKeys)
        binaryError('object exceeds key limit');
    if (shape.keys.some(key => key.length > limits.maxStringCodeUnits)) {
        binaryError('object shape key exceeds string limit');
    }
    if (reader.remaining() < shape.keys.length)
        binaryError('truncated shaped object');
    const value = shape.prototype == 1 ? Object.create(null) : {};
    for (const key of shape.keys) {
        defineDecodedValue(value, key, readValue(reader, depth + 1, limits, context), context, shape.prototype == 1);
    }
    return value;
}
const readValue = function readBinaryValue(reader, depth, limits, context, allowHole = false) {
    if (++context.workUnits > MAX_VALUE_WORK_UNITS) {
        binaryError('decoded value exceeds work limit');
    }
    if (depth > limits.maxDepth)
        binaryError('maximum depth exceeded');
    const tag = reader.readU8();
    if (tag == VALUE_TAG.NULL)
        return null;
    if (tag == VALUE_TAG.UNDEFINED)
        return undefined;
    if (tag == VALUE_TAG.FALSE)
        return false;
    if (tag == VALUE_TAG.TRUE)
        return true;
    if (tag == VALUE_TAG.ARRAY_HOLE) {
        if (!allowHole)
            binaryError('array-hole tag outside an array');
        return ARRAY_HOLE;
    }
    if (tag == VALUE_TAG.INTEGER) {
        return reader.readSafeInteger();
    }
    if (tag == VALUE_TAG.FLOAT64)
        return reader.readFloat64();
    if (tag == VALUE_TAG.STRING_UTF8)
        return readUtf8String(reader, limits);
    if (tag == VALUE_TAG.STRING_UTF16)
        return readUtf16String(reader, limits);
    if (tag == VALUE_TAG.BIGINT) {
        const sign = reader.readU8();
        if (sign != 0 && sign != 1)
            binaryError('invalid BigInt sign');
        const magnitude = reader.readVarUint(MAX_BIGINT_VARUINT_BYTES, 'BigInt', MAX_BIGINT_MAGNITUDE);
        if (sign == 1 && magnitude == 0n)
            binaryError('negative zero BigInt is not canonical');
        return sign == 1 ? -magnitude : magnitude;
    }
    if (tag == VALUE_TAG.CALLBACK_REF) {
        if (!context.config.callbackRefs)
            binaryError('callback references are disabled');
        if (++context.callbackRefs > MAX_CALLBACK_REFS_PER_VALUE) {
            binaryRangeError('callback reference count exceeds protocol limit');
        }
        const id = reader.readVarUintNumber(MAX_SAFE_INTEGER_VARUINT_BYTES, 'callback reference', Number.MAX_SAFE_INTEGER);
        return createReplayBinaryCallbackRef(id);
    }
    if (tag == VALUE_TAG.DATE)
        return new Date(reader.readFloat64());
    if (tag == VALUE_TAG.REGEXP) {
        const source = readString(reader, limits);
        const flags = validateRegExpV1(source, readString(reader, limits));
        return new RegExp(source, flags);
    }
    if (tag == VALUE_TAG.ARRAY) {
        const length = readLength(reader, limits.maxArrayItems, 'array length');
        if (reader.remaining() < length)
            binaryError('truncated array');
        const value = new Array(length);
        for (let index = 0; index < length; index++) {
            const item = readValue(reader, depth + 1, limits, context, true);
            if (item !== ARRAY_HOLE)
                value[index] = item;
        }
        return value;
    }
    if (tag == VALUE_TAG.OBJECT) {
        const prototype = reader.readU8();
        if (prototype != 0 && prototype != 1)
            binaryError('invalid object prototype');
        const count = readLength(reader, limits.maxObjectKeys, 'object key count');
        if (reader.remaining() < count * 3)
            binaryError('truncated object');
        const value = prototype == 1 ? Object.create(null) : {};
        const keys = new Set();
        for (let index = 0; index < count; index++) {
            const key = readString(reader, limits);
            if (keys.has(key))
                binaryError('duplicate object key');
            keys.add(key);
            defineDecodedValue(value, key, readValue(reader, depth + 1, limits, context), context, prototype == 1);
        }
        return value;
    }
    if (tag == VALUE_TAG.OBJECT_SHAPE_DEF) {
        const shapes = context.shapes;
        if (!shapes)
            binaryError('object shape cache is disabled');
        const id = readLength(reader, shapes.limits.maxEntries - 1, 'object shape id');
        const prototype = reader.readU8();
        if (prototype != 0 && prototype != 1)
            binaryError('invalid object shape prototype');
        const count = readLength(reader, limits.maxObjectKeys, 'object shape key count');
        if (reader.remaining() < count * 3)
            binaryError('truncated object shape');
        const keys = [];
        const unique = new Set();
        for (let index = 0; index < count; index++) {
            const key = readString(reader, limits);
            if (unique.has(key))
                binaryError('duplicate object shape key');
            unique.add(key);
            keys.push(key);
        }
        const shape = stageShape(shapes, prototype, keys, id);
        return decodedShapeObject(reader, depth, limits, context, shape);
    }
    if (tag == VALUE_TAG.OBJECT_SHAPE_REF) {
        const shapes = context.shapes;
        if (!shapes)
            binaryError('object shape cache is disabled');
        const id = readLength(reader, shapes.limits.maxEntries - 1, 'object shape id');
        const shape = transactionShapeById(shapes, id);
        if (!shape)
            binaryError('unknown object shape reference');
        shapes.references++;
        return decodedShapeObject(reader, depth, limits, context, shape);
    }
    if (tag == VALUE_TAG.MAP) {
        const count = readLength(reader, limits.maxArrayItems, 'Map item count');
        if (reader.remaining() < count * 2)
            binaryError('truncated Map');
        const value = new Map();
        for (let index = 0; index < count; index++) {
            const key = readValue(reader, depth + 1, limits, context);
            if (value.has(key))
                binaryError('duplicate Map key');
            value.set(key, readValue(reader, depth + 1, limits, context));
        }
        return value;
    }
    if (tag == VALUE_TAG.SET) {
        const count = readLength(reader, limits.maxArrayItems, 'Set item count');
        if (reader.remaining() < count)
            binaryError('truncated Set');
        const value = new Set();
        for (let index = 0; index < count; index++) {
            const item = readValue(reader, depth + 1, limits, context);
            if (value.has(item))
                binaryError('duplicate Set value');
            value.add(item);
        }
        return value;
    }
    if (tag == VALUE_TAG.ARRAY_BUFFER) {
        return copyBinary(readBinaryPayload(reader, limits)).buffer;
    }
    if (tag == VALUE_TAG.DATA_VIEW) {
        return new DataView(copyBinary(readBinaryPayload(reader, limits)).buffer);
    }
    if (tag == VALUE_TAG.TYPED_ARRAY) {
        const code = reader.readU8();
        const entry = typedArrayEntryByCode(code);
        if (!entry)
            binaryError('unknown or unsupported typed-array code');
        const payload = readBinaryPayload(reader, limits);
        if (payload.byteLength % entry.bytesPerElement != 0) {
            binaryError('typed-array byte length is misaligned');
        }
        const copy = copyTypedArrayEndianAdjusted(payload, entry.bytesPerElement);
        try {
            return trustReplayBinaryLeaf(new entry.Constructor(copy.buffer));
        }
        catch {
            return binaryError('cannot construct typed array');
        }
    }
    return binaryError('unknown value tag');
};
function defineTrustedDecodedValue(target, key, value, nullPrototype) {
    if (nullPrototype || !(key in Object.prototype)) {
        target[key] = value;
        return;
    }
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    });
}
function readTrustedUtf8String(reader, limits) {
    const byteLength = reader.readVarUintNumberTrusted();
    if (byteLength > Math.min(MAX_STRING_BYTES, limits.maxStringCodeUnits * 3)) {
        return binaryRangeError('trusted UTF-8 string exceeds limit');
    }
    const value = trustedUtf8Decoder.decode(reader.take(byteLength));
    if (value.length > limits.maxStringCodeUnits) {
        return binaryRangeError('trusted UTF-8 string exceeds code-unit limit');
    }
    return value;
}
function readTrustedUtf16String(reader, limits) {
    const codeUnits = reader.readVarUintNumberTrusted();
    if (codeUnits > limits.maxStringCodeUnits || codeUnits * 2 > MAX_STRING_BYTES) {
        return binaryRangeError('trusted UTF-16 string exceeds limit');
    }
    const encoded = reader.take(codeUnits * 2);
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const parts = [];
    const chunkSize = 8_192;
    for (let offset = 0; offset < codeUnits; offset += chunkSize) {
        const count = Math.min(chunkSize, codeUnits - offset);
        const chunk = new Array(count);
        for (let index = 0; index < count; index++) {
            chunk[index] = view.getUint16((offset + index) * 2, true);
        }
        parts.push(String.fromCharCode(...chunk));
    }
    return parts.join('');
}
function readTrustedString(reader, limits) {
    const tag = reader.readU8();
    if (tag == VALUE_TAG.STRING_UTF8)
        return readTrustedUtf8String(reader, limits);
    if (tag == VALUE_TAG.STRING_UTF16)
        return readTrustedUtf16String(reader, limits);
    return binaryError('expected trusted string');
}
function readTrustedValue(reader, limits, context, allowHole = false) {
    const tag = reader.readU8();
    if (tag == VALUE_TAG.NULL)
        return null;
    if (tag == VALUE_TAG.UNDEFINED)
        return undefined;
    if (tag == VALUE_TAG.FALSE)
        return false;
    if (tag == VALUE_TAG.TRUE)
        return true;
    if (tag == VALUE_TAG.ARRAY_HOLE)
        return allowHole ? ARRAY_HOLE : binaryError('unexpected array hole');
    if (tag == VALUE_TAG.INTEGER)
        return reader.readSafeIntegerTrusted();
    if (tag == VALUE_TAG.FLOAT64)
        return reader.readFloat64();
    if (tag == VALUE_TAG.STRING_UTF8)
        return readTrustedUtf8String(reader, limits);
    if (tag == VALUE_TAG.STRING_UTF16)
        return readTrustedUtf16String(reader, limits);
    if (tag == VALUE_TAG.BIGINT) {
        const negative = reader.readU8() == 1;
        const magnitude = reader.readVarUintTrusted();
        return negative ? -magnitude : magnitude;
    }
    if (tag == VALUE_TAG.CALLBACK_REF) {
        return createReplayBinaryCallbackRef(reader.readVarUintNumberTrusted());
    }
    if (tag == VALUE_TAG.DATE)
        return new Date(reader.readFloat64());
    if (tag == VALUE_TAG.REGEXP) {
        return new RegExp(readTrustedString(reader, limits), readTrustedString(reader, limits));
    }
    if (tag == VALUE_TAG.ARRAY) {
        const length = reader.readVarUintNumberTrusted();
        if (length > limits.maxArrayItems)
            return binaryRangeError('trusted array exceeds limit');
        const value = new Array(length);
        for (let index = 0; index < length; index++) {
            const item = readTrustedValue(reader, limits, context, true);
            if (item !== ARRAY_HOLE)
                value[index] = item;
        }
        return value;
    }
    if (tag == VALUE_TAG.OBJECT) {
        const nullPrototype = reader.readU8() == 1;
        const count = reader.readVarUintNumberTrusted();
        if (count > limits.maxObjectKeys)
            return binaryRangeError('trusted object exceeds limit');
        const value = nullPrototype ? Object.create(null) : {};
        for (let index = 0; index < count; index++) {
            defineTrustedDecodedValue(value, readTrustedString(reader, limits), readTrustedValue(reader, limits, context), nullPrototype);
        }
        return value;
    }
    if (tag == VALUE_TAG.OBJECT_SHAPE_DEF) {
        const shapes = context.shapes;
        if (!shapes)
            return binaryError('trusted object shape cache is disabled');
        const id = reader.readVarUintNumberTrusted();
        const prototype = reader.readU8() == 1 ? 1 : 0;
        const count = reader.readVarUintNumberTrusted();
        if (count > limits.maxObjectKeys)
            return binaryRangeError('trusted shape exceeds limit');
        const keys = new Array(count);
        for (let index = 0; index < count; index++) {
            keys[index] = readTrustedString(reader, limits);
        }
        const shape = stageShape(shapes, prototype, keys, id);
        const value = prototype == 1 ? Object.create(null) : {};
        for (const key of shape.keys) {
            defineTrustedDecodedValue(value, key, readTrustedValue(reader, limits, context), prototype == 1);
        }
        return value;
    }
    if (tag == VALUE_TAG.OBJECT_SHAPE_REF) {
        const shapes = context.shapes;
        if (!shapes)
            return binaryError('trusted object shape cache is disabled');
        const shape = transactionShapeById(shapes, reader.readVarUintNumberTrusted());
        if (!shape)
            return binaryError('unknown trusted object shape');
        shapes.references++;
        const nullPrototype = shape.prototype == 1;
        const value = nullPrototype ? Object.create(null) : {};
        for (const key of shape.keys) {
            defineTrustedDecodedValue(value, key, readTrustedValue(reader, limits, context), nullPrototype);
        }
        return value;
    }
    if (tag == VALUE_TAG.MAP) {
        const count = reader.readVarUintNumberTrusted();
        if (count > limits.maxArrayItems)
            return binaryRangeError('trusted Map exceeds limit');
        const value = new Map();
        for (let index = 0; index < count; index++) {
            value.set(readTrustedValue(reader, limits, context), readTrustedValue(reader, limits, context));
        }
        return value;
    }
    if (tag == VALUE_TAG.SET) {
        const count = reader.readVarUintNumberTrusted();
        if (count > limits.maxArrayItems)
            return binaryRangeError('trusted Set exceeds limit');
        const value = new Set();
        for (let index = 0; index < count; index++) {
            value.add(readTrustedValue(reader, limits, context));
        }
        return value;
    }
    if (tag == VALUE_TAG.ARRAY_BUFFER) {
        const byteLength = reader.readVarUintNumberTrusted();
        if (byteLength > limits.maxBinaryBytes)
            return binaryRangeError('trusted binary exceeds limit');
        return copyBinary(reader.take(byteLength)).buffer;
    }
    if (tag == VALUE_TAG.DATA_VIEW) {
        const byteLength = reader.readVarUintNumberTrusted();
        if (byteLength > limits.maxBinaryBytes)
            return binaryRangeError('trusted binary exceeds limit');
        return new DataView(copyBinary(reader.take(byteLength)).buffer);
    }
    if (tag == VALUE_TAG.TYPED_ARRAY) {
        const entry = typedArrayEntryByCode(reader.readU8());
        if (!entry)
            return binaryError('unknown typed-array code');
        const byteLength = reader.readVarUintNumberTrusted();
        if (byteLength > limits.maxBinaryBytes)
            return binaryRangeError('trusted binary exceeds limit');
        const copy = copyTypedArrayEndianAdjusted(reader.take(byteLength), entry.bytesPerElement);
        try {
            return trustReplayBinaryLeaf(new entry.Constructor(copy.buffer));
        }
        catch {
            return binaryError('cannot construct typed array');
        }
    }
    return binaryError('unknown trusted value tag');
}
function wireBytes(wire) {
    if (wire instanceof ArrayBuffer)
        return new Uint8Array(wire);
    if (ArrayBuffer.isView(wire)) {
        return new Uint8Array(wire.buffer, wire.byteOffset, wire.byteLength);
    }
    return binaryError('wire must be an ArrayBuffer or ArrayBuffer view');
}
function integerOption(value, fallback, maximum, label) {
    const resolved = value == undefined ? fallback : value;
    if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum) {
        throw new RangeError(label + ' must be an integer from 0 through ' + maximum);
    }
    return resolved;
}
function positiveIntegerOption(value, fallback, label) {
    const resolved = value == undefined ? fallback : value;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw new RangeError(label + ' must be a positive safe integer');
    }
    return resolved;
}
function resolveShapeCacheOptions(value) {
    if (value == undefined)
        return undefined;
    if (typeof value == 'boolean') {
        if (!value)
            return undefined;
    }
    else if (typeof value == 'number') {
        if (value == 0)
            return undefined;
    }
    else if (value == null || typeof value != 'object') {
        throw new TypeError('binary shape-cache option must be boolean, number or options');
    }
    const options = value != null && typeof value == 'object' ? value : undefined;
    const maxEntries = integerOption(typeof value == 'number' ? value : options?.maxEntries, MAX_SHAPE_ENTRIES, MAX_SHAPE_ENTRIES, 'binary shape-cache maxEntries');
    if (maxEntries == 0)
        return undefined;
    return {
        maxEntries,
        maxFieldRefs: integerOption(options?.maxFieldRefs, MAX_SHAPE_FIELD_REFS, MAX_SHAPE_FIELD_REFS, 'binary shape-cache maxFieldRefs'),
        maxKeyTextBytes: integerOption(options?.maxKeyTextBytes, MAX_SHAPE_KEY_TEXT_BYTES, MAX_SHAPE_KEY_TEXT_BYTES, 'binary shape-cache maxKeyTextBytes'),
    };
}
function resolveCodecConfig(options) {
    if (!options || typeof options != 'object') {
        throw new TypeError('binary value codec options are required');
    }
    const magic = new Uint8Array(options.magic);
    if (magic.byteLength == 0 || magic.byteLength > 16
        || Array.from(options.magic).some(byte => !Number.isInteger(byte) || byte < 0 || byte > 0xff)) {
        throw new RangeError('binary value codec magic must contain 1 through 16 bytes');
    }
    if (!Number.isInteger(options.version) || options.version < 0 || options.version > 0xff) {
        throw new RangeError('binary value codec version must be one byte');
    }
    if (typeof options.label != 'string' || options.label.length == 0) {
        throw new TypeError('binary value codec label must be a non-empty string');
    }
    return {
        magic,
        version: options.version,
        label: options.label,
        callbackRefs: options.callbackRefs == true,
        shapeLimits: resolveShapeCacheOptions(options.shapeCache),
        maxDepth: integerOption(options.maxDepth, DEFAULT_MAX_DEPTH, MAX_CODEC_DEPTH, 'binary value maxDepth'),
        maxBinaryBytes: positiveIntegerOption(options.maxBinaryBytes, DEFAULT_MAX_BINARY_BYTES, 'binary value maxBinaryBytes'),
        maxWireBytes: positiveIntegerOption(options.maxWireBytes, DEFAULT_MAX_WIRE_BYTES, 'binary value maxWireBytes'),
    };
}
function throwLabeledError(label, error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RangeError)
        throw new RangeError(label + ': ' + message);
    throw new TypeError(label + ': ' + message);
}
function createBinaryValueCodec(options) {
    const config = resolveCodecConfig(options);
    let encodeShapes = createShapeCacheState();
    let decodeShapes = createShapeCacheState();
    let pendingEncode;
    let generation = 0;
    let encodeDefinitions = 0;
    let encodeReferences = 0;
    let encodeRawShapes = 0;
    let decodeDefinitions = 0;
    let decodeReferences = 0;
    function applyEncodeStats(transaction) {
        if (!transaction)
            return;
        encodeDefinitions += transaction.definitions;
        encodeReferences += transaction.references;
        encodeRawShapes += transaction.raw;
    }
    function applyDecodeStats(transaction) {
        if (!transaction)
            return;
        decodeDefinitions += transaction.definitions;
        decodeReferences += transaction.references;
    }
    function writeEncodedValue(writer, value, shapes) {
        for (const byte of config.magic)
            writer.writeU8(byte);
        writer.writeU8(config.version);
        writeValue(writer, value, 0, new WeakSet(), {
            config,
            shapes,
            workUnits: 0,
            callbackRefs: 0,
        });
    }
    function prepareEncode(value) {
        if (pendingEncode) {
            throw new Error(config.label + ': prepared encode must be committed or rolled back');
        }
        try {
            const shapes = config.shapeLimits
                ? createShapeTransaction(encodeShapes, config.shapeLimits)
                : undefined;
            const writer = createByteWriter(config.maxWireBytes);
            writeEncodedValue(writer, value, shapes);
            const wire = trustReplayBinaryLeaf(writer.finish());
            const preparedGeneration = generation;
            let settled = false;
            const token = {};
            pendingEncode = token;
            function commit() {
                if (settled)
                    return;
                if (preparedGeneration != generation || pendingEncode != token) {
                    throw new Error(config.label + ': prepared encode belongs to an obsolete generation');
                }
                settled = true;
                pendingEncode = undefined;
                if (shapes)
                    commitShapeTransaction(shapes);
                applyEncodeStats(shapes);
            }
            function rollback() {
                if (settled)
                    return;
                settled = true;
                if (pendingEncode == token)
                    pendingEncode = undefined;
            }
            return { wire, commit, rollback };
        }
        catch (error) {
            return throwLabeledError(config.label, error);
        }
    }
    function measureEncode(value) {
        if (pendingEncode) {
            throw new Error(config.label + ': prepared encode must be committed or rolled back');
        }
        try {
            const shapes = config.shapeLimits
                ? createShapeTransaction(encodeShapes, config.shapeLimits)
                : undefined;
            const writer = createByteCounter(config.maxWireBytes);
            writeEncodedValue(writer, value, shapes);
            return writer.byteLength();
        }
        catch (error) {
            return throwLabeledError(config.label, error);
        }
    }
    function encode(value) {
        const prepared = prepareEncode(value);
        prepared.commit();
        return prepared.wire;
    }
    function decodeValue(wire, requestedLimits, wireLimits, trusted = false) {
        try {
            const bytes = wireBytes(wire);
            const limits = binaryDecodeLimits(config, requestedLimits, wireLimits);
            if (bytes.byteLength > limits.maxWireBytes) {
                binaryRangeError('encoded frame exceeds binary limit');
            }
            const reader = createByteReader(bytes);
            for (const expected of config.magic) {
                if (reader.readU8() != expected)
                    binaryError('magic mismatch');
            }
            const version = reader.readU8();
            if (version != config.version)
                binaryError('unsupported version');
            const shapes = config.shapeLimits
                ? createShapeTransaction(decodeShapes, config.shapeLimits)
                : undefined;
            const value = trusted
                ? readTrustedValue(reader, limits, { config, shapes })
                : readValue(reader, 0, limits, {
                    config,
                    shapes,
                    workUnits: 0,
                    callbackRefs: 0,
                    property: {
                        configurable: true,
                        enumerable: true,
                        writable: true,
                        value: undefined,
                    },
                });
            if (!reader.done())
                binaryError('trailing bytes');
            if (shapes)
                commitShapeTransaction(shapes);
            applyDecodeStats(shapes);
            return value;
        }
        catch (error) {
            return throwLabeledError(config.label, error);
        }
    }
    function decode(wire, requestedLimits, wireLimits) {
        return decodeValue(wire, requestedLimits, wireLimits);
    }
    function decodeTrusted(wire, requestedLimits, wireLimits) {
        return decodeValue(wire, requestedLimits, wireLimits, true);
    }
    function stats() {
        return {
            generation,
            pendingEncode: pendingEncode != undefined,
            encodeShapes: encodeShapes.shapes.length,
            decodeShapes: decodeShapes.shapes.length,
            encodeFieldRefs: encodeShapes.fieldRefs,
            decodeFieldRefs: decodeShapes.fieldRefs,
            encodeKeyTextBytes: encodeShapes.keyTextBytes,
            decodeKeyTextBytes: decodeShapes.keyTextBytes,
            encodeDefinitions,
            encodeReferences,
            encodeRawShapes,
            decodeDefinitions,
            decodeReferences,
        };
    }
    function reset() {
        if (pendingEncode) {
            throw new Error(config.label + ': cannot reset with an unsettled prepared encode');
        }
        generation++;
        encodeShapes = createShapeCacheState();
        decodeShapes = createShapeCacheState();
        encodeDefinitions = 0;
        encodeReferences = 0;
        encodeRawShapes = 0;
        decodeDefinitions = 0;
        decodeReferences = 0;
    }
    return { encode, prepareEncode, measureEncode, decode, decodeTrusted, stats, reset };
}
