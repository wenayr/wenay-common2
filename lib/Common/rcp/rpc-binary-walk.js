"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rollbackRpcBinaryCallbacks = rollbackRpcBinaryCallbacks;
exports.packRpcBinaryArgs = packRpcBinaryArgs;
exports.unpackRpcBinaryArgs = unpackRpcBinaryArgs;
exports.unpackRpcBinaryArgsTrusted = unpackRpcBinaryArgsTrusted;
exports.validateRpcBinaryResultTrusted = validateRpcBinaryResultTrusted;
exports.validateRpcBinaryResult = validateRpcBinaryResult;
exports.snapshotRpcBinaryResult = snapshotRpcBinaryResult;
exports.rpcBinaryErrorToDto = rpcBinaryErrorToDto;
exports.reviveRpcBinaryError = reviveRpcBinaryError;
const myThrow_1 = require("../../toError/myThrow");
const rpc_limits_1 = require("./rpc-limits");
const rpc_walk_1 = require("./rpc-walk");
const rpc_binary_value_1 = require("./rpc-binary-value");
const own = Object.prototype.hasOwnProperty;
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
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const SharedArrayBufferConstructor = globalThis.SharedArrayBuffer;
const sharedArrayBufferGrowableGetter = typeof SharedArrayBufferConstructor == 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBufferConstructor.prototype, 'growable')?.get
    : undefined;
