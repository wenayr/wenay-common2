"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.copyConversationData = copyConversationData;
function copyConversationData(value, label = 'conversation data') {
    const seen = new Set();
    function copy(current, path) {
        if (current == null || typeof current == 'string' || typeof current == 'boolean')
            return current;
        if (typeof current == 'number') {
            if (!Number.isFinite(current))
                throw new Error(path + ': number must be finite');
            return current;
        }
        if (typeof current != 'object')
            throw new Error(path + ': expected JSON-like data');
        if (seen.has(current))
            throw new Error(path + ': cycles are not supported');
        seen.add(current);
        try {
            if (Array.isArray(current)) {
                const result = [];
                for (let index = 0; index < current.length; index++) {
                    if (!Object.prototype.hasOwnProperty.call(current, index))
                        throw new Error(path + ': sparse arrays are not supported');
                    result.push(copy(current[index], path + '[' + index + ']'));
                }
                return result;
            }
            const prototype = Object.getPrototypeOf(current);
            if (prototype != Object.prototype && prototype != null)
                throw new Error(path + ': class instances are not supported');
            const result = {};
            for (const key of Reflect.ownKeys(current)) {
                if (typeof key != 'string')
                    throw new Error(path + ': symbol keys are not supported');
                if (key == '__proto__' || key == 'prototype' || key == 'constructor')
                    throw new Error(path + ': unsafe object key ' + key);
                const property = Object.getOwnPropertyDescriptor(current, key);
                if (!property || !property.enumerable || !('value' in property))
                    throw new Error(path + ': accessors and hidden properties are not supported');
                result[key] = copy(property.value, path + '.' + key);
            }
            return result;
        }
        finally {
            seen.delete(current);
        }
    }
    return copy(value, label);
}
