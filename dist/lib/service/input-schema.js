"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildInputValidate = buildInputValidate;
exports.inputJsonSchema = inputJsonSchema;
exports.schemaCommand = schemaCommand;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function fieldRule(spec) {
    if (typeof spec == 'string') {
        const optional = spec.endsWith('?');
        return { optional, base: (optional ? spec.slice(0, -1) : spec) };
    }
    return { optional: spec.optional == true, base: spec };
}
function checkScalar(kind, value, path) {
    if (kind == 'string') {
        if (typeof value != 'string')
            throw new Error(path + ' must be a string');
    }
    else if (kind == 'number') {
        if (typeof value != 'number' || !Number.isFinite(value))
            throw new Error(path + ' must be a finite number');
    }
    else if (kind == 'boolean') {
        if (typeof value != 'boolean')
            throw new Error(path + ' must be a boolean');
    }
    else {
        const timestamp = typeof value == 'string' && ISO_DAY.test(value) ? Date.parse(value) : NaN;
        if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) != value) {
            throw new Error(path + ' must be an ISO day (YYYY-MM-DD)');
        }
    }
}
function checkSpec(base, value, path) {
    if (typeof base == 'string')
        return checkScalar(base, value, path);
    if ('enum' in base) {
        if (typeof value != 'string' || !base.enum.includes(value)) {
            throw new Error(path + ' must be one of: ' + base.enum.join(', '));
        }
        return;
    }
    if ('array' in base) {
        if (!Array.isArray(value))
            throw new Error(path + ' must be an array');
        for (let index = 0; index < value.length; index++) {
            checkSpec(base.array, value[index], path + '[' + index + ']');
        }
        return;
    }
    checkObject(base.object, value, path);
}
function checkObject(schema, value, path) {
    if (value == null || typeof value != 'object' || Array.isArray(value)) {
        throw new Error(path + ' must be an object');
    }
    const record = value;
    for (const key of Object.keys(record)) {
        if (!Object.hasOwn(schema, key))
            throw new Error(path + '.' + key + ' is not a known field');
    }
    for (const [key, spec] of Object.entries(schema)) {
        const rule = fieldRule(spec);
        const fieldPath = path + '.' + key;
        if (record[key] === undefined) {
            if (!rule.optional)
                throw new Error(fieldPath + ' is required');
            continue;
        }
        checkSpec(rule.base, record[key], fieldPath);
    }
}
function buildInputValidate(schema) {
    return function validateInput(input) {
        checkObject(schema, input, 'input');
    };
}
const SCALAR_JSON = {
    'string': { type: 'string' },
    'number': { type: 'number' },
    'boolean': { type: 'boolean' },
    'date-string': { type: 'string', format: 'date' },
};
function specJsonSchema(base) {
    if (typeof base == 'string')
        return { ...SCALAR_JSON[base] };
    if ('enum' in base)
        return { type: 'string', enum: [...base.enum] };
    if ('array' in base)
        return { type: 'array', items: specJsonSchema(base.array) };
    return inputJsonSchema(base.object);
}
function inputJsonSchema(schema) {
    const properties = {};
    const required = [];
    for (const [key, spec] of Object.entries(schema)) {
        const rule = fieldRule(spec);
        properties[key] = specJsonSchema(rule.base);
        if (!rule.optional)
            required.push(key);
    }
    return {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
    };
}
function schemaCommand(input, command) {
    return { input, ...command };
}
