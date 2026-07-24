"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasCap = exports.RPC_BINARY_DEFAULT_PROMOTION_THRESHOLD = exports.RPC_BINARY_MAX_SCHEMAS = exports.RPC_BINARY_MAX_SHAPES = exports.CAPS_ALL = exports.Caps = void 0;
exports.optToCaps = optToCaps;
exports.rpcBinarySchemaOptions = rpcBinarySchemaOptions;
exports.rpcBinaryMaxShapes = rpcBinaryMaxShapes;
exports.Caps = {
    COMPACT: 1 << 0,
    CB_BATCH: 1 << 1,
    BINARY: 1 << 2,
    BINARY_SCHEMA: 1 << 3,
    BINARY_MSGPACK: 1 << 4,
};
exports.CAPS_ALL = exports.Caps.COMPACT
    | exports.Caps.CB_BATCH
    | exports.Caps.BINARY
    | exports.Caps.BINARY_SCHEMA
    | exports.Caps.BINARY_MSGPACK;
exports.RPC_BINARY_MAX_SHAPES = 1_000;
exports.RPC_BINARY_MAX_SCHEMAS = 1_000;
exports.RPC_BINARY_DEFAULT_PROMOTION_THRESHOLD = 3;
const hasCap = (caps, c) => (caps & c) === c;
exports.hasCap = hasCap;
function optToCaps(opt) {
    let c = exports.Caps.COMPACT | exports.Caps.CB_BATCH;
    if (opt?.compact === false)
        c &= ~exports.Caps.COMPACT;
    if (opt?.callbackBatch === false)
        c &= ~exports.Caps.CB_BATCH;
    if (opt?.binary === true || (opt?.binary && typeof opt.binary == 'object')) {
        c |= exports.Caps.BINARY | exports.Caps.BINARY_SCHEMA | exports.Caps.BINARY_MSGPACK;
        if (typeof opt.binary == 'object' && opt.binary.schema === false) {
            c &= ~(exports.Caps.BINARY_SCHEMA | exports.Caps.BINARY_MSGPACK);
        }
        if (typeof opt.binary == 'object' && opt.binary.msgpack === false) {
            c &= ~exports.Caps.BINARY_MSGPACK;
        }
    }
    return c;
}
function rpcBinarySchemaOptions(opt) {
    const value = opt?.binary && typeof opt.binary == 'object'
        ? opt.binary
        : undefined;
    const maxSchemas = value?.maxSchemas ?? value?.maxShapes;
    const promotionThreshold = value?.promotionThreshold;
    if (maxSchemas != undefined && !Number.isFinite(maxSchemas)) {
        throw new RangeError('RPC binary maxSchemas must be finite');
    }
    if (promotionThreshold != undefined && !Number.isFinite(promotionThreshold)) {
        throw new RangeError('RPC binary promotionThreshold must be finite');
    }
    return {
        maxSchemas: maxSchemas == undefined
            ? exports.RPC_BINARY_MAX_SCHEMAS
            : Math.max(0, Math.min(exports.RPC_BINARY_MAX_SCHEMAS, Math.floor(maxSchemas))),
        promotionThreshold: promotionThreshold == undefined
            ? exports.RPC_BINARY_DEFAULT_PROMOTION_THRESHOLD
            : Math.max(1, Math.floor(promotionThreshold)),
        predeclared: value?.predeclared ?? [],
    };
}
function rpcBinaryMaxShapes(opt) {
    const value = opt?.binary && typeof opt.binary == 'object'
        ? opt.binary.maxShapes
        : undefined;
    if (value == undefined)
        return exports.RPC_BINARY_MAX_SHAPES;
    if (!Number.isFinite(value))
        throw new RangeError('RPC binary maxShapes must be finite');
    return Math.max(0, Math.min(exports.RPC_BINARY_MAX_SHAPES, Math.floor(value)));
}
