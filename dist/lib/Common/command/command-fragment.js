"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bindCommandNames = bindCommandNames;
const RESERVED_COMMAND_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
function bindCommandNames(names, make) {
    const bound = {};
    for (const name of names) {
        if (RESERVED_COMMAND_NAMES.has(name))
            throw new Error('command name is reserved: ' + name);
        Object.defineProperty(bound, name, { value: make(name), enumerable: true, writable: true, configurable: true });
    }
    return bound;
}
