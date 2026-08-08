"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CCachedValue2 = exports.CCachedValueT = exports.WeakMapExt = exports.MapExt = exports.CObjectID = exports.Mutex = exports.MyTimerInterval = exports.CancelablePromise = exports.CancelToken = exports.VirtualItems = exports.ArraySet = exports.ArrayMap = exports.StructSet = exports.StructMap = exports.MyNumMap = exports.MyMap = exports.__MyMap = exports.formatSig = exports.roundSig = exports.formatAuto = exports.BSearchAsync = exports.E_MATCH = exports.E_SORTMODE = exports.CBase = exports.isEqual = exports.clone = void 0;
exports.GetEnumKeys = GetEnumKeys;
exports.isDate = isDate;
exports.shallowClone = shallowClone;
exports._deepClone = _deepClone;
exports.deepClone = deepClone;
exports.deepCloneMutable = deepCloneMutable;
exports.deepCloneObject = deepCloneObject;
exports.deepCloneObjectMutable = deepCloneObjectMutable;
exports.toImmutable = toImmutable;
exports.readonlyFull = readonlyFull;
exports.deepEqual = deepEqual;
exports.shallowEqual = shallowEqual;
exports.arrayShallowEqual = arrayShallowEqual;
exports.sleepAsync = sleepAsync;
exports.BSearch = BSearch;
exports.BSearchDefault = BSearchDefault;
exports.BSearchIndex = BSearchIndex;
exports.BSearchValueInRange = BSearchValueInRange;
exports.BSearchNearest = BSearchNearest;
exports._BSearchNearest = _BSearchNearest;
exports.NormalizeDouble = NormalizeDouble;
exports.round = round;
exports.MaxCommonDivisor = MaxCommonDivisor;
exports.MaxCommonDivisorOnArray = MaxCommonDivisorOnArray;
exports.gcd = gcd;
exports.GetDblPrecision2 = GetDblPrecision2;
exports.GetDblPrecision = GetDblPrecision;
exports.decimals = decimals;
exports.DblToStrAuto = DblToStrAuto;
exports.NormalizeDoubleAnd = NormalizeDoubleAnd;
exports.DblToStrAnd = DblToStrAnd;
exports.ArrayItemHandler = ArrayItemHandler;
exports.CreateArrayProxy = CreateArrayProxy;
exports.JSON_clone = JSON_clone;
exports.createCancellableTimer = createCancellableTimer;
exports.createCancellableTaskWrapper = createCancellableTaskWrapper;
exports.copyToClipboard = copyToClipboard;
exports.isObjectCastableTo = isObjectCastableTo;
const deep_equal_1 = require("./deep-equal");
function GetEnumKeys(T) { return Object.keys(T).filter(k => isNaN(k)); }
function isDate(value) {
    return value instanceof Date;
}
{
    let aaa;
    let bbb;
    if (isDate(bbb))
        bbb.getDate();
    let ccc;
    if (isDate(ccc))
        ccc.getDate();
}
if (0)
    Object.prototype.valueOf = function () {
        console.error("function 'valueOf' is not defined in object", this.constructor.name, ":", this);
        throw new Error("function 'valueOf' is not defined!!!");
    };
