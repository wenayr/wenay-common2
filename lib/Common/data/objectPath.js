"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deepEntries = exports.objectUnset = exports.objectGet = exports.objectSet = void 0;
exports.objectSetValueByPath = objectSetValueByPath;
exports.objectGetValueByPath = objectGetValueByPath;
exports.objectDeleteValueByPath = objectDeleteValueByPath;
exports.iterateDeepObjectEntries = iterateDeepObjectEntries;
function objectSetValueByPath(obj, path, value) {
    if (path.length == 0)
        throw "empty path!";
    let key = path[0];
    if (path.length == 1) {
        obj[key] = value;
        return;
    }
    let val = obj[key];
    if (val == null || typeof val != "object")
        throw "value is not an object: " + val;
    return objectSetValueByPath(val, path.slice(1), value);
}
exports.objectSet = objectSetValueByPath;
function objectGetValueByPath(object, path) {
    if (path.length == 0)
        throw "empty path!";
    let key = path[0];
    if (!(key in object))
        throw "key is not in object: " + key;
    let val = object[key];
    if (path.length == 1)
        return val;
    if (val == null || typeof val != "object")
        throw "value is not an object: " + val;
    return objectGetValueByPath(val, path.slice(1));
}
exports.objectGet = objectGetValueByPath;
function objectDeleteValueByPath(object, path) {
    if (path.length == 0)
        throw "empty path!";
    let key = path[0];
    if (path.length == 1)
        if (!(key in object))
            return false;
        else {
            delete object[key];
            return true;
        }
    let val = object[key];
    if (val == null || typeof val != "object")
        throw "value is not an object: " + val;
    return objectDeleteValueByPath(val, path.slice(1));
}
exports.objectUnset = objectDeleteValueByPath;
function* iterateDeepObjectEntries(obj, filter, currentPath = []) {
    if (obj)
        for (let [key, val] of Object.entries(obj)) {
            let keyPath = currentPath.concat(key);
            if (filter?.(key, val, keyPath) == false)
                continue;
            yield [key, val, keyPath];
            if (typeof (val) == "object")
                yield* iterateDeepObjectEntries(val, filter, keyPath);
        }
}
exports.deepEntries = iterateDeepObjectEntries;
