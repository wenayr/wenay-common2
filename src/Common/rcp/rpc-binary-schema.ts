// =====================================================================
// Universal typed-schema binary codec
// =====================================================================

import {
    createBinaryValueCodec,
    rpcBinaryCallbackRefId,
    rpcBinaryNativeOwnStateError,
    trustRpcBinaryLeaf,
} from './rpc-binary-value'

const DEFAULT_MAX_DEPTH = 36
const MAX_CODEC_DEPTH = 64
const DEFAULT_MAX_BINARY_BYTES = 8_000_000
const DEFAULT_MAX_WIRE_BYTES = 16_000_000
const DEFAULT_MAX_SCHEMAS = 1_000
const DEFAULT_PROMOTION_THRESHOLD = 3
const MAX_SCHEMAS = 1_000
const MAX_FIELDS = 1_000
const MAX_TUPLE_FIELDS = 64
const MAX_COLLECTION_ITEMS = 100_000
const MAX_DICTIONARY_KEYS = 20_000
const BULK_ADMISSION_SCAN_NODES = 128
const MAX_STRING_BYTES = 4_000_000
const MAX_BIGINT_BYTES = 8_192 / 8 + 1
const MAX_SAFE_INTEGER_VARUINT_BYTES = 8
const SAFE_INTEGER_ZIGZAG_HIGH_FACTOR = 2 ** 48

const FRAME_KIND = {
    DATA: 0,
    PRELUDE: 1,
} as const

const ROOT_TAG = {
    GENERIC: 0,
    UNDEFINED: 1,
    NULL: 2,
    FALSE: 3,
    TRUE: 4,
    INTEGER: 5,
    FLOAT64: 6,
    STRING: 7,
    BIGINT: 8,
    SCHEMA: 9,
    RUN: 10,
    SEGMENTS: 11,
    ARRAY_BUFFER: 12,
    DATA_VIEW: 13,
    TYPED_ARRAY: 14,
} as const

const SCHEMA_KIND = {
    OBJECT: 0,
    TUPLE: 1,
} as const

const FIELD_KIND = {
    UNDEFINED: 0,
    NULL: 1,
    BOOLEAN: 2,
    INTEGER: 3,
    FLOAT64: 4,
    STRING: 5,
    BIGINT: 6,
    DATE: 7,
    NESTED: 8,
    GENERIC: 9,
    ARRAY_BUFFER: 10,
    DATA_VIEW: 11,
    TYPED_ARRAY: 12,
} as const

const GENERIC_KIND = {
    OTHER: 0,
    REGEXP: 1,
    MAP: 2,
    SET: 3,
    ARRAY_BUFFER: 4,
    DATA_VIEW: 5,
    TYPED_ARRAY: 6,
    CALLBACK_REF: 7,
    ARRAY: 8,
    OBJECT: 9,
} as const

const FALLBACK_TAG = {
    EXACT: 0,
    UNDEFINED: 1,
    NULL: 2,
    FALSE: 3,
    TRUE: 4,
    INTEGER: 5,
    FLOAT64: 6,
    STRING: 7,
    BIGINT: 8,
    DATE: 9,
    OBJECT: 10,
    ARRAY: 11,
} as const

const GENERIC_PAYLOAD = {
    FALLBACK: 0,
    DATA: 1,
    DICTIONARY: 2,
} as const

type tSchemaKind = typeof SCHEMA_KIND[keyof typeof SCHEMA_KIND]
type tFieldKind = typeof FIELD_KIND[keyof typeof FIELD_KIND]
type tGenericKind = typeof GENERIC_KIND[keyof typeof GENERIC_KIND]

type tLayoutField = {
    key?: string
    kind: tFieldKind
    genericKind?: tGenericKind
    binaryCode?: number
    nested?: tLayout
}

type tLayout = {
    kind: tSchemaKind
    prototype: 0 | 1
    fields: tLayoutField[]
    signature: string
}

type tSchemaField = {
    key?: string
    kind: tFieldKind
    genericKind?: tGenericKind
    binaryCode?: number
    schemaId?: number
}

type tSchema = {
    id: number
    kind: tSchemaKind
    prototype: 0 | 1
    fields: tSchemaField[]
    signature: string
}

type tRegistry = {
    schemas: tSchema[]
    bySignature: Map<string, tSchema>
}

type tCandidate = {
    layout: tLayout
    observations: number
    sequence: number
}

type tSchemaHint = string | number

type tHintPlan =
    | {tag: 'schema', schema: tSchema}
    | {tag: 'run', schema: tSchema}

type tEncodeCounters = {
    promotions: number
    definitions: number
    references: number
    runs: number
    rows: number
    generic: number
    typedFields: number
}

type tDecodeCounters = {
    definitions: number
    references: number
    runs: number
    rows: number
    generic: number
    typedFields: number
}

type tEncodeTransaction = {
    staged: tSchema[]
    stagedBySignature: Map<string, tSchema>
    candidateChanges: Map<string, tCandidate>
    candidateRemovals: Set<string>
    definitionIds: Set<number>
    announcedIds: Set<number>
    hintChanges: Map<tSchemaHint, tHintPlan>
    sequence: number
    counters: tEncodeCounters
}

type tDecodeTransaction = {
    staged: tSchema[]
    counters: tDecodeCounters
}

type tRootPlan =
    | {tag: 'generic', wire: Uint8Array}
    | {tag: 'undefined'}
    | {tag: 'null'}
    | {tag: 'false'}
    | {tag: 'true'}
    | {tag: 'integer', value: number}
    | {tag: 'float64', value: number}
    | {tag: 'string', value: string}
    | {tag: 'bigint', value: bigint}
    | {tag: 'schema', schema: tSchema, value: object}
    | {tag: 'run', schema: tSchema, rows: object[]}
    | {tag: 'segments', segments: {schema: tSchema, rows: object[]}[]}
    | {tag: 'arrayBuffer', value: ArrayBuffer}
    | {tag: 'dataView', value: DataView}
    | {tag: 'typedArray', value: ArrayBufferView, entry: tTypedArrayEntry}

type tEncodeGeneric = (
    value: unknown,
    depth: number,
    hint?: tSchemaHint,
) => Uint8Array

export type RpcBinarySchemaCodecOptions = {
    magic: readonly number[] | Uint8Array
    version: number
    label: string
    callbackRefs?: boolean
    maxSchemas?: number
    promotionThreshold?: number
    predeclared?: readonly unknown[]
    maxDepth?: number
    maxBinaryBytes?: number
    maxWireBytes?: number
}

type tResolvedOptions = {
    magic: Uint8Array
    version: number
    label: string
    callbackRefs: boolean
    maxSchemas: number
    promotionThreshold: number
    maxDepth: number
    maxBinaryBytes: number
    maxWireBytes: number
}

type tTypedArrayEntry = {
    code: number
    Constructor: any
    bytesPerElement: number
}

const TYPED_ARRAY_SPEC = [
    {code: 1, name: 'Int8Array'},
    {code: 2, name: 'Uint8Array'},
    {code: 3, name: 'Uint8ClampedArray'},
    {code: 4, name: 'Int16Array'},
    {code: 5, name: 'Uint16Array'},
    {code: 6, name: 'Int32Array'},
    {code: 7, name: 'Uint32Array'},
    {code: 8, name: 'Float32Array'},
    {code: 9, name: 'Float64Array'},
    {code: 10, name: 'BigInt64Array'},
    {code: 11, name: 'BigUint64Array'},
] as const

const typedArrayEntries = TYPED_ARRAY_SPEC.flatMap(function createTypedArrayEntry(spec) {
    const Constructor = (globalThis as any)[spec.name]
    if (typeof Constructor != 'function'
        || !Number.isInteger(Constructor.BYTES_PER_ELEMENT)
        || Constructor.BYTES_PER_ELEMENT <= 0) {
        return []
    }
    return [{
        code: spec.code,
        Constructor,
        bytesPerElement: Constructor.BYTES_PER_ELEMENT,
    }]
}) as tTypedArrayEntry[]

const PLATFORM_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([0x0102]).buffer)[0] == 0x02
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'resizable',
)?.get
const SharedArrayBufferConstructor = (globalThis as any).SharedArrayBuffer
const sharedArrayBufferGrowableGetter = typeof SharedArrayBufferConstructor == 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBufferConstructor.prototype, 'growable')?.get
    : undefined
const ARRAY_BUFFER_NATIVE_SHADOW_KEYS = ['byteLength', 'slice'] as const
const ARRAY_BUFFER_VIEW_NATIVE_SHADOW_KEYS = [
    'buffer',
    'byteOffset',
    'byteLength',
    'constructor',
    'length',
    'BYTES_PER_ELEMENT',
] as const

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true})
const trustedUtf8Decoder = new TextDecoder('utf-8', {ignoreBOM: true})
const own = Object.prototype.hasOwnProperty

function fail(message: string): never {
    throw new TypeError(message)
}

function failRange(message: string): never {
    throw new RangeError(message)
}

function labeledError(label: string, error: unknown): never {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof RangeError) throw new RangeError(label + ': ' + message)
    throw new TypeError(label + ': ' + message)
}

function integerOption(
    value: number | undefined,
    fallback: number,
    maximum: number,
    label: string,
) {
    const resolved = value == undefined ? fallback : value
    if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum) {
        throw new RangeError(label + ' must be an integer from 0 through ' + maximum)
    }
    return resolved
}

function positiveIntegerOption(
    value: number | undefined,
    fallback: number,
    label: string,
) {
    const resolved = value == undefined ? fallback : value
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw new RangeError(label + ' must be a positive safe integer')
    }
    return resolved
}

function resolveOptions(options: RpcBinarySchemaCodecOptions): tResolvedOptions {
    if (!options || typeof options != 'object') {
        throw new TypeError('RPC binary schema codec options are required')
    }
    const magic = new Uint8Array(options.magic)
    if (magic.byteLength == 0 || magic.byteLength > 16
        || Array.from(options.magic).some(byte => !Number.isInteger(byte) || byte < 0 || byte > 0xff)) {
        throw new RangeError('RPC binary schema codec magic must contain 1 through 16 bytes')
    }
    if (!Number.isInteger(options.version) || options.version < 0 || options.version > 0xff) {
        throw new RangeError('RPC binary schema codec version must be one byte')
    }
    if (typeof options.label != 'string' || options.label.length == 0) {
        throw new TypeError('RPC binary schema codec label must be a non-empty string')
    }
    return {
        magic,
        version: options.version,
        label: options.label,
        callbackRefs: options.callbackRefs == true,
        maxSchemas: integerOption(
            options.maxSchemas,
            DEFAULT_MAX_SCHEMAS,
            MAX_SCHEMAS,
            'RPC binary schema maxSchemas',
        ),
        promotionThreshold: positiveIntegerOption(
            options.promotionThreshold,
            DEFAULT_PROMOTION_THRESHOLD,
            'RPC binary schema promotionThreshold',
        ),
        maxDepth: integerOption(
            options.maxDepth,
            DEFAULT_MAX_DEPTH,
            MAX_CODEC_DEPTH,
            'RPC binary schema maxDepth',
        ),
        maxBinaryBytes: positiveIntegerOption(
            options.maxBinaryBytes,
            DEFAULT_MAX_BINARY_BYTES,
            'RPC binary schema maxBinaryBytes',
        ),
        maxWireBytes: positiveIntegerOption(
            options.maxWireBytes,
            DEFAULT_MAX_WIRE_BYTES,
            'RPC binary schema maxWireBytes',
        ),
    }
}

function createRegistry(): tRegistry {
    return {
        schemas: [],
        bySignature: new Map(),
    }
}

function createEncodeCounters(): tEncodeCounters {
    return {
        promotions: 0,
        definitions: 0,
        references: 0,
        runs: 0,
        rows: 0,
        generic: 0,
        typedFields: 0,
    }
}

function createDecodeCounters(): tDecodeCounters {
    return {
        definitions: 0,
        references: 0,
        runs: 0,
        rows: 0,
        generic: 0,
        typedFields: 0,
    }
}

function wireBytes(wire: unknown) {
    if (wire instanceof Uint8Array) return wire
    if (wire instanceof ArrayBuffer) return new Uint8Array(wire)
    if (ArrayBuffer.isView(wire)) {
        return new Uint8Array(wire.buffer, wire.byteOffset, wire.byteLength)
    }
    return fail('wire must be an ArrayBuffer or ArrayBuffer view')
}

function typedArrayEntryByCode(code: number) {
    return typedArrayEntries.find(entry => entry.code == code)
}

function typedArrayEntryForValue(value: ArrayBufferView) {
    const Constructor = (value as any).constructor
    if (typeof Constructor?.isBuffer == 'function' && Constructor.isBuffer(value)) {
        return typedArrayEntries.find(entry => entry.code == 2)
    }
    return typedArrayEntries.find(entry => Constructor == entry.Constructor)
}

function hasOwnNativeShadow(value: object, keys: readonly string[]) {
    return keys.some(key => own.call(value, key))
}

function nativeBufferFlag(getter: (() => unknown) | undefined, value: object) {
    if (!getter) return false
    try {
        return getter.call(value) == true
    } catch {
        return false
    }
}

function dynamicBinaryBuffer(value: object) {
    return nativeBufferFlag(arrayBufferResizableGetter, value)
        || nativeBufferFlag(sharedArrayBufferGrowableGetter, value)
}

