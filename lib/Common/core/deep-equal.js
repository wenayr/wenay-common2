"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareDeepValues = compareDeepValues;
function owns(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function samePrimitive(left, right, mode, loose) {
    if (mode == 'same-value')
        return Object.is(left, right);
    return loose ? left == right : left === right;
}
function equalBytes(left, right) {
    if (left.byteLength != right.byteLength)
        return false;
    for (let index = 0; index < left.byteLength; index++)
        if (left[index] != right[index])
            return false;
    return true;
}
function compareDeepValues(leftRoot, rightRoot, mode = 'same-value') {
    const activeLeft = new WeakMap();
    const activeRight = new WeakMap();
    function equal(left, right, loose) {
        if (samePrimitive(left, right, mode, loose))
            return true;
        if (left == null || right == null || typeof left != 'object' || typeof right != 'object')
            return false;
        if (Object.getPrototypeOf(left)?.constructor != Object.getPrototypeOf(right)?.constructor)
            return false;
        if (activeLeft.has(left))
            return activeLeft.get(left) == right;
        if (activeRight.has(right))
            return false;
        activeLeft.set(left, right);
        activeRight.set(right, left);
        try {
            if (left instanceof Date)
                return left.getTime() == right.getTime();
            if (left instanceof RegExp)
                return left.source == right.source && left.flags == right.flags;
            if (left instanceof ArrayBuffer)
                return equalBytes(new Uint8Array(left), new Uint8Array(right));
            if (ArrayBuffer.isView(left)) {
                return equalBytes(new Uint8Array(left.buffer, left.byteOffset, left.byteLength), new Uint8Array(right.buffer, right.byteOffset, right.byteLength));
            }
            if (left instanceof Map) {
                if (left.size != right.size)
                    return false;
                const looseValues = mode == 'legacy';
                for (const [key, value] of left) {
                    if (!right.has(key) || !equal(value, right.get(key), looseValues))
                        return false;
                }
                return true;
            }
            if (left instanceof Set) {
                if (left.size != right.size)
                    return false;
                for (const value of left)
                    if (!right.has(value))
                        return false;
                return true;
            }
            const leftKeys = Object.keys(left);
            const rightKeys = Object.keys(right);
            if (leftKeys.length != rightKeys.length)
                return false;
            for (const key of leftKeys) {
                if (!owns(right, key) || !equal(left[key], right[key], false))
                    return false;
            }
            return true;
        }
        finally {
            activeLeft.delete(left);
            activeRight.delete(right);
        }
    }
    return equal(leftRoot, rightRoot, mode == 'legacy');
}
