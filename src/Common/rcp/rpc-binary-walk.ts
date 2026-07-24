import {type idPool} from '../id-pool'
import {MyError} from '../../toError/myThrow'
import {isSafeKey, PayloadLimitError, resolveLimits, type RpcLimits} from './rpc-limits'
import {createRpcCallbackWrapper} from './rpc-walk'
import {
    createRpcBinaryCallbackRef,
    rpcBinaryCallbackRefId,
    rpcBinaryNativeOwnStateError,
    rpcBinaryRegExpV1Error,
    trustRpcBinaryLeaf,
} from './rpc-binary-value'

// =====================================================================
// Direct binary application-value walk
// =====================================================================

type tWalkMode = 'pack' | 'unpack' | 'result'

type tWalkContext = {
    mode: tWalkMode
    active: WeakSet<object>
    snapshot: boolean
    limits?: Required<RpcLimits>
    pool?: idPool
    callbacks?: Map<number, Function>
    callbackIds?: number[]
    callbackCount?: {value: number}
    sender?: (id: number, args: any[]) => void
    onEnd?: (id: number) => void
}

export type tRpcBinaryErrorDto =
    | [kind: 0, value: unknown]
    | [
        kind: 1,
        name: string,
        message: string,
        stack: string | undefined,
        code: unknown,
        data: unknown,
        cause: tRpcBinaryErrorDto | undefined,
    ]

const own = Object.prototype.hasOwnProperty
const DATE_NATIVE_SHADOW_KEYS = ['valueOf'] as const
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
] as const
const ARRAY_BUFFER_NATIVE_SHADOW_KEYS = ['byteLength', 'slice'] as const
const ARRAY_BUFFER_VIEW_NATIVE_SHADOW_KEYS = [
    'buffer',
    'byteOffset',
    'byteLength',
    'constructor',
    'length',
    'BYTES_PER_ELEMENT',
] as const
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'resizable',
)?.get
const SharedArrayBufferConstructor = (globalThis as any).SharedArrayBuffer
const sharedArrayBufferGrowableGetter = typeof SharedArrayBufferConstructor == 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBufferConstructor.prototype, 'growable')?.get
    : undefined

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
    const Constructor = (globalThis as any)[name]
    return typeof Constructor == 'function' ? Constructor : undefined
}).filter(function hasTypedArrayConstructor(Constructor) {
    return Constructor != undefined
})

function binaryWalkError(message: string): never {
    throw new TypeError('rpc binary value: ' + message)
}

function exactPrototype(value: object, expected: object, label: string) {
    if (Object.getPrototypeOf(value) != expected) {
        binaryWalkError(label + ' subclasses are not supported')
    }
}

function rejectOwnNativeShadows(
    value: object,
    keys: readonly string[],
    label: string,
) {
    for (const key of keys) {
        if (own.call(value, key)) {
            binaryWalkError(label + ' own ' + key + ' shadow is not supported')
        }
    }
}

function validateRegExpV1(source: string, flags: string) {
    const error = rpcBinaryRegExpV1Error(source, flags)
    if (error) binaryWalkError(error)
    return flags
}

function nativeBufferFlag(getter: (() => unknown) | undefined, value: object) {
    if (!getter) return false
    try {
        return getter.call(value) == true
    } catch {
        return false
    }
}

function rejectDynamicBinaryBuffer(value: object) {
    let dynamic: boolean
    if (value instanceof ArrayBuffer) {
        dynamic = nativeBufferFlag(arrayBufferResizableGetter, value)
    } else if (typeof SharedArrayBufferConstructor == 'function'
        && value instanceof SharedArrayBufferConstructor) {
        dynamic = nativeBufferFlag(sharedArrayBufferGrowableGetter, value)
    } else {
        // Cross-realm buffers do not satisfy the local instanceof checks, but
        // intrinsic getters still recognize their internal slots.
        dynamic = nativeBufferFlag(arrayBufferResizableGetter, value)
            || nativeBufferFlag(sharedArrayBufferGrowableGetter, value)
    }
    if (dynamic) {
        binaryWalkError(
            'resizable and growable binary buffers are not supported in protocol v1',
        )
    }
}