function directBinaryField(
    value: unknown,
    config: tResolvedOptions,
): tLayoutField | undefined {
    if (value instanceof ArrayBuffer) {
        if (Object.getPrototypeOf(value) != ArrayBuffer.prototype
            || hasOwnNativeShadow(value, ARRAY_BUFFER_NATIVE_SHADOW_KEYS)
            || rpcBinaryNativeOwnStateError(value, 'ArrayBuffer')
            || dynamicBinaryBuffer(value)) {
            return undefined
        }
        if (value.byteLength > config.maxBinaryBytes) failRange('binary value exceeds limit')
        return {kind: FIELD_KIND.ARRAY_BUFFER}
    }
    if (!ArrayBuffer.isView(value)) return undefined
    if (hasOwnNativeShadow(value, ARRAY_BUFFER_VIEW_NATIVE_SHADOW_KEYS)
        || dynamicBinaryBuffer(value.buffer)) {
        return undefined
    }
    if (value instanceof DataView) {
        if (Object.getPrototypeOf(value) != DataView.prototype
            || rpcBinaryNativeOwnStateError(value, 'DataView')) {
            return undefined
        }
        if (value.byteLength > config.maxBinaryBytes) failRange('binary value exceeds limit')
        return {kind: FIELD_KIND.DATA_VIEW}
    }
    const entry = typedArrayEntryForValue(value)
    if (!entry || rpcBinaryNativeOwnStateError(
        value,
        'TypedArray',
        value.byteLength / entry.bytesPerElement,
    )) {
        return undefined
    }
    if (value.byteLength > config.maxBinaryBytes) failRange('binary value exceeds limit')
    return {
        kind: FIELD_KIND.TYPED_ARRAY,
        binaryCode: entry.code,
    }
}

function activeBinaryBytes(value: ArrayBufferView) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function endianAdjustedBinaryBytes(value: Uint8Array, bytesPerElement: number) {
    if (PLATFORM_LITTLE_ENDIAN || bytesPerElement == 1) return value
    const copy = value.slice()
    for (let offset = 0; offset < copy.byteLength; offset += bytesPerElement) {
        for (let left = 0, right = bytesPerElement - 1; left < right; left++, right--) {
            const byte = copy[offset + left]
            copy[offset + left] = copy[offset + right]
            copy[offset + right] = byte
        }
    }
    return copy
}

function varUintNumberByteLength(value: number) {
    let remaining = value
    let bytes = 1
    while (remaining >= 0x80) {
        remaining = Math.floor(remaining / 0x80)
        bytes++
    }
    return bytes
}

function createByteWriter(maxWireBytes: number, initialCapacity = 256) {
    let bytes = new Uint8Array(Math.min(maxWireBytes, Math.max(1, initialCapacity)))
    let view = new DataView(bytes.buffer)
    let position = 0

    function ensure(extra: number) {
        const required = position + extra
        if (!Number.isSafeInteger(extra) || extra < 0 || required > maxWireBytes) {
            failRange('encoded frame exceeds binary limit')
        }
        if (required <= bytes.byteLength) return
        let capacity = Math.max(required, bytes.byteLength * 2)
        if (capacity > maxWireBytes) capacity = maxWireBytes
        const expanded = new Uint8Array(capacity)
        expanded.set(bytes)
        bytes = expanded
        view = new DataView(bytes.buffer)
    }

    function writeU8(value: number) {
        ensure(1)
        bytes[position++] = value
    }

    function writeFloat64(value: number) {
        ensure(8)
        view.setFloat64(position, value, true)
        position += 8
    }

    function writeBytes(value: Uint8Array) {
        ensure(value.byteLength)
        bytes.set(value, position)
        position += value.byteLength
    }

    function writeVarUintNumber(value: number) {
        if (!Number.isSafeInteger(value) || value < 0) {
            failRange('number varuint must be a non-negative safe integer')
        }
        let remaining = value
        do {
            const payload = remaining % 0x80
            remaining = Math.floor(remaining / 0x80)
            writeU8(remaining == 0 ? payload : payload | 0x80)
        } while (remaining != 0)
    }

    function writeVarUint(value: bigint) {
        if (value < 0n) failRange('varuint cannot be negative')
        let remaining = value
        let count = 0
        do {
            if (count >= MAX_BIGINT_BYTES) failRange('bigint exceeds binary limit')
            const payload = Number(remaining & 0x7fn)
            remaining >>= 7n
            writeU8(remaining == 0n ? payload : payload | 0x80)
            count++
        } while (remaining != 0n)
    }

    function finish() {
        const wire = position * 2 < bytes.byteLength
            ? bytes.slice(0, position)
            : bytes.subarray(0, position)
        return trustRpcBinaryLeaf(wire)
    }

    return {
        writeU8,
        writeFloat64,
        writeBytes,
        writeVarUintNumber,
        writeVarUint,
        finish,
    }
}

type tByteWriter = Omit<ReturnType<typeof createByteWriter>, 'finish'>

function createByteReader(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let position = 0

    function requireBytes(length: number) {
        if (!Number.isSafeInteger(length) || length < 0 || length > bytes.byteLength - position) {
            fail('truncated frame')
        }
    }

    function readU8() {
        requireBytes(1)
        return bytes[position++]
    }

    function readFloat64() {
        requireBytes(8)
        const value = view.getFloat64(position, true)
        position += 8
        return value
    }

    function readVarUintNumber(maxValue: number) {
        let value = 0
        let factor = 1
        for (let count = 0; count < 8; count++) {
            const byte = readU8()
            value += (byte & 0x7f) * factor
            if ((byte & 0x80) == 0) {
                if (!Number.isSafeInteger(value) || value > maxValue) fail('number varuint overflows')
                return value
            }
            factor *= 0x80
        }
        return fail('unterminated number varuint')
    }

    function readVarUint() {
        let value = 0n
        let shift = 0n
        for (let count = 0; count < MAX_BIGINT_BYTES; count++) {
            const byte = readU8()
            value |= BigInt(byte & 0x7f) << shift
            if ((byte & 0x80) == 0) return value
            shift += 7n
        }
        return fail('unterminated bigint varuint')
    }

    function readSafeInteger() {
        let low = 0
        let factor = 1
        for (let count = 0; count < MAX_SAFE_INTEGER_VARUINT_BYTES; count++) {
            const byte = readU8()
            const payload = byte & 0x7f
            if (count < MAX_SAFE_INTEGER_VARUINT_BYTES - 1) low += payload * factor
            if ((byte & 0x80) == 0) {
                if (count == MAX_SAFE_INTEGER_VARUINT_BYTES - 1) {
                    const half = payload * SAFE_INTEGER_ZIGZAG_HIGH_FACTOR
                        + Math.floor(low / 2)
                    const magnitude = low % 2 == 0 ? half : half + 1
                    return low % 2 == 0 ? magnitude : -magnitude
                }
                return low % 2 == 0 ? low / 2 : -((low + 1) / 2)
            }
            factor *= 0x80
        }
        return fail('unterminated integer varuint')
    }

    function take(length: number) {
        requireBytes(length)
        const result = bytes.subarray(position, position + length)
        position += length
        return result
    }

    function done() {
        return position == bytes.byteLength
    }

    function remaining() {
        return bytes.byteLength - position
    }

    return {
        readU8,
        readFloat64,
        readVarUintNumber,
        readVarUint,
        readSafeInteger,
        take,
        done,
        remaining,
    }
}

type tByteReader = ReturnType<typeof createByteReader>

function writeHeader(writer: tByteWriter, config: tResolvedOptions, kind: number) {
    writer.writeBytes(config.magic)
    writer.writeU8(config.version)
    writer.writeU8(kind)
}

function readHeader(reader: tByteReader, config: tResolvedOptions, expectedKind: number) {
    for (const byte of config.magic) {
        if (reader.readU8() != byte) fail('magic mismatch')
    }
    if (reader.readU8() != config.version) fail('unsupported version')
    if (reader.readU8() != expectedKind) fail('unexpected frame kind')
}

function hasLoneSurrogate(value: string) {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1)
            if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true
            index++
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return true
        }
    }
    return false
}

function writeString(writer: tByteWriter, value: string) {
    if (hasLoneSurrogate(value)) {
        writer.writeU8(1)
        writer.writeVarUintNumber(value.length)
        const bytes = new Uint8Array(value.length * 2)
        const view = new DataView(bytes.buffer)
        for (let index = 0; index < value.length; index++) {
            view.setUint16(index * 2, value.charCodeAt(index), true)
        }
        writer.writeBytes(bytes)
        return
    }
    writer.writeU8(0)
    const bytes = utf8Encoder.encode(value)
    writer.writeVarUintNumber(bytes.byteLength)
    writer.writeBytes(bytes)
}

function readString(reader: tByteReader, trusted: boolean) {
    const mode = reader.readU8()
    const length = reader.readVarUintNumber(MAX_STRING_BYTES)
    if (mode == 0) {
        const bytes = reader.take(length)
        return (trusted ? trustedUtf8Decoder : utf8Decoder).decode(bytes)
    }
    if (mode == 1) {
        if (length > MAX_STRING_BYTES / 2) fail('UTF-16 string exceeds binary limit')
        const bytes = reader.take(length * 2)
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const parts = new Array<string>(Math.ceil(length / 4_096))
        for (let offset = 0, part = 0; offset < length; offset += 4_096, part++) {
            const end = Math.min(length, offset + 4_096)
            const codes = new Array<number>(end - offset)
            for (let index = offset; index < end; index++) {
                codes[index - offset] = view.getUint16(index * 2, true)
            }
            parts[part] = String.fromCharCode(...codes)
        }
        return parts.join('')
    }
    return fail('unknown string encoding')
}

function writeInteger(writer: tByteWriter, value: number) {
    const zigzag = value < 0 ? (-value * 2) - 1 : value * 2
    if (Number.isSafeInteger(zigzag)) {
        writer.writeVarUintNumber(zigzag)
        return
    }
    const integer = BigInt(value)
    writer.writeVarUint(integer < 0n ? ((-integer) << 1n) - 1n : integer << 1n)
}

function readInteger(reader: tByteReader) {
    return reader.readSafeInteger()
}

function writeBigInt(writer: tByteWriter, value: bigint) {
    writer.writeVarUint(value >= 0n ? value << 1n : ((-value) << 1n) - 1n)
}

function readBigInt(reader: tByteReader) {
    const zigzag = reader.readVarUint()
    const magnitude = zigzag >> 1n
    return (zigzag & 1n) == 0n ? magnitude : -magnitude - 1n
}

function genericKindOf(value: unknown, callbackRefs: boolean): tGenericKind {
    if (callbackRefs && rpcBinaryCallbackRefId(value) != undefined) {
        return GENERIC_KIND.CALLBACK_REF
    }
    if (value instanceof RegExp) return GENERIC_KIND.REGEXP
    if (value instanceof Map) return GENERIC_KIND.MAP
    if (value instanceof Set) return GENERIC_KIND.SET
    if (value instanceof ArrayBuffer) return GENERIC_KIND.ARRAY_BUFFER
    if (value instanceof DataView) return GENERIC_KIND.DATA_VIEW
    if (ArrayBuffer.isView(value)) return GENERIC_KIND.TYPED_ARRAY
    if (Array.isArray(value)) return GENERIC_KIND.ARRAY
    if (value != null && typeof value == 'object') return GENERIC_KIND.OBJECT
    return GENERIC_KIND.OTHER
}

function fieldSignature(field: tLayoutField) {
    let result = String(field.kind)
    if (field.kind == FIELD_KIND.NESTED) {
        const nested = field.nested
        if (!nested) fail('nested schema field is missing its layout')
        result += ':' + nested.signature.length + ':' + nested.signature
    } else if (field.kind == FIELD_KIND.GENERIC) {
        result += ':' + field.genericKind
    } else if (field.kind == FIELD_KIND.TYPED_ARRAY) {
        result += ':' + field.binaryCode
    }
    return result
}

function layoutSignature(
    kind: tSchemaKind,
    prototype: 0 | 1,
    fields: tLayoutField[],
) {
    let signature = kind + ':' + prototype + ':' + fields.length + '|'
    for (const field of fields) {
        if (kind == SCHEMA_KIND.OBJECT) {
            const key = field.key!
            signature += key.length + ':' + key
        }
        const type = fieldSignature(field)
        signature += '#' + type.length + ':' + type
    }
    return signature
}

function isSafeDate(value: unknown) {
    if (!(value instanceof Date)) return false
    return Object.getPrototypeOf(value) == Date.prototype
        && Reflect.ownKeys(value).length == 0
}

function isObjectValue(value: unknown): value is object {
    return value != null && typeof value == 'object'
}

function isNestedObjectCollection(value: unknown) {
    return Array.isArray(value)
        && value.length >= 2
        && isObjectValue(value[0])
        && isObjectValue(value[1])
}

function makeField(
    value: unknown,
    depth: number,
    stack: Set<object>,
    config: tResolvedOptions,
): tLayoutField {
    if (value === undefined) return {kind: FIELD_KIND.UNDEFINED}
    if (value === null) return {kind: FIELD_KIND.NULL}
    if (typeof value == 'boolean') return {kind: FIELD_KIND.BOOLEAN}
    if (typeof value == 'number') {
        return Number.isSafeInteger(value) && !Object.is(value, -0)
            ? {kind: FIELD_KIND.INTEGER}
            : {kind: FIELD_KIND.FLOAT64}
    }
    if (typeof value == 'string') return {kind: FIELD_KIND.STRING}
    if (typeof value == 'bigint') return {kind: FIELD_KIND.BIGINT}
    if (isSafeDate(value)) return {kind: FIELD_KIND.DATE}
    const binary = directBinaryField(value, config)
    if (binary) return binary
    // A row collection is length-variable data, not a positional tuple. Keeping
    // it generic here lets its nested DATA frame select RUN/SEGMENTS itself.
    if (isNestedObjectCollection(value)) {
        return {
            kind: FIELD_KIND.GENERIC,
            genericKind: GENERIC_KIND.ARRAY,
        }
    }
    if (value != null && typeof value == 'object') {
        if (depth >= config.maxDepth) {
            let prototype: object | null | undefined
            try {
                prototype = Object.getPrototypeOf(value)
            } catch {
                prototype = undefined
            }
            if (Array.isArray(value) || prototype == Object.prototype || prototype == null) {
                failRange('max depth exceeded')
            }
        } else {
            const nested = inspectLayout(value, depth + 1, stack, config)
            if (nested) return {kind: FIELD_KIND.NESTED, nested}
        }
    }
    return {
        kind: FIELD_KIND.GENERIC,
        genericKind: genericKindOf(value, config.callbackRefs),
    }
}

