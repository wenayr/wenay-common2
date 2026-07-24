"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cloneStoreProjectionValue = cloneStoreProjectionValue;
exports.reconcileStoreProjection = reconcileStoreProjection;
exports.collectStoreProjectionChanges = collectStoreProjectionChanges;
exports.reconcileStoreProjectionRecord = reconcileStoreProjectionRecord;
const deep_equal_1 = require("../core/deep-equal");
const store_1 = require("./store");
const reactive_1 = require("./reactive");
function owns(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function isRecord(value) {
    if (value == null || typeof value != 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype == null || prototype == Object.prototype;
}
function defineProjectionValue(target, key, value) {
    const defined = Reflect.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    });
    if (!defined)
        throw new TypeError('store projection cannot define key: ' + String(key));
}
function cloneStoreProjectionValue(value) {
    return (0, store_1.cloneStoreValue)(value);
}
function reconcileStoreProjection(store, next) {
    const current = (0, reactive_1.toRaw)(store.state);
    const target = store.state;
    let writes = 0;
    for (const key of Reflect.ownKeys(current)) {
        if (owns(next, key))
            continue;
        delete target[key];
        writes++;
    }
    for (const key of Reflect.ownKeys(next)) {
        const nextValue = next[key];
        const currentValue = current[key];
        if (!isRecord(currentValue) || !isRecord(nextValue)) {
            if ((0, deep_equal_1.compareDeepValues)(currentValue, nextValue))
                continue;
            defineProjectionValue(target, key, nextValue);
            writes++;
            continue;
        }
        const collection = target[key];
        for (const itemKey of Reflect.ownKeys(currentValue)) {
            if (owns(nextValue, itemKey))
                continue;
            delete collection[itemKey];
            writes++;
        }
        for (const itemKey of Reflect.ownKeys(nextValue)) {
            const item = nextValue[itemKey];
            if (owns(currentValue, itemKey) && (0, deep_equal_1.compareDeepValues)(currentValue[itemKey], item))
                continue;
            defineProjectionValue(collection, itemKey, item);
            writes++;
        }
    }
    return writes;
}
function collectStoreProjectionChanges(change, collections) {
    const allowed = new Set(collections);
    const changed = new Map();
    for (const path of change.paths) {
        if (path.length < 2 || !allowed.has(path[0]))
            return null;
        let ids = changed.get(path[0]);
        if (!ids) {
            ids = new Set();
            changed.set(path[0], ids);
        }
        ids.add(path[1]);
    }
    return changed;
}
function reconcileStoreProjectionRecord(store, collectionKey, itemKey, next) {
    const current = (0, reactive_1.toRaw)(store.state);
    const currentCollection = current[collectionKey];
    const targetCollection = store.state[collectionKey];
    const exists = !!currentCollection && owns(currentCollection, itemKey);
    if (!next.exists) {
        if (!exists)
            return false;
        delete targetCollection[itemKey];
        return true;
    }
    if (exists && (0, deep_equal_1.compareDeepValues)(currentCollection[itemKey], next.value))
        return false;
    defineProjectionValue(targetCollection, itemKey, next.value);
    return true;
}