function validateNativeOwnState(
    value: object,
    kind: Parameters<typeof rpcBinaryNativeOwnStateError>[1],
    typedArrayItems?: number,
) {
    const error = rpcBinaryNativeOwnStateError(value, kind, typedArrayItems)
    if (error) binaryWalkError(error)
}

function beginActive(context: tWalkContext, value: object) {
    if (context.active.has(value)) binaryWalkError('cyclic values are not supported')
    context.active.add(value)
}

function withActive<T>(context: tWalkContext, value: object, run: () => T) {
    beginActive(context, value)
    try {
        return run()
    } finally {
        context.active.delete(value)
    }
}

function checkDepth(context: tWalkContext, depth: number) {
    if (context.limits && depth > context.limits.maxDepth) {
        throw new PayloadLimitError('max depth exceeded')
    }
}

function checkString(context: tWalkContext, value: string) {
    if (context.limits && value.length > context.limits.maxStringLen) {
        throw new PayloadLimitError('string too long')
    }
}

function checkBinary(context: tWalkContext, byteLength: number) {
    if (context.limits && byteLength > context.limits.maxBinaryLen) {
        throw new PayloadLimitError('binary too long')
    }
}

function checkCollection(context: tWalkContext, size: number, label: string) {
    if (context.limits && size > context.limits.maxArrayLen) {
        throw new PayloadLimitError(label + ' too long')
    }
}

function isNodeBuffer(value: ArrayBufferView) {
    const Constructor = (globalThis as any).Buffer
    return typeof Constructor?.isBuffer == 'function' && Constructor.isBuffer(value)
}

function normalizeNodeBuffer(value: ArrayBufferView) {
    const Constructor = (globalThis as any).Buffer
    if (Object.getPrototypeOf(value) != Constructor.prototype) {
        binaryWalkError('Buffer subclasses are not supported')
    }
    const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const copy = new Uint8Array(source.byteLength)
    copy.set(source)
    return trustRpcBinaryLeaf(copy)
}

function normalizeBinaryValue(value: object, context: tWalkContext) {
    if (value instanceof ArrayBuffer) {
        exactPrototype(value, ArrayBuffer.prototype, 'ArrayBuffer')
        rejectOwnNativeShadows(value, ARRAY_BUFFER_NATIVE_SHADOW_KEYS, 'ArrayBuffer')
        validateNativeOwnState(value, 'ArrayBuffer')
        rejectDynamicBinaryBuffer(value)
        checkBinary(context, value.byteLength)
        return context.snapshot ? value.slice(0) : value
    }
    if (typeof SharedArrayBufferConstructor == 'function'
        && value instanceof SharedArrayBufferConstructor) {
        rejectDynamicBinaryBuffer(value)
    }
    if (!ArrayBuffer.isView(value)) return undefined
    rejectOwnNativeShadows(
        value,
        ARRAY_BUFFER_VIEW_NATIVE_SHADOW_KEYS,
        'ArrayBuffer view',
    )
    rejectDynamicBinaryBuffer(value.buffer)
    // Binary leaves intentionally bypass property walking, as in legacy RPC. Reflecting
    // the own keys of an 8 MiB TypedArray would allocate/enumerate millions of indexes.
    checkBinary(context, value.byteLength)
    if (isNodeBuffer(value)) {
        if (Object.getPrototypeOf(value) != (globalThis as any).Buffer.prototype) {
            binaryWalkError('Buffer subclasses are not supported')
        }
        validateNativeOwnState(value, 'TypedArray', value.byteLength)
        return context.snapshot ? normalizeNodeBuffer(value) : value
    }
    if (value instanceof DataView) {
        exactPrototype(value, DataView.prototype, 'DataView')
        validateNativeOwnState(value, 'DataView')
        if (!context.snapshot) return value
        const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        const copy = new Uint8Array(source.byteLength)
        copy.set(source)
        return new DataView(copy.buffer)
    }
    const Constructor = TYPED_ARRAY_CONSTRUCTORS.find(function matchTypedArray(candidate) {
        return Object.getPrototypeOf(value) == candidate.prototype
    })
    if (!Constructor) binaryWalkError('non-standard typed arrays are not supported')
    validateNativeOwnState(
        value,
        'TypedArray',
        value.byteLength / Constructor.BYTES_PER_ELEMENT,
    )
    if (!context.snapshot) return value
    const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const copy = new Uint8Array(source.byteLength)
    copy.set(source)
    return trustRpcBinaryLeaf(new Constructor(copy.buffer))
}