function inspectTuple(
    value: unknown[],
    depth: number,
    stack: Set<object>,
    config: tResolvedOptions,
): tLayout | undefined {
    if (value.length > MAX_TUPLE_FIELDS) return undefined
    const keys = Reflect.ownKeys(value)
    if (keys.length != value.length + 1 || keys[keys.length - 1] != 'length') return undefined
    const fields = new Array<tLayoutField>(value.length)
    for (let index = 0; index < value.length; index++) {
        if (keys[index] != String(index) || !own.call(value, index)) return undefined
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor)
            || !descriptor.enumerable || !descriptor.configurable || !descriptor.writable) {
            return undefined
        }
        fields[index] = makeField(descriptor.value, depth, stack, config)
    }
    return {
        kind: SCHEMA_KIND.TUPLE,
        prototype: 0,
        fields,
        signature: layoutSignature(SCHEMA_KIND.TUPLE, 0, fields),
    }
}

function inspectObject(
    value: object,
    depth: number,
    stack: Set<object>,
    config: tResolvedOptions,
): tLayout | undefined {
    const prototype = Object.getPrototypeOf(value)
    if (prototype != Object.prototype && prototype != null) return undefined
    const keys = Reflect.ownKeys(value)
    if (keys.length > MAX_FIELDS || keys.some(key => typeof key != 'string')) return undefined
    const fields = new Array<tLayoutField>(keys.length)
    for (let index = 0; index < keys.length; index++) {
        const key = keys[index] as string
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !('value' in descriptor)
            || !descriptor.enumerable || !descriptor.configurable || !descriptor.writable) {
            return undefined
        }
        fields[index] = {
            key,
            ...makeField(descriptor.value, depth, stack, config),
        }
    }
    const prototypeCode = prototype == null ? 1 : 0
    return {
        kind: SCHEMA_KIND.OBJECT,
        prototype: prototypeCode,
        fields,
        signature: layoutSignature(SCHEMA_KIND.OBJECT, prototypeCode, fields),
    }
}

function inspectLayout(
    value: object,
    depth: number,
    stack: Set<object>,
    config: tResolvedOptions,
): tLayout | undefined {
    if (depth > config.maxDepth) failRange('max depth exceeded')
    if (stack.has(value)) return undefined
    stack.add(value)
    try {
        if (Array.isArray(value)) return inspectTuple(value, depth, stack, config)
        return inspectObject(value, depth, stack, config)
    } catch (error) {
        if (error instanceof RangeError) throw error
        return undefined
    } finally {
        stack.delete(value)
    }
}

function containsBulkObjectCollection(
    value: unknown,
    minimum: number,
    depth: number,
    seen: Set<object>,
    budget: {remaining: number},
    config: tResolvedOptions,
): boolean {
    if (!isObjectValue(value) || depth > config.maxDepth
        || seen.has(value) || budget.remaining <= 0) {
        return false
    }
    budget.remaining--
    seen.add(value)
    try {
        // Binary and native rich values are scalar leaves for schema admission.
        // Never enumerate TypedArray indices or descend into Map/Set contents.
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)
            || value instanceof Date || value instanceof RegExp
            || value instanceof Map || value instanceof Set) {
            return false
        }
        if (Array.isArray(value) && value.length >= minimum) {
            let shared: tLayout | undefined
            for (let index = 0; index < minimum; index++) {
                const row = value[index]
                if (!isObjectValue(row)) {
                    shared = undefined
                    break
                }
                const layout = inspectLayout(row, depth + 1, new Set(), config)
                if (!layout) {
                    shared = undefined
                    break
                }
                shared = shared ? mergeLayouts(shared, layout) : layout
                if (!shared) break
            }
            if (shared) return true
        }
        if (Array.isArray(value)) {
            const count = Math.min(value.length, budget.remaining)
            for (let index = 0; index < count; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
                if (descriptor && 'value' in descriptor
                    && containsBulkObjectCollection(
                        descriptor.value,
                        minimum,
                        depth + 1,
                        seen,
                        budget,
                        config,
                    )) {
                    return true
                }
            }
        } else {
            // for..in can stop at the budget. Reflect.ownKeys/Object.keys would
            // allocate every key before the first bounded admission check.
            for (const key in value) {
                if (budget.remaining <= 0) break
                if (!own.call(value, key)) continue
                const descriptor = Object.getOwnPropertyDescriptor(value, key)
                if (descriptor && 'value' in descriptor
                    && containsBulkObjectCollection(
                        descriptor.value,
                        minimum,
                        depth + 1,
                        seen,
                        budget,
                        config,
                    )) {
                    return true
                }
            }
        }
        return false
    } catch (error) {
        if (error instanceof RangeError) throw error
        return false
    } finally {
        seen.delete(value)
    }
}

function fieldMatchesValue(
    field: tLayoutField,
    value: unknown,
    depth: number,
    stack: Set<object>,
    config: tResolvedOptions,
): boolean {
    switch (field.kind) {
        case FIELD_KIND.UNDEFINED:
            return value === undefined
        case FIELD_KIND.NULL:
            return value === null
        case FIELD_KIND.BOOLEAN:
            return typeof value == 'boolean'
        case FIELD_KIND.INTEGER:
            return typeof value == 'number'
                && Number.isSafeInteger(value)
                && !Object.is(value, -0)
        case FIELD_KIND.FLOAT64:
            return typeof value == 'number'
        case FIELD_KIND.STRING:
            return typeof value == 'string'
        case FIELD_KIND.BIGINT:
            return typeof value == 'bigint'
        case FIELD_KIND.DATE:
            return isSafeDate(value)
        case FIELD_KIND.ARRAY_BUFFER:
        case FIELD_KIND.DATA_VIEW:
        case FIELD_KIND.TYPED_ARRAY: {
            const binary = directBinaryField(value, config)
            return binary?.kind == field.kind
                && binary.binaryCode == field.binaryCode
        }
        case FIELD_KIND.NESTED:
            return value != null
                && typeof value == 'object'
                && field.nested != undefined
                && layoutMatchesValue(field.nested, value, depth + 1, stack, config)
        case FIELD_KIND.GENERIC:
            return genericKindOf(value, config.callbackRefs) == field.genericKind
        default:
            return false
    }
}

function layoutMatchesValue(
    layout: tLayout,
    value: object,
    depth: number,
    stack: Set<object>,
    config: tResolvedOptions,
): boolean {
    if (depth > config.maxDepth || stack.has(value)) return false
    stack.add(value)
    try {
        if (layout.kind == SCHEMA_KIND.TUPLE) {
            if (!Array.isArray(value) || value.length != layout.fields.length) return false
            const keys = Reflect.ownKeys(value)
            if (keys.length != value.length + 1 || keys[keys.length - 1] != 'length') return false
            for (let index = 0; index < layout.fields.length; index++) {
                if (keys[index] != String(index)
                    || !fieldMatchesValue(layout.fields[index], value[index], depth, stack, config)) {
                    return false
                }
            }
            return true
        }
        if (Array.isArray(value)) return false
        const prototype = Object.getPrototypeOf(value)
        if (prototype != (layout.prototype == 0 ? Object.prototype : null)) return false
        const keys = Reflect.ownKeys(value)
        if (keys.length != layout.fields.length) return false
        for (let index = 0; index < layout.fields.length; index++) {
            const field = layout.fields[index]
            if (keys[index] != field.key) return false
            const descriptor = Object.getOwnPropertyDescriptor(value, field.key!)
            if (!descriptor || !('value' in descriptor)
                || !descriptor.enumerable || !descriptor.configurable || !descriptor.writable
                || !fieldMatchesValue(field, descriptor.value, depth, stack, config)) {
                return false
            }
        }
        return true
    } catch {
        return false
    } finally {
        stack.delete(value)
    }
}

function trustedFieldMatchesValue(
    field: tLayoutField,
    value: unknown,
    depth: number,
    config: tResolvedOptions,
): boolean {
    switch (field.kind) {
        case FIELD_KIND.UNDEFINED:
            return value === undefined
        case FIELD_KIND.NULL:
            return value === null
        case FIELD_KIND.BOOLEAN:
            return typeof value == 'boolean'
        case FIELD_KIND.INTEGER:
            return typeof value == 'number'
                && Number.isSafeInteger(value)
                && !Object.is(value, -0)
        case FIELD_KIND.FLOAT64:
            return typeof value == 'number'
        case FIELD_KIND.STRING:
            return typeof value == 'string'
        case FIELD_KIND.BIGINT:
            return typeof value == 'bigint'
        case FIELD_KIND.DATE:
            return isSafeDate(value)
        case FIELD_KIND.ARRAY_BUFFER:
        case FIELD_KIND.DATA_VIEW:
        case FIELD_KIND.TYPED_ARRAY: {
            const binary = directBinaryField(value, config)
            return binary?.kind == field.kind
                && binary.binaryCode == field.binaryCode
        }
        case FIELD_KIND.NESTED:
            return value != null
                && typeof value == 'object'
                && field.nested != undefined
                && trustedLayoutMatchesValue(field.nested, value, depth + 1, config)
        case FIELD_KIND.GENERIC:
            return genericKindOf(value, config.callbackRefs) == field.genericKind
        default:
            return false
    }
}

// Negotiated RPC already owns the local values it is serializing. Its hot path
// treats enumerable data fields as the wire surface, but still checks every
// key, prototype and primitive kind before reusing a schema. The standalone
// codec keeps layoutMatchesValue for descriptor-aware inspection.
function trustedLayoutMatchesValue(
    layout: tLayout,
    value: object,
    depth: number,
    config: tResolvedOptions,
): boolean {
    if (depth > config.maxDepth) return false
    if (layout.kind == SCHEMA_KIND.TUPLE) {
        if (!Array.isArray(value) || value.length != layout.fields.length) return false
        const keys = Object.keys(value)
        if (keys.length != value.length) return false
        for (let index = 0; index < layout.fields.length; index++) {
            if (keys[index] != String(index)
                || !trustedFieldMatchesValue(
                    layout.fields[index],
                    value[index],
                    depth,
                    config,
                )) {
                return false
            }
        }
        return true
    }
    if (Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype != (layout.prototype == 0 ? Object.prototype : null)) return false
    const keys = Object.keys(value)
    if (keys.length != layout.fields.length) return false
    for (let index = 0; index < layout.fields.length; index++) {
        const field = layout.fields[index]
        if (keys[index] != field.key
            || !trustedFieldMatchesValue(
                field,
                (value as Record<string, unknown>)[field.key!],
                depth,
                config,
            )) {
            return false
        }
    }
    return true
}

function nestedLayouts(layout: tLayout) {
    const result: tLayout[] = []
    for (const field of layout.fields) {
        if (field.kind == FIELD_KIND.NESTED && field.nested) result.push(field.nested)
    }
    return result
}

function mergeLayouts(left: tLayout, right: tLayout): tLayout | undefined {
    if (left.kind != right.kind
        || left.prototype != right.prototype
        || left.fields.length != right.fields.length) {
        return undefined
    }
    let changed = false
    const fields = new Array<tLayoutField>(left.fields.length)
    for (let index = 0; index < left.fields.length; index++) {
        const a = left.fields[index]
        const b = right.fields[index]
        if (a.key != b.key) return undefined
        if (a.kind == b.kind) {
            if (a.kind == FIELD_KIND.NESTED) {
                const nested = a.nested && b.nested && mergeLayouts(a.nested, b.nested)
                if (!nested) return undefined
                changed ||= nested.signature != a.nested!.signature
                fields[index] = {...a, nested}
            } else {
                if (a.genericKind != b.genericKind) return undefined
                fields[index] = a
            }
            continue
        }
        if ((a.kind == FIELD_KIND.INTEGER && b.kind == FIELD_KIND.FLOAT64)
            || (a.kind == FIELD_KIND.FLOAT64 && b.kind == FIELD_KIND.INTEGER)) {
            fields[index] = {key: a.key, kind: FIELD_KIND.FLOAT64}
            changed = true
            continue
        }
        return undefined
    }
    if (!changed) return left
    return {
        kind: left.kind,
        prototype: left.prototype,
        fields,
        signature: layoutSignature(left.kind, left.prototype, fields),
    }
}

function schemaFromLayout(
    id: number,
    layout: tLayout,
    resolveNested: (layout: tLayout) => tSchema | undefined,
) {
    const fields = layout.fields.map(function mapLayoutField(field): tSchemaField {
        if (field.kind != FIELD_KIND.NESTED) {
            return {
                key: field.key,
                kind: field.kind,
                genericKind: field.genericKind,
                binaryCode: field.binaryCode,
            }
        }
        const nested = field.nested && resolveNested(field.nested)
        if (!nested) fail('nested schema dependency is missing')
        return {
            key: field.key,
            kind: FIELD_KIND.NESTED,
            schemaId: nested.id,
        }
    })
    return {
        id,
        kind: layout.kind,
        prototype: layout.prototype,
        fields,
        signature: layout.signature,
    }
}

function admitStaticLayout(
    registry: tRegistry,
    layout: tLayout,
    maximum: number,
): tSchema | undefined {
    const cached = registry.bySignature.get(layout.signature)
    if (cached) return cached
    for (const nested of nestedLayouts(layout)) {
        if (!admitStaticLayout(registry, nested, maximum)) return undefined
    }
    if (registry.schemas.length >= maximum) return undefined
    const schema = schemaFromLayout(
        registry.schemas.length,
        layout,
        nested => registry.bySignature.get(nested.signature),
    )
    registry.schemas.push(schema)
    registry.bySignature.set(schema.signature, schema)
    return schema
}

function harvestPredeclared(
    value: unknown,
    registry: tRegistry,
    config: tResolvedOptions,
    seen: Set<object>,
) {
    if (value == null || typeof value != 'object' || seen.has(value)) return
    seen.add(value)
    try {
        if (Array.isArray(value)) {
            if (value.length > 0 && value[0] != null && typeof value[0] == 'object') {
                const row = inspectLayout(value[0], 0, new Set(), config)
                if (row && !admitStaticLayout(registry, row, config.maxSchemas)) {
                    failRange('predeclared schemas exceed maxSchemas')
                }
            }
            for (const item of value) harvestPredeclared(item, registry, config, seen)
        } else {
            for (const key of Reflect.ownKeys(value)) {
                const descriptor = Object.getOwnPropertyDescriptor(value, key)
                if (descriptor && 'value' in descriptor) {
                    harvestPredeclared(descriptor.value, registry, config, seen)
                }
            }
        }
        const layout = inspectLayout(value, 0, new Set(), config)
        if (layout && !admitStaticLayout(registry, layout, config.maxSchemas)) {
            failRange('predeclared schemas exceed maxSchemas')
        }
    } finally {
        seen.delete(value)
    }
}

