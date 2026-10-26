"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkMethodMeta = checkMethodMeta;
exports.describeMethod = describeMethod;
exports.methodMeta = methodMeta;
exports.facadeMetaKey = facadeMetaKey;
exports.checkMetaMap = checkMetaMap;
exports.resolveMethodMeta = resolveMethodMeta;
exports.methodInputSchema = methodInputSchema;
exports.methodArgTuple = methodArgTuple;
const FACADE_METHOD_META = Symbol.for('wenay-common2.facade.methodMeta');
const ANNOTATION_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
function isPlainObject(value) {
    return value != null && typeof value == 'object' && !Array.isArray(value);
}
function objectSchema(value, field, where) {
    if (!isPlainObject(value) || value['type'] != 'object') {
        throw new Error(`Facade metadata ${where}: ${field} must be a JSON Schema of type 'object'`);
    }
    return value;
}
function checkArgs(value, where) {
    if (!Array.isArray(value))
        throw new Error(`Facade metadata ${where}: args must be an array`);
    const names = new Set();
    return Object.freeze(value.map(function checkArg(arg, index) {
        if (!isPlainObject(arg) || typeof arg['name'] != 'string' || arg['name'].length == 0) {
            throw new Error(`Facade metadata ${where}: args[${index}] needs a non-empty name`);
        }
        const name = arg['name'];
        if (names.has(name))
            throw new Error(`Facade metadata ${where}: duplicate argument name ${name}`);
        names.add(name);
        if (!isPlainObject(arg['schema'])) {
            throw new Error(`Facade metadata ${where}: argument ${name} needs a JSON Schema object`);
        }
        if (arg['description'] != null && typeof arg['description'] != 'string') {
            throw new Error(`Facade metadata ${where}: argument ${name} description must be a string`);
        }
        return Object.freeze({ ...arg });
    }));
}
function checkMethodMeta(meta, where) {
    if (!isPlainObject(meta))
        throw new Error(`Facade metadata ${where}: must be an object`);
    if (typeof meta['description'] != 'string' || meta['description'].trim() == '') {
        throw new Error(`Facade metadata ${where}: description must be a non-empty string`);
    }
    if (meta['title'] != null && typeof meta['title'] != 'string') {
        throw new Error(`Facade metadata ${where}: title must be a string`);
    }
    if (meta['input'] != null && meta['args'] != null) {
        throw new Error(`Facade metadata ${where}: input and args are exclusive (one object argument or positional ones)`);
    }
    const out = { ...meta };
    if (meta['input'] != null)
        out['input'] = objectSchema(meta['input'], 'input', where);
    if (meta['args'] != null)
        out['args'] = checkArgs(meta['args'], where);
    if (meta['output'] != null)
        out['output'] = objectSchema(meta['output'], 'output', where);
    if (meta['annotations'] != null) {
        const annotations = meta['annotations'];
        if (!isPlainObject(annotations))
            throw new Error(`Facade metadata ${where}: annotations must be an object`);
        for (const key of ANNOTATION_KEYS) {
            if (annotations[key] != null && typeof annotations[key] != 'boolean') {
                throw new Error(`Facade metadata ${where}: annotations.${key} must be a boolean`);
            }
        }
        out['annotations'] = Object.freeze({ ...annotations });
    }
    if (meta['context'] != null && typeof meta['context'] != 'boolean') {
        throw new Error(`Facade metadata ${where}: context must be a boolean`);
    }
    return Object.freeze(out);
}
function describeMethod(fn, meta) {
    if (typeof fn != 'function')
        throw new Error('describeMethod needs a function');
    const checked = checkMethodMeta(meta, fn.name ? `of ${fn.name}` : 'of an anonymous function');
    Object.defineProperty(fn, FACADE_METHOD_META, { value: checked, configurable: true });
    return fn;
}
function methodMeta(fn) {
    return typeof fn == 'function' ? fn[FACADE_METHOD_META] : undefined;
}
function facadeMetaKey(path) {
    return path.join('.');
}
function checkMetaMap(map) {
    if (map == null)
        return undefined;
    if (!isPlainObject(map))
        throw new Error('Facade metadata map must be an object keyed by dotted path');
    const out = {};
    for (const key of Object.keys(map))
        out[key] = checkMethodMeta(map[key], `for ${key}`);
    return out;
}
function resolveMethodMeta(fn, path, map) {
    const key = facadeMetaKey(path);
    return map != null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : methodMeta(fn);
}
function withDescription(arg) {
    return arg.description == null ? arg.schema : { ...arg.schema, description: arg.description };
}
function methodInputSchema(meta) {
    if (meta?.input)
        return meta.input;
    if (meta?.args) {
        const properties = {};
        const required = [];
        for (const arg of meta.args) {
            properties[arg.name] = withDescription(arg);
            if (!arg.optional)
                required.push(arg.name);
        }
        return {
            type: 'object',
            properties,
            ...(required.length ? { required } : {}),
            additionalProperties: false,
        };
    }
    return { type: 'object' };
}
function methodArgTuple(meta) {
    if (meta?.input)
        return [meta.input];
    if (meta?.args)
        return meta.args.map(withDescription);
    return undefined;
}
