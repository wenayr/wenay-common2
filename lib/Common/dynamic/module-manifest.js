"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateModuleManifest = validateModuleManifest;
exports.parseModuleManifest = parseModuleManifest;
exports.canonicalModuleManifest = canonicalModuleManifest;
exports.moduleManifestSignaturePayload = moduleManifestSignaturePayload;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const manifestDefaults = {
    maxManifestBytes: 64 * 1024,
    maxArtifactBytes: 64 * 1024 * 1024,
    maxDependencies: 64,
    maxListEntries: 64,
};
const rootFields = [
    'manifestProtocol',
    'moduleId',
    'version',
    'contentHash',
    'entrypoint',
    'compatibility',
    'dependencies',
    'capabilities',
    'permissions',
    'integrity',
    'signature',
    'migration',
    'health',
    'budget',
];
const capabilityPattern = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const moduleIdPattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
const rangePattern = /^[0-9A-Za-z*<>=~^|.,+_\-\s]{1,128}$/;
const hookPattern = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const permissionPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const signatureValuePattern = /^[A-Za-z0-9+/_=-]{8,16384}$/;
const hex256Pattern = /^[a-f0-9]{64}$/;
function fail(message) {
    throw new Error('dynamic module manifest: ' + message);
}
function positiveLimit(value, fallback, label) {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1)
        fail(label + ' must be a positive safe integer');
    return resolved;
}
function resolveLimits(input = {}) {
    return {
        maxManifestBytes: positiveLimit(input.maxManifestBytes, manifestDefaults.maxManifestBytes, 'maxManifestBytes'),
        maxArtifactBytes: positiveLimit(input.maxArtifactBytes, manifestDefaults.maxArtifactBytes, 'maxArtifactBytes'),
        maxDependencies: positiveLimit(input.maxDependencies, manifestDefaults.maxDependencies, 'maxDependencies'),
        maxListEntries: positiveLimit(input.maxListEntries, manifestDefaults.maxListEntries, 'maxListEntries'),
    };
}
function parseInput(input, maxBytes) {
    if (typeof input == 'string') {
        if (input.length > maxBytes || encoder.encode(input).byteLength > maxBytes) {
            fail('document exceeds maxManifestBytes');
        }
        try {
            return JSON.parse(input);
        }
        catch {
            return fail('document must be valid JSON');
        }
    }
    if (input instanceof Uint8Array) {
        if (input.byteLength > maxBytes)
            fail('document exceeds maxManifestBytes');
        try {
            return JSON.parse(decoder.decode(input));
        }
        catch {
            return fail('document must be valid UTF-8 JSON');
        }
    }
    return input;
}
function exactObject(value, label, fields) {
    if (typeof value != 'object' || value == null || Array.isArray(value))
        fail(label + ' must be an object');
    const prototype = Object.getPrototypeOf(value);
    if (prototype != Object.prototype && prototype != null)
        fail(label + ' must be a plain data object');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set(fields);
    const output = {};
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key != 'string' || !allowed.has(key))
            fail(label + ' contains unknown field ' + String(key));
        const descriptor = descriptors[key];
        if (!('value' in descriptor))
            fail(label + '.' + key + ' must be inert data');
        output[key] = descriptor.value;
    }
    return output;
}
function required(object, field, label) {
    if (!Object.prototype.hasOwnProperty.call(object, field))
        fail(label + '.' + field + ' is required');
    return object[field];
}
function has(object, field) {
    return Object.prototype.hasOwnProperty.call(object, field);
}
function stringValue(value, label, maxLength = 256) {
    if (typeof value != 'string' || !value || value.length > maxLength) {
        return fail(label + ' must be a non-empty bounded string');
    }
    if (/[\u0000-\u001f\u007f]/.test(value))
        fail(label + ' contains control characters');
    return value;
}
function matchedString(value, label, pattern, maxLength = 256) {
    const text = stringValue(value, label, maxLength);
    if (!pattern.test(text))
        fail(label + ' has an invalid format');
    return text;
}
function moduleId(value, label) {
    return matchedString(value, label, moduleIdPattern, 128);
}
function version(value, label) {
    return matchedString(value, label, versionPattern, 128);
}
function versionRange(value, label) {
    const range = matchedString(value, label, rangePattern, 128);
    if (range.trim() != range || !/[0-9A-Za-z*]/.test(range))
        fail(label + ' has an invalid format');
    return range;
}
function booleanValue(value, label) {
    if (typeof value != 'boolean')
        fail(label + ' must be a boolean');
    return value;
}
function boundedInteger(value, label, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        return fail(label + ` must be a safe integer from ${min} to ${max}`);
    }
    return value;
}
function arrayValues(value, label, maxLength) {
    if (!Array.isArray(value))
        fail(label + ' must be an array');
    if (value.length > maxLength)
        fail(label + ' exceeds its item limit');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor))
            fail(label + ' must be a dense inert-data array');
        output.push(descriptor.value);
    }
    const extra = Object.keys(descriptors).filter(key => key != 'length' && !/^(0|[1-9][0-9]*)$/.test(key));
    if (extra.length)
        fail(label + ' contains unknown field ' + extra[0]);
    return output;
}
function uniqueStrings(value, label, maxLength, validate) {
    const output = arrayValues(value, label, maxLength).map(function validateItem(item, index) {
        return validate(item, `${label}[${index}]`);
    });
    if (new Set(output).size != output.length)
        fail(label + ' contains duplicates');
    return output;
}
function optionalStringList(object, field, label, maxLength, validate) {
    if (!Object.prototype.hasOwnProperty.call(object, field))
        return undefined;
    return uniqueStrings(object[field], label + '.' + field, maxLength, validate);
}
function compatibilityValue(value) {
    const object = exactObject(value, 'compatibility', ['api', 'schema', 'state', 'runtime']);
    function apiCoordinate(input, label) {
        const coordinate = exactObject(input, label, ['contractId', 'version']);
        return {
            contractId: matchedString(required(coordinate, 'contractId', label), label + '.contractId', capabilityPattern, 128),
            version: version(required(coordinate, 'version', label), label + '.version'),
        };
    }
    function versionedCoordinate(input, label) {
        const coordinate = exactObject(input, label, ['id', 'version']);
        return {
            id: matchedString(required(coordinate, 'id', label), label + '.id', capabilityPattern, 128),
            version: version(required(coordinate, 'version', label), label + '.version'),
        };
    }
    const api = apiCoordinate(required(object, 'api', 'compatibility'), 'compatibility.api');
    const schema = has(object, 'schema')
        ? versionedCoordinate(object['schema'], 'compatibility.schema')
        : undefined;
    const state = has(object, 'state')
        ? versionedCoordinate(object['state'], 'compatibility.state')
        : undefined;
    let runtime;
    if (has(object, 'runtime')) {
        const runtimeObject = exactObject(object['runtime'], 'compatibility.runtime', ['name', 'range']);
        const name = required(runtimeObject, 'name', 'compatibility.runtime');
        if (name != 'node' && name != 'browser')
            fail('compatibility.runtime.name is unsupported');
        runtime = {
            name,
            range: versionRange(required(runtimeObject, 'range', 'compatibility.runtime'), 'compatibility.runtime.range'),
        };
    }
    return {
        api,
        ...(schema == undefined ? {} : { schema }),
        ...(state == undefined ? {} : { state }),
        ...(runtime == undefined ? {} : { runtime }),
    };
}
function dependencyValues(value, limits) {
    return arrayValues(value, 'dependencies', limits.maxDependencies).map(function validateDependency(item, index) {
        const label = `dependencies[${index}]`;
        const object = exactObject(item, label, [
            'moduleId',
            'apiRange',
            'required',
            'capabilities',
            'degradation',
        ]);
        const capabilities = optionalStringList(object, 'capabilities', label, limits.maxListEntries, function capability(input, itemLabel) {
            return matchedString(input, itemLabel, capabilityPattern, 128);
        });
        const hasDegradation = has(object, 'degradation');
        const degradation = object['degradation'];
        if (hasDegradation
            && degradation != 'unavailable-result'
            && degradation != 'cached-read'
            && degradation != 'reject') {
            fail(label + '.degradation is unsupported');
        }
        const requiredDependency = booleanValue(required(object, 'required', label), label + '.required');
        if (!requiredDependency && !hasDegradation) {
            fail(label + '.degradation is required for an optional dependency');
        }
        return {
            moduleId: moduleId(required(object, 'moduleId', label), label + '.moduleId'),
            apiRange: versionRange(required(object, 'apiRange', label), label + '.apiRange'),
            required: requiredDependency,
            ...(capabilities == undefined ? {} : { capabilities }),
            ...(!hasDegradation ? {} : { degradation }),
        };
    });
}
function networkPermission(value, label) {
    const text = stringValue(value, label, 512);
    let url;
    try {
        url = new URL(text);
    }
    catch {
        return fail(label + ' must be an absolute HTTP(S) origin');
    }
    if ((url.protocol != 'https:' && url.protocol != 'http:')
        || url.username
        || url.password
        || url.pathname != '/'
        || url.search
        || url.hash
        || text != url.origin) {
        fail(label + ' must be an exact credential-free HTTP(S) origin');
    }
    return text;
}
function permissionValue(value, limits) {
    const object = exactObject(value, 'permissions', ['network', 'storage', 'secrets']);
    const network = optionalStringList(object, 'network', 'permissions', limits.maxListEntries, networkPermission);
    const storage = optionalStringList(object, 'storage', 'permissions', limits.maxListEntries, function storagePermission(input, label) {
        return matchedString(input, label, permissionPattern, 256);
    });
    const secrets = optionalStringList(object, 'secrets', 'permissions', limits.maxListEntries, function secretPermission(input, label) {
        return matchedString(input, label, permissionPattern, 256);
    });
    return {
        ...(network == undefined ? {} : { network }),
        ...(storage == undefined ? {} : { storage }),
        ...(secrets == undefined ? {} : { secrets }),
    };
}
function integrityValue(value, limits) {
    const object = exactObject(value, 'integrity', ['algorithm', 'digest', 'size']);
    if (required(object, 'algorithm', 'integrity') != 'sha256')
        fail('integrity.algorithm is unsupported');
    return {
        algorithm: 'sha256',
        digest: matchedString(required(object, 'digest', 'integrity'), 'integrity.digest', hex256Pattern, 64),
        size: boundedInteger(required(object, 'size', 'integrity'), 'integrity.size', 1, limits.maxArtifactBytes),
    };
}
function signatureValue(value, limits) {
    const object = exactObject(value, 'signature', ['algorithm', 'keyId', 'value', 'signedFields']);
    return {
        algorithm: matchedString(required(object, 'algorithm', 'signature'), 'signature.algorithm', capabilityPattern, 128),
        keyId: matchedString(required(object, 'keyId', 'signature'), 'signature.keyId', permissionPattern, 256),
        value: matchedString(required(object, 'value', 'signature'), 'signature.value', signatureValuePattern, 16384),
        signedFields: uniqueStrings(required(object, 'signedFields', 'signature'), 'signature.signedFields', limits.maxListEntries, function signedField(input, label) {
            const field = stringValue(input, label, 64);
            if (field == 'signature' || !rootFields.includes(field)) {
                fail(label + ' is not a signable manifest field');
            }
            return field;
        }),
    };
}
function migrationValue(value, limits) {
    const object = exactObject(value, 'migration', [
        'fromStateRanges',
        'prepareHook',
        'commitHook',
        'abortHook',
        'reversible',
    ]);
    const ranges = uniqueStrings(required(object, 'fromStateRanges', 'migration'), 'migration.fromStateRanges', limits.maxListEntries, versionRange);
    if (!ranges.length)
        fail('migration.fromStateRanges must not be empty');
    function optionalHook(field) {
        if (!Object.prototype.hasOwnProperty.call(object, field))
            return undefined;
        return matchedString(object[field], 'migration.' + field, hookPattern, 256);
    }
    const prepareHook = optionalHook('prepareHook');
    const commitHook = optionalHook('commitHook');
    const abortHook = optionalHook('abortHook');
    return {
        fromStateRanges: ranges,
        ...(prepareHook == undefined ? {} : { prepareHook }),
        ...(commitHook == undefined ? {} : { commitHook }),
        ...(abortHook == undefined ? {} : { abortHook }),
        reversible: booleanValue(required(object, 'reversible', 'migration'), 'migration.reversible'),
    };
}
function healthValue(value) {
    const object = exactObject(value, 'health', ['warmupHook', 'checkHook', 'timeoutMs', 'failureThreshold']);
    const warmupHook = has(object, 'warmupHook')
        ? matchedString(object['warmupHook'], 'health.warmupHook', hookPattern, 256)
        : undefined;
    return {
        ...(warmupHook == undefined ? {} : { warmupHook }),
        checkHook: matchedString(required(object, 'checkHook', 'health'), 'health.checkHook', hookPattern, 256),
        timeoutMs: boundedInteger(required(object, 'timeoutMs', 'health'), 'health.timeoutMs', 1, 10 * 60 * 1000),
        failureThreshold: boundedInteger(required(object, 'failureThreshold', 'health'), 'health.failureThreshold', 1, 100),
    };
}
function budgetValue(value) {
    const object = exactObject(value, 'budget', [
        'callTimeoutMs',
        'warmupTimeoutMs',
        'memoryMb',
        'cpuMs',
        'concurrency',
    ]);
    function optionalBudget(field, max) {
        if (!Object.prototype.hasOwnProperty.call(object, field))
            return undefined;
        return boundedInteger(object[field], 'budget.' + field, 1, max);
    }
    const memoryMb = optionalBudget('memoryMb', 32 * 1024);
    const cpuMs = optionalBudget('cpuMs', 10 * 60 * 1000);
    const concurrency = optionalBudget('concurrency', 10_000);
    return {
        callTimeoutMs: boundedInteger(required(object, 'callTimeoutMs', 'budget'), 'budget.callTimeoutMs', 1, 10 * 60 * 1000),
        warmupTimeoutMs: boundedInteger(required(object, 'warmupTimeoutMs', 'budget'), 'budget.warmupTimeoutMs', 1, 10 * 60 * 1000),
        ...(memoryMb == undefined ? {} : { memoryMb }),
        ...(cpuMs == undefined ? {} : { cpuMs }),
        ...(concurrency == undefined ? {} : { concurrency }),
    };
}
function deepFreeze(value) {
    if (typeof value != 'object' || value == null || Object.isFrozen(value))
        return value;
    for (const nested of Object.values(value))
        deepFreeze(nested);
    return Object.freeze(value);
}
function stableJson(value) {
    if (value == null || typeof value == 'boolean' || typeof value == 'string')
        return JSON.stringify(value);
    if (typeof value == 'number') {
        if (!Number.isFinite(value))
            fail('canonical data contains a non-finite number');
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return '[' + value.map(stableJson).join(',') + ']';
    if (typeof value != 'object')
        fail('canonical data contains a non-JSON value');
    const object = value;
    return '{' + Object.keys(object).sort().map(function encodeField(key) {
        return JSON.stringify(key) + ':' + stableJson(object[key]);
    }).join(',') + '}';
}
function entrypointValue(value) {
    const entrypoint = stringValue(value, 'entrypoint', 512);
    if (!entrypoint.startsWith('./')
        || entrypoint.includes('\\')
        || entrypoint.includes('?')
        || entrypoint.includes('#')
        || entrypoint.includes(':')) {
        fail('entrypoint must be a normalized relative path');
    }
    const parts = entrypoint.slice(2).split('/');
    if (!parts.length || parts.some(part => !part || part == '.' || part == '..')) {
        fail('entrypoint contains path traversal or an empty segment');
    }
    return entrypoint;
}
function validateModuleManifest(input, limitOverrides = {}) {
    const limits = resolveLimits(limitOverrides);
    const root = exactObject(parseInput(input, limits.maxManifestBytes), 'manifest', rootFields);
    const manifestProtocol = required(root, 'manifestProtocol', 'manifest');
    if (typeof manifestProtocol != 'number' || manifestProtocol != 1) {
        fail('manifestProtocol is unsupported');
    }
    const contentHash = matchedString(required(root, 'contentHash', 'manifest'), 'contentHash', /^sha256:[a-f0-9]{64}$/, 71);
    const capabilities = uniqueStrings(required(root, 'capabilities', 'manifest'), 'capabilities', limits.maxListEntries, function capability(input, label) {
        return matchedString(input, label, capabilityPattern, 128);
    });
    const integrity = integrityValue(required(root, 'integrity', 'manifest'), limits);
    if (contentHash.slice('sha256:'.length) != integrity.digest) {
        fail('contentHash and integrity.digest must identify the same bytes');
    }
    const signature = signatureValue(required(root, 'signature', 'manifest'), limits);
    const migration = has(root, 'migration') ? migrationValue(root['migration'], limits) : undefined;
    const manifest = {
        manifestProtocol: 1,
        moduleId: moduleId(required(root, 'moduleId', 'manifest'), 'moduleId'),
        version: version(required(root, 'version', 'manifest'), 'version'),
        contentHash,
        entrypoint: entrypointValue(required(root, 'entrypoint', 'manifest')),
        compatibility: compatibilityValue(required(root, 'compatibility', 'manifest')),
        dependencies: dependencyValues(required(root, 'dependencies', 'manifest'), limits),
        capabilities,
        permissions: permissionValue(required(root, 'permissions', 'manifest'), limits),
        integrity,
        signature,
        ...(migration == undefined ? {} : { migration }),
        health: healthValue(required(root, 'health', 'manifest')),
        budget: budgetValue(required(root, 'budget', 'manifest')),
    };
    const presentFields = Object.keys(root).filter(field => field != 'signature').sort();
    const signedFields = [...signature.signedFields].sort();
    if (presentFields.length != signedFields.length
        || presentFields.some((field, index) => field != signedFields[index])) {
        fail('signature.signedFields must cover every present manifest field except signature');
    }
    if (encoder.encode(stableJson(manifest)).byteLength > limits.maxManifestBytes) {
        fail('normalized document exceeds maxManifestBytes');
    }
    return deepFreeze(manifest);
}
function parseModuleManifest(input, limitOverrides = {}) {
    return validateModuleManifest(input, limitOverrides);
}
function canonicalModuleManifest(manifest) {
    return stableJson(manifest);
}
function moduleManifestSignaturePayload(manifest) {
    const signedFields = [...manifest.signature.signedFields].sort();
    const fields = {};
    for (const field of signedFields)
        fields[field] = manifest[field];
    return encoder.encode(stableJson({
        signature: {
            algorithm: manifest.signature.algorithm,
            keyId: manifest.signature.keyId,
            signedFields,
        },
        fields,
    }));
}