function lookupEncodeSchema(
    registry: tRegistry,
    transaction: tEncodeTransaction,
    signature: string,
) {
    return transaction.stagedBySignature.get(signature)
        || registry.bySignature.get(signature)
}

function admitDynamicLayout(
    registry: tRegistry,
    transaction: tEncodeTransaction,
    layout: tLayout,
    maximum: number,
): tSchema | undefined {
    const cached = lookupEncodeSchema(registry, transaction, layout.signature)
    if (cached) return cached
    for (const nested of nestedLayouts(layout)) {
        if (!admitDynamicLayout(registry, transaction, nested, maximum)) return undefined
    }
    if (registry.schemas.length + transaction.staged.length >= maximum) return undefined
    const schema = schemaFromLayout(
        registry.schemas.length + transaction.staged.length,
        layout,
        nested => lookupEncodeSchema(registry, transaction, nested.signature),
    )
    transaction.staged.push(schema)
    transaction.stagedBySignature.set(schema.signature, schema)
    transaction.candidateRemovals.add(schema.signature)
    transaction.candidateChanges.delete(schema.signature)
    transaction.counters.promotions++
    return schema
}

function transactionCandidate(
    candidates: Map<string, tCandidate>,
    transaction: tEncodeTransaction,
    signature: string,
) {
    if (transaction.candidateRemovals.has(signature)) return undefined
    return transaction.candidateChanges.get(signature) || candidates.get(signature)
}

function candidateCount(
    candidates: Map<string, tCandidate>,
    transaction: tEncodeTransaction,
) {
    let size = candidates.size
    for (const signature of transaction.candidateRemovals) {
        if (candidates.has(signature)) size--
    }
    for (const signature of transaction.candidateChanges.keys()) {
        if (!candidates.has(signature) || transaction.candidateRemovals.has(signature)) size++
    }
    return size
}

function evictCandidate(
    candidates: Map<string, tCandidate>,
    transaction: tEncodeTransaction,
) {
    let victimSignature: string | undefined
    let victim: tCandidate | undefined
    const consider = function considerCandidate(signature: string, candidate: tCandidate) {
        if (transaction.candidateRemovals.has(signature)) return
        const changed = transaction.candidateChanges.get(signature)
        const current = changed || candidate
        if (!victim
            || current.observations < victim.observations
            || (current.observations == victim.observations && current.sequence < victim.sequence)) {
            victimSignature = signature
            victim = current
        }
    }
    for (const [signature, candidate] of candidates) consider(signature, candidate)
    for (const [signature, candidate] of transaction.candidateChanges) {
        if (!candidates.has(signature)) consider(signature, candidate)
    }
    if (victimSignature == undefined) return
    transaction.candidateChanges.delete(victimSignature)
    if (candidates.has(victimSignature)) transaction.candidateRemovals.add(victimSignature)
}

function observeCandidate(
    candidates: Map<string, tCandidate>,
    transaction: tEncodeTransaction,
    layout: tLayout,
    observations: number,
    maximum: number,
) {
    const existing = transactionCandidate(candidates, transaction, layout.signature)
    if (!existing && maximum == 0) return 0
    if (!existing && candidateCount(candidates, transaction) >= maximum) {
        evictCandidate(candidates, transaction)
    }
    transaction.sequence++
    const next = {
        layout,
        observations: (existing?.observations || 0) + observations,
        sequence: transaction.sequence,
    }
    transaction.candidateRemovals.delete(layout.signature)
    transaction.candidateChanges.set(layout.signature, next)
    return next.observations
}

function observeLayoutTree(
    registry: tRegistry,
    candidates: Map<string, tCandidate>,
    transaction: tEncodeTransaction,
    layout: tLayout,
    observations: number,
    config: tResolvedOptions,
) {
    for (const nested of nestedLayouts(layout)) {
        observeLayoutTree(registry, candidates, transaction, nested, observations, config)
    }
    if (lookupEncodeSchema(registry, transaction, layout.signature)) return
    const count = observeCandidate(
        candidates,
        transaction,
        layout,
        observations,
        config.maxSchemas,
    )
    if (count >= config.promotionThreshold) {
        admitDynamicLayout(registry, transaction, layout, config.maxSchemas)
    }
}

function commitEncodeTransaction(
    registry: tRegistry,
    candidates: Map<string, tCandidate>,
    announced: Set<number>,
    hints: Map<tSchemaHint, tHintPlan>,
    transaction: tEncodeTransaction,
) {
    for (const schema of transaction.staged) {
        if (schema.id != registry.schemas.length) fail('schema transaction is out of order')
        registry.schemas.push(schema)
        registry.bySignature.set(schema.signature, schema)
    }
    for (const signature of transaction.candidateRemovals) candidates.delete(signature)
    for (const [signature, candidate] of transaction.candidateChanges) {
        if (!registry.bySignature.has(signature)) candidates.set(signature, candidate)
    }
    for (const id of transaction.announcedIds) announced.add(id)
    for (const [hint, plan] of transaction.hintChanges) hints.set(hint, plan)
}

function schemaById(
    registry: tRegistry,
    staged: tSchema[],
    id: number,
) {
    return id < registry.schemas.length
        ? registry.schemas[id]
        : staged[id - registry.schemas.length]
}

function collectDefinition(
    registry: tRegistry,
    announced: Set<number>,
    transaction: tEncodeTransaction,
    schema: tSchema,
) {
    // IDs are intentionally dense. Sending an unannounced prefix keeps decoder
    // installation append-only even when a later predeclared schema is the first
    // one actually used on the wire.
    for (let id = 0; id <= schema.id; id++) {
        if (!schemaById(registry, transaction.staged, id)) fail('schema id is missing')
        if (announced.has(id) || transaction.definitionIds.has(id)) continue
        transaction.definitionIds.add(id)
        transaction.announcedIds.add(id)
    }
}

function writeSchemaDefinition(writer: tByteWriter, schema: tSchema) {
    writer.writeVarUintNumber(schema.id)
    writer.writeU8(schema.kind)
    writer.writeU8(schema.prototype)
    writer.writeVarUintNumber(schema.fields.length)
    for (const field of schema.fields) {
        if (schema.kind == SCHEMA_KIND.OBJECT) writeString(writer, field.key!)
        writer.writeU8(field.kind)
        if (field.kind == FIELD_KIND.NESTED) {
            writer.writeVarUintNumber(field.schemaId!)
        } else if (field.kind == FIELD_KIND.GENERIC) {
            writer.writeU8(field.genericKind!)
        } else if (field.kind == FIELD_KIND.TYPED_ARRAY) {
            writer.writeU8(field.binaryCode!)
        }
    }
}

function schemaSignatureFromFields(
    kind: tSchemaKind,
    prototype: 0 | 1,
    fields: tSchemaField[],
    registry: tRegistry,
    staged: tSchema[],
) {
    const layoutFields = fields.map(function mapSchemaField(field): tLayoutField {
        if (field.kind != FIELD_KIND.NESTED) {
            return {
                key: field.key,
                kind: field.kind,
                genericKind: field.genericKind,
                binaryCode: field.binaryCode,
            }
        }
        const nested = schemaById(registry, staged, field.schemaId!)
        if (!nested) fail('schema definition references an unknown nested schema')
        return {
            key: field.key,
            kind: FIELD_KIND.NESTED,
            nested: {
                kind: nested.kind,
                prototype: nested.prototype,
                fields: [],
                signature: nested.signature,
            },
        }
    })
    return layoutSignature(kind, prototype, layoutFields)
}

function readSchemaDefinition(
    reader: tByteReader,
    registry: tRegistry,
    staged: tSchema[],
    trusted: boolean,
) {
    const id = reader.readVarUintNumber(MAX_SCHEMAS - 1)
    const kind = reader.readU8()
    if (kind != SCHEMA_KIND.OBJECT && kind != SCHEMA_KIND.TUPLE) {
        fail('unknown schema kind')
    }
    const prototype = reader.readU8()
    if (prototype != 0 && prototype != 1) fail('unknown schema prototype')
    const fieldCount = reader.readVarUintNumber(MAX_FIELDS)
    if (kind == SCHEMA_KIND.TUPLE && fieldCount > MAX_TUPLE_FIELDS) {
        fail('tuple schema exceeds field limit')
    }
    const fields = new Array<tSchemaField>(fieldCount)
    for (let index = 0; index < fieldCount; index++) {
        const key = kind == SCHEMA_KIND.OBJECT ? readString(reader, trusted) : undefined
        const fieldKind = reader.readU8()
        if (fieldKind > FIELD_KIND.TYPED_ARRAY) fail('unknown schema field kind')
        const field: tSchemaField = {key, kind: fieldKind as tFieldKind}
        if (field.kind == FIELD_KIND.NESTED) {
            const schemaId = reader.readVarUintNumber(MAX_SCHEMAS - 1)
            if (!schemaById(registry, staged, schemaId)) {
                fail('schema definition references an unknown nested schema')
            }
            field.schemaId = schemaId
        } else if (field.kind == FIELD_KIND.GENERIC) {
            const genericKind = reader.readU8()
            if (genericKind > GENERIC_KIND.OBJECT) fail('unknown generic field kind')
            field.genericKind = genericKind as tGenericKind
        } else if (field.kind == FIELD_KIND.TYPED_ARRAY) {
            const binaryCode = reader.readU8()
            if (!typedArrayEntryByCode(binaryCode)) fail('unknown typed-array code')
            field.binaryCode = binaryCode
        }
        fields[index] = field
    }
    const signature = schemaSignatureFromFields(
        kind as tSchemaKind,
        prototype as 0 | 1,
        fields,
        registry,
        staged,
    )
    return {
        id,
        kind: kind as tSchemaKind,
        prototype: prototype as 0 | 1,
        fields,
        signature,
    }
}

function schemasEqual(left: tSchema, right: tSchema) {
    if (left.id != right.id
        || left.kind != right.kind
        || left.prototype != right.prototype
        || left.fields.length != right.fields.length) {
        return false
    }
    for (let index = 0; index < left.fields.length; index++) {
        const a = left.fields[index]
        const b = right.fields[index]
        if (a.key != b.key || a.kind != b.kind
            || a.genericKind != b.genericKind || a.schemaId != b.schemaId) {
            return false
        }
        if (a.binaryCode != b.binaryCode) return false
    }
    return true
}

function readDefinitions(
    reader: tByteReader,
    registry: tRegistry,
    transaction: tDecodeTransaction,
    trusted: boolean,
) {
    const count = reader.readVarUintNumber(MAX_SCHEMAS)
    for (let index = 0; index < count; index++) {
        const schema = readSchemaDefinition(reader, registry, transaction.staged, trusted)
        const nextId = registry.schemas.length + transaction.staged.length
        if (schema.id < nextId) {
            const existing = schemaById(registry, transaction.staged, schema.id)
            if (!existing || !schemasEqual(existing, schema)) {
                fail('schema definition conflicts with an installed id')
            }
        } else {
            if (schema.id != nextId) fail('schema definition id is out of order')
            transaction.staged.push(schema)
        }
        transaction.counters.definitions++
    }
}

function commitDecodeTransaction(registry: tRegistry, transaction: tDecodeTransaction) {
    for (const schema of transaction.staged) {
        if (schema.id != registry.schemas.length) fail('decoded schema transaction is out of order')
        registry.schemas.push(schema)
        registry.bySignature.set(schema.signature, schema)
    }
}

function fieldValue(schema: tSchema, value: object, index: number) {
    return schema.kind == SCHEMA_KIND.TUPLE
        ? (value as unknown[])[index]
        : (value as Record<string, unknown>)[schema.fields[index].key!]
}

function nestedSchemaHint(schema: tSchema, fieldIndex: number) {
    return -1 - schema.id * (MAX_FIELDS + 1) - fieldIndex
}

function writeGeneric(
    writer: tByteWriter,
    value: unknown,
    depth: number,
    encodeGeneric: tEncodeGeneric,
    hint?: tSchemaHint,
) {
    const wire = encodeGeneric(value, depth, hint)
    writer.writeVarUintNumber(wire.byteLength)
    writer.writeBytes(wire)
}

function writeDirectBinary(writer: tByteWriter, value: Uint8Array) {
    writer.writeVarUintNumber(value.byteLength)
    writer.writeBytes(value)
}

function writeTypedArray(
    writer: tByteWriter,
    value: ArrayBufferView,
    entry: tTypedArrayEntry,
) {
    writeDirectBinary(
        writer,
        endianAdjustedBinaryBytes(activeBinaryBytes(value), entry.bytesPerElement),
    )
}

function readBinaryCopy(reader: tByteReader, maxBinaryBytes: number) {
    const byteLength = reader.readVarUintNumber(maxBinaryBytes)
    return reader.take(byteLength).slice()
}

function readDirectArrayBuffer(reader: tByteReader, maxBinaryBytes: number) {
    return readBinaryCopy(reader, maxBinaryBytes).buffer
}

function readDirectDataView(reader: tByteReader, maxBinaryBytes: number) {
    return new DataView(readBinaryCopy(reader, maxBinaryBytes).buffer)
}

function readDirectTypedArray(
    reader: tByteReader,
    maxBinaryBytes: number,
    binaryCode: number,
) {
    const entry = typedArrayEntryByCode(binaryCode)
    if (!entry) return fail('unknown typed-array code')
    const copy = endianAdjustedBinaryBytes(
        readBinaryCopy(reader, maxBinaryBytes),
        entry.bytesPerElement,
    )
    try {
        return trustRpcBinaryLeaf(new entry.Constructor(copy.buffer))
    } catch {
        return fail('cannot construct typed array')
    }
}