function shallowClone(val) {
    return Array.isArray(val) ? Object.assign([], { ...val })
        : typeof val == "object" && val ? { ...val } : val;
}
function _deepClone(src, map) {
    if (!src || typeof src != "object")
        return src;
    const srcObj = src;
    const cached = map?.get(srcObj);
    if (cached)
        return cached;
    const cloneValue = (value) => value && typeof value == "object"
        ? _deepClone(value, map)
        : typeof value == "function"
            ? value.bind(newobject)
            : value;
    let newobject = src instanceof Array ? [] : {};
    map ??= new Map();
    map.set(srcObj, newobject);
    if (src instanceof Date) {
        newobject = new Date(src);
        map.set(srcObj, newobject);
        return newobject;
    }
    if (src instanceof Set) {
        newobject = new Set();
        map.set(srcObj, newobject);
        for (const value of src)
            newobject.add(cloneValue(value));
        return newobject;
    }
    if (src instanceof Map) {
        newobject = new Map();
        map.set(srcObj, newobject);
        for (const [key, value] of src)
            newobject.set(cloneValue(key), cloneValue(value));
        return newobject;
    }
    for (let [key, value] of Object.entries(src))
        newobject[key] = cloneValue(value);
    return newobject;
}
function deepClone(object) { return _deepClone(object); }
exports.clone = deepClone;
function deepCloneMutable(value) { return deepClone(value); }
function deepCloneObject(object) {
    if (object == undefined)
        throw new Error("object is undefined!");
    return deepClone(object);
}
function deepCloneObjectMutable(object) { return deepCloneObject(object); }
function toImmutable(object) {
    return object.Mutable == false ? object
        : Object.freeze(Object.assign(deepCloneObject(object), { Mutable: false }));
}
function readonlyFull(arg) { return arg; }
function deepEqual(object1, object2) {
    return (0, deep_equal_1.compareDeepValues)(object1, object2, 'legacy');
}
exports.isEqual = deepEqual;
function shallowEqual(object1, object2) {
    if (!object1 || !object2)
        return object1 == object2;
    const keys1 = Object.keys(object1);
    const keys2 = Object.keys(object2);
    if (keys1.length != keys2.length) {
        return false;
    }
    for (const key of keys1) {
        const val1 = object1[key];
        const val2 = object2[key];
        if (val1 !== val2)
            return false;
    }
    return true;
}
function arrayShallowEqual(arr1, arr2) {
    if (arr1.length != arr2.length)
        return false;
    return arr1.every((item, i) => arr2[i] == item);
}
async function sleepAsync(msec = 0) {
    return new Promise((resolve, reject) => { setTimeout(resolve, msec); });
}
class CBase {
}
exports.CBase = CBase;
var E_SORTMODE;
(function (E_SORTMODE) {
    E_SORTMODE[E_SORTMODE["DESCEND"] = 0] = "DESCEND";
    E_SORTMODE[E_SORTMODE["ASCEND"] = 1] = "ASCEND";
})(E_SORTMODE || (exports.E_SORTMODE = E_SORTMODE = {}));
;
var E_MATCH;
(function (E_MATCH) {
    E_MATCH[E_MATCH["LESS_OR_EQUAL"] = -1] = "LESS_OR_EQUAL";
    E_MATCH[E_MATCH["EQUAL"] = 0] = "EQUAL";
    E_MATCH[E_MATCH["GREAT_OR_EQUAL"] = 1] = "GREAT_OR_EQUAL";
})(E_MATCH || (exports.E_MATCH = E_MATCH = {}));
function BSearch(array, arg2, arg3, ...args) {
    return typeof (arg3) == "function" ? __BSearch(array, arg2, arg3, ...args) :
        typeof (arg2) == "function" ? ___BSearch(array, arg2, arg3, ...args) :
            BSearchDefault(array, arg2, arg3, ...args);
}
const BSearchAsync = (...a) => ___BSearchAsync(...a);
exports.BSearchAsync = BSearchAsync;
function BSearchDefault(array, value, match, mode) {
    return __BSearch(array, value, (a, b) => Math.sign(a.valueOf() - b.valueOf()), match, mode);
}
function __BSearch(array, value, comparer, matchMode, sortMode) {
    return ___BSearch(array, (item) => comparer(item, value), matchMode, sortMode);
}
async function ___BSearchAsync(length, compareIndexToValue, matchMode, sortMode) {
    if (sortMode == undefined)
        sortMode = E_SORTMODE.ASCEND;
    let k = (sortMode === E_SORTMODE.DESCEND || sortMode == "descend" ? -1 : sortMode === E_SORTMODE.ASCEND || sortMode == "ascend" ? 1 : (() => { throw new Error("wrong sortMode: " + JSON.stringify(sortMode)); })());
    let match = typeof matchMode != "string" ? matchMode : matchMode == "equal" ? E_MATCH.EQUAL : matchMode == "lessOrEqual" ? E_MATCH.LESS_OR_EQUAL : matchMode == "greatOrEqual" ? E_MATCH.GREAT_OR_EQUAL : (() => { throw new Error("wrong matchMode!"); })();
    let start = 0;
    let count = length;
    let end = start + count - 1;
    let left = start;
    let right = end;
    let i = left;
    while (left <= right) {
        i = (left + right) >> 1;
        let cmp = await compareIndexToValue(i) * k;
        if (cmp > 0) {
            right = i - 1;
            continue;
        }
        if (cmp < 0) {
            left = i + 1;
            continue;
        }
        return i;
    }
    if (match == E_MATCH.LESS_OR_EQUAL) {
        i = right;
        if (i < start)
            i = -1;
    }
    else if (match == E_MATCH.GREAT_OR_EQUAL) {
        i = left;
        if (i > end)
            i = -1;
    }
    else
        i = -1;
    return i;
}
function BSearchIndex(length, compareIndex, matchMode, sortMode) {
    if (sortMode == undefined)
        sortMode = E_SORTMODE.ASCEND;
    let k = (sortMode === E_SORTMODE.DESCEND || sortMode == "descend" ? -1 : sortMode === E_SORTMODE.ASCEND || sortMode == "ascend" ? 1 : (() => { throw new Error("wrong sortMode: " + JSON.stringify(sortMode)); })());
    let match = typeof matchMode != "string" ? matchMode : matchMode == "equal" ? E_MATCH.EQUAL : matchMode == "lessOrEqual" ? E_MATCH.LESS_OR_EQUAL : matchMode == "greatOrEqual" ? E_MATCH.GREAT_OR_EQUAL : (() => { throw new Error("wrong matchMode!"); })();
    let start = 0;
    let count = length;
    let end = start + count - 1;
    let left = start;
    let right = end;
    let i = left;
    while (left <= right) {
        i = (left + right) >> 1;
        let cmp = compareIndex(i) * k;
        if (cmp > 0) {
            right = i - 1;
            continue;
        }
        if (cmp < 0) {
            left = i + 1;
            continue;
        }
        return i;
    }
    if (match == E_MATCH.LESS_OR_EQUAL) {
        i = right;
        if (i < start)
            i = -1;
    }
    else if (match == E_MATCH.GREAT_OR_EQUAL) {
        i = left;
        if (i > end)
            i = -1;
    }
    else
        i = -1;
    return i;
}
function ___BSearch(array, compareItemToValue, matchMode, sortMode) {
    return BSearchIndex(array.length, (i) => compareItemToValue(array[i]), matchMode, sortMode);
}
function BSearchValueInRange(from, to, precision, compare, matchMode) {
    if (precision == 0)
        throw new Error("precision=0");
    let count = Math.round((to - from) / precision) + 1;
    const sortMode = precision > 0 ? E_SORTMODE.ASCEND : E_SORTMODE.DESCEND;
    count = Math.abs(count);
    let i = BSearchIndex(count, (index) => compare(from + precision * index), matchMode, sortMode);
    if (i == -1)
        return null;
    return from + precision * i;
}
BSearch.EQUAL = E_MATCH.EQUAL;
BSearch.LESS_OR_EQUAL = E_MATCH.LESS_OR_EQUAL;
BSearch.GREAT_OR_EQUAL = E_MATCH.GREAT_OR_EQUAL;
function BSearchNearest(array, searchValue, getterOrDelta, maxDeltaOrNull) {
    let [getter, maxDelta] = typeof getterOrDelta == "function" ? [getterOrDelta, maxDeltaOrNull] : [(elem) => elem, getterOrDelta];
    return _BSearchNearest(array, searchValue, getter, maxDelta);
}
function _BSearchNearest(array, searchValue, arrayGetValue, maxDelta) {
    if (array.length == 0)
        return -1;
    let i = BSearch(array, (element) => arrayGetValue(element) - searchValue, "greatOrEqual");
    let indexes = [];
    if (i == -1)
        i = array.length - 1;
    else if (i > 0)
        indexes.push(i - 1);
    indexes.push(i);
    let delta = maxDelta ?? Number.MAX_VALUE;
    let index = -1;
    for (let i of indexes) {
        let d = Math.abs(arrayGetValue(array[i]) - searchValue);
        if (d <= delta) {
            delta = d;
            index = i;
        }
    }
    return index;
}
function NormalizeDouble(value, digits) { let factor = 10 ** digits; return Math.round(value * factor) / factor; }
function round(value, digits = 0) { return NormalizeDouble(value, digits); }
function fabs(value) { return Math.abs(value); }
function roundInt(value) { return Math.round(value); }
function __GetMaxCommonDivisor(a, b, digits) {
    let precis = 0.1 ** (digits) / 2;
    while (true) {
        if (b < precis)
            return NormalizeDouble(a, digits);
        a = fabs(a - roundInt(a / b) * b);
        if (a < precis)
            return NormalizeDouble(b, digits);
        b = fabs(b - roundInt(b / a) * a);
    }
}
function __GetMaxCommonDivisorInteger(a, b) {
    while (true) {
        if (b < 1)
            return a;
        a = a % b;
        if (a < 1)
            return b;
        b = b % a;
    }
}
function MaxCommonDivisor(a, b, digits = 8) {
    if (a == undefined || b == undefined) {
        throw new Error("!!! Undefined value in MaxCommonDivisor");
    }
    a = fabs(a);
    b = fabs(b);
    if (Number.isInteger(a) && Number.isInteger(b))
        if (a > b)
            return __GetMaxCommonDivisorInteger(a, b);
        else
            return __GetMaxCommonDivisorInteger(b, a);
    if (a > b)
        return __GetMaxCommonDivisor(a, b, digits);
    else
        return __GetMaxCommonDivisor(b, a, digits);
}
function MaxCommonDivisorOnArray(values, precisDigits = 8) {
    let divis = 0;
    for (let value of values) {
        divis = MaxCommonDivisor(value, divis, precisDigits);
    }
    return divis;
}
function gcd(a, b, digits) {
    if (typeof a == "number")
        return MaxCommonDivisor(a, b, digits ?? 8);
    return MaxCommonDivisorOnArray(a, b ?? 8);
}
function GetDblPrecision2(value, mindigits, maxdigits) {
    maxdigits = Math.min(maxdigits, 16);
    let epsilon = Math.pow(0.1, maxdigits + 1);
    let d;
    for (d = mindigits; d < maxdigits; d++) {
        if (fabs(value - NormalizeDouble(value, d)) < epsilon)
            break;
    }
    if (d < 0 || d >= 100)
        throw new Error("wrong digits:  value=" + value + "  mindigits=" + mindigits + "  maxdigits=" + maxdigits);
    return d;
}
;
function GetDblPrecision(value, maxdigits = 8) { return GetDblPrecision2(value, 0, maxdigits); }
function decimals(value, maxDigits = 8, minDigits = 0) { return GetDblPrecision2(value, minDigits, maxDigits); }
function DblToStrAuto2(value, minprecis, maxprecis) { return value?.toFixed(GetDblPrecision2(value, minprecis, maxprecis)); }
function DblToStrAuto(value, maxprecis = 8) {
    let digits = maxprecis;
    if (digits < 0)
        if (value != 0)
            maxprecis = Math.trunc(Math.max(0, -digits - Math.log10(fabs(value))));
        else
            maxprecis = 0;
    return DblToStrAuto2(value, 0, maxprecis);
}
exports.formatAuto = DblToStrAuto;
function NormalizeDoubleAnd(a, options) {
    if (a == 0)
        return a;
    let { digitsPoint: w = 4, digitsR: r } = options ?? {};
    if (!r && a % 1.0 == 0)
        return a;
    if (a == 0)
        return 0;
    if (r)
        w = r;
    let k = Math.ceil(Math.log10(Math.abs(a)));
    const func = options?.type == "max" ? Math.ceil : options?.type == "min" ? Math.floor : Math.round;
    if (k > w && !r)
        return func(a);
    if (k >= 0)
        return func(a / (10 ** (k - w))) * (10 ** (k - w));
    return func(a / (10 ** (k - w))) * (10 ** (k - w));
}
exports.roundSig = NormalizeDoubleAnd;
function DblToStrAnd(a, options) {
    let { digitsPoint: w = 4, digitsR: r } = options ?? {};
    if (!r && a % 1.0 == 0)
        return a.toString();
    if (a == 0)
        return "0";
    if (r)
        w = r;
    let a2 = Math.abs(a);
    const k = Math.floor(Math.log10(a2));
    const func = options?.type == "max" ? Math.ceil : options?.type == "min" ? Math.floor : Math.round;
    if (k + 1 >= w && !r)
        return func(a).toString();
    if (k + 1 >= w && r)
        return (func(a / (10 ** (k - w + 1))) * (10 ** (k - w + 1))).toString();
    return (func(a / (10 ** (k - w + 1))) * (10 ** (k - w + 1))).toFixed(w - k - 1);
}
exports.formatSig = DblToStrAnd;
function testDblToStrAnd() {
    const r = 0.047952487787;
    for (let i = -10; i < 10; i++) {
        const z = DblToStrAnd(r * (10 ** i), { digitsR: 2, type: "min" });
        console.log(z);
    }
    for (let i = -10; i < 10; i++) {
        const z = DblToStrAnd(r * (10 ** i), { digitsR: 2, type: "max" });
        console.log(z);
    }
}
function ArrayItemHandler(getter, setter) {
    return {
        get: function (target, prop) {
            if (prop in target) {
                return target[prop];
            }
            let num = typeof prop == "number" ? prop : typeof (prop) == "string" ? Number.parseInt(prop) : undefined;
            if (num != undefined && !isNaN(num))
                return getter(target, prop);
            return target[prop];
        },
        set: !setter ? undefined :
            function (target, prop, value, receiver) {
                if (prop in target) {
                    target[prop] = value;
                    return true;
                }
                let num = typeof (prop) == "number" ? prop : typeof (prop) == "string" ? Number.parseInt(prop) : undefined;
                if (num != undefined && !isNaN(num)) {
                    setter(target, prop, value);
                    return true;
                }
                target[prop] = value;
                return true;
            }
    };
}
function CreateArrayProxy(target, getterOrArray, setter) {
    if (typeof getterOrArray == "object")
        return CreateArrayProxy(target, (i) => getterOrArray[i], (i, val) => getterOrArray[i] = val);
    return new Proxy(target, ArrayItemHandler((target, i) => getterOrArray(i), setter ? (target, i, value) => setter(i, value) : undefined));
}
class __NumMap {
    *keys() { for (let keyStr of Object.keys(this)) {
        let key = Number(keyStr);
        yield key;
    } }
    *values() { for (let keyStr of Object.keys(this)) {
        yield this[keyStr];
    } }
    *entries() { for (let keyStr of Object.keys(this)) {
        let key = Number(keyStr);
        yield [key, this[keyStr]];
    } }
    clone() { return Object.assign(new __NumMap, this); }
    clear() { for (let k of Object.keys(this))
        delete this[k]; }
}
class __MyMap {
    map = new __NumMap;
    keys;
    values;
    createArrays() {
        let thisKeys = this.keys = [];
        let thisValues = this.values = [];
        for (let pair of this.map.values()) {
            thisKeys.push(pair.key);
            thisValues.push(pair.value);
        }
    }
    OnModify(key) { }
    Set(key, value) { this.map[key.valueOf()] = { key, value }; this.keys = null; this.OnModify?.(key); }
    Get(key) { let pair = this.map[key.valueOf()]; return pair ? pair.value : undefined; }
    Contains(key) { return this.map[key.valueOf()] != undefined; }
    TryAdd(key, value) { if (this.Contains(key))
        return false; this.Set(key, value); return true; }
    Add(key, value) { if (!this.TryAdd(key, value))
        throw new Error(`Key ${key} is already exists for ${typeof value}`); }
    Remove(key) { delete (this.map[key.valueOf()]); this.keys = null; this.OnModify?.(key); }
    Clear() { let pairs = this.OnModify ? this.map.values() : []; this.map.clear(); this.keys = undefined; this.values = undefined; for (let p of pairs)
        this.OnModify(p.key); }
    Count() { return this.sortedKeys.length; }
    get sortedKeys() { if (!this.keys)
        this.createArrays(); return this.keys; }
    get Values() { if (!this.keys)
        this.createArrays(); return this.values; }
    assign(other) { this.map = other.map.clone(); this.keys = other.keys; this.values = other.values; }
    set(key, value) { this.Set(key, value); }
    get(key) { return this.Get(key); }
    has(key) { return this.Contains(key); }
    delete(key) { this.Remove(key); }
    clear() { this.Clear(); }
    get size() { return this.Count(); }
}
exports.__MyMap = __MyMap;
class MyMap extends __MyMap {
    Clone() { let newobj = new MyMap(); newobj.assign(this); return newobj; }
    clone() { return this.Clone(); }
}
exports.MyMap = MyMap;
class MyNumMap extends __MyMap {
    constructor() {
        super();
        return CreateArrayProxy(this, (i) => this.Get(i), (key, value) => this.Set(key, value ?? (() => { throw new Error("undefined value"); })()));
    }
    Clone() { let newobj = new MyNumMap(); newobj.assign(this); return newobj; }
    clone() { return this.Clone(); }
}
exports.MyNumMap = MyNumMap;
class StructMap {
    _data = {};
    _keys = [];
    _values = [];
    [Symbol.iterator]() { return this.entries(); }
    set(key, value) {
        let items = key instanceof Array ? key : Object.values(key);
        if (!items?.length)
            throw new Error("passed empty object as key");
        let obj = this._data;
        for (let i = 0; i < items.length - 1; i++) {
            let item = items[i];
            obj = (obj[item] ??= {});
        }
        obj[items[items.length - 1]] = value;
        this._keys.push(key instanceof Array ? [...key] : { ...key });
        this._values.push(value);
    }
    get(key) {
        let items = key instanceof Array ? key : Object.values(key);
        if (items.length == 0)
            return undefined;
        let obj = this._data;
        for (let item of items) {
            obj = obj[item];
            if (!obj)
                return undefined;
        }
        return obj;
    }
    has(key) {
        let items = key instanceof Array ? key : Object.values(key);
        if (items.length == 0)
            return false;
        let obj = this._data;
        for (let item of items) {
            if (typeof obj != "object" && typeof obj != "function")
                return false;
            if (obj == null || !(item in obj))
                return false;
            obj = obj[item];
        }
        return true;
    }
    keys() { return this._keys; }
    values() { return this._values; }
    *entries() { for (let [i, key] of this._keys.entries())
        yield [key, this._values[i]]; }
}
exports.StructMap = StructMap;
class StructSet {
    data = new StructMap();
    [Symbol.iterator]() { return this.keys(); }
    add(key) { return this.data.set(key, null); }
    has(key) { return this.data.has(key); }
    keys() { return this.data.keys(); }
    values() { return this.data.keys(); }
}
exports.StructSet = StructSet;
class ArrayMap extends StructMap {
}
exports.ArrayMap = ArrayMap;
class ArraySet extends StructSet {
}
exports.ArraySet = ArraySet;
class VirtualItems {
    getLength;
    getValue;
    get length() { return this.getLength(); }
    *[Symbol.iterator]() { let len = this.length; for (let i = 0; i < len; i++)
        yield this.getValue(i); }
    constructor(itemGetter, lengthGetter) {
        this.getLength = lengthGetter;
        this.getValue = itemGetter;
        return CreateArrayProxy(this, itemGetter);
    }
}
exports.VirtualItems = VirtualItems;
let sss;
function JSON_clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}
class CancelToken {
    _cancel = false;
    isCancelled() { return this._cancel; }
    cancel() { this._cancel = true; }
    get aborted() { return this.isCancelled(); }
    abort() { this.cancel(); }
}
exports.CancelToken = CancelToken;
class CancelablePromise extends Promise {
    _reject;
    _onCancel;
    constructor(executor, onCancel) {
        let rejectCaptured;
        super((resolve, reject) => { rejectCaptured = reject; executor(resolve, reject); });
        this._reject = rejectCaptured;
        this._onCancel = onCancel;
    }
    cancel(msg) { if (this._onCancel)
        this._onCancel(); return this._reject(msg); }
    static resolve(value) { return new CancelablePromise((resolve, reject) => Promise.resolve(value).then(resolve, reject)); }
}
exports.CancelablePromise = CancelablePromise;
function createCancellableTimer(interval_ms, onTimer, onStop) {
    let timer;
    function stop() { clearInterval(timer); onStop?.(); }
    let executor = (resolve, reject) => {
        timer = setInterval(() => { if (onTimer() == false) {
            stop();
            reject("Stopped");
        } }, interval_ms);
    };
    return new CancelablePromise(executor, () => stop());
}
async function createCancellableTaskWrapper(task, isStopped, interval_ms = 50) {
    let stopCheckingTask = createCancellableTimer(interval_ms, () => !isStopped?.());
    try {
        return await Promise.race([task, stopCheckingTask]);
    }
    catch (e) {
        if (isStopped?.())
            return "stopped";
        throw e;
    }
    finally {
        stopCheckingTask.cancel();
    }
}
class MyTimerInterval {
    _timer;
    _onstop;
    constructor(period_ms, onTimer, onStop) { this._timer = setInterval(onTimer, period_ms); this._onstop = onStop; }
    stop() { clearInterval(this._timer); this._onstop?.(); }
}
exports.MyTimerInterval = MyTimerInterval;
class Mutex {
    mutex = Promise.resolve();
    lock() {
        let begin = unlock => { };
        this.mutex = this.mutex.then(() => {
            return new Promise(begin);
        });
        return new Promise(res => {
            begin = res;
        });
    }
    async dispatch(fn) {
        const unlock = await this.lock();
        try {
            return await fn();
        }
        finally {
            unlock();
        }
    }
    runExclusive(fn) { return this.dispatch(fn); }
    static createLock() { return (new Mutex).lock(); }
}
exports.Mutex = Mutex;
async function copyToClipboard(textToCopy) {
    const { navigator, window, document } = globalThis;
    const childProcessModule = 'child_process';
    if (typeof window != "object")
        return (await Promise.resolve(`${childProcessModule}`).then(s => __importStar(require(s)))).spawn('clip').stdin.end(textToCopy);
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(textToCopy);
    }
    else {
        let textArea = document.createElement("textarea");
        textArea.value = textToCopy;
        textArea.style.position = "fixed";
        textArea.style.left = "-999999px";
        textArea.style.top = "-999999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        return new Promise((res, rej) => {
            document.execCommand('copy') ? res() : rej();
            textArea.remove();
        });
    }
}
class CObjectID {
    static #id = 1;
    value = CObjectID.#id++;
    #object;
    #owner;
    [Symbol.species] = this;
    toString = () => { return this.value + ""; };
    constructor(object, owner) { this.#object = object; this.#owner = owner; }
    static getInfo(id) {
        let obj = id;
        return { object: obj.#object, owner: obj.#owner };
    }
    static getObjectByOwner(id, owner) { let data = CObjectID.getInfo(id); return data.owner == owner ? data.object : undefined; }
}
exports.CObjectID = CObjectID;
const stringifyDefault = JSON.stringify;
JSON.stringify = (value, replacer, space) => {
    const allow = Array.isArray(replacer)
        ? new Set(replacer.filter(v => typeof v == "string" || typeof v == "number").map(String))
        : null;
    return stringifyDefault(value, (key, val) => {
        if (allow && key !== "" && !allow.has(key))
            return undefined;
        const next = val instanceof CObjectID ? val.value + "" : val;
        return typeof replacer == "function" ? replacer(key, next) : next;
    }, space);
};
class MapExt extends Map {
    immutArray;
    set(key, value) { this.immutArray = undefined; return super.set(key, value); }
    delete(key) { this.immutArray = undefined; return super.delete(key); }
    clear() { this.immutArray = undefined; return super.clear(); }
    valuesArrayImmutable() { return this.immutArray ??= [...this.values()]; }
    getOrSetFunc(key, val) {
        let v = this.get(key);
        if (v === undefined && !this.has(key))
            this.set(key, v = val());
        return v;
    }
    getOrSet(key, val) { return this.getOrSetFunc(key, () => val); }
}
exports.MapExt = MapExt;
class WeakMapExt extends WeakMap {
    getOrSetFunc(key, val) {
        let v = this.get(key);
        if (v === undefined && !this.has(key))
            this.set(key, v = val());
        return v;
    }
    getOrSet(key, val) { return this.getOrSetFunc(key, () => val); }
}
exports.WeakMapExt = WeakMapExt;
class CCachedValueT {
    key;
    val;
    size;
    constructor(size) { this.size = size; }
    getOrSet(key, valFunc) {
        if (!this.key) {
            this.key = [...key];
            return this.val = valFunc();
        }
        for (let i = 0; i < this.size; i++)
            if (key[i] != this.key[i]) {
                this.key = [...key];
                return this.val = valFunc();
            }
        return this.val;
    }
}
exports.CCachedValueT = CCachedValueT;
class CCachedValue2 extends CCachedValueT {
    constructor() { super(2); }
}
exports.CCachedValue2 = CCachedValue2;
function isObjectCastableTo(object, members) {
    let keys = Object.keys(object);
    for (let m of members)
        if (!keys.includes(m))
            return false;
    return true;
}
