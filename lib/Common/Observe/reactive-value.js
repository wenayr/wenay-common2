"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isReactiveObj = isReactiveObj;
exports.prepareReactiveValue = prepareReactiveValue;
function isReactiveObj(value) {
    if (value == null || typeof value != 'object')
        return false;
    if (Array.isArray(value))
        return true;
    const prototype = Object.getPrototypeOf(value);
    return prototype == Object.prototype || prototype == null;
}
function prepareReactiveValue(value, toRaw) {
    const raw = toRaw(value);
    if (!Object.is(raw, value) || !isReactiveObj(value))
        return raw;
    const seen = new WeakSet();
    const pending = [value];
    const replacements = [];
    while (pending.length) {
        const target = pending.pop();
        if (seen.has(target))
            continue;
        seen.add(target);
        for (const key of Reflect.ownKeys(target)) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            if (!Object.prototype.hasOwnProperty.call(descriptor, 'value'))
                continue;
            const child = descriptor.value;
            const next = toRaw(child);
            if (!Object.is(child, next)) {
                if (!descriptor.configurable && !descriptor.writable) {
                    throw new TypeError('Observe cannot unwrap a reactive value in non-writable, non-configurable property ' + String(key));
                }
                replacements.push({ target, key, descriptor: { ...descriptor, value: next } });
            }
            else if (isReactiveObj(child))
                pending.push(child);
        }
    }
    for (const { target, key, descriptor } of replacements) {
        if (!Reflect.defineProperty(target, key, descriptor)) {
            throw new TypeError('Observe cannot store an unwrapped value at property ' + String(key));
        }
    }
    return raw;
}