function writeSchemaPayload(
    writer: tByteWriter,
    schema: tSchema,
    value: object,
    registry: tRegistry,
    staged: tSchema[],
    encodeGeneric: tEncodeGeneric,
    counters: tEncodeCounters,
    depth: number,
) {
    for (let index = 0; index < schema.fields.length; index++) {
        const field = schema.fields[index]
        const current = fieldValue(schema, value, index)
        counters.typedFields++
        switch (field.kind) {
            case FIELD_KIND.UNDEFINED:
            case FIELD_KIND.NULL:
                break
            case FIELD_KIND.BOOLEAN:
                writer.writeU8(current ? 1 : 0)
                break
            case FIELD_KIND.INTEGER:
                writeInteger(writer, current as number)
                break
            case FIELD_KIND.FLOAT64:
                writer.writeFloat64(current as number)
                break
            case FIELD_KIND.STRING:
                writeString(writer, current as string)
                break
            case FIELD_KIND.BIGINT:
                writeBigInt(writer, current as bigint)
                break
            case FIELD_KIND.DATE:
                writer.writeFloat64(Date.prototype.getTime.call(current))
                break
            case FIELD_KIND.ARRAY_BUFFER:
                writeDirectBinary(writer, new Uint8Array(current as ArrayBuffer))
                break
            case FIELD_KIND.DATA_VIEW:
                writeDirectBinary(writer, activeBinaryBytes(current as DataView))
                break
            case FIELD_KIND.TYPED_ARRAY: {
                const entry = typedArrayEntryByCode(field.binaryCode!)
                if (!entry) fail('unknown typed-array code')
                writeTypedArray(writer, current as ArrayBufferView, entry)
                break
            }
            case FIELD_KIND.NESTED: {
                const nested = schemaById(registry, staged, field.schemaId!)
                if (!nested) fail('nested schema id is missing')
                writeSchemaPayload(
                    writer,
                    nested,
                    current as object,
                    registry,
                    staged,
                    encodeGeneric,
                    counters,
                    depth + 1,
                )
                break
            }
            case FIELD_KIND.GENERIC:
                writeGeneric(
                    writer,
                    current,
                    depth + 1,
                    encodeGeneric,
                    nestedSchemaHint(schema, index),
                )
                counters.generic++
                break
            default:
                fail('unknown schema field kind')
        }
    }
}

function writeSchemaRunPayload(
    writer: tByteWriter,
    schema: tSchema,
    rows: object[],
    registry: tRegistry,
    staged: tSchema[],
    encodeGeneric: tEncodeGeneric,
    counters: tEncodeCounters,
    depth: number,
) {
    for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex++) {
        const field = schema.fields[fieldIndex]
        counters.typedFields += rows.length
        switch (field.kind) {
            case FIELD_KIND.UNDEFINED:
            case FIELD_KIND.NULL:
                break
            case FIELD_KIND.BOOLEAN:
                for (let start = 0; start < rows.length; start += 8) {
                    let bitmap = 0
                    const end = Math.min(rows.length, start + 8)
                    for (let rowIndex = start; rowIndex < end; rowIndex++) {
                        if (fieldValue(schema, rows[rowIndex], fieldIndex)) {
                            bitmap |= 1 << (rowIndex - start)
                        }
                    }
                    writer.writeU8(bitmap)
                }
                break
            case FIELD_KIND.INTEGER:
                for (const row of rows) {
                    writeInteger(writer, fieldValue(schema, row, fieldIndex) as number)
                }
                break
            case FIELD_KIND.FLOAT64:
                for (const row of rows) {
                    writer.writeFloat64(fieldValue(schema, row, fieldIndex) as number)
                }
                break
            case FIELD_KIND.STRING:
                for (const row of rows) {
                    writeString(writer, fieldValue(schema, row, fieldIndex) as string)
                }
                break
            case FIELD_KIND.BIGINT:
                for (const row of rows) {
                    writeBigInt(writer, fieldValue(schema, row, fieldIndex) as bigint)
                }
                break
            case FIELD_KIND.DATE:
                for (const row of rows) {
                    writer.writeFloat64(Date.prototype.getTime.call(
                        fieldValue(schema, row, fieldIndex),
                    ))
                }
                break
            case FIELD_KIND.ARRAY_BUFFER:
                for (const row of rows) {
                    writeDirectBinary(
                        writer,
                        new Uint8Array(fieldValue(schema, row, fieldIndex) as ArrayBuffer),
                    )
                }
                break
            case FIELD_KIND.DATA_VIEW:
                for (const row of rows) {
                    writeDirectBinary(
                        writer,
                        activeBinaryBytes(fieldValue(schema, row, fieldIndex) as DataView),
                    )
                }
                break
            case FIELD_KIND.TYPED_ARRAY: {
                const entry = typedArrayEntryByCode(field.binaryCode!)
                if (!entry) fail('unknown typed-array code')
                for (const row of rows) {
                    writeTypedArray(
                        writer,
                        fieldValue(schema, row, fieldIndex) as ArrayBufferView,
                        entry,
                    )
                }
                break
            }
            case FIELD_KIND.NESTED: {
                const nested = schemaById(registry, staged, field.schemaId!)
                if (!nested) fail('nested schema id is missing')
                const nestedRows = rows.map(
                    row => fieldValue(schema, row, fieldIndex) as object,
                )
                writeSchemaRunPayload(
                    writer,
                    nested,
                    nestedRows,
                    registry,
                    staged,
                    encodeGeneric,
                    counters,
                    depth + 1,
                )
                break
            }
            case FIELD_KIND.GENERIC:
                for (const row of rows) {
                    writeGeneric(
                        writer,
                        fieldValue(schema, row, fieldIndex),
                        depth + 1,
                        encodeGeneric,
                        nestedSchemaHint(schema, fieldIndex),
                    )
                    counters.generic++
                }
                break
            default:
                fail('unknown schema field kind')
        }
    }
}

function trustedSchemaKeysMatch(schema: tSchema, value: object) {
    if (schema.kind == SCHEMA_KIND.TUPLE) {
        if (!Array.isArray(value) || value.length != schema.fields.length) return false
        const keys = Object.keys(value)
        if (keys.length != value.length) return false
        for (let index = 0; index < keys.length; index++) {
            if (keys[index] != String(index)) return false
        }
        return true
    }
    if (Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype != (schema.prototype == 0 ? Object.prototype : null)) return false
    const keys = Object.keys(value)
    if (keys.length != schema.fields.length) return false
    for (let index = 0; index < keys.length; index++) {
        if (keys[index] != schema.fields[index].key) return false
    }
    return true
}

function allObjectRows(value: unknown[]): value is object[] {
    for (let index = 0; index < value.length; index++) {
        const row = value[index]
        if (row == null || typeof row != 'object') return false
    }
    return true
}

function writeTrustedScalarField(
    writer: tByteWriter,
    schema: tSchema,
    field: tSchemaField,
    fieldIndex: number,
    current: unknown,
    encodeGeneric: tEncodeGeneric,
    counters: tEncodeCounters,
    depth: number,
    config: tResolvedOptions,
) {
    counters.typedFields++
    switch (field.kind) {
        case FIELD_KIND.UNDEFINED:
            return current === undefined
        case FIELD_KIND.NULL:
            return current === null
        case FIELD_KIND.BOOLEAN:
            if (typeof current != 'boolean') return false
            writer.writeU8(current ? 1 : 0)
            return true
        case FIELD_KIND.INTEGER:
            if (typeof current != 'number'
                || !Number.isSafeInteger(current)
                || Object.is(current, -0)) {
                return false
            }
            writeInteger(writer, current)
            return true
        case FIELD_KIND.FLOAT64:
            if (typeof current != 'number') return false
            writer.writeFloat64(current)
            return true
        case FIELD_KIND.STRING:
            if (typeof current != 'string') return false
            writeString(writer, current)
            return true
        case FIELD_KIND.BIGINT:
            if (typeof current != 'bigint') return false
            writeBigInt(writer, current)
            return true
        case FIELD_KIND.DATE:
            if (!isSafeDate(current)) return false
            writer.writeFloat64(Date.prototype.getTime.call(current))
            return true
        case FIELD_KIND.ARRAY_BUFFER: {
            const binary = directBinaryField(current, config)
            if (binary?.kind != FIELD_KIND.ARRAY_BUFFER) return false
            writeDirectBinary(writer, new Uint8Array(current as ArrayBuffer))
            return true
        }
        case FIELD_KIND.DATA_VIEW: {
            const binary = directBinaryField(current, config)
            if (binary?.kind != FIELD_KIND.DATA_VIEW) return false
            writeDirectBinary(writer, activeBinaryBytes(current as DataView))
            return true
        }
        case FIELD_KIND.TYPED_ARRAY: {
            const binary = directBinaryField(current, config)
            if (binary?.kind != FIELD_KIND.TYPED_ARRAY
                || binary.binaryCode != field.binaryCode) {
                return false
            }
            const entry = typedArrayEntryByCode(field.binaryCode!)
            if (!entry) fail('unknown typed-array code')
            writeTypedArray(writer, current as ArrayBufferView, entry)
            return true
        }
        case FIELD_KIND.GENERIC:
            if (genericKindOf(current, config.callbackRefs) != field.genericKind) return false
            writeGeneric(
                writer,
                current,
                depth + 1,
                encodeGeneric,
                nestedSchemaHint(schema, fieldIndex),
            )
            counters.generic++
            return true
        default:
            return false
    }
}

function writeTrustedSchemaPayload(
    writer: tByteWriter,
    schema: tSchema,
    value: object,
    registry: tRegistry,
    staged: tSchema[],
    encodeGeneric: tEncodeGeneric,
    counters: tEncodeCounters,
    depth: number,
    config: tResolvedOptions,
): boolean {
    if (depth > config.maxDepth || !trustedSchemaKeysMatch(schema, value)) return false
    for (let index = 0; index < schema.fields.length; index++) {
        const field = schema.fields[index]
        const current = fieldValue(schema, value, index)
        if (field.kind == FIELD_KIND.NESTED) {
            if (current == null || typeof current != 'object') return false
            const nested = schemaById(registry, staged, field.schemaId!)
            if (!nested) fail('nested schema id is missing')
            if (!writeTrustedSchemaPayload(
                writer,
                nested,
                current as object,
                registry,
                staged,
                encodeGeneric,
                counters,
                depth + 1,
                config,
            )) {
                return false
            }
            continue
        }
        if (!writeTrustedScalarField(
            writer,
            schema,
            field,
            index,
            current,
            encodeGeneric,
            counters,
            depth,
            config,
        )) {
            return false
        }
    }
    return true
}

function writeTrustedSchemaRunPayload(
    writer: tByteWriter,
    schema: tSchema,
    rows: object[],
    registry: tRegistry,
    staged: tSchema[],
    encodeGeneric: tEncodeGeneric,
    counters: tEncodeCounters,
    depth: number,
    config: tResolvedOptions,
): boolean {
    if (depth > config.maxDepth) return false
    for (const row of rows) {
        if (!trustedSchemaKeysMatch(schema, row)) return false
    }
    for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex++) {
        const field = schema.fields[fieldIndex]
        if (field.kind == FIELD_KIND.UNDEFINED || field.kind == FIELD_KIND.NULL) {
            counters.typedFields += rows.length
            for (const row of rows) {
                const current = fieldValue(schema, row, fieldIndex)
                if (field.kind == FIELD_KIND.UNDEFINED
                    ? current !== undefined
                    : current !== null) {
                    return false
                }
            }
            continue
        }
        if (field.kind == FIELD_KIND.BOOLEAN) {
            counters.typedFields += rows.length
            for (let start = 0; start < rows.length; start += 8) {
                let bitmap = 0
                const end = Math.min(rows.length, start + 8)
                for (let rowIndex = start; rowIndex < end; rowIndex++) {
                    const current = fieldValue(schema, rows[rowIndex], fieldIndex)
                    if (typeof current != 'boolean') return false
                    if (current) bitmap |= 1 << (rowIndex - start)
                }
                writer.writeU8(bitmap)
            }
            continue
        }
        if (field.kind == FIELD_KIND.NESTED) {
            const nested = schemaById(registry, staged, field.schemaId!)
            if (!nested) fail('nested schema id is missing')
            const nestedRows = new Array<object>(rows.length)
            for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
                const current = fieldValue(schema, rows[rowIndex], fieldIndex)
                if (current == null || typeof current != 'object') return false
                nestedRows[rowIndex] = current as object
            }
            if (!writeTrustedSchemaRunPayload(
                writer,
                nested,
                nestedRows,
                registry,
                staged,
                encodeGeneric,
                counters,
                depth + 1,
                config,
            )) {
                return false
            }
            continue
        }
        for (const row of rows) {
            if (!writeTrustedScalarField(
                writer,
                schema,
                field,
                fieldIndex,
                fieldValue(schema, row, fieldIndex),
                encodeGeneric,
                counters,
                depth,
                config,
            )) {
                return false
            }
        }
    }
    return true
}

function defineDecodedField(target: object, key: string, value: unknown) {
    // Assignment creates the same ordinary data descriptor and is materially
    // cheaper for wide rows. __proto__ is the one legacy setter which must not
    // observe a wire key.
    if (key != '__proto__' || Object.getPrototypeOf(target) == null) {
        (target as Record<string, unknown>)[key] = value
        return
    }
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    })
}

function readGeneric(
    reader: tByteReader,
    maximum: number,
    depth: number,
    decodeGeneric: (wire: Uint8Array, depth: number) => unknown,
) {
    const length = reader.readVarUintNumber(maximum)
    return decodeGeneric(reader.take(length), depth)
}