function isArrayIndexKey(key: string, length: number) {
    const index = Number(key)
    return Number.isInteger(index) && index >= 0 && index < length && String(index) == key
}

function validateArray(value: unknown[]) {
    exactPrototype(value, Array.prototype, 'Array')
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key == 'symbol') binaryWalkError('symbol array keys are not supported')
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor) binaryWalkError('array property descriptor disappeared')
        if (own.call(descriptor, 'get') || own.call(descriptor, 'set')) {
            binaryWalkError('accessor properties are not supported')
        }
        if (key != 'length' && !isArrayIndexKey(key, value.length)) {
            binaryWalkError('extra array properties are not supported')
        }
    }
}

function captureObject(value: Record<string, unknown>) {
    const keys: string[] = []
    const values: unknown[] = []
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key == 'symbol') binaryWalkError('symbol object keys are not supported')
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor) binaryWalkError('object property descriptor disappeared')
        if (own.call(descriptor, 'get') || own.call(descriptor, 'set')) {
            binaryWalkError('accessor properties are not supported')
        }
        if (descriptor.enumerable) {
            keys.push(key)
            values.push(descriptor.value)
        }
    }
    return {keys, values}
}

function defineWalkValue(
    target: Record<string, unknown>,
    key: string,
    value: unknown,
    nullPrototype: boolean,
) {
    if (nullPrototype) {
        target[key] = value
        return
    }
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, key)
    if (!inherited || own.call(inherited, 'value') && inherited.writable == true) {
        target[key] = value
        return
    }
    const defined = Reflect.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    })
    if (!defined) binaryWalkError('cannot define object key')
}

function callbackRefValue(value: object, context: tWalkContext) {
    const id = rpcBinaryCallbackRefId(value)
    if (id == undefined) return undefined
    if (context.mode != 'unpack') binaryWalkError('callback reference outside RPC arguments')
    if (!Number.isSafeInteger(id) || id < 0) binaryWalkError('invalid callback id')
    const count = context.callbackCount!
    if (++count.value > context.limits!.maxCallbacks) {
        throw new PayloadLimitError('too many callbacks')
    }
    return createRpcCallbackWrapper({
        id,
        sender: context.sender!,
        onEnd: context.onEnd!,
        // Binary uses Pkt.CB_END. The historical string is ordinary application data here.
        legacyStopSentinel: false,
    })
}

function transformArray(value: unknown[], context: tWalkContext, depth: number) {
    checkCollection(context, value.length, 'array')
    validateArray(value)
    return withActive(context, value, function transformActiveArray() {
        const transformed = new Array<unknown>(value.length)
        for (let index = 0; index < value.length; index++) {
            if (own.call(value, index)) {
                transformed[index] = transformValue(value[index], context, depth + 1)
            }
        }
        return transformed
    })
}

function transformMap(value: Map<unknown, unknown>, context: tWalkContext, depth: number) {
    exactPrototype(value, Map.prototype, 'Map')
    checkCollection(context, value.size, 'Map')
    validateNativeOwnState(value, 'Map')
    return withActive(context, value, function transformActiveMap() {
        const transformed = new Map<unknown, unknown>()
        for (const [key, item] of value) {
            transformed.set(
                transformValue(key, context, depth + 1),
                transformValue(item, context, depth + 1),
            )
        }
        return transformed
    })
}