const TYPED_ARRAY_CONSTRUCTORS = [
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
].map(function resolveTypedArrayConstructor(name) {
    const Constructor = globalThis[name];
    return typeof Constructor == 'function' ? Constructor : undefined;
}).filter(function hasTypedArrayConstructor(Constructor) {
    return Constructor != undefined;
});
function binaryWalkError(message) {
    throw new TypeError('rpc binary value: ' + message);
}
function exactPrototype(value, expected, label) {
    if (Object.getPrototypeOf(value) != expected) {
        binaryWalkError(label + ' subclasses are not supported');
    }
}
function rejectOwnNativeShadows(value, keys, label) {
    for (const key of keys) {
        if (own.call(value, key)) {
            binaryWalkError(label + ' own ' + key + ' shadow is not supported');
        }
    }
}
function validateRegExpV1(source, flags) {
    const error = (0, rpc_binary_value_1.rpcBinaryRegExpV1Error)(source, flags);
    if (error)
        binaryWalkError(error);
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
        binaryWalkError('resizable and growable binary buffers are not supported in protocol v1');
    }
}
function validateNativeOwnState(value, kind, typedArrayItems) {
    const error = (0, rpc_binary_value_1.rpcBinaryNativeOwnStateError)(value, kind, typedArrayItems);
    if (error)
        binaryWalkError(error);
}
function beginActive(context, value) {
    if (context.active.has(value))
        binaryWalkError('cyclic values are not supported');
    context.active.add(value);
}
function withActive(context, value, run) {
    beginActive(context, value);
    try {
        return run();
    }
    finally {
        context.active.delete(value);
    }
}
function checkDepth(context, depth) {
    if (context.limits && depth > context.limits.maxDepth) {
        throw new rpc_limits_1.PayloadLimitError('max depth exceeded');
    }
}
function checkString(context, value) {
    if (context.limits && value.length > context.limits.maxStringLen) {
        throw new rpc_limits_1.PayloadLimitError('string too long');
    }
}
function checkBinary(context, byteLength) {
    if (context.limits && byteLength > context.limits.maxBinaryLen) {
        throw new rpc_limits_1.PayloadLimitError('binary too long');
    }
}
function checkCollection(context, size, label) {
    if (context.limits && size > context.limits.maxArrayLen) {
        throw new rpc_limits_1.PayloadLimitError(label + ' too long');
    }
}
function isNodeBuffer(value) {
    const Constructor = globalThis.Buffer;
    return typeof Constructor?.isBuffer == 'function' && Constructor.isBuffer(value);
}
function normalizeNodeBuffer(value) {
    const Constructor = globalThis.Buffer;
    if (Object.getPrototypeOf(value) != Constructor.prototype) {
        binaryWalkError('Buffer subclasses are not supported');
    }
    const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return (0, rpc_binary_value_1.trustRpcBinaryLeaf)(copy);
}
function normalizeBinaryValue(value, context) {
    if (value instanceof ArrayBuffer) {
        exactPrototype(value, ArrayBuffer.prototype, 'ArrayBuffer');
        rejectOwnNativeShadows(value, ARRAY_BUFFER_NATIVE_SHADOW_KEYS, 'ArrayBuffer');
        validateNativeOwnState(value, 'ArrayBuffer');
        rejectDynamicBinaryBuffer(value);
        checkBinary(context, value.byteLength);
        return context.snapshot ? value.slice(0) : value;
    }
    if (typeof SharedArrayBufferConstructor == 'function'
        && value instanceof SharedArrayBufferConstructor) {
        rejectDynamicBinaryBuffer(value);
    }
    if (!ArrayBuffer.isView(value))
        return undefined;
    rejectOwnNativeShadows(value, ARRAY_BUFFER_VIEW_NATIVE_SHADOW_KEYS, 'ArrayBuffer view');
    rejectDynamicBinaryBuffer(value.buffer);
    checkBinary(context, value.byteLength);
    if (isNodeBuffer(value)) {
        if (Object.getPrototypeOf(value) != globalThis.Buffer.prototype) {
            binaryWalkError('Buffer subclasses are not supported');
        }
        validateNativeOwnState(value, 'TypedArray', value.byteLength);
        return context.snapshot ? normalizeNodeBuffer(value) : value;
    }
    if (value instanceof DataView) {
        exactPrototype(value, DataView.prototype, 'DataView');
        validateNativeOwnState(value, 'DataView');
        if (!context.snapshot)
            return value;
        const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const copy = new Uint8Array(source.byteLength);
        copy.set(source);
        return new DataView(copy.buffer);
    }
    const Constructor = TYPED_ARRAY_CONSTRUCTORS.find(function matchTypedArray(candidate) {
        return Object.getPrototypeOf(value) == candidate.prototype;
    });
    if (!Constructor)
        binaryWalkError('non-standard typed arrays are not supported');
    validateNativeOwnState(value, 'TypedArray', value.byteLength / Constructor.BYTES_PER_ELEMENT);
    if (!context.snapshot)
        return value;
    const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return (0, rpc_binary_value_1.trustRpcBinaryLeaf)(new Constructor(copy.buffer));
}
function isArrayIndexKey(key, length) {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < length && String(index) == key;
}
function validateArray(value) {
    exactPrototype(value, Array.prototype, 'Array');
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key == 'symbol')
            binaryWalkError('symbol array keys are not supported');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor)
            binaryWalkError('array property descriptor disappeared');
        if (own.call(descriptor, 'get') || own.call(descriptor, 'set')) {
            binaryWalkError('accessor properties are not supported');
        }
        if (key != 'length' && !isArrayIndexKey(key, value.length)) {
            binaryWalkError('extra array properties are not supported');
        }
    }
}
function captureObject(value) {
    const keys = [];
    const values = [];
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key == 'symbol')
            binaryWalkError('symbol object keys are not supported');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor)
            binaryWalkError('object property descriptor disappeared');
        if (own.call(descriptor, 'get') || own.call(descriptor, 'set')) {
            binaryWalkError('accessor properties are not supported');
        }
        if (descriptor.enumerable) {
            keys.push(key);
            values.push(descriptor.value);
        }
    }
    return { keys, values };
}
function defineWalkValue(target, key, value, nullPrototype) {
    if (nullPrototype) {
        target[key] = value;
        return;
    }
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, key);
    if (!inherited || own.call(inherited, 'value') && inherited.writable == true) {
        target[key] = value;
        return;
    }
    const defined = Reflect.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    });
    if (!defined)
        binaryWalkError('cannot define object key');
}
function callbackRefValue(value, context) {
    const id = (0, rpc_binary_value_1.rpcBinaryCallbackRefId)(value);
    if (id == undefined)
        return undefined;
    if (context.mode != 'unpack')
        binaryWalkError('callback reference outside RPC arguments');
    if (!Number.isSafeInteger(id) || id < 0)
        binaryWalkError('invalid callback id');
    const count = context.callbackCount;
    if (++count.value > context.limits.maxCallbacks) {
        throw new rpc_limits_1.PayloadLimitError('too many callbacks');
    }
    return (0, rpc_walk_1.createRpcCallbackWrapper)({
        id,
        sender: context.sender,
        onEnd: context.onEnd,
        legacyStopSentinel: false,
    });
}
function transformArray(value, context, depth) {
    checkCollection(context, value.length, 'array');
    validateArray(value);
    return withActive(context, value, function transformActiveArray() {
        const transformed = new Array(value.length);
        for (let index = 0; index < value.length; index++) {
            if (own.call(value, index)) {
                transformed[index] = transformValue(value[index], context, depth + 1);
            }
        }
        return transformed;
    });
}
function transformMap(value, context, depth) {
    exactPrototype(value, Map.prototype, 'Map');
    checkCollection(context, value.size, 'Map');
    validateNativeOwnState(value, 'Map');
    return withActive(context, value, function transformActiveMap() {
        const transformed = new Map();
        for (const [key, item] of value) {
            transformed.set(transformValue(key, context, depth + 1), transformValue(item, context, depth + 1));
        }
        return transformed;
    });
}
function transformSet(value, context, depth) {
    exactPrototype(value, Set.prototype, 'Set');
    checkCollection(context, value.size, 'Set');
    validateNativeOwnState(value, 'Set');
    return withActive(context, value, function transformActiveSet() {
        const transformed = new Set();
        for (const item of value)
            transformed.add(transformValue(item, context, depth + 1));
        return transformed;
    });
}
function transformObject(value, context, depth) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype != Object.prototype && prototype != null) {
        binaryWalkError('class instances are not supported');
    }
    const captured = captureObject(value);
    if (context.limits && captured.keys.length > context.limits.maxKeys) {
        throw new rpc_limits_1.PayloadLimitError('too many keys in object');
    }
    return withActive(context, value, function transformActiveObject() {
        const transformed = prototype == null ? Object.create(null) : {};
        for (let index = 0; index < captured.keys.length; index++) {
            const key = captured.keys[index];
            const item = captured.values[index];
            checkString(context, key);
            if (context.mode == 'result' && typeof item == 'function')
                continue;
            if (!(0, rpc_limits_1.isSafeKey)(key))
                continue;
            defineWalkValue(transformed, key, transformValue(item, context, depth + 1), prototype == null);
        }
        return transformed;
    });
}
function transformValue(value, context, depth) {
    checkDepth(context, depth);
    if (typeof value == 'string') {
        checkString(context, value);
        return value;
    }
    if (typeof value == 'function') {
        if (context.mode != 'pack')
            binaryWalkError('function values are not supported');
        const id = context.pool.next();
        context.callbacks.set(id, value);
        context.callbackIds.push(id);
        return (0, rpc_binary_value_1.createRpcBinaryCallbackRef)(id);
    }
    if (typeof value == 'symbol')
        binaryWalkError('symbol values are not supported');
    if (value == null || typeof value != 'object')
        return value;
    const callback = callbackRefValue(value, context);
    if (callback != undefined)
        return callback;
    const binary = normalizeBinaryValue(value, context);
    if (binary != undefined)
        return binary;
    if (Array.isArray(value))
        return transformArray(value, context, depth);
    if (value instanceof Date) {
        exactPrototype(value, Date.prototype, 'Date');
        rejectOwnNativeShadows(value, DATE_NATIVE_SHADOW_KEYS, 'Date');
        validateNativeOwnState(value, 'Date');
        return context.snapshot ? new Date(value.valueOf()) : value;
    }
    if (value instanceof RegExp) {
        exactPrototype(value, RegExp.prototype, 'RegExp');
        rejectOwnNativeShadows(value, REGEXP_NATIVE_SHADOW_KEYS, 'RegExp');
        validateNativeOwnState(value, 'RegExp');
        const source = value.source;
        checkString(context, source);
        const flags = validateRegExpV1(source, value.flags);
        checkString(context, flags);
        return context.snapshot ? new RegExp(source, flags) : value;
    }
    if (value instanceof Map)
        return transformMap(value, context, depth);
    if (value instanceof Set)
        return transformSet(value, context, depth);
    return transformObject(value, context, depth);
}
function transformArgs(args, context) {
    if (!Array.isArray(args))
        binaryWalkError('arguments must be an array');
    validateArray(args);
    const transformed = new Array(args.length);
    for (let index = 0; index < args.length; index++) {
        if (own.call(args, index))
            transformed[index] = transformValue(args[index], context, 0);
    }
    return transformed;
}
function rollbackRpcBinaryCallbacks(pool, callbacks, callbackIds, from = 0) {
    const keep = Math.max(0, Math.min(callbackIds.length, Math.floor(from)));
    while (callbackIds.length > keep) {
        const id = callbackIds.pop();
        callbacks.delete(id);
        pool.release(id);
    }
}
function packRpcBinaryArgs(args, pool, callbacks, callbackIds, snapshot = false) {
    const checkpoint = callbackIds.length;
    const context = {
        mode: 'pack',
        active: new WeakSet(),
        snapshot,
        pool,
        callbacks,
        callbackIds,
    };
    try {
        return transformArgs(args, context);
    }
    catch (error) {
        rollbackRpcBinaryCallbacks(pool, callbacks, callbackIds, checkpoint);
        throw error;
    }
}
function unpackRpcBinaryArgs(args, sender, onEnd, limits) {
    const resolved = (0, rpc_limits_1.resolveLimits)(limits);
    if (!Array.isArray(args))
        binaryWalkError('arguments must be an array');
    if (args.length > resolved.maxArgs)
        throw new rpc_limits_1.PayloadLimitError('too many args');
    return transformArgs(args, {
        mode: 'unpack',
        active: new WeakSet(),
        snapshot: false,
        limits: resolved,
        callbackCount: { value: 0 },
        sender,
        onEnd,
    });
}
function checkTrustedString(value, context) {
    if (value.length > context.limits.maxStringLen) {
        throw new rpc_limits_1.PayloadLimitError('string too long');
    }
}
function checkTrustedCollection(size, label, context) {
    if (size > context.limits.maxArrayLen) {
        throw new rpc_limits_1.PayloadLimitError(label + ' too long');
    }
}
function walkTrustedValue(value, context, depth) {
    if (depth > context.limits.maxDepth) {
        throw new rpc_limits_1.PayloadLimitError('max depth exceeded');
    }
    if (typeof value == 'string') {
        checkTrustedString(value, context);
        return value;
    }
    if (value == null || typeof value != 'object')
        return value;
    const callbackId = (0, rpc_binary_value_1.rpcBinaryCallbackRefId)(value);
    if (callbackId != undefined) {
        if (++context.callbackCount > context.limits.maxCallbacks) {
            throw new rpc_limits_1.PayloadLimitError('too many callbacks');
        }
        if (!context.sender || !context.onEnd)
            return value;
        return (0, rpc_walk_1.createRpcCallbackWrapper)({
            id: callbackId,
            sender: context.sender,
            onEnd: context.onEnd,
            legacyStopSentinel: false,
        });
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        if (value.byteLength > context.limits.maxBinaryLen) {
            throw new rpc_limits_1.PayloadLimitError('binary too long');
        }
        return value;
    }
    if (value instanceof Date)
        return value;
    if (value instanceof RegExp) {
        checkTrustedString(value.source, context);
        checkTrustedString(value.flags, context);
        return value;
    }
    if (Array.isArray(value)) {
        checkTrustedCollection(value.length, 'array', context);
        for (let index = 0; index < value.length; index++) {
            if (own.call(value, index)) {
                value[index] = walkTrustedValue(value[index], context, depth + 1);
            }
        }
        return value;
    }
    if (value instanceof Map) {
        checkTrustedCollection(value.size, 'Map', context);
        const entries = [...value];
        value.clear();
        for (const [key, item] of entries) {
            value.set(walkTrustedValue(key, context, depth + 1), walkTrustedValue(item, context, depth + 1));
        }
        return value;
    }
    if (value instanceof Set) {
        checkTrustedCollection(value.size, 'Set', context);
        const items = [...value];
        value.clear();
        for (const item of items) {
            value.add(walkTrustedValue(item, context, depth + 1));
        }
        return value;
    }
    const keys = Object.keys(value);
    if (keys.length > context.limits.maxKeys) {
        throw new rpc_limits_1.PayloadLimitError('too many keys in object');
    }
    for (const key of keys) {
        checkTrustedString(key, context);
        value[key] = walkTrustedValue(value[key], context, depth + 1);
    }
    return value;
}
function unpackRpcBinaryArgsTrusted(args, sender, onEnd, limits) {
    const resolved = (0, rpc_limits_1.resolveLimits)(limits);
    if (args.length > resolved.maxArgs)
        throw new rpc_limits_1.PayloadLimitError('too many args');
    const context = {
        limits: resolved,
        callbackCount: 0,
        sender,
        onEnd,
    };
    for (let index = 0; index < args.length; index++) {
        if (own.call(args, index)) {
            args[index] = walkTrustedValue(args[index], context, 0);
        }
    }
    return args;
}
function validateRpcBinaryResultTrusted(value, limits) {
    if (!limits)
        return value;
    return walkTrustedValue(value, {
        limits: (0, rpc_limits_1.resolveLimits)(limits),
        callbackCount: 0,
    }, 0);
}
function validateRpcBinaryResult(value, limits) {
    return transformValue(value, {
        mode: 'result',
        active: new WeakSet(),
        snapshot: false,
        limits: limits ? (0, rpc_limits_1.resolveLimits)(limits) : undefined,
    }, 0);
}
function snapshotRpcBinaryResult(value, limits) {
    return transformValue(value, {
        mode: 'result',
        active: new WeakSet(),
        snapshot: true,
        limits: limits ? (0, rpc_limits_1.resolveLimits)(limits) : undefined,
    }, 0);
}
function errorToDto(error, active, limits, depth = 0) {
    if (limits && depth > limits.maxDepth) {
        throw new rpc_limits_1.PayloadLimitError('max depth exceeded');
    }
    if (!(error instanceof Error)) {
        return [0, validateRpcBinaryResult(error, limits)];
    }
    if (active.has(error))
        binaryWalkError('cyclic error causes are not supported');
    active.add(error);
    try {
        const source = error;
        const cause = source.cause === undefined
            ? undefined
            : errorToDto(source.cause, active, limits, depth + 1);
        return [
            1,
            String(error.name),
            String(error.message),
            typeof error.stack == 'string' ? error.stack : undefined,
            validateRpcBinaryResult(source.code, limits),
            validateRpcBinaryResult(source.data, limits),
            cause,
        ];
    }
    finally {
        active.delete(error);
    }
}
function rpcBinaryErrorToDto(error, limits) {
    return errorToDto(error, new WeakSet(), limits ? (0, rpc_limits_1.resolveLimits)(limits) : undefined);
}
function reviveErrorDto(dto) {
    if (dto[0] === 0) {
        if (dto.length != 2)
            binaryWalkError('invalid thrown-value DTO');
        return dto[1];
    }
    if (dto[0] !== 1 || dto.length != 7 || typeof dto[1] != 'string'
        || typeof dto[2] != 'string' || (dto[3] != undefined && typeof dto[3] != 'string')) {
        return binaryWalkError('invalid Error DTO');
    }
    const error = myThrow_1.MyError.fromWire({
        name: dto[1],
        message: dto[2],
        stack: dto[3],
        code: dto[4],
        data: dto[5],
    });
    if (dto[6] != undefined)
        error.cause = reviveErrorDto(dto[6]);
    return error;
}
function reviveRpcBinaryError(dto, limits) {
    const validated = validateRpcBinaryResult(dto, limits);
    if (!Array.isArray(validated))
        binaryWalkError('invalid error DTO');
    return reviveErrorDto(validated);
}