function readSchemaPayload(
    reader: tByteReader,
    schema: tSchema,
    registry: tRegistry,
    staged: tSchema[],
    decodeGeneric: (wire: Uint8Array, depth: number) => unknown,
    counters: tDecodeCounters,
    depth: number,
    maxBinaryBytes: number,
) {
    const target: any = schema.kind == SCHEMA_KIND.TUPLE
        ? new Array(schema.fields.length)
        : Object.create(schema.prototype == 0 ? Object.prototype : null)
    for (let index = 0; index < schema.fields.length; index++) {
        const field = schema.fields[index]
        counters.typedFields++
        let value: unknown
        switch (field.kind) {
            case FIELD_KIND.UNDEFINED:
                value = undefined
                break
            case FIELD_KIND.NULL:
                value = null
                break
            case FIELD_KIND.BOOLEAN:
                value = reader.readU8() != 0
                break
            case FIELD_KIND.INTEGER:
                value = readInteger(reader)
                break
            case FIELD_KIND.FLOAT64:
                value = reader.readFloat64()
                break
            case FIELD_KIND.STRING:
                value = readString(reader, true)
                break
            case FIELD_KIND.BIGINT:
                value = readBigInt(reader)
                break
            case FIELD_KIND.DATE:
                value = new Date(reader.readFloat64())
                break
            case FIELD_KIND.ARRAY_BUFFER:
                value = readDirectArrayBuffer(reader, maxBinaryBytes)
                break
            case FIELD_KIND.DATA_VIEW:
                value = readDirectDataView(reader, maxBinaryBytes)
                break
            case FIELD_KIND.TYPED_ARRAY:
                value = readDirectTypedArray(reader, maxBinaryBytes, field.binaryCode!)
                break
            case FIELD_KIND.NESTED: {
                const nested = schemaById(registry, staged, field.schemaId!)
                if (!nested) fail('nested schema id is missing')
                value = readSchemaPayload(
                    reader,
                    nested,
                    registry,
                    staged,
                    decodeGeneric,
                    counters,
                    depth + 1,
                    maxBinaryBytes,
                )
                break
            }
            case FIELD_KIND.GENERIC:
                value = readGeneric(
                    reader,
                    Number.MAX_SAFE_INTEGER,
                    depth + 1,
                    decodeGeneric,
                )
                counters.generic++
                break
            default:
                value = fail('unknown schema field kind')
        }
        if (schema.kind == SCHEMA_KIND.TUPLE) {
            target[index] = value
        } else {
            defineDecodedField(target, field.key!, value)
        }
    }
    return target
}

function createSchemaTarget(schema: tSchema) {
    return schema.kind == SCHEMA_KIND.TUPLE
        ? new Array(schema.fields.length)
        : Object.create(schema.prototype == 0 ? Object.prototype : null)
}

function setSchemaField(
    schema: tSchema,
    target: any,
    fieldIndex: number,
    value: unknown,
) {
    if (schema.kind == SCHEMA_KIND.TUPLE) {
        target[fieldIndex] = value
    } else {
        defineDecodedField(target, schema.fields[fieldIndex].key!, value)
    }
}

function readSchemaRunPayload(
    reader: tByteReader,
    schema: tSchema,
    count: number,
    registry: tRegistry,
    staged: tSchema[],
    decodeGeneric: (wire: Uint8Array, depth: number) => unknown,
    counters: tDecodeCounters,
    depth: number,
    maxBinaryBytes: number,
) {
    const rows = new Array<any>(count)
    for (let index = 0; index < count; index++) rows[index] = createSchemaTarget(schema)
    for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex++) {
        const field = schema.fields[fieldIndex]
        counters.typedFields += count
        switch (field.kind) {
            case FIELD_KIND.UNDEFINED:
                for (const row of rows) setSchemaField(schema, row, fieldIndex, undefined)
                break
            case FIELD_KIND.NULL:
                for (const row of rows) setSchemaField(schema, row, fieldIndex, null)
                break
            case FIELD_KIND.BOOLEAN:
                for (let start = 0; start < count; start += 8) {
                    const bitmap = reader.readU8()
                    const end = Math.min(count, start + 8)
                    for (let rowIndex = start; rowIndex < end; rowIndex++) {
                        setSchemaField(
                            schema,
                            rows[rowIndex],
                            fieldIndex,
                            (bitmap & (1 << (rowIndex - start))) != 0,
                        )
                    }
                }
                break
            case FIELD_KIND.INTEGER:
                for (const row of rows) {
                    setSchemaField(schema, row, fieldIndex, readInteger(reader))
                }
                break
            case FIELD_KIND.FLOAT64:
                for (const row of rows) {
                    setSchemaField(schema, row, fieldIndex, reader.readFloat64())
                }
                break
            case FIELD_KIND.STRING:
                for (const row of rows) {
                    setSchemaField(schema, row, fieldIndex, readString(reader, true))
                }
                break
            case FIELD_KIND.BIGINT:
                for (const row of rows) {
                    setSchemaField(schema, row, fieldIndex, readBigInt(reader))
                }
                break
            case FIELD_KIND.DATE:
                for (const row of rows) {
                    setSchemaField(schema, row, fieldIndex, new Date(reader.readFloat64()))
                }
                break
            case FIELD_KIND.ARRAY_BUFFER:
                for (const row of rows) {
                    setSchemaField(
                        schema,
                        row,
                        fieldIndex,
                        readDirectArrayBuffer(reader, maxBinaryBytes),
                    )
                }
                break
            case FIELD_KIND.DATA_VIEW:
                for (const row of rows) {
                    setSchemaField(
                        schema,
                        row,
                        fieldIndex,
                        readDirectDataView(reader, maxBinaryBytes),
                    )
                }
                break
            case FIELD_KIND.TYPED_ARRAY:
                for (const row of rows) {
                    setSchemaField(
                        schema,
                        row,
                        fieldIndex,
                        readDirectTypedArray(reader, maxBinaryBytes, field.binaryCode!),
                    )
                }
                break
            case FIELD_KIND.NESTED: {
                const nested = schemaById(registry, staged, field.schemaId!)
                if (!nested) fail('nested schema id is missing')
                const nestedRows = readSchemaRunPayload(
                    reader,
                    nested,
                    count,
                    registry,
                    staged,
                    decodeGeneric,
                    counters,
                    depth + 1,
                    maxBinaryBytes,
                )
                for (let rowIndex = 0; rowIndex < count; rowIndex++) {
                    setSchemaField(
                        schema,
                        rows[rowIndex],
                        fieldIndex,
                        nestedRows[rowIndex],
                    )
                }
                break
            }
            case FIELD_KIND.GENERIC:
                for (const row of rows) {
                    setSchemaField(
                        schema,
                        row,
                        fieldIndex,
                        readGeneric(
                            reader,
                            Number.MAX_SAFE_INTEGER,
                            depth + 1,
                            decodeGeneric,
                        ),
                    )
                    counters.generic++
                }
                break
            default:
                fail('unknown schema field kind')
        }
    }
    return rows
}

function planRoot(
    value: unknown,
    registry: tRegistry,
    candidates: Map<string, tCandidate>,
    announced: Set<number>,
    transaction: tEncodeTransaction,
    config: tResolvedOptions,
    encodeGeneric: tEncodeGeneric,
    depth: number,
    trustedInput: boolean,
): tRootPlan {
    if (depth > config.maxDepth) failRange('max depth exceeded')
    if (value === undefined) return {tag: 'undefined'}
    if (value === null) return {tag: 'null'}
    if (value === false) return {tag: 'false'}
    if (value === true) return {tag: 'true'}
    if (typeof value == 'number') {
        if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
            return {tag: 'integer', value}
        }
        return {tag: 'float64', value}
    }
    if (typeof value == 'string') return {tag: 'string', value}
    if (typeof value == 'bigint') return {tag: 'bigint', value}
    const binary = directBinaryField(value, config)
    if (binary?.kind == FIELD_KIND.ARRAY_BUFFER) {
        return {tag: 'arrayBuffer', value: value as ArrayBuffer}
    }
    if (binary?.kind == FIELD_KIND.DATA_VIEW) {
        return {tag: 'dataView', value: value as DataView}
    }
    if (binary?.kind == FIELD_KIND.TYPED_ARRAY) {
        const entry = typedArrayEntryByCode(binary.binaryCode!)
        if (!entry) fail('unknown typed-array code')
        return {tag: 'typedArray', value: value as ArrayBufferView, entry}
    }

    if (Array.isArray(value) && value.length >= 2
        && value[0] != null && typeof value[0] == 'object') {
        const rowStack = new Set<object>()
        const firstRowLayout = inspectLayout(value[0], depth + 1, rowStack, config)
        if (firstRowLayout) {
            let rowLayout: tLayout = firstRowLayout
            let rows: object[] = [value[0]]
            const layoutSegments: {layout: tLayout, rows: object[]}[] = []
            let supported = true
            for (let index = 1; index < value.length; index++) {
                const row = value[index]
                if (row != null && typeof row == 'object'
                    && (trustedInput
                        ? trustedLayoutMatchesValue(rowLayout, row, depth + 1, config)
                        : layoutMatchesValue(rowLayout, row, depth + 1, rowStack, config))) {
                    rows.push(row)
                    continue
                }
                const nextLayout = row != null && typeof row == 'object'
                    ? inspectLayout(row, depth + 1, rowStack, config)
                    : undefined
                const merged: tLayout | undefined = nextLayout
                    ? mergeLayouts(rowLayout, nextLayout)
                    : undefined
                if (merged) {
                    rowLayout = merged
                    rows.push(row as object)
                    continue
                }
                if (!nextLayout) {
                    supported = false
                    break
                }
                layoutSegments.push({layout: rowLayout, rows})
                rowLayout = nextLayout
                rows = [row as object]
            }
            if (supported) {
                layoutSegments.push({layout: rowLayout, rows})
            }
            if (supported) {
                const observations = new Map<string, {layout: tLayout, count: number}>()
                for (const segment of layoutSegments) {
                    const entry = observations.get(segment.layout.signature)
                    if (entry) {
                        entry.count += segment.rows.length
                    } else {
                        observations.set(segment.layout.signature, {
                            layout: segment.layout,
                            count: segment.rows.length,
                        })
                    }
                }
                for (const entry of observations.values()) {
                    observeLayoutTree(
                        registry,
                        candidates,
                        transaction,
                        entry.layout,
                        entry.count,
                        config,
                    )
                }
                const segments: {schema: tSchema, rows: object[]}[] = []
                let allSchemas = true
                for (const segment of layoutSegments) {
                    const schema = lookupEncodeSchema(
                        registry,
                        transaction,
                        segment.layout.signature,
                    )
                    if (!schema) {
                        allSchemas = false
                        break
                    }
                    collectDefinition(registry, announced, transaction, schema)
                    segments.push({schema, rows: segment.rows})
                }
                if (allSchemas && segments.length == 1) {
                    return {
                        tag: 'run',
                        schema: segments[0].schema,
                        rows: segments[0].rows,
                    }
                }
                if (allSchemas) return {tag: 'segments', segments}
            }
        }
    }

    if (value != null && typeof value == 'object') {
        const layout = inspectLayout(value, depth, new Set(), config)
        if (layout) {
            const existing = lookupEncodeSchema(registry, transaction, layout.signature)
            if (existing) {
                collectDefinition(registry, announced, transaction, existing)
                return {tag: 'schema', schema: existing, value}
            }
            const observations = containsBulkObjectCollection(
                value,
                config.promotionThreshold,
                depth,
                new Set(),
                {remaining: BULK_ADMISSION_SCAN_NODES},
                config,
            )
                ? config.promotionThreshold
                : 1
            observeLayoutTree(registry, candidates, transaction, layout, observations, config)
            const schema = lookupEncodeSchema(registry, transaction, layout.signature)
            if (schema) {
                collectDefinition(registry, announced, transaction, schema)
                return {tag: 'schema', schema, value}
            }
        }
    }

    transaction.counters.generic++
    return {tag: 'generic', wire: encodeGeneric(value, depth)}
}

function writeRoot(
    writer: tByteWriter,
    plan: tRootPlan,
    registry: tRegistry,
    transaction: tEncodeTransaction,
    encodeGeneric: tEncodeGeneric,
    depth: number,
) {
    switch (plan.tag) {
        case 'generic':
            writer.writeU8(ROOT_TAG.GENERIC)
            writer.writeVarUintNumber(plan.wire.byteLength)
            writer.writeBytes(plan.wire)
            break
        case 'undefined':
            writer.writeU8(ROOT_TAG.UNDEFINED)
            break
        case 'null':
            writer.writeU8(ROOT_TAG.NULL)
            break
        case 'false':
            writer.writeU8(ROOT_TAG.FALSE)
            break
        case 'true':
            writer.writeU8(ROOT_TAG.TRUE)
            break
        case 'integer':
            writer.writeU8(ROOT_TAG.INTEGER)
            writeInteger(writer, plan.value)
            break
        case 'float64':
            writer.writeU8(ROOT_TAG.FLOAT64)
            writer.writeFloat64(plan.value)
            break
        case 'string':
            writer.writeU8(ROOT_TAG.STRING)
            writeString(writer, plan.value)
            break
        case 'bigint':
            writer.writeU8(ROOT_TAG.BIGINT)
            writeBigInt(writer, plan.value)
            break
        case 'arrayBuffer':
            writer.writeU8(ROOT_TAG.ARRAY_BUFFER)
            writeDirectBinary(writer, new Uint8Array(plan.value))
            break
        case 'dataView':
            writer.writeU8(ROOT_TAG.DATA_VIEW)
            writeDirectBinary(writer, activeBinaryBytes(plan.value))
            break
        case 'typedArray':
            writer.writeU8(ROOT_TAG.TYPED_ARRAY)
            writer.writeU8(plan.entry.code)
            writeTypedArray(writer, plan.value, plan.entry)
            break
        case 'schema':
            writer.writeU8(ROOT_TAG.SCHEMA)
            writer.writeVarUintNumber(plan.schema.id)
            transaction.counters.references++
            writeSchemaPayload(
                writer,
                plan.schema,
                plan.value,
                registry,
                transaction.staged,
                encodeGeneric,
                transaction.counters,
                depth,
            )
            break
        case 'run':
            writer.writeU8(ROOT_TAG.RUN)
            writer.writeVarUintNumber(plan.schema.id)
            writer.writeVarUintNumber(plan.rows.length)
            transaction.counters.references++
            transaction.counters.runs++
            transaction.counters.rows += plan.rows.length
            writeSchemaRunPayload(
                writer,
                plan.schema,
                plan.rows,
                registry,
                transaction.staged,
                encodeGeneric,
                transaction.counters,
                depth + 1,
            )
            break
        case 'segments':
            writer.writeU8(ROOT_TAG.SEGMENTS)
            writer.writeVarUintNumber(plan.segments.length)
            transaction.counters.references += plan.segments.length
            transaction.counters.runs += plan.segments.length
            for (const segment of plan.segments) {
                writer.writeVarUintNumber(segment.schema.id)
                writer.writeVarUintNumber(segment.rows.length)
                transaction.counters.rows += segment.rows.length
                writeSchemaRunPayload(
                    writer,
                    segment.schema,
                    segment.rows,
                    registry,
                    transaction.staged,
                    encodeGeneric,
                    transaction.counters,
                    depth + 1,
                )
            }
            break
    }
}