function transformSet(value: Set<unknown>, context: tWalkContext, depth: number) {
    exactPrototype(value, Set.prototype, 'Set')
    checkCollection(context, value.size, 'Set')
    validateNativeOwnState(value, 'Set')
    return withActive(context, value, function transformActiveSet() {
        const transformed = new Set<unknown>()
        for (const item of value) transformed.add(transformValue(item, context, depth + 1))
        return transformed
    })
}

function transformObject(value: Record<string, unknown>, context: tWalkContext, depth: number) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype != Object.prototype && prototype != null) {
        binaryWalkError('class instances are not supported')
    }
    const captured = captureObject(value)
    if (context.limits && captured.keys.length > context.limits.maxKeys) {
        throw new PayloadLimitError('too many keys in object')
    }
    return withActive(context, value, function transformActiveObject() {
        const transformed: Record<string, unknown> = prototype == null ? Object.create(null) : {}
        for (let index = 0; index < captured.keys.length; index++) {
            const key = captured.keys[index]
            const item = captured.values[index]
            checkString(context, key)
            // Public RPC result types expose data only. Legacy JSON omitted function
            // properties from returned chain objects; retain that contract without
            // treating the complete result as a serialization failure.
            if (context.mode == 'result' && typeof item == 'function') continue
            // Keep legacy RPC's admission rule. DefineProperty makes construction safe,
            // but retaining these keys would make JSON and binary application semantics differ.
            if (!isSafeKey(key)) continue
            defineWalkValue(
                transformed,
                key,
                transformValue(item, context, depth + 1),
                prototype == null,
            )
        }
        return transformed
    })
}

function transformValue(value: any, context: tWalkContext, depth: number): any {
    checkDepth(context, depth)
    if (typeof value == 'string') {
        checkString(context, value)
        return value
    }
    if (typeof value == 'function') {
        if (context.mode != 'pack') binaryWalkError('function values are not supported')
        const id = context.pool!.next()
        context.callbacks!.set(id, value)
        context.callbackIds!.push(id)
        return createRpcBinaryCallbackRef(id)
    }
    if (typeof value == 'symbol') binaryWalkError('symbol values are not supported')
    if (value == null || typeof value != 'object') return value

    const callback = callbackRefValue(value, context)
    if (callback != undefined) return callback

    const binary = normalizeBinaryValue(value, context)
    if (binary != undefined) return binary

    if (Array.isArray(value)) return transformArray(value, context, depth)
    if (value instanceof Date) {
        exactPrototype(value, Date.prototype, 'Date')
        rejectOwnNativeShadows(value, DATE_NATIVE_SHADOW_KEYS, 'Date')
        validateNativeOwnState(value, 'Date')
        return context.snapshot ? new Date(value.valueOf()) : value
    }
    if (value instanceof RegExp) {
        exactPrototype(value, RegExp.prototype, 'RegExp')
        rejectOwnNativeShadows(value, REGEXP_NATIVE_SHADOW_KEYS, 'RegExp')
        validateNativeOwnState(value, 'RegExp')
        const source = value.source
        checkString(context, source)
        const flags = validateRegExpV1(source, value.flags)
        checkString(context, flags)
        return context.snapshot ? new RegExp(source, flags) : value
    }
    if (value instanceof Map) return transformMap(value, context, depth)
    if (value instanceof Set) return transformSet(value, context, depth)
    return transformObject(value, context, depth)
}

function transformArgs(args: any[], context: tWalkContext) {
    if (!Array.isArray(args)) binaryWalkError('arguments must be an array')
    validateArray(args)
    const transformed = new Array<any>(args.length)
    for (let index = 0; index < args.length; index++) {
        if (own.call(args, index)) transformed[index] = transformValue(args[index], context, 0)
    }
    return transformed
}

export function rollbackRpcBinaryCallbacks(
    pool: idPool,
    callbacks: Map<number, Function>,
    callbackIds: number[],
    from = 0,
) {
    const keep = Math.max(0, Math.min(callbackIds.length, Math.floor(from)))
    while (callbackIds.length > keep) {
        const id = callbackIds.pop()!
        callbacks.delete(id)
        pool.release(id)
    }
}