function readRoot(
    reader: tByteReader,
    registry: tRegistry,
    transaction: tDecodeTransaction,
    config: tResolvedOptions,
    decodeGeneric: (wire: Uint8Array, depth: number) => unknown,
    depth: number,
) {
    if (depth > config.maxDepth) failRange('max depth exceeded')
    const tag = reader.readU8()
    switch (tag) {
        case ROOT_TAG.GENERIC:
            transaction.counters.generic++
            return readGeneric(reader, config.maxWireBytes, depth, decodeGeneric)
        case ROOT_TAG.UNDEFINED:
            return undefined
        case ROOT_TAG.NULL:
            return null
        case ROOT_TAG.FALSE:
            return false
        case ROOT_TAG.TRUE:
            return true
        case ROOT_TAG.INTEGER:
            return readInteger(reader)
        case ROOT_TAG.FLOAT64:
            return reader.readFloat64()
        case ROOT_TAG.STRING:
            return readString(reader, true)
        case ROOT_TAG.BIGINT:
            return readBigInt(reader)
        case ROOT_TAG.ARRAY_BUFFER:
            return readDirectArrayBuffer(reader, config.maxBinaryBytes)
        case ROOT_TAG.DATA_VIEW:
            return readDirectDataView(reader, config.maxBinaryBytes)
        case ROOT_TAG.TYPED_ARRAY:
            return readDirectTypedArray(
                reader,
                config.maxBinaryBytes,
                reader.readU8(),
            )
        case ROOT_TAG.SCHEMA: {
            const id = reader.readVarUintNumber(MAX_SCHEMAS - 1)
            const schema = schemaById(registry, transaction.staged, id)
            if (!schema) fail('unknown schema id')
            transaction.counters.references++
            return readSchemaPayload(
                reader,
                schema,
                registry,
                transaction.staged,
                decodeGeneric,
                transaction.counters,
                depth,
                config.maxBinaryBytes,
            )
        }
        case ROOT_TAG.RUN: {
            const id = reader.readVarUintNumber(MAX_SCHEMAS - 1)
            const schema = schemaById(registry, transaction.staged, id)
            if (!schema) fail('unknown schema id')
            const count = reader.readVarUintNumber(MAX_COLLECTION_ITEMS)
            const rows = new Array<unknown>(count)
            transaction.counters.references++
            transaction.counters.runs++
            transaction.counters.rows += count
            return readSchemaRunPayload(
                reader,
                schema,
                count,
                registry,
                transaction.staged,
                decodeGeneric,
                transaction.counters,
                depth + 1,
                config.maxBinaryBytes,
            )
        }
        case ROOT_TAG.SEGMENTS: {
            const segmentCount = reader.readVarUintNumber(MAX_COLLECTION_ITEMS)
            const result: unknown[] = []
            transaction.counters.references += segmentCount
            transaction.counters.runs += segmentCount
            for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
                const id = reader.readVarUintNumber(MAX_SCHEMAS - 1)
                const schema = schemaById(registry, transaction.staged, id)
                if (!schema) fail('unknown schema id')
                const count = reader.readVarUintNumber(MAX_COLLECTION_ITEMS - result.length)
                transaction.counters.rows += count
                const rows = readSchemaRunPayload(
                    reader,
                    schema,
                    count,
                    registry,
                    transaction.staged,
                    decodeGeneric,
                    transaction.counters,
                    depth + 1,
                    config.maxBinaryBytes,
                )
                for (const row of rows) result.push(row)
            }
            return result
        }
        default:
            return fail('unknown root value tag')
    }
}

function cloneRegistry(source: readonly tSchema[]) {
    const registry = createRegistry()
    for (const schema of source) {
        const clone = {
            ...schema,
            fields: schema.fields.map(field => ({...field})),
        }
        registry.schemas.push(clone)
        registry.bySignature.set(clone.signature, clone)
    }
    return registry
}

function addEncodeCounters(target: tEncodeCounters, source: tEncodeCounters) {
    target.promotions += source.promotions
    target.definitions += source.definitions
    target.references += source.references
    target.runs += source.runs
    target.rows += source.rows
    target.generic += source.generic
    target.typedFields += source.typedFields
}

function addDecodeCounters(target: tDecodeCounters, source: tDecodeCounters) {
    target.definitions += source.definitions
    target.references += source.references
    target.runs += source.runs
    target.rows += source.rows
    target.generic += source.generic
    target.typedFields += source.typedFields
}

type tSimpleObjectState = {
    prototype: 0 | 1
    keys: string[]
    values: unknown[]
}

function simpleObjectState(value: object): tSimpleObjectState | undefined {
    if (Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype != Object.prototype && prototype != null) return undefined
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length > MAX_DICTIONARY_KEYS
        || ownKeys.some(key => typeof key != 'string')) {
        return undefined
    }
    const keys = ownKeys as string[]
    const values = new Array<unknown>(keys.length)
    for (let index = 0; index < keys.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, keys[index])
        if (!descriptor || !('value' in descriptor)
            || !descriptor.enumerable || !descriptor.configurable || !descriptor.writable) {
            return undefined
        }
        values[index] = descriptor.value
    }
    return {
        prototype: prototype == null ? 1 : 0,
        keys,
        values,
    }
}

function simpleArrayValues(value: unknown[]) {
    if (value.length > MAX_COLLECTION_ITEMS) return undefined
    const keys = Reflect.ownKeys(value)
    if (keys.length != value.length + 1 || keys[keys.length - 1] != 'length') return undefined
    const values = new Array<unknown>(value.length)
    for (let index = 0; index < value.length; index++) {
        if (keys[index] != String(index)) return undefined
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor)
            || !descriptor.enumerable || !descriptor.configurable || !descriptor.writable) {
            return undefined
        }
        values[index] = descriptor.value
    }
    return values
}

function writeFallbackValue(
    writer: tByteWriter,
    value: unknown,
    depth: number,
    stack: Set<object>,
    config: tResolvedOptions,
    encodeExact: (value: unknown) => Uint8Array,
) {
    if (depth > config.maxDepth) failRange('max depth exceeded')
    if (value === undefined) {
        writer.writeU8(FALLBACK_TAG.UNDEFINED)
        return
    }
    if (value === null) {
        writer.writeU8(FALLBACK_TAG.NULL)
        return
    }
    if (value === false) {
        writer.writeU8(FALLBACK_TAG.FALSE)
        return
    }
    if (value === true) {
        writer.writeU8(FALLBACK_TAG.TRUE)
        return
    }
    if (typeof value == 'number') {
        if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
            writer.writeU8(FALLBACK_TAG.INTEGER)
            writeInteger(writer, value)
        } else {
            writer.writeU8(FALLBACK_TAG.FLOAT64)
            writer.writeFloat64(value)
        }
        return
    }
    if (typeof value == 'string') {
        writer.writeU8(FALLBACK_TAG.STRING)
        writeString(writer, value)
        return
    }
    if (typeof value == 'bigint') {
        writer.writeU8(FALLBACK_TAG.BIGINT)
        writeBigInt(writer, value)
        return
    }
    if (isSafeDate(value)) {
        writer.writeU8(FALLBACK_TAG.DATE)
        writer.writeFloat64(Date.prototype.getTime.call(value))
        return
    }
    if (value != null && typeof value == 'object') {
        if (stack.has(value)) fail('cyclic values are not supported')
        stack.add(value)
        try {
            if (Array.isArray(value)) {
                const values = simpleArrayValues(value)
                if (values) {
                    writer.writeU8(FALLBACK_TAG.ARRAY)
                    writer.writeVarUintNumber(values.length)
                    for (const item of values) {
                        writeFallbackValue(
                            writer,
                            item,
                            depth + 1,
                            stack,
                            config,
                            encodeExact,
                        )
                    }
                    return
                }
            } else {
                const state = simpleObjectState(value)
                if (state) {
                    writer.writeU8(FALLBACK_TAG.OBJECT)
                    writer.writeU8(state.prototype)
                    writer.writeVarUintNumber(state.keys.length)
                    for (let index = 0; index < state.keys.length; index++) {
                        writeString(writer, state.keys[index])
                        writeFallbackValue(
                            writer,
                            state.values[index],
                            depth + 1,
                            stack,
                            config,
                            encodeExact,
                        )
                    }
                    return
                }
            }
        } finally {
            stack.delete(value)
        }
    }
    writer.writeU8(FALLBACK_TAG.EXACT)
    const wire = encodeExact(value)
    writer.writeVarUintNumber(wire.byteLength)
    writer.writeBytes(wire)
}

function encodeFallback(
    value: unknown,
    depth: number,
    config: tResolvedOptions,
    encodeExact: (value: unknown) => Uint8Array,
) {
    const writer = createByteWriter(config.maxWireBytes)
    writeFallbackValue(writer, value, depth, new Set(), config, encodeExact)
    return writer.finish()
}

function readFallbackValue(
    reader: tByteReader,
    depth: number,
    config: tResolvedOptions,
    decodeExact: (wire: Uint8Array) => unknown,
): unknown {
    if (depth > config.maxDepth) failRange('max depth exceeded')
    const tag = reader.readU8()
    switch (tag) {
        case FALLBACK_TAG.EXACT: {
            const length = reader.readVarUintNumber(config.maxWireBytes)
            return decodeExact(reader.take(length))
        }
        case FALLBACK_TAG.UNDEFINED:
            return undefined
        case FALLBACK_TAG.NULL:
            return null
        case FALLBACK_TAG.FALSE:
            return false
        case FALLBACK_TAG.TRUE:
            return true
        case FALLBACK_TAG.INTEGER:
            return readInteger(reader)
        case FALLBACK_TAG.FLOAT64:
            return reader.readFloat64()
        case FALLBACK_TAG.STRING:
            return readString(reader, true)
        case FALLBACK_TAG.BIGINT:
            return readBigInt(reader)
        case FALLBACK_TAG.DATE:
            return new Date(reader.readFloat64())
        case FALLBACK_TAG.OBJECT: {
            const prototype = reader.readU8()
            if (prototype != 0 && prototype != 1) fail('unknown fallback object prototype')
            const count = reader.readVarUintNumber(MAX_DICTIONARY_KEYS)
            const target = Object.create(prototype == 0 ? Object.prototype : null)
            for (let index = 0; index < count; index++) {
                const key = readString(reader, true)
                const field = readFallbackValue(reader, depth + 1, config, decodeExact)
                defineDecodedField(target, key, field)
            }
            return target
        }
        case FALLBACK_TAG.ARRAY: {
            const count = reader.readVarUintNumber(MAX_COLLECTION_ITEMS)
            const target = new Array<unknown>(count)
            for (let index = 0; index < count; index++) {
                target[index] = readFallbackValue(reader, depth + 1, config, decodeExact)
            }
            return target
        }
        default:
            return fail('unknown fallback value tag')
    }
}

function decodeFallback(
    wire: Uint8Array,
    depth: number,
    config: tResolvedOptions,
    decodeExact: (wire: Uint8Array) => unknown,
) {
    const reader = createByteReader(wire)
    const value = readFallbackValue(reader, depth, config, decodeExact)
    if (!reader.done()) fail('fallback value has trailing bytes')
    return value
}