export function packRpcBinaryArgs(
    args: any[],
    pool: idPool,
    callbacks: Map<number, Function>,
    callbackIds: number[],
    snapshot = false,
) {
    const checkpoint = callbackIds.length
    const context: tWalkContext = {
        mode: 'pack',
        active: new WeakSet<object>(),
        snapshot,
        pool,
        callbacks,
        callbackIds,
    }
    try {
        return transformArgs(args, context)
    } catch (error) {
        rollbackRpcBinaryCallbacks(pool, callbacks, callbackIds, checkpoint)
        throw error
    }
}

export function unpackRpcBinaryArgs(
    args: any[],
    sender: (id: number, args: any[]) => void,
    onEnd: (id: number) => void,
    limits?: RpcLimits,
) {
    const resolved = resolveLimits(limits)
    if (!Array.isArray(args)) binaryWalkError('arguments must be an array')
    if (args.length > resolved.maxArgs) throw new PayloadLimitError('too many args')
    return transformArgs(args, {
        mode: 'unpack',
        active: new WeakSet<object>(),
        snapshot: false,
        limits: resolved,
        callbackCount: {value: 0},
        sender,
        onEnd,
    })
}

type tTrustedWalkContext = {
    limits: Required<RpcLimits>
    callbackCount: number
    sender?: (id: number, args: any[]) => void
    onEnd?: (id: number) => void
}

function checkTrustedString(value: string, context: tTrustedWalkContext) {
    if (value.length > context.limits.maxStringLen) {
        throw new PayloadLimitError('string too long')
    }
}

function checkTrustedCollection(size: number, label: string, context: tTrustedWalkContext) {
    if (size > context.limits.maxArrayLen) {
        throw new PayloadLimitError(label + ' too long')
    }
}

/**
 * The schema decoder already guarantees the wire grammar. This walk adds only
 * caller-selected resource limits while visiting the callback positions RPC
 * must visit anyway; it does not repeat descriptor/prototype/schema validation.
 */
function walkTrustedValue(value: any, context: tTrustedWalkContext, depth: number): any {
    if (depth > context.limits.maxDepth) {
        throw new PayloadLimitError('max depth exceeded')
    }
    if (typeof value == 'string') {
        checkTrustedString(value, context)
        return value
    }
    if (value == null || typeof value != 'object') return value

    const callbackId = rpcBinaryCallbackRefId(value)
    if (callbackId != undefined) {
        if (++context.callbackCount > context.limits.maxCallbacks) {
            throw new PayloadLimitError('too many callbacks')
        }
        if (!context.sender || !context.onEnd) return value
        return createRpcCallbackWrapper({
            id: callbackId,
            sender: context.sender,
            onEnd: context.onEnd,
            legacyStopSentinel: false,
        })
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        if (value.byteLength > context.limits.maxBinaryLen) {
            throw new PayloadLimitError('binary too long')
        }
        return value
    }
    if (value instanceof Date) return value
    if (value instanceof RegExp) {
        checkTrustedString(value.source, context)
        checkTrustedString(value.flags, context)
        return value
    }
    if (Array.isArray(value)) {
        checkTrustedCollection(value.length, 'array', context)
        for (let index = 0; index < value.length; index++) {
            if (own.call(value, index)) {
                value[index] = walkTrustedValue(value[index], context, depth + 1)
            }
        }
        return value
    }
    if (value instanceof Map) {
        checkTrustedCollection(value.size, 'Map', context)
        const entries = [...value]
        value.clear()
        for (const [key, item] of entries) {
            value.set(
                walkTrustedValue(key, context, depth + 1),
                walkTrustedValue(item, context, depth + 1),
            )
        }
        return value
    }
    if (value instanceof Set) {
        checkTrustedCollection(value.size, 'Set', context)
        const items = [...value]
        value.clear()
        for (const item of items) {
            value.add(walkTrustedValue(item, context, depth + 1))
        }
        return value
    }

    const keys = Object.keys(value)
    if (keys.length > context.limits.maxKeys) {
        throw new PayloadLimitError('too many keys in object')
    }
    for (const key of keys) {
        checkTrustedString(key, context)
        value[key] = walkTrustedValue(value[key], context, depth + 1)
    }
    return value
}

export function unpackRpcBinaryArgsTrusted(
    args: any[],
    sender: (id: number, args: any[]) => void,
    onEnd: (id: number) => void,
    limits?: RpcLimits,
) {
    const resolved = resolveLimits(limits)
    if (args.length > resolved.maxArgs) throw new PayloadLimitError('too many args')
    const context: tTrustedWalkContext = {
        limits: resolved,
        callbackCount: 0,
        sender,
        onEnd,
    }
    for (let index = 0; index < args.length; index++) {
        if (own.call(args, index)) {
            args[index] = walkTrustedValue(args[index], context, 0)
        }
    }
    return args
}

export function validateRpcBinaryResultTrusted(value: unknown, limits?: RpcLimits) {
    if (!limits) return value
    return walkTrustedValue(value, {
        limits: resolveLimits(limits),
        callbackCount: 0,
    }, 0)
}

/**
 * Validate and sanitize an already decoded result. Unsafe RPC object keys are
 * dropped exactly as in the legacy JSON walk; the returned rich-value tree is detached.
 */
export function validateRpcBinaryResult(value: unknown, limits?: RpcLimits) {
    return transformValue(value, {
        mode: 'result',
        active: new WeakSet<object>(),
        snapshot: false,
        limits: limits ? resolveLimits(limits) : undefined,
    }, 0)
}

export function snapshotRpcBinaryResult(value: unknown, limits?: RpcLimits) {
    return transformValue(value, {
        mode: 'result',
        active: new WeakSet<object>(),
        snapshot: true,
        limits: limits ? resolveLimits(limits) : undefined,
    }, 0)
}

function errorToDto(
    error: unknown,
    active: WeakSet<object>,
    limits?: Required<RpcLimits>,
    depth = 0,
): tRpcBinaryErrorDto {
    if (limits && depth > limits.maxDepth) {
        throw new PayloadLimitError('max depth exceeded')
    }
    if (!(error instanceof Error)) {
        return [0, validateRpcBinaryResult(error, limits)]
    }
    if (active.has(error)) binaryWalkError('cyclic error causes are not supported')
    active.add(error)
    try {
        const source = error as any
        // A thrown `null` cause is data; only absent/explicit undefined means no cause.
        const cause = source.cause === undefined
            ? undefined
            : errorToDto(source.cause, active, limits, depth + 1)
        return [
            1,
            String(error.name),
            String(error.message),
            typeof error.stack == 'string' ? error.stack : undefined,
            validateRpcBinaryResult(source.code, limits),
            validateRpcBinaryResult(source.data, limits),
            cause,
        ] as tRpcBinaryErrorDto
    } finally {
        active.delete(error)
    }
}

export function rpcBinaryErrorToDto(error: unknown, limits?: RpcLimits) {
    return errorToDto(
        error,
        new WeakSet<object>(),
        limits ? resolveLimits(limits) : undefined,
    )
}

function reviveErrorDto(dto: tRpcBinaryErrorDto): unknown {
    // DTO tags distinguish boolean/number application values, so coercion is invalid here.
    if (dto[0] === 0) {
        if (dto.length != 2) binaryWalkError('invalid thrown-value DTO')
        return dto[1]
    }
    if (dto[0] !== 1 || dto.length != 7 || typeof dto[1] != 'string'
        || typeof dto[2] != 'string' || (dto[3] != undefined && typeof dto[3] != 'string')) {
        return binaryWalkError('invalid Error DTO')
    }
    const error = MyError.fromWire({
        name: dto[1],
        message: dto[2],
        stack: dto[3],
        code: dto[4],
        data: dto[5],
    } as any)
    if (dto[6] != undefined) (error as any).cause = reviveErrorDto(dto[6])
    return error
}

export function reviveRpcBinaryError(dto: unknown, limits?: RpcLimits) {
    const validated = validateRpcBinaryResult(dto, limits)
    if (!Array.isArray(validated)) binaryWalkError('invalid error DTO')
    return reviveErrorDto(validated as tRpcBinaryErrorDto)
}