export function createRpcBinarySchemaCodec(options: RpcBinarySchemaCodecOptions) {
    const config = resolveOptions(options)
    const genericMagic = [0x52, 0x53, 0x47] as const
    const genericEncoder = createBinaryValueCodec({
        magic: genericMagic,
        version: config.version,
        label: config.label + ' generic encode',
        callbackRefs: config.callbackRefs,
        shapeCache: false,
        maxDepth: config.maxDepth,
        maxBinaryBytes: config.maxBinaryBytes,
        maxWireBytes: config.maxWireBytes,
    })
    const genericDecoder = createBinaryValueCodec({
        magic: genericMagic,
        version: config.version,
        label: config.label + ' generic decode',
        callbackRefs: config.callbackRefs,
        shapeCache: false,
        maxDepth: config.maxDepth,
        maxBinaryBytes: config.maxBinaryBytes,
        maxWireBytes: config.maxWireBytes,
    })
    let encodeRegistry = createRegistry()
    for (const value of options.predeclared || []) {
        harvestPredeclared(value, encodeRegistry, config, new Set())
    }
    const predeclaredSchemas = encodeRegistry.schemas.map(schema => ({
        ...schema,
        fields: schema.fields.map(field => ({...field})),
    }))
    let decodeRegistry = createRegistry()
    let candidates = new Map<string, tCandidate>()
    let announced = new Set<number>()
    let hints = new Map<tSchemaHint, tHintPlan>()
    let pendingEncode: object | undefined
    let generation = 0
    let sequence = 0
    let encodeCounters = createEncodeCounters()
    let decodeCounters = createDecodeCounters()
    let encodedBytes = 0

    function makeEncodeTransaction(): tEncodeTransaction {
        return {
            staged: [],
            stagedBySignature: new Map(),
            candidateChanges: new Map(),
            candidateRemovals: new Set(),
            definitionIds: new Set(),
            announcedIds: new Set(),
            hintChanges: new Map(),
            sequence,
            counters: createEncodeCounters(),
        }
    }

    function makeDecodeTransaction(): tDecodeTransaction {
        return {
            staged: [],
            counters: createDecodeCounters(),
        }
    }

    function encodeFallbackPayload(value: unknown, depth: number) {
        const payload = encodeFallback(value, depth, config, genericEncoder.encode)
        const writer = createByteWriter(config.maxWireBytes, payload.byteLength + 1)
        writer.writeU8(GENERIC_PAYLOAD.FALLBACK)
        writer.writeBytes(payload)
        return writer.finish()
    }

    function decodeFallbackPayload(wire: Uint8Array, depth: number) {
        return decodeFallback(wire, depth, config, genericDecoder.decodeTrusted)
    }

    function buildDataWire(
        value: unknown,
        transaction: tEncodeTransaction,
        alreadyIncluded = new Set<number>(),
        compoundStack = new Set<object>(),
        depth = 0,
        trustedInput = false,
        trustedHint?: tSchemaHint,
    ) {
        function encodeNestedGeneric(
            value: unknown,
            nestedDepth: number,
            nestedHint?: tSchemaHint,
        ) {
            const objectValue = value != null && typeof value == 'object'
                ? value
                : undefined
            if (objectValue && compoundStack.has(objectValue)) {
                fail('cyclic values are not supported')
            }
            if (objectValue) compoundStack.add(objectValue)
            const included = new Set(transaction.definitionIds)
            try {
                if (value != null && typeof value == 'object' && !Array.isArray(value)) {
                    const dictionary = simpleObjectState(value)
                    if (dictionary && dictionary.keys.length > MAX_FIELDS) {
                        const valuesWire = buildDataWire(
                            dictionary.values,
                            transaction,
                            included,
                            compoundStack,
                            nestedDepth,
                            trustedInput,
                            nestedHint == undefined
                                ? undefined
                                : String(nestedHint) + ':dictionary',
                        )
                        const dictionaryWriter = createByteWriter(config.maxWireBytes)
                        dictionaryWriter.writeU8(GENERIC_PAYLOAD.DICTIONARY)
                        dictionaryWriter.writeU8(dictionary.prototype)
                        dictionaryWriter.writeVarUintNumber(dictionary.keys.length)
                        for (const key of dictionary.keys) writeString(dictionaryWriter, key)
                        dictionaryWriter.writeVarUintNumber(valuesWire.byteLength)
                        dictionaryWriter.writeBytes(valuesWire)
                        return dictionaryWriter.finish()
                    }
                }
                const dataWire = buildDataWire(
                    value,
                    transaction,
                    included,
                    compoundStack,
                    nestedDepth,
                    trustedInput,
                    nestedHint,
                )
                const nestedWriter = createByteWriter(config.maxWireBytes, dataWire.byteLength + 1)
                nestedWriter.writeU8(GENERIC_PAYLOAD.DATA)
                nestedWriter.writeBytes(dataWire)
                return nestedWriter.finish()
            } finally {
                if (objectValue) compoundStack.delete(objectValue)
            }
        }

        function currentDefinitionIds() {
            return Array.from(transaction.definitionIds)
                .filter(id => !alreadyIncluded.has(id))
                .sort((a, b) => a - b)
        }

        function createDataWriter(definitionIds: number[]) {
            const writer = createByteWriter(config.maxWireBytes)
            writeHeader(writer, config, FRAME_KIND.DATA)
            writer.writeVarUintNumber(definitionIds.length)
            for (const id of definitionIds) {
                const schema = schemaById(encodeRegistry, transaction.staged, id)
                if (!schema) fail('schema definition id is missing')
                writeSchemaDefinition(writer, schema)
            }
            return writer
        }

        function stageHint(plan: tHintPlan) {
            if (trustedHint == undefined) return
            if (!hints.has(trustedHint)
                && !transaction.hintChanges.has(trustedHint)
                && hints.size + transaction.hintChanges.size >= config.maxSchemas) {
                return
            }
            transaction.hintChanges.set(trustedHint, plan)
        }

        if (trustedInput && trustedHint != undefined) {
            const hinted = transaction.hintChanges.get(trustedHint) || hints.get(trustedHint)
            if (hinted) {
                collectDefinition(encodeRegistry, announced, transaction, hinted.schema)
                const definitionIds = currentDefinitionIds()
                const writer = createDataWriter(definitionIds)
                const counters = createEncodeCounters()
                let matched = false
                if (hinted.tag == 'schema'
                    && value != null && typeof value == 'object') {
                    writer.writeU8(ROOT_TAG.SCHEMA)
                    writer.writeVarUintNumber(hinted.schema.id)
                    counters.references++
                    matched = writeTrustedSchemaPayload(
                        writer,
                        hinted.schema,
                        value as object,
                        encodeRegistry,
                        transaction.staged,
                        encodeNestedGeneric,
                        counters,
                        depth,
                        config,
                    )
                } else if (hinted.tag == 'run'
                    && Array.isArray(value) && value.length >= 2) {
                    if (allObjectRows(value)) {
                        const rows = value
                        writer.writeU8(ROOT_TAG.RUN)
                        writer.writeVarUintNumber(hinted.schema.id)
                        writer.writeVarUintNumber(rows.length)
                        counters.references++
                        counters.runs++
                        counters.rows += rows.length
                        matched = writeTrustedSchemaRunPayload(
                            writer,
                            hinted.schema,
                            rows,
                            encodeRegistry,
                            transaction.staged,
                            encodeNestedGeneric,
                            counters,
                            depth + 1,
                            config,
                        )
                    }
                }
                if (matched) {
                    transaction.counters.definitions += definitionIds.length
                    addEncodeCounters(transaction.counters, counters)
                    return writer.finish()
                }
            }
        }

        const plan = planRoot(
            value,
            encodeRegistry,
            candidates,
            announced,
            transaction,
            config,
            encodeFallbackPayload,
            depth,
            trustedInput,
        )
        if (plan.tag == 'schema') {
            stageHint({tag: 'schema', schema: plan.schema})
        } else if (plan.tag == 'run') {
            stageHint({tag: 'run', schema: plan.schema})
        }
        const definitionIds = currentDefinitionIds()
        const writer = createDataWriter(definitionIds)
        writeRoot(
            writer,
            plan,
            encodeRegistry,
            transaction,
            encodeNestedGeneric,
            depth,
        )
        transaction.counters.definitions += definitionIds.length
        return writer.finish()
    }

    function prepareEncodeMode(
        value: unknown,
        rootDepth: number,
        trustedInput: boolean,
        trustedHint?: tSchemaHint,
    ) {
        if (pendingEncode) {
            throw new Error(config.label + ': prepared encode must be committed or rolled back')
        }
        try {
            const transaction = makeEncodeTransaction()
            const wire = buildDataWire(
                value,
                transaction,
                new Set(),
                new Set(),
                rootDepth,
                trustedInput,
                trustedHint,
            )
            const preparedGeneration = generation
            const token = {}
            let settled = false
            pendingEncode = token

            function commit() {
                if (settled) return
                if (preparedGeneration != generation || pendingEncode != token) {
                    throw new Error(config.label + ': prepared encode belongs to an obsolete generation')
                }
                settled = true
                pendingEncode = undefined
                commitEncodeTransaction(encodeRegistry, candidates, announced, hints, transaction)
                sequence = transaction.sequence
                addEncodeCounters(encodeCounters, transaction.counters)
                encodedBytes += wire.byteLength
            }

            function rollback() {
                if (settled) return
                settled = true
                if (pendingEncode == token) pendingEncode = undefined
            }

            return {wire, commit, rollback}
        } catch (error) {
            return labeledError(config.label, error)
        }
    }

    function prepareEncode(value: unknown, rootDepth = 0) {
        return prepareEncodeMode(value, rootDepth, false)
    }

    function prepareEncodeTrusted(
        value: unknown,
        rootDepth = 0,
        trustedHint?: tSchemaHint,
    ) {
        return prepareEncodeMode(value, rootDepth, true, trustedHint)
    }

    function measureEncodeMode(
        value: unknown,
        rootDepth: number,
        trustedInput: boolean,
        trustedHint?: tSchemaHint,
    ) {
        if (pendingEncode) {
            throw new Error(config.label + ': prepared encode must be committed or rolled back')
        }
        try {
            return buildDataWire(
                value,
                makeEncodeTransaction(),
                new Set(),
                new Set(),
                rootDepth,
                trustedInput,
                trustedHint,
            ).byteLength
        } catch (error) {
            return labeledError(config.label, error)
        }
    }

    function measureEncode(value: unknown, rootDepth = 0) {
        return measureEncodeMode(value, rootDepth, false)
    }

    function measureEncodeTrusted(
        value: unknown,
        rootDepth = 0,
        trustedHint?: tSchemaHint,
    ) {
        return measureEncodeMode(value, rootDepth, true, trustedHint)
    }

    function encode(value: unknown, rootDepth = 0) {
        const prepared = prepareEncode(value, rootDepth)
        prepared.commit()
        return prepared.wire
    }

    function readDataBytes(
        bytes: Uint8Array,
        transaction: tDecodeTransaction,
        depth = 0,
    ) {
        if (bytes.byteLength > config.maxWireBytes) {
            failRange('encoded frame exceeds binary limit')
        }
        const reader = createByteReader(bytes)
        readHeader(reader, config, FRAME_KIND.DATA)
        readDefinitions(reader, decodeRegistry, transaction, true)

        function decodeNestedGeneric(wire: Uint8Array, nestedDepth: number): unknown {
            const nested = createByteReader(wire)
            const kind = nested.readU8()
            if (kind == GENERIC_PAYLOAD.FALLBACK) {
                return decodeFallbackPayload(
                    nested.take(nested.remaining()),
                    nestedDepth,
                )
            }
            if (kind == GENERIC_PAYLOAD.DATA) {
                return readDataBytes(
                    nested.take(nested.remaining()),
                    transaction,
                    nestedDepth,
                )
            }
            if (kind == GENERIC_PAYLOAD.DICTIONARY) {
                const prototype = nested.readU8()
                if (prototype != 0 && prototype != 1) fail('unknown dictionary prototype')
                const count = nested.readVarUintNumber(MAX_DICTIONARY_KEYS)
                const keys = new Array<string>(count)
                for (let index = 0; index < count; index++) {
                    keys[index] = readString(nested, true)
                }
                const valuesLength = nested.readVarUintNumber(config.maxWireBytes)
                const values = readDataBytes(
                    nested.take(valuesLength),
                    transaction,
                    nestedDepth,
                ) as unknown[]
                if (!nested.done()) fail('dictionary payload has trailing bytes')
                const target = Object.create(prototype == 0 ? Object.prototype : null)
                for (let index = 0; index < count; index++) {
                    defineDecodedField(target, keys[index], values[index])
                }
                return target
            }
            return fail('unknown generic payload kind')
        }

        const value = readRoot(
            reader,
            decodeRegistry,
            transaction,
            config,
            decodeNestedGeneric,
            depth,
        )
        if (!reader.done()) fail('trailing bytes')
        return value
    }

    function decodeData(wire: unknown) {
        try {
            const bytes = wireBytes(wire)
            const transaction = makeDecodeTransaction()
            const value = readDataBytes(bytes, transaction)
            commitDecodeTransaction(decodeRegistry, transaction)
            addDecodeCounters(decodeCounters, transaction.counters)
            return value
        } catch (error) {
            return labeledError(config.label, error)
        }
    }

    function decode(wire: unknown) {
        return decodeData(wire)
    }

    function decodeTrusted(wire: unknown) {
        return decodeData(wire)
    }

    function encodePrelude() {
        if (pendingEncode) {
            throw new Error(config.label + ': prepared encode must be committed or rolled back')
        }
        try {
            const writer = createByteWriter(config.maxWireBytes)
            writeHeader(writer, config, FRAME_KIND.PRELUDE)
            writer.writeVarUintNumber(predeclaredSchemas.length)
            for (const schema of predeclaredSchemas) writeSchemaDefinition(writer, schema)
            const wire = writer.finish()
            for (const schema of predeclaredSchemas) announced.add(schema.id)
            encodeCounters.definitions += predeclaredSchemas.length
            encodedBytes += wire.byteLength
            return wire
        } catch (error) {
            return labeledError(config.label, error)
        }
    }

    function decodePrelude(payload: unknown) {
        try {
            const bytes = wireBytes(payload)
            if (bytes.byteLength > config.maxWireBytes) {
                failRange('encoded frame exceeds binary limit')
            }
            const reader = createByteReader(bytes)
            readHeader(reader, config, FRAME_KIND.PRELUDE)
            const transaction = makeDecodeTransaction()
            readDefinitions(reader, decodeRegistry, transaction, true)
            if (!reader.done()) fail('trailing bytes')
            commitDecodeTransaction(decodeRegistry, transaction)
            addDecodeCounters(decodeCounters, transaction.counters)
        } catch (error) {
            return labeledError(config.label, error)
        }
    }

    function stats() {
        return {
            generation,
            pendingEncode: pendingEncode != undefined,
            encodeSchemas: encodeRegistry.schemas.length,
            decodeSchemas: decodeRegistry.schemas.length,
            encodeCandidates: candidates.size,
            encodePromotions: encodeCounters.promotions,
            encodeDefinitions: encodeCounters.definitions,
            decodeDefinitions: decodeCounters.definitions,
            encodeReferences: encodeCounters.references,
            decodeReferences: decodeCounters.references,
            encodeRuns: encodeCounters.runs,
            decodeRuns: decodeCounters.runs,
            encodeRows: encodeCounters.rows,
            decodeRows: decodeCounters.rows,
            encodeGeneric: encodeCounters.generic,
            decodeGeneric: decodeCounters.generic,
            encodeTypedFields: encodeCounters.typedFields,
            decodeTypedFields: decodeCounters.typedFields,
            encodedBytes,
        }
    }

    function reset() {
        if (pendingEncode) {
            throw new Error(config.label + ': cannot reset with an unsettled prepared encode')
        }
        generation++
        encodeRegistry = cloneRegistry(predeclaredSchemas)
        decodeRegistry = createRegistry()
        candidates = new Map()
        announced = new Set()
        hints = new Map()
        sequence = 0
        encodeCounters = createEncodeCounters()
        decodeCounters = createDecodeCounters()
        encodedBytes = 0
        genericEncoder.reset()
        genericDecoder.reset()
    }

    return {
        encode,
        prepareEncode,
        prepareEncodeTrusted,
        measureEncode,
        measureEncodeTrusted,
        decode,
        decodeTrusted,
        stats,
        reset,
        encodePrelude,
        decodePrelude,
    }
}

export type RpcBinarySchemaCodec = ReturnType<typeof createRpcBinarySchemaCodec>
